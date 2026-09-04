import type { JsonValue } from "@agent-multiplex/protocol";
import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";

export type HostErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "FENCED"
  | "PAYLOAD_MISMATCH"
  | "OUTCOME_UNKNOWN"
  | "INVALID_PATH"
  | "UNSUPPORTED";

export class HostCoreError extends Error {
  readonly code: HostErrorCode;
  readonly details?: JsonValue;

  constructor(code: HostErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "HostCoreError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
const trpcCode: Record<HostErrorCode, TRPC_ERROR_CODE_KEY> = {
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  UNAVAILABLE: "SERVICE_UNAVAILABLE",
  FENCED: "CONFLICT",
  PAYLOAD_MISMATCH: "CONFLICT",
  OUTCOME_UNKNOWN: "TIMEOUT",
  INVALID_PATH: "BAD_REQUEST",
  UNSUPPORTED: "METHOD_NOT_SUPPORTED",
};

export function asTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof HostCoreError) {
    return new TRPCError({
      code: trpcCode[error.code],
      message: error.message,
      cause: error,
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Unknown host error",
    cause: error,
  });
}
