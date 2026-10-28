import { CAPTURE_GAP_ID, type Action, type Activity, type Body, type CapturedScope, type CapturePort, type Change, type Coverage, type Cursor, type Frame, type Gap, type HistoryPage, type HistoryReadState, type Json, type OlderEdge, type Row, type RowKind, type Scope, type ScopeInventory, type Snapshot } from "../contracts/types.js";
import type { HistoryRecord } from "../acquisition/types.js";
import { mergeHistoryOrder } from "../contracts/order.js";
import { conversationKey, scopeKey } from "../contracts/identity.js";
import { canonical, cloneJson, deepFreeze, invariant, text, validateActions, validateFrame, validateRow, validateScope, validateScopeInventory, validateHistoryRead } from "../contracts/validation.js";
import { mediaMeaning, rowMedia } from "../contracts/media.js";

export interface HostLimits {
  maxReadRows: number; maxReadFences: number;
  maxRetirements: number; maxRows: number; maxBodyBytes: number; maxCurrentBytes: number; maxScopes: number; maxGaps: number;
  maxReplayFrames: number; maxReplayBytes: number; maxSubscribers: number; maxQueuedFrames: number;
}
const defaults: HostLimits = { maxReadRows: 1024, maxReadFences: 8, maxRetirements: 256, maxRows: 64, maxBodyBytes: 4096, maxCurrentBytes: 524_288, maxScopes: 32, maxGaps: 128,
  maxReplayFrames: 32, maxReplayBytes: 1_048_576, maxSubscribers: 16, maxQueuedFrames: 8 };
interface HeldRow { row: Row; knownStart: boolean; fromRead?: boolean; sequence: Map<string, { next: number; seen: Map<number, string> }> }
export type HistoryReadFence = Readonly<{ scope: Scope; generation: string; revision: number; readContext?: string; olderEdge: OlderEdge; nonce: symbol }>;
interface State { retirements: Map<string, Extract<Change, { kind: "retireRows" }>>; rows: Map<string, HeldRow>; order: string[]; gaps: Map<string, Gap>; edge: OlderEdge; activity: Activity; read: HistoryReadState; readBoundary?: string; scopeInventory?: ScopeInventory }
function copy(state: State): State {
  return { ...state, retirements: new Map(state.retirements), rows: new Map([...state.rows].map(([id, held]) => [id, { ...held,
    sequence: new Map([...held.sequence].map(([channel, seq]) => [channel, { next: seq.next, seen: new Map(seq.seen) }])) }])),
    order: [...state.order], gaps: new Map(state.gaps) };
}
function initial(): State { return { retirements: new Map(), rows: new Map(), order: [], gaps: new Map(), edge: { state: "unknown", reason: "Prior boundary is unestablished" }, activity: { turnId: null, state: "unknown" }, read: { state: "idle" } }; }
function bodyText(body: Body): string { return body.kind === "unavailable" ? "" : body.text; }
function fit(text: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= maximum ? { text, truncated: false }
    : { text: new TextDecoder().decode(bytes.subarray(0, maximum), { stream: true }), truncated: true };
}
function fact(id: string, kind: Gap["kind"]): Gap { return { id: JSON.stringify([kind, id]), kind, rowId: id }; }
const omittedGaps = "history:earlier-gap-annotations-omitted";

/** Native/history echoes cannot undo a file owner's established byte identity. */
function retainMedia(previous: Row["native"], next: Row["native"], fromRead = false): Row["native"] {
  if (previous.media === undefined) return next;
  if (next.media === undefined) return { ...next, media: previous.media };
  const prior = rowMedia({ native: previous }), incoming = rowMedia({ native: next });
  const media = incoming.map(value => {
    const old = prior.find(item => item.id === value.id && canonical(mediaMeaning([item])) === canonical(mediaMeaning([value])));
    if (!old) return value;
    if (old.state === "available") {
      if (value.state === "available") invariant(value.artifactId === old.artifactId, "MEDIA_ARTIFACT_CONFLICT");
      return old;
    }
    return fromRead && value.state === "pending" && old.state !== "pending" ? old : value;
  });
  return { ...next, media: media as unknown as Json };
}

export class HistorySubscription implements AsyncIterableIterator<Frame> {
  readonly boundary: Cursor;
  readonly mode: "snapshot" | "replay";
  private queue: Frame[];
  private waiter: ((result: IteratorResult<Frame>) => void) | undefined;
  private closed = false;
  overflowResets = 0;
  constructor(private readonly owner: HistoryOwner, frames: Frame[], mode: "snapshot" | "replay") {
    this.queue = frames; this.mode = mode;
    this.boundary = deepFreeze({ generation: owner.snapshot().generation, revision: owner.snapshot().revision });
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<Frame> { return this; }
  next(): Promise<IteratorResult<Frame>> {
    invariant(!this.waiter, "CONCURRENT_STREAM_NEXT");
    const frame = this.queue.shift();
    if (frame) return Promise.resolve({ done: false, value: frame });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => { this.waiter = resolve; });
  }
  drain(): readonly Frame[] { const frames = this.queue; this.queue = []; return frames; }
  push(frame: Frame): void {
    if (this.closed) return;
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve({ done: false, value: frame }); return; }
    if (this.queue.length >= this.owner.limits.maxQueuedFrames) { this.queue = [this.owner.snapshotFrame()]; this.overflowResets++; }
    else this.queue.push(frame);
  }
  async return(): Promise<IteratorResult<Frame>> {
    this.closed = true; this.queue = []; this.owner.release(this);
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve({ done: true, value: undefined }); }
    return { done: true, value: undefined };
  }
}

/** Pure native evidence and Host snapshot/replay. It has no native-read or effect port. */
export class HistoryOwner {
  readonly scope: Scope;
  private state = initial();
  private generationNumber = 1;
  private revision = 0;
  private knownStart: boolean;
  private readContext: string | undefined;
  private replay: { frame: Frame; bytes: number }[] = [];
  private replayBytes = 0;
  private subscribers = new Set<HistorySubscription>();
  private retired = false;
  private rowSerial = 0;
  private evidence = new Map<string, { row: Row; source: "native" | "read" }>();
  private evidenceOrder: string[] = [];
  private fences = new Map<HistoryReadFence, Set<string>>();
  private cached: Snapshot;
  constructor(scope: Scope, readonly limits: HostLimits, private readonly prefix: string, knownStart: boolean) {
    this.scope = deepFreeze(cloneJson(validateScope(scope))); this.knownStart = knownStart;
    if (knownStart) this.state.edge = { state: "end", evidence: "provedEmptyCapture" };
    this.cached = this.buildSnapshot();
  }
  private generation(): string { return `${this.prefix}:${this.generationNumber}`; }
  private coverage(state = this.state): Coverage { return { knownStart: this.knownStart, gaps: [...state.gaps.values()] }; }
  private buildSnapshot(): Snapshot {
    const snapshot: Snapshot = { scope: this.scope, generation: this.generation(), revision: this.revision,
      rows: this.state.order.map(id => this.state.rows.get(id)!.row), retirements: [...this.state.retirements.values()], olderEdge: this.state.edge, coverage: this.coverage(), activity: this.state.activity, read: this.state.read,
      ...(this.state.scopeInventory === undefined ? {} : { scopeInventory: this.state.scopeInventory }), ...(this.readContext === undefined ? {} : { readContext: this.readContext }) };
    const checked = validateFrame({ kind: "snapshot", snapshot }); invariant(checked.kind === "snapshot", "INTERNAL_FRAME"); return checked.snapshot;
  }
  snapshot(): Snapshot { return this.cached; }
  /** Last positive native edit fact, not an authorization or native cursor. */
  get readBoundary(): string | undefined { return this.state.readBoundary; }
  snapshotFrame(): Frame { return deepFreeze({ kind: "snapshot", snapshot: this.cached }); }
  /** Host-owned readonly projection; this never opens or authorizes a scope. */
  setScopeInventory(input: ScopeInventory): void {
    invariant(!this.retired, "OWNER_RETIRED");
    const inventory = deepFreeze(validateScopeInventory(cloneJson(input), this.scope));
    invariant(inventory.entries.length <= this.limits.maxScopes, "SCOPE_CAPACITY");
    if (canonical(this.state.scopeInventory ?? null) === canonical(inventory)) return;
    const previous = this.state, state = copy(previous); state.scopeInventory = inventory;
    this.commitState(previous, state, []);
  }
  /** A real reader change retires paging only. Captured/loaded rows keep their
   * identities, body versions, ordering and capture generation. */
  setReadContext(value: string): void {
    text(value, "READ_CONTEXT", 256); invariant(!this.retired, "OWNER_RETIRED");
    if (this.readContext === value) return;
    const previous = this.state, state = copy(previous), prior = this.readContext;
    if (state.edge.state === "available") state.edge = { state: "unknown", reason: "Native reader changed; check the original history boundary" };
    state.read = { state: "idle" }; this.readContext = value; this.fences.clear();
    try { this.commitState(previous, state, []); } catch (error) { this.readContext = prior; throw error; }
  }
  /** Read-only acquisition status. The caller supplies its exact publication fence. */
  setReadState(value: HistoryReadState, generation: string, context: string | undefined): void {
    if (this.retired || this.generation() !== generation || this.readContext !== context) return;
    const read = validateHistoryRead(value); if (canonical(read) === canonical(this.state.read)) return;
    const previous = this.state, state = copy(previous); state.read = read; this.commitState(previous, state, []);
  }
  private update(held: HeldRow, changes: Partial<Row>): void {
    const candidate = { ...held.row, ...changes }; if (canonical(candidate) === canonical(held.row)) return;
    invariant(this.rowSerial < Number.MAX_SAFE_INTEGER, "ROW_VERSION_EXHAUSTED");
    const version = ++this.rowSerial;
    held.row = deepFreeze({ ...candidate, version,
      contentVersion: canonical(candidate.body) === canonical(held.row.body) ? held.row.contentVersion : version });
  }
  private gap(state: State, gap: Gap): void {
    const prior = gap.rowId ? state.rows.get(gap.rowId)?.row ?? this.evidence.get(gap.rowId)?.row : undefined;
    // Forgetting an accumulator's prefix/final cannot contradict an exact
    // terminal full body already proved by capture or a native read.
    if ((gap.kind === "missingPrefix" || gap.kind === "missingFinal") && prior?.body.kind === "complete" && prior.lifecycle !== "running" && prior.lifecycle !== "unknown") return;
    state.gaps.set(gap.id, gap);
    if (state.gaps.size > this.limits.maxGaps) {
      // Coverage is a bounded annotation window. Omission never heals the
      // affected partial bodies or certifies an intact capture prefix.
      state.gaps.set(omittedGaps, { id: omittedGaps, kind: "truncated" });
      const boundary = state.readBoundary === undefined ? undefined : JSON.stringify(["nativeReadBoundary", state.readBoundary]);
      while (state.gaps.size > this.limits.maxGaps) {
        const id = [...state.gaps.keys()].find(id => id !== omittedGaps && id !== CAPTURE_GAP_ID && id !== boundary);
        invariant(id !== undefined, "GAP_CAPACITY"); state.gaps.delete(id);
      }
    }
    const held = gap.rowId ? state.rows.get(gap.rowId) : undefined;
    if (held && held.row.body.kind !== "unavailable" && !(held.row.body.kind === "complete" && !held.fromRead
      && held.row.lifecycle !== "running" && held.row.lifecycle !== "unknown" && (gap.kind === "nativeGap" || gap.kind === "identity"))) {
      const missing = new Set(held.row.body.kind === "partial" ? held.row.body.missing : []);
      missing.add(gap.kind === "missingPrefix" ? "prefix" : gap.kind === "truncated" ? "truncated" : gap.kind === "missingFinal" ? "final" : "interior");
      this.update(held, { body: { kind: "partial", text: held.row.body.text, missing: [...missing] } });
    }
  }
  private clearBodyGaps(state: State, id: string): void {
    for (const [key, gap] of state.gaps) if (gap.rowId === id && ["missingPrefix", "missingFinal", "nativeGap", "truncated"].includes(gap.kind)) state.gaps.delete(key);
  }
  private ensure(state: State, id: string, kind: RowKind, knownStart: boolean): HeldRow {
    invariant(!state.retirements.has(id), "RETIRED_NATIVE_IDENTITY");
    let held = state.rows.get(id); if (held) { invariant(held.row.kind === kind, "ROW_KIND_CHANGED"); return held; }
    const cached = this.evidence.get(id);
    if (cached) invariant(cached.row.kind === kind, "ROW_KIND_CHANGED");
    const row: Row = cached?.row ?? { id, kind, lifecycle: "running", body: { kind: "partial", text: "", missing: knownStart ? ["final"] : ["prefix", "final"] }, native: {}, version: 0, contentVersion: 0 };
    held = { row, knownStart: cached ? false : knownStart, ...(cached?.source === "read" ? { fromRead: true } : {}), sequence: new Map() };
    state.rows.set(id, held); state.order.push(id);
    if (cached) state.order = mergeHistoryOrder(this.evidenceOrder.filter(value => state.rows.has(value)), state.order.filter(value => !this.evidence.has(value)), false);
    else if (!knownStart) this.gap(state, fact(id, "missingPrefix")); return held;
  }
  private evictCurrent(previous: State, state: State, protectedIds: ReadonlySet<string> = new Set()): Row[] {
    const evicted: Row[] = [];
    // Count serialized bytes, including native metadata and JSON escaping. A
    // large complete body stays intact; residency rolls instead of truncating
    // every message to make a fixed row count fit a wire frame.
    const sizes = new Map(state.order.map(id => [id, new TextEncoder().encode(JSON.stringify(state.rows.get(id)!.row)).byteLength]));
    let bytes = 2 + Math.max(0, state.order.length - 1) + [...sizes.values()].reduce((sum, size) => sum + size, 0);
    while (state.order.length > this.limits.maxRows || bytes > this.limits.maxCurrentBytes) {
      const id = state.order.find(id => previous.rows.has(id) && !protectedIds.has(id) && state.rows.get(id)!.row.lifecycle !== "running");
      invariant(id !== undefined, "PROTECTED_ROW_CAPACITY");
      evicted.push(state.rows.get(id)!.row); bytes -= sizes.get(id)! + Number(state.order.length > 1);
      state.order = state.order.filter(value => value !== id); state.rows.delete(id);
    }
    return evicted;
  }
  private trimEvidence(evidence: Map<string, { row: Row; source: "native" | "read" }>, order: readonly string[], state: State, protectedIds: ReadonlySet<string> = new Set()): string[] {
    // Evidence is bounded residency, not a lifetime conversation quota. Running
    // rows and the current/read result remain protected; retirement proofs have
    // their separate ledger and are never manufactured by cache eviction.
    for (const id of order) {
      if (evidence.size <= this.limits.maxReadRows) break;
      if (!state.rows.has(id) && !protectedIds.has(id) && evidence.get(id)?.row.lifecycle !== "running") evidence.delete(id);
    }
    invariant(evidence.size <= this.limits.maxReadRows, "HISTORY_EVIDENCE_CAPACITY");
    return order.filter(id => evidence.has(id));
  }
  private metadata(held: HeldRow, native: Readonly<Row["native"]> | undefined): void {
    if (native) this.update(held, { native: { ...held.row.native, ...retainMedia(held.row.native, native) } });
  }
  ingest(input: readonly Action[]): void {
    invariant(!this.retired, "OWNER_RETIRED"); const actions = validateActions(input);
    const previous = this.state, state = copy(previous), retirements: Change[] = [];
    for (const action of actions) {
      if (action.type === "activity") { state.activity = action.activity; continue; }
      if (action.type === "gap") { this.gap(state, action.gap); continue; }
      if (action.type === "clearGap") { state.gaps.delete(action.id); continue; }
      if (action.type === "edge") { state.edge = action.edge; continue; }
      if (action.type === "readBoundary") {
        const id = JSON.stringify(["nativeReadBoundary", action.factId]);
        if (state.gaps.has(id)) continue;
        state.readBoundary = action.factId; this.gap(state, { id, kind: "nativeGap" });
        state.edge = { state: "unknown", reason: action.reason }; continue;
      }
      if (action.type === "media") {
        const held = state.rows.get(action.id); invariant(held, "MEDIA_ROW_MISSING");
        invariant(canonical(mediaMeaning(rowMedia(held.row))) === canonical(mediaMeaning(action.media)), "MEDIA_IDENTITY_CONFLICT");
        this.update(held, { native: { ...held.row.native, ...retainMedia(held.row.native, { media: action.media as unknown as Json }) } });
        continue;
      }
      if (action.type === "retire") {
        for (const id of action.rowIds) {
          const proof: Extract<Change, { kind: "retireRows" }> = { kind: "retireRows", rowIds: [id], evidence: action.evidence, ...(action.replacementId === undefined ? {} : { replacementId: action.replacementId }) };
          const old = state.retirements.get(id); invariant(!old || canonical(old) === canonical(proof), "RETIREMENT_EVIDENCE_CONFLICT");
          invariant(old || state.retirements.size < this.limits.maxRetirements, "RETIREMENT_CAPACITY"); state.retirements.set(id, proof);
          state.rows.delete(id); state.order = state.order.filter(x => x !== id); for (const [key, gap] of state.gaps) if (gap.rowId === id) state.gaps.delete(key); }
        retirements.push({ kind: "retireRows", rowIds: action.rowIds, evidence: action.evidence,
          ...(action.replacementId === undefined ? {} : { replacementId: action.replacementId }) }); continue;
      }
      const resident = state.rows.get(action.id), cached = this.evidence.get(action.id), proved = resident?.row ?? cached?.row;
      if (proved?.body.kind === "complete" && (resident ? !resident.fromRead : cached?.source === "native") && proved.lifecycle !== "running" && proved.lifecycle !== "unknown") {
        invariant(proved.kind === action.kind, "ROW_KIND_CHANGED");
        if (action.type === "start" || action.type === "append" || action.type === "replace") continue;
        if (action.type === "finish") {
          if (action.lifecycle !== proved.lifecycle || typeof action.text === "string" && action.text !== proved.body.text) {
            this.gap(state, { id: JSON.stringify(["conflictingNativeFinal", action.id]), kind: "nativeGap", rowId: action.id }); continue;
          }
          if (!resident) continue;
        }
      }
      const existed = !!resident || !!cached, held = this.ensure(state, action.id, action.kind, action.type === "start");
      if (held.fromRead && ["start", "append", "replace"].includes(action.type)) {
        // Read bytes have no native callback continuation fence. Never append a
        // raw suffix to them or make a terminal historical record run again.
        if (["completed", "failed", "interrupted"].includes(held.row.lifecycle)) continue;
        held.fromRead = false; held.knownStart = action.type === "start"; held.sequence.clear();
        this.update(held, { lifecycle: "running", body: { kind: "partial", text: "", missing: held.knownStart ? ["final"] : ["prefix", "final"] } });
        this.gap(state, fact(action.id, "nativeGap"));
      }
      if (action.type === "start") {
        if ((!existed || held.row.body.kind === "partial" && held.row.body.text === "") && action.text === null) this.update(held, { body: { kind: "unavailable", reason: "nativeOmitted" } });
        if ((!existed || held.row.body.kind === "partial" && held.row.body.text === "") && typeof action.text === "string") {
          const body = fit(action.text, this.limits.maxBodyBytes);
          this.update(held, { body: { kind: "partial", text: body.text, missing: body.truncated ? ["final", "truncated"] : ["final"] } });
          if (body.truncated) this.gap(state, fact(action.id, "truncated"));
        }
        this.metadata(held, action.native); continue;
      }
      if (action.type === "append") {
        if (held.row.lifecycle !== "running") continue;
        if (action.sequence !== undefined) {
          const channel = action.channel ?? "output"; let sequence = held.sequence.get(channel);
          if (!sequence) { invariant(held.sequence.size < 8, "CHANNEL_CAPACITY"); sequence = { next: 0, seen: new Map() }; held.sequence.set(channel, sequence); }
          if (action.sequence < sequence.next) { if (sequence.seen.get(action.sequence) !== action.text) this.gap(state, fact(action.id, "nativeGap")); continue; }
          if (action.sequence !== sequence.next) this.gap(state, fact(action.id, "nativeGap"));
          sequence.next = action.sequence + 1; sequence.seen.set(action.sequence, action.text);
          if (sequence.seen.size > 64) sequence.seen.delete(sequence.seen.keys().next().value!);
        }
        if (held.row.body.kind === "partial" && held.row.body.missing.includes("truncated")) continue;
        const body = fit(bodyText(held.row.body) + action.text, this.limits.maxBodyBytes);
        const missing = new Set(held.row.body.kind === "partial" ? held.row.body.missing : []); missing.add("final");
        if (!held.knownStart) missing.add("prefix"); if (body.truncated) missing.add("truncated");
        this.update(held, { body: { kind: "partial", text: body.text, missing: [...missing] } });
        if (body.truncated) this.gap(state, fact(action.id, "truncated")); continue;
      }
      if (action.type === "replace") {
        if (held.row.lifecycle !== "running") continue;
        const body = fit(action.text, this.limits.maxBodyBytes); held.knownStart = true; this.clearBodyGaps(state, action.id);
        this.update(held, { body: { kind: "partial", text: body.text, missing: body.truncated ? ["final", "truncated"] : ["final"] } });
        if (body.truncated) this.gap(state, fact(action.id, "truncated")); this.metadata(held, action.native); continue;
      }
      if (action.type === "finish") {
        if (typeof action.text === "string") {
          const body = fit(action.text, this.limits.maxBodyBytes); this.clearBodyGaps(state, action.id); held.knownStart = true; held.fromRead = false;
          this.update(held, { lifecycle: action.lifecycle, body: body.truncated ? { kind: "partial", text: body.text, missing: ["truncated"] }
            : { kind: "complete", text: action.text, evidence: "nativeFullBody" } });
          if (body.truncated) this.gap(state, fact(action.id, "truncated"));
        } else {
          const body = held.row.body;
          const canSeal = action.sealCaptured && held.knownStart && body.kind === "partial" && body.missing.every(x => x === "final");
          this.update(held, { lifecycle: action.lifecycle, ...(canSeal ? { body: { kind: "complete", text: body.text, evidence: "capturedStartThroughEnd" } as Body }
            : !existed && bodyText(body) === "" ? { body: { kind: "unavailable", reason: "nativeOmitted" } as Body } : {}) });
          if (canSeal) this.clearBodyGaps(state, action.id);
          else if (held.row.body.kind === "partial") this.gap(state, fact(action.id, "missingFinal"));
        }
        this.metadata(held, action.native);
      }
    }
    const evicted = this.evictCurrent(previous, state);
    if (evicted.length && state.edge.state === "end") state.edge = { state: "unknown", reason: "Earlier captured rows left the current window" };
    const changes: Change[] = [...retirements];
    for (const row of evicted) if (canonical(row) !== canonical(previous.rows.get(row.id)?.row ?? null)) changes.push({ kind: "replaceRow", row });
    for (const id of state.order) { const row = state.rows.get(id)!.row; if (canonical(row) !== canonical(previous.rows.get(id)?.row ?? null)) changes.push({ kind: "replaceRow", row }); }
    if (evicted.length) changes.push({ kind: "evictCurrentRows", rowIds: evicted.map(row => row.id) });
    if (!changes.length && canonical(state.order) === canonical(previous.order) && canonical([...state.gaps.values()]) === canonical([...previous.gaps.values()])
      && canonical(state.edge) === canonical(previous.edge) && canonical(state.activity) === canonical(previous.activity)) { this.state = state; return; }
    this.commitState(previous, state, changes);
  }
  private commitState(previous: State, state: State, changes: readonly Change[]): void {
    invariant(this.revision < Number.MAX_SAFE_INTEGER, "REVISION_EXHAUSTED");
    const frame = validateFrame({ kind: "commit", scope: this.scope, generation: this.generation(), baseRevision: this.revision, revision: this.revision + 1,
      changes, order: state.order, olderEdge: state.edge, coverage: this.coverage(state), activity: state.activity,
      ...(state.read === previous.read ? {} : { read: state.read }),
      ...(state.scopeInventory === previous.scopeInventory ? {} : { scopeInventory: state.scopeInventory }), ...(this.readContext === undefined ? {} : { readContext: this.readContext }) });
    const evidence = new Map(this.evidence);
    for (const change of changes) if (change.kind === "replaceRow") evidence.set(change.row.id, { row: change.row, source: state.rows.get(change.row.id)?.fromRead ? "read" : "native" });
    for (const id of state.retirements.keys()) evidence.delete(id);
    const evidenceOrder = this.trimEvidence(evidence, mergeHistoryOrder(this.evidenceOrder.filter(id => evidence.has(id)), state.order, false), state);
    const proofEvicted = [...this.evidence.keys()].some(id => !evidence.has(id) && !state.retirements.has(id));
    const oldRevision = this.revision; this.state = state; this.revision++;
    try { this.cached = this.buildSnapshot(); } catch (error) { this.state = previous; this.revision = oldRevision; throw error; }
    this.evidence = evidence; this.evidenceOrder = evidenceOrder;
    // An outstanding read cannot be merged after the evidence needed to reject
    // its stale bodies left memory. This retires only its local publication
    // fence; the admitted native read still owns its resources until settlement.
    if (proofEvicted || state.readBoundary !== previous.readBoundary) this.fences.clear();
    for (const [fence, changed] of this.fences) {
      for (const change of changes) {
        if (change.kind === "replaceRow") {
          const before = previous.rows.get(change.row.id)?.row;
          const { media: _oldMedia, ...oldNative } = before?.native ?? {}, { media: _newMedia, ...newNative } = change.row.native;
          if (!before || before.contentVersion !== change.row.contentVersion || before.lifecycle !== change.row.lifecycle ||
              before.kind !== change.row.kind || canonical(oldNative) !== canonical(newNative)) changed.add(change.row.id);
        } else for (const id of change.rowIds) changed.add(id);
      }
      if (changed.size > this.limits.maxReadRows) this.fences.delete(fence);
    }
    this.publish(frame);
  }
  /** Local publication fence only; not a native snapshot/callback cursor. */
  beginRead(): HistoryReadFence {
    invariant(!this.retired && this.fences.size < this.limits.maxReadFences, "READ_FENCE_CAPACITY");
    const fence = Object.freeze({ scope: this.scope, generation: this.generation(), revision: this.revision, olderEdge: this.cached.olderEdge, nonce: Symbol("native-read"), ...(this.readContext === undefined ? {} : { readContext: this.readContext }) });
    this.fences.set(fence, new Set()); return fence;
  }
  endRead(fence: HistoryReadFence): void { this.fences.delete(fence); }
  readIsCurrent(fence: HistoryReadFence): boolean { return !this.retired && this.fences.has(fence) && fence.generation === this.generation(); }
  /** Host assigns versions; history cannot replay live activity, edits, ownership or effects. */
  mergeRead(fence: HistoryReadFence, input: readonly HistoryRecord[], edge: OlderEdge, gaps: readonly Gap[], baseline: boolean): HistoryPage | null {
    if (!this.readIsCurrent(fence)) return null;
    const records = cloneJson(input); invariant(records.length <= 128, "READ_RECORD_LIMIT");
    const ids = new Set<string>();
    for (const record of records) {
      invariant(Object.keys(record).every(key => ["id", "kind", "lifecycle", "body", "native"].includes(key)), "NATIVE_RECORD_VERSION");
      invariant(!ids.has(record.id), "DUPLICATE_READ_RECORD"); ids.add(record.id);
      validateRow({ ...record, version: 0, contentVersion: 0 });
      invariant(record.body.kind !== "complete" || record.body.evidence === "nativeFullBody", "READ_BODY_EVIDENCE");
    }
    const boundary = validateFrame({ kind: "snapshot", snapshot: { scope: this.scope, generation: this.generation(), revision: this.revision,
      rows: records.map(record => ({ ...record, version: 0, contentVersion: 0 })), retirements: [], olderEdge: edge,
      coverage: { knownStart: false, gaps }, activity: { turnId: null, state: "unknown" } } });
    invariant(boundary.kind === "snapshot", "INTERNAL_FRAME"); edge = boundary.snapshot.olderEdge; gaps = boundary.snapshot.coverage.gaps;
    const previous = this.state, state = copy(previous), evidence = new Map(this.evidence);
    const changed = this.fences.get(fence)!;
    const selected: Row[] = [], changes: Change[] = [];
    for (const raw of records) {
      const fitted = raw.body.kind === "unavailable" ? null : fit(raw.body.text, this.limits.maxBodyBytes);
      const body: Body = fitted?.truncated ? { kind: "partial", text: fitted.text, missing: [...new Set([...(raw.body.kind === "partial" ? raw.body.missing : []), "truncated" as const])] } : raw.body;
      let record: HistoryRecord = { ...raw, body };
      if (state.retirements.has(record.id)) continue;
      const prior = evidence.get(record.id);
      if (prior) {
        record = { ...record, native: retainMedia(prior.row.native, record.native, true) };
        invariant(prior.row.kind === record.kind, "HISTORY_KIND_CONFLICT");
        for (const key of ["threadId", "turnId", "nativeItemId", "channel", "index", "messageId", "reasoningId", "toolCallId", "originatingMessageId", "agentId", "parentToolCallId"])
          if (prior.row.native[key] !== undefined && record.native[key] !== undefined)
            invariant(canonical(prior.row.native[key]) === canonical(record.native[key]), "HISTORY_IDENTITY_CONFLICT");
      }
      if (prior && (changed.has(record.id) || prior.source === "native")) {
        // An unchanged partial may be healed only by exact positive terminal
        // full-body evidence. Unknown history lifecycle cannot certify this.
        const terminal = ["completed", "failed", "interrupted"].includes(record.lifecycle);
        if (!changed.has(record.id) && terminal && record.body.kind === "complete" && prior.row.body.kind !== "complete") {
          const held: HeldRow = { row: prior.row, knownStart: true, sequence: new Map() };
          this.update(held, { body: record.body, lifecycle: record.lifecycle, native: { ...prior.row.native, ...record.native } });
          evidence.set(record.id, { row: held.row, source: "native" });
          if (state.rows.has(record.id)) { state.rows.set(record.id, held); this.clearBodyGaps(state, record.id); changes.push({ kind: "replaceRow", row: held.row }); }
          selected.push(held.row); continue;
        }
        if (!changed.has(record.id) && terminal && record.body.kind === "complete" && prior.row.body.kind === "complete")
          invariant(record.body.text === prior.row.body.text, "HISTORY_BODY_CONFLICT");
        selected.push(prior.row); continue;
      }
      if (prior) {
        if (prior.row.body.kind === "complete" && record.body.kind === "complete") invariant(prior.row.body.text === record.body.text, "HISTORY_BODY_CONFLICT");
        if (canonical({ ...record, version: prior.row.version, contentVersion: prior.row.contentVersion }) === canonical(prior.row) || record.body.kind !== "complete") {
          selected.push(prior.row); continue;
        }
      }
      if (body.kind === "complete") this.clearBodyGaps(state, record.id);
      if (fitted?.truncated) this.gap(state, fact(record.id, "truncated"));
      const held: HeldRow = { row: prior?.row ?? { ...record, body, version: 0, contentVersion: 0 }, knownStart: false, fromRead: true, sequence: new Map() };
      this.update(held, { ...record, body });
      if (held.row.version === 0) { invariant(this.rowSerial < Number.MAX_SAFE_INTEGER, "ROW_VERSION_EXHAUSTED"); const version = ++this.rowSerial; held.row = deepFreeze({ ...held.row, version, contentVersion: version }); }
      evidence.set(record.id, { row: held.row, source: "read" }); selected.push(held.row);
      if (state.rows.has(record.id)) state.rows.set(record.id, held);
    }
    let order = mergeHistoryOrder(this.evidenceOrder.filter(id => evidence.has(id)), selected.map(row => row.id), true);
    let evicted: Row[] = [];
    if (baseline) {
      for (const row of selected) if (!state.rows.has(row.id)) {
        const source = evidence.get(row.id)!.source;
        state.rows.set(row.id, { row, knownStart: false, fromRead: source === "read", sequence: new Map() }); changes.push({ kind: "replaceRow", row });
      }
      state.order = mergeHistoryOrder(state.order, selected.map(row => row.id), true);
      evicted = this.evictCurrent(previous, state, ids);
      if (canonical(state.edge) === canonical(fence.olderEdge)) state.edge = edge;
    }
    const acceptedGaps = gaps.filter(gap => !gap.rowId || !changed.has(gap.rowId) && evidence.get(gap.rowId)?.source !== "native");
    for (const gap of acceptedGaps) this.gap(state, gap);
    // Gap annotations can change a resident body/version. Project only final
    // staged rows so a page, current snapshot and later evidence agree.
    for (let index = 0; index < selected.length; index++) {
      const row = selected[index]!, held = state.rows.get(row.id);
      if (held) { selected[index] = held.row; evidence.set(row.id, { row: held.row, source: held.fromRead ? "read" : "native" }); }
    }
    for (const [id, held] of state.rows) evidence.set(id, { row: held.row, source: held.fromRead ? "read" : "native" });
    order = this.trimEvidence(evidence, order, state, ids);
    const proofEvicted = [...this.evidence.keys()].some(id => !evidence.has(id) && !state.retirements.has(id));
    changes.length = 0;
    for (const id of state.order) {
      const row = state.rows.get(id)!.row;
      if (canonical(row) !== canonical(previous.rows.get(id)?.row ?? null)) changes.push({ kind: "replaceRow", row });
    }
    if (evicted.length) changes.push({ kind: "evictCurrentRows", rowIds: evicted.map(row => row.id) });
    // Validate the complete outbound page and staged state before either can publish.
    const checked = validateFrame({ kind: "snapshot", snapshot: { scope: this.scope, generation: this.generation(), revision: this.revision,
      rows: selected, retirements: [], olderEdge: edge, coverage: { knownStart: false, gaps: acceptedGaps }, activity: { turnId: null, state: "unknown" } } });
    invariant(checked.kind === "snapshot", "INTERNAL_FRAME");
    if (changes.length || canonical(state.edge) !== canonical(previous.edge) || canonical([...state.gaps]) !== canonical([...previous.gaps])) this.commitState(previous, state, changes);
    if (proofEvicted) this.fences.clear();
    this.evidence = evidence; this.evidenceOrder = order;
    return deepFreeze({ scope: this.scope, generation: this.generation(), rows: selected, olderEdge: edge, ...(this.readContext === undefined ? {} : { readContext: this.readContext }) });
  }
  private publish(frame: Frame): void {
    const bytes = new TextEncoder().encode(canonical(frame)).byteLength; this.replay.push({ frame, bytes }); this.replayBytes += bytes;
    while (this.replay.length > this.limits.maxReplayFrames || this.replayBytes > this.limits.maxReplayBytes) this.replayBytes -= this.replay.shift()!.bytes;
    for (const subscriber of this.subscribers) subscriber.push(frame);
  }
  watch(cursor?: Cursor): HistorySubscription {
    invariant(!this.retired, "OWNER_RETIRED"); invariant(this.subscribers.size < this.limits.maxSubscribers, "SUBSCRIBER_CAPACITY");
    if (cursor) invariant(typeof cursor.generation === "string" && Number.isSafeInteger(cursor.revision) && cursor.revision >= 0, "INVALID_CURSOR");
    let frames: Frame[] = [this.snapshotFrame()], mode: "snapshot" | "replay" = "snapshot";
    if (cursor?.generation === this.generation() && cursor.revision <= this.revision) {
      const replay = this.replay.filter(x => x.frame.kind === "commit" && x.frame.revision > cursor.revision).map(x => x.frame);
      if (cursor.revision === this.revision || (replay[0]?.kind === "commit" && replay[0].baseRevision === cursor.revision)) { frames = replay; mode = "replay"; }
    }
    if (frames.length > this.limits.maxQueuedFrames) { frames = [this.snapshotFrame()]; mode = "snapshot"; }
    const subscription = new HistorySubscription(this, frames, mode); this.subscribers.add(subscription); return subscription;
  }
  release(subscription: HistorySubscription): void { this.subscribers.delete(subscription); }
  reset(reason: string): void {
    invariant(!this.retired, "OWNER_RETIRED"); invariant(reason.length > 0 && reason.length <= 1024, "RESET_REASON");
    this.generationNumber++; this.revision = 0; this.knownStart = false;
    this.state = { ...initial(), ...(this.state.scopeInventory === undefined ? {} : { scopeInventory: this.state.scopeInventory }) };
    this.evidence.clear(); this.evidenceOrder = [];
    this.fences.clear();
    this.state.gaps.set("nativeReset", { id: "nativeReset", kind: "nativeGap" }); this.state.edge = { state: "unknown", reason };
    this.replay = []; this.replayBytes = 0; this.cached = this.buildSnapshot();
    for (const subscriber of this.subscribers) subscriber.push(this.snapshotFrame());
  }
  /** End current observers/cursors while retaining the projection for an
   * explicit passive read. This grants neither capture nor native ownership. */
  disconnect(): void { this.fences.clear(); for (const subscriber of [...this.subscribers]) void subscriber.return(); }
  retire(): void { this.retired = true; this.disconnect(); }
  get subscriberCount(): number { return this.subscribers.size; }
}

export class HistoryHub implements CapturePort {
  readonly limits: HostLimits;
  private owners = new Map<string, HistoryOwner>();
  private active = new Map<string, string>();
  private serial = 0;
  constructor(limits: Partial<HostLimits> = {}) {
    this.limits = Object.freeze({ ...defaults, ...limits });
    for (const value of Object.values(this.limits)) invariant(Number.isSafeInteger(value) && value > 0 && value <= 1_048_576, "INVALID_LIMIT");
    invariant(this.limits.maxReadRows <= 1024 && this.limits.maxReadFences <= 32 && this.limits.maxRetirements <= 1024 && this.limits.maxRows <= 1024 && this.limits.maxGaps <= 256 && this.limits.maxBodyBytes <= 65_536, "INVALID_LIMIT");
  }
  open(scope: Scope, options: Readonly<{ knownStart?: boolean }> = {}): void {
    validateScope(scope); const key = scopeKey(scope), logical = conversationKey(scope); if (this.owners.has(key)) return;
    const old = this.active.get(logical); invariant(old !== undefined || this.owners.size < this.limits.maxScopes, "SCOPE_CAPACITY");
    const candidate = new HistoryOwner(scope, this.limits, `host-observation-${this.serial + 1}`, options.knownStart ?? false);
    if (old) { this.owners.get(old)!.retire(); this.owners.delete(old); }
    this.serial++; this.owners.set(key, candidate); this.active.set(logical, key);
  }
  owner(scope: Scope): HistoryOwner { const owner = this.owners.get(scopeKey(scope)); invariant(owner, "UNKNOWN_OR_RETIRED_SCOPE"); return owner; }
  emit(scope: Scope, actions: readonly Action[]): void { this.owner(scope).ingest(actions); }
  reset(scope: Scope, reason: string): void { this.owner(scope).reset(reason); }
  snapshot(scope: Scope): Snapshot { return this.owner(scope).snapshot(); }
  watch(scope: Scope, cursor?: Cursor): HistorySubscription { return this.owner(scope).watch(cursor); }
}
