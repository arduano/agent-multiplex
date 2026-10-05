import { AdapterNativeStateReadError } from "@arduano/agent-multiplex-runtime-node-core";

export const COPILOT_READ_TIMEOUT_MS = 15_000;
const MAX_PENDING_READS = 256;

interface PendingRead {
  identity: string;
  result: Promise<unknown>;
  deadlineAt: number;
  close(): void;
}

/** No new native observation was made; preserve newer observed settings. */
export class CopilotReadBusyError extends AdapterNativeStateReadError {
  public constructor(message: string, public readonly stalled = false) { super("nativeReadBusy", message); }
}

/** Bound caller wait without pretending the SDK cancelled its native request.
 * A timed-out lane remains occupied until the native call settles. In particular,
 * polling/reconnects cannot accumulate another request behind the stalled one.
 * Only read-only calls belong here; mutations retain their outcome fences. */
export class CopilotReadRequests {
  readonly #pending = new Map<string, PendingRead>();
  #closed = false;

  /** Retire caller waits during owner shutdown, without claiming cancellation. */
  public close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.close();
  }

  public read<T>(lane: string, identity: string, action: () => Promise<T>, deadlineAt?: number): Promise<T> {
    if (this.#closed) return Promise.reject(new AdapterNativeStateReadError("nativeOwnerRetired", "Copilot native reads are closing"));
    const timeoutMs = Math.min(COPILOT_READ_TIMEOUT_MS, deadlineAt === undefined ? COPILOT_READ_TIMEOUT_MS : deadlineAt - Date.now());
    if (timeoutMs <= 0) return Promise.reject(new AdapterNativeStateReadError("nativeReadTimedOut", "Copilot native read timed out before its next page request"));
    const pending = this.#pending.get(lane);
    if (pending) {
      if (pending.identity !== identity) {
        return Promise.reject(new CopilotReadBusyError("Copilot native read is already in progress; retry after it settles", Date.now() >= pending.deadlineAt));
      }
      return pending.result as Promise<T>;
    }
    if (this.#pending.size >= MAX_PENDING_READS) {
      return Promise.reject(new CopilotReadBusyError("Copilot native read capacity is occupied by pending requests; retry after native recovery"));
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    let finished = false;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const entry: PendingRead = { identity, result, deadlineAt: Date.now() + timeoutMs, close: () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new AdapterNativeStateReadError("nativeOwnerRetired", "Copilot owner is closing; the native read remains pending until owner termination"));
    } };
    this.#pending.set(lane, entry);
    const timer = setTimeout(() => {
      finished = true;
      reject(new AdapterNativeStateReadError("nativeReadTimedOut", "Copilot native read timed out; the native request remains pending"));
    }, timeoutMs);
    timer.unref?.();
    const settled = () => {
      clearTimeout(timer);
      if (this.#pending.get(lane) === entry) this.#pending.delete(lane);
      const accept = !finished;
      finished = true;
      return accept;
    };
    void Promise.resolve().then(() => {
      if (this.#closed) throw new AdapterNativeStateReadError("nativeOwnerRetired", "Copilot native reads are closing");
      return action();
    }).then(
      value => { if (settled()) resolve(value); },
      error => { if (settled()) reject(error); },
    );
    return result;
  }
}
