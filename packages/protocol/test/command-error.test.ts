import { describe, expect, it } from "vitest";
import { commandErrorSchema, safeCommandError } from "../src/command-error.js";
import { commandRecordSchema } from "../src/command.js";
import { newCommandId, newRuntimeNodeId } from "../src/ids.js";

const sentinel = "SYNTHETIC_SECRET_SENTINEL_DO_NOT_PERSIST";

describe("public durable command errors", () => {
  it.each([
    new Error(sentinel, { cause: new Error(sentinel) }),
    sentinel,
    { message: sentinel, code: "FENCED", token: sentinel },
    Object.assign(new Error(sentinel), { code: sentinel }),
  ])("does not store native exception text or arbitrary fields", (error) => {
    const publicError = safeCommandError(error, { stage: "native", certainty: "definiteFailure" });
    expect(publicError).toMatchObject({ code: "NATIVE_FAILURE", certainty: "definiteFailure" });
    expect(JSON.stringify(publicError)).not.toContain(sentinel);
    expect(commandErrorSchema.safeParse({ ...publicError, message: sentinel }).success).toBe(false);
    expect(commandErrorSchema.safeParse({ ...publicError, stack: sentinel }).success).toBe(false);
  });

  it("preserves allowlisted codes and owner certainty without executing native getters", () => {
    const error = Object.assign(new Error(sentinel), { code: "FENCED" });
    const safe = safeCommandError(error, { stage: "dispatch", certainty: "outcomeUnknown" });
    expect(safe).toMatchObject({ code: "FENCED", certainty: "outcomeUnknown", stage: "dispatch" });
    expect(safe.diagnosticId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(safe)).not.toContain(sentinel);
    const hostile = Object.defineProperty(new Error(sentinel), "code", { get() { throw new Error(sentinel); } });
    expect(safeCommandError(hostile, { stage: "native", certainty: "outcomeUnknown" }).code).toBe("OUTCOME_UNKNOWN");
  });

  it("rejects legacy string errors and certainty mismatches at every command contract", () => {
    const record = {
      commandId: newCommandId(), runtimeNodeId: newRuntimeNodeId(), sessionId: null,
      state: "failed", request: {}, payloadHash: "payload-hash",
      createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
    };
    expect(commandRecordSchema.safeParse({ ...record, error: sentinel }).success).toBe(false);
    const error = safeCommandError(undefined, { stage: "recovery", certainty: "outcomeUnknown" });
    expect(commandRecordSchema.safeParse({ ...record, error }).success).toBe(false);
    expect(commandRecordSchema.safeParse({ ...record, state: "succeeded", error }).success).toBe(false);
    expect(commandRecordSchema.parse({ ...record, state: "outcomeUnknown", error }).error).toEqual(error);
  });
});
