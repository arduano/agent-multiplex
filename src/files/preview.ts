import { FileError, type Preview, type StoredFile } from "./contracts.js";
export function imageType(bytes: Uint8Array): string | null {
  const prefix = String.fromCharCode(...bytes.subarray(0, 32));
  if (bytes.length >= 24 && prefix.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes.length >= 10 && (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")))
    return "image/gif";
  if (bytes.length >= 12 && prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP")
    return "image/webp";
  return null;
}
export function textContent(bytes: Uint8Array, maximum: number): string {
  if (bytes.byteLength > maximum)
    throw new FileError("CAPACITY", "Text preview exceeds its byte limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileError("UNSUPPORTED", "Content is not UTF-8 text");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))
    throw new FileError("UNSUPPORTED", "Content is binary");
  return text;
}
export function mediaType(bytes: Uint8Array, declared = "application/octet-stream"): string {
  const type = declared.toLowerCase().split(";")[0]!.trim();
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type) || type.length > 128)
    throw new FileError("INVALID", "Invalid media type");
  const image = imageType(bytes);
  if (image) return image;
  if (type.startsWith("image/") && type !== "image/svg+xml")
    throw new FileError("UNSUPPORTED", "Image signature does not match a supported image");
  if (type === "application/pdf" && String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-")
    throw new FileError("UNSUPPORTED", "Invalid PDF signature");
  return type;
}
/** Consumers render HTML only in an opaque sandbox and Mermaid with strict
 * security mode. These descriptors never authorize application-origin HTML. */
export function preview(file: StoredFile, bytes: Uint8Array, maxTextBytes = 1024 * 1024): Preview {
  if (bytes.byteLength !== file.bytes)
    throw new FileError("CORRUPT", "Preview length differs from immutable file");
  if (imageType(bytes) === file.mediaType) return { kind: "image", file };
  if (file.mediaType === "application/pdf") return { kind: "pdf", file };
  if (bytes.byteLength > maxTextBytes) return { kind: "download", file, reason: "too-large" };
  if (file.mediaType === "image/svg+xml") return { kind: "download", file, reason: "unsupported" };
  if (file.mediaType === "text/html")
    return {
      kind: "html",
      file,
      text: textContent(bytes, maxTextBytes),
      sandbox: "",
      csp: "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:",
    };
  if (file.mediaType === "text/vnd.mermaid")
    return {
      kind: "mermaid",
      file,
      text: textContent(bytes, maxTextBytes),
      securityLevel: "strict",
    };
  if (file.mediaType.startsWith("text/") || file.mediaType === "application/json")
    return { kind: "text", file, text: textContent(bytes, maxTextBytes) };
  return { kind: "download", file, reason: "unsupported" };
}
