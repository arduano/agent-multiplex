import { describe, expect, it, vi } from "vitest";
import { imageDescriptorSchema, jsonWireByteUpperBound, type CommandImageBinding, type HarnessCommand } from "@arduano/agent-multiplex-protocol";
import { acceptsCopilotCommandImage, copilotImageCodec, copilotHistoryEventBytes } from "../src/images.js";

const png = "iVBORw0KGgo=";
const sink = () => ({
  storeBase64: vi.fn(async () => ({ unavailable: true as const, reason: "missing" as const })),
  snapshotPath: vi.fn(async () => ({ unavailable: true as const, reason: "missing" as const })),
});

describe("Copilot native image codec", () => {
  it("bounds page-indexed paths, missing asset slots, and remote model image URLs", async () => {
    const path = "/workspace/" + "日".repeat(4_000) + ".png";
    const event = { type: "user.message", id: "paths", data: { attachments: [
      { type: "file", path, mimeType: "image/png" },
      { type: "blob", assetId: "missing", mimeType: "image/png" },
    ] } };
    const page = [...Array.from({ length: 100 }, () => ({ type: "session.idle", data: {} })), event];
    const image = imageDescriptorSchema.parse({ imageId: "ffffffff-ffff-4fff-8fff-ffffffffffff", sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff", runtimeNodeId: "ffffffff-ffff-4fff-8fff-ffffffffffff", bindingRevision: Number.MAX_SAFE_INTEGER, sha256: "f".repeat(64), byteLength: 10 * 1_024 * 1_024, mediaType: "image/svg+xml" });
    const envelope = await copilotImageCodec.externalize(page, { storeBase64: async () => image, snapshotPath: async () => image });
    const estimate = page.reduce((bytes, member, index) => bytes + copilotHistoryEventBytes(member, index), 128);
    expect(estimate).toBeGreaterThanOrEqual(jsonWireByteUpperBound(envelope));
    expect(copilotHistoryEventBytes(event, 100)).toBeGreaterThan(copilotHistoryEventBytes(event, 0));
    expect(copilotHistoryEventBytes(event)).toBeGreaterThan(Buffer.byteLength(path));
    const remote = "https://example.test/" + "x".repeat(20_000);
    expect(copilotHistoryEventBytes({ type: "model.messages_snapshot", data: { messages: [{ content: [{ type: "image_url", image_url: { url: remote } }] }] } })).toBeGreaterThan(Buffer.byteLength(remote));
  });
  it("extracts attachment and binary asset relations without interpreting arbitrary tool arguments", async () => {
    const disguised = { type: "image", mimeType: "image/png", data: png };
    const payload = [
      { type: "session.binary_asset", data: { ...disguised, assetId: "sha256:a", byteLength: 8 } },
      { type: "user.message", data: { content: "look", attachments: [{ type: "blob", mimeType: "image/png", assetId: "sha256:a" }] } },
      { type: "tool.execution_complete", data: { result: { contents: [disguised], structuredContent: disguised, binaryResultsForLlm: [{ type: "image", mimeType: "image/png", omittedReason: "size_limit", byteLength: 100000000 }] } } },
      { type: "tool.execution_start", data: { arguments: disguised } },
    ];
    const target = sink();
    const result = await copilotImageCodec.externalize(payload, target);
    expect(result.images.map(({ pointer }) => pointer)).toEqual(["/0/data/data", "/1/data/attachments/0/data", "/2/data/result/contents/0/data", "/2/data/result/binaryResultsForLlm/0/data"]);
    expect(result.images[3]?.image).toEqual({ unavailable: true, reason: "tooLarge" });
    expect(result.json).toMatchObject([
      { data: { data: null, assetId: "sha256:a" } },
      { data: { attachments: [{ assetId: "sha256:a", data: null }] } },
      { data: { result: { structuredContent: disguised } } },
      { data: { arguments: disguised } },
    ]);
    expect(target.storeBase64).toHaveBeenCalledTimes(3);
  });

  it("externalizes the pinned CLI's ephemeral model message snapshot image parts", async () => {
    const target = sink();
    const payload = { type: "model.messages_snapshot", ephemeral: true, data: { kind: "messages_snapshot", messages: [
      { role: "user", content: [{ type: "text", text: "fixture" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] },
      { role: "assistant", tool_calls: [{ arguments: { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } } }] },
    ] } };
    const result = await copilotImageCodec.externalize(payload, target);
    expect(result.images).toMatchObject([{ pointer: "/data/messages/0/content/1/image_url/url", representation: "dataUrl", dataUrlPrefix: "data:image/png;base64," }]);
    expect(result.images).toHaveLength(1);
    expect(result.json).toMatchObject({ data: { messages: [{ content: [{ type: "text", text: "fixture" }, { image_url: { url: null } }] }, payload.data.messages[1]] } });
    expect(target.storeBase64).toHaveBeenCalledWith({ dataBase64: png, mediaType: "image/png" });
  });

  it("emits explicit missing assets and per-image storage failures", async () => {
    const target = sink();
    target.storeBase64.mockRejectedValue(new Error("storage offline"));
    const result = await copilotImageCodec.externalize({ type: "user.message", data: { attachments: [
      { type: "blob", mimeType: "image/png", assetId: "missing" },
      { type: "blob", mimeType: "image/png", data: png },
    ] } }, target);
    expect(result.images.map(({ image }) => image)).toEqual([{ unavailable: true, reason: "missing" }, { unavailable: true, reason: "unavailable" }]);
    expect(JSON.stringify(result)).not.toContain(png);
  });

  it("accepts only matching native blob command slots", () => {
    const request = { harness: "copilot", command: { type: "send", mode: "enqueue", prompt: "look", native: { attachments: [{ type: "blob", mimeType: "image/png", data: null }] } } } as HarnessCommand;
    const slot = { pointer: "/command/native/attachments/0/data", representation: "base64", image: { mediaType: "image/png" } } as CommandImageBinding;
    expect(acceptsCopilotCommandImage(request, slot)).toBe(true);
    expect(acceptsCopilotCommandImage(request, { ...slot, pointer: "/command/native/requestHeaders/x" })).toBe(false);
    expect(acceptsCopilotCommandImage(request, { ...slot, representation: "dataUrl" })).toBe(false);
  });
});
