import {
  accessStreamItemSchema,
  type AccessAttachInput,
  type AccessStreamItem,
  type MetadataOperationRecord,
  type NativeEvent,
  type RuntimeNodeEventItem,
  type SessionId,
  type StreamCursor,
} from "@arduano/agent-multiplex-protocol";

import { ControlNodeCatalog } from "./catalog.js";

export interface ControlNodeEventHubOptions {
  readonly catalog: ControlNodeCatalog;
  readonly nativeRingSize?: number;
  readonly heartbeatMs?: number;
  readonly subscriberBufferSize?: number;
}

class BoundedQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  #closed = false;
  #failure: unknown;

  public constructor(
    private readonly capacity: number,
    private readonly onClose: () => void,
  ) {}

  public get closed(): boolean { return this.#closed; }

  public push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (this.#values.length >= this.capacity) this.close(new SubscriberOverflowError(this.capacity));
    else this.#values.push(value);
  }

  public close(cause?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = cause;
    this.#values.splice(0);
    for (const waiter of this.#waiters.splice(0)) {
      if (cause === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(cause);
    }
    this.onClose();
  }

  public async next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.#closed) {
      if (this.#failure !== undefined) throw this.#failure;
      return { value: undefined, done: true };
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

export class SubscriberOverflowError extends Error {
  public constructor(public readonly capacity: number) {
    super(`access stream subscriber exceeded its ${capacity}-item buffer`);
    this.name = "SubscriberOverflowError";
  }
}

interface Listener {
  readonly queue: BoundedQueue<AccessStreamItem>;
  readonly sessions: ReadonlySet<SessionId> | null;
  readonly includeNative: boolean;
}

/** Bounded live delivery layered over the catalog's durable control journal. */
export class ControlNodeEventHub {
  readonly #catalog: ControlNodeCatalog;
  readonly #nativeRingSize: number;
  readonly #heartbeatMs: number;
  readonly #subscriberBufferSize: number;
  readonly #rings = new Map<SessionId, NativeEvent[]>();
  readonly #nativeSeen = new Map<
    SessionId,
    Pick<NativeEvent, "runtimeEpoch" | "sequence">
  >();
  readonly #listeners = new Set<Listener>();
  readonly #unsubscribeControl: () => void;

  public constructor(options: ControlNodeEventHubOptions) {
    this.#catalog = options.catalog;
    this.#nativeRingSize = options.nativeRingSize ?? 2_048;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#subscriberBufferSize = options.subscriberBufferSize ?? 4_096;
    for (const value of [this.#nativeRingSize, this.#heartbeatMs, this.#subscriberBufferSize]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("event-hub limits must be positive integers");
    }
    this.#unsubscribeControl = this.#catalog.onControl((item) => {
      if (item.change.type === "session.upsert") {
        const latest = this.#nativeSeen.get(item.change.session.sessionId);
        if (
          latest !== undefined &&
          latest.runtimeEpoch !== item.change.session.runtimeEpoch
        ) {
          this.#forgetNativeSession(item.change.session.sessionId);
        }
      }
      this.#broadcast(item);
    });
  }

  public close(): void {
    this.#unsubscribeControl();
    for (const listener of this.#listeners) listener.queue.close();
    this.#listeners.clear();
    this.#nativeSeen.clear();
    this.#rings.clear();
  }

  public publish(itemInput: AccessStreamItem): void {
    const item = accessStreamItemSchema.parse(itemInput);
    if (item.kind === "native") {
      const previous = this.#nativeSeen.get(item.sessionId);
      if (
        previous?.runtimeEpoch === item.runtimeEpoch &&
        item.sequence <= previous.sequence
      ) {
        // Child pumps reconnect without a native cursor, and transports may
        // also retry a publication. Sequence identity is epoch-scoped, so the
        // first observation wins and replays cannot reach clients twice.
        return;
      }
      if (previous !== undefined && previous.runtimeEpoch !== item.runtimeEpoch) {
        this.#forgetNativeSession(item.sessionId);
      }
      const ring = this.#rings.get(item.sessionId) ?? [];
      ring.push(item);
      if (ring.length > this.#nativeRingSize) ring.splice(0, ring.length - this.#nativeRingSize);
      this.#rings.set(item.sessionId, ring);
      this.#nativeSeen.set(item.sessionId, {
        runtimeEpoch: item.runtimeEpoch,
        sequence: item.sequence,
      });
    }
    this.#broadcast(item);
  }

  public publishRuntimeItem(item: RuntimeNodeEventItem): AccessStreamItem | null {
    if (item.kind === "heartbeat" || item.kind === "control") return null;
    const provenance = {
      originControlNodeId: this.#catalog.localControlNode().controlNodeId,
      authority: this.#catalog.authority(),
    };
    const canonical = accessStreamItemSchema.parse({ ...item, provenance });
    this.publish(canonical);
    return canonical;
  }

  public attach(input: AccessAttachInput, signal?: AbortSignal): AsyncIterable<AccessStreamItem> {
    const sessions = input.sessions === "all" ? null : new Set<SessionId>(input.sessions);
    return this.#subscribe(sessions, input.includeNative, input.cursor, signal);
  }

  public watchControlNodes(cursor: StreamCursor, signal?: AbortSignal): AsyncIterable<AccessStreamItem> {
    return this.#subscribe(null, false, cursor, signal, (item) =>
      item.kind !== "control" || item.change.type.startsWith("controlNode.") || item.change.type === "authority.promoted",
    );
  }

  public watchRuntimeNodes(cursor: StreamCursor, signal?: AbortSignal): AsyncIterable<AccessStreamItem> {
    return this.#subscribe(null, false, cursor, signal, (item) =>
      item.kind !== "control" || item.change.type.startsWith("runtimeNode."),
    );
  }

  public watchMetadataOperations(cursor: StreamCursor, signal?: AbortSignal): AsyncIterable<AccessStreamItem> {
    return this.#subscribe(null, false, cursor, signal, (item) =>
      item.kind !== "control" || item.change.type === "metadata.operation",
    );
  }

  async *#subscribe(
    sessions: ReadonlySet<SessionId> | null,
    includeNative: boolean,
    cursor: StreamCursor | undefined,
    signal: AbortSignal | undefined,
    filter: (item: AccessStreamItem) => boolean = () => true,
  ): AsyncGenerator<AccessStreamItem> {
    if (signal?.aborted) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let removeAbortListener = (): void => {};
    const queue = new BoundedQueue<AccessStreamItem>(
      this.#subscriberBufferSize,
      () => {
        this.#listeners.delete(listener);
        if (timer !== undefined) clearInterval(timer);
        removeAbortListener();
      },
    );
    const listener: Listener = { queue, sessions, includeNative };
    this.#listeners.add(listener);
    const close = (): void => queue.close();
    removeAbortListener = (): void => signal?.removeEventListener("abort", close);
    if (signal?.aborted || queue.closed) close();
    else signal?.addEventListener("abort", close, { once: true });
    if (queue.closed) return;

    // Install live delivery before taking replay barriers. Anything committed
    // after these snapshots is buffered; controls at or below the barrier are
    // skipped later because the durable journal is their source of truth.
    const checkpoint = this.#catalog.feedCheckpoint();
    const nativeReplay = includeNative
      ? [...this.#rings].map(([sessionId, ring]) => [sessionId, [...ring]] as const)
      : [];
    const authorityRefs = [this.#catalog.authority()];
    let replayCursor = cursor?.controlCursor ?? checkpoint.controlCursor;
    try {
      if (cursor && cursor.feedId !== checkpoint.feedId) {
        yield {
          kind: "streamReset",
          previousFeedId: cursor.feedId,
          feedId: checkpoint.feedId,
          controlCursor: checkpoint.controlCursor,
          authorityRefs,
          reason: "feedChanged",
          recovery: "snapshot",
        };
        return;
      }
      if (cursor && !this.#catalog.canReplayControlCursor(cursor.controlCursor)) {
        yield {
          kind: "streamReset",
          previousFeedId: cursor.feedId,
          feedId: checkpoint.feedId,
          controlCursor: checkpoint.controlCursor,
          authorityRefs,
          reason: "cursorExpired",
          recovery: "snapshot",
        };
        return;
      }
      if (cursor) {
        for (const item of this.#catalog.controlEventsAfter(replayCursor)) {
          if (item.cursor > checkpoint.controlCursor) break;
          replayCursor = item.cursor;
          if (filter(item) && selected(item, sessions, includeNative)) yield item;
        }
      }
      if (includeNative && cursor) {
        for (const [sessionId, ring] of nativeReplay) {
          if (sessions !== null && !sessions.has(sessionId)) continue;
          const wanted = cursor.native[sessionId];
          const newestEpoch = ring.at(-1)?.runtimeEpoch;
          if (!newestEpoch) continue;
          const wantedSequence = wanted?.runtimeEpoch === newestEpoch ? wanted.sequence : -1;
          const sameEpoch = ring.filter((event) => event.runtimeEpoch === newestEpoch);
          const first = sameEpoch[0];
          if (first && wantedSequence + 1 < first.sequence) {
            yield {
              kind: "nativeGap",
              sessionId,
              reason: `native ring begins at sequence ${first.sequence}`,
              recovery: "readNativeHistory",
              provenance: first.provenance,
            };
          } else {
            for (const event of sameEpoch) if (event.sequence > wantedSequence) yield event;
          }
        }
      }

      timer = setInterval(() => queue.push({
        kind: "heartbeat",
        feedId: this.#catalog.feedCheckpoint().feedId,
        controlCursor: this.#catalog.controlCursor(),
        authorityRefs: [this.#catalog.authority()],
      }), this.#heartbeatMs);
      timer.unref();
      while (!signal?.aborted) {
        const next = await queue.next();
        if (next.done) break;
        if (
          (next.value.kind === "control" || next.value.kind === "heartbeat") &&
          next.value.feedId !== checkpoint.feedId
        ) {
          // Authority promotion rotates the durable control-feed generation.
          // Subscribers already attached to the previous generation must not
          // consume new-generation controls under an old snapshot barrier.
          yield {
            kind: "streamReset",
            previousFeedId: checkpoint.feedId,
            feedId: next.value.feedId,
            controlCursor: this.#catalog.controlCursor(),
            authorityRefs: [this.#catalog.authority()],
            reason: "feedChanged",
            recovery: "snapshot",
          };
          break;
        }
        if (next.value.kind === "control" && next.value.cursor <= checkpoint.controlCursor) {
          continue;
        }
        if (filter(next.value)) yield next.value;
      }
    } finally {
      close();
    }
  }

  #broadcast(item: AccessStreamItem): void {
    // Promotion starts a new feed generation. Deliver its boundary event to
    // every live subscriber so even a session-scoped stream resets before it
    // can observe native items from the new authority epoch.
    const generationBoundary = item.kind === "control" && item.change.type === "authority.promoted";
    for (const listener of this.#listeners) {
      if (generationBoundary || selected(item, listener.sessions, listener.includeNative)) {
        listener.queue.push(item);
      }
    }
  }

  #forgetNativeSession(sessionId: SessionId): void {
    this.#nativeSeen.delete(sessionId);
    this.#rings.delete(sessionId);
  }
}

function selected(
  item: AccessStreamItem,
  sessions: ReadonlySet<SessionId> | null,
  includeNative: boolean,
): boolean {
  if ((item.kind === "native" || item.kind === "nativeGap") && !includeNative) return false;
  if (sessions === null) return true;
  if (item.kind === "native" || item.kind === "nativeGap") return sessions.has(item.sessionId);
  if (item.kind !== "control") return true;
  const change = item.change;
  if (change.type === "session.upsert") return sessions.has(change.session.sessionId);
  if (change.type === "session.unavailable" || change.type === "metadata.changed") return sessions.has(change.sessionId);
  if (change.type === "metadata.operation") return sessions.has(change.operation.sessionId);
  if (change.type === "interaction.changed") return sessions.has(change.interaction.sessionId);
  if (change.type === "command.changed") return change.command.sessionId !== null && sessions.has(change.command.sessionId);
  return false;
}

export function metadataOperationFromItem(item: AccessStreamItem): MetadataOperationRecord | null {
  return item.kind === "control" && item.change.type === "metadata.operation"
    ? item.change.operation
    : null;
}
