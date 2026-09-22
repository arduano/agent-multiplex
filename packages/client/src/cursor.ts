import {
  type AccessStreamItem,
  type SessionId,
  type StreamCursor,
} from "@arduano/agent-multiplex-protocol";
import { advanceAccessCursor } from "./access-watch.js";

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
    if (item.kind === "native" && !this.#cursor) {
      const previous = this.#pendingNative[item.sessionId];
      if (previous?.runtimeEpoch !== item.runtimeEpoch || previous.sequence < item.sequence) {
        this.#pendingNative[item.sessionId] = {
          runtimeEpoch: item.runtimeEpoch,
          sequence: item.sequence,
        };
      }
      return;
    }
    const previous = this.#cursor;
    this.#cursor = advanceAccessCursor(previous, item);
    if (item.kind === "streamReset" || (previous && previous.feedId !== this.#cursor?.feedId)) {
      this.#pendingNative = {};
    } else if (!previous && this.#cursor) {
      this.#cursor.native = { ...this.#pendingNative, ...this.#cursor.native };
      this.#pendingNative = {};
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
