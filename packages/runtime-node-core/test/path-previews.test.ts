import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  imageBeginUploadInputSchema, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  type RuntimeNodeSessionRecord, type ImageTarget,
} from "@arduano/agent-multiplex-protocol";
import { RuntimeImages, RuntimeNodeStore, readConfinedImage, validPreviewPath } from "../src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-preview-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const target: ImageTarget = {
    sessionId: newSessionId(), runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1,
  };
  const images = new RuntimeImages(store, runtimeNodeId);
  await images.ready();
  cleanup.push(async () => { await images.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const session = { sessionId: target.sessionId, bindingRevision: 1, cwd: directory } as RuntimeNodeSessionRecord;
  const snapshot = (name: string) => images.snapshot(target, name, name, session, {} as never, true, true);
  return { directory, images, snapshot, target };
}

describe("session-fenced local path previews", () => {
  it("admits drive paths but rejects URL schemes, UNC shares and alternate streams", () => {
    expect(validPreviewPath(String.raw`C:\Work\report.pdf`, "win32")).toBe(true);
    expect(validPreviewPath("C:/Work/report.pdf", "win32")).toBe(true);
    for (const value of [String.raw`\\server\share\report.pdf`, String.raw`\\?\C:\Work\report.pdf`,
      "C:/Work/report.pdf:stream", "C:relative.pdf", "file:///C:/Work/report.pdf", "https://example.org/report.pdf"]) {
      expect(validPreviewPath(value, "win32"), value).toBe(false);
    }
    expect(validPreviewPath("/home/owner/work/report.pdf", "linux")).toBe(true);
    expect(validPreviewPath(String.raw`C:\Work\report.pdf`, "linux")).toBe(false);
  });

  it("snapshots text and PDF bytes through the bounded image transport but disallows them as image uploads or attachments", async () => {
    const { directory, images, snapshot, target } = await fixture();
    await writeFile(join(directory, "notes.md"), "# Private workspace notes\n");
    await writeFile(join(directory, "report.pdf"), "%PDF-1.7\nsample");
    const text = await snapshot("notes.md");
    const pdf = await snapshot("report.pdf");
    expect(text.mediaType).toBe("text/plain; charset=utf-8");
    expect(pdf.mediaType).toBe("application/pdf");
    expect(Buffer.from((await images.read({ ...target, imageId: text.imageId, offset: 0, length: 64 })).dataBase64, "base64").toString()).toBe("# Private workspace notes\n");
    expect(imageBeginUploadInputSchema.safeParse({ ...target, imageId: pdf.imageId, byteLength: pdf.byteLength, sha256: pdf.sha256, mediaType: pdf.mediaType }).success).toBe(false);
    await expect(images.getBytes(target, text)).rejects.toThrow("only images");
  });

  it("rejects traversal, symlinks outside the workspace, directories, oversized files and binary text", async () => {
    if (process.platform !== "linux") return;
    const { directory, snapshot } = await fixture();
    const outside = join(directory, "..", "outside-preview-" + crypto.randomUUID() + ".txt");
    await writeFile(outside, "outside");
    cleanup.push(() => rm(outside, { force: true }));
    await symlink(outside, join(directory, "escape.md"));
    await mkdir(join(directory, "folder"));
    await writeFile(join(directory, "binary.md"), Buffer.from([0x61, 0, 0x62]));
    await writeFile(join(directory, "large.md"), Buffer.alloc(10 * 1_024 * 1_024 + 1, 0x61));
    await expect(snapshot("../" + outside.split("/").at(-1))).rejects.toThrow("outside configured roots");
    await expect(snapshot("escape.md")).rejects.toThrow("outside configured roots");
    await expect(snapshot("folder")).rejects.toThrow("regular file");
    await expect(snapshot("binary.md")).rejects.toThrow("binary file");
    await expect(snapshot("large.md")).rejects.toThrow("maximum byte length");
    await expect(readConfinedImage(join(directory, "binary.md"), [directory], 100, [directory])).rejects.toThrow("private runtime image storage");
  });
});
