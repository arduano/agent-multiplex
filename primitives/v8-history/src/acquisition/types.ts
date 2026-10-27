import type { Body, CapturedScope, Gap, Json, RowKind, Scope } from "../contracts/types.js";
import type { AcquisitionResult } from "./owner.js";
import type { ReadObservation } from "../repair/read-coordinator.js";

/** Consumer lifetime only. Cancellation/timeout never releases actual native read ownership. */
export type HistoryObservation = Readonly<{ signal?: AbortSignal; timeoutMs?: number }>;
/** Baseline bodies are published on the retained stream, never a second response projection. */
export type HistoryRecovery = ReadObservation<Readonly<{ status: AcquisitionResult["status"] }>>;

/** Native read evidence has no Host row/content version and never invokes a live codec. */
export type HistoryRecord = Readonly<{
  id: string;
  kind: RowKind;
  lifecycle: "unknown" | "running" | "completed" | "failed" | "interrupted";
  body: Body;
  native: Readonly<Record<string, Json>>;
}>;
export type AcquisitionBatch = Readonly<{
  scope: Scope;
  status: "ok" | "expired" | "unsupported";
  records: readonly HistoryRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  gaps: readonly Gap[];
  /** Exact scopes proved during this same bounded native read. No live ownership. */
  discoveredScopes?: readonly CapturedScope[];
}>;
export type AcquisitionRequest<S extends Scope = Scope> = Readonly<{ scope: S; cursor: string | null; count: number }>;
export interface AcquisitionPort<S extends Scope = Scope> {
  readonly scope: S;
  readonly mode: "active" | "persisted";
  /** Stable actual native attachment/read-lease identity; never caller authority. */
  readonly context?: string;
  /** Authorization belongs to the injected native binding; no resume/create/effect capability. */
  read(request: AcquisitionRequest<S>, assertCurrent?: () => void): Promise<AcquisitionBatch>;
}
