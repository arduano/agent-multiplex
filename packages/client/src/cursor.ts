import {
  type AccessStreamItem,
  type SessionId,
  type StreamCursor,
} from "@arduano/agent-multiplex-protocol";

/** Mutable reconnect cursor. Native cursors remain epoch-scoped and never imply history. */
export class AccessCursor {
  #cursor: StreamCursor | undefined;
  #pendingNative: StreamCursor["native"] = {};

  public constructor(initial?: StreamCursor) {
    this.#cursor = initial
      ? clone(initial)
      : undefined;
  }

  public observe(item: AccessStreamItem): void {
    if (item.kind === "control") {
      this.#observeFeed(item.feedId, item.cursor);
    } else if (item.kind === "heartbeat") {
      this.#observeFeed(item.feedId, item.controlCursor);
    } else if (item.kind === "native") {
      const native = this.#cursor?.native ?? this.#pendingNative;
      native[item.sessionId] = {
        runtimeEpoch: item.runtimeEpoch,
        sequence: item.sequence,
      };
    } else if (item.kind === "streamReset") {
      this.#pendingNative = {};
      this.#cursor = {
        feedId: item.feedId,
        controlCursor: item.controlCursor,
        native: {},
      };
    }
  }

  public forgetNative(sessionId: SessionId): void {
    delete this.#cursor?.native[sessionId];
    delete this.#pendingNative[sessionId];
  }

  /** Undefined until the remote feed has identified itself. */
  public snapshot(): StreamCursor | undefined {
    return this.#cursor ? clone(this.#cursor) : undefined;
  }

  #observeFeed(feedId: StreamCursor["feedId"], controlCursor: number): void {
    if (!this.#cursor || this.#cursor.feedId !== feedId) {
      this.#cursor = {
        feedId,
        controlCursor,
        native: this.#cursor ? {} : { ...this.#pendingNative },
      };
      this.#pendingNative = {};
      return;
    }
    this.#cursor.controlCursor = Math.max(
      this.#cursor.controlCursor,
      controlCursor,
    );
  }
}

function clone(cursor: StreamCursor): StreamCursor {
  return {
    feedId: cursor.feedId,
    controlCursor: cursor.controlCursor,
    native: Object.fromEntries(
      Object.entries(cursor.native).map(([sessionId, position]) => [
        sessionId,
        { ...position },
      ]),
    ) as StreamCursor["native"],
  };
}
