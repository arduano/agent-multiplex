import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import type { CodexScope } from "../../v8-history/src/contracts/types.js";
import { FileWorkspace } from "../src/client/workspace.js";
import { MemoryDraftPersistence } from "../src/client/persistence.js";
import { ResourceCache } from "../src/client/resource-cache.js";
import { createHttpFilePort } from "../src/client/http-port.js";
import { FileError, type FileInputs, type FileMethod, type FileOutputs, type FilePort, type FileScope } from "../src/contracts/types.js";
import { ClientFixturePort } from "./client-fixture.js";
import { createFileHttpHandler } from "../src/transport/http.js";
import { digest } from "../src/contracts/content.js";
const scope: FileScope = { connection: "files-client", principal: "owner", host: "host", session: "a" };
const historyScope = (name = "a"): CodexScope => ({ kind: "codex", threadId: name, origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: name, attachment: "fixture" } });
const input = { name: "data.bin", mediaType: "text/html", blob: new Blob([new Uint8Array([0, 255, 17, 21])]) };
function fixture(port: FilePort = new ClientFixturePort(), persistence = new MemoryDraftPersistence()) {
  const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
  return { history, persistence, client: new FileWorkspace({ history, port, persistence, chunkBytes: 2 }) };
}
for (const lost of ["begin", "write", "commit"] as const) test(`client reconciles lost ${lost} reply with exact original upload ID and bytes`, async () => {
  const server = new ClientFixturePort(); let once = true;
  const port: FilePort = { async call<M extends FileMethod>(method: M, value: FileInputs[M]): Promise<FileOutputs[M]> { const result = await server.call(method, value); if (method === lost && once) { once = false; throw new FileError("IO", "Injected lost reply"); } return result; } };
  const { client, persistence } = fixture(port); await client.bind(scope, historyScope());
  const original = await client.saveDraft(scope, input); await client.recordRequest(scope, original.manifest.id, "original-send");
  await assert.rejects(client.upload(scope, original.manifest.id));
  assert.equal((await persistence.get(scope, original.manifest.id))!.phase, "uncertain");
  const artifact = await client.reconcile(scope, original.manifest.id);
  assert.equal(artifact.id, original.manifest.id); assert.equal(server.begins.size, 1);
  assert.deepEqual((await persistence.get(scope, artifact.id))!.operationIds, ["original-send"]);
  assert.equal(server.calls.includes("protect"), false);
});
test("file workspace uses retained HistoryWorkspace for A/B/A and pin while disconnected", async () => {
  const { client, history } = fixture(); const a = historyScope(), b = historyScope("b"); await client.bind(scope, a); await client.bind({ ...scope, session: "b" }, b);
  const draft = await client.saveDraft(scope, input); const first = history.select(a); client.setPinned(scope, true); history.select(b); first.release();
  client.setConnected(false); assert.equal(history.session(a).pinned, true);
  assert.equal(client.getSnapshot().records[0]!.manifest.id, draft.manifest.id);
  await assert.rejects(client.upload(scope, draft.manifest.id), { code: "BUSY" });
  client.setConnected(true); const artifact = await client.upload(scope, draft.manifest.id); history.select(a);
  assert.equal(artifact.id, draft.manifest.id); assert.equal(history.session(a).pinned, true);
});
test("binding rejects another session even on the same authenticated host", async () => {
  const { client } = fixture(); await assert.rejects(client.bind(scope, historyScope("b")), { code: "FENCED" });
  assert.equal(client.getSnapshot().records.length, 0);
});
test("browser persistence contract preserves stale edits as bounded conflict copies", async () => {
  const persistence = new MemoryDraftPersistence(100, 2), { client } = fixture(undefined, persistence); await client.bind(scope, historyScope());
  const first = await client.saveDraft(scope, input);
  const copy = await client.saveDraft(scope, { ...input, id: first.manifest.id }, 0);
  assert.equal(copy.conflictOf, first.manifest.id); assert.notEqual(copy.manifest.id, first.manifest.id);
  assert.equal((await persistence.get(scope, first.manifest.id))!.revision, 1);
  await assert.rejects(client.saveDraft(scope, input), { code: "STORAGE_FULL" });
});
test("replacement upload requires positive terminal status; new ID does not inherit Send references", async () => {
  const server = new ClientFixturePort(), { client } = fixture(server); await client.bind(scope, historyScope());
  const first = await client.saveDraft(scope, input); await assert.rejects(client.retryExpired(scope, first.manifest.id), { code: "CONFLICT" });
  await server.call("begin", { scope, manifest: first.manifest }); await server.call("abort", { scope, id: first.manifest.id });
  const next = await client.retryExpired(scope, first.manifest.id); assert.notEqual(next.manifest.id, first.manifest.id); assert.deepEqual(next.operationIds, []);
});
test("shared resources verify bytes, ignore spoofed MIME and hold actual blocked work through close/expiry", async () => {
  const server = new ClientFixturePort(), { client } = fixture(server); await client.bind(scope, historyScope()); const draft = await client.saveDraft(scope, input); const artifact = await client.upload(scope, draft.manifest.id);
  let finish!: () => void; server.blockedRead = new Promise(resolve => { finish = resolve; });
  const cache = new ResourceCache(server, { maxReads: 1, maxEntries: 1 }); const a = cache.acquire(artifact), b = cache.acquire(artifact);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(cache.usage.activeReads, 1); assert.equal(server.leases.size, 1);
  cache.markExpired(artifact); cache.close(); assert.equal(cache.usage.activeReads, 1); assert.equal(cache.usage.entries, 1);
  finish(); const [left, right] = await Promise.all([a, b]); assert.equal(left.blob, right.blob); assert.equal(left.preview.kind, "download");
  assert.equal(server.calls.filter(method => method === "read").length, 1); assert.equal(server.leases.size, 0);
  left.release(); assert.equal(cache.usage.entries, 1); right.release(); assert.equal(cache.usage.entries, 0);
  await assert.rejects(cache.acquire(artifact), { code: "CLOSED" });
});
test("resource byte/entry admission refuses without evicting active work, and actual read slots stay bounded", async () => {
  const server = new ClientFixturePort(), { client } = fixture(server); await client.bind(scope, historyScope());
  const refs = [];
  for (let i = 0; i < 5; i++) { const draft = await client.saveDraft(scope, input); refs.push(await client.upload(scope, draft.manifest.id)); }
  let finish!: () => void; server.blockedRead = new Promise(resolve => { finish = resolve; });
  const cache = new ResourceCache(server, { maxReads: 2, maxEntries: 4, maxEncodedBytes: 16 });
  const jobs = refs.slice(0, 4).map(ref => cache.acquire(ref));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(cache.usage.activeReads, 2); assert.equal(server.leases.size, 2); assert.equal(cache.usage.encodedBytes, 16);
  await assert.rejects(cache.acquire(refs[4]!), { code: "STORAGE_FULL" });
  cache.close(); assert.equal(cache.usage.entries, 4); finish(); const leases = await Promise.all(jobs);
  for (const lease of leases) lease.release(); assert.equal(cache.usage.entries, 0); assert.equal(cache.usage.activeReads, 0); assert.equal(server.leases.size, 0);
});
test("resource corruption and decoded capacity failure release the actual read and never publish a resource", async () => {
  const server = new ClientFixturePort(), { client } = fixture(server); await client.bind(scope, historyScope());
  const svg = await client.saveDraft(scope, { name: "image.svg", mediaType: "image/svg+xml", blob: new Blob(['<svg width="8" height="8"></svg>']) });
  const ref = await client.upload(scope, svg.manifest.id);
  const cache = new ResourceCache(server, { maxDecodedBytes: 128, decodeImage: async () => ({ width: 8, height: 8 }) });
  await assert.rejects(cache.acquire(ref), { code: "STORAGE_FULL" }); assert.equal(cache.usage.entries, 0); assert.equal(server.leases.size, 0);
  const entry = [...server.uploads.values()][0]!; entry.data[0] = 0;
  await assert.rejects(cache.acquire(ref), { code: "CORRUPT" }); assert.equal(cache.usage.entries, 0); assert.equal(server.leases.size, 0);
});
test("decoded image URL is revoked when auth retirement rejects final file release", async t => {
  const server = new ClientFixturePort(), { client } = fixture(server); await client.bind(scope, historyScope());
  const draft = await client.saveDraft(scope, { name: "image.svg", mediaType: "image/svg+xml", blob: new Blob(['<svg width="1" height="1"></svg>']) });
  const artifact = await client.upload(scope, draft.manifest.id), created: string[] = [], revoked: string[] = [];
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  t.mock.method(URL, "createObjectURL", (blob: Blob) => { const url = create(blob); created.push(url); return url; });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); revoke(url); });
  let beginDecode!: () => void, finishDecode!: () => void, retired = false, releases = 0;
  const entered = new Promise<void>(resolve => { beginDecode = resolve; }), decoding = new Promise<void>(resolve => { finishDecode = resolve; });
  const port: FilePort = { async call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
    if (method === "release" && retired) { releases++; throw new FileError("FENCED"); }
    return server.call(method, input);
  } };
  const cache = new ResourceCache(port, { decodeImage: async () => { beginDecode(); await decoding; return { width: 1, height: 1 }; } });
  try {
    const preview = cache.acquire(artifact); await entered; assert.equal(created.length, 1); assert.equal(revoked.length, 0);
    retired = true; cache.close(); assert.equal(cache.usage.activeReads, 1); assert.equal(cache.usage.activeDecodes, 1);
    finishDecode(); await assert.rejects(preview, { code: "FENCED" });
    assert.deepEqual(revoked, created); assert.equal(releases, 1);
    assert.equal(cache.usage.entries, 0); assert.equal(cache.usage.activeReads, 0); assert.equal(cache.usage.activeDecodes, 0);
  } finally {
    finishDecode(); cache.close(); server.leases.clear(); // This fixture's denied server lease has no asserted native release proof.
  }
});
test("HTTP client bounds actual response chunks before full-body allocation and cancels overflow", async () => {
  let pulls = 0, canceled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(600 * 1024)); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const fetcher = (async () => new Response(stream, { status: 200 })) as typeof fetch;
  const port = createHttpFilePort("https://fixture.invalid", fetcher);
  await assert.rejects(port.call("status", { scope, id: "bounded" }), { code: "INVALID" });
  assert.equal(pulls, 2); assert.equal(canceled, 1);
});
test("lost HTTP acquisition response cannot leak a Host lease; local buffers enforce four slots and scope", async () => {
  const host = new ClientFixturePort(), { client } = fixture(host); await client.bind(scope, historyScope());
  const draft = await client.saveDraft(scope, input), artifact = await client.upload(scope, draft.manifest.id);
  const handler = createFileHttpHandler(host, { authenticate: () => scope, canUpload: () => true });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  let lose = true;
  const fetcher = (async (...args: Parameters<typeof fetch>) => {
    const response = await fetch(...args);
    if (new URL(String(args[0])).pathname.startsWith("/files/") && lose) { lose = false; await response.body?.cancel(); throw new FileError("IO", "Injected lost GET reply"); }
    return response;
  }) as typeof fetch;
  try {
    const port = createHttpFilePort(`http://127.0.0.1:${address.port}`, fetcher);
    await assert.rejects(port.call("acquire", { scope, id: artifact.id }), { code: "IO" });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(host.leases.size, 0);
    const acquired = [];
    for (let i = 0; i < 4; i++) acquired.push(await port.call("acquire", { scope, id: artifact.id }));
    assert.equal(host.leases.size, 0); await assert.rejects(port.call("acquire", { scope, id: artifact.id }), { code: "BUSY" });
    const first = acquired[0]!;
    await assert.rejects(port.call("read", { scope: { ...scope, session: "b" }, leaseId: first.leaseId, offset: 0, length: 1 }), { code: "FENCED" });
    assert.deepEqual(await port.call("read", { scope, leaseId: first.leaseId, offset: 0, length: 4 }), new Uint8Array([0, 255, 17, 21]));
    for (const lease of acquired) await port.call("release", { scope, leaseId: lease.leaseId });
    const next = await port.call("acquire", { scope, id: artifact.id }); await port.call("release", { scope, leaseId: next.leaseId });
    assert.equal(host.leases.size, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); }); }
});
test("draft acquisition snapshots mutable scope, metadata and Blob reference before asynchronous hashing", async () => {
  const { client } = fixture(); await client.bind(scope, historyScope());
  const mutableScope = { ...scope }, original = new Blob(["original bytes"]), replacement = new Blob(["replacement"]);
  const realRead = original.arrayBuffer.bind(original); let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  Object.defineProperty(original, "arrayBuffer", { value: async () => { await gate; return realRead(); } });
  const mutableInput = { name: "original.txt", mediaType: "text/plain", blob: original, id: "frozen-input" };
  const saving = client.saveDraft(mutableScope, mutableInput);
  mutableScope.session = "b"; mutableInput.name = "changed.bin"; mutableInput.mediaType = "application/octet-stream"; mutableInput.blob = replacement; mutableInput.id = "changed-id";
  resume(); const record = await saving;
  assert.deepEqual(record.scope, scope); assert.equal(record.manifest.name, "original.txt"); assert.equal(record.manifest.mediaType, "text/plain"); assert.equal(record.manifest.id, "frozen-input"); assert.equal(record.blob, original);
  assert.equal(record.manifest.sha256, await digest(new TextEncoder().encode("original bytes"))); assert.equal(await record.blob.text(), "original bytes");
});
test("HTTP acquisition snapshots scope and ID across deferred status and binary response", async () => {
  const host = new ClientFixturePort(), { client } = fixture(host); await client.bind(scope, historyScope());
  const draft = await client.saveDraft(scope, input), artifact = await client.upload(scope, draft.manifest.id);
  let resume!: () => void, ready!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
  const fetcher = (async (...args: Parameters<typeof fetch>) => {
    if (new URL(String(args[0])).pathname === "/rpc") { ready(); await gate; return Response.json({ result: { state: "committed", artifact } }); }
    assert.equal(new URL(String(args[0])).pathname, `/files/${artifact.id}`);
    return new Response(new Uint8Array([0, 255, 17, 21]));
  }) as typeof fetch;
  const port = createHttpFilePort("https://fixture.invalid", fetcher), mutableScope = { ...scope }, mutableInput = { scope: mutableScope, id: artifact.id };
  const acquiring = port.call("acquire", mutableInput); await started;
  mutableScope.session = "b"; mutableInput.id = "changed-id"; resume();
  const lease = await acquiring;
  assert.equal(lease.artifact.id, artifact.id); assert.deepEqual(await port.call("read", { scope, leaseId: lease.leaseId, offset: 0, length: 4 }), new Uint8Array([0, 255, 17, 21]));
  await assert.rejects(port.call("read", { scope: mutableScope, leaseId: lease.leaseId, offset: 0, length: 1 }), { code: "FENCED" });
  await port.call("release", { scope, leaseId: lease.leaseId });
});
