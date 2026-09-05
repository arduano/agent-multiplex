import { describe, expect, it } from "vitest";
import { isLocalImagePath, modelImageLimits } from "../apps/web/src/client/image-media.js";

describe("web image policies", () => {
  it("keeps URL schemes and network paths out of runtime resolution", () => {
    for (const path of ["https://example.test/a.png", "//example.test/a.png", "file:///etc/a.png", "data:image/png;base64,AA==", "javascript:alert(1)", "\\\\server\\file.png", " https://example.test/a.png", "a\nb.png", "#fragment"]) expect(isLocalImagePath(path), path).toBe(false);
    for (const path of ["outputs/chart.png", "/workspace/chart.svg", "../shared/image.png"]) expect(isLocalImagePath(path), path).toBe(true);
  });
  it("uses native advertised capabilities and distinguishes unknown BYOK models", () => {
    expect(modelImageLimits({ harness: "codex", id: "text", native: { inputModalities: ["text"] } }).support).toBe("unsupported");
    expect(modelImageLimits({ harness: "codex", id: "vision", native: { inputModalities: ["text", "image"] } }).support).toBe("supported");
    expect(modelImageLimits({ harness: "copilot", id: "custom", native: { imageSupport: "unknown", capabilities: { supports: { vision: false } } } }).support).toBe("unknown");
    expect(modelImageLimits({ harness: "copilot", id: "vision", native: { capabilities: { supports: { vision: true }, limits: { vision: { max_prompt_images: 2, max_prompt_image_size: 1024, supported_media_types: ["image/png"] } } } } })).toEqual({ support: "supported", count: 2, bytes: 1024, mediaTypes: ["image/png"] });
  });
});
