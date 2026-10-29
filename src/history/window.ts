import type {
  Cursor,
  HistoryFeed,
  HistoryReadWindow,
  HistoryFeedSubscription,
  ReadFence,
  Frame,
  HistoryRecord,
  HistoryScope,
  OlderEdge,
  Snapshot,
  Update,
  WindowLimits,
} from "./contracts.js";
import {
  activity,
  bytes,
  canonical,
  check,
  edge,
  gap,
  historyScopeKey,
  immutable,
  integer,
  mergeOrder as merge,
  record,
  snapshot,
  text,
} from "./validation.js";

const defaults: WindowLimits = {
  maxRows: 128,
  maxBodyBytes: 65536,
  maxBytes: 524288,
  maxGaps: 128,
  maxReplayFrames: 32,
  maxReplayBytes: 1048576,
  maxSubscribers: 16,
  maxQueuedFrames: 8,
};

/** A quiet iterator has a real, immediate return: cancellation never waits for
 * the next producer event and never closes the history/native owner. */
export class HistorySubscription implements AsyncIterableIterator<Frame> {
  #queue: Frame[];
  #waiting: ((value: IteratorResult<Frame>) => void) | undefined;
  #closed = false;
  constructor(
    private readonly owner: HistoryWindow,
    frames: readonly Frame[],
  ) {
    this.#queue = [...frames];
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<Frame> {
    return this;
  }
  next(): Promise<IteratorResult<Frame>> {
    check(!this.#waiting, "CONCURRENT_NEXT");
    const value = this.#queue.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
  push(frame: Frame): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const accept = this.#waiting;
      this.#waiting = undefined;
      accept({ done: false, value: frame });
    } else if (this.#queue.length >= this.owner.limits.maxQueuedFrames)
      this.#queue = [this.owner.frame()];
    else this.#queue.push(frame);
  }
  async return(): Promise<IteratorResult<Frame>> {
    this.#closed = true;
    this.#queue = [];
    this.owner.release(this);
    if (this.#waiting) {
      const accept = this.#waiting;
      this.#waiting = undefined;
      accept({ done: true, value: undefined });
    }
    return { done: true, value: undefined };
  }
}

/** One exact stream's current evidence, with no native API, timer or global
 * scope registry. Eviction changes residency; a native history edit needs an explicit reset. */
export class HistoryWindow implements HistoryFeed, HistoryReadWindow {
  readonly scope: HistoryScope;
  readonly limits: WindowLimits;
  #snapshot: Snapshot;
  #replay: Frame[] = [];
  #replayBytes = 0;
  #closed = false;
  #subscribers = new Set<HistorySubscription>();
  #fences = new Set<ReadFence>();
  constructor(scope: HistoryScope, limits: Partial<WindowLimits> = {}, knownEmpty = false) {
    historyScopeKey(scope);
    this.scope = immutable(scope);
    this.limits = Object.freeze({ ...defaults, ...limits });
    for (const value of Object.values(this.limits)) {
      integer(value, 1);
      check(value <= 16777216, "INVALID_LIMIT");
    }
    check(this.limits.maxRows <= 4096 && this.limits.maxGaps <= 4096, "INVALID_LIMIT");
    this.#snapshot = immutable({
      scope: this.scope,
      generation: 1,
      revision: 0,
      readEpoch: 0,
      residencyOmitted: false,
      rows: [],
      gaps: [],
      olderEdge: knownEmpty
        ? { state: "end", evidence: "provedEmptyCapture" }
        : { state: "unknown", reason: "Prior boundary is unestablished" },
      activity: { state: "unknown", turnId: null },
    });
    check(bytes(this.#snapshot) <= this.limits.maxBytes, "WINDOW_FULL");
  }
  getSnapshot(): Snapshot {
    return this.#snapshot;
  }
  frame(): Frame {
    return immutable({ kind: "snapshot", snapshot: this.#snapshot });
  }
  get subscriberCount(): number {
    return this.#subscribers.size;
  }
  get replayBytes(): number {
    return this.#replayBytes;
  }
  subscribe(cursor?: Cursor): HistoryFeedSubscription {
    check(!this.#closed, "CLOSED");
    check(this.#subscribers.size < this.limits.maxSubscribers, "SUBSCRIBER_FULL");
    let frames: readonly Frame[] = [this.frame()];
    if (cursor) {
      integer(cursor.generation, 1);
      integer(cursor.revision);
      if (
        cursor.generation === this.#snapshot.generation &&
        cursor.revision <= this.#snapshot.revision
      ) {
        const replay = this.#replay.filter(
          (value) => value.kind === "commit" && value.revision > cursor.revision,
        );
        if (
          cursor.revision === this.#snapshot.revision ||
          (replay[0]?.kind === "commit" && replay[0].baseRevision === cursor.revision)
        )
          frames = replay;
      }
    }
    if (frames.length > this.limits.maxQueuedFrames) frames = [this.frame()];
    const stream = new HistorySubscription(this, frames);
    this.#subscribers.add(stream);
    return stream;
  }
  release(stream: HistorySubscription): void {
    this.#subscribers.delete(stream);
  }
  beginRead(): ReadFence {
    check(!this.#closed, "CLOSED");
    check(this.#fences.size < 16, "READ_FULL");
    const fence = Object.freeze({
      generation: this.#snapshot.generation,
      readEpoch: this.#snapshot.readEpoch,
      revision: this.#snapshot.revision,
    });
    this.#fences.add(fence);
    return fence;
  }
  readIsCurrent(fence: ReadFence): boolean {
    return (
      !this.#closed &&
      this.#fences.has(fence) &&
      fence.generation === this.#snapshot.generation &&
      fence.readEpoch === this.#snapshot.readEpoch
    );
  }
  endRead(fence: ReadFence): void {
    this.#fences.delete(fence);
  }
  update(input: Update): Snapshot {
    return this.#write(input);
  }
  /** A positive native edit/reader replacement fences paging, never reorders or
   * clears retained rows. An actual history reset is a separate transition. */
  invalidateReads(reason: string): void {
    text(reason, 1024);
    integer(this.#snapshot.readEpoch + 1);
    this.#write(
      { olderEdge: { state: "unknown", reason } },
      undefined,
      undefined,
      this.#snapshot.readEpoch + 1,
    );
  }
  publishRead(
    fence: ReadFence,
    rows: readonly HistoryRecord[],
    olderEdge: OlderEdge,
    placement: "before" | "after",
    gaps: Update["gaps"] = [],
  ): boolean {
    if (!this.readIsCurrent(fence)) return false;
    check(placement === "before" || placement === "after", "INVALID_PLACEMENT");
    this.#write({ rows, olderEdge, gaps }, fence, placement);
    return true;
  }
  #write(
    input: Update,
    fence?: ReadFence,
    placement?: "before" | "after",
    readEpoch = this.#snapshot.readEpoch,
  ): Snapshot {
    check(!this.#closed, "CLOSED");
    canonical(input);
    const previous = this.#snapshot,
      revision = previous.revision + 1;
    integer(revision, 1);
    const incoming = input.rows ?? [];
    check(incoming.length <= 4096, "PAGE_TOO_LARGE");
    incoming.forEach(record);
    check(new Set(incoming.map((value) => value.id)).size === incoming.length, "DUPLICATE_ROW");
    const rows = new Map(previous.rows.map((value) => [value.id, value]));
    for (const source of incoming) {
      const prior = rows.get(source.id);
      if (prior && fence && prior.version > fence.revision) continue;
      if (prior) check(prior.kind === source.kind, "IDENTITY_CONFLICT");
      if (
        prior &&
        prior.lifecycle !== "running" &&
        prior.lifecycle !== "unknown" &&
        (source.lifecycle === "running" || source.lifecycle === "unknown")
      )
        continue;
      if (
        prior?.body.kind === "complete" &&
        prior.lifecycle !== "running" &&
        prior.lifecycle !== "unknown" &&
        source.body.kind !== "complete"
      )
        continue;
      if (
        prior?.body.kind === "complete" &&
        source.body.kind === "complete" &&
        prior.lifecycle !== "running" &&
        prior.body.text !== source.body.text
      )
        check(false, "IDENTITY_CONFLICT");
      let value = structuredClone(source);
      if (value.body.kind !== "unavailable") {
        const encoded = new TextEncoder().encode(value.body.text);
        if (encoded.length > this.limits.maxBodyBytes)
          value = {
            ...value,
            body: {
              kind: "partial",
              text: new TextDecoder().decode(encoded.subarray(0, this.limits.maxBodyBytes), {
                stream: true,
              }),
              missing: [
                ...new Set([
                  ...(value.body.kind === "partial" ? value.body.missing : []),
                  "truncated" as const,
                ]),
              ],
            },
          };
      }
      const { version: _version, ...priorRecord } = prior ?? { version: 0 };
      if (!prior || canonical(priorRecord) !== canonical(value))
        rows.set(value.id, immutable({ ...value, version: revision }));
    }
    let order = previous.rows.map((value) => value.id).filter((id) => rows.has(id));
    order = placement
      ? merge(
          order,
          incoming.map((value) => value.id),
          placement === "before",
        )
      : [...order, ...incoming.map((value) => value.id).filter((id) => !order.includes(id))];
    const heldGaps = new Map(previous.gaps.map((value) => [value.id, value]));
    for (const id of input.clearGaps ?? []) {
      text(id);
      heldGaps.delete(id);
    }
    for (const value of input.gaps ?? []) {
      gap(value);
      const prior = value.rowId ? rows.get(value.rowId) : undefined;
      if (
        prior?.body.kind === "complete" &&
        prior.lifecycle !== "running" &&
        ["missingPrefix", "missingFinal"].includes(value.kind)
      )
        continue;
      heldGaps.set(value.id, immutable(value));
    }
    if (heldGaps.size > this.limits.maxGaps) {
      const summary = { id: "history:gap-details-omitted", kind: "truncated" as const };
      heldGaps.delete(summary.id);
      while (heldGaps.size >= this.limits.maxGaps) heldGaps.delete(heldGaps.keys().next().value!);
      heldGaps.set(summary.id, summary);
    }
    let nextEdge = input.olderEdge ?? previous.olderEdge,
      residencyOmitted = previous.residencyOmitted;
    const nextActivity = input.activity ?? previous.activity;
    edge(nextEdge);
    activity(nextActivity);
    const build = (): Snapshot => ({
      scope: this.scope,
      generation: previous.generation,
      revision,
      readEpoch,
      residencyOmitted,
      rows: order.map((id) => rows.get(id)!),
      olderEdge: nextEdge,
      gaps: [...heldGaps.values()],
      activity: nextActivity,
    });
    const protectedIds = new Set(incoming.map((value) => value.id)),
      evicted: string[] = [];
    const previousIds = new Set(previous.rows.map((value) => value.id));
    while (order.length > this.limits.maxRows || bytes(build()) > this.limits.maxBytes) {
      // Never jump over protected work to remove an interior range. Older
      // insertion trims the recent tail; live append trims the old prefix.
      const victim = placement === "before" ? order.at(-1) : order[0];
      check(
        victim !== undefined &&
          previousIds.has(victim) &&
          !protectedIds.has(victim) &&
          rows.get(victim)!.lifecycle !== "running",
        "WINDOW_FULL",
      );
      rows.delete(victim);
      if (placement === "before") order.pop();
      else order.shift();
      evicted.push(victim);
      residencyOmitted = true;
      if (placement !== "before")
        nextEdge =
          fence && incoming[0]?.id === order[0]
            ? (input.olderEdge ?? previous.olderEdge)
            : { state: "unknown", reason: "Earlier resident rows were omitted" };
    }
    const candidate = build();
    if (canonical({ ...candidate, revision: previous.revision }) === canonical(previous))
      return previous;
    snapshot(candidate);
    this.#snapshot = immutable(candidate);
    const frame: Frame = immutable({
      kind: "commit",
      scope: this.scope,
      generation: candidate.generation,
      baseRevision: previous.revision,
      revision,
      readEpoch,
      residencyOmitted,
      rows: candidate.rows.filter((value) => value.version === revision),
      placement: placement ?? "after",
      order,
      evicted,
      olderEdge: nextEdge,
      gaps: candidate.gaps,
      activity: nextActivity,
    });
    this.#replay.push(frame);
    this.#replayBytes += bytes(frame);
    while (
      this.#replay.length > this.limits.maxReplayFrames ||
      this.#replayBytes > this.limits.maxReplayBytes
    )
      this.#replayBytes -= bytes(this.#replay.shift()!);
    for (const stream of this.#subscribers) stream.push(frame);
    return this.#snapshot;
  }
  reset(reason: string): void {
    check(!this.#closed, "CLOSED");
    text(reason, 1024);
    const generation = this.#snapshot.generation + 1;
    integer(generation, 1);
    this.#snapshot = immutable({
      ...this.#snapshot,
      generation,
      revision: 0,
      readEpoch: 0,
      residencyOmitted: false,
      rows: [],
      gaps: [],
      olderEdge: { state: "unknown", reason },
      activity: { state: "unknown", turnId: null },
    });
    this.#fences.clear();
    this.#replay = [];
    this.#replayBytes = 0;
    for (const stream of this.#subscribers) stream.push(this.frame());
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fences.clear();
    for (const stream of [...this.#subscribers]) void stream.return();
  }
}

export function applyFrame(
  current: Snapshot | undefined,
  input: Frame,
): Readonly<{
  status: "applied" | "duplicate" | "stale" | "needsSnapshot";
  snapshot: Snapshot | undefined;
}> {
  const frame = immutable(input);
  if (frame.kind === "snapshot") {
    snapshot(frame.snapshot);
    if (current) {
      check(
        historyScopeKey(current.scope) === historyScopeKey(frame.snapshot.scope),
        "FOREIGN_SCOPE",
      );
      if (
        frame.snapshot.generation < current.generation ||
        (frame.snapshot.generation === current.generation &&
          frame.snapshot.revision < current.revision)
      )
        return { status: "stale", snapshot: current };
      if (
        frame.snapshot.generation === current.generation &&
        frame.snapshot.revision === current.revision
      ) {
        check(canonical(current) === canonical(frame.snapshot), "REVISION_CONFLICT");
        return { status: "duplicate", snapshot: current };
      }
      if (frame.snapshot.generation === current.generation)
        check(!current.residencyOmitted || frame.snapshot.residencyOmitted, "RESIDENCY_CONFLICT");
    }
    return { status: "applied", snapshot: frame.snapshot };
  }
  check(frame.kind === "commit", "INVALID_FRAME");
  historyScopeKey(frame.scope);
  integer(frame.generation, 1);
  integer(frame.baseRevision);
  integer(frame.revision, 1);
  check(frame.placement === "before" || frame.placement === "after", "INVALID_PLACEMENT");
  check(frame.revision === frame.baseRevision + 1, "REVISION_GAP");
  if (!current) return { status: "needsSnapshot", snapshot: undefined };
  check(historyScopeKey(current.scope) === historyScopeKey(frame.scope), "FOREIGN_SCOPE");
  if (
    frame.generation < current.generation ||
    (frame.generation === current.generation && frame.revision < current.revision)
  )
    return { status: "stale", snapshot: current };
  if (frame.generation !== current.generation || frame.baseRevision > current.revision)
    return { status: "needsSnapshot", snapshot: current };
  const rows = new Map(current.rows.map((value) => [value.id, value]));
  check(
    Array.isArray(frame.rows) &&
      frame.rows.length <= 4096 &&
      new Set(frame.rows.map((value) => value.id)).size === frame.rows.length,
    "INVALID_ROWS",
  );
  check(
    Array.isArray(frame.evicted) &&
      frame.evicted.length <= 4096 &&
      new Set(frame.evicted).size === frame.evicted.length,
    "INVALID_EVICTION",
  );
  for (const id of frame.evicted) {
    text(id);
    rows.delete(id);
  }
  for (const value of frame.rows) {
    record(value);
    integer(value.version, 1);
    check(value.version === frame.revision, "ROW_VERSION");
    const old = rows.get(value.id);
    if (old?.version === value.version)
      check(canonical(old) === canonical(value), "ROW_VERSION_CONFLICT");
    rows.set(value.id, value);
  }
  check(
    new Set(frame.order).size === frame.order.length &&
      frame.order.length === rows.size &&
      frame.order.every((id) => rows.has(id)),
    "INVALID_ORDER",
  );
  check(!current.residencyOmitted || frame.residencyOmitted, "RESIDENCY_CONFLICT");
  const next: Snapshot = {
    scope: frame.scope,
    generation: frame.generation,
    revision: frame.revision,
    readEpoch: frame.readEpoch,
    residencyOmitted: frame.residencyOmitted,
    rows: frame.order.map((id) => rows.get(id)!),
    gaps: frame.gaps,
    olderEdge: frame.olderEdge,
    activity: frame.activity,
  };
  snapshot(next);
  if (frame.revision === current.revision) {
    check(canonical(next) === canonical(current), "REVISION_CONFLICT");
    return { status: "duplicate", snapshot: current };
  }
  check(frame.baseRevision === current.revision, "REVISION_CONFLICT");
  return { status: "applied", snapshot: immutable(next) };
}
