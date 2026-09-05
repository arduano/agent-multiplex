import { describe, expect, it } from "vitest";
import { Packr } from "msgpackr";

import {
  commandEnvelopeSchema, imageDescriptorSchema, imageWriteUploadInputSchema,
  IMAGE_MAX_CHUNK_BYTES, nativePayloadSchema, newCommandId, newRuntimeNodeBootId,
  newRuntimeNodeId, newSessionId, packNativePayload, assertImageResponseTarget,
  imageReadResultSchema, imageUploadStateSchema, jsonWireByteUpperBound,
  NATIVE_PAYLOAD_MAX_BYTES, commandRecordSchema, feedControlItemSchema,
} from "../src/index.js";

const target = {
  sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(),
  runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1,
};
const image = imageDescriptorSchema.parse({
  ...target, imageId: newCommandId(), sha256: "a".repeat(64), byteLength: 4, mediaType: "image/svg+xml",
});

describe("protocol-v5 images", () => {
  it("bounds mixed JSON and float64 MessagePack encodings conservatively", () => {
    const encoder = new Packr({ useRecords: false, variableMapSize: false, mapsAsObjects: true, moreTypes: false });
    const values = [
      null, true, false, 0, 0.1, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE,
      "plain", "\u0000\n\"\\", "é🙂\ud800", [], {},
      Array.from({ length: 1000 }, (_, index) => index / 10),
      { escaped: "\u0000".repeat(100), floats: Array.from({ length: 1000 }, () => 0.1), nested: [[], { "é🙂": false }] },
    ];
    for (const value of values) {
      const bound = jsonWireByteUpperBound(value);
      expect(bound).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(value)));
      expect(bound).toBeGreaterThanOrEqual(encoder.pack(value).byteLength);
    }
    expect(jsonWireByteUpperBound({ kept: true, optional: undefined })).toBe(jsonWireByteUpperBound({ kept: true }));
  });

  it("rejects float-heavy native results and commands that fit only the JSON budget", () => {
    const floats = Array.from({ length: 120_000 }, () => 0.1);
    const payload = { encoding: "native-json-images-v1", json: floats, images: [] };
    const command = {
      commandId: newCommandId(), payloadHash: "a".repeat(64), sessionId: target.sessionId,
      runtimeNodeId: target.runtimeNodeId, bindingRevision: 1,
      request: { harness: "codex", command: { type: "send", input: floats } },
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(NATIVE_PAYLOAD_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(NATIVE_PAYLOAD_MAX_BYTES);
    expect(nativePayloadSchema.safeParse(payload).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse(command).success).toBe(false);
  });

  it("reserves the transport value count when dense request and result arrays share a frame", () => {
    const input = Array.from({ length: 57_000 }, () => null);
    const command = commandEnvelopeSchema.parse({
      commandId: newCommandId(), payloadHash: "a".repeat(64), sessionId: target.sessionId,
      runtimeNodeId: target.runtimeNodeId, bindingRevision: 1,
      request: { harness: "codex", command: { type: "send", input } },
    });
    const result = packNativePayload(input);
    const count = (value: unknown): number => {
      if (Array.isArray(value)) return 1 + value.reduce((total, member) => total + count(member), 0);
      if (value !== null && typeof value === "object") return 1 + Object.values(value).reduce<number>((total, member) => total + 1 + count(member), 0);
      return 1;
    };
    expect(count({ request: command, result }) + 128).toBeLessThan(128 * 1_024);
    // Individually these larger arrays fit both byte encodings, but together
    // they exceed the transport's maximum decoded value count.
    const dense = Array.from({ length: 70_000 }, () => null);
    expect(Buffer.byteLength(JSON.stringify(dense))).toBeLessThan(NATIVE_PAYLOAD_MAX_BYTES);
    expect(nativePayloadSchema.safeParse({ encoding: "native-json-images-v1", json: dense, images: [] }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ ...command, request: { harness: "codex", command: { type: "send", input: dense } } }).success).toBe(false);
  });

  it("leaves framing room when a command record retains maximum request and result envelopes", () => {
    const command = {
      commandId: newCommandId(), payloadHash: "a".repeat(64), sessionId: target.sessionId,
      runtimeNodeId: target.runtimeNodeId, bindingRevision: 1,
      request: { harness: "codex", command: { type: "send", input: "" } },
    };
    const payload = { encoding: "native-json-images-v1", json: "", images: [] };
    command.request.command.input = "x".repeat(NATIVE_PAYLOAD_MAX_BYTES - jsonWireByteUpperBound(command));
    payload.json = "y".repeat(NATIVE_PAYLOAD_MAX_BYTES - jsonWireByteUpperBound(payload));
    command.request.command.input += "x".repeat(NATIVE_PAYLOAD_MAX_BYTES - jsonWireByteUpperBound(command));
    payload.json += "y".repeat(NATIVE_PAYLOAD_MAX_BYTES - jsonWireByteUpperBound(payload));
    expect(jsonWireByteUpperBound(command)).toBe(NATIVE_PAYLOAD_MAX_BYTES);
    expect(jsonWireByteUpperBound(payload)).toBe(NATIVE_PAYLOAD_MAX_BYTES);
    const record = commandRecordSchema.parse({
      commandId: command.commandId, payloadHash: command.payloadHash,
      sessionId: target.sessionId, runtimeNodeId: target.runtimeNodeId, state: "succeeded",
      request: commandEnvelopeSchema.parse(command), result: nativePayloadSchema.parse(payload),
      createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z",
    });
    const event = feedControlItemSchema.parse({
      kind: "control", eventId: newCommandId(), feedId: newCommandId(), cursor: 1,
      provenance: { originControlNodeId: newCommandId(), authority: { realmId: newCommandId(), controlNodeId: newCommandId(), epochId: newCommandId() } },
      change: { type: "command.changed", command: record },
    });
    const encoder = new Packr({ useRecords: false, variableMapSize: false, mapsAsObjects: true, moreTypes: false });
    for (const value of [record, event]) {
      const rpcFrame = { id: "bounded-command-response", data: { json: value } };
      expect(jsonWireByteUpperBound(rpcFrame)).toBeLessThan(2 * 1_024 * 1_024);
      expect(encoder.pack(rpcFrame).byteLength).toBeLessThan(2 * 1_024 * 1_024);
    }
    payload.json += "y";
    command.request.command.input += "x";
    expect(nativePayloadSchema.safeParse(payload).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse(command).success).toBe(false);
  });

  it("preserves native shape and requires explicit unique null image slots", () => {
    const payload = {
      encoding: "native-json-images-v1",
      json: { "native/item": { result: null, detail: "original", sibling: "unchanged" } },
      images: [{ pointer: "/native~1item/result", representation: "base64", image }],
    };
    expect(nativePayloadSchema.parse(payload)).toEqual(payload);
    expect(nativePayloadSchema.safeParse({ ...payload, images: [...payload.images, ...payload.images] }).success).toBe(false);
    expect(nativePayloadSchema.safeParse({ ...payload, images: [{ ...payload.images[0], pointer: "/native~1item/sibling" }] }).success).toBe(false);
    expect(nativePayloadSchema.safeParse({ ...payload, images: [{ ...payload.images[0], pointer: "/native~2item/result" }] }).success).toBe(false);
    expect(nativePayloadSchema.safeParse({ payload: {} }).success).toBe(false);
    expect(packNativePayload({ event: "unchanged" }).json).toEqual({ event: "unchanged" });
  });

  it("bounds canonical base64 chunks below the unchanged transport frame ceiling", () => {
    const maximum = { ...target, imageId: image.imageId, offset: 0, dataBase64: Buffer.alloc(IMAGE_MAX_CHUNK_BYTES).toString("base64") };
    expect(imageWriteUploadInputSchema.parse(maximum)).toEqual(maximum);
    expect(Buffer.byteLength(JSON.stringify(maximum))).toBeLessThan(2 * 1_024 * 1_024);
    for (const dataBase64 of ["AB==", "AAA=\n", Buffer.alloc(IMAGE_MAX_CHUNK_BYTES + 1).toString("base64")]) {
      expect(imageWriteUploadInputSchema.safeParse({ ...maximum, dataBase64 }).success).toBe(false);
    }
  });

  it("preserves original native path and data-URL representation metadata", () => {
    const path = { pointer: "/path", representation: "path", originalPath: "/work/output.svg", image };
    const dataUrl = { pointer: "/url", representation: "dataUrl", dataUrlPrefix: "data:IMAGE/SVG+XML;BASE64,", image };
    const payload = { encoding: "native-json-images-v1", json: { path: null, url: null }, images: [path, dataUrl] };
    expect(nativePayloadSchema.parse(payload)).toEqual(payload);
    expect(nativePayloadSchema.safeParse({ ...payload, images: [{ ...path, originalPath: undefined }] }).success).toBe(false);
    expect(nativePayloadSchema.safeParse({ ...payload, images: [{ ...path, representation: "base64" }] }).success).toBe(false);
    expect(nativePayloadSchema.safeParse({ ...payload, images: [{ ...dataUrl, dataUrlPrefix: "https://example.com/" }] }).success).toBe(false);
  });

  it("fences command image references by binding and includes explicit unavailable outputs", () => {
    const command = {
      ...target, commandId: newCommandId(), payloadHash: "image-command-identity",
      request: { harness: "codex", command: { type: "send", input: [{ type: "image", url: null, detail: "original" }] } },
      images: [{ pointer: "/command/input/0/url", representation: "dataUrl", image }],
    };
    expect(commandEnvelopeSchema.parse(command).images).toEqual(command.images);
    expect(commandEnvelopeSchema.safeParse({ ...command, sessionId: newSessionId() }).success).toBe(false);
    expect(nativePayloadSchema.parse({
      encoding: "native-json-images-v1", json: { data: null },
      images: [{ pointer: "/data", representation: "base64", image: { unavailable: true, reason: "tooLarge" } }],
    }).images[0]?.image).toEqual({ unavailable: true, reason: "tooLarge" });
  });

  it("rejects proxy responses from another image or session", () => {
    expect(() => assertImageResponseTarget({ ...target, imageId: image.imageId }, { image })).not.toThrow();
    expect(() => assertImageResponseTarget({ ...target, imageId: newCommandId() }, { image })).toThrow();
    expect(() => assertImageResponseTarget(target, { image: { ...image, sessionId: newSessionId() } })).toThrow();
  });

  it("rejects inconsistent upload receipts and chunk ranges", () => {
    const state = { imageId: image.imageId, byteLength: 4, receivedBytes: 4, committed: image };
    expect(imageUploadStateSchema.parse(state)).toEqual(state);
    expect(imageUploadStateSchema.safeParse({ ...state, receivedBytes: 3 }).success).toBe(false);
    expect(imageUploadStateSchema.safeParse({ ...state, committed: { ...image, imageId: newCommandId() } }).success).toBe(false);
    const chunk = { image, offset: 0, dataBase64: "AAAAAA==", eof: true };
    expect(imageReadResultSchema.parse(chunk)).toEqual(chunk);
    expect(imageReadResultSchema.safeParse({ ...chunk, offset: 1 }).success).toBe(false);
    expect(imageReadResultSchema.safeParse({ ...chunk, eof: false }).success).toBe(false);
    expect(imageReadResultSchema.safeParse({ ...chunk, dataBase64: "", eof: false }).success).toBe(false);
    expect(() => assertImageResponseTarget({ ...target, offset: 1, length: 4 }, chunk)).toThrow(/byte range/);
    expect(() => assertImageResponseTarget({ ...target, offset: 0, length: 3 }, chunk)).toThrow(/byte range/);
  });
});
