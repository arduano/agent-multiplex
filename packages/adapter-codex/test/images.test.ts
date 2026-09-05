import { describe, expect, it, vi } from "vitest";
import { imageDescriptorSchema, jsonWireByteUpperBound, type CommandImageBinding, type HarnessCommand, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { codexImageCodec, codexHistoryPageBytes, acceptsCodexCommandImage } from "../src/images.js";

const png = "iVBORw0KGgo=";
const sink = () => ({
  storeBase64: vi.fn(async () => ({ unavailable: true as const, reason: "missing" as const })),
  snapshotPath: vi.fn(async () => ({ unavailable: true as const, reason: "missing" as const })),
});

describe("Codex native image codec", () => {
  it("bounds retained long paths, remote URLs, and sidecars without charging inline image bytes", async () => {
    const path = "/workspace/" + "日".repeat(4_000) + ".png";
    const remote = "https://example.test/" + "x".repeat(20_000);
    const payload = { threadId: "t", turn: { items: [
      { type: "imageView", id: "path", path },
      { type: "userMessage", id: "inputs", content: [{ type: "image", url: remote }, { type: "image", url: `data:image/PNG;base64,${png}` }] },
    ] } };
    const image = imageDescriptorSchema.parse({ imageId: "ffffffff-ffff-4fff-8fff-ffffffffffff", sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff", runtimeNodeId: "ffffffff-ffff-4fff-8fff-ffffffffffff", bindingRevision: Number.MAX_SAFE_INTEGER, sha256: "f".repeat(64), byteLength: 10 * 1_024 * 1_024, mediaType: "image/svg+xml" });
    const envelope = await codexImageCodec.externalize(payload, { storeBase64: async () => image, snapshotPath: async () => image });
    const estimate = codexHistoryPageBytes(payload);
    expect(estimate).toBeGreaterThanOrEqual(jsonWireByteUpperBound(envelope));
    expect(estimate).toBeGreaterThan(Buffer.byteLength(path) + Buffer.byteLength(remote));
    expect(codexHistoryPageBytes({ threadId: "t", item: { type: "imageGeneration", result: "A".repeat(1_000_000) } })).toBeLessThan(2_000);
  });
  it("externalizes only native image content and preserves tool arguments verbatim", async () => {
    const disguised = { type: "image", url: `data:image/png;base64,${png}` };
    const payload = { data: [
      { turnId: "turn-1", item: { type: "userMessage", content: [disguised, { type: "text", text: "look" }] } },
      { turnId: "turn-1", item: { type: "mcpToolCall", arguments: disguised, result: { content: [{ type: "image", mimeType: "image/png", data: png }], structuredContent: disguised } } },
      { turnId: "turn-1", item: { type: "functionCallOutput", output: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }] } },
      { turnId: "turn-1", item: { type: "imageGeneration", result: png } },
    ], nextCursor: null, backwardsCursor: null };
    const target = sink();
    const result = await codexImageCodec.externalize(payload, target);
    expect(result.images.map(({ pointer }) => pointer)).toEqual([
      "/data/0/item/content/0/url", "/data/1/item/result/content/0/data", "/data/2/item/output/0/image_url", "/data/3/item/result",
    ]);
    expect(result.json).toMatchObject({ data: [
      { item: { content: [{ url: null }, { text: "look" }] } },
      { item: { arguments: disguised, result: { structuredContent: disguised } } },
      {}, {},
    ] });
    expect(payload.data[0]?.item.content?.[0]).toEqual(disguised);
    expect(target.storeBase64).toHaveBeenCalledTimes(4);
  });

  it("handles raw image generation and unsupported inline bytes without leaking them", async () => {
    const target = sink();
    const result = await codexImageCodec.externalize({ threadId: "t", item: { type: "image_generation_call", result: "not-an-image" } }, target);
    expect(result.json).toMatchObject({ item: { result: null } });
    expect(result.images[0]?.image).toEqual({ unavailable: true, reason: "unsupported" });
    expect(target.storeBase64).not.toHaveBeenCalled();
  });

  it("rejects inline command images and allows only image URL upload slots", () => {
    const request = { harness: "codex", command: { type: "send", input: [{ type: "image", url: null }] } } as HarnessCommand;
    const slot = { pointer: "/command/input/0/url", representation: "dataUrl" } as CommandImageBinding;
    expect(acceptsCodexCommandImage(request, slot)).toBe(true);
    expect(acceptsCodexCommandImage(request, { ...slot, pointer: "/command/native/arguments/url" })).toBe(false);
    expect(() => codexImageCodec.validateCommand?.({ harness: "codex", command: { type: "send", input: [{ type: "image", url: `data:image/png;base64,${png}` }] } })).toThrow("uploaded image");
  });

  it("does not scan arbitrary nested objects or external URLs", async () => {
    const payload: JsonValue = { arbitrary: { item: { type: "imageGeneration", result: png } }, threadId: "t", item: { type: "userMessage", content: [{ type: "image", url: "https://example.com/image.png" }] } };
    const result = await codexImageCodec.externalize(payload, sink());
    expect(result.images).toEqual([]);
    expect(result.json).toEqual(payload);
  });

  it("preserves native paths and exact data URL prefixes with stable image source identities", async () => {
    const target = sink();
    const notification = { threadId: "t", item: { id: "image-1", type: "imageView", path: "/work/result.png" } };
    const event = await codexImageCodec.externalize(notification, target);
    const history = await codexImageCodec.externalize({ data: [{ turnId: "turn-1", item: notification.item }], nextCursor: null }, target);
    expect(event.images[0]).toMatchObject({ pointer: "/item/path", representation: "path", originalPath: "/work/result.png" });
    expect(history.images[0]).toMatchObject({ pointer: "/data/0/item/path", originalPath: "/work/result.png" });
    expect(target.snapshotPath.mock.calls[0]).toEqual(target.snapshotPath.mock.calls[1]);
    const inline = await codexImageCodec.externalize({ threadId: "t", item: { type: "userMessage", content: [{ type: "image", url: `data:image/PNG;base64,${png}` }] } }, target);
    expect(inline.images[0]?.dataUrlPrefix).toBe("data:image/PNG;base64,");
  });
});
