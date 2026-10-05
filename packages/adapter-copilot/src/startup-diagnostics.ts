/** Private process-local startup trace. Native payloads, paths, configuration
 * and arbitrary exception text never enter this record. The original error
 * remains in the caller's Error.cause chain for the embedding Host to retain. */
export interface CopilotStartupDiagnostic {
  startupId: string;
  stage: "nativeStart" | "nativeTermination";
  outcome: "dispatched" | "progress" | "acknowledged" | "lateAcknowledged" | "timedOut" | "unacknowledged" | "retired";
  elapsedMs: number;
  deadlineMs: number;
  childState: "notObserved" | "running" | "exited";
  childPid?: number;
  failureReason?: "nativeStartTimedOut" | "nativeStartRetired" | "nativeStartRejected" | "nativeTerminationUnproved";
  causes?: readonly CopilotStartupCause[];
}

export interface CopilotStartupCause {
  name: "Error" | "TypeError" | "RangeError" | "AggregateError" | "AdapterOutcomeUnknownError" | "RuntimeNodeProtocolError" | "ResponseError" | "other";
  code?: number | "ENOENT" | "EACCES" | "EPERM" | "EPIPE" | "ECONNREFUSED" | "ECONNRESET" | "ETIMEDOUT" | "FENCED" | "CONFLICT";
}

const ERROR_NAMES: readonly CopilotStartupCause["name"][] = [
  "Error", "TypeError", "RangeError", "AggregateError", "AdapterOutcomeUnknownError", "RuntimeNodeProtocolError", "ResponseError",
];
const ERROR_CODES: readonly NonNullable<CopilotStartupCause["code"]>[] = [
  "ENOENT", "EACCES", "EPERM", "EPIPE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "FENCED", "CONFLICT",
];

export function startupCauses(error: unknown): readonly CopilotStartupCause[] {
  const causes: CopilotStartupCause[] = [];
  const seen = new Set<unknown>();
  while (error !== undefined && causes.length < 4 && !seen.has(error)) {
    seen.add(error);
    try {
      if (!(error instanceof Error)) { causes.push({ name: "other" }); break; }
      const name = ERROR_NAMES.includes(error.name as CopilotStartupCause["name"])
        ? error.name as CopilotStartupCause["name"] : "other";
      const code: unknown = Reflect.get(error, "code");
      // Standard JSON-RPC errors are numeric. Unknown strings could contain
      // provider/configuration values and are deliberately not retained.
      const safeCode = typeof code === "number" && Number.isSafeInteger(code) && code >= -32_768 && code <= 32_767
        ? code : ERROR_CODES.includes(code as never) ? code as CopilotStartupCause["code"] : undefined;
      causes.push({ name, ...(safeCode === undefined ? {} : { code: safeCode }) });
      error = error.cause;
    } catch { causes.push({ name: "other" }); break; }
  }
  return causes;
}
