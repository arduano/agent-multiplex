import { type CommandImageBinding, type HarnessCommand, type JsonObject, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { externalizeNativeImages, nativeImagePayloadByteUpperBound, type NativeImageCodec, type NativeImageLeaf } from "@arduano/agent-multiplex-runtime-node-core";

/** Native event fields only; arbitrary tool arguments/results are never searched. */
export const copilotImageCodec: NativeImageCodec = {
  externalize: (payload, sink) => externalizeNativeImages(payload, sink, copilotImageLeaves(payload)),
  acceptsCommandImage: acceptsCopilotCommandImage,
  validateCommand: (request) => {
    if (request.harness !== "copilot" || !("prompt" in request.command)) return;
    for (const source of [request.command.prompt, request.command.native]) {
      const attachments = object(source)?.attachments;
      if (!Array.isArray(attachments)) continue;
      for (const value of attachments) {
        const attachment = object(value);
        if (attachment?.type === "blob" && typeof attachment.mimeType === "string" && attachment.mimeType.startsWith("image/") && attachment.data !== null) {
          throw new TypeError("Copilot image input requires an uploaded image binding");
        }
      }
    }
  },
};

export function acceptsCopilotCommandImage(request: HarnessCommand, slot: CommandImageBinding): boolean {
  if (request.harness !== "copilot" || !("prompt" in request.command)) return false;
  const match = /^\/command\/(prompt|native)\/attachments\/(0|[1-9][0-9]*)\/data$/.exec(slot.pointer);
  if (!match || slot.representation !== "base64") return false;
  const source = object(match[1] === "prompt" ? request.command.prompt : request.command.native);
  const attachment = Array.isArray(source?.attachments) ? object(source.attachments[Number(match[2])]) : undefined;
  return attachment?.type === "blob" && attachment.data === null && attachment.mimeType === slot.image.mediaType;
}

export function copilotImageLeaves(payload: JsonValue): NativeImageLeaf[] {
  const leaves: NativeImageLeaf[] = [];
  const events = Array.isArray(payload) ? payload : [payload];
  const assets = new Map<string, JsonObject>();
  for (const event of events) {
    const record = object(event);
    const data = object(record?.data);
    if (record?.type === "session.binary_asset" && data?.type === "image" && typeof data.assetId === "string") assets.set(data.assetId, data);
  }
  function binary(value: unknown, pointer: string, sourceKey: string) {
    const entry = object(value);
    if (entry?.type === "file" && typeof entry.path === "string" &&
      (typeof entry.mimeType === "string" ? entry.mimeType.startsWith("image/") : /\.(png|jpe?g|webp|gif|svg)$/i.test(entry.path))) {
      leaves.push({ pointer: `${pointer}/path`, representation: "path", sourceKey: `${sourceKey}:${entry.path}` });
      return;
    }
    if (!entry || (entry.type !== "blob" && entry.type !== "image") || typeof entry.mimeType !== "string" || !entry.mimeType.startsWith("image/")) return;
    if (typeof entry.data === "string") {
      leaves.push({ pointer: `${pointer}/data`, representation: "base64", mediaType: entry.mimeType });
    } else if (typeof entry.assetId === "string") {
      const asset = assets.get(entry.assetId);
      // Preserve the native asset relation and add a null data slot. The SDK
      // normally expands these for external clients; missing assets are explicit.
      leaves.push({ pointer: `${pointer}/data`, representation: "base64", mediaType: entry.mimeType,
        ...(typeof asset?.data === "string" ? { dataBase64: asset.data } : { unavailable: { unavailable: true, reason: "missing" } }) });
    } else if (entry.omittedReason) {
      leaves.push({ pointer: `${pointer}/data`, representation: "base64", unavailable: { unavailable: true, reason: "tooLarge" } });
    }
  }
  function list(value: unknown, pointer: string, sourceKey: string) {
    if (Array.isArray(value)) value.forEach((entry, index) => binary(entry, `${pointer}/${index}`, `${sourceKey}:${index}`));
  }
  events.forEach((value, index) => {
    const event = object(value);
    const data = object(event?.data);
    if (!event || !data) return;
    const prefix = Array.isArray(payload) ? `/${index}/data` : "/data";
    const sourceKey = `copilot:event:${String(event.id ?? "unknown")}`;
    switch (event.type) {
      case "model.messages_snapshot": {
        // The pinned CLI's ephemeral model context uses chat content parts.
        if (Array.isArray(data.messages)) data.messages.forEach((value, messageIndex) => {
          const message = object(value);
          if (!Array.isArray(message?.content)) return;
          message.content.forEach((value, contentIndex) => {
            const content = object(value);
            if (content?.type === "image_url" && typeof object(content.image_url)?.url === "string") {
              leaves.push({ pointer: `${prefix}/messages/${messageIndex}/content/${contentIndex}/image_url/url`, representation: "dataUrl" });
            }
          });
        });
        break;
      }
      case "user.message": list(data.attachments, `${prefix}/attachments`, sourceKey); break;
      case "session.binary_asset": binary(data, prefix, sourceKey); break;
      case "tool.execution_complete": {
        const result = object(data.result);
        list(result?.contents, `${prefix}/result/contents`, `${sourceKey}:contents`);
        list(result?.binaryResultsForLlm, `${prefix}/result/binaryResultsForLlm`, `${sourceKey}:binary`);
        break;
      }
    }
  });
  return leaves;
}

/** SDK getEvents is unpaged; apply the public wire budget after native retrieval. */
export function copilotHistoryEventBytes(payload: JsonValue, pageIndex = 0): number {
  // Charging one complete envelope per event is conservative for the combined
  // page. Include its final page index in every image sidecar pointer.
  return nativeImagePayloadByteUpperBound(payload, copilotImageLeaves(payload), `/${pageIndex}`);
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
