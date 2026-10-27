import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/contracts/content.js";
import type { ArtifactRef, FileScope } from "../src/contracts/types.js";
import { prepareCodexImage, prepareCopilotImage } from "../src/native/index.js";

const scope: FileScope = { connection: "test", principal: "owner", host: "host", session: "session" };
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
async function artifact(bytes = png, mediaType = "image/png"): Promise<ArtifactRef> {
  return { kind: "artifact", owner: scope, id: "image", name: "image.png", mediaType, bytes: bytes.length, sha256: await digest(bytes), capturedAt: 0 };
}
test("native image preparation preserves exact verified raster bytes in separate native shapes", async () => {
  const ref = await artifact();
  const codex = await prepareCodexImage({ harness: "codex", scope, artifact: ref, bytes: png });
  const copilot = await prepareCopilotImage({ harness: "copilot", scope, artifact: ref, bytes: png });
  assert.equal(codex.type, "image"); assert.equal(copilot.type, "blob"); assert.equal(copilot.mimeType, "image/png");
  assert.deepEqual(Buffer.from(codex.url.split(",")[1]!, "base64"), Buffer.from(png));
  assert.deepEqual(Buffer.from(copilot.data, "base64"), Buffer.from(png));
});
test("native image preparation rejects foreign scope and corrupt or mislabelled bytes", async () => {
  const ref = await artifact();
  await assert.rejects(prepareCodexImage({ harness: "codex", scope: { ...scope, session: "foreign" }, artifact: ref, bytes: png }), /FENCED/);
  await assert.rejects(prepareCopilotImage({ harness: "copilot", scope, artifact: ref, bytes: new Uint8Array(png.length) }), /CORRUPT/);
  await assert.rejects(prepareCopilotImage({ harness: "copilot", scope, artifact: { ...ref, mediaType: "image/jpeg" }, bytes: png }), /verified raster/);
});
test("generic binary and SVG storage do not imply native ingestion or host rendering", async () => {
  for (const [bytes, mediaType] of [[new TextEncoder().encode("binary content"), "application/octet-stream"], [new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml"]] as const) {
    const ref = await artifact(bytes, mediaType);
    await assert.rejects(prepareCodexImage({ harness: "codex", scope, artifact: ref, bytes }), /verified raster/);
    await assert.rejects(prepareCopilotImage({ harness: "copilot", scope, artifact: ref, bytes }), /verified raster/);
  }
});
test("native image preparation snapshots bytes before awaiting verification", async () => {
  const bytes = new Uint8Array(png), ref = await artifact(bytes);
  const pending = prepareCopilotImage({ harness: "copilot", scope, artifact: ref, bytes });
  bytes.fill(0);
  const result = await pending; assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from(png));
  const original = await artifact(), manifest = { ...original, sha256: "0".repeat(64) };
  const conflicting = prepareCodexImage({ harness: "codex", scope, artifact: manifest, bytes: png });
  manifest.sha256 = original.sha256;
  await assert.rejects(conflicting, /CORRUPT/);
});
