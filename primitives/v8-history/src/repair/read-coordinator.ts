import type { Scope } from "../contracts/types.js";
import { scopeKey } from "../contracts/identity.js";
import { cloneJson, deepFreeze, invariant, PrimitiveError, text, validateScope } from "../contracts/validation.js";

export const reasons = {
  E01: "coldOpen", E02: "captureLost", E03: "viewerReplay", E04: "subscriberReset", E05: "gatewayReconnect",
  E06: "nativeGap", E07: "missingStart", E08: "missingFinal", E09: "missingTurn", E10: "originHealth",
  E11: "identityEvidence", E12: "explicitReload", E13: "olderPage", E14: "explicitContent", E15: "capacity",
  E16: "childOpen", E17: "nativeHistoryEdit", E18: "unsupportedFrame", E19: "duplicateDelivery", E20: "nativeDiagnostic",
  E21: "toolGap", E22: "readUnavailable", E23: "authorization", E24: "lifecycle", E25: "unrecoverableEphemeral",
  E26: "originalReceipt", E27: "ownerChanged", E28: "stoppedInspection", E29: "scopeChanged", E30: "unsupportedPage",
} as const;
export type ExceptionReason = keyof typeof reasons;
const bodyReasons = new Set<ExceptionReason>(["E01", "E02", "E06", "E07", "E08", "E09", "E11", "E12", "E13", "E14", "E16", "E17", "E20", "E21", "E27", "E28", "E29", "E30"]);
export interface ReadRequest { readonly scope: Scope; readonly reason: ExceptionReason; readonly factId: string; readonly kind: "nativeBody" | "metadata" }
export type ReadObservation<T> =
  | Readonly<{ state: "value"; value: T }>
  | Readonly<{ state: "failed"; code: string }>
  | Readonly<{ state: "waitingExpired" }>
  | Readonly<{ state: "healed" }>
  | Readonly<{ state: "retired" }>;
interface Entry<T> { request: ReadRequest; attempts: number; active: boolean; healed: boolean; retired: boolean; result?: ReadObservation<T>; settled: Promise<ReadObservation<T>> }
export class ReadHandle<T> {
  constructor(private readonly entry: Entry<T>) {}
  get active(): boolean { return this.entry.active; }
  get outcome(): ReadObservation<T> | undefined { return this.entry.healed ? { state: "healed" } : this.entry.retired ? { state: "retired" } : this.entry.result; }
  /** Actual owner settlement, independent of finite observer waits/cancellation. */
  get settled(): Promise<ReadObservation<T>> { return this.entry.settled.then(result => this.outcome ?? result); }
  async wait(timeoutMs: number, signal?: AbortSignal): Promise<ReadObservation<T>> {
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 30_000, "WAIT_BOUND");
    signal?.throwIfAborted();
    if (this.outcome) return this.outcome;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([this.entry.settled, new Promise<ReadObservation<T>>((resolve, reject) => { timer = setTimeout(() => resolve({ state: "waitingExpired" }), timeoutMs);
        abort = () => reject(new DOMException("History observer cancelled", "AbortError")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); })]);
      return this.entry.healed ? { state: "healed" } : this.entry.retired ? { state: "retired" } : result;
    } finally { if (timer !== undefined) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }
}
/** One bounded owner for actual reads. Consumer expiry never releases its capacity. */
export class ReadCoordinator {
  private entries = new Map<string, Entry<unknown>>();
  private handles = new WeakMap<object, Entry<unknown>>();
  private activeCount = 0;
  private retiredScopes = new Set<string>();
  readonly limits: Readonly<{ maxConcurrent: number; maxFacts: number; maxAttemptsPerFact: number }>;
  readonly counters = { nativeBodyReads: 0, nativeMetadataReads: 0, coalesced: 0, rejected: 0 };
  constructor(limits: Readonly<{ maxConcurrent: number; maxFacts: number; maxAttemptsPerFact: number }> = { maxConcurrent: 2, maxFacts: 64, maxAttemptsPerFact: 2 }) {
    this.limits = Object.freeze({ ...limits });
    for (const value of Object.values(this.limits)) invariant(Number.isSafeInteger(value) && value > 0 && value <= 1024, "READ_LIMIT");
  }
  private key(request: Pick<ReadRequest, "scope" | "factId">): string { return JSON.stringify([scopeKey(request.scope), request.factId]); }
  request<T>(request: ReadRequest, operation: () => Promise<T>): ReadHandle<T> {
    request = deepFreeze(cloneJson(request));
    validateScope(request.scope); invariant(!this.retiredScopes.has(scopeKey(request.scope)), "READ_SCOPE_RETIRED"); text(request.factId, "EXPECTED_STRING", 65536); invariant(Object.hasOwn(reasons, request.reason), "UNKNOWN_EXCEPTION");
    invariant(request.kind === "nativeBody" || request.kind === "metadata", "READ_KIND");
    invariant(request.kind !== "nativeBody" || bodyReasons.has(request.reason), "BODY_READ_NOT_ADMITTED");
    const key = this.key(request), old = this.entries.get(key);
    if (old) {
      invariant(old.request.kind === request.kind && old.request.reason === request.reason, "FACT_MEANING_CHANGED");
      this.counters.coalesced++; return this.handle(old as Entry<T>);
    }
    invariant(this.entries.size < this.limits.maxFacts, "FACT_CAPACITY");
    return this.start(key, request, 1, operation);
  }
  private start<T>(key: string, request: ReadRequest, attempts: number, operation: () => Promise<T>): ReadHandle<T> {
    if (this.activeCount >= this.limits.maxConcurrent) { this.counters.rejected++; throw new PrimitiveError("READ_BUSY"); }
    let resolve!: (value: ReadObservation<T>) => void;
    const entry: Entry<T> = { request: deepFreeze(structuredClone(request)), attempts, active: true, healed: false, retired: false,
      settled: new Promise(accept => { resolve = accept; }) };
    this.entries.set(key, entry as Entry<unknown>); this.activeCount++;
    if (request.kind === "nativeBody") this.counters.nativeBodyReads++; else this.counters.nativeMetadataReads++;
    // Reserve before invoking a port, including synchronous throws and reentrant observers.
    void Promise.resolve().then(operation).then(value => ({ state: "value", value } as ReadObservation<T>),
      error => ({ state: "failed", code: error instanceof PrimitiveError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : "READ_FAILED" } as ReadObservation<T>)).then(result => {
      entry.active = false; this.activeCount--;
      entry.result = entry.healed ? { state: "healed" } : entry.retired ? { state: "retired" } : result;
      resolve(entry.result);
    });
    return this.handle(entry);
  }
  private handle<T>(entry: Entry<T>): ReadHandle<T> {
    const handle = new ReadHandle(entry); this.handles.set(handle, entry as Entry<unknown>); return handle;
  }
  /** An exact settled paging owner may release a superseded receipt. This is
   * never automatic eviction: its caller must first fence re-admission of any
   * single-use input. Existing repair facts retain their normal lifetime. */
  releaseSettled<T>(request: Pick<ReadRequest, "scope" | "factId">, handle: ReadHandle<T>): void {
    const key = this.key(request), entry = this.entries.get(key);
    invariant(entry && this.handles.get(handle) === entry, "READ_HANDLE_MISMATCH");
    invariant(!entry.active, "UNDERLYING_READ_STILL_OWNED"); this.entries.delete(key);
  }
  renew<T>(request: ReadRequest, trigger: "explicitUser" | "ownerReconnected" | "newNativeBoundary", operation: () => Promise<T>): ReadHandle<T> {
    request = deepFreeze(cloneJson(request));
    invariant(!this.retiredScopes.has(scopeKey(request.scope)), "READ_SCOPE_RETIRED");
    invariant(["explicitUser", "ownerReconnected", "newNativeBoundary"].includes(trigger), "RENEW_TRIGGER");
    const old = this.entries.get(this.key(request)); invariant(old && !old.active, "UNDERLYING_READ_STILL_OWNED");
    invariant(!old.healed && !old.retired && old.attempts < this.limits.maxAttemptsPerFact, "REPAIR_ALLOWANCE_EXHAUSTED");
    invariant(old.request.kind === request.kind && old.request.reason === request.reason, "FACT_MEANING_CHANGED");
    return this.start(this.key(request), request, old.attempts + 1, operation);
  }
  heal(scope: Scope, factId: string): void { const entry = this.entries.get(this.key({ scope, factId })); if (entry) entry.healed = true; }
  retire(scope: Scope): void {
    const key = scopeKey(validateScope(scope));
    invariant(this.retiredScopes.has(key) || this.retiredScopes.size < this.limits.maxFacts, "RETIRED_READ_SCOPE_CAPACITY"); this.retiredScopes.add(key);
    for (const entry of this.entries.values()) if (scopeKey(entry.request.scope) === key) entry.retired = true;
  }
  get active(): number { return this.activeCount; }
  get retainedFacts(): number { return this.entries.size; }
}
