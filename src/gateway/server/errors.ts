import { TRPCError } from "@trpc/server";
import { GatewayError } from "../contracts.js";
export const gatewayTRPCCodes = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  FENCED: "CONFLICT",
  UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INVALID: "BAD_REQUEST",
  FULL: "TOO_MANY_REQUESTS",
  INTERNAL: "INTERNAL_SERVER_ERROR",
} as const;
/** Preserve standard tRPC meaning, never an exception body, stack or custom data. */
export function publicTRPCError(error: unknown): TRPCError {
  const code =
    error instanceof GatewayError
      ? gatewayTRPCCodes[error.code]
      : error instanceof TRPCError
        ? error.code
        : "INTERNAL_SERVER_ERROR";
  return new TRPCError({ code, message: code });
}
export async function publicCall<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw publicTRPCError(error);
  }
}
