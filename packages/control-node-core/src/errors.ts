import { TRPCError } from "@trpc/server";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";

export type ControlNodeCoreErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "FENCED"
  | "PAYLOAD_MISMATCH"
  | "OUTCOME_UNKNOWN"
  | "UNSUPPORTED"
  | "CURSOR_EXPIRED"
  | "UNAUTHORIZED";

export class ControlNodeCoreError extends Error {
  public constructor(
    public readonly code: ControlNodeCoreErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlNodeCoreError";
  }
}

export function asTrpcError(error: unknown): TRPCError {
  if (!(error instanceof ControlNodeCoreError)) {
    const dependencyFailure = classifyDependencyFailure(error);
    if (dependencyFailure === "OUTCOME_UNKNOWN") {
      return new TRPCError({
        code: "BAD_GATEWAY",
        message: "control node dependency returned an indeterminate outcome",
        cause: error,
      });
    }
    if (dependencyFailure === "UNAVAILABLE") {
      return new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "control node dependency is unavailable",
        cause: error,
      });
    }
    if (dependencyFailure !== undefined) {
      return forwardedDependencyError(dependencyFailure, error);
    }
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "control node failed", cause: error });
  }
  const code = error.code === "NOT_FOUND"
    ? "NOT_FOUND"
    : error.code === "CONFLICT" || error.code === "PAYLOAD_MISMATCH"
      ? "CONFLICT"
      : error.code === "UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code === "UNAUTHORIZED"
          ? "UNAUTHORIZED"
          : error.code === "UNSUPPORTED"
            ? "METHOD_NOT_SUPPORTED"
            : error.code === "OUTCOME_UNKNOWN"
              ? "BAD_GATEWAY"
              : "PRECONDITION_FAILED";
  return new TRPCError({ code, message: error.message, cause: error });
}

type ForwardedDependencyCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "SERVICE_UNAVAILABLE"
  | "TOO_MANY_REQUESTS"
  | "METHOD_NOT_SUPPORTED"
  | "BAD_GATEWAY"
  | "GATEWAY_TIMEOUT"
  | "INTERNAL_SERVER_ERROR";

type DependencyFailure = ForwardedDependencyCode | "OUTCOME_UNKNOWN" | "UNAVAILABLE";

/**
 * Inspect only Error instances and canonically validated tRPC client
 * envelopes. Remote error data is untrusted, so only a semantic code from
 * this explicit allowlist is interpreted; messages and auxiliary data are
 * ignored.
 */
function classifyDependencyFailure(error: unknown): DependencyFailure | undefined {
  const visited = new Set<unknown>();
  let current = error;
  let remoteCode: ForwardedDependencyCode | undefined;
  let unavailable = false;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    try {
      const validatedRemoteCode = readValidatedTRPCClientErrorCode(current);
      if (validatedRemoteCode !== undefined) {
        const code = forwardedDependencyCode(validatedRemoteCode);
        if (code === "BAD_GATEWAY") return "OUTCOME_UNKNOWN";
        remoteCode ??= code;
      }
      const code = Reflect.get(current, "code");
      if (code === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
      if (code === "DISCONNECTED" || code === "TIMEOUT") unavailable = true;
      current = Reflect.get(current, "cause");
    } catch {
      break;
    }
  }
  return remoteCode ?? (unavailable ? "UNAVAILABLE" : undefined);
}

function forwardedDependencyCode(code: string): ForwardedDependencyCode | undefined {
  switch (code) {
    case "NOT_FOUND":
    case "CONFLICT":
    case "PRECONDITION_FAILED":
    case "SERVICE_UNAVAILABLE":
    case "TOO_MANY_REQUESTS":
    case "METHOD_NOT_SUPPORTED":
    case "BAD_GATEWAY":
    case "GATEWAY_TIMEOUT":
    case "INTERNAL_SERVER_ERROR":
      return code;
    default:
      return undefined;
  }
}

/**
 * Recognize the canonical tRPC client envelope produced by p2prpc even when
 * its file dependency resolves a second `@trpc/client` module instance.
 *
 * Constructor-name or `{ data: { code } }` duck typing alone is deliberately
 * insufficient. P2prpc validates and freezes an exact wire error shape before
 * constructing TRPCClientError; repeat those invariants here before accepting
 * its semantic code. Callers must still apply a context-specific allowlist.
 */
export function readValidatedTRPCClientErrorCode(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const errorProperties = Object.getOwnPropertyDescriptors(error);
    if (
      errorProperties.name?.value !== "TRPCClientError" ||
      typeof errorProperties.message?.value !== "string" ||
      !Object.hasOwn(errorProperties, "shape") ||
      !Object.hasOwn(errorProperties, "data") ||
      !Object.hasOwn(errorProperties, "meta") ||
      !Object.hasOwn(errorProperties, "cause")
    ) return undefined;

    const prototype = Object.getPrototypeOf(error);
    const constructor = prototype === null
      ? undefined
      : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
    if (typeof constructor !== "function" || constructor.name !== "TRPCClientError") {
      return undefined;
    }

    const shapeDescriptor = errorProperties.shape;
    const dataDescriptor = errorProperties.data;
    if (!shapeDescriptor || !dataDescriptor) return undefined;
    const shape = shapeDescriptor.value;
    const data = dataDescriptor.value;
    if (
      shape === null || typeof shape !== "object" ||
      data === null || typeof data !== "object" ||
      !Object.isFrozen(shape) || !Object.isFrozen(data) ||
      !hasExactOwnKeys(shape, ["code", "message", "data"]) ||
      !hasExactOwnKeys(data, ["code", "httpStatus", "path"])
    ) return undefined;

    const shapeProperties = Object.getOwnPropertyDescriptors(shape);
    const dataProperties = Object.getOwnPropertyDescriptors(data);
    const code = dataProperties.code?.value;
    const rpcCode = shapeProperties.code?.value;
    const httpStatus = dataProperties.httpStatus?.value;
    if (
      shapeProperties.message?.value !== errorProperties.message.value ||
      shapeProperties.data?.value !== data ||
      typeof code !== "string" ||
      !Object.hasOwn(TRPC_ERROR_CODES_BY_KEY, code) ||
      rpcCode !== TRPC_ERROR_CODES_BY_KEY[code as keyof typeof TRPC_ERROR_CODES_BY_KEY] ||
      !Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599 ||
      typeof dataProperties.path?.value !== "string" ||
      dataProperties.path.value.length === 0
    ) return undefined;
    return code;
  } catch {
    return undefined;
  }
}

function hasExactOwnKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function forwardedDependencyError(
  code: ForwardedDependencyCode,
  cause: unknown,
): TRPCError {
  const message = code === "NOT_FOUND"
    ? "control node dependency did not find the requested resource"
    : code === "CONFLICT" || code === "PRECONDITION_FAILED"
      ? "control node dependency rejected conflicting state"
      : code === "SERVICE_UNAVAILABLE" || code === "GATEWAY_TIMEOUT"
        ? "control node dependency is unavailable"
        : code === "TOO_MANY_REQUESTS"
          ? "control node dependency is temporarily rate limited"
          : code === "METHOD_NOT_SUPPORTED"
            ? "control node dependency does not support the request"
            : code === "BAD_GATEWAY"
              ? "control node dependency returned an indeterminate outcome"
              : "control node dependency failed";
  return new TRPCError({ code, message, cause });
}
