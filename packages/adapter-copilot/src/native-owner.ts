import type { ChildProcess } from "node:child_process";
import { NativeChildProcessOwner, NativeOwnerTerminationError } from "@arduano/agent-multiplex-runtime-node-core";

export interface CopilotOwnerClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  forceStop(): Promise<void>;
}
export interface CopilotOwnerSnapshot {
  childState: "notObserved" | "running" | "exited";
  childPid?: number;
  startupPending: boolean;
}
export interface CopilotNativeOwner {
  /** One original startup request. Repeated callers observe it, never replay it. */
  start(): Promise<void>;
  snapshot(): CopilotOwnerSnapshot;
  /** Success is proof that this lifetime cannot acquire another local owner. */
  close(options?: { timeoutMs?: number; force?: boolean }): Promise<void>;
}

/** The only seam that observes the pinned SDK's private child. Embeddings pass
 * this explicit capability through wrappers, never emulate SDK-private getters.
 * A fulfilled forceStop is not process termination. */
export function observeCopilotNativeOwner(client: CopilotOwnerClient, lifecycle: CopilotOwnerClient = client): CopilotNativeOwner {
  return new SdkNativeOwner(client, lifecycle);
}

class SdkNativeOwner implements CopilotNativeOwner {
  readonly #children = new Map<ChildProcess, NativeChildProcessOwner>();
  #startup: Promise<void> | undefined;
  #startupPending = false;
  #startupFailed = false;
  #retired = false;
  #closing: Promise<void> | undefined;
  #timeoutMs = 10_000;

  constructor(readonly client: CopilotOwnerClient, readonly lifecycle: CopilotOwnerClient) {}

  #capture(): void {
    // Keep SDK details confined to this exact-version adapter seam.
    if (Reflect.get(this.client, "isExternalServer") !== false) return;
    const child = Reflect.get(this.client, "cliProcess") as ChildProcess | null | undefined;
    if (child && Number.isSafeInteger(child.pid) && Number(child.pid) > 0 &&
      typeof child.once === "function" && typeof child.on === "function" && typeof child.removeListener === "function" &&
      !this.#children.has(child)) this.#children.set(child, new NativeChildProcessOwner(child));
  }

  public start(): Promise<void> {
    if (this.#startup) return this.#startup;
    if (this.#retired) return Promise.reject(new NativeOwnerTerminationError("Copilot owner retired before startup"));
    this.#startupPending = true;
    let request: Promise<void>;
    try { request = Promise.resolve(this.lifecycle.start()); }
    catch (error) { request = Promise.reject(error); }
    this.#capture();
    this.#startup = request.then(() => undefined, cause => {
      this.#startupFailed = true;
      throw cause;
    }).finally(() => {
      this.#capture();
      this.#startupPending = false;
      if (this.#retired) {
        // The original failed close remains failed. A late owner is privately
        // cleaned up after that attempt; it never grants a replacement license.
        void (async () => {
          await this.#closing?.catch(() => undefined);
          await this.#terminate(false, this.#timeoutMs);
        })().catch(() => undefined);
      }
    });
    return this.#startup;
  }

  public snapshot(): CopilotOwnerSnapshot {
    this.#capture();
    const owners = [...this.#children.values()];
    const owner = owners.find(item => !item.terminated) ?? owners.at(-1);
    return { childState: owner ? owner.terminated ? "exited" : "running" : "notObserved",
      ...(owner?.child.pid === undefined ? {} : { childPid: owner.child.pid }), startupPending: this.#startupPending };
  }

  public close(options: { timeoutMs?: number; force?: boolean } = {}): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#retired = true;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    return this.#closing = this.#terminate(options.force ?? false, this.#timeoutMs);
  }

  async #terminate(force: boolean, timeoutMs: number): Promise<void> {
    this.#capture();
    let failure: unknown;
    if (!force) {
      try {
        const result = await bounded(this.lifecycle.stop(), timeoutMs);
        if (Array.isArray(result) && result.length > 0) throw new AggregateError(result, "Copilot graceful stop refused");
        // SDK graceful stop waits for its captured child. Independently retain
        // our child proof, including one whose SDK getter was cleared earlier.
        if ([...this.#children.values()].some(owner => !owner.terminated)) throw new NativeOwnerTerminationError("Copilot graceful stop did not release its child");
      } catch (cause) { failure = cause; force = true; }
    }
    if (force) {
      this.#capture();
      const owners = [...this.#children.values()];
      // Observe actual exit before forceStop can clear the SDK reference.
      const proofs = owners.map(owner => owner.waitForTermination(timeoutMs));
      // Observe rejected proof promises immediately while forceStop is pending.
      const settled = Promise.allSettled(proofs);
      try {
        await bounded(this.lifecycle.forceStop(), timeoutMs);
        const result = await settled;
        if (owners.length === 0 || result.some(item => item.status === "rejected")) {
          throw new NativeOwnerTerminationError("Copilot forced termination has no exact child exit proof");
        }
        failure = undefined;
      } catch (cause) { failure = cause; }
    }
    if (this.#startupPending || this.#startupFailed && this.#children.size === 0) {
      throw new NativeOwnerTerminationError("Copilot startup may still acquire an unobserved native owner", { ...(failure === undefined ? {} : { cause: failure }) });
    }
    if (failure !== undefined) throw new NativeOwnerTerminationError("Copilot native owner termination is unproved", { cause: failure });
  }
}

function bounded<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new NativeOwnerTerminationError("Copilot owner cleanup deadline expired")), timeoutMs);
    timer.unref();
    void request.then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
}
