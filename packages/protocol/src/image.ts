import { z } from "zod";

import { runtimeNodeBootIdSchema, runtimeNodeIdSchema, sessionIdSchema } from "./ids.js";
import { jsonValueSchema, jsonWireByteUpperBound, type JsonValue } from "./json.js";

export const IMAGE_MAX_CHUNK_BYTES = 256 * 1_024;
export const IMAGE_MAX_BYTES = 10 * 1_024 * 1_024;
export const IMAGE_MAX_COMMAND_IMAGES = 10;
// A command record can carry both its request and result. Leave 128 KiB for
// record, event, and RPC framing within the unchanged 2 MiB transport cap.
export const NATIVE_PAYLOAD_MAX_BYTES = 960 * 1_024;

export const imageIdSchema = z.uuid();
export type ImageId = z.infer<typeof imageIdSchema>;
export const imageMediaTypeSchema = z.enum([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml",
]);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

export const imageTargetSchema = z.object({
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  bindingRevision: z.number().int().positive(),
  runtimeNodeBootId: runtimeNodeBootIdSchema,
});
export type ImageTarget = z.infer<typeof imageTargetSchema>;

export const imageDescriptorSchema = z.object({
  imageId: imageIdSchema,
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  bindingRevision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(IMAGE_MAX_BYTES),
  mediaType: imageMediaTypeSchema,
});
export type ImageDescriptor = z.infer<typeof imageDescriptorSchema>;

const pointerSchema = z.string().max(8_192).refine(
  (pointer) => pointer === "" || /^\/(?:[^~]|~[01])*$/.test(pointer),
  "image pointer must be an RFC 6901 JSON pointer",
);
export const nativeImageUnavailableSchema = z.object({
  unavailable: z.literal(true),
  reason: z.enum(["missing", "unsupported", "tooLarge", "quotaExceeded", "invalid", "unavailable"]),
});
export type NativeImageUnavailable = z.infer<typeof nativeImageUnavailableSchema>;
export const nativeImageSlotSchema = z.object({
  pointer: pointerSchema,
  representation: z.enum(["base64", "dataUrl", "path"]),
  originalPath: z.string().min(1).max(16_384).optional(),
  dataUrlPrefix: z.string().max(128).regex(/^data:image\/[a-z0-9.+-]+;base64,$/i).optional(),
  /** A native asset reference/omission had no inline byte field to reconstruct. */
  absent: z.literal(true).optional(),
  image: z.union([imageDescriptorSchema, nativeImageUnavailableSchema]),
});
export type NativeImageSlot = z.infer<typeof nativeImageSlotSchema>;
export const commandImageBindingSchema = nativeImageSlotSchema.extend({
  image: imageDescriptorSchema,
  representation: z.enum(["base64", "dataUrl"]),
  originalPath: z.never().optional(),
  absent: z.never().optional(),
});
export type CommandImageBinding = z.infer<typeof commandImageBindingSchema>;

export const nativePayloadSchema = z.object({
  encoding: z.literal("native-json-images-v1"),
  json: jsonValueSchema,
  images: z.array(nativeImageSlotSchema).max(256),
}).superRefine((payload, context) => {
  const seen = new Set<string>();
  for (const [index, slot] of payload.images.entries()) {
    if ((slot.representation === "path") !== (slot.originalPath !== undefined) ||
      (slot.dataUrlPrefix !== undefined && slot.representation !== "dataUrl") ||
      (slot.absent && (!slot.pointer || Array.isArray(nativeImagePointerValue(payload.json, slot.pointer.slice(0, slot.pointer.lastIndexOf("/"))))))) {
      context.addIssue({ code: "custom", path: ["images", index], message: "image representation metadata is inconsistent" });
    }
    if (seen.has(slot.pointer) || nativeImagePointerValue(payload.json, slot.pointer) !== null) {
      context.addIssue({ code: "custom", path: ["images", index, "pointer"], message: "image pointers must be unique and target null leaves" });
    }
    seen.add(slot.pointer);
  }
  if (jsonWireByteUpperBound(payload) > NATIVE_PAYLOAD_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "native payload exceeds the bounded wire envelope" });
  }
});
export type NativePayload = z.infer<typeof nativePayloadSchema>;

/** Wrap an image-free native value; this is not a wire compatibility coercion. */
export function packNativePayload(json: JsonValue): NativePayload {
  return nativePayloadSchema.parse({ encoding: "native-json-images-v1", json, images: [] });
}

/** Own-property traversal prevents inherited keys from becoming image slots. */
export function nativeImagePointerValue(json: unknown, pointer: string): unknown {
  if (pointer === "") return json;
  if (!pointer.startsWith("/")) return undefined;
  let value: unknown = json;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
    value = (value as Record<string, JsonValue>)[key];
  }
  return value;
}

const imageBase64Schema = z.string().min(4).max(4 * Math.ceil(IMAGE_MAX_CHUNK_BYTES / 3))
  .superRefine((value, context) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const tail = alphabet.indexOf(value[value.length - padding - 1] ?? "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ||
      (padding === 2 && (tail & 15) !== 0) || (padding === 1 && (tail & 3) !== 0) ||
      value.length / 4 * 3 - padding > IMAGE_MAX_CHUNK_BYTES) {
      context.addIssue({ code: "custom", message: "image chunk must be bounded canonical base64" });
    }
  });

export const imageBeginUploadInputSchema = imageTargetSchema.extend({
  imageId: imageIdSchema,
  byteLength: z.number().int().positive().max(IMAGE_MAX_BYTES),
  sha256: imageDescriptorSchema.shape.sha256,
  mediaType: imageMediaTypeSchema,
});
export type ImageBeginUploadInput = z.infer<typeof imageBeginUploadInputSchema>;
export const imageWriteUploadInputSchema = imageTargetSchema.extend({
  imageId: imageIdSchema,
  offset: z.number().int().nonnegative().max(IMAGE_MAX_BYTES),
  dataBase64: imageBase64Schema,
});
export type ImageWriteUploadInput = z.infer<typeof imageWriteUploadInputSchema>;
export const imageUploadIdInputSchema = imageTargetSchema.extend({ imageId: imageIdSchema });
export type ImageUploadIdInput = z.infer<typeof imageUploadIdInputSchema>;
export const imageUploadStateSchema = z.object({
  imageId: imageIdSchema,
  receivedBytes: z.number().int().nonnegative().max(IMAGE_MAX_BYTES),
  byteLength: z.number().int().positive().max(IMAGE_MAX_BYTES),
  committed: imageDescriptorSchema.nullable(),
}).refine((state) => state.receivedBytes <= state.byteLength &&
  (state.committed === null || state.committed.imageId === state.imageId &&
    state.committed.byteLength === state.byteLength && state.receivedBytes === state.byteLength),
"upload progress or committed descriptor disagrees with its declared identity and size");
export type ImageUploadState = z.infer<typeof imageUploadStateSchema>;
export const imageAbortUploadResultSchema = z.object({ imageId: imageIdSchema, aborted: z.boolean() });
export type ImageAbortUploadResult = z.infer<typeof imageAbortUploadResultSchema>;
export const imageResolvePathInputSchema = imageTargetSchema.extend({
  sourceKey: z.string().min(1).max(4_096),
  path: z.string().min(1).max(16_384),
});
export type ImageResolvePathInput = z.infer<typeof imageResolvePathInputSchema>;
export const imageReadInputSchema = imageUploadIdInputSchema.extend({
  offset: z.number().int().nonnegative().max(IMAGE_MAX_BYTES),
  length: z.number().int().positive().max(IMAGE_MAX_CHUNK_BYTES).default(IMAGE_MAX_CHUNK_BYTES),
});
export type ImageReadInput = z.infer<typeof imageReadInputSchema>;
export const imageReadResultSchema = z.object({
  image: imageDescriptorSchema,
  offset: z.number().int().nonnegative().max(IMAGE_MAX_BYTES),
  dataBase64: z.union([z.literal(""), imageBase64Schema]),
  eof: z.boolean(),
}).refine((result) => {
  const end = result.offset + base64ByteLength(result.dataBase64);
  return end <= result.image.byteLength && result.eof === (end === result.image.byteLength) &&
    (result.dataBase64.length > 0 || result.eof);
}, "image chunk range and end-of-file marker disagree with the descriptor");
export type ImageReadResult = z.infer<typeof imageReadResultSchema>;
export const imageLimitsSchema = z.object({
  maximumImageBytes: z.number().int().positive().max(IMAGE_MAX_BYTES),
  maximumChunkBytes: z.number().int().positive().max(IMAGE_MAX_CHUNK_BYTES),
  maximumImagesPerCommand: z.number().int().positive().max(IMAGE_MAX_COMMAND_IMAGES),
  maximumSessionBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maximumRuntimeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mediaTypes: z.array(imageMediaTypeSchema).min(1).max(5),
});
export type ImageLimits = z.infer<typeof imageLimitsSchema>;

export const imageContract = {
  beginUpload: { input: imageBeginUploadInputSchema, output: imageUploadStateSchema },
  writeUpload: { input: imageWriteUploadInputSchema, output: imageUploadStateSchema },
  commitUpload: { input: imageUploadIdInputSchema, output: imageDescriptorSchema },
  abortUpload: { input: imageUploadIdInputSchema, output: imageAbortUploadResultSchema },
  resolvePath: { input: imageResolvePathInputSchema, output: imageDescriptorSchema },
  read: { input: imageReadInputSchema, output: imageReadResultSchema },
  limits: { input: imageTargetSchema, output: imageLimitsSchema },
} as const;

/** Transport-neutral runtime image port, shared by control and gateway routes. */
export interface ImagePort {
  beginImageUpload(input: ImageBeginUploadInput): Promise<ImageUploadState>;
  writeImageUpload(input: ImageWriteUploadInput): Promise<ImageUploadState>;
  commitImageUpload(input: ImageUploadIdInput): Promise<ImageDescriptor>;
  abortImageUpload(input: ImageUploadIdInput): Promise<ImageAbortUploadResult>;
  resolveImagePath(input: ImageResolvePathInput): Promise<ImageDescriptor>;
  readImage(input: ImageReadInput): Promise<ImageReadResult>;
  imageLimits(input: ImageTarget): Promise<ImageLimits>;
}

/** Validate identity-bearing image responses before a proxy releases bytes. */
export function assertImageResponseTarget(target: ImageTarget & {
  imageId?: string; offset?: number; length?: number; byteLength?: number;
  sha256?: string; mediaType?: ImageMediaType;
}, result: unknown): void {
  if (result === null || typeof result !== "object") return;
  const value = result as Record<string, unknown>;
  const descriptor = "sha256" in value ? value : value.image ?? value.committed;
  if (target.imageId !== undefined && typeof value.imageId === "string" && value.imageId !== target.imageId) {
    throw new Error("image response returned another image identity");
  }
  if (target.offset !== undefined && target.length !== undefined &&
    (value.offset !== target.offset || typeof value.dataBase64 !== "string" || base64ByteLength(value.dataBase64) > target.length)) {
    throw new Error("image response returned another byte range");
  }
  if (target.byteLength !== undefined && value.byteLength !== target.byteLength) {
    throw new Error("image response returned another declared size");
  }
  if (descriptor === null || descriptor === undefined || typeof descriptor !== "object") return;
  const image = descriptor as Record<string, unknown>;
  if (image.sessionId !== target.sessionId || image.runtimeNodeId !== target.runtimeNodeId ||
    image.bindingRevision !== target.bindingRevision ||
    (target.imageId !== undefined && image.imageId !== target.imageId) ||
    (target.sha256 !== undefined && image.sha256 !== target.sha256) ||
    (target.mediaType !== undefined && image.mediaType !== target.mediaType)) {
    throw new Error("image response escaped the requested session binding");
  }
}

function base64ByteLength(value: string): number {
  return value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
