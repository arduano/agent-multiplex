import { digest, imageType } from "../contracts/content.js";
import { defaultLimits } from "../contracts/limits.js";
import { FileError } from "../contracts/types.js";

/** User SVG input only. Native output retains its original immutable SVG bytes. */
export async function svgInputToPng(blob: Blob): Promise<Readonly<{ blob: Blob; provenance: Readonly<{ sourceSha256: string; sourceMediaType: "image/svg+xml"; outputSha256: string; transform: "browser-canvas-png"; width: number; height: number }> }>> {
  if (blob.size > defaultLimits.maxFileBytes) throw new FileError("INVALID");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (imageType(bytes) !== "image/svg+xml") throw new FileError("UNSUPPORTED");
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" })), image = new Image();
  try {
    image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new FileError("UNSUPPORTED");
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) throw new FileError("UNSUPPORTED");
    context.drawImage(image, 0, 0, width, height);
    const output = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new FileError("UNSUPPORTED")), "image/png"));
    canvas.width = canvas.height = 0;
    if (output.size > defaultLimits.maxFileBytes) throw new FileError("STORAGE_FULL");
    return Object.freeze({ blob: output, provenance: Object.freeze({ sourceSha256: await digest(bytes), sourceMediaType: "image/svg+xml", outputSha256: await digest(new Uint8Array(await output.arrayBuffer())), transform: "browser-canvas-png", width, height }) });
  } finally { image.removeAttribute("src"); URL.revokeObjectURL(url); }
}
