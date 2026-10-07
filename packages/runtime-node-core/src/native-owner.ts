import type { ChildProcess } from "node:child_process";

/** Cleanup did not prove that the exact native owner has terminated.
 * Supervisors must retain that owner and must not start a replacement. */
export class NativeOwnerTerminationError extends Error {
  public readonly termination = "unproved" as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeOwnerTerminationError";
  }
}

/** Inspect typed cleanup evidence without depending on error wording. */
export function isNativeOwnerTerminationError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let visited = 0; pending.length > 0 && visited < 256; visited += 1) {
    const value = pending.pop();
    if (value instanceof NativeOwnerTerminationError) return true;
    if (!(value instanceof Error) || seen.has(value)) continue;
    seen.add(value);
    // Error fields are data properties. Do not invoke arbitrary subclass
    // getters while deciding whether native replacement is safe.
    const cause = Object.getOwnPropertyDescriptor(value, "cause");
    if (cause && "value" in cause) pending.push(cause.value);
    if (value instanceof AggregateError) {
      const errors = Object.getOwnPropertyDescriptor(value, "errors");
      if (errors && "value" in errors && Array.isArray(errors.value)) {
        pending.push(...errors.value.slice(0, Math.max(0, 256 - pending.length)));
      }
    }
  }
  return false;
}

export interface NativeChildProcessTerminationOptions {
  /** Time allowed after SIGTERM before escalation. */
  graceMs?: number;
  /** Time allowed for actual exit acknowledgement after SIGKILL. */
  forceMs?: number;
}

/** Exact-child lifetime capability, captured before a vendor can lose its
 * process reference. A kill acknowledgement is never exit acknowledgement. */
export class NativeChildProcessOwner {
  readonly #waiters = new Set<() => void>();
  #terminated = false;
  #lastError: Error | undefined;
  #terminating: Promise<void> | undefined;

  public constructor(public readonly child: ChildProcess) {
    child.once("exit", this.#didExit);
    child.on("error", this.#didError);
    if (this.terminated) this.#didExit();
  }

  public get terminated(): boolean {
    return this.#terminated ||
      this.child.exitCode !== null && this.child.exitCode !== undefined ||
      this.child.signalCode !== null && this.child.signalCode !== undefined;
  }

  public async waitForTermination(timeoutMs: number): Promise<void> {
    if (await this.#wait(timeoutMs)) return;
    throw new NativeOwnerTerminationError("Native child process termination was not acknowledged", {
      ...(this.#lastError ? { cause: this.#lastError } : {}),
    });
  }

  public terminate(options: NativeChildProcessTerminationOptions = {}): Promise<void> {
    if (this.terminated) return Promise.resolve();
    if (!this.#terminating) this.#terminating = this.#terminate(options);
    return this.#terminating;
  }

  async #terminate(options: NativeChildProcessTerminationOptions): Promise<void> {
    this.#signal("SIGTERM");
    if (await this.#wait(options.graceMs ?? 3_000)) return;
    this.#signal("SIGKILL");
    await this.waitForTermination(options.forceMs ?? 3_000);
  }

  #signal(signal: NodeJS.Signals): void {
    if (this.terminated) return;
    try {
      this.child.kill(signal);
    } catch (error) {
      this.#lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  async #wait(timeoutMs: number): Promise<boolean> {
    if (this.terminated) return true;
    return new Promise<boolean>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(finish);
        resolve(this.terminated);
      };
      const timer = setTimeout(finish, timeoutMs);
      this.#waiters.add(finish);
      if (this.terminated) finish();
    });
  }

  readonly #didError = (error: Error): void => {
    this.#lastError = error;
    // A failed spawn emits error without exit. An error from a live child
    // (including a failed kill) does not establish termination.
    if (this.child.pid === undefined) this.#didExit();
  };

  readonly #didExit = (): void => {
    this.#terminated = true;
    this.child.removeListener("exit", this.#didExit);
    this.child.removeListener("error", this.#didError);
    for (const finish of [...this.#waiters]) finish();
  };
}
