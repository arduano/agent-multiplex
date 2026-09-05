import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  imageIdSchema,
  imageDescriptorSchema,
  imageLimitsSchema,
  imageReadResultSchema,
  imageUploadStateSchema,
  nativePayloadSchema,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_CHUNK_BYTES,
  type ImageMediaType,
  type CommandEnvelope,
  type Harness,
  type HarnessCommand,
  type ImageDescriptor,
  type ImageTarget,
  type NativePayload,
  type RuntimeNodeDescriptor,
  type SessionRecord,
} from "@arduano/agent-multiplex-protocol";
import type { AccessClient } from "./client.js";

/** The byte transfer interface works with HTTP and direct p2prpc access clients. */
export type ImageProcedures = Pick<AccessClient, "images">;

export interface ImageTransferOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (completedBytes: number, totalBytes: number) => void;
}

export function imageTarget(session: SessionRecord, runtime: RuntimeNodeDescriptor): ImageTarget {
  if (session.runtimeNodeId !== runtime.runtimeNodeId) throw new Error("Image runtime does not own the session");
  return {
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
    runtimeNodeBootId: runtime.runtimeNodeBootId,
  };
}

export function imageBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

export function imageBase64ToBytes(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

export function imageSha256(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Call again with the same image ID and bytes after an interrupted upload. */
export async function uploadImage(
  client: ImageProcedures,
  target: ImageTarget,
  bytes: Uint8Array,
  mediaType: ImageMediaType,
  options: ImageTransferOptions & { readonly imageId?: ImageDescriptor["imageId"] } = {},
): Promise<ImageDescriptor> {
  options.signal?.throwIfAborted();
  const limits = imageLimitsSchema.parse(await client.images.limits.query(target));
  if (!bytes.length || bytes.length > limits.maximumImageBytes) throw new Error("Image exceeds the runtime upload limit");
  if (!limits.mediaTypes.includes(mediaType)) throw new Error("Image type is not supported by the runtime");
  const imageId = options.imageId ?? imageIdSchema.parse(globalThis.crypto.randomUUID());
  const digest = imageSha256(bytes);
  const request = { ...target, imageId };
  try {
    const progress = imageUploadStateSchema.parse(await client.images.beginUpload.mutate({ ...request, byteLength: bytes.length, sha256: digest, mediaType }));
    if (progress.imageId !== imageId || progress.byteLength !== bytes.length) throw new Error("Invalid image upload receipt");
    let offset = progress.receivedBytes;
    if (offset < 0 || offset > bytes.length) throw new Error("Invalid image upload offset");
    options.onProgress?.(offset, bytes.length);
    while (!progress.committed && offset < bytes.length) {
      options.signal?.throwIfAborted();
      const chunk = bytes.subarray(offset, offset + limits.maximumChunkBytes);
      const result = imageUploadStateSchema.parse(await client.images.writeUpload.mutate({ ...request, offset, dataBase64: imageBytesToBase64(chunk) }));
      if (result.imageId !== imageId || result.byteLength !== bytes.length || result.receivedBytes !== offset + chunk.length) throw new Error("Invalid image upload receipt");
      offset = result.receivedBytes;
      options.onProgress?.(offset, bytes.length);
    }
    options.signal?.throwIfAborted();
    const descriptor = imageDescriptorSchema.parse(await client.images.commitUpload.mutate(request));
    if (descriptor.imageId !== imageId || descriptor.sha256 !== digest || descriptor.byteLength !== bytes.length ||
      descriptor.sessionId !== target.sessionId || descriptor.runtimeNodeId !== target.runtimeNodeId ||
      descriptor.bindingRevision !== target.bindingRevision || descriptor.mediaType !== mediaType) {
      throw new Error("Image commit returned a conflicting descriptor");
    }
    return descriptor;
  } catch (error) {
    if (options.signal?.aborted) await client.images.abortUpload.mutate(request).catch(() => undefined);
    throw error;
  }
}

export async function readImage(
  client: ImageProcedures,
  target: ImageTarget,
  descriptor: ImageDescriptor,
  options: ImageTransferOptions = {},
): Promise<Uint8Array> {
  imageDescriptorSchema.parse(descriptor);
  if (descriptor.sessionId !== target.sessionId || descriptor.runtimeNodeId !== target.runtimeNodeId || descriptor.bindingRevision !== target.bindingRevision) {
    throw new Error("Image belongs to another session");
  }
  if (descriptor.byteLength <= 0 || descriptor.byteLength > IMAGE_MAX_BYTES) throw new Error("Invalid image length");
  const bytes = new Uint8Array(descriptor.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    options.signal?.throwIfAborted();
    const length = Math.min(IMAGE_MAX_CHUNK_BYTES, bytes.length - offset);
    const result = imageReadResultSchema.parse(await client.images.read.query({ ...target, imageId: descriptor.imageId, offset, length }));
    const chunk = imageBase64ToBytes(result.dataBase64);
    if (Object.entries(descriptor).some(([key, value]) => result.image[key as keyof ImageDescriptor] !== value) || result.offset !== offset || chunk.length !== length ||
      result.eof !== (offset + chunk.length === bytes.length)) throw new Error("Invalid image chunk");
    bytes.set(chunk, offset);
    offset += chunk.length;
    options.onProgress?.(offset, bytes.length);
  }
  options.signal?.throwIfAborted();
  if (imageSha256(bytes) !== descriptor.sha256) throw new Error("Image checksum mismatch");
  return bytes;
}

/** Build native attachment shapes without putting image bytes into a command. */
export function imageMessage(
  harness: Harness,
  kind: "send" | "steer",
  text: string,
  images: readonly ImageDescriptor[],
): { request: HarnessCommand; images: NonNullable<CommandEnvelope["images"]> } {
  if (!text.trim() && !images.length) throw new Error("A message needs text or an image");
  if (images.length > 10 || images.reduce((total, image) => total + image.byteLength, 0) > 50 * 1_024 * 1_024) {
    throw new Error("A message can contain at most 10 images and 50 MiB");
  }
  if (harness === "codex") {
    const input = [
      ...(text ? [{ type: "text", text, text_elements: [] }] : []),
      ...images.map(() => ({ type: "image", url: null })),
    ];
    return {
      request: { harness, command: { type: kind, input } },
      images: images.map((image, index) => ({ pointer: `/command/input/${index + (text ? 1 : 0)}/url`, representation: "dataUrl", image })),
    };
  }
  return {
    request: { harness, command: kind === "send"
      ? { type: "send", prompt: { prompt: text, attachments: images.map((image) => ({ type: "blob", data: null, mimeType: image.mediaType })) }, mode: "enqueue" }
      : { type: "steer", prompt: { prompt: text, attachments: images.map((image) => ({ type: "blob", data: null, mimeType: image.mediaType })) }, mode: "immediate" } },
    images: images.map((image, index) => ({ pointer: `/command/prompt/attachments/${index}/data`, representation: "base64", image })),
  };
}

/** Reconstruct an exact native payload on demand; ordinary rendering uses refs. */
export async function reconstructNativePayload(
  payload: NativePayload,
  read: (image: ImageDescriptor) => Promise<Uint8Array>,
): Promise<unknown> {
  nativePayloadSchema.parse(payload);
  let json: unknown = structuredClone(payload.json);
  for (const binding of payload.images) {
    if (binding.absent) {
      if (!binding.pointer) throw new Error("A root image slot cannot be absent");
      const parts = binding.pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      let parent = json as Record<string, unknown>;
      for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      delete parent[parts.at(-1)!];
      continue;
    }
    let value: string;
    if (binding.representation === "path") {
      value = binding.originalPath!;
    } else {
      if ("unavailable" in binding.image) throw new Error("Native image is unavailable");
      const bytes = await read(binding.image);
      if (bytes.length !== binding.image.byteLength || imageSha256(bytes) !== binding.image.sha256) throw new Error("Native image checksum mismatch");
      const encoded = imageBytesToBase64(bytes);
      value = binding.representation === "dataUrl" ? `${binding.dataUrlPrefix ?? `data:${binding.image.mediaType};base64,`}${encoded}` : encoded;
    }
    if (binding.pointer === "") { json = value; continue; }
    const parts = binding.pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let parent = json as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      if (!parent || !Object.prototype.hasOwnProperty.call(parent, part)) throw new Error("Invalid native image pointer");
      parent = parent[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1)!;
    if (!parent || !Object.prototype.hasOwnProperty.call(parent, leaf) || parent[leaf] !== null) throw new Error("Invalid native image placeholder");
    Object.defineProperty(parent, leaf, { value, enumerable: true, configurable: true, writable: true });
  }
  return json;
}
