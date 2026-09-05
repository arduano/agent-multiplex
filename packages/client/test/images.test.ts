import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_CHUNK_BYTES, newRuntimeNodeId, newRuntimeNodeBootId, newSessionId, type ImageDescriptor } from "@arduano/agent-multiplex-protocol";
import { imageMessage, imageSha256, readImage, reconstructNativePayload, uploadImage, type ImageProcedures } from "../src/images.js";

const target = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1 };
const bytes = new Uint8Array(IMAGE_MAX_CHUNK_BYTES + 31).map((_, index) => index % 251);
const descriptor: ImageDescriptor = { imageId: randomUUID(), sessionId: target.sessionId, runtimeNodeId: target.runtimeNodeId, bindingRevision: 1, byteLength: bytes.length, sha256: imageSha256(bytes), mediaType: "image/png" };
function fixture() {
  let offset = 0;
  const images = {
    limits: { query: vi.fn(async () => ({ maximumImageBytes: 10 * 1024 * 1024, maximumChunkBytes: IMAGE_MAX_CHUNK_BYTES, maximumImagesPerCommand: 10, maximumSessionBytes: 512 * 1024 * 1024, maximumRuntimeBytes: 10 * 1024 ** 3, mediaTypes: ["image/png"] })) },
    beginUpload: { mutate: vi.fn(async () => ({ imageId: descriptor.imageId, receivedBytes: offset, byteLength: bytes.length, committed: null })) },
    writeUpload: { mutate: vi.fn(async (input: { offset: number; dataBase64: string }) => {
      const chunk = Buffer.from(input.dataBase64, "base64");
      expect(chunk).toEqual(Buffer.from(bytes.subarray(input.offset, input.offset + chunk.length)));
      expect(chunk.length).toBeLessThanOrEqual(IMAGE_MAX_CHUNK_BYTES);
      offset = input.offset + chunk.length;
      return { imageId: descriptor.imageId, receivedBytes: offset, byteLength: bytes.length, committed: null };
    }) },
    commitUpload: { mutate: vi.fn(async () => descriptor) },
    abortUpload: { mutate: vi.fn(async () => ({ imageId: descriptor.imageId, aborted: true })) },
    read: { query: vi.fn(async (input: { offset: number; length: number }) => ({ image: descriptor, offset: input.offset, dataBase64: Buffer.from(bytes.subarray(input.offset, input.offset + input.length)).toString("base64"), eof: input.offset + input.length === bytes.length })) },
  };
  return { images, client: { images } as unknown as ImageProcedures };
}

describe("image client", () => {
  it("resumes after an acknowledged chunk whose response was lost", async () => {
    const { client, images } = fixture();
    const write = images.writeUpload.mutate.getMockImplementation()!;
    images.writeUpload.mutate.mockImplementationOnce(async (input) => { await write(input); throw new Error("connection lost"); });
    await expect(uploadImage(client, target, bytes, "image/png", { imageId: descriptor.imageId })).rejects.toThrow("connection lost");
    expect(images.abortUpload.mutate).not.toHaveBeenCalled();
    expect(await uploadImage(client, target, bytes, "image/png", { imageId: descriptor.imageId })).toEqual(descriptor);
    expect(images.writeUpload.mutate.mock.calls.map(([input]) => input.offset)).toEqual([0, IMAGE_MAX_CHUNK_BYTES]);
  });
  it("cancels before commit and aborts unfinished storage", async () => {
    const { client, images } = fixture();
    const abort = new AbortController();
    await expect(uploadImage(client, target, bytes, "image/png", { imageId: descriptor.imageId, signal: abort.signal, onProgress: (offset) => { if (offset) abort.abort(); } })).rejects.toThrow();
    expect(images.abortUpload.mutate).toHaveBeenCalledOnce();
    expect(images.commitUpload.mutate).not.toHaveBeenCalled();
  });
  it("checks every read descriptor and rejects corrupted image bytes", async () => {
    const { client, images } = fixture();
    expect(await readImage(client, target, descriptor)).toEqual(bytes);
    const query = images.read.query.getMockImplementation()!;
    images.read.query.mockImplementationOnce(async (input) => ({ ...await query(input), image: { ...descriptor, bindingRevision: 2 } }));
    await expect(readImage(client, target, descriptor)).rejects.toThrow("Invalid image chunk");
    images.read.query.mockImplementationOnce(async (input) => ({ ...await query(input), dataBase64: Buffer.alloc(input.length).toString("base64") }));
    await expect(readImage(client, target, descriptor)).rejects.toThrow("checksum");
  });
  it("builds image-only native send and steer shapes and reconstructs escaped pointers", async () => {
    expect(imageMessage("codex", "steer", "", [descriptor])).toMatchObject({ request: { command: { input: [{ type: "image", url: null }] } }, images: [{ pointer: "/command/input/0/url", representation: "dataUrl" }] });
    expect(imageMessage("copilot", "send", "", [descriptor])).toMatchObject({ request: { command: { prompt: { prompt: "", attachments: [{ type: "blob", data: null }] } } } });
    const payload = { encoding: "native-json-images-v1" as const, json: { "a/b": { "~key": null } }, images: [{ pointer: "/a~1b/~0key", representation: "base64" as const, image: descriptor }] };
    expect(await reconstructNativePayload(payload, async () => bytes)).toEqual({ "a/b": { "~key": Buffer.from(bytes).toString("base64") } });
    expect(payload.json["a/b"]["~key"]).toBeNull();
    expect(await reconstructNativePayload({ ...payload, json: null, images: [{ ...payload.images[0]!, pointer: "" }] }, async () => bytes)).toBe(Buffer.from(bytes).toString("base64"));
    await expect(reconstructNativePayload({ ...payload, images: [...payload.images, ...payload.images] }, async () => bytes)).rejects.toThrow();
  });
  it("restores native paths and absent asset-reference byte fields without fetching", async () => {
    const read = vi.fn(async () => bytes);
    const result = await reconstructNativePayload({ encoding: "native-json-images-v1", json: { path: null, attachment: { assetId: "native:asset", data: null } }, images: [
      { pointer: "/path", representation: "path", originalPath: "/workspace/output.png", image: { unavailable: true, reason: "missing" } },
      { pointer: "/attachment/data", representation: "base64", absent: true, image: descriptor },
    ] }, read);
    expect(result).toEqual({ path: "/workspace/output.png", attachment: { assetId: "native:asset" } });
    expect(read).not.toHaveBeenCalled();
  });

});
