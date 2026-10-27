import type { CapturedScope, HistoryPage, HistoryReadTarget, Scope } from "../contracts/types.js";
import { sameScope } from "../contracts/identity.js";
import { canonical, cloneJson, deepFreeze, invariant, PrimitiveError, text, validateCapturedScopes, validateRow, validateScope } from "../contracts/validation.js";
import type { HistoryOwner } from "../host/history-owner.js";
import { ReadCoordinator, type ExceptionReason, type ReadHandle, type ReadRequest } from "../repair/read-coordinator.js";
import type { AcquisitionBatch, AcquisitionPort } from "./types.js";

export type AcquisitionResult =
  | Readonly<{ status: "ready"; page: HistoryPage }>
  | Readonly<{ status: "stale" | "expired" | "unsupported" }>;
export type AcquisitionLimits = Readonly<{
  count?: number; maxBytes?: number; maxCallsPerPage?: number;
  /** Native cursor/retired-baseline identities, never a second body store. */
  maxTombstones?: number; maxTombstoneBytes?: number;
}>;
type Episode = { key: string; meaning: string; request: ReadRequest; handle: ReadHandle<AcquisitionResult>; target: HistoryReadTarget;
  generation: string; context: string | undefined; retries: number; retryToken: string | undefined; renewedFrom: string | undefined };
const baselineReasons = new Set<ExceptionReason>(["E01", "E02", "E06", "E07", "E08", "E09", "E11", "E12", "E16", "E17", "E20", "E21", "E27", "E28", "E29"]);

/** One attachment-owned paging frontier. Actual work outlives its observers;
 * completed paging receipts have bounded retention, not a lifetime page quota. */
export class HistoryAcquisition<S extends Scope = Scope> {
  readonly scope: S;
  readonly reads: ReadCoordinator;
  readonly limits: Readonly<Required<AcquisitionLimits>>;
  readonly counters = { portCalls: 0, oversized: 0, stale: 0, limited: 0 };
  private baselineEpisode: Episode | undefined;
  private pages: Episode[] = [];
  private pending: Episode | undefined;
  private tombstones = new Map<string, string>();
  private tombstoneBytes = 0;
  private expected: string | null = null;
  private persistedEnded = false;
  constructor(private readonly owner: HistoryOwner, private readonly port: AcquisitionPort<S>, reads = new ReadCoordinator(), limits: AcquisitionLimits = {}, private readonly episodeOwner = "", private readonly admitScopes?: (scopes: readonly CapturedScope[]) => void) {
    this.scope = deepFreeze(cloneJson(validateScope(port.scope))) as S;
    invariant(sameScope(owner.scope, this.scope), "FOREIGN_ACQUISITION_PORT"); this.reads = reads;
    invariant(port.mode === "active" || port.mode === "persisted", "ACQUISITION_MODE");
    if (port.context !== undefined) text(port.context, "READ_CONTEXT", 256);
    if (episodeOwner !== "") text(episodeOwner);
    this.limits = Object.freeze({ count: limits.count ?? 100, maxBytes: limits.maxBytes ?? 524_288, maxCallsPerPage: limits.maxCallsPerPage ?? 128,
      maxTombstones: limits.maxTombstones ?? 4096, maxTombstoneBytes: limits.maxTombstoneBytes ?? 1_048_576 });
    for (const value of Object.values(this.limits)) invariant(Number.isSafeInteger(value) && value > 0, "ACQUISITION_LIMIT");
    invariant(this.limits.count <= 128 && this.limits.maxBytes <= 1_048_576 && this.limits.maxCallsPerPage <= 1024
      && this.limits.maxTombstones <= 4096 && this.limits.maxTombstoneBytes <= 1_048_576, "ACQUISITION_LIMIT");
  }
  get retention(): Readonly<{ episodes: number; tombstones: number; tombstoneBytes: number }> {
    return Object.freeze({ episodes: Number(!!this.baselineEpisode) + this.pages.length, tombstones: this.tombstones.size, tombstoneBytes: this.tombstoneBytes });
  }
  baseline(reason: ExceptionReason, factId: string, kind: "initial" | "recover" = "recover", retryToken?: string): ReadHandle<AcquisitionResult> {
    invariant(baselineReasons.has(reason), "BASELINE_REASON_NOT_ADMITTED"); text(factId);
    return this.request(reason, factId, null, true, this.owner.snapshot().generation, { kind }, retryToken);
  }
  older(target: Readonly<{ scope: Scope; generation: string; cursor: string }>, retryToken?: string): ReadHandle<AcquisitionResult> {
    invariant(sameScope(target.scope, this.scope), "FOREIGN_ACQUISITION_TARGET"); text(target.cursor, "EXPECTED_STRING", 16384);
    invariant(target.generation === this.owner.snapshot().generation, "STALE_ACQUISITION_TARGET");
    const prefix = this.port.context === undefined ? "" : `${this.port.context.length}:${this.port.context}:`;
    invariant(target.cursor.startsWith(prefix), "STALE_READ_CONTEXT");
    const cursor = target.cursor.slice(prefix.length); text(cursor, "EXPECTED_STRING", 8192);
    return this.request("E13", JSON.stringify(["older", target.cursor]), cursor, false, target.generation, { kind: "older", cursor: target.cursor }, retryToken);
  }
  private remember(kind: "cursor" | "baseline", input: string | null, meaning = ""): void {
    const key = JSON.stringify([kind, input]), known = this.tombstones.get(key);
    if (known !== undefined) { invariant(known === meaning, "FACT_MEANING_CHANGED"); return; }
    const bytes = new TextEncoder().encode(canonical([key, meaning])).byteLength;
    invariant(this.tombstones.size < this.limits.maxTombstones && this.tombstoneBytes + bytes <= this.limits.maxTombstoneBytes, "ACQUISITION_IDENTITY_CAPACITY");
    this.tombstones.set(key, meaning); this.tombstoneBytes += bytes;
  }
  private consumed(cursor: string | null): boolean { return this.tombstones.has(JSON.stringify(["cursor", cursor])); }
  private release(episode: Episode): void { this.reads.releaseSettled(episode.request, episode.handle); }
  private request(reason: ExceptionReason, factId: string, cursor: string | null, baseline: boolean, generation: string, target: HistoryReadTarget, retryToken?: string): ReadHandle<AcquisitionResult> {
    const key = JSON.stringify([this.episodeOwner, generation, factId]), meaning = canonical({ reason, cursor, baseline });
    const prior = [this.baselineEpisode, ...this.pages].find(episode => episode?.key === key);
    if (retryToken !== undefined) text(retryToken, "HISTORY_READ_RETRY", 128);
    if (prior) {
      invariant(prior.meaning === meaning, "FACT_MEANING_CHANGED");
      if (retryToken === undefined || retryToken === prior.renewedFrom) return prior.handle;
      invariant(prior.generation === this.owner.snapshot().generation && prior.context === this.owner.snapshot().readContext, "STALE_READ_RETRY");
      invariant(this.port.mode === "active" && prior.retryToken === retryToken && prior.retries === 0 && prior.handle.outcome?.state === "failed", "STALE_READ_RETRY");
      invariant(!this.pending?.handle.active, "READ_BUSY");
      const handle = this.reads.renew(prior.request, "explicitUser", () => this.readPage(cursor, baseline, generation));
      prior.handle = handle; prior.retries++; prior.retryToken = undefined; prior.renewedFrom = retryToken; this.pending = prior;
      this.publishRead(prior); return handle;
    }
    invariant(retryToken === undefined, "STALE_READ_RETRY");
    invariant(!this.pending?.handle.active, "READ_BUSY"); this.pending = undefined;
    if (this.port.mode === "persisted") invariant(!this.persistedEnded && cursor === this.expected && !this.consumed(cursor), "PERSISTED_CURSOR_CONSUMED");
    if (baseline) {
      const retired = this.tombstones.get(JSON.stringify(["baseline", key]));
      if (retired !== undefined) { invariant(retired === meaning, "FACT_MEANING_CHANGED"); throw new PrimitiveError("ACQUISITION_FACT_RETIRED"); }
      if (this.baselineEpisode) {
        // ACTIVE reads may establish a new baseline for a new actual gap or
        // generation. Retiring its old fact cannot manufacture another read.
        this.remember("baseline", this.baselineEpisode.key, this.baselineEpisode.meaning);
        this.release(this.baselineEpisode); this.baselineEpisode = undefined;
      }
    } else if (this.pages.length === 2) {
      // Keep the current and preceding page for coalesced late viewers.
      // Persisted tombstones fence released inputs; active cursors remain
      // explicitly repeatable read-only native boundaries.
      this.release(this.pages[0]!); this.pages.shift();
    }
    const request: ReadRequest = { scope: this.scope, reason, factId: key, kind: "nativeBody" };
    const handle = this.reads.request<AcquisitionResult>(request, () => this.readPage(cursor, baseline, generation));
    const episode: Episode = { key, meaning, request, handle, target, generation, context: this.owner.snapshot().readContext,
      retries: 0, retryToken: undefined, renewedFrom: undefined }; this.pending = episode;
    if (baseline) this.baselineEpisode = episode; else this.pages.push(episode);
    this.publishRead(episode); return handle;
  }
  private publishRead(episode: Episode): void {
    const handle = episode.handle;
    this.owner.setReadState({ state: "pending", target: episode.target }, episode.generation, episode.context);
    void handle.settled.then(result => {
      if (this.pending !== episode || episode.handle !== handle) return;
      if (result.state === "retired" || result.state === "value" && result.value.status === "stale") {
        this.owner.setReadState({ state: "idle" }, episode.generation, episode.context); return;
      }
      if (result.state === "waitingExpired") return; // Consumer waits never settle the actual owner.
      const outcome = result.state === "value" ? result.value.status : result.state;
      if (outcome === "stale") return;
      if (outcome === "failed" && this.port.mode === "active" && episode.retries === 0 && this.reads.limits.maxAttemptsPerFact > 1) episode.retryToken = crypto.randomUUID();
      this.owner.setReadState({ state: "settled", target: episode.target, outcome, ...(episode.retryToken ? { retryToken: episode.retryToken } : {}) }, episode.generation, episode.context);
    }).catch(() => { /* A retired projection cannot change actual read custody. */ });
  }
  private async readPage(input: string | null, baseline: boolean, generation: string): Promise<AcquisitionResult> {
    const fence = this.owner.beginRead();
    if (fence.generation !== generation) { this.owner.endRead(fence); return { status: "stale" }; }
    let cursor = input, count = this.port.mode === "persisted" ? 1 : this.limits.count, calls = 0;
    const discovered = new Map<string, CapturedScope>(); let discoveryLimited = false;
    try {
      for (;;) {
        if (!this.owner.readIsCurrent(fence)) { this.counters.stale++; return { status: "stale" }; }
        if (this.port.mode === "persisted") {
          invariant(!this.persistedEnded && cursor === this.expected && !this.consumed(cursor), "PERSISTED_CURSOR_CONSUMED");
          this.remember("cursor", cursor); // Consume before await, including errors/timeouts.
        }
        let batch: AcquisitionBatch;
        for (;;) {
          if (!this.owner.readIsCurrent(fence)) { this.counters.stale++; return { status: "stale" }; }
          invariant(calls < this.limits.maxCallsPerPage, "ACQUISITION_CALL_CAPACITY"); calls++; this.counters.portCalls++;
          try {
            batch = cloneJson(await this.port.read(deepFreeze({ scope: this.scope, cursor, count }), () => invariant(this.owner.readIsCurrent(fence), "STALE_READ_FENCE")));
            invariant(new TextEncoder().encode(canonical(batch)).byteLength <= this.limits.maxBytes, "PAGE_TOO_LARGE");
            invariant(Array.isArray(batch.records) && batch.records.length <= 128, "PAGE_TOO_LARGE");
            break;
          } catch (error) {
            if (!this.owner.readIsCurrent(fence)) { this.counters.stale++; return { status: "stale" }; }
            if (!(error instanceof PrimitiveError) || error.code !== "PAGE_TOO_LARGE" || count === 1 || this.port.mode !== "active") throw error;
            this.counters.oversized++; count = Math.max(1, Math.floor(count / 2));
          }
        }
        invariant(sameScope(validateScope(batch.scope), this.scope), "FOREIGN_PAGE_SCOPE");
        invariant(["ok", "expired", "unsupported"].includes(batch.status), "ACQUISITION_STATUS");
        if (!this.owner.readIsCurrent(fence)) { this.counters.stale++; return { status: "stale" }; }
        if (batch.status !== "ok") { if (this.port.mode === "persisted") this.persistedEnded = true; return { status: batch.status }; }
        invariant(typeof batch.hasMore === "boolean", "PAGE_CURSOR");
        if (batch.hasMore) { text(batch.nextCursor, "EXPECTED_STRING", 8192); invariant(batch.nextCursor !== cursor, "NONADVANCING_CURSOR"); }
        else invariant(batch.nextCursor === null, "PAGE_CURSOR_CONFLICT");
        invariant(Array.isArray(batch.records) && batch.records.length <= 128 && Array.isArray(batch.gaps) && batch.gaps.length <= 128, "ACQUISITION_BATCH_LIMIT");
        for (const record of batch.records) {
          invariant(Object.keys(record).every(key => ["id", "kind", "lifecycle", "body", "native"].includes(key)), "NATIVE_RECORD_VERSION");
          validateRow({ ...record, version: 0, contentVersion: 0 });
        }
        if (batch.discoveredScopes !== undefined) for (const entry of validateCapturedScopes(batch.discoveredScopes, this.scope)) {
          const key = canonical(entry.scope);
          if (discovered.has(key)) continue;
          if (discovered.size === 31) { discoveryLimited = true; continue; }
          discovered.set(key, entry);
        }
        if (this.port.mode === "persisted") { this.expected = batch.nextCursor; this.persistedEnded = !batch.hasMore; }
        if (!batch.records.length && !batch.gaps.length && batch.hasMore && calls < this.limits.maxCallsPerPage) {
          cursor = batch.nextCursor; continue;
        }
        if (!batch.records.length && !batch.gaps.length && batch.hasMore) this.counters.limited++;
        const nativeCursor = batch.nextCursor!;
        const exposedCursor = this.port.context === undefined ? nativeCursor : `${this.port.context.length}:${this.port.context}:${nativeCursor}`;
        const edge = batch.hasMore ? { state: "available" as const, cursor: exposedCursor } : { state: "end" as const, evidence: "nativeBoundary" as const };
        const gaps = discoveryLimited ? [...batch.gaps, { id: 'history:child-discovery-capacity', kind: 'truncated' as const }] : batch.gaps;
        const page = this.owner.mergeRead(fence, batch.records, edge, gaps, baseline);
        if (page && discovered.size) this.admitScopes?.(deepFreeze([...discovered.values()]));
        return page ? { status: "ready", page } : { status: "stale" };
      }
    } catch (error) { if (this.port.mode === "persisted") this.persistedEnded = true; throw error; }
    finally { this.owner.endRead(fence); }
  }
}
