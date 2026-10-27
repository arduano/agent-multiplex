import { FileError } from "./types.js";
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, "0")).join("");
}
export function imageType(bytes: Uint8Array): string | undefined {
  const prefix = String.fromCharCode(...bytes.subarray(0, 256));
  if (bytes.length >= 24 && bytes[0] === 137 && prefix.slice(1, 8) === "PNG\r\n\x1a\n") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(prefix)) return "image/svg+xml";
  return undefined;
}
export function textContent(bytes: Uint8Array, maximum: number): string {
  if (bytes.length > maximum) throw new FileError("UNSUPPORTED", "Text preview exceeds its bound");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new FileError("UNSUPPORTED", "Binary file has no text preview"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw new FileError("UNSUPPORTED", "Binary file has no text preview");
  return text;
}
