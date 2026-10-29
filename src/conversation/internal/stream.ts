/** Bounded full-snapshot observer. Quiet return releases only its observer. */
export class SnapshotStream<T> implements AsyncIterableIterator<T> {
  #queue: T[] = [];
  #closed = false;
  #error: unknown;
  #failed = false;
  #waiting:
    | {
        resolve(value: IteratorResult<T>): void;
        reject(error: unknown): void;
      }
    | undefined;
  #release: (() => void) | undefined;
  constructor(
    readonly maximum = 1,
    readonly overflow?: () => T,
  ) {}
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
  cleanup(release: () => void): void {
    if (this.#closed) release();
    else this.#release = release;
  }
  push(value: T): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const waiter = this.#waiting;
      this.#waiting = undefined;
      waiter.resolve({ done: false, value });
    } else if (this.#queue.length >= this.maximum)
      this.#queue = [this.overflow ? this.overflow() : value];
    else this.#queue.push(value);
  }
  complete(): void {
    if (this.#closed) return;
    this.#closed = true;
    const release = this.#release;
    this.#release = undefined;
    release?.();
    const waiter = this.#waiting;
    this.#waiting = undefined;
    waiter?.resolve({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#failed = true;
    this.#error = error;
    this.#finish();
  }
  #finish(): void {
    this.#closed = true;
    this.#queue = [];
    const release = this.#release;
    this.#release = undefined;
    release?.();
    const waiter = this.#waiting;
    this.#waiting = undefined;
    if (waiter) {
      if (this.#failed) waiter.reject(this.#error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }
  next(): Promise<IteratorResult<T>> {
    if (this.#waiting) return Promise.reject(new Error("Concurrent conversation next"));
    if (this.#failed) return Promise.reject(this.#error);
    const value = this.#queue.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }
  async return(): Promise<IteratorResult<T>> {
    this.#failed = false;
    this.#finish();
    return { done: true, value: undefined };
  }
}
