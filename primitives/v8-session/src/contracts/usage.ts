import type { CopilotUsage } from "./types.js";
import { canonical, check, copy, id } from "./validation.js";

/** Missing/malformed accounting is unknown. Native timestamps are normalized
 * once, so time ordering compares instants rather than vendor spellings. */
export function copilotCheckpoint(totalNanoAiu: unknown, reportedAt: unknown): Readonly<{ totalNanoAiu: number; reportedAt: string }> | null {
  if (typeof totalNanoAiu !== "number" || !Number.isSafeInteger(totalNanoAiu) || totalNanoAiu < 0 || typeof reportedAt !== "string" || reportedAt.length > 64) return null;
  const at = Date.parse(reportedAt); if (!Number.isFinite(at)) return null;
  return { totalNanoAiu, reportedAt: new Date(at).toISOString() };
}

/** Closed observation boundary, also used by the passive exact-owned reader. */
export function observedCopilotUsage(value: unknown, nativeSession?: string): CopilotUsage {
  canonical(value, 2048);
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const usage = value as CopilotUsage;
  check(Object.keys(usage).length === 4 && Object.keys(usage).every(key => ["nativeSession", "totalNanoAiu", "reportedAt", "observedAt"].includes(key)));
  id(usage.nativeSession); check(nativeSession === undefined || usage.nativeSession === nativeSession);
  const checkpoint = copilotCheckpoint(usage.totalNanoAiu, usage.reportedAt);
  check(checkpoint && checkpoint.reportedAt === usage.reportedAt);
  check(typeof usage.observedAt === "string" && usage.observedAt.length <= 64 && Number.isFinite(Date.parse(usage.observedAt)) && new Date(usage.observedAt).toISOString() === usage.observedAt);
  return copy(usage);
}
