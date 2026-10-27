import { mapCodexImageLeaves } from "../../v8-history/src/native/codex/media.js";
import { mapCopilotMediaLeaves } from "../../v8-history/src/native/copilot/media.js";
import { MAX_NATIVE_MEDIA_BYTES, MAX_NATIVE_MEDIA_OCCURRENCES } from "../../v8-history/src/contracts/media.js";
import { requireThat } from "../../v8-runtime/src/validation.js";

/** Control/framing projection only. The existing history codec receives the
 * original once and remains the sole media occurrence/file-capture owner. */
const MAX_AGGREGATE_BYTES = 20 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
  requireThat(Object.values(Object.getOwnPropertyDescriptors(value)).every(field => "value" in field), "Native media accessors are unsupported");
  return value as RecordValue;
}
function optionalObject(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? object(value) : null;
}
class Budget {
  count = 0; bytes = 0;
  admit(encoded: string, mediaType: string, image: boolean): void {
    requireThat(image ? /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/.test(mediaType) : mediaType.length <= 256 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType), "Unsupported native media MIME");
    requireThat(encoded.length <= Math.ceil(MAX_NATIVE_MEDIA_BYTES / 3) * 4 && encoded.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(encoded), "Invalid native media base64");
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    requireThat(encoded.indexOf("=") === (padding ? encoded.length - padding : -1), "Invalid native media padding");
    const bytes = encoded.length / 4 * 3 - padding;
    requireThat(bytes <= MAX_NATIVE_MEDIA_BYTES && ++this.count <= MAX_NATIVE_MEDIA_OCCURRENCES && (this.bytes += bytes) <= MAX_AGGREGATE_BYTES, "Native media bound exceeded");
  }
}
function codexItem(raw: unknown, budget: Budget): unknown {
  const item = optionalObject(raw); if (!item) return raw;
  return mapCodexImageLeaves(item, leaf => {
    if (leaf.representation === "path" || leaf.value == null || leaf.value === "") return leaf.value;
    if (leaf.representation === "dataUrl") {
      if (typeof leaf.value !== "string" || !leaf.value.startsWith("data:")) return leaf.value;
      const match = /^data:(image\/[a-z+]+);base64,([\s\S]*)$/.exec(leaf.value); requireThat(match, "Unsupported native inline image");
      budget.admit(match[2]!, match[1]!, true);
    } else { requireThat(typeof leaf.value === "string"); budget.admit(leaf.value, leaf.mediaType ?? "image/png", true); }
    return "";
  });
}

/** Only exact pinned item image notification paths are eligible. */
export function projectCodexMediaNotification(raw: unknown): unknown | null {
  const value = object(raw); if (value.method !== "item/started" && value.method !== "item/completed") return null;
  const params = optionalObject(value.params); if (!params) return null;
  const budget = new Budget(), item = codexItem(params.item, budget);
  return budget.count ? { ...value, params: { ...params, item } } : null;
}

/** An actual pending method selects closed response paths, never a deep walk. */
export function projectCodexMediaResult(method: string, raw: unknown): unknown | null {
  const value = optionalObject(raw); if (!value) return null;
  const budget = new Budget(); let projected: RecordValue = value;
  if (method === "thread/items/list" && Array.isArray(value.data)) {
    projected = { ...value, data: value.data.map(raw => { const entry = object(raw); return { ...entry, item: codexItem(entry.item, budget) }; }) };
  } else if (method === "turn/start") {
    const turn = optionalObject(value.turn);
    if (turn && Array.isArray(turn.items)) projected = { ...value, turn: { ...turn, items: turn.items.map(item => codexItem(item, budget)) } };
  }
  return budget.count ? projected : null;
}

/** Only the same closed SDK attachment/tool-image leaves as history capture. */
export function projectCopilotMediaEvent(raw: unknown): unknown | null {
  const value = object(raw), data = optionalObject(value.data); if (!data) return null;
  const budget = new Budget();
  const leaf = (raw: unknown, pointer: string): unknown => {
    const item = optionalObject(raw);
    if (!item || !["image", "blob", "file"].includes(String(item.type)) || typeof item.data !== "string") return raw;
    requireThat(typeof item.mimeType === "string", "Native attachment MIME missing");
    if (pointer.startsWith("result/") && !item.mimeType.startsWith("image/")) return raw;
    budget.admit(item.data, item.mimeType, item.type === "image" || item.mimeType.startsWith("image/"));
    const { data: _body, ...metadata } = item; return metadata;
  };
  const projected = mapCopilotMediaLeaves(String(value.type), data, leaf);
  return budget.count ? { ...value, data: projected } : null;
}
