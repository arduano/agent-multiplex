import type { CodexScope, Json } from "../../contracts/types.js";
import { inlineMedia, MAX_NATIVE_MEDIA_OCCURRENCES, mediaMeaning, resolveMedia, type NativeMediaHandler, type NativeMediaOccurrence } from "../../contracts/media.js";
import { invariant, object } from "../../contracts/validation.js";

export type CodexImageLeaf = Readonly<{ key: string; value: unknown; representation: "dataUrl" | "base64" | "path"; mediaType?: string; assetId?: unknown }>;
function plain(value: unknown): Record<string, unknown> {
  const result = object(value);
  invariant(Object.values(Object.getOwnPropertyDescriptors(result)).every(field => "value" in field), "MEDIA_ACCESSOR");
  return result;
}

/** The closed pinned structural map, shared by framing and capture. It never
 * traverses arguments, structuredContent, arbitrary JSON or remote resources. */
export function mapCodexImageLeaves(raw: unknown, map: (leaf: CodexImageLeaf) => unknown): Record<string, unknown> {
  const item = plain(raw);
  const content = (raw: unknown, kind: "user" | "response" | "dynamic" | "mcp") => {
    if (!Array.isArray(raw)) return raw;
    invariant(raw.length <= 32, "CODEX_CONTENT_BOUND");
    return raw.map((raw, index) => {
      const part = plain(raw);
      if (kind === "user" && part.type === "image") return { ...part, url: map({ key: String(index), value: part.url, representation: "dataUrl", ...(part.fileId === undefined ? {} : { assetId: part.fileId }) }) };
      if (kind === "user" && part.type === "localImage") return { ...part, path: map({ key: String(index), value: part.path, representation: "path" }) };
      if (kind === "response" && part.type === "input_image") return { ...part, image_url: map({ key: `content:${index}`, value: part.image_url, representation: "dataUrl", ...(part.file_id === undefined ? {} : { assetId: part.file_id }) }) };
      if (kind === "dynamic" && part.type === "inputImage") return { ...part, imageUrl: map({ key: `content:${index}`, value: part.imageUrl, representation: "dataUrl" }) };
      if (kind === "mcp" && part.type === "image") return { ...part, data: map({ key: `content:${index}`, value: part.data, representation: "base64", ...(typeof part.mimeType === "string" ? { mediaType: part.mimeType } : {}) }) };
      return raw;
    });
  };
  if (item.type === "userMessage" || item.type === "message") return { ...item, content: content(item.content, item.type === "userMessage" ? "user" : "response") };
  if (["functionCallOutput", "function_call_output", "custom_tool_call_output"].includes(String(item.type))) return { ...item, output: content(item.output, "response") };
  if (item.type === "dynamicToolCall") return { ...item, contentItems: content(item.contentItems, "dynamic") };
  if (item.type === "mcpToolCall" && item.result != null) { const result = plain(item.result); return { ...item, result: { ...result, content: content(result.content, "mcp") } }; }
  if (item.type === "imageView") return { ...item, path: map({ key: "path", value: item.path, representation: "path" }) };
  if (item.type === "imageGeneration" || item.type === "image_generation_call") return { ...item,
    ...(typeof item.savedPath === "string" ? { savedPath: map({ key: "savedPath", value: item.savedPath, representation: "path" }) } : {}),
    result: map({ key: "result", value: item.result, representation: "base64" }) };
  return item;
}

/** Media is removed before bounded JSON cloning/fingerprinting. Occurrence IDs
 * use native item/leaf identity and match live and historical observations. */
export function codexMediaItem(raw: unknown, occurrenceId: string, scope?: CodexScope, handler?: NativeMediaHandler): Readonly<{
  item: Record<string, unknown>; media: readonly NativeMediaOccurrence[]; unsupported: boolean;
}> {
  const source = plain(raw);
  const media: NativeMediaOccurrence[] = []; let unsupported = false;
  const item = mapCodexImageLeaves(raw, leaf => {
    // An empty generation start is not an immutable output occurrence.
    if (["imageGeneration", "image_generation_call"].includes(String(source.type)) && leaf.key === "result" && (leaf.value == null || leaf.value === "")) return leaf.value;
    invariant(media.length < MAX_NATIVE_MEDIA_OCCURRENCES, "MEDIA_REFERENCE_BOUND");
    const id = `${occurrenceId}:${leaf.key}`;
    let occurrence: NativeMediaOccurrence, bytes: Uint8Array | undefined;
    try {
      if (leaf.representation === "path") {
        invariant(typeof leaf.value === "string" && leaf.value.length > 0 && leaf.value.length <= 4096, "MEDIA_PATH");
        occurrence = { id, kind: "image", source: "disk", path: leaf.value, nativeType: String(source.type), state: "pending" };
      } else if (leaf.representation === "dataUrl" && typeof leaf.assetId === "string" && leaf.assetId.length > 0 && leaf.assetId.length <= 1024 && leaf.value == null) {
        occurrence = { id, kind: "image", source: "native", assetId: leaf.assetId, absent: true, state: "unavailable" };
      } else if (leaf.value === undefined || leaf.value === null || leaf.value === "") {
        occurrence = { id, kind: "image", source: "native", absent: true, state: "unavailable" };
      } else {
        invariant(typeof leaf.value === "string", "MEDIA_ENCODING");
        const match = leaf.representation === "dataUrl" ? /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(leaf.value) : null;
        invariant(leaf.representation !== "dataUrl" || match, "MEDIA_ENCODING");
        const mediaType = match?.[1] ?? leaf.mediaType ?? "image/png";
        const decoded = inlineMedia(match ? leaf.value.slice(match[0].length) : leaf.value, mediaType); bytes = decoded.bytes;
        occurrence = { id, kind: "image", source: "inline", mediaType, sha256: decoded.sha256, bytes: bytes.length, state: "pending" };
      }
    } catch {
      unsupported = true; occurrence = { id, kind: "unsupported", source: "unsupported", nativeType: "invalid-image", state: "unsupported" };
    }
    const resolved = resolveMedia(scope, occurrence, bytes, handler); media.push(resolved);
    return { media: mediaMeaning([resolved])[0] as Json };
  });
  const parts = source.type === "mcpToolCall" && source.result != null ? plain(source.result).content
    : source.type === "dynamicToolCall" ? source.contentItems
    : ["functionCallOutput", "function_call_output", "custom_tool_call_output"].includes(String(source.type)) ? source.output : source.content;
  if (Array.isArray(parts)) {
    const accepted = source.type === "userMessage" ? ["text", "image", "localImage"]
      : source.type === "dynamicToolCall" ? ["inputText", "inputImage"]
      : source.type === "mcpToolCall" ? ["text", "image"] : ["input_text", "output_text", "input_image"];
    for (const [index, raw] of parts.entries()) {
      const part = plain(raw);
      if (accepted.includes(String(part.type))) continue;
      invariant(media.length < MAX_NATIVE_MEDIA_OCCURRENCES, "MEDIA_REFERENCE_BOUND"); unsupported = true;
      media.push({ id: `${occurrenceId}:unsupported:${index}`, kind: "unsupported", source: "unsupported", nativeType: typeof part.type === "string" ? part.type.slice(0, 128) : "unknown", state: "unsupported" });
    }
  }
  if (source.type === "mcpToolCall" && source.result != null && plain(source.result).structuredContent != null) unsupported = true;
  return { item, media, unsupported };
}

