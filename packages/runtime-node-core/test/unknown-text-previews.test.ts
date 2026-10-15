import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRuntimeNodeBootId, newRuntimeNodeId, newSessionId, type ImageTarget, type RuntimeNodeSessionRecord } from "@arduano/agent-multiplex-protocol";
import { RuntimeImages, RuntimeNodeStore } from "../src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-unknown-text-"));
  const store = new RuntimeNodeStore(":memory:"), runtimeNodeId = newRuntimeNodeId();
  const target: ImageTarget = { sessionId: newSessionId(), runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1 };
  const images = new RuntimeImages(store, runtimeNodeId);
  await images.ready();
  cleanup.push(async () => { await images.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const session = { sessionId: target.sessionId, bindingRevision: 1, cwd: directory } as RuntimeNodeSessionRecord;
  const snapshot = (path: string, sourceKey = path, documents = true) => images.snapshot(target, sourceKey, path, session, {} as never, true, documents);
  return { directory, images, snapshot, target };
}

describe("content-validated unknown text previews", () => {
  it.each(["program.spade", "model.unregistered-format", "manifest", ".custom-format", "misleading.png", "misleading.pdf"])(
    "snapshots bounded UTF-8 %s as inert text regardless of its suffix", async name => {
      const f = await fixture(), bytes = Buffer.from("\ufeffλ demo {\n\tvalue = \"é\"\r\n}\n");
      await writeFile(join(f.directory, name), bytes);
      const descriptor = await f.snapshot(name);
      expect(descriptor).toMatchObject({ mediaType: "text/plain; charset=utf-8", byteLength: bytes.length });
      const read = await f.images.read({ ...f.target, imageId: descriptor.imageId, offset: 0, length: bytes.length });
      expect(Buffer.from(read.dataBase64, "base64")).toEqual(bytes);
      await expect(f.images.getBytes(f.target, descriptor)).rejects.toThrow("only images");
    });

  it("retains native image/PDF signature precedence over unknown filenames and keeps unknown HTML-shaped bytes as text", async () => {
    const f = await fixture();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2cAAAAASUVORK5CYII=", "base64");
    const files = [
      ["diagram.spade", png, "image/png"],
      ["document.unregistered", Buffer.from("%PDF-1.7\nfixture-only\n%%EOF\n"), "application/pdf"],
      ["drawing.unregistered", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), "image/svg+xml"],
      ["markup.spade", Buffer.from("<!doctype html><script>throw new Error('not executed')</script>"), "text/plain; charset=utf-8"],
    ] as const;
    for (const [name, bytes, mediaType] of files) {
      await writeFile(join(f.directory, name), bytes);
      expect(await f.snapshot(name)).toMatchObject({ mediaType, byteLength: bytes.length });
    }
  });

  it.each([
    ["NUL", Buffer.from([0x61, 0, 0x62])], ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["C0 control", Buffer.from([0x61, 1, 0x62])], ["escape", Buffer.from("\x1b[31mbinary-looking")],
    ["DEL", Buffer.from([0x61, 0x7f])], ["C1 control", Buffer.from("text\u0085data")],
  ] as const)("refuses unknown files with %s without retaining a successful snapshot", async (_kind, bytes) => {
    const f = await fixture();
    await writeFile(join(f.directory, "binary.spade"), bytes);
    await expect(f.snapshot("binary.spade")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await writeFile(join(f.directory, "binary.spade"), "valid replacement\n");
    expect(await f.snapshot("binary.spade")).toMatchObject({ mediaType: "text/plain; charset=utf-8" });
  });

  it("preserves previously supported ANSI log files while keeping the unknown fallback strict", async () => {
    const f = await fixture(), bytes = Buffer.from("\x1b[32mBuild passed\x1b[0m\n");
    await writeFile(join(f.directory, "build.log"), bytes);
    await writeFile(join(f.directory, "build.unregistered"), bytes);
    expect(await f.snapshot("build.log")).toMatchObject({ mediaType: "text/plain; charset=utf-8" });
    await expect(f.snapshot("build.unregistered")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(f.snapshot("build.log", "image-only", false)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("keeps the exact 2 MiB text cap, immutable first snapshot and session/binding ownership", async () => {
    const f = await fixture(), maximum = 2 * 1_024 * 1_024;
    await writeFile(join(f.directory, "large.spade"), Buffer.alloc(maximum + 1, 0x61));
    await expect(f.snapshot("large.spade")).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
    await writeFile(join(f.directory, "large.spade"), Buffer.alloc(maximum, 0x61));
    const descriptor = await f.snapshot("large.spade");
    expect(descriptor.byteLength).toBe(maximum);
    await writeFile(join(f.directory, "large.spade"), "changed source\n");
    expect(await f.snapshot("large.spade")).toEqual(descriptor);
    await expect(f.images.read({ ...f.target, sessionId: newSessionId(), imageId: descriptor.imageId, offset: 0, length: 1 }))
      .rejects.toMatchObject({ code: "FENCED" });
    await expect(f.images.read({ ...f.target, bindingRevision: 2, imageId: descriptor.imageId, offset: 0, length: 1 }))
      .rejects.toMatchObject({ code: "FENCED" });
    expect(Buffer.from((await f.images.read({ ...f.target, imageId: descriptor.imageId, offset: 0, length: 1 })).dataBase64, "base64").toString()).toBe("a");
  });

  it("preserves path syntax, workspace confinement, private storage and regular-file boundaries for unknown suffixes", async () => {
    if (process.platform !== "linux") return;
    const f = await fixture(), outside = join(f.directory, "..", "outside-unknown-" + crypto.randomUUID() + ".spade");
    await writeFile(outside, "outside\n");
    cleanup.push(() => rm(outside, { force: true }));
    await symlink(outside, join(f.directory, "escape.spade"));
    for (const path of ["../" + outside.split("/").at(-1), "escape.spade"])
      await expect(f.snapshot(path)).rejects.toMatchObject({ code: "FENCED" });
    for (const path of ["https://fixture.invalid/model.spade", "//remote/model.spade", "model.spade\u0000", " model.spade"])
      await expect(f.snapshot(path)).rejects.toMatchObject({ code: "FENCED" });
    await expect(f.snapshot(f.directory)).rejects.toMatchObject({ code: "FENCED" });
  });
});
