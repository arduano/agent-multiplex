import {
  lifecycleSnapshotSchema,
  type AccessStreamItem,
  type LifecycleSnapshot,
  type NativeEvent,
  type SessionId,
} from "@arduano/agent-multiplex-protocol";

type RelevantItem =
  | Extract<AccessStreamItem, { kind: "native" | "nativeGap" | "streamReset" }>
  | Extract<AccessStreamItem, { kind: "control" }>;

export type LifecycleHandoffState = "pending" | "continuous" | "gap";

/**
 * Subscribe-first buffer for the atomic lifecycle/native-cursor handoff.
 *
 * Construct this before starting the access subscription, pass every item to
 * observe(), then install the readLifecycle result. Native events below the
 * snapshot's exclusive nextNativeSequence are overlap and are discarded. A
 * missing sequence, binding change, epoch change, stream reset, explicit gap,
 * or bounded-buffer overflow fails closed and requires a new snapshot/history
 * recovery. Create a new instance for each recovery attempt.
 */
export class LifecycleNativeHandoff {
  static readonly defaultMaximumBufferedItems = 4_096;

  readonly #sessionId: SessionId;
  readonly #maximumBufferedItems: number;
  #buffer: RelevantItem[] = [];
  #snapshot: LifecycleSnapshot | undefined;
  #nextSequence: number | undefined;
  #state: LifecycleHandoffState = "pending";
  #reason: string | undefined;

  public constructor(
    sessionId: SessionId,
    maximumBufferedItems = LifecycleNativeHandoff.defaultMaximumBufferedItems,
  ) {
    if (!Number.isSafeInteger(maximumBufferedItems) || maximumBufferedItems <= 0) {
      throw new RangeError("maximumBufferedItems must be a positive safe integer");
    }
    this.#sessionId = sessionId;
    this.#maximumBufferedItems = maximumBufferedItems;
  }

  public get state(): LifecycleHandoffState { return this.#state; }
  public get reason(): string | undefined { return this.#reason; }
  /** Exclusive sequence expected from the selected runtime epoch. */
  public get nextNativeSequence(): number | undefined { return this.#nextSequence; }

  /**
   * Buffer a selected-session item until install(). Once installed, return only
   * newly contiguous native events that the caller may apply.
   */
  public observe(item: AccessStreamItem): readonly NativeEvent[] {
    if (this.#state === "gap") return [];
    if (!this.#relevant(item)) return [];
    if (!this.#snapshot) {
      if (this.#buffer.length >= this.#maximumBufferedItems) {
        this.#fail("subscribe-first lifecycle buffer overflowed");
        return [];
      }
      this.#buffer.push(item);
      return [];
    }
    return this.#accept(item);
  }

  /** Install exactly one fenced snapshot and release its contiguous suffix. */
  public install(candidate: LifecycleSnapshot): readonly NativeEvent[] {
    if (this.#snapshot) throw new Error("lifecycle snapshot is already installed");
    const snapshot = lifecycleSnapshotSchema.parse(candidate);
    if (snapshot.state.fence.sessionId !== this.#sessionId) {
      this.#fail("lifecycle snapshot belongs to another session");
      return [];
    }
    this.#snapshot = snapshot;
    this.#nextSequence = snapshot.nextNativeSequence;
    if (this.#state === "gap") return [];

    const released: NativeEvent[] = [];
    for (const item of this.#buffer) {
      const accepted = this.#accept(item);
      if (this.#reason !== undefined) {
        this.#buffer = [];
        return [];
      }
      released.push(...accepted);
    }
    this.#buffer = [];
    this.#state = "continuous";
    return released;
  }

  #relevant(item: AccessStreamItem): item is RelevantItem {
    if (item.kind === "streamReset") return true;
    if (item.kind === "native" || item.kind === "nativeGap") {
      return item.sessionId === this.#sessionId;
    }
    if (item.kind !== "control") return false;
    const runtimeNodeId = this.#snapshot?.state.fence.runtimeNodeId;
    switch (item.change.type) {
      case "session.upsert":
        return item.change.session.sessionId === this.#sessionId;
      case "session.unavailable":
        return item.change.sessionId === this.#sessionId;
      case "runtimeNode.upsert":
        // Before install() the selected runtime is deliberately unknown, so
        // retain bounded runtime evidence and filter it against the snapshot.
        return runtimeNodeId === undefined ||
          item.change.runtimeNode.runtimeNodeId === runtimeNodeId;
      case "runtimeNode.presence":
        return runtimeNodeId === undefined ||
          item.change.runtimeNodeId === runtimeNodeId;
      default:
        return false;
    }
  }

  #accept(item: RelevantItem): readonly NativeEvent[] {
    const snapshot = this.#snapshot;
    if (!snapshot || this.#state === "gap") return [];
    if (item.kind === "streamReset") {
      this.#fail(`access stream reset: ${item.reason}`);
      return [];
    }
    if (item.kind === "nativeGap") {
      this.#fail(`native stream gap: ${item.reason}`);
      return [];
    }
    const fence = snapshot.state.fence;
    if (item.kind === "control") {
      switch (item.change.type) {
        case "session.unavailable":
          this.#fail("session became unavailable during lifecycle handoff");
          break;
        case "session.upsert": {
          const session = item.change.session;
          if (
            session.availability !== "active" ||
            session.runtimeNodeId !== fence.runtimeNodeId ||
            session.bindingRevision !== fence.bindingRevision ||
            session.runtimeEpoch !== fence.runtimeEpoch ||
            (session.lifecycle !== undefined &&
              session.lifecycle.fence.runtimeNodeBootId !== fence.runtimeNodeBootId)
          ) this.#fail("session binding changed during lifecycle handoff");
          break;
        }
        case "runtimeNode.upsert":
          if (item.change.runtimeNode.runtimeNodeId === fence.runtimeNodeId && (
            item.change.runtimeNode.runtimeNodeBootId !== fence.runtimeNodeBootId ||
            item.change.runtimeNode.presence !== "online" ||
            item.change.runtimeNode.reachability !== "reachable"
          )) this.#fail("runtime identity or reachability changed during lifecycle handoff");
          break;
        case "runtimeNode.presence":
          if (item.change.runtimeNodeId === fence.runtimeNodeId &&
              item.change.presence !== "online") {
            this.#fail("runtime became unavailable during lifecycle handoff");
          }
          break;
      }
      return [];
    }
    if (item.runtimeEpoch !== fence.runtimeEpoch) {
      this.#fail("runtime epoch changed during lifecycle handoff");
      return [];
    }
    const expected = this.#nextSequence!;
    if (item.sequence < expected) return [];
    if (item.sequence > expected) {
      this.#fail(`native sequence gap: expected ${expected}, received ${item.sequence}`);
      return [];
    }
    this.#nextSequence = expected + 1;
    return [item];
  }

  #fail(reason: string): void {
    this.#state = "gap";
    this.#reason = reason;
    this.#buffer = [];
  }
}
