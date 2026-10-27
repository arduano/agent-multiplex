import type { CopilotScope } from "../../contracts/types.js";
import { inlineMedia, MAX_NATIVE_MEDIA_OCCURRENCES, mediaMeaning, resolveMedia, type NativeMediaHandler, type NativeMediaOccurrence } from "../../contracts/media.js";
import { invariant, object } from "../../contracts/validation.js";

/** Closed SDK image-bearing paths, shared by framing and history extraction. */
export function mapCopilotMediaLeaves(type: string, data: Record<string, unknown>, map: (leaf: unknown, pointer: string) => unknown): Record<string, unknown> {
  const list = (raw: unknown, pointer: string) => {
    invariant(Array.isArray(raw) && raw.length <= MAX_NATIVE_MEDIA_OCCURRENCES, "MEDIA_REFERENCE_BOUND");
    return raw.map((item, index) => map(item, `${pointer}/${index}`));
  };
  invariant(Object.values(Object.getOwnPropertyDescriptors(data)).every(value => "value" in value), "MEDIA_ACCESSOR");
  if (type === "user.message" && data.attachments !== undefined) return { ...data, attachments: list(data.attachments, "attachments") };
  if (type === "session.binary_asset" && data.type === "image") return object(map(data, "asset"));
  if (type === "tool.execution_complete" && data.result !== undefined && data.result !== null) {
    const result = object(data.result);
    invariant(Object.values(Object.getOwnPropertyDescriptors(result)).every(value => "value" in value), "MEDIA_ACCESSOR");
    const normalized = { ...result };
    for (const key of ["contents", "binaryResultsForLlm"]) if (result[key] !== undefined) normalized[key] = list(result[key], `result/${key}`);
    return { ...data, result: normalized };
  }
  return data;
}

/** SDK image attachment/result leaves only. Raw tool arguments are never searched. */
export function copilotMediaData(type: string, data: Record<string, unknown>, eventId: string, scope?: CopilotScope, handler?: NativeMediaHandler): Readonly<{
  data: Record<string, unknown>; media: readonly NativeMediaOccurrence[]; unsupported: boolean;
}> {
  const media: NativeMediaOccurrence[] = []; let unsupported = false;
  if (!["user.message", "session.binary_asset", "tool.execution_complete"].includes(type)) return { data, media, unsupported };
  function leaf(raw: unknown, pointer: string): unknown {
    const item = object(raw);
    invariant(Object.values(Object.getOwnPropertyDescriptors(item)).every(value => "value" in value), "MEDIA_ACCESSOR");
    if (item.type === "text" && typeof item.text === "string") return raw;
    // SDK .19 result.contents also carries terminal metadata. These leaves
    // describe the shell, not missing image bytes. Explicit result content is
    // independent; neither terminal text nor an output preview seals a body.
    if (pointer.startsWith("result/contents/") && (item.type === "terminal" || item.type === "shell_exit")) {
      const terminal = item.type === "terminal";
      const allowed = terminal ? ["type", "text", "cwd", "exitCode"] : ["type", "exitCode", "shellId", "cwd", "outputFilePath", "outputPreview", "outputTruncated"];
      invariant(Object.keys(item).every(key => allowed.includes(key)), "COPILOT_TERMINAL_SHAPE");
      for (const key of ["cwd", "outputFilePath"]) if (Object.hasOwn(item, key)) invariant(typeof item[key] === "string" && (item[key] as string).length > 0 && (item[key] as string).length <= 4096, "COPILOT_TERMINAL_PATH");
      if (terminal) invariant(typeof item.text === "string" && item.text.length <= 65_536, "COPILOT_TERMINAL_TEXT");
      else {
        invariant(typeof item.shellId === "string" && item.shellId.length > 0 && item.shellId.length <= 1024, "COPILOT_TERMINAL_ID");
        invariant(Number.isSafeInteger(item.exitCode), "COPILOT_TERMINAL_EXIT");
        if (Object.hasOwn(item, "outputPreview")) invariant(typeof item.outputPreview === "string" && item.outputPreview.length <= 65_536, "COPILOT_TERMINAL_TEXT");
        if (Object.hasOwn(item, "outputTruncated")) invariant(typeof item.outputTruncated === "boolean", "COPILOT_TERMINAL_TRUNCATION");
      }
      if (Object.hasOwn(item, "exitCode")) invariant(Number.isSafeInteger(item.exitCode), "COPILOT_TERMINAL_EXIT");
      return raw;
    }
    invariant(media.length < MAX_NATIVE_MEDIA_OCCURRENCES, "MEDIA_REFERENCE_BOUND");
    const id = JSON.stringify([eventId, pointer]); let bytes: Uint8Array | undefined, occurrence: NativeMediaOccurrence;
    const mime = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const image = (item.type === "image" || item.type === "blob" || item.type === "file") && mime?.startsWith("image/");
    const assetId = typeof item.assetId === "string" && item.assetId.length > 0 && item.assetId.length <= 1024 ? item.assetId : undefined;
    const omittedReason = typeof item.omittedReason === "string" && item.omittedReason.length <= 128 ? item.omittedReason : undefined;
    if (item.type === "file" && typeof item.path === "string" && item.path.length <= 4096) {
      // A persisted file's asset is the post-resize model-facing identity. It
      // must never be replaced by a later read of the original disk path.
      occurrence = { id, kind: image || /\.(png|jpe?g|webp|gif|svg)$/i.test(item.path) ? "image" : "unsupported",
        source: assetId || omittedReason ? "native" : "disk", path: item.path, state: assetId || omittedReason ? "unavailable" : "pending",
        ...(mime ? { mediaType: mime } : {}), ...(assetId ? { assetId, absent: true as const } : {}), ...(omittedReason ? { omittedReason } : {}) };
    } else if (image) {
      if (typeof item.data === "string") {
        try {
          const decoded = inlineMedia(item.data, mime!); bytes = decoded.bytes;
          occurrence = { id, kind: "image", source: "inline", mediaType: mime!, sha256: decoded.sha256, bytes: bytes.length, state: "pending", ...(assetId ? { assetId } : {}) };
        } catch { unsupported = true; occurrence = { id, kind: "unsupported", source: "unsupported", nativeType: "invalid-image", state: "unsupported" }; }
      } else {
        occurrence = { id, kind: "image", source: "native", mediaType: mime!, state: "unavailable", ...(!Object.hasOwn(item, "data") ? { absent: true as const } : {}), ...(assetId ? { assetId } : {}), ...(omittedReason ? { omittedReason } : {}) };
      }
    } else {
      unsupported = true; occurrence = { id, kind: "unsupported", source: "unsupported", nativeType: typeof item.type === "string" ? item.type.slice(0, 128) : "unknown", state: "unsupported" };
    }
    for (const key of ["displayName", "taggedFilesEntry"] as const) if (typeof item[key] === "string") {
      if ((item[key] as string).length > (key === "taggedFilesEntry" ? 4096 : 1024)) {
        unsupported = true; occurrence = { ...occurrence, kind: "unsupported", state: "unsupported", nativeType: `${key}-over-bound` };
      } else occurrence = { ...occurrence, [key]: item[key] as string };
    }
    if (Number.isSafeInteger(item.byteLength) && (item.byteLength as number) >= 0) occurrence = { ...occurrence, declaredBytes: item.byteLength as number };
    if (occurrence.kind === "unsupported") { unsupported = true; occurrence = { ...occurrence, state: "unsupported" }; }
    const resolved = resolveMedia(scope, occurrence, bytes, handler); media.push(resolved);
    // Project admitted identity only. Never retain native inline bytes in a history fingerprint.
    return { type: typeof item.type === "string" ? item.type.slice(0, 128) : "unknown", media: mediaMeaning([resolved])[0] };
  }
  const projected = mapCopilotMediaLeaves(type, data, leaf);
  return { data: projected, media, unsupported };
}
