import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileError, preview, type StoredFile } from "../../src/files/index.js";
import { FileStore } from "../../src/files/node.js";
const scope = { connection: "c", principal: "p", host: "h", session: "s" };
const other = { ...scope, session: "other" };
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
async function fixture(run: (directory: string, parent: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "multiplex-files-"));
  await chmod(parent, 0o700);
  const directory = join(parent, "store");
  await mkdir(directory, { mode: 0o700 });
  try {
    await run(directory, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
const code =
  (expected: FileError["code"]) =>
  (error: unknown): boolean =>
    error instanceof FileError && error.code === expected;
test("immutable scoped originals, one owner and independent bounded leases survive reopen", () =>
  fixture(async (directory) => {
    const store = await FileStore.open({ directory, limits: { maxReadBytes: 4 } });
    const richScope = { ...scope, privateContext: "must not escape" };
    const bytes = text("hello");
    const file = await store.put(
      richScope,
      { id: "u", name: "greeting.txt", mediaType: "text/plain" },
      bytes,
    );
    bytes.fill(0);
    assert.deepEqual(file.scope, scope);
    assert.equal(
      (
        await store.put(
          scope,
          { id: "u", name: "greeting.txt", mediaType: "text/plain" },
          text("hello"),
        )
      ).sha256,
      file.sha256,
    );
    await assert.rejects(
      store.put(scope, { id: "u", name: "greeting.txt", mediaType: "text/plain" }, text("other")),
      code("CONFLICT"),
    );
    await assert.rejects(FileStore.open({ directory }), /locked/);
    await assert.rejects(store.acquire(other, file), code("FENCED"));
    const lease = await store.acquire(scope, file);
    assert.equal(new TextDecoder().decode(await lease.read(1, 4)), "ello");
    await assert.rejects(lease.read(0, 5), code("INVALID"));
    assert.throws(() => store.close(), code("BUSY"));
    await lease.release();
    await lease.release();
    store.close();
    const reopened = await FileStore.open({ directory });
    assert.deepEqual(reopened.file(scope, "u"), file);
    assert.equal(reopened.file(other, "u"), null);
    const read = await reopened.acquire(scope, file);
    assert.equal(new TextDecoder().decode(await read.read(0, 5)), "hello");
    await read.release();
    reopened.close();
  }));
test("cache expiration, native holds and explicit retired session lifetime reclaim exact accounting", () =>
  fixture(async (directory) => {
    let at = 100;
    const store = await FileStore.open({
      directory,
      now: () => at,
      limits: {
        maxFileBytes: 4,
        maxBytes: 8,
        maxSessionBytes: 4,
        maxStagingBytes: 4,
        maxEntries: 2,
        cacheTtlMs: 10,
      },
    });
    await store.put(scope, { id: "user", name: "u.txt", mediaType: "text/plain" }, text("1234"));
    const cached = await store.put(
      other,
      { id: "cache", name: "c.txt", mediaType: "text/plain", retention: "cache" },
      text("5678"),
    );
    await assert.rejects(
      store.put(scope, { id: "full", name: "f.txt" }, text("x")),
      code("CAPACITY"),
    );
    const held = await store.acquire(other, cached);
    at = 200;
    assert.deepEqual(await store.collect(), { files: 0, bytes: 0 });
    assert.equal(store.usage().bytes, 8);
    await held.release();
    assert.deepEqual(await store.collect(), { files: 1, bytes: 4 });
    await store.retireSession(scope);
    assert.deepEqual(await store.collect(), { files: 1, bytes: 4 });
    assert.equal(store.usage().bytes, 0);
    assert.equal(store.usage().entries, 0);
    store.close();
    const reopened = await FileStore.open({ directory, now: () => at });
    await assert.rejects(
      reopened.put(scope, { id: "new", name: "n.txt" }, text("x")),
      code("FENCED"),
    );
    reopened.close();
  }));
test("concurrent publication reserves bytes/count before I/O and releases failed admission", () =>
  fixture(async (directory) => {
    const store = await FileStore.open({
      directory,
      limits: { maxFileBytes: 8, maxStagingBytes: 8, maxStaging: 1 },
    });
    const results = await Promise.allSettled([
      store.put(scope, { id: "a", name: "a.bin" }, text("12345678")),
      store.put(scope, { id: "b", name: "b.bin" }, text("abcdefgh")),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(code("CAPACITY")(failed.reason));
    assert.equal(store.usage().reservedBytes, 0);
    assert.equal(store.usage().staging, 0);
    assert.equal(store.usage().bytes, 8);
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    store.close();
  }));
test("Host path authority is distinct from uploads; captures and injected native inputs retain bytes", () =>
  fixture(async (directory, parent) => {
    const workspace = join(parent, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const path = join(workspace, "note.txt");
    await writeFile(path, "first");
    const store = await FileStore.open({
      directory,
      paths: {
        async resolve(_scope, key) {
          if (key !== "observed-file") throw new FileError("FENCED");
          return { path, name: "note.txt", mediaType: "text/plain" };
        },
      },
    });
    await assert.rejects(store.reference(scope, "/etc/passwd"), code("FENCED"));
    const reference = await store.reference(scope, "observed-file");
    assert.equal("path" in reference, false);
    await assert.rejects(store.capture(other, reference, { id: "wrong" }), code("FENCED"));
    const captured = await store.capture(scope, reference, { id: "capture" });
    assert.equal(captured.origin, "capture");
    assert.equal(captured.retention, "cache");
    await writeFile(path, "later");
    const prepared = await store.prepareInput(scope, captured, {
      accepts: (file) => file.mediaType === "text/plain",
      async prepare(input) {
        return new TextDecoder().decode(await input.read(0, 5));
      },
    });
    assert.equal(prepared.input, "first");
    await store.retireSession(scope);
    assert.deepEqual(await store.collect(), { files: 0, bytes: 0 });
    await prepared.release();
    assert.deepEqual(await store.collect(), { files: 1, bytes: 5 });
    store.close();
  }));
test("symlinked Host sources, corrupt immutable objects and ignored state are never adopted", () =>
  fixture(async (directory, parent) => {
    const source = join(parent, "source");
    await writeFile(source, "safe");
    const link = join(parent, "link");
    await symlink(source, link);
    const store = await FileStore.open({
      directory,
      paths: {
        async resolve() {
          return { path: link };
        },
      },
    });
    const ref = await store.reference(scope, "observed");
    await assert.rejects(store.capture(scope, ref, { id: "link" }), code("FENCED"));
    const file = await store.put(scope, { id: "kept", name: "safe.bin" }, text("safe"));
    store.close();
    const object = (await readdir(join(directory, "objects")))[0]!;
    const data = join(directory, "objects", object, "data");
    await writeFile(data, "evil");
    await assert.rejects(FileStore.open({ directory }), code("CORRUPT"));
    assert.equal((await readFile(data)).toString(), "evil");
    await writeFile(data, "safe");
    const manifestPath = join(directory, "objects", object, "manifest.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      JSON.stringify({ ...JSON.parse(originalManifest), privateContext: "foreign" }),
    );
    await assert.rejects(FileStore.open({ directory }), code("CORRUPT"));
    await writeFile(manifestPath, originalManifest);
    await mkdir(join(directory, "objects", "unknown"), { mode: 0o700 });
    await assert.rejects(FileStore.open({ directory }), code("CORRUPT"));
    assert.ok((await readdir(join(directory, "objects"))).includes("unknown"));
    assert.equal(file.bytes, 4);
  }));
test("killed owner releases OS lock; reopening preserves published bytes and reaps only known staging", () =>
  fixture(async (directory) => {
    const module = new URL("../../src/files/node.js", import.meta.url).href;
    const script = `import{FileStore}from${JSON.stringify(module)};import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const store=await FileStore.open({directory:${JSON.stringify(directory)}});await store.put(${JSON.stringify(scope)},{id:'published',name:'p.txt',mediaType:'text/plain'},new TextEncoder().encode('durable'));const stage=join(${JSON.stringify(directory)},'staging','00000000-0000-0000-0000-000000000000');await mkdir(stage,{mode:0o700});await writeFile(join(stage,'data'),'partial',{mode:0o600});process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const store = await FileStore.open({ directory });
    const file = store.file(scope, "published")!;
    assert.equal(file.bytes, 7);
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    assert.equal(store.usage().bytes, 7);
    store.close();
  }));
test("preview contracts isolate HTML, refuse active SVG and constrain decoded text", () => {
  const descriptor = (type: string, value: string): StoredFile => ({
    kind: "stored",
    scope,
    id: "p",
    name: "p",
    bytes: text(value).length,
    sha256: "0".repeat(64),
    mediaType: type,
    origin: "upload",
    retention: "session",
  });
  const html = "<script>parent.document.body.remove()</script>";
  const result = preview(descriptor("text/html", html), text(html));
  assert.equal(result.kind, "html");
  if (result.kind === "html") {
    assert.equal(result.sandbox, "");
    assert.match(result.csp, /default-src 'none'/);
  }
  assert.equal(preview(descriptor("image/svg+xml", "<svg/>"), text("<svg/>")).kind, "download");
  assert.deepEqual(
    preview(descriptor("text/vnd.mermaid", "graph TD;A-->B"), text("graph TD;A-->B")).kind,
    "mermaid",
  );
  const diagram = preview(descriptor("text/vnd.mermaid", "graph TD;A-->B"), text("graph TD;A-->B"));
  if (diagram.kind === "mermaid") assert.equal(diagram.securityLevel, "strict");
  assert.equal(preview(descriptor("text/plain", "long"), text("long"), 2).kind, "download");
  assert.throws(
    () => preview({ ...descriptor("text/plain", "a"), bytes: 2 }, text("a")),
    code("CORRUPT"),
  );
});

test("publication witness precedes post-commit failure; aborted admission cannot publish", () =>
  fixture(async (directory) => {
    const store = await FileStore.open({ directory });
    const signal = AbortSignal.abort(Error("cancelled before publication"));
    let witnessed: StoredFile | undefined;
    await assert.rejects(
      store.put(scope, { id: "cancelled", name: "c.txt" }, text("no"), "upload", {
        signal,
        onCommitted() {
          throw Error("must not run");
        },
      }),
      /cancelled/,
    );
    assert.equal(store.file(scope, "cancelled"), null);
    await assert.rejects(
      store.put(
        scope,
        { id: "committed", name: "c.txt", mediaType: "text/plain" },
        text("yes"),
        "upload",
        {
          onCommitted(file) {
            witnessed = file;
            throw Error("after irreversible publication");
          },
        },
      ),
      /irreversible publication/,
    );
    assert.ok(witnessed);
    assert.throws(() => store.file(scope, "committed"), code("CORRUPT"));
    store.close();
    const reopened = await FileStore.open({ directory });
    assert.deepEqual(reopened.file(scope, "committed"), witnessed);
    assert.equal(reopened.file(scope, "cancelled"), null);
    reopened.close();
  }));
