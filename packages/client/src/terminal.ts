import {
  TERMINAL_MAX_FRAME_BYTES,
  newTerminalLeaseRequestId,
  terminalStreamItemSchema,
  type TerminalAttachInput,
  type TerminalClientId,
  type TerminalCursor,
  type TerminalDimensions,
  type TerminalId,
  type TerminalInput,
  type TerminalInputResult,
  type TerminalLeaseAcquireInput,
  type TerminalLeaseAcquireResult,
  type TerminalLeaseId,
  type TerminalLeaseReleaseInput,
  type TerminalLeaseReleaseResult,
  type TerminalLeaseRenewInput,
  type TerminalLeaseRenewResult,
  type TerminalLeaseSummary,
  type TerminalStreamItem,
  type TerminalTarget,
} from "@arduano/agent-multiplex-protocol";

import {
  startResilientSubscription,
  type ResilientSubscriptionHandle,
  type ResilientSubscriptionOptions,
  type ResilientSubscriptionState,
  type SubscriptionProcedure,
} from "./resilient-subscription.js";

export type TerminalWatchCursor = TerminalCursor;

export interface TerminalWatchOptions
  extends Omit<
    ResilientSubscriptionOptions<TerminalAttachInput, TerminalStreamItem>,
    "procedure" | "input" | "onData" | "onCommitted"
  > {
  readonly target: TerminalTarget;
  readonly terminalId: TerminalId;
  readonly cursor?: TerminalCursor;
  readonly onItem: (item: TerminalStreamItem) => Promise<void> | void;
}

export interface TerminalWatchHandle {
  readonly done: Promise<void>;
  readonly state: ResilientSubscriptionState;
  readonly cursor: TerminalCursor | undefined;
  stop(): void;
}

/** Advances a terminal stream cursor without retaining terminal output. */
export function advanceTerminalCursor(item: TerminalStreamItem): TerminalCursor {
  return { ...item.cursor };
}

/**
 * Follows an opaque terminal byte stream and resumes from the last item that
 * the consumer successfully committed. Reset items are always delivered: a
 * reset is the runtime's authoritative current screen, even at the same cursor.
 */
export function watchTerminal(
  procedure: SubscriptionProcedure<TerminalAttachInput, TerminalStreamItem>,
  options: TerminalWatchOptions,
): TerminalWatchHandle {
  let cursor = options.cursor ? { ...options.cursor } : undefined;
  let replay: { highWater: number; lastSequence: number } | undefined;
  const {
    target,
    terminalId,
    cursor: _initialCursor,
    onItem,
    onStateChange,
    ...resilience
  } = options;
  void _initialCursor;

  if (cursor !== undefined && cursor.terminalId !== terminalId) {
    throw new TypeError("terminal cursor must identify the requested terminal");
  }

  const handle: ResilientSubscriptionHandle = startResilientSubscription({
    ...resilience,
    procedure,
    onStateChange: (state) => {
      // A partial exact replay is intentionally uncommitted. Reconnect from
      // the prior durable cursor so the emulator is reset and replayed whole.
      if (state.state === "connecting") replay = undefined;
      onStateChange?.(state);
    },
    input: () => ({
      ...target,
      terminalId,
      ...(cursor ? { cursor: { ...cursor } } : {}),
    }),
    onData: async (candidate) => {
      const item = terminalStreamItemSchema.parse(candidate);
      if (item.cursor.terminalId !== terminalId) {
        throw new Error("terminal stream was replaced while attached");
      }
      if (
        (item.kind === "reset" || item.kind === "replayEnd" || item.kind === "changed") &&
        (
          item.terminal.terminalId !== terminalId ||
          item.terminal.sequence !== item.cursor.sequence
        )
      ) {
        throw new Error("terminal stream descriptor does not match its cursor");
      }
      if (
        item.kind === "replayStart" &&
        item.terminal.terminalId !== terminalId
      ) {
        throw new Error("terminal replay descriptor identifies another terminal");
      }
      if (item.kind === "replayStart") {
        if (cursor !== undefined) {
          throw new Error("terminal exact replay cannot replace a committed cursor");
        }
        replay = { highWater: item.terminal.sequence, lastSequence: 0 };
        await onItem(item);
        return;
      }
      if (replay !== undefined) {
        if (item.kind === "replayEnd") {
          if (
            item.cursor.sequence !== replay.highWater ||
            item.cursor.sequence < replay.lastSequence
          ) {
            throw new Error("terminal exact replay ended at another high-water cursor");
          }
          await onItem(item);
          cursor = advanceTerminalCursor(item);
          replay = undefined;
          return;
        }
        if (
          (item.kind !== "output" && item.kind !== "resize") ||
          item.cursor.sequence <= replay.lastSequence ||
          item.cursor.sequence > replay.highWater
        ) {
          throw new Error("terminal exact replay timeline is malformed");
        }
        await onItem(item);
        replay.lastSequence = item.cursor.sequence;
        return;
      }
      if (item.kind === "replayEnd") {
        throw new Error("terminal exact replay ended without a start");
      }
      if (
        item.kind !== "reset" &&
        cursor !== undefined &&
        item.cursor.sequence <= cursor.sequence
      ) return;
      await onItem(item);
      cursor = advanceTerminalCursor(item);
    },
  });

  return {
    done: handle.done,
    get state() { return handle.state; },
    get cursor() { return cursor ? { ...cursor } : undefined; },
    stop: () => handle.stop(),
  };
}

interface MutationProcedure<TInput, TOutput> {
  mutate(input: TInput): Promise<TOutput>;
}

/** Minimal structural surface accepted from `AccessClient["terminals"]`. */
export interface TerminalControlProcedures {
  readonly lease: {
    readonly acquire: MutationProcedure<TerminalLeaseAcquireInput, TerminalLeaseAcquireResult>;
    readonly renew: MutationProcedure<TerminalLeaseRenewInput, TerminalLeaseRenewResult>;
    readonly release: MutationProcedure<TerminalLeaseReleaseInput, TerminalLeaseReleaseResult>;
  };
  readonly input: MutationProcedure<TerminalInput, TerminalInputResult>;
}

export type TerminalKeyboardState =
  | { readonly state: "active"; readonly lease: TerminalLeaseSummary }
  | { readonly state: "renewing"; readonly lease: TerminalLeaseSummary }
  | { readonly state: "released" }
  | { readonly state: "failed"; readonly error: unknown };

export interface AcquireTerminalKeyboardOptions {
  readonly target: TerminalTarget;
  readonly terminalId: TerminalId;
  readonly terminalClientId: TerminalClientId;
  readonly forceTerminalLeaseId?: TerminalLeaseId;
  readonly renewIntervalMs?: number;
  readonly inputRetryDelayMs?: number;
  readonly onStateChange?: (state: TerminalKeyboardState) => void;
}

export interface TerminalKeyboardHandle {
  readonly state: TerminalKeyboardState;
  readonly lease: TerminalLeaseSummary | undefined;
  /** Write UTF-8 text. Each RPC frame is independently valid UTF-8. */
  write(data: string): Promise<void>;
  resize(dimensions: TerminalDimensions): Promise<void>;
  /** Stop local renewal after the authoritative stream revoked this lease. */
  abandon(): void;
  /** Voluntarily release a lease that the authoritative stream still owns. */
  release(): Promise<void>;
}

/**
 * Acquires and renews the single raw-terminal keyboard lease. Credentials stay
 * inside this closure and are never exposed by the returned browser handle.
 */
export async function acquireTerminalKeyboard(
  procedures: TerminalControlProcedures,
  options: AcquireTerminalKeyboardOptions,
): Promise<TerminalKeyboardHandle> {
  const renewIntervalMs = positiveInteger(options.renewIntervalMs ?? 5_000, "renewIntervalMs");
  const inputRetryDelayMs = nonnegativeInteger(
    options.inputRetryDelayMs ?? 250,
    "inputRetryDelayMs",
  );
  const operationBase = {
    ...options.target,
    terminalId: options.terminalId,
    terminalClientId: options.terminalClientId,
  };
  const acquireRequest: TerminalLeaseAcquireInput = {
    ...operationBase,
    requestId: newTerminalLeaseRequestId(),
    ...(options.forceTerminalLeaseId
      ? { forceTerminalLeaseId: options.forceTerminalLeaseId }
      : {}),
  };
  let acquired: TerminalLeaseAcquireResult;
  try {
    acquired = await procedures.lease.acquire.mutate(acquireRequest);
  } catch {
    // Acquisition is runtime-idempotent by requestId, including forced
    // takeover, so an indeterminate first response can be retried verbatim.
    if (inputRetryDelayMs > 0) await delay(inputRetryDelayMs);
    acquired = await procedures.lease.acquire.mutate(acquireRequest);
  }
  const credential = acquired.credential;
  let lease: TerminalLeaseSummary | undefined = acquired.lease;
  let inputSequence = acquired.nextInputSequence;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operationTail: Promise<void> = Promise.resolve();
  let state: TerminalKeyboardState = { state: "active", lease };

  const transition = (next: TerminalKeyboardState): void => {
    state = next;
    options.onStateChange?.(next);
  };

  const fail = (error: unknown): void => {
    if (!active) return;
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    transition({ state: "failed", error });
  };

  const scheduleRenewal = (): void => {
    if (!active) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!active || lease === undefined) return;
      transition({ state: "renewing", lease });
      void procedures.lease.renew.mutate({ ...operationBase, credential })
        .then((renewed) => {
          if (!active) return;
          lease = renewed.lease;
          inputSequence = Math.max(inputSequence, renewed.nextInputSequence);
          transition({ state: "active", lease });
          scheduleRenewal();
        })
        .catch(fail);
    }, renewIntervalMs);
  };

  const requireActive = (): void => {
    if (!active) throw new Error("terminal keyboard lease is not active");
  };

  const deactivate = (): void => {
    if (!active) return;
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    lease = undefined;
    transition({ state: "released" });
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = operationTail.then(operation, operation);
    operationTail = next.catch(() => undefined);
    return next;
  };

  const sendInput = (payload: TerminalInputPayload): Promise<void> => enqueue(async () => {
    requireActive();
    const sequence = inputSequence;
    const request = {
      ...operationBase,
      credential,
      inputSequence: sequence,
      ...payload,
    } as TerminalInput;

    let result: TerminalInputResult;
    try {
      result = await procedures.input.mutate(request);
    } catch {
      // Retrying this exact request is safe: the runtime deduplicates by lease,
      // sequence, and payload hash. Never advance to different bytes first.
      if (inputRetryDelayMs > 0) await delay(inputRetryDelayMs);
      requireActive();
      try {
        result = await procedures.input.mutate(request);
      } catch (error) {
        fail(error);
        throw error;
      }
    }
    if (result.terminalId !== options.terminalId || result.inputSequence !== sequence) {
      const error = new Error("runtime acknowledged a different terminal input");
      fail(error);
      throw error;
    }
    inputSequence = sequence + 1;
  });

  const handle: TerminalKeyboardHandle = {
    get state() { return state; },
    get lease() { return lease ? { ...lease } : undefined; },
    write: (data) => {
      requireActive();
      const bytes = new TextEncoder().encode(data);
      if (bytes.byteLength === 0) return Promise.resolve();
      let completed = Promise.resolve();
      for (let offset = 0; offset < bytes.byteLength;) {
        let end = Math.min(offset + TERMINAL_MAX_FRAME_BYTES, bytes.byteLength);
        // Every write is decoded independently by the runtime. If the nominal
        // boundary lands inside a multi-byte scalar, move it to that scalar's
        // leading byte so neither frame contains partial UTF-8.
        while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
        const frame = bytes.subarray(offset, end);
        // Queue every frame synchronously so a concurrent keypress cannot be
        // interleaved into the middle of a large paste.
        const sent = sendInput({ kind: "write", dataBase64: terminalBytesToBase64(frame) });
        completed = completed.then(() => sent);
        offset = end;
      }
      return completed;
    },
    resize: (dimensions) => sendInput({ kind: "resize", dimensions }),
    abandon: deactivate,
    release: async () => {
      if (!active) return;
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await operationTail.catch(() => undefined);
      try {
        await procedures.lease.release.mutate({ ...operationBase, credential });
      } finally {
        lease = undefined;
        transition({ state: "released" });
      }
    },
  };

  transition(state);
  scheduleRenewal();
  return Object.freeze(handle);
}

type TerminalInputPayload =
  | { readonly kind: "write"; readonly dataBase64: string }
  | { readonly kind: "resize"; readonly dimensions: TerminalDimensions };

/** Browser- and Node-safe canonical base64 helpers for terminal frames. */
export function terminalBytesToBase64(data: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < data.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

export function terminalBase64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
