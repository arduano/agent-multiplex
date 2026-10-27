import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileHost, type FileHostOptions } from "../src/host/index.js";
import { FileError, type FileManifest, type FileScope } from "../src/contracts/types.js";

const a: FileScope = { connection: "connection", principal: "person", host: "host", session: "a" };
const b: FileScope = { ...a, session: "b" };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const manifest = (id: string, text: string): FileManifest => ({ id, name: `${id}.bin`, mediaType: "application/octet-stream", bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) });
const code = (expected: string) => (error: unknown): boolean => error instanceof FileError && error.code === expected;
async function fixture(options: Partial<FileHostOptions> = {}): Promise<{ host: FileHost; directory: string; cwd: string; root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(process.env.V8_FILES_TMPDIR ?? tmpdir(), "v8-files-host-")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const directory = join(root, "private");
  const host = await FileHost.open({ directory, bindings: [{ scope: a, cwd, dialect: "posix" }, { scope: b, cwd, dialect: "posix" }], ...options });
  return { host, directory, cwd, root, async cleanup() { await host.close(); await rm(root, { recursive: true, force: true }); } };
}
async function put(host: FileHost, id: string, text: string, scope = a): Promise<void> {
  await host.call("begin", { scope, manifest: manifest(id, text) });
  await host.call("write", { scope, id, offset: 0, data: Buffer.from(text) });
  await host.call("commit", { scope, id });
}

test("private archive seal requires actual lease/consumer release and preserves uncertain operation bytes", async () => {
  const f = await fixture();
  try {
    await put(f.host, "retained", "original bytes");
    const acquired = await f.host.call("acquire", { scope: a, id: "retained" });
    assert.equal((await f.host.archiveStatus(a)).activeReads, 1); await assert.rejects(f.host.seal(a), code("BUSY"));
    await f.host.call("release", { scope: a, leaseId: acquired.leaseId });
    await f.host.call("protect", { scope: a, operationId: "unknown-send", artifactIds: ["retained"], consumers: ["native"] });
    await assert.rejects(f.host.seal(a), code("BUSY"));
    await f.host.call("releaseConsumer", { scope: a, operationId: "unknown-send", consumer: "native" }); await f.host.seal(a);
    assert.equal((await f.host.protectedOperations(a)).operations[0]!.settled, false);
    assert.equal((await f.host.call("status", { scope: a, id: "retained" })).state, "committed");
    await assert.rejects(f.host.call("acquire", { scope: a, id: "retained" }), code("FENCED"));
    await assert.rejects(f.host.call("collect", { scope: a, requiredBytes: 1 }), code("FENCED"));
    await put(f.host, "other-session", "still open", b);
  } finally { await f.cleanup(); }
});

test("Host exact transfer identity, chunk replay, binary integrity and scope fences", async () => {
  const f = await fixture();
  try {
    const m = manifest("original", "hello\0world");
    assert.equal((await f.host.call("begin", { scope: a, manifest: m })).state, "uploading");
    assert.equal((await f.host.call("begin", { scope: a, manifest: m })).state, "uploading");
    await assert.rejects(f.host.call("begin", { scope: a, manifest: { ...m, name: "changed" } }), code("CONFLICT"));
    await f.host.call("write", { scope: a, id: m.id, offset: 0, data: Buffer.from("hello") });
    await f.host.call("write", { scope: a, id: m.id, offset: 0, data: Buffer.from("hello") });
    await assert.rejects(f.host.call("write", { scope: a, id: m.id, offset: 0, data: Buffer.from("jello") }), code("CONFLICT"));
    await assert.rejects(f.host.call("write", { scope: a, id: m.id, offset: 4, data: Buffer.from("o\0") }), code("CONFLICT"));
    await assert.rejects(f.host.call("commit", { scope: a, id: m.id }), code("CONFLICT"));
    await f.host.call("write", { scope: a, id: m.id, offset: 5, data: Buffer.from("\0world") });
    const artifact = await f.host.call("commit", { scope: a, id: m.id });
    assert.deepEqual(artifact.owner, a);
    assert.deepEqual(await f.host.call("commit", { scope: a, id: m.id }), artifact);
    const lease = await f.host.call("acquire", { scope: a, id: m.id });
    assert.deepEqual(Buffer.from(await f.host.call("read", { scope: a, leaseId: lease.leaseId, offset: 0, length: m.bytes })), Buffer.from("hello\0world"));
    await assert.rejects(f.host.call("read", { scope: b, leaseId: lease.leaseId, offset: 0, length: 1 }), code("FENCED"));
    await assert.rejects(f.host.call("status", { scope: { ...a, principal: "other" }, id: m.id }), code("FENCED"));
    assert.deepEqual(await f.host.call("status", { scope: b, id: m.id }), { state: "missing" });
    await f.host.call("release", { scope: a, leaseId: lease.leaseId });
    await assert.rejects(f.host.call("abort", { scope: a, id: m.id }), code("CONFLICT"));
  } finally { await f.cleanup(); }
});

test("Host permits empty files and refuses bad digest or oversized manifests", async () => {
  const f = await fixture({ limits: { maxFileBytes: 8 } });
  try {
    await put(f.host, "empty", "");
    const acquired = await f.host.call("acquire", { scope: a, id: "empty" });
    assert.equal((await f.host.call("read", { scope: a, leaseId: acquired.leaseId, offset: 0, length: 0 })).length, 0);
    await f.host.call("release", { scope: a, leaseId: acquired.leaseId });
    await assert.rejects(f.host.call("begin", { scope: a, manifest: manifest("large", "123456789") }), code("INVALID"));
    await f.host.call("begin", { scope: a, manifest: manifest("bad", "good") });
    await f.host.call("write", { scope: a, id: "bad", offset: 0, data: Buffer.from("evil") });
    await assert.rejects(f.host.call("commit", { scope: a, id: "bad" }), code("CORRUPT"));
  } finally { await f.cleanup(); }
});

test("Host pressure waits for operation settlement AND every positive native release", async () => {
  const f = await fixture({ limits: { sessionBytes: 8, hostBytes: 16 } });
  try {
    await put(f.host, "input", "12345678");
    await f.host.call("protect", { scope: a, operationId: "send", artifactIds: ["input"], consumers: ["native"] });
    await f.host.call("protect", { scope: a, operationId: "send", artifactIds: ["input"], consumers: ["native"] });
    await assert.rejects(f.host.call("protect", { scope: a, operationId: "send", artifactIds: ["input"], consumers: [] }), code("CONFLICT"));
    await assert.rejects(f.host.call("begin", { scope: a, manifest: manifest("next", "12345678") }), code("STORAGE_FULL"));
    await f.host.call("settle", { scope: a, operationId: "send" });
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 8 })).expired, []);
    await assert.rejects(f.host.call("releaseConsumer", { scope: a, operationId: "send", consumer: "other" }), code("FENCED"));
    await f.host.call("releaseConsumer", { scope: a, operationId: "send", consumer: "native" });
    const gc = await f.host.call("collect", { scope: a, requiredBytes: 8 });
    assert.deepEqual(gc.expired, ["input"]); assert.equal(gc.reclaimedBytes, 8);
    assert.equal((await f.host.call("status", { scope: a, id: "input" })).state, "expired");
    await assert.rejects(f.host.call("acquire", { scope: a, id: "input" }), code("EXPIRED"));
    await assert.rejects(f.host.call("protect", { scope: a, operationId: "late", artifactIds: ["input"], consumers: [] }), code("EXPIRED"));
    await put(f.host, "next", "12345678");
  } finally { await f.cleanup(); }
});

test("Host read leases survive UI absence and block deletion until actual release", async () => {
  const f = await fixture({ limits: { sessionBytes: 8, hostBytes: 8, maxReads: 1 } });
  try {
    await put(f.host, "visible", "12345678"); await f.host.call("abandon", { scope: a, id: "visible" });
    const lease = await f.host.call("acquire", { scope: a, id: "visible" });
    assert.equal((await f.host.call("usage", { scope: a })).activeReads, 1);
    await assert.rejects(f.host.call("acquire", { scope: a, id: "visible" }), code("BUSY"));
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 8 })).expired, []);
    await f.host.call("release", { scope: a, leaseId: lease.leaseId });
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 8 })).expired, ["visible"]);
  } finally { await f.cleanup(); }
});

test("Host session pressure cannot evict another session; Host pressure can", async () => {
  const f = await fixture({ limits: { sessionBytes: 8, hostBytes: 12 } });
  try {
    await put(f.host, "b-old", "bbbbbbbb", b); await f.host.call("abandon", { scope: b, id: "b-old" });
    await put(f.host, "a-new", "aaaa", a);
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 8 })).expired, []);
    assert.equal((await f.host.call("status", { scope: b, id: "b-old" })).state, "committed");
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 4 })).expired, ["b-old"]);
  } finally { await f.cleanup(); }
});

test("Host staged reservations, positive-progress expiry, draft release and no committed age expiry", async () => {
  let now = 100;
  const f = await fixture({ now: () => now, limits: { stagingTtlMs: 10, sessionBytes: 16, hostBytes: 16 } });
  try {
    await f.host.call("begin", { scope: a, manifest: manifest("staged", "12345678") });
    assert.equal((await f.host.call("usage", { scope: a })).reservedBytes, 8);
    now = 105; await f.host.call("write", { scope: a, id: "staged", offset: 0, data: Buffer.from("1234") });
    now = 112; await f.host.call("status", { scope: a, id: "staged" });
    assert.deepEqual((await f.host.call("sweep", { scope: a })).expired, []);
    now = 115;
    assert.deepEqual((await f.host.call("sweep", { scope: a })).expired, ["staged"]);
    assert.equal((await f.host.call("usage", { scope: a })).hostBytes, 0);
    assert.equal((await f.host.call("begin", { scope: a, manifest: manifest("staged", "12345678") })).state, "expired");
    await put(f.host, "old", "12345678"); now += 10000;
    assert.deepEqual((await f.host.call("sweep", { scope: a })).expired, []);
    assert.equal((await f.host.call("status", { scope: a, id: "old" })).state, "committed");
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 16 })).expired, ["old"]);
  } finally { await f.cleanup(); }
});

test("Host historical capture never rebinds; Open current requires a new stable source key", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "literal%23#?.txt"), "first");
    const old = await f.host.call("capture", { scope: a, sourceKey: "message/1/file", path: "literal%23#?.txt" });
    await writeFile(join(f.cwd, "literal%23#?.txt"), "later");
    assert.deepEqual(await f.host.call("capture", { scope: a, sourceKey: "message/1/file", path: "literal%23#?.txt", current: true }), old);
    const current = await f.host.call("capture", { scope: a, sourceKey: "explicit-current-1", path: "literal%23#?.txt", current: true });
    assert.notEqual(old.id, current.id); assert.notEqual(old.sha256, current.sha256);
    await assert.rejects(f.host.call("capture", { scope: a, sourceKey: "message/1/file", path: "other.txt" }), code("CONFLICT"));
    const lease = await f.host.call("acquire", { scope: a, id: old.id });
    assert.equal(Buffer.from(await f.host.call("read", { scope: a, leaseId: lease.leaseId, offset: 0, length: 5 })).toString(), "first");
    await f.host.call("release", { scope: a, leaseId: lease.leaseId });
  } finally { await f.cleanup(); }
});

test("Host preview path policy excludes private files and symlink escapes; broad access is explicit", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside.txt"); await writeFile(outside, "secret");
    execFileSync("mkfifo", [join(f.cwd, "pipe")]);
    await assert.rejects(f.host.call("capture", { scope: a, sourceKey: "special", path: "pipe" }), code("FENCED"));
    await symlink(outside, join(f.cwd, "escape.txt"));
    await assert.rejects(f.host.call("capture", { scope: a, sourceKey: "escape", path: "escape.txt" }), code("FENCED"));
    await assert.rejects(f.host.call("capture", { scope: a, sourceKey: "private", path: join(f.directory, "files.sqlite") }), code("FENCED"));
    await assert.rejects(f.host.call("capture", { scope: a, sourceKey: "external", path: "https://example.invalid/image.png" }), code("FENCED"));
    await f.host.close();
    const broad = await FileHost.open({ directory: f.directory, bindings: [{ scope: a, cwd: f.cwd, dialect: "posix" }], broadPaths: true });
    try {
      assert.equal((await broad.call("capture", { scope: a, sourceKey: "outside-explicit", path: outside })).bytes, 6);
      await assert.rejects(broad.call("capture", { scope: a, sourceKey: "private2", path: join(f.directory, "files.sqlite") }), code("FENCED"));
    } finally { await broad.close(); }
  } finally { await f.cleanup(); }
});

test("Host checksum verification occurs before any range and detects changed leased bytes", async () => {
  const f = await fixture();
  try {
    await put(f.host, "original", "12345678");
    const object = join(f.directory, "objects", (await readdir(join(f.directory, "objects")))[0]!);
    const lease = await f.host.call("acquire", { scope: a, id: "original" });
    await writeFile(object, "abcdefgh");
    await assert.rejects(f.host.call("read", { scope: a, leaseId: lease.leaseId, offset: 0, length: 1 }), code("CORRUPT"));
    await f.host.call("release", { scope: a, leaseId: lease.leaseId });
    await assert.rejects(f.host.call("acquire", { scope: a, id: "original" }), code("CORRUPT"));
  } finally { await f.cleanup(); }
});

test("Host failed unlink keeps trash charged, preserves expiry, and resumes owned cleanup", async () => {
  const f = await fixture({ qualification: { failUnlink: true }, limits: { sessionBytes: 8, hostBytes: 8 } });
  try {
    await put(f.host, "old", "12345678"); await f.host.call("abandon", { scope: a, id: "old" });
    const result = await f.host.call("collect", { scope: a, requiredBytes: 8 });
    assert.deepEqual(result.expired, ["old"]); assert.equal(result.reclaimedBytes, 0);
    assert.equal((await f.host.call("usage", { scope: a })).trashBytes, 8);
    await assert.rejects(f.host.call("begin", { scope: a, manifest: manifest("new", "12345678") }), code("STORAGE_FULL"));
    await f.host.close();
    const reopened = await FileHost.open({ directory: f.directory, bindings: [{ scope: a, cwd: f.cwd, dialect: "posix" }], limits: { sessionBytes: 8, hostBytes: 8 } });
    try { assert.equal((await reopened.call("sweep", { scope: a })).reclaimedBytes, 8); assert.equal((await reopened.call("status", { scope: a, id: "old" })).state, "expired"); }
    finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});

test("Host entries and metadata refuse new identities without deleting useful bytes", async () => {
  const f = await fixture({ limits: { sessionEntries: 2, hostEntries: 3 } });
  try {
    await put(f.host, "one", "1"); await put(f.host, "two", "2");
    await f.host.call("abandon", { scope: a, id: "one" });
    await assert.rejects(f.host.call("begin", { scope: a, manifest: manifest("three", "3") }), code("STORAGE_FULL"));
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 0, requiredEntries: 1 })).expired, []);
    assert.equal((await f.host.call("status", { scope: a, id: "one" })).state, "committed");
  } finally { await f.cleanup(); }
  const metadata = await fixture({ limits: { sessionMetadataBytes: 4200 } });
  try { await assert.rejects(metadata.host.call("begin", { scope: a, manifest: manifest("no-room", "1") }), code("STORAGE_FULL")); }
  finally { await metadata.cleanup(); }
});

test("Host unknown private files are charged and never removed by reconciliation or GC", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "objects", "unknown"); await writeFile(path, "owned-by-someone-else");
    const usage = await f.host.call("usage", { scope: a }); assert.equal(usage.hostBytes, Buffer.byteLength("owned-by-someone-else"));
    await f.host.call("collect", { scope: a, requiredBytes: 0 }); await f.host.call("sweep", { scope: a });
    assert.equal((await readFile(path)).toString(), "owned-by-someone-else");
  } finally { await f.cleanup(); }
});

test("Host hardened writer refuses simultaneous ownership and physical budget exhaustion", async () => {
  const f = await fixture();
  try {
    await assert.rejects(FileHost.open({ directory: f.directory, bindings: [{ scope: a, cwd: f.cwd, dialect: "posix" }] }), code("IO"));
    const usage = await f.host.call("usage", { scope: a }); assert.ok(usage.dbBytes > 0); assert.equal(usage.walBytes, 0);
  } finally { await f.cleanup(); }
  const limited = await fixture({ limits: { databaseBytes: 96 * 1024 } });
  try { await assert.rejects(limited.host.call("begin", { scope: a, manifest: manifest("db-full", "1") }), code("STORAGE_FULL")); }
  finally { await limited.cleanup(); }
});

test("Host normal publication failure completes the original commit and capture without restart", async () => {
  const f = await fixture({ qualification: { failPublishOnce: true } });
  try {
    await f.host.call("begin", { scope: a, manifest: manifest("original", "1234") });
    await f.host.call("write", { scope: a, id: "original", offset: 0, data: Buffer.from("1234") });
    await assert.rejects(f.host.call("commit", { scope: a, id: "original" }), code("IO"));
    const reconciled = await f.host.call("status", { scope: a, id: "original" });
    assert.equal(reconciled.state, "committed");
    assert.equal((await f.host.call("commit", { scope: a, id: "original" })).sha256, manifest("original", "1234").sha256);
  } finally { await f.cleanup(); }
  const capture = await fixture({ qualification: { failPublishOnce: true } });
  try {
    await writeFile(join(capture.cwd, "source.txt"), "original");
    await assert.rejects(capture.host.call("capture", { scope: a, sourceKey: "item/file", path: "source.txt" }), code("IO"));
    await writeFile(join(capture.cwd, "source.txt"), "changed");
    assert.equal((await capture.host.call("capture", { scope: a, sourceKey: "item/file", path: "source.txt" })).sha256, sha(Buffer.from("original")));
    assert.equal((await capture.host.call("usage", { scope: a })).entries, 2);
  } finally { await capture.cleanup(); }
});

test("Host release-before-settlement remains protected and metadata release state never grows", async () => {
  const f = await fixture({ limits: { sessionBytes: 4, hostBytes: 4 } });
  try {
    await put(f.host, "input", "1234");
    const consumers = Array.from({ length: 64 }, (_, index) => `consumer-${index}-${"x".repeat(180)}`);
    await f.host.call("protect", { scope: a, operationId: "send", artifactIds: ["input"], consumers });
    const metadata = (await f.host.call("usage", { scope: a })).metadataBytes;
    for (const consumer of consumers) await f.host.call("releaseConsumer", { scope: a, operationId: "send", consumer });
    assert.equal((await f.host.call("usage", { scope: a })).metadataBytes, metadata);
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 4 })).expired, []);
    await f.host.call("settle", { scope: a, operationId: "send" });
    assert.deepEqual((await f.host.call("collect", { scope: a, requiredBytes: 4 })).expired, ["input"]);
  } finally { await f.cleanup(); }
});

test("Host reserves WAL capacity before multi-artifact protection and refuses failed checkpoints", async () => {
  const f = await fixture({ limits: { walBytes: 1024 * 1024 } });
  try {
    for (const id of ["one", "two"]) await put(f.host, id, "1");
    await assert.rejects(f.host.call("protect", { scope: a, operationId: "send", artifactIds: ["one", "two"], consumers: [] }), code("STORAGE_FULL"));
    assert.ok((await f.host.call("usage", { scope: a })).walBytes <= 1024 * 1024);
  } finally { await f.cleanup(); }
  const root = await mkdtemp(join(process.env.V8_FILES_TMPDIR ?? tmpdir(), "v8-files-checkpoint-"));
  try { await assert.rejects(FileHost.open({ directory: join(root, "private"), bindings: [{ scope: a, cwd: root, dialect: "posix" }], qualification: { failCheckpoint: true } }), code("STORAGE_FULL")); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("Host replacement inode has no deletion authority even at a registered object pathname", async () => {
  const f = await fixture({ limits: { sessionBytes: 8, hostBytes: 8 } });
  try {
    await put(f.host, "original", "12345678"); await f.host.call("abandon", { scope: a, id: "original" });
    const object = join(f.directory, "objects", (await readdir(join(f.directory, "objects")))[0]!);
    await rename(object, `${object}.unknown`); await writeFile(object, "replaced");
    await assert.rejects(f.host.call("acquire", { scope: a, id: "original" }), code("CORRUPT"));
    const pressure = await f.host.call("collect", { scope: a, requiredBytes: 8 });
    assert.deepEqual(pressure.expired, ["original"]); assert.equal(pressure.reclaimedBytes, 0);
    assert.equal((await readFile(object)).toString(), "replaced");
    assert.equal((await readFile(`${object}.unknown`)).toString(), "12345678");
    const usage = await f.host.call("usage", { scope: a }); assert.equal(usage.hostBytes, 16); assert.equal(usage.trashBytes, 8);
  } finally { await f.cleanup(); }
});

test("Host FULL WAL commits accumulate within budget; failed threshold checkpoint preserves the original acknowledged offset", async () => {
  const walLimit = 600 * 1024;
  const f = await fixture({ qualification: { failCheckpointOnceAtThreshold: true }, limits: { walBytes: walLimit } });
  try {
    const data = new Uint8Array(20 * 65536); for (let index = 0; index < data.length; index++) data[index] = index % 251;
    const m: FileManifest = { id: "threshold-original", name: "threshold.bin", mediaType: "application/octet-stream", bytes: data.length, sha256: sha(data) };
    await f.host.call("begin", { scope: a, manifest: m });
    let previousWal = (await f.host.call("usage", { scope: a })).walBytes;
    let failures = 0, decreases = 0, uncheckpointed = 0;
    for (let offset = 0; offset < data.length;) {
      try {
        const status = await f.host.call("write", { scope: a, id: m.id, offset, data: data.subarray(offset, offset + 65536) });
        assert.equal(status.state, "uploading");
        if (status.state !== "uploading") throw new Error("Wrong upload state");
        offset = status.offset;
      } catch (error) {
        assert.ok(code("STORAGE_FULL")(error)); assert.equal(++failures, 1);
        const status = await f.host.call("status", { scope: a, id: m.id });
        assert.equal(status.state, "uploading"); if (status.state === "uploading") assert.equal(status.offset, offset);
      }
      const usage = await f.host.call("usage", { scope: a });
      assert.ok(usage.walBytes <= walLimit);
      if (usage.walBytes > 0) uncheckpointed++;
      if (usage.walBytes < previousWal) decreases++;
      previousWal = usage.walBytes;
    }
    assert.equal(failures, 1); assert.ok(uncheckpointed > 1); assert.ok(decreases > 0);
    const artifact = await f.host.call("commit", { scope: a, id: m.id }); assert.equal(artifact.sha256, m.sha256);
    const lease = await f.host.call("acquire", { scope: a, id: m.id });
    const observed = new Uint8Array(data.length);
    for (let offset = 0; offset < data.length; offset += 65536) observed.set(await f.host.call("read", { scope: a, leaseId: lease.leaseId, offset, length: 65536 }), offset);
    assert.equal(sha(observed), m.sha256);
    await f.host.call("release", { scope: a, leaseId: lease.leaseId });
  } finally { await f.cleanup(); }
});

test('Host new staging admission expires stale uploads across scopes in one bounded pass',async()=>{
 let now=100;const f=await fixture({now:()=>now,limits:{maxUploads:3,stagingBytes:24,stagingTtlMs:10,cleanupBatch:1,hostBytes:64,sessionBytes:64}});
 try{
  for(const id of ['old-1','old-2','old-3'])await f.host.call('begin',{scope:a,manifest:manifest(id,'12345678')});
  await f.host.call('write',{scope:a,id:'old-1',offset:0,data:Buffer.from('1234')});
  now=109;await assert.rejects(f.host.call('begin',{scope:b,manifest:manifest('new','1234567890123456')}),code('STORAGE_FULL'));assert.equal((await f.host.call('status',{scope:a,id:'old-1'})).state,'uploading');
  now=110;await assert.rejects(f.host.call('begin',{scope:b,manifest:manifest('new','1234567890123456')}),code('STORAGE_FULL'));
  assert.equal((await f.host.call('status',{scope:a,id:'old-1'})).state,'expired');assert.equal((await f.host.call('status',{scope:a,id:'old-2'})).state,'uploading');assert.equal((await f.host.call('usage',{scope:a})).stagingBytes,0);
  assert.equal((await f.host.call('begin',{scope:b,manifest:manifest('new','1234567890123456')})).state,'uploading');assert.equal((await f.host.call('status',{scope:a,id:'old-2'})).state,'expired');assert.equal((await f.host.call('status',{scope:a,id:'old-3'})).state,'uploading');
  assert.equal((await f.host.call('begin',{scope:a,manifest:manifest('old-1','12345678')})).state,'expired');
 }finally{await f.cleanup();}
});

test('Host global staging expiry preserves failed-unlink charges and terminal identity',async()=>{
 let now=100;const f=await fixture({now:()=>now,qualification:{failUnlink:true},limits:{maxUploads:1,stagingBytes:8,stagingTtlMs:10,hostBytes:8,sessionBytes:8}});
 try{
  await f.host.call('begin',{scope:a,manifest:manifest('abandoned','12345678')});await f.host.call('write',{scope:a,id:'abandoned',offset:0,data:Buffer.from('12345678')});now=110;
  await assert.rejects(f.host.call('begin',{scope:b,manifest:manifest('next','12345678')}),code('STORAGE_FULL'));assert.equal((await f.host.call('status',{scope:a,id:'abandoned'})).state,'expired');assert.equal((await f.host.call('usage',{scope:a})).trashBytes,8);assert.equal((await f.host.call('begin',{scope:a,manifest:manifest('abandoned','12345678')})).state,'expired');
 }finally{await f.cleanup();}
});
