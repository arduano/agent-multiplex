import {
  accessStreamItemSchema,
  type AccessAttachInput,
  type AccessStreamItem,
} from "@arduano/agent-multiplex-protocol";

import {
  startResilientSubscription,
  type ResilientSubscriptionHandle,
  type ResilientSubscriptionOptions,
  type ResilientSubscriptionState,
  type SubscriptionProcedure,
} from "./resilient-subscription.js";

export type AccessWatchCursor = NonNullable<AccessAttachInput["cursor"]>;

export interface AccessWatchOptions
  extends Omit<
    ResilientSubscriptionOptions<AccessAttachInput, AccessStreamItem>,
    "procedure" | "input" | "onData" | "onCommitted"
  > {
  readonly sessions?: AccessAttachInput["sessions"];
  readonly includeNative?: boolean;
  readonly cursor?: AccessWatchCursor;
  readonly onItem: (item: AccessStreamItem) => Promise<void> | void;
}

export interface AccessWatchHandle {
  readonly done: Promise<void>;
  readonly state: ResilientSubscriptionState;
  /** Last committed position; undefined until the remote feed identifies itself. */
  readonly cursor: AccessWatchCursor | undefined;
  stop(): void;
}

/** Immutable cursor advance used by web, TUI, and embedded clients. */
export function advanceAccessCursor(
  cursor: AccessWatchCursor,
  item: AccessStreamItem,
): AccessWatchCursor;
export function advanceAccessCursor(
  cursor: undefined,
  item: AccessStreamItem,
): AccessWatchCursor | undefined;
export function advanceAccessCursor(
  cursor: AccessWatchCursor | undefined,
  item: AccessStreamItem,
): AccessWatchCursor | undefined;
export function advanceAccessCursor(
  cursor: AccessWatchCursor | undefined,
  item: AccessStreamItem,
): AccessWatchCursor | undefined {
  switch (item.kind) {
    case "control": {
      if (!cursor || cursor.feedId !== item.feedId) {
        return { feedId: item.feedId, controlCursor: item.cursor, native: {} };
      }
      return {
        ...cursor,
        controlCursor: Math.max(cursor.controlCursor, item.cursor),
        native: { ...cursor.native },
      };
    }
    case "heartbeat": {
      if (!cursor || cursor.feedId !== item.feedId) {
        return {
          feedId: item.feedId,
          controlCursor: item.controlCursor,
          native: {},
        };
      }
      return {
        ...cursor,
        controlCursor: Math.max(cursor.controlCursor, item.controlCursor),
        native: { ...cursor.native },
      };
    }
    case "native": {
      if (!cursor) return undefined;
      const previous = cursor.native[item.sessionId];
      if (
        previous?.runtimeEpoch === item.runtimeEpoch &&
        previous.sequence >= item.sequence
      ) return cloneCursor(cursor);
      return {
        feedId: cursor.feedId,
        controlCursor: cursor.controlCursor,
        native: {
          ...cursor.native,
          [item.sessionId]: {
            runtimeEpoch: item.runtimeEpoch,
            sequence: item.sequence,
          },
        },
      };
    }
    case "nativeGap":
      return cursor ? cloneCursor(cursor) : undefined;
    case "streamReset":
      return {
        feedId: item.feedId,
        controlCursor: item.controlCursor,
        native: {},
      };
  }
}

/**
 * Resubscribes with the last committed application cursor and suppresses
 * replayed control/native items. Native gaps are surfaced unchanged so callers
 * can recover through readNativeHistory rather than interpreting transcripts.
 */
export function watchAccess(
  procedure: SubscriptionProcedure<AccessAttachInput, AccessStreamItem>,
  options: AccessWatchOptions,
): AccessWatchHandle {
  let cursor = options.cursor ? cloneCursor(options.cursor) : undefined;
  let pendingNative: AccessWatchCursor["native"] = {};
  const seenNative = new NativeSeenSet(cursor);
  const {
    sessions = "all",
    includeNative = true,
    onItem,
    cursor: _initialCursor,
    ...resilience
  } = options;
  void _initialCursor;

  const handle: ResilientSubscriptionHandle = startResilientSubscription({
    ...resilience,
    procedure,
    input: () => ({
      sessions,
      includeNative,
      ...(cursor ? { cursor: cloneCursor(cursor) } : {}),
    }),
    onData: async (candidate) => {
      const item = accessStreamItemSchema.parse(candidate);
      if (alreadyCommitted(cursor, seenNative, item)) return;
      await onItem(item);
      const previous = cursor;
      if (item.kind === "native" && !cursor) {
        pendingNative[item.sessionId] = {
          runtimeEpoch: item.runtimeEpoch,
          sequence: item.sequence,
        };
      }
      cursor = advanceAccessCursor(cursor, item);
      const reset =
        item.kind === "streamReset" ||
        (previous !== undefined &&
          cursor !== undefined &&
          previous.feedId !== cursor.feedId);
      if (reset) {
        pendingNative = {};
        seenNative.reset();
      } else if (!previous && cursor) {
        cursor = { ...cursor, native: { ...pendingNative, ...cursor.native } };
        pendingNative = {};
      }
      seenNative.commit(item);
    },
  });

  return {
    done: handle.done,
    get state() { return handle.state; },
    get cursor() { return cursor ? cloneCursor(cursor) : undefined; },
    stop: () => handle.stop(),
  };
}

function alreadyCommitted(
  cursor: AccessWatchCursor | undefined,
  seenNative: NativeSeenSet,
  item: AccessStreamItem,
): boolean {
  if (item.kind === "control") {
    return cursor?.feedId === item.feedId && item.cursor <= cursor.controlCursor;
  }
  if (item.kind === "native") return seenNative.has(item);
  return false;
}

function cloneCursor(cursor: AccessWatchCursor): AccessWatchCursor {
  return {
    feedId: cursor.feedId,
    controlCursor: cursor.controlCursor,
    native: Object.fromEntries(
      Object.entries(cursor.native).map(([sessionId, position]) => [
        sessionId,
        { ...position },
      ]),
    ) as AccessWatchCursor["native"],
  };
}

class NativeSeenSet {
  private static readonly maximumEntries = 8_192;
  private readonly positions = new Map<string, number>();

  constructor(cursor: AccessWatchCursor | undefined) {
    for (const [sessionId, position] of Object.entries(cursor?.native ?? {})) {
      this.positions.set(this.key(sessionId, position.runtimeEpoch), position.sequence);
    }
  }

  reset(): void { this.positions.clear(); }

  has(item: Extract<AccessStreamItem, { kind: "native" }>): boolean {
    const position = this.positions.get(this.key(item.sessionId, item.runtimeEpoch));
    return position !== undefined && position >= item.sequence;
  }

  commit(item: AccessStreamItem): void {
    if (item.kind !== "native") return;
    const key = this.key(item.sessionId, item.runtimeEpoch);
    this.positions.delete(key);
    this.positions.set(key, item.sequence);
    while (this.positions.size > NativeSeenSet.maximumEntries) {
      const oldest = this.positions.keys().next().value;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
  }

  private key(sessionId: string, runtimeEpoch: string): string {
    return `${sessionId}\u0000${runtimeEpoch}`;
  }
}
