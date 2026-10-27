import type { ArtifactRef, FileScope } from "../contracts/types.js";
import { FileError, assertScope, scopeKey } from "../contracts/types.js";
import { digest, imageType } from "../contracts/content.js";

export type CodexImageRequest = Readonly<{ harness: "codex"; scope: FileScope; artifact: ArtifactRef; bytes: Uint8Array }>;
export type CopilotImageRequest = Readonly<{ harness: "copilot"; scope: FileScope; artifact: ArtifactRef; bytes: Uint8Array }>;
export type CopilotBlobRequest = CopilotImageRequest;
export type CodexImageInput = Readonly<{ type: "image"; url: string }>;
export type CopilotImageAttachment = Readonly<{ type: "blob"; mimeType: string; data: string }>;

async function verifiedArtifact(input: CodexImageRequest | CopilotImageRequest, harness: "codex" | "copilot"): Promise<Readonly<{ bytes: Uint8Array; mediaType: string }>> {
  if (input.harness !== harness) throw new FileError("FENCED", "Wrong native harness");
  const artifact = { ...input.artifact, owner: { ...input.artifact.owner } }, scope = { ...input.scope };
  assertScope(scope); assertScope(artifact.owner);
  if (artifact.kind !== "artifact" || scopeKey(scope) !== scopeKey(artifact.owner)) throw new FileError("FENCED");
  // Snapshot before the asynchronous digest: caller mutation cannot change native output.
  const bytes = new Uint8Array(input.bytes);
  if (bytes.length > 10 * 1024 * 1024 || bytes.length !== artifact.bytes || await digest(bytes) !== artifact.sha256) throw new FileError("CORRUPT");
  if (typeof artifact.mediaType !== "string" || artifact.mediaType.length > 256 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(artifact.mediaType)) throw new FileError("UNSUPPORTED", "Native blob MIME type is unsupported");
  return { bytes, mediaType: artifact.mediaType };
}
async function verified(input: CodexImageRequest | CopilotImageRequest, harness: "codex" | "copilot"): Promise<Readonly<{ bytes: Uint8Array; mediaType: string }>> {
  const image = await verifiedArtifact(input, harness), bytes = image.bytes;
  const mediaType = imageType(bytes);
  if (!mediaType || mediaType !== image.mediaType || mediaType === "image/svg+xml") throw new FileError("UNSUPPORTED", "Native image preparation requires verified raster bytes");
  return { bytes, mediaType };
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}
/** Pure native encoding only: no SDK, model call, file read or native temporary path. */
export async function prepareCodexImage(input: CodexImageRequest): Promise<CodexImageInput> {
  const image = await verified(input, "codex");
  return Object.freeze({ type: "image", url: `data:${image.mediaType};base64,${base64(image.bytes)}` });
}
export async function prepareCopilotImage(input: CopilotImageRequest): Promise<CopilotImageAttachment> {
  const image = await verified(input, "copilot");
  return Object.freeze({ type: "blob", mimeType: image.mediaType, data: base64(image.bytes) });
}
/** Explicit blob ingestion, never implicit text embedding or a temporary file. */
export async function prepareCopilotBlob(input: CopilotBlobRequest): Promise<CopilotImageAttachment> {
  const blob = /^image\//i.test(input.artifact.mediaType) ? await verified(input, "copilot") : await verifiedArtifact(input, "copilot");
  return Object.freeze({ type: "blob", mimeType: blob.mediaType, data: base64(blob.bytes) });
}
