import { type CommandImageBinding, type HarnessCommand, type JsonObject, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { externalizeNativeImages, nativeImagePayloadByteUpperBound, type NativeImageCodec, type NativeImageLeaf } from "@arduano/agent-multiplex-runtime-node-core";

/** Pinned structural locations only: tool arguments and structuredContent stay opaque. */
export const codexImageCodec: NativeImageCodec = {
  externalize: (payload, sink) => externalizeNativeImages(payload, sink, codexImageLeaves(payload)),
  acceptsCommandImage: acceptsCodexCommandImage,
  validateCommand: (request) => {
    if (request.harness !== "codex" || !("input" in request.command) || !Array.isArray(request.command.input)) return;
    for (const entry of request.command.input) {
      const input = object(entry);
      if (input?.type === "image" && input.url !== null) throw new TypeError("Codex image input requires an uploaded image binding");
    }
  },
};

export function acceptsCodexCommandImage(request: HarnessCommand, slot: CommandImageBinding): boolean {
  if (request.harness !== "codex" || !["send", "steer"].includes(request.command.type)) return false;
  const match = /^\/command\/input\/(0|[1-9][0-9]*)\/url$/.exec(slot.pointer);
  if (!match || slot.representation !== "dataUrl" || !("input" in request.command) || !Array.isArray(request.command.input)) return false;
  const input = object(request.command.input[Number(match[1])]);
  return input?.type === "image" && input.url === null;
}

export function codexImageLeaves(payload: JsonValue): NativeImageLeaf[] {
  const leaves: NativeImageLeaf[] = [];
  function content(value: unknown, pointer: string, kind: "user" | "response" | "dynamic" | "mcp", sourceKey: string) {
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) => {
      const item = object(entry);
      if (!item) return;
      const prefix = `${pointer}/${index}`;
      if (kind === "user" && item.type === "image") leaves.push({ pointer: `${prefix}/url`, representation: "dataUrl" });
      if (kind === "user" && item.type === "localImage") leaves.push({ pointer: `${prefix}/path`, representation: "path", sourceKey: `${sourceKey}:input:${index}:${String(item.path)}` });
      if (kind === "response" && item.type === "input_image") leaves.push({ pointer: `${prefix}/image_url`, representation: "dataUrl" });
      if (kind === "dynamic" && item.type === "inputImage") leaves.push({ pointer: `${prefix}/imageUrl`, representation: "dataUrl" });
      if (kind === "mcp" && item.type === "image") leaves.push({ pointer: `${prefix}/data`, representation: "base64", ...(typeof item.mimeType === "string" ? { mediaType: item.mimeType } : {}) });
    });
  }
  function item(value: unknown, pointer: string) {
    const entry = object(value);
    if (!entry) return;
    const sourceKey = `codex:item:${String(entry.id ?? entry.call_id ?? "unknown")}`;
    switch (entry.type) {
      case "userMessage": content(entry.content, `${pointer}/content`, "user", sourceKey); break;
      case "message": content(entry.content, `${pointer}/content`, "response", sourceKey); break;
      case "functionCallOutput":
      case "function_call_output":
      case "custom_tool_call_output": content(entry.output, `${pointer}/output`, "response", sourceKey); break;
      case "dynamicToolCall": content(entry.contentItems, `${pointer}/contentItems`, "dynamic", sourceKey); break;
      case "mcpToolCall": content(object(entry.result)?.content, `${pointer}/result/content`, "mcp", sourceKey); break;
      case "imageView": leaves.push({ pointer: `${pointer}/path`, representation: "path", sourceKey: `${sourceKey}:${String(entry.path)}` }); break;
      case "imageGeneration":
        if (typeof entry.savedPath === "string") leaves.push({ pointer: `${pointer}/savedPath`, representation: "path", sourceKey: `${sourceKey}:${entry.savedPath}` });
        leaves.push({ pointer: `${pointer}/result`, representation: "base64" }); break;
      case "image_generation_call": leaves.push({ pointer: `${pointer}/result`, representation: "base64" }); break;
    }
  }
  function turn(value: unknown, pointer: string) {
    const entry = object(value);
    if (Array.isArray(entry?.items)) entry.items.forEach((value, index) => item(value, `${pointer}/items/${index}`));
  }
  const root = object(payload);
  if (!root) return leaves;
  if (typeof root.threadId === "string") item(root.item, "/item");
  if (Array.isArray(root.data) && Object.hasOwn(root, "nextCursor")) root.data.forEach((entry, index) => {
    const row = object(entry);
    if (typeof row?.turnId === "string") item(row.item, `/data/${index}/item`);
  });
  turn(root.turn, "/turn");
  const thread = object(root.thread);
  if (Array.isArray(thread?.turns)) thread.turns.forEach((value, index) => turn(value, `/thread/turns/${index}`));
  return leaves;
}

/** Estimate the public page without copying inline binaries or touching storage. */
export function codexHistoryPageBytes(payload: JsonValue): number {
  return nativeImagePayloadByteUpperBound(payload, codexImageLeaves(payload));
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
