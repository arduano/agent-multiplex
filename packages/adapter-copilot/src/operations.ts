import { AdapterOutcomeUnknownError, RuntimeNodeProtocolError } from "@arduano/agent-multiplex-runtime-node-core";

export const COPILOT_NATIVE_OPERATION_TIMEOUT_MS = 15_000;
const MAX_PENDING_OPERATIONS = 256;

type Outcome = "dispatched" | "acknowledged" | "lateAcknowledged" | "timedOut" | "unacknowledged" | "retired";
interface PendingOperation {
  group: string;
  completion: Promise<void>;
  retire(): void;
}

/** Bound the caller, never the ownership of a noncancellable SDK mutation.
 * A retired caller cannot admit another request in the same lane or apply a
 * late result. Native settlement or verified whole-owner termination is still
 * required before a stopped handle can release its ownership fence. */
export class CopilotNativeOperations {
  readonly #pending = new Map<string, PendingOperation>();
  #closed = false;

  public close(): void {
    this.#closed = true;
    for (const entry of this.#pending.values()) entry.retire();
  }

  public pending(group: string): boolean {
    return [...this.#pending.values()].some(entry => entry.group === group);
  }

  public drain(group: string): Promise<void> {
    return Promise.all([...this.#pending.values()].filter(entry => entry.group === group).map(entry => entry.completion)).then(() => undefined);
  }

  public assertAvailable(group: string, lane: string): void {
    if (this.#closed) throw new RuntimeNodeProtocolError("FENCED", "Copilot native operations are closing");
    if (this.#pending.has(JSON.stringify([group, lane])) || this.#pending.size >= MAX_PENDING_OPERATIONS) {
      throw new RuntimeNodeProtocolError("CONFLICT", "Copilot native operation ownership is pending; wait for settlement or recover the Host");
    }
  }

  public run<T>(group: string, lane: string, action: () => Promise<T>, diagnostic?: (outcome: Outcome) => void): Promise<T> {
    try { this.assertAvailable(group, lane); } catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([group, lane]);
    const trace = (outcome: Outcome): void => { try { diagnostic?.(outcome); } catch { /* Diagnostics never alter ownership. */ } };
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    let finishNative!: () => void;
    let finished = false;
    let dispatched = false;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const abandon = (outcome: "retired" | "timedOut"): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      trace(outcome);
      reject(dispatched
        ? new AdapterOutcomeUnknownError("Copilot native operation was not acknowledged; its request remains owned and must not be replayed")
        : new RuntimeNodeProtocolError("FENCED", "Copilot native operation retired before dispatch"));
    };
    const entry: PendingOperation = { group, completion: new Promise<void>(yes => { finishNative = yes; }), retire: () => abandon("retired") };
    this.#pending.set(key, entry);
    const timer = setTimeout(() => abandon("timedOut"), COPILOT_NATIVE_OPERATION_TIMEOUT_MS);
    timer.unref?.();
    const settle = (): boolean => {
      clearTimeout(timer);
      if (this.#pending.get(key) === entry) this.#pending.delete(key);
      finishNative();
      const accept = !finished;
      finished = true;
      return accept;
    };
    let native: Promise<T>;
    try {
      dispatched = true;
      trace("dispatched");
      if (this.#closed) throw new RuntimeNodeProtocolError("FENCED", "Copilot native operations are closing");
      native = action();
    } catch (error) { native = Promise.reject(error); }
    void native.then(value => {
      const accept = settle();
      trace(accept ? "acknowledged" : "lateAcknowledged");
      if (accept) resolve(value);
    }, cause => {
      const accept = settle();
      trace("unacknowledged");
      if (accept) reject(dispatched
        ? new AdapterOutcomeUnknownError("Copilot native operation failed after dispatch; native outcome is unknown", { cause }) : cause);
    });
    return result;
  }
}
