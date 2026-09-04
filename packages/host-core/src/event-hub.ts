import {
  fleetStreamItemSchema,
  type AttachInput,
  type FleetStreamItem,
  type NativeEvent,
  type SessionId,
  type StreamCursor,
} from "@agent-multiplex/protocol";

import { HostCatalog } from "./catalog.js";

export interface FleetEventHubOptions {
  catalog: HostCatalog;
  nativeRingSize?: number;
  heartbeatMs?: number;
  /**
   * Maximum number of events waiting behind one subscriber. Slow observers
   * are disconnected and resume from their last committed cursor instead of
   * being allowed to grow an unbounded host-side queue.
   */
  subscriberBufferSize?: number;
}

type Listener = (item: FleetStreamItem) => void;

interface NativeRing {
  runtimeEpoch: string;
  items: NativeEvent[];
}

class AsyncMailbox<T> {
  readonly #values: T[] = [];
  readonly #capacity: number;
  #settle:
    | { resolve(value: T | null): void; reject(error: unknown): void }
    | undefined;
  #closed: unknown | undefined;

  public constructor(capacity: number) {
    this.#capacity = capacity;
  }

  public push(value: T): boolean {
    if (this.#closed !== undefined) return false;
    if (this.#settle) {
      const { resolve } = this.#settle;
      this.#settle = undefined;
      resolve(value);
      return true;
    }
    if (this.#values.length >= this.#capacity) return false;
    this.#values.push(value);
    return true;
  }

  public close(error: unknown): void {
    if (this.#closed !== undefined) return;
    this.#closed = error;
    this.#values.length = 0;
    if (this.#settle) {
      const { reject } = this.#settle;
      this.#settle = undefined;
      reject(error);
    }
  }

  public async next(signal: AbortSignal | undefined, timeoutMs: number): Promise<T | null> {
    const queued = this.#values.shift();
    if (queued !== undefined) return queued;
    if (this.#closed !== undefined) throw this.#closed;
    if (signal?.aborted) return null;
    return new Promise<T | null>((resolve, reject) => {
      let settled = false;
      const finish = (value: T | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.#settle?.resolve === finish) this.#settle = undefined;
        resolve(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.#settle?.reject === fail) this.#settle = undefined;
        reject(error);
      };
      const abort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.#settle = { resolve: finish, reject: fail };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export class FleetSubscriberOverflowError extends Error {
  public constructor(public readonly capacity: number) {
    super(`Fleet subscriber exceeded its ${capacity}-item buffer; reconnect with the last committed cursor`);
    this.name = "FleetSubscriberOverflowError";
  }
}

/** Combines durable host control replay with bounded, deliberately ephemeral native rings. */
export class FleetEventHub {
  readonly #catalog: HostCatalog;
  readonly #nativeRingSize: number;
  readonly #heartbeatMs: number;
  readonly #subscriberBufferSize: number;
  readonly #rings = new Map<SessionId, NativeRing>();
  readonly #listeners = new Set<Listener>();
  readonly #unsubscribeControl: () => void;

  public constructor(options: FleetEventHubOptions) {
    this.#catalog = options.catalog;
    this.#nativeRingSize = options.nativeRingSize ?? 1_024;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#subscriberBufferSize = options.subscriberBufferSize ?? 4_096;
    if (!Number.isInteger(this.#nativeRingSize) || this.#nativeRingSize < 1) {
      throw new RangeError("nativeRingSize must be a positive integer");
    }
    if (!Number.isInteger(this.#subscriberBufferSize) || this.#subscriberBufferSize < 1) {
      throw new RangeError("subscriberBufferSize must be a positive integer");
    }
    this.#unsubscribeControl = this.#catalog.onControl((item) => this.#broadcast(item));
  }

  public close(): void {
    this.#unsubscribeControl();
    this.#listeners.clear();
    this.#rings.clear();
  }

  public publish(itemInput: FleetStreamItem): void {
    const item = fleetStreamItemSchema.parse(itemInput);
    if (item.kind === "control" || item.kind === "heartbeat") return;
    if (item.kind === "native") {
      const previous = this.#rings.get(item.sessionId);
      const ring =
        previous?.runtimeEpoch === item.runtimeEpoch
          ? previous
          : { runtimeEpoch: item.runtimeEpoch, items: [] };
      const final = ring.items.at(-1);
      if (final && item.sequence <= final.sequence) {
        return;
      }
      if (previous && previous.runtimeEpoch !== item.runtimeEpoch) {
        this.#broadcast(this.#gap(item.sessionId, "the native runtime epoch changed"));
      } else if (final && item.sequence > final.sequence + 1) {
        this.#broadcast(
          this.#gap(
            item.sessionId,
            `native sequence jumped from ${final.sequence} to ${item.sequence}`,
          ),
        );
      }
      ring.items.push(item);
      if (ring.items.length > this.#nativeRingSize) ring.items.shift();
      this.#rings.set(item.sessionId, ring);
    }
    this.#broadcast(item);
  }

  public async *attach(input: AttachInput, signal?: AbortSignal): AsyncGenerator<FleetStreamItem> {
    const selected = input.sessions === "all" ? null : new Set(input.sessions);
    const includeNative = input.includeNative;
    const startCursor = input.cursor?.controlCursor ?? 0;
    const mailbox = new AsyncMailbox<FleetStreamItem>(this.#subscriberBufferSize);
    const listener: Listener = (item) => {
      if (
        this.#selected(item, selected, includeNative) &&
        !mailbox.push(item)
      ) {
        mailbox.close(new FleetSubscriberOverflowError(this.#subscriberBufferSize));
      }
    };
    this.#listeners.add(listener);
    const checkpoint = this.#catalog.feedCheckpoint();
    const replayThrough = checkpoint.controlCursor;
    const deliveredNative = new Map<SessionId, { runtimeEpoch: string; sequence: number }>();
    try {
      if (input.cursor && input.cursor.feedId !== checkpoint.feedId) {
        yield {
          kind: "streamReset",
          previousFeedId: input.cursor.feedId,
          feedId: checkpoint.feedId,
          controlCursor: checkpoint.controlCursor,
          reason: "feedChanged",
          recovery: "snapshot",
        };
        return;
      }
      if (startCursor > replayThrough) {
        yield {
          kind: "streamReset",
          ...(input.cursor ? { previousFeedId: input.cursor.feedId } : {}),
          feedId: checkpoint.feedId,
          controlCursor: checkpoint.controlCursor,
          reason: "cursorExpired",
          recovery: "snapshot",
        };
        return;
      }
      let controlCursor = startCursor;
      for (;;) {
        const page = this.#catalog.controlEventsAfter(controlCursor, {
          through: replayThrough,
        });
        for (const item of page) {
          controlCursor = item.cursor;
          if (this.#selected(item, selected, includeNative)) yield item;
        }
        if (page.length < 10_000) break;
      }

      if (includeNative) {
        const nativeCursor = input.cursor?.native ?? {};
        const replaySessionIds = new Set<SessionId>(
          Object.keys(nativeCursor) as SessionId[],
        );
        // A missing cursor entry means this receiver has never committed a
        // native event for the session. Include buffered sessions as well as
        // explicit cursor entries so a fresh attachment receives the ring.
        for (const sessionId of this.#rings.keys()) replaySessionIds.add(sessionId);

        for (const sessionId of replaySessionIds) {
          if (selected && !selected.has(sessionId)) continue;
          const cursor = nativeCursor[sessionId];
          const ring = this.#rings.get(sessionId);
          if (!ring) {
            yield this.#gap(sessionId, "native event buffer is unavailable on this host");
            continue;
          }
          if (cursor && ring.runtimeEpoch !== cursor.runtimeEpoch) {
            yield this.#gap(sessionId, "the native runtime epoch changed");
            continue;
          }
          const wantedSequence = cursor?.sequence ?? -1;
          const first = ring.items[0];
          if (first && first.sequence > wantedSequence + 1) {
            yield this.#gap(sessionId, "requested native events have left the bounded host buffer");
          }
          for (const item of ring.items) {
            if (item.sequence <= wantedSequence) continue;
            deliveredNative.set(sessionId, {
              runtimeEpoch: item.runtimeEpoch,
              sequence: item.sequence,
            });
            yield item;
          }
        }
      }

      while (!signal?.aborted) {
        const item = await mailbox.next(signal, this.#heartbeatMs);
        if (item === null) {
          if (signal?.aborted) break;
          yield {
            kind: "heartbeat",
            feedId: this.#catalog.feedCheckpoint().feedId,
            controlCursor: this.#catalog.controlCursor(),
          };
          continue;
        }
        if (item.kind === "control") {
          if (item.cursor <= replayThrough || item.cursor <= controlCursor) continue;
          controlCursor = item.cursor;
          yield item;
          continue;
        }
        if (item.kind === "native") {
          const delivered = deliveredNative.get(item.sessionId);
          if (
            delivered?.runtimeEpoch === item.runtimeEpoch &&
            item.sequence <= delivered.sequence
          ) {
            continue;
          }
          deliveredNative.set(item.sessionId, {
            runtimeEpoch: item.runtimeEpoch,
            sequence: item.sequence,
          });
        }
        yield item;
      }
    } finally {
      this.#listeners.delete(listener);
    }
  }

  public async *watchWorkers(
    cursor: StreamCursor,
    signal?: AbortSignal,
  ): AsyncGenerator<FleetStreamItem> {
    const input: AttachInput = {
      sessions: "all",
      includeNative: false,
      cursor,
    };
    for await (const item of this.attach(input, signal)) {
      if (
        item.kind === "heartbeat" ||
        item.kind === "streamReset" ||
        (item.kind === "control" && item.change.type.startsWith("worker."))
      ) {
        yield item;
      }
    }
  }

  public async *watchHosts(
    cursor: StreamCursor,
    signal?: AbortSignal,
  ): AsyncGenerator<FleetStreamItem> {
    const input: AttachInput = { sessions: "all", includeNative: false, cursor };
    for await (const item of this.attach(input, signal)) {
      if (
        item.kind === "heartbeat" ||
        item.kind === "streamReset" ||
        (item.kind === "control" && item.change.type.startsWith("host."))
      ) {
        yield item;
      }
    }
  }

  public async *watchMetadataOperations(
    cursor: StreamCursor,
    signal?: AbortSignal,
  ): AsyncGenerator<FleetStreamItem> {
    const input: AttachInput = { sessions: "all", includeNative: false, cursor };
    for await (const item of this.attach(input, signal)) {
      if (
        item.kind === "heartbeat" ||
        item.kind === "streamReset" ||
        (item.kind === "control" && item.change.type === "metadata.operation")
      ) {
        yield item;
      }
    }
  }

  #selected(
    item: FleetStreamItem,
    selected: ReadonlySet<SessionId> | null,
    includeNative: boolean,
  ): boolean {
    if (item.kind === "native" || item.kind === "nativeGap") {
      return includeNative && (selected === null || selected.has(item.sessionId));
    }
    if (item.kind === "control" && selected !== null) {
      const change = item.change;
      if (
        change.type === "session.upsert" ||
        change.type === "session.unavailable" ||
        change.type === "metadata.changed" ||
        change.type === "metadata.operation" ||
        change.type === "interaction.changed"
      ) {
        const sessionId =
          change.type === "session.upsert"
            ? change.session.sessionId
            : change.type === "metadata.operation"
              ? change.operation.sessionId
            : change.type === "interaction.changed"
              ? change.interaction.sessionId
              : change.sessionId;
        return selected.has(sessionId);
      }
      if (change.type === "command.changed" && change.command.sessionId !== null) {
        return selected.has(change.command.sessionId);
      }
    }
    return true;
  }

  #gap(sessionId: SessionId, reason: string): FleetStreamItem {
    return { kind: "nativeGap", sessionId, reason, recovery: "readNativeHistory" };
  }

  #broadcast(item: FleetStreamItem): void {
    for (const listener of this.#listeners) listener(item);
  }
}
