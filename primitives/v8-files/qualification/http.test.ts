import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileHost } from "../src/host/index.js";
import { createFileHttpHandler } from "../src/transport/http.js";
import { createHttpFilePort } from "../src/client/http-port.js";
import { digest } from "../src/contracts/content.js";
import { FileError, type FilePort, type FileScope } from "../src/contracts/types.js";

const scope: FileScope = { connection: "http-fixture", principal: "owner", host: "host", session: "session" };
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("HTTP ownership did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(run: (host: FileHost, origin: string, fetcher: typeof fetch, control: ReturnType<typeof createFileHttpHandler>) => Promise<void>, wrap?: (host: FileHost) => FilePort) {
  const directory = mkdtempSync(join(tmpdir(), "v8-files-http-")), cwd = join(directory, "workspace"); mkdirSync(cwd, { mode: 0o700 });
  let host: FileHost | undefined;
  const server = createServer();
  try {
    host = await FileHost.open({ directory: join(directory, "private"), bindings: [{ scope, cwd, dialect: "posix" }], limits: { sessionBytes: 256 * 1024, hostBytes: 512 * 1024 } });
    const handler = createFileHttpHandler(wrap?.(host) ?? host, {
      authenticate(request) { if (request.headers["x-fixture-owner"] !== "yes") throw new FileError("FENCED"); return scope; },
      canUpload: request => request.headers["x-fixture-write"] === "yes",
    });
    server.on("request", (req, res) => { void handler(req, res); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}/`;
    const fetcher: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers); headers.set("x-fixture-owner", "yes"); headers.set("x-fixture-write", "yes");
      if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      return fetch(input, { ...init, headers });
    };
    await run(host, origin, fetcher, handler);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await host?.close(); rmSync(directory, { recursive: true, force: true }); }
}
async function upload(port: FilePort, id: string, data: Uint8Array, name = "file.bin", mediaType = "application/octet-stream") {
  await port.call("begin", { scope, manifest: { id, bytes: data.length, name, mediaType, sha256: await digest(data) } });
  for (let offset = 0; offset < data.length; offset += 65536) await port.call("write", { scope, id, offset, data: data.subarray(offset, offset + 65536) });
  return port.call("commit", { scope, id });
}

test("real authenticated HTTP uploads arbitrary bytes and serves inert exact downloads, HEAD, ETags and ranges", async () => {
  await fixture(async (host, origin, fetcher) => {
    const port = createHttpFilePort(origin, fetcher), data = Uint8Array.from([0, 255, 1, 2, 3, 4, 5, 6]);
    const artifact = await upload(port, "binary", data, "../document.html", "text/html");
    const url = new URL("files/binary", origin);
    const full = await fetcher(url); assert.equal(full.status, 200); assert.equal(full.headers.get("content-type"), "application/octet-stream");
    assert.equal(full.headers.get("x-content-type-options"), "nosniff"); assert.match(full.headers.get("content-disposition")!, /^attachment;.*document.html/);
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), data);
    const etag = `"${artifact.sha256}"`;
    const head = await fetcher(url, { method: "HEAD" }); assert.equal(head.headers.get("etag"), etag); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const ranged = await fetcher(url, { headers: { range: "bytes=2-4", "if-range": etag } }); assert.equal(ranged.status, 206); assert.equal(ranged.headers.get("content-range"), "bytes 2-4/8"); assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), data.slice(2, 5));
    assert.equal((await fetcher(url, { headers: { range: "bytes=8-" } })).status, 416);
    assert.equal((await fetcher(url, { headers: { "if-match": '"foreign"' } })).status, 412);
    assert.equal((await fetcher(url, { headers: { "if-none-match": etag } })).status, 304);
    const local = await port.call("acquire", { scope, id: "binary" });
    assert.deepEqual(await port.call("read", { scope, leaseId: local.leaseId, offset: 1, length: 3 }), data.slice(1, 4));
    await port.call("release", { scope, leaseId: local.leaseId });
    const empty = await upload(port, "empty", new Uint8Array()); assert.equal(empty.bytes, 0);
    assert.equal((await (await fetcher(new URL("files/empty", origin))).arrayBuffer()).byteLength, 0);
    assert.equal((await fetcher(new URL("files/empty", origin), { headers: { range: "bytes=0-" } })).status, 416);
    await eventually(async () => (await host.call("usage", { scope })).activeReads === 0);
  });
});

test("HTTP release failure retains exact cleanup ownership and admission until a later finite reconciliation succeeds", async () => {
  let failures = 3, calls = 0;
  await fixture(async (host, origin, fetcher, control) => {
    await upload(host, "release-original", new Uint8Array([1, 2, 3]));
    const response = await fetcher(new URL("files/release-original", origin)); await response.arrayBuffer();
    await eventually(async () => control.pendingReleases() === 1 && calls === 3);
    assert.equal((await host.call("usage", { scope })).activeReads, 1);
    await control.retryReleases();
    assert.equal(control.pendingReleases(), 0); assert.equal(calls, 4);
    assert.equal((await host.call("usage", { scope })).activeReads, 0);
  }, host => ({ async call(method, input) {
    if (method === "release") { calls++; if (failures-- > 0) throw new FileError("BUSY"); }
    return host.call(method, input);
  } }));
});

test("file navigation cannot upload, change scope or invoke internal native/GC/lease controls", async () => {
  await fixture(async (_host, origin, fetcher) => {
    assert.equal((await fetch(new URL("files/missing", origin))).status, 403);
    const command = { method: "begin", input: { scope, manifest: { id: "blocked", name: "a", mediaType: "application/octet-stream", bytes: 0, sha256: await digest(new Uint8Array()) } } };
    const readOnly = await fetch(new URL("rpc", origin), { method: "POST", headers: { "x-fixture-owner": "yes", "content-type": "application/json" }, body: JSON.stringify(command) }); assert.equal(readOnly.status, 403);
    assert.equal((await fetcher(new URL("rpc", origin), { method: "POST", headers: { origin: "https://foreign.invalid" }, body: JSON.stringify(command) })).status, 403);
    assert.equal((await fetcher(new URL("rpc", origin), { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(command) })).status, 415);
    for (const method of ["protect", "settle", "releaseConsumer", "collect", "sweep", "acquire", "read", "release"]) {
      assert.equal((await fetcher(new URL("rpc", origin), { method: "POST", body: JSON.stringify({ method, input: { scope } }) })).status, 403);
    }
    await assert.rejects(createHttpFilePort(origin, fetcher).call("status", { scope: { ...scope, session: "foreign" }, id: "blocked" }), { code: "FENCED" });
  });
});

test("lost HTTP download retains actual Host ownership through pending read settlement; released original then expires only under pressure", async () => {
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), reading = new Promise<void>(resolve => { entered = resolve; });
  await fixture(async (host, origin, fetcher) => {
    await upload(host, "active-download", new Uint8Array(200 * 1024));
    await host.call("protect", { scope, operationId: "send", artifactIds: ["active-download"], consumers: ["root", "child"] });
    await host.call("settle", { scope, operationId: "send" });
    await host.call("releaseConsumer", { scope, operationId: "send", consumer: "root" });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: 200 * 1024 })).expired, []);
    await host.call("releaseConsumer", { scope, operationId: "send", consumer: "child" });
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: 0 })).expired, []);
    const abort = new AbortController(); const pending = fetcher(new URL("files/active-download", origin), { signal: abort.signal }).then(response => response.arrayBuffer()).catch(() => undefined);
    try {
      await reading; abort.abort();
      assert.equal((await host.call("usage", { scope })).activeReads, 1);
      assert.deepEqual((await host.call("collect", { scope, requiredBytes: 200 * 1024 })).expired, []);
    } finally { unblock(); await pending; }
    await eventually(async () => (await host.call("usage", { scope })).activeReads === 0);
    assert.deepEqual((await host.call("collect", { scope, requiredBytes: 200 * 1024 })).expired, ["active-download"]);
    await assert.rejects(host.call("acquire", { scope, id: "active-download" }), /EXPIRED/);
  }, host => ({ async call(method, input) { if (method === "read") { entered(); await gate; } return host.call(method, input); } }));
});
