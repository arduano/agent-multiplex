export interface Subscription {
  unsubscribe(): void;
}

export interface SubscriptionCallbacks<TOutput> {
  readonly onData: (value: TOutput) => void;
  readonly onError: (error: unknown) => void;
  readonly onComplete: () => void;
  readonly onStarted?: () => void;
  readonly onStopped?: () => void;
  readonly onConnectionStateChange?: (state: SubscriptionConnectionState) => void;
}

export interface SubscriptionConnectionState {
  readonly state: "idle" | "connecting" | "pending";
  readonly error?: unknown;
}

export interface SubscriptionProcedure<TInput, TOutput> {
  subscribe(
    input: TInput,
    callbacks: SubscriptionCallbacks<TOutput>,
  ): Subscription;
}

export type ResilientSubscriptionState =
  | { readonly state: "connecting"; readonly attempt: number }
  | { readonly state: "live"; readonly attempt: number }
  | {
      readonly state: "retrying";
      readonly attempt: number;
      readonly delayMs: number;
      readonly error: unknown;
    }
  | { readonly state: "stopped" }
  | { readonly state: "failed"; readonly error: unknown };

export interface ResilientSubscriptionOptions<TInput, TOutput> {
  readonly procedure: SubscriptionProcedure<TInput, TOutput>;
  /** Re-evaluated for every application-level resubscription. */
  readonly input: () => TInput;
  /** Values are processed serially; completion commits the value. */
  readonly onData: (value: TOutput) => Promise<void> | void;
  readonly onCommitted?: (value: TOutput) => void;
  readonly signal?: AbortSignal;
  readonly maxPendingItems?: number;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly retryFactor?: number;
  readonly retryJitter?: number;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly onStateChange?: (state: ResilientSubscriptionState) => void;
}

export interface ResilientSubscriptionHandle {
  readonly done: Promise<void>;
  readonly state: ResilientSubscriptionState;
  stop(): void;
}

export class SubscriptionBufferOverflowError extends Error {
  constructor(readonly capacity: number) {
    super(`Subscription consumer exceeded its ${capacity}-item buffer`);
    this.name = "SubscriptionBufferOverflowError";
  }
}

export class UnexpectedSubscriptionEndError extends Error {
  constructor() {
    super("Subscription completed unexpectedly");
    this.name = "UnexpectedSubscriptionEndError";
  }
}

/**
 * Adds bounded, serialized consumption and application-level resubscription to
 * any tRPC-style subscription procedure. It never silently drops a value.
 */
export function startResilientSubscription<TInput, TOutput>(
  options: ResilientSubscriptionOptions<TInput, TOutput>,
): ResilientSubscriptionHandle {
  return new ResilientSubscriptionController(options);
}

class ResilientSubscriptionController<TInput, TOutput>
  implements ResilientSubscriptionHandle
{
  readonly done: Promise<void>;

  private readonly maxPendingItems: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly retryFactor: number;
  private readonly retryJitter: number;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private currentState: ResilientSubscriptionState = {
    state: "connecting",
    attempt: 0,
  };
  private active = true;
  private generation = 0;
  private retryAttempt = 0;
  private pendingItems = 0;
  private processing: Promise<void> = Promise.resolve();
  private subscription: Subscription | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: ResilientSubscriptionOptions<TInput, TOutput>,
  ) {
    this.maxPendingItems = positiveInteger(
      options.maxPendingItems ?? 1_024,
      "maxPendingItems",
    );
    this.initialRetryDelayMs = nonnegativeInteger(
      options.initialRetryDelayMs ?? 250,
      "initialRetryDelayMs",
    );
    this.maxRetryDelayMs = nonnegativeInteger(
      options.maxRetryDelayMs ?? 30_000,
      "maxRetryDelayMs",
    );
    this.retryFactor = finiteAtLeast(options.retryFactor ?? 2, 1, "retryFactor");
    this.retryJitter = finiteBetween(
      options.retryJitter ?? 0.2,
      0,
      1,
      "retryJitter",
    );
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A caller can observe `done`, but failure should not create an unhandled
    // rejection merely because state callbacks are the chosen integration API.
    void this.done.catch(() => undefined);

    if (options.signal?.aborted) {
      this.stop();
      return;
    }
    options.signal?.addEventListener("abort", this.stop, { once: true });
    this.subscribe();
  }

  get state(): ResilientSubscriptionState {
    return this.currentState;
  }

  readonly stop = (): void => {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.options.signal?.removeEventListener("abort", this.stop);
    this.transition({ state: "stopped" });
    void this.processing.then(this.resolveDone);
  };

  private subscribe(): void {
    if (!this.active) return;
    const generation = ++this.generation;
    let established = false;
    const markLive = (): void => {
      if (!this.active || generation !== this.generation) return;
      if (established) return;
      established = true;
      this.retryAttempt = 0;
      this.transition({ state: "live", attempt: 0 });
    };
    this.transition({ state: "connecting", attempt: this.retryAttempt });
    let created: Subscription;
    try {
      created = this.options.procedure.subscribe(this.options.input(), {
        onData: (value) => {
          markLive();
          this.enqueue(generation, value);
        },
        onError: (error) => this.ended(generation, error),
        onComplete: () =>
          this.ended(generation, new UnexpectedSubscriptionEndError()),
        onStarted: markLive,
        onStopped: () =>
          this.ended(generation, new UnexpectedSubscriptionEndError()),
        onConnectionStateChange: (state) => {
          if (state.state === "pending") {
            markLive();
          } else if (state.state === "connecting" && established) {
            this.ended(
              generation,
              state.error ?? new Error("Subscription transport disconnected"),
            );
          }
        },
      });
    } catch (error) {
      this.ended(generation, error);
      return;
    }

    if (!this.active || generation !== this.generation) {
      created.unsubscribe();
      return;
    }
    this.subscription = created;
  }

  private enqueue(generation: number, value: TOutput): void {
    if (!this.active || generation !== this.generation) return;
    if (this.pendingItems >= this.maxPendingItems) {
      this.fail(new SubscriptionBufferOverflowError(this.maxPendingItems));
      return;
    }
    this.pendingItems += 1;
    this.processing = this.processing
      .then(async () => {
        if (!this.active) return;
        await this.options.onData(value);
        if (!this.active) return;
        this.options.onCommitted?.(value);
        this.retryAttempt = 0;
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.pendingItems -= 1;
      });
  }

  private ended(generation: number, error: unknown): void {
    if (!this.active || generation !== this.generation) return;
    this.generation += 1;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    void this.processing.then(() => {
      if (!this.active) return;
      const attempt = this.retryAttempt;
      if (this.options.shouldRetry?.(error, attempt) === false) {
        this.fail(error);
        return;
      }
      const delayMs = this.retryDelay(attempt);
      this.retryAttempt += 1;
      this.transition({ state: "retrying", attempt, delayMs, error });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.subscribe();
      }, delayMs);
    });
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(
      this.maxRetryDelayMs,
      this.initialRetryDelayMs * this.retryFactor ** attempt,
    );
    const jitter = exponential * this.retryJitter;
    return Math.max(
      0,
      Math.round(exponential - jitter + Math.random() * jitter * 2),
    );
  }

  private fail(error: unknown): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.options.signal?.removeEventListener("abort", this.stop);
    this.transition({ state: "failed", error });
    this.rejectDone(error);
  }

  private transition(state: ResilientSubscriptionState): void {
    this.currentState = state;
    this.options.onStateChange?.(state);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function finiteAtLeast(value: number, minimum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${name} must be at least ${minimum}`);
  }
  return value;
}

function finiteBetween(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
