import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileHost, type FileHostOptions } from "../src/host/index.js";
import { FileError, type FileManifest, type FileScope } from "../src/contracts/types.js";

const scope: FileScope = { connection: "connection", principal: "owner", host: "host", session: "session" };
const data = Buffer.from("original exact bytes");
const manifest: FileManifest = { id: "original", name: "original.bin", mediaType: "application/octet-stream", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
const code = (expected: string) => (error: unknown): boolean => error instanceof FileError && error.code === expected;
async function fixture() {
  const root = await mkdtemp(join(process.env.V8_FILES_TMPDIR ?? tmpdir(), "v8-files-crash-")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const options: FileHostOptions = { directory: join(root, "private"), bindings: [{ scope, cwd, dialect: "posix" }] };
  return { root, cwd, options, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}
for (const phase of ["reserved", "flushed", "acknowledged", "publishing", "renamed", "published"] as const) {
  test(`Host process kill/reopen at ${phase} reconciles original upload identity`, async () => {
    const f = await fixture(); let host: FileHost | undefined;
    try {
      host = await FileHost.open({ ...f.options, qualification: { crashAt: phase } });
      if (phase === "reserved") await assert.rejects(host.call("begin", { scope, manifest }), code("CLOSED"));
      else {
        await host.call("begin", { scope, manifest });
        if (phase === "flushed" || phase === "acknowledged") await assert.rejects(host.call("write", { scope, id: manifest.id, offset: 0, data }), code("CLOSED"));
        else { await host.call("write", { scope, id: manifest.id, offset: 0, data }); await assert.rejects(host.call("commit", { scope, id: manifest.id }), code("CLOSED")); }
      }
      await host.terminate(); host = await FileHost.open(f.options);
      const status = await host.call("status", { scope, id: manifest.id });
      if (phase === "reserved" || phase === "flushed" || phase === "acknowledged") {
        assert.equal(status.state, "uploading");
        if (status.state !== "uploading") throw new Error("Wrong recovered state");
        assert.equal(status.offset, phase === "acknowledged" ? data.length : 0);
        await host.call("write", { scope, id: manifest.id, offset: 0, data });
        await host.call("commit", { scope, id: manifest.id });
      } else assert.equal(status.state, "committed");
      const lease = await host.call("acquire", { scope, id: manifest.id });
      assert.deepEqual(Buffer.from(await host.call("read", { scope, leaseId: lease.leaseId, offset: 0, length: data.length })), data);
      await host.call("release", { scope, leaseId: lease.leaseId });
      assert.equal((await host.call("usage", { scope })).hostBytes, data.length);
      assert.equal((await host.call("begin", { scope, manifest })).state, "committed");
    } finally { await host?.close(); await f.cleanup(); }
  });
}

test("Host persists expired identity before unlink and positively owned cleanup resumes after kill", async () => {
  const f = await fixture(); let host: FileHost | undefined;
  try {
    host = await FileHost.open({ ...f.options, limits: { sessionBytes: data.length, hostBytes: data.length }, qualification: { crashAt: "expired" } });
    await host.call("begin", { scope, manifest }); await host.call("write", { scope, id: manifest.id, offset: 0, data }); await host.call("commit", { scope, id: manifest.id });
    await host.call("abandon", { scope, id: manifest.id });
    await assert.rejects(host.call("collect", { scope, requiredBytes: data.length }), code("CLOSED"));
    await host.terminate(); host = await FileHost.open(f.options);
    assert.equal((await host.call("status", { scope, id: manifest.id })).state, "expired");
    assert.equal((await host.call("usage", { scope })).trashBytes, data.length);
    await assert.rejects(host.call("acquire", { scope, id: manifest.id }), code("EXPIRED"));
    assert.equal((await host.call("sweep", { scope })).reclaimedBytes, data.length);
    assert.equal((await host.call("usage", { scope })).hostBytes, 0);
  } finally { await host?.close(); await f.cleanup(); }
});

test("Host request and native holds survive termination independently and prevent replay admission", async () => {
  const f = await fixture(); let host: FileHost | undefined;
  try {
    host = await FileHost.open(f.options);
    await host.call("begin", { scope, manifest }); await host.call("write", { scope, id: manifest.id, offset: 0, data }); await host.call("commit", { scope, id: manifest.id });
    await host.call("protect", { scope, operationId: "send", artifactIds: [manifest.id], consumers: ["native"] });
    await host.terminate(); host = await FileHost.open({ ...f.options, limits: { sessionBytes: data.length, hostBytes: data.length } });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: data.length })).expired, []);
    await host.call("settle", { scope, operationId: "send" });
    await host.terminate(); host = await FileHost.open({ ...f.options, limits: { sessionBytes: data.length, hostBytes: data.length } });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: data.length })).expired, []);
    await host.call("releaseConsumer", { scope, operationId: "send", consumer: "native" });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: data.length })).expired, [manifest.id]);
    // Replaying the exact original protection cannot resurrect it or recreate work.
    await host.call("protect", { scope, operationId: "send", artifactIds: [manifest.id], consumers: ["native"] });
    assert.equal((await host.call("status", { scope, id: manifest.id })).state, "expired");
  } finally { await host?.close(); await f.cleanup(); }
});

test("Host capture lost publication reply keeps its original source identity after disk changes", async () => {
  const f = await fixture(); let host: FileHost | undefined;
  try {
    await writeFile(join(f.cwd, "source.txt"), data);
    host = await FileHost.open({ ...f.options, qualification: { crashAt: "published" } });
    await assert.rejects(host.call("capture", { scope, sourceKey: "message/item/file", path: "source.txt" }), code("CLOSED"));
    await host.terminate(); await writeFile(join(f.cwd, "source.txt"), "changed disk bytes");
    host = await FileHost.open(f.options);
    const artifact = await host.call("capture", { scope, sourceKey: "message/item/file", path: "source.txt" });
    assert.equal(artifact.sha256, manifest.sha256);
    assert.equal((await host.call("usage", { scope })).entries, 2);
  } finally { await host?.close(); await f.cleanup(); }
});

test("Host interrupted capture refuses changed source instead of rebinding its reserved identity", async () => {
  const f = await fixture(); let host: FileHost | undefined;
  try {
    await writeFile(join(f.cwd, "source.txt"), data);
    host = await FileHost.open({ ...f.options, qualification: { crashAt: "flushed" } });
    await assert.rejects(host.call("capture", { scope, sourceKey: "message/item/file", path: "source.txt" }), code("CLOSED"));
    await host.terminate(); await writeFile(join(f.cwd, "source.txt"), "changed disk bytes");
    host = await FileHost.open(f.options);
    await assert.rejects(host.call("capture", { scope, sourceKey: "message/item/file", path: "source.txt" }), code("CORRUPT"));
    assert.equal((await host.call("usage", { scope })).entries, 2);
  } finally { await host?.close(); await f.cleanup(); }
});

test("Host unclean child SIGKILL recovers FULL uncheckpointed ACKs and independent request/native holds", { timeout: 120_000 }, async () => {
  const f = await fixture(); let host: FileHost | undefined;
  const child = fork(new URL("./crash-child.js", import.meta.url), [f.root], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" } });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const acknowledged = await new Promise<{ offset: number; walBytes: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Disposable child did not acknowledge its finite setup")), 90_000);
      child.once("message", value => {
        clearTimeout(timer);
        const message = value as { kind?: unknown; offset: number; walBytes: number };
        if (message.kind !== "acknowledged") reject(new Error("Unexpected crash child message")); else resolve(message);
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Disposable child exited before its acknowledgement")); });
    });
    assert.equal(acknowledged.offset, data.length); assert.ok(acknowledged.walBytes > 0);
    assert.equal(child.kill("SIGKILL"), true);
    assert.equal((await exited).signal, "SIGKILL");
    assert.ok((await stat(join(f.options.directory, "files.sqlite-wal"))).size > 0);
    host = await FileHost.open({ ...f.options, limits: { sessionBytes: data.length * 2, hostBytes: data.length * 2 } });
    const recovered = await host.call("status", { scope, id: manifest.id });
    assert.equal(recovered.state, "uploading"); if (recovered.state === "uploading") assert.equal(recovered.offset, data.length);
    // Discard the staged reservation explicitly to isolate the committed artifact's two holds.
    await host.call("abort", { scope, id: manifest.id });
    const lease = await host.call("acquire", { scope, id: "held" });
    assert.deepEqual(Buffer.from(await host.call("read", { scope, leaseId: lease.leaseId, offset: 0, length: data.length })), data);
    await host.call("release", { scope, leaseId: lease.leaseId });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: data.length * 2 })).expired, []);
    await host.call("settle", { scope, operationId: "unclean-send" });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: data.length * 2 })).expired, []);
    await host.call("releaseConsumer", { scope, operationId: "unclean-send", consumer: "native" });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: data.length * 2 })).expired, ["held"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited; await host?.close(); await f.cleanup();
  }
});
