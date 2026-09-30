import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NATIVE_PAYLOAD_MAX_BYTES, nativePayloadSchema, nativePayloadValidationFailure,
  nativeGapDiagnosticSchema, packNativePayload, parseNativePayload,
  type NativePayloadValidationFailure,
} from "../src/index.js";

const envelope = (json: unknown = null, images: unknown[] = []) => ({ encoding: "native-json-images-v1", json, images });
const unavailable = { unavailable: true, reason: "missing" };
const slot = { pointer: "/image", representation: "base64", image: unavailable };
const sentinel = "PRIVATE_CONTENT_/private/path_session-id_native-id";

function failure(payload: unknown): unknown {
  try { parseNativePayload(payload); }
  catch (error) { return error; }
  throw new Error("Expected native envelope rejection");
}

describe("payload-free native envelope validation categories", () => {
  it.each<{ category: NativePayloadValidationFailure; payload: unknown }>([
    { category: "wireEnvelope", payload: envelope(sentinel.repeat(Math.ceil(NATIVE_PAYLOAD_MAX_BYTES / sentinel.length))) },
    { category: "imageSlotLimit", payload: envelope({ image: null }, Array.from({ length: 257 }, () => slot)) },
    { category: "imageSlotMetadata", payload: envelope({ image: null }, [{ ...slot, representation: "path" }]) },
    { category: "imagePointer", payload: envelope({ image: sentinel }, [slot]) },
    { category: "imageSlotShape", payload: envelope({ image: null }, [{ ...slot, image: { unavailable: true, reason: sentinel } }]) },
    { category: "jsonShape", payload: envelope({ [sentinel]: [undefined] }) },
    { category: "envelopeShape", payload: { encoding: sentinel, json: null, images: [] } },
  ])("reports $category without exposing rejected fields", ({ category, payload }) => {
    const error = failure(payload);
    expect(error).toBeInstanceOf(z.ZodError);
    expect(nativePayloadValidationFailure(error)).toBe(category);
    const diagnostic = {
      diagnosticId: "11111111-1111-4111-8111-111111111111", at: "2026-09-30T00:00:00.000Z",
      code: "imageExtraction", eventKind: "native", pendingEvents: 1, pendingEventBytes: 1,
      errorClass: "schema", payloadFailure: nativePayloadValidationFailure(error),
    };
    expect(JSON.stringify(diagnostic)).not.toContain(sentinel);
    expect(Object.keys(diagnostic).sort()).toEqual([
      "at", "code", "diagnosticId", "errorClass", "eventKind", "payloadFailure", "pendingEventBytes", "pendingEvents",
    ]);
  });

  it("uses a fixed category priority for multiple schema failures", () => {
    const error = failure(envelope("x".repeat(NATIVE_PAYLOAD_MAX_BYTES), [{ ...slot, pointer: "/missing" }]));
    expect(nativePayloadValidationFailure(error)).toBe("wireEnvelope");
  });

  it("identifies image-free packing while leaving unrelated schema errors unclassified", () => {
    let packedError: unknown;
    try { packNativePayload("x".repeat(NATIVE_PAYLOAD_MAX_BYTES)); }
    catch (error) { packedError = error; }
    expect(nativePayloadValidationFailure(packedError)).toBe("wireEnvelope");
    const unrelated = z.object({ json: z.number() }).safeParse({ json: sentinel });
    expect(unrelated.success).toBe(false);
    if (!unrelated.success) expect(nativePayloadValidationFailure(unrelated.error)).toBeUndefined();
    const direct = nativePayloadSchema.safeParse(envelope(sentinel, [slot]));
    expect(direct.success).toBe(false);
    if (!direct.success) expect(nativePayloadValidationFailure(direct.error)).toBeUndefined();
    expect(nativePayloadValidationFailure(new Error(sentinel))).toBeUndefined();
    expect(nativePayloadValidationFailure({ name: "ZodError", issues: [{ path: [sentinel] }] })).toBeUndefined();
  });

  it("retains the released strict durable diagnostic shape", () => {
    const diagnostic = { diagnosticId: "11111111-1111-4111-8111-111111111111", at: "2026-09-30T00:00:00.000Z",
      code: "imageExtraction", eventKind: "native", pendingEvents: 1, pendingEventBytes: 1, errorClass: "schema" };
    expect(nativeGapDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(nativeGapDiagnosticSchema.safeParse({ ...diagnostic, payloadFailure: sentinel }).success).toBe(false);
    expect(nativeGapDiagnosticSchema.safeParse({ ...diagnostic, issuePath: sentinel }).success).toBe(false);
  });
});
