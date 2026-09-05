import { IMAGE_MAX_BYTES, jsonWireByteUpperBound, nativeImagePointerValue, nativePayloadSchema, type JsonValue, type NativeImageSlot, type NativePayload } from "@arduano/agent-multiplex-protocol";
import type { NativeImageSink } from "./adapter.js";

export interface NativeImageLeaf {
  /** Exact leaf selected by the harness; arbitrary tool arguments are never traversed. */
  readonly pointer: string;
  readonly representation: "base64" | "dataUrl" | "path";
  readonly sourceKey?: string;
  readonly mediaType?: string;
  /** For native references whose bytes are carried by another native asset event. */
  readonly dataBase64?: string;
  readonly unavailable?: NativeImageSlot["image"];
}

/**
 * Bounds the actual image envelope before storage. Inline image strings are
 * replaced without serializing/copying their bytes; remote URLs remain native
 * strings. Descriptor fields use their largest contract sizes, while retained
 * paths, pointer prefixes, and data URL prefixes are counted exactly.
 */
export function nativeImagePayloadByteUpperBound(payload: JsonValue, leaves: readonly NativeImageLeaf[], pointerPrefix = ""): number {
  const selected = new Map<string, NativeImageLeaf>();
  const images: Array<Record<string, unknown>> = [];
  for (const leaf of leaves) {
    if (selected.has(leaf.pointer)) continue;
    const encoded = leaf.dataBase64 ?? nativeImagePointerValue(payload, leaf.pointer);
    if (typeof encoded !== "string" && !leaf.unavailable) continue;
    if (leaf.representation === "dataUrl" && typeof encoded === "string" && encoded.slice(0, 5).toLowerCase() !== "data:") continue;
    const parent = nativeImagePointerValue(payload, leaf.pointer.slice(0, leaf.pointer.lastIndexOf("/")));
    if (parent === null || typeof parent !== "object") return Infinity;
    const key = leaf.pointer.slice(leaf.pointer.lastIndexOf("/") + 1).replaceAll("~1", "/").replaceAll("~0", "~");
    const prefix = leaf.representation === "dataUrl" && typeof encoded === "string"
      ? /^(data:image\/[a-z0-9.+-]+;base64,)/i.exec(encoded)?.[1] : undefined;
    selected.set(leaf.pointer, leaf);
    images.push({
      pointer: pointerPrefix + leaf.pointer,
      representation: leaf.representation,
      image: {
        imageId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        runtimeNodeId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        bindingRevision: Number.MAX_SAFE_INTEGER,
        sha256: "f".repeat(64),
        byteLength: IMAGE_MAX_BYTES,
        mediaType: "image/svg+xml",
      },
      ...(leaf.representation === "path" ? { originalPath: encoded } : {}),
      ...(prefix ? { dataUrlPrefix: prefix } : {}),
      ...(!Object.hasOwn(parent, key) ? { absent: true } : {}),
    });
  }
  function copy(value: JsonValue, pointer: string): JsonValue {
    if (selected.has(pointer)) return null;
    if (value === null || typeof value !== "object") return value;
    const pairs = Object.entries(value).map(([key, member]) => [key, copy(member, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)] as const);
    const result: JsonValue = Array.isArray(value) ? pairs.map(([, member]) => member) : Object.fromEntries(pairs);
    // Missing byte fields in native asset references still add a null leaf.
    for (const leaf of selected.values()) {
      if (leaf.pointer.slice(0, leaf.pointer.lastIndexOf("/")) !== pointer) continue;
      const key = leaf.pointer.slice(leaf.pointer.lastIndexOf("/") + 1).replaceAll("~1", "/").replaceAll("~0", "~");
      Object.defineProperty(result, key, { value: null, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  return jsonWireByteUpperBound({ encoding: "native-json-images-v1", json: copy(payload, ""), images });
}

/** Each adapter supplies its exact native fields; core never guesses from text. */
export async function externalizeNativeImages(payload: JsonValue, sink: NativeImageSink, leaves: readonly NativeImageLeaf[]): Promise<NativePayload> {
  // JSON transport duplicates aliased objects. Match that behavior so replacing
  // an image content leaf cannot mutate an aliased opaque tool argument.
  const json = JSON.parse(JSON.stringify(payload)) as JsonValue;
  const images: NativeImageSlot[] = [];
  if (leaves.length > 256) throw new Error("Native payload has too many images");
  const seen = new Set<string>();
  for (const leaf of leaves) {
    if (seen.has(leaf.pointer)) continue;
    seen.add(leaf.pointer);
    const encoded = leaf.dataBase64 ?? nativeImagePointerValue(json, leaf.pointer);
    if (typeof encoded !== "string" && !leaf.unavailable) continue;
    let dataBase64 = encoded;
    let mediaType = leaf.mediaType;
    let dataUrlPrefix: string | undefined;
    if (leaf.representation === "dataUrl" && typeof encoded === "string") {
      if (!encoded.toLowerCase().startsWith("data:")) continue;
      const match = /^(data:(image\/[a-z0-9.+-]+);base64,)([\s\S]*)$/i.exec(encoded);
      if (match) {
        dataUrlPrefix = match[1];
        mediaType = match[2]?.toLowerCase();
        dataBase64 = match[3]!;
      } else mediaType = undefined;
    }
    if (!mediaType && leaf.representation === "base64" && typeof encoded === "string") mediaType = imageHeaderType(encoded);
    const segments = leaf.pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (!leaf.pointer.startsWith("/") || segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) throw new Error("Invalid native image pointer");
    const parent = nativeImagePointerValue(json, leaf.pointer.slice(0, leaf.pointer.lastIndexOf("/")));
    if (parent === null || typeof parent !== "object") throw new Error("Invalid native image parent");
    const absent = !Object.hasOwn(parent, segments.at(-1)!);
    (parent as Record<string, JsonValue>)[segments.at(-1)!] = null;
    let image: NativeImageSlot["image"];
    try {
      if (leaf.unavailable) image = leaf.unavailable;
      else if (leaf.representation === "path" && typeof encoded === "string") image = await sink.snapshotPath({ sourceKey: leaf.sourceKey ?? encoded, path: encoded });
      else if (typeof dataBase64 === "string" && dataBase64.length > 4 * Math.ceil(IMAGE_MAX_BYTES / 3)) image = { unavailable: true, reason: "tooLarge" };
      else if (mediaType && typeof dataBase64 === "string") image = await sink.storeBase64({ dataBase64, mediaType });
      else image = { unavailable: true, reason: "unsupported" };
    } catch { image = { unavailable: true, reason: "unavailable" }; }
    images.push({ pointer: leaf.pointer, representation: leaf.representation, image,
      ...(leaf.representation === "path" && typeof encoded === "string" ? { originalPath: encoded } : {}),
      ...(dataUrlPrefix ? { dataUrlPrefix } : {}),
      ...(absent ? { absent: true } : {}),
    });
  }
  return nativePayloadSchema.parse({ encoding: "native-json-images-v1", json, images });
}

function imageHeaderType(encoded: string): string | undefined {
  const header = Buffer.from(encoded.slice(0, 128), "base64");
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216) return "image/jpeg";
  if (header.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}
