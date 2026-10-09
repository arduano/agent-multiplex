import { V7Error } from "./errors.js";

/** A subscriber's own bound; overflow never blocks a publisher or its peers. */
export class EventQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = [];
  readonly #waiting: Array<{ resolve: (v: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  #closed = false;
  #failure: unknown;
  public constructor(private readonly capacity: number, private readonly cleanup: () => void) {}
  public push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (this.#values.length >= this.capacity) this.close(new V7Error("OBSERVER_OVERFLOW", "Observer must obtain a fresh snapshot"));
    else this.#values.push(value);
  }
  public close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true; this.#failure = error; this.#values.length = 0; this.cleanup();
    for (const waiter of this.#waiting.splice(0)) {
      if (error === undefined) waiter.resolve({ value: undefined, done: true }); else waiter.reject(error);
    }
  }
  public async next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.#closed) { if (this.#failure !== undefined) throw this.#failure; return { value: undefined, done: true }; }
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }
  public async return(): Promise<IteratorResult<T>> { this.close(); return { value: undefined, done: true }; }
  public [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
}

export interface Diagnostic {
  role: "host" | "root"; operation: string; sessionId?: string; requestId?: string; code: string; error?: unknown;
}
/** Exceptions thrown by user diagnostics can never become service failures. */
export function diagnose(sink: ((event: Diagnostic) => void) | undefined, event: Diagnostic): void {
  try { sink?.(event); } catch { /* Logging is best effort. */ }
}
