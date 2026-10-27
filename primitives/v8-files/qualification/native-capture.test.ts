import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeFileCapture, type NativeCapturePort, type NativeOccurrence } from "../src/native/capture.js";
import { FileHost } from "../src/host/index.js";
import type { FileInputs, FileManifest, FileMethod, FileOutputs, FilePort, FileScope } from "../src/contracts/types.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { createCopilotCodec } from "../../v8-history/src/native/copilot/index.js";
import { rowMedia, type NativeMediaOccurrence } from "../../v8-history/src/contracts/media.js";
import type { CopilotScope } from "../../v8-history/src/contracts/types.js";

const scope: FileScope = { connection: "test", principal: "owner", host: "host", session: "session" };
const nativeScope: CopilotScope = { kind: "copilot", origin: { connection: "test", principal: "owner", host: "host", nativeSession: "session", attachment: "epoch" }, agentId: null };
const bytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const occurrence = (id: string): NativeMediaOccurrence => ({ id, kind: "image", source: "inline", state: "pending", mediaType: "image/png", bytes: bytes.length, sha256 });
async function fixture(): Promise<{ host: FileHost; cwd: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(process.env.V8_FILES_TMPDIR ?? tmpdir(), "v8-native-capture-")), cwd = join(root, "workspace"); await mkdir(cwd);
  const host = await FileHost.open({ directory: join(root, "private"), bindings: [{ scope, cwd, dialect: "posix" }], limits: { sessionBytes: bytes.length * 2 } });
  return { host, cwd, async cleanup() { await host.close(); await rm(root, { recursive: true, force: true }); } };
}
class Port implements NativeCapturePort {
  readonly calls: { method: FileMethod; id?: string }[] = [];
  readonly lose = new Set<FileMethod>();
  gate: Promise<void> | undefined;
  constructor(readonly host: FileHost) {}
  async native<M extends "begin" | "capture">(method: M, input: FileInputs[M], occurrence: NativeOccurrence): Promise<FileOutputs[M]> {
    const item = input as { manifest?: { id: string } };
    this.calls.push({ method, ...(item.manifest ? { id: item.manifest.id } : {}) });
    if (method === "begin" && this.gate) await this.gate;
    const result = await this.host.native(method, input, occurrence);
    if (this.lose.delete(method)) throw new Error("Lost original file reply");
    return result;
  }
  async call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
    const item = input as { id?: string; manifest?: { id: string } };
    this.calls.push({ method, ...(item.id || item.manifest?.id ? { id: item.id ?? item.manifest!.id } : {}) });
    if (method === "begin" && this.gate) await this.gate;
    const result = await this.host.call(method, input);
    if (this.lose.delete(method)) throw new Error("Lost original file reply");
    return result;
  }
}

test("native capture composes real codec and Host without blocking text, and releases only its own output draft hold", async () => {
  const f = await fixture();
  try {
    const original = { id: "user-original", name: "original.png", mediaType: "image/png", bytes: bytes.length, sha256 };
    await f.host.call("begin", { scope, manifest: original }); await f.host.call("write", { scope, id: original.id, offset: 0, data: bytes }); await f.host.call("commit", { scope, id: original.id });
    const port = new Port(f.host), capture = new NativeFileCapture({ port, mapScope: () => scope }), hub = new HistoryHub();
    const codec = createCopilotCodec({ origin: nativeScope.origin, capture: hub, media: capture.handler });
    const event = { type: "user.message", id: "event", data: { messageId: "message", content: "visible before disk", attachments: [{ type: "blob", mimeType: "image/png", data: Buffer.from(bytes).toString("base64") }] } };
    codec.observe(event); const row = hub.snapshot(nativeScope).rows[0]!, media = rowMedia(row)[0]!;
    assert.equal(row.body.kind, "complete"); assert.equal(port.calls.length, 0); assert.equal(media.state, "pending");
    codec.observe(event); assert.equal(capture.diagnostics().pending, 1);
    await capture.drain(); assert.equal(capture.lookup(nativeScope, media.id).state, "available");
    const artifact = capture.artifact(nativeScope, media.id)!; assert.notEqual(artifact.id, original.id);
    const lease = await f.host.call("acquire", { scope, id: artifact.id });
    assert.deepEqual(Buffer.from(await f.host.call("read", { scope, leaseId: lease.leaseId, offset: 0, length: bytes.length })), Buffer.from(bytes));
    await f.host.call("release", { scope, leaseId: lease.leaseId });
    const cleanup = await f.host.call("collect", { scope, requiredBytes: bytes.length }); assert.deepEqual(cleanup.expired, [artifact.id]);
    assert.equal((await f.host.call("status", { scope, id: original.id })).state, "committed");
    assert.ok(port.calls.filter(call => call.method === "abandon").every(call => call.id === artifact.id));
  } finally { await f.cleanup(); }
});

test("lost begin/chunk/commit/release replies reconcile one original native artifact without duplicate mutations", async () => {
  const f = await fixture();
  try {
    const port = new Port(f.host); for (const method of ["begin", "write", "commit", "abandon"] as const) port.lose.add(method);
    const capture = new NativeFileCapture({ port, mapScope: () => scope }); const media = occurrence("leaf");
    const first = capture.handler({ scope: nativeScope, occurrence: media, bytes }); assert.equal(first.state, "pending");
    assert.deepEqual(capture.handler({ scope: nativeScope, occurrence: media, bytes }), first);
    await capture.settle(); assert.equal(capture.lookup(nativeScope, media.id).state, "available");
    assert.equal(new Set(port.calls.filter(call => call.id).map(call => call.id)).size, 1);
    for (const method of ["begin", "write", "commit"]) assert.equal(port.calls.filter(call => call.method === method).length, 1);
    assert.equal(port.calls.filter(call => call.method === "abandon").length, 2);
    assert.deepEqual(capture.diagnostics(), { occurrences: 1, pending: 0, pendingBytes: 0, closed: false });
  } finally { await f.cleanup(); }
});

test("native capture bounds terminal truth and actual pending work through close without reading paths or assets", async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const port = new Port(f.host); port.gate = new Promise<void>(resolve => { release = resolve; });
    const capture = new NativeFileCapture({ port, mapScope: () => scope, maxPending: 1, maxOccurrences: 2 });
    capture.handler({ scope: nativeScope, occurrence: occurrence("one"), bytes });
    assert.equal(capture.handler({ scope: nativeScope, occurrence: occurrence("two"), bytes }).state, "unavailable");
    capture.close(); assert.equal(capture.handler({ scope: nativeScope, occurrence: occurrence("three"), bytes }).state, "unavailable");
    let drained = false; const settlement = capture.settle().then(() => { drained = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(drained, false); assert.equal(capture.diagnostics().pending, 1);
    release(); await settlement; assert.equal(capture.diagnostics().pending, 0); assert.equal(capture.diagnostics().occurrences, 2);
    const references = new NativeFileCapture({ port, mapScope: () => scope }); const before = port.calls.length;
    assert.equal(references.handler({ scope: nativeScope, occurrence: { id: "path", kind: "image", source: "disk", path: "/not-readable/image.png", state: "pending" } }).state, "unavailable");
    assert.equal(references.handler({ scope: nativeScope, occurrence: { id: "asset", kind: "image", source: "native", assetId: "opaque", absent: true, state: "unavailable" } }).state, "unavailable");
    await references.drain(); assert.equal(port.calls.length, before);
  } finally { release?.(); await f.cleanup(); }
});

test("native capture snapshots caller bytes and refuses changed occurrence identity without a replacement upload", async () => {
  const f = await fixture();
  try {
    const port = new Port(f.host), capture = new NativeFileCapture({ port, mapScope: () => scope }), mutable = new Uint8Array(bytes), media = occurrence("one");
    const pending = capture.handler({ scope: nativeScope, occurrence: media, bytes: mutable }); mutable.fill(0);
    assert.equal(capture.handler({ scope: nativeScope, occurrence: { ...media, sha256: "0".repeat(64) }, bytes }).state, "unavailable");
    await capture.drain(); assert.equal(capture.lookup(nativeScope, media.id).state, "available");
    assert.equal(capture.lookup(nativeScope, media.id).artifactId, pending.artifactId); assert.equal(port.calls.filter(call => call.method === "begin").length, 1);
    const other = { ...nativeScope, agentId: "child" }; assert.equal(capture.lookup(other, media.id).state, "unavailable");
  } finally { await f.cleanup(); }
});

test("reattachment preserves historical native artifact identity and cannot resurrect expired bytes", async () => {
  const f = await fixture();
  try {
    const firstPort = new Port(f.host), first = new NativeFileCapture({ port: firstPort, mapScope: () => scope }), media = occurrence("same-native-leaf");
    const original = first.handler({ scope: nativeScope, occurrence: media, bytes }); await first.drain();
    assert.equal(first.lookup(nativeScope, media.id).state, "available");
    const expired = await f.host.call("collect", { scope, requiredBytes: bytes.length * 2 });
    assert.deepEqual(expired.expired, [original.artifactId]); first.close();
    const reattachedScope: CopilotScope = { ...nativeScope, origin: { ...nativeScope.origin, attachment: "epoch-2" } };
    const secondPort = new Port(f.host), second = new NativeFileCapture({ port: secondPort, mapScope: () => scope });
    const pending = second.handler({ scope: reattachedScope, occurrence: media, bytes });
    assert.equal(pending.artifactId, original.artifactId); await second.drain();
    assert.equal(second.lookup(reattachedScope, media.id).state, "unavailable");
    assert.equal((await f.host.call("status", { scope, id: original.artifactId! })).state, "expired");
    assert.equal(secondPort.calls.filter(call => call.method === "begin").length, 1);
    assert.equal(secondPort.calls.filter(call => ["write", "commit", "abandon"].includes(call.method)).length, 0);
    assert.equal(second.artifact(reattachedScope, media.id), undefined);
  } finally { await f.cleanup(); }
});

test("native capture refuses partial atomic acknowledgements or repeated nonprogress within one finite episode", async () => {
  for (const offset of [0, 1]) {
    let manifest!: FileManifest, calls = 0;
    const port: NativeCapturePort = { native: (method, input) => port.call(method, input), async call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
      calls++;
      if (method === "begin") { manifest = (input as FileInputs["begin"]).manifest; return { state: "uploading", manifest, offset: 0 } as FileOutputs[M]; }
      if (method === "write") return { state: "uploading", manifest, offset } as FileOutputs[M];
      throw new Error("Unexpected subsequent acquisition");
    } };
    const capture = new NativeFileCapture({ port, mapScope: () => scope });
    capture.handler({ scope: nativeScope, occurrence: occurrence("one"), bytes }); await capture.drain();
    assert.equal(capture.lookup(nativeScope, "one").state, "unavailable"); assert.equal(capture.diagnostics().pending, 0);
    assert.ok(calls <= 3);
  }
});

test("settled native media rolls its bounded memo while the same ledger preserves conflicts, original artifacts and expiry across reopening", async () => {
  const f = await fixture(); let reopened: FileHost | undefined, lease: Awaited<ReturnType<FileHost["call"]>> | undefined;
  try {
    const port = new Port(f.host), capture = new NativeFileCapture({ port, mapScope: () => scope, maxOccurrences: 2 });
    const first = occurrence("first"); capture.handler({ scope: nativeScope, occurrence: first, bytes }); await capture.drain();
    const original = capture.artifact(nativeScope, first.id)!;
    const held = await f.host.call("acquire", { scope, id: original.id }); lease = held;
    for (let index = 0; index < 4; index++) {
      capture.handler({ scope: nativeScope, occurrence: occurrence(`later-${index}`), bytes }); await capture.drain();
      assert.equal(capture.lookup(nativeScope, `later-${index}`).state, "available"); assert.ok(capture.diagnostics().occurrences <= 2);
    }
    capture.handler({ scope: nativeScope, occurrence: first, bytes }); await capture.drain();
    assert.deepEqual(capture.artifact(nativeScope, first.id), original, "rolling the memo cannot change historical byte identity");
    for (const id of ["evict-a", "evict-b"]) { capture.handler({ scope: nativeScope, occurrence: occurrence(id), bytes }); await capture.drain(); }
    const changed = bytes.slice(); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    capture.handler({ scope: nativeScope, occurrence: { ...first, sha256: createHash("sha256").update(changed).digest("hex") }, bytes: changed }); await capture.drain();
    assert.equal(capture.lookup(nativeScope, first.id).state, "unavailable");
    assert.deepEqual(await f.host.call("read", { scope, leaseId: held.leaseId, offset: 0, length: bytes.length }), bytes);
    await f.host.call("release", { scope, leaseId: held.leaseId }); lease = undefined;
    await f.host.call("collect", { scope, requiredBytes: bytes.length * 2 }); assert.equal((await f.host.call("status", { scope, id: original.id })).state, "expired");
    capture.close(); await f.host.close();
    reopened = await FileHost.open({ directory: join(f.cwd, "..", "private"), bindings: [{ scope, cwd: f.cwd, dialect: "posix" }], limits: { sessionBytes: bytes.length * 2 } });
    const again = new NativeFileCapture({ port: reopened, mapScope: () => scope, maxOccurrences: 2 });
    again.handler({ scope: { ...nativeScope, origin: { ...nativeScope.origin, attachment: "replacement" } }, occurrence: first, bytes }); await again.drain();
    assert.equal(again.lookup({ ...nativeScope, origin: { ...nativeScope.origin, attachment: "replacement" } }, first.id).state, "unavailable");
    assert.equal((await reopened.call("status", { scope, id: original.id })).state, "expired", "reattachment never resurrects collected bytes");
    await assert.rejects(reopened.call("capture", { scope, sourceKey: `native-occurrence-${"0".repeat(64)}`, path: "note.txt" }), { code: "FENCED" });
    again.close();
  } finally {
    if (lease && "leaseId" in lease) await f.host.call("release", { scope, leaseId: lease.leaseId });
    await reopened?.close(); await f.cleanup();
  }
});

test("native output paths use one immutable confined FileHost capture across replay, reattachment and changed source bytes", async () => {
  const f = await fixture();
  try {
    const path = join(f.cwd, "output.png"); await writeFile(path, bytes);
    const port = new Port(f.host), capture = new NativeFileCapture({ port, mapScope: () => scope });
    const output: NativeMediaOccurrence = { id: "output-leaf", kind: "image", source: "disk", nativeType: "imageGeneration", path, state: "pending" };
    assert.equal(capture.handler({ scope: nativeScope, occurrence: output }).state, "pending");
    assert.equal(port.calls.length, 0, "history callback performs no disk operation");
    capture.handler({ scope: nativeScope, occurrence: output }); await capture.drain();
    const original = capture.artifact(nativeScope, output.id)!; assert.equal(original.sha256, sha256);
    assert.equal(port.calls.filter(value => value.method === "capture").length, 1);
    await writeFile(path, new Uint8Array(bytes.length)); capture.close();
    const second = new NativeFileCapture({ port, mapScope: () => scope }), scope2: CopilotScope = { ...nativeScope, origin: { ...nativeScope.origin, attachment: "replacement" } };
    second.handler({ scope: scope2, occurrence: output }); await second.drain();
    assert.deepEqual(second.artifact(scope2, output.id), original, "first snapshot is immutable after source changes");
    const lease = await f.host.call("acquire", { scope, id: original.id });
    try { assert.deepEqual(await f.host.call("read", { scope, leaseId: lease.leaseId, offset: 0, length: bytes.length }), bytes); }
    finally { await f.host.call("release", { scope, leaseId: lease.leaseId }); }
    const expired = await f.host.call("collect", { scope, requiredBytes: bytes.length * 2 }); assert.deepEqual(expired.expired, [original.id]);
    const third = new NativeFileCapture({ port, mapScope: () => scope }); third.handler({ scope: scope2, occurrence: output }); await third.drain();
    assert.equal(third.lookup(scope2, output.id).state, "unavailable", "native path replay cannot resurrect expired historical bytes");
    assert.equal(third.artifact(scope2, output.id), undefined);
  } finally { await f.cleanup(); }
});

test("native output disk capture retains actual held capacity through close and refuses an outside-root native path", async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const path = join(f.cwd, "output.png"); await writeFile(path, bytes);
    const entered = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    const port: NativeCapturePort = { async native(method, input, occurrence) { calls++; await entered; return f.host.native(method, input, occurrence); }, async call(method, input) { calls++; await entered; return f.host.call(method, input); } };
    const capture = new NativeFileCapture({ port, mapScope: () => scope, maxPending: 1, maxPendingBytes: 10 * 1024 * 1024 });
    const output: NativeMediaOccurrence = { id: "one", kind: "image", source: "disk", nativeType: "imageView", path, state: "pending" };
    capture.handler({ scope: nativeScope, occurrence: output }); await Promise.resolve();
    assert.equal(capture.handler({ scope: nativeScope, occurrence: { ...output, id: "second" } }).state, "unavailable");
    capture.close(); assert.equal(capture.diagnostics().pending, 1); assert.equal(capture.diagnostics().pendingBytes, 10 * 1024 * 1024);
    release(); await capture.drain(); assert.equal(calls, 1); assert.equal(capture.lookup(nativeScope, "one").state, "available"); assert.equal(capture.diagnostics().pendingBytes, 0);
    const refused = new NativeFileCapture({ port: f.host, mapScope: () => scope });
    refused.handler({ scope: nativeScope, occurrence: { ...output, id: "outside", path: "/etc/passwd" } }); await refused.drain();
    assert.equal(refused.lookup(nativeScope, "outside").state, "unavailable"); assert.equal(refused.artifact(nativeScope, "outside"), undefined);
  } finally { release?.(); await f.cleanup(); }
});
