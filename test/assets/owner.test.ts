import { transferFixture } from "./transfer-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixture as copilotFixture } from "../copilot/fixture.js";
import { FileStore, type HostPathAuthority, type OwnedFileStore } from "../../src/files/node.js";
import { HistoryWindow } from "../../src/history/index.js";
import {
  ASSET_CHUNK_BYTES,
  ASSET_MAX_FILE_BYTES,
  assetFileReadPort,
  uploadFile,
  type AssetRemote,
  type NativeMediaInput,
  type UploadSpec,
} from "../../src/assets/index.js";
import { HostAssetOwner, assetRouter, replaceAsset } from "../../src/assets/node.js";
import type { StoredFile } from "../../src/files/index.js";
import type { RunRef } from "../../src/protocol/index.js";
const scope = { connection: "c", principal: "p", host: "h", session: "s" };
const run: RunRef = { scope, generation: 1, nativeSession: "native" };
const bytes = (text: string) => new TextEncoder().encode(text),
  hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const spec = (id: string, data: Uint8Array): UploadSpec => ({
  id,
  name: `${id}.txt`,
  bytes: data.length,
  sha256: hash(data),
  mediaType: "text/plain",
});
const code = (value: string) => (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  (error.code === value || ("message" in error && error.message === `ASSET_${value}`));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(
  work: (value: {
    directory: string;
    root: string;
    store: FileStore;
    owner: HostAssetOwner;
    remote: AssetRemote;
    files: ReturnType<typeof transferFixture>["files"];
    setTime(value: number): void;
  }) => Promise<void>,
  options: {
    paths?: HostPathAuthority;
    trustedSourceKey?: (input: NativeMediaInput) => string | Promise<string>;
    assertCurrent?: (run: RunRef) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "multiplex-assets-"));
  await chmod(root, 0o700);
  const directory = join(root, "store");
  await mkdir(directory, { mode: 0o700 });
  let now = 100;
  const store = await FileStore.open({
    directory,
    ...(options.paths ? { paths: options.paths } : {}),
  });
  let storeCloses = 0;
  const owned: OwnedFileStore = {
    resourceIdentity: store.resourceIdentity,
    file: store.file.bind(store),
    isRetired: store.isRetired.bind(store),
    reference: store.reference.bind(store),
    capture: store.capture.bind(store),
    acquire: store.acquire.bind(store),
    put: store.put.bind(store),
    prepareInput: store.prepareInput.bind(store),
    usage: store.usage.bind(store),
    retireSession: store.retireSession.bind(store),
    collect: store.collect.bind(store),
    close() {
      storeCloses++;
      store.close();
    },
  };
  const owner = new HostAssetOwner({
    store: owned,
    now: () => now,
    uploadTtlMs: 10,
    leaseTtlMs: 10,
    ...options,
  });
  assert.equal(owner.resourceIdentity, store.resourceIdentity);
  const transport = transferFixture(owner, scope);
  const remote: AssetRemote = assetRouter(owner).createCaller({
    bridge: transport.bridge,
    identity: { connection: "c", principal: "p", actions: ["read", "control"] },
    route: { authority: "root", host: "h", owner: "owner", routeEpoch: "e" },
    admit: () => () => {},
  });
  try {
    await work({
      directory,
      root,
      store,
      owner,
      remote,
      files: transport.files,
      setTime(value) {
        now = value;
      },
    });
  } finally {
    await owner.close();
    assert.equal(storeCloses, 1, "The asset owner closes its exact supplied store once");
    await rm(root, { recursive: true, force: true });
  }
}
test("actual destination publishes immutable bytes, source lease downloads and exact status survives restart", () =>
  fixture(async (value) => {
    const data = bytes("x".repeat(ASSET_CHUNK_BYTES + 17)),
      fileSpec = spec("upload", data);
    const committed = await uploadFile(
      value.remote,
      value.files,
      { session: "s", file: fileSpec },
      data,
    );
    assert.equal(committed.sha256, hash(data));
    assert.deepEqual(await value.remote.status({ session: "s", id: "upload" }), {
      state: "complete",
      file: committed,
    });
    await assert.rejects(
      value.remote.begin({ session: "s", file: { ...fileSpec, name: "other.txt" } }),
      code("CONFLICT"),
    );
    const read = await assetFileReadPort(value.remote, value.files).acquire(scope, committed);
    assert.deepEqual(await read.read(ASSET_CHUNK_BYTES, 17), data.subarray(ASSET_CHUNK_BYTES));
    await read.release();
    await read.release();
    assert.equal(value.store.usage().leases, 0);
    const previews = assetFileReadPort(value.remote, value.files);
    const retained = await Promise.all(
      Array.from({ length: 4 }, () => previews.acquire(scope, committed)),
    );
    try {
      await assert.rejects(previews.acquire(scope, committed), code("CAPACITY"));
    } finally {
      await Promise.all(retained.map((lease) => lease.release()));
    }
    const available = await previews.acquire(scope, committed);
    await available.release();
    await value.owner.close();
    const reopened = await FileStore.open({ directory: value.directory });
    assert.deepEqual(reopened.file(scope, "upload"), committed);
    reopened.close();
  }));
test("business reservation, wrong SHA, abort and expiry never publish partial bytes", () =>
  fixture(async (value) => {
    for (let index = 0; index < 4; index++)
      value.owner.begin(scope, spec(`u${index}`, bytes("abc")));
    assert.throws(() => value.owner.begin(scope, spec("fifth", bytes("x"))), code("CAPACITY"));
    assert.throws(
      () =>
        value.owner.begin(scope, { ...spec("huge", bytes("x")), bytes: ASSET_MAX_FILE_BYTES + 1 }),
      code("INVALID"),
    );
    value.setTime(111);
    await value.owner.collect();
    assert.deepEqual(value.owner.status(scope, "u0"), { state: "unknown", id: "u0" });
    const wrong = { ...spec("wrong", bytes("abc")), sha256: hash(bytes("bad")) };
    await assert.rejects(
      uploadFile(value.remote, value.files, { session: "s", file: wrong }, bytes("abc")),
      code("CONFLICT"),
    );
    assert.equal(value.store.file(scope, "wrong"), null);
    const guardedSpec = spec("guarded", bytes("abc")),
      guarded = value.owner.begin(scope, guardedSpec);
    if (guarded.state !== "receiving") throw Error("missing guarded intent");
    const transport = transferFixture(value.owner, scope),
      manifest = {
        transferId: "guarded",
        name: guardedSpec.name,
        size: 3,
        digest: "0".repeat(64),
        chunkSize: 65536,
        chunkCount: 1,
        metadata: { session: "s", file: guardedSpec, token: guarded.token },
      };
    const decision = await value.owner.incoming({
      peerId: "fixture",
      principal: transport.principal,
      sessionId: "fixture",
      signal: new AbortController().signal,
      manifest,
    });
    if (!decision.accept) throw Error("destination refused");
    await decision.accept.prepare(manifest);
    await decision.accept.writeChunk(manifest, 0, bytes("abc"));
    let marked = 0;
    await assert.rejects(
      decision.accept.finalize(manifest, {
        markCommitted() {
          marked++;
        },
      }),
      code("CONFLICT"),
    );
    assert.equal(marked, 0, "A wrong complete BLAKE3 must never report publication");
    assert.equal(value.store.file(scope, "guarded"), null);
    await decision.accept.abort(manifest, { discard: true });
    const claims = transport.principal.claims;
    assert.throws(
      () =>
        value.owner.incoming({
          peerId: "fixture",
          principal: {
            ...transport.principal,
            claims: {
              ...claims,
              viewer: { connection: "c", principal: "p", actions: ["read"], hosts: ["h"] },
            },
          },
          sessionId: "fixture",
          signal: new AbortController().signal,
          manifest,
        }),
      code("FENCED"),
    );

    const old = value.owner.begin(scope, spec("reused", bytes("old")));
    if (old.state !== "receiving") throw Error("missing upload");
    value.setTime(122);
    await value.owner.collect();
    value.owner.begin(scope, spec("reused", bytes("new")));
    assert.throws(() => value.owner.abort(scope, "reused", old.token), code("FENCED"));
  }));
test("actual native input leases keep immutable image/file paths private and survive session retirement", () =>
  fixture(async (value) => {
    const uploaded = await uploadFile(
      value.remote,
      value.files,
      { session: "s", file: spec("native-file", bytes("snapshot")) },
      bytes("snapshot"),
    );
    const codex = await value.owner.prepareCodexInputs({
      run,
      originalId: "send",
      attachments: [{ id: uploaded.id }],
    });
    const copilot = await value.owner.prepareCopilotInputs(run, [uploaded.id]);
    assert.equal(codex.inputs[0]!.type, "mention");
    assert.equal((await readFile(codex.inputs[0]!.path)).toString(), "snapshot");
    assert.equal(value.store.usage().leases, 2);
    assert.equal(JSON.stringify(uploaded).includes(value.root), false);
    assert.throws(() => value.owner.close(), code("BUSY"));
    await value.owner.retireSession(scope);
    assert.equal(value.store.isRetired(scope), true);
    assert.throws(() => value.owner.begin(scope, spec("retired", bytes("x"))), code("FENCED"));
    assert.equal((await value.store.collect()).files, 0);
    await codex.release();
    await copilot.release();
    assert.equal((await value.store.collect()).files, 1);
    assert.equal(value.owner.readiness().ready, true);
  }));
test("inline/data URL media materializes real bytes while remote URLs and untrusted native paths refuse", () =>
  fixture(async (value) => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(16).fill(0)]);
    const input: NativeMediaInput = {
      run,
      attachment: "a",
      stream: "native",
      eventId: "event",
      rowId: "row",
      assetId: "asset",
      name: "image.png",
      mediaType: "image/png",
      source: {
        type: "image",
        url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
      },
    };
    const file = await value.owner.capture(input);
    assert.equal(file.sha256, hash(png));
    assert.equal(JSON.stringify(file).includes("base64"), false);
    assert.equal(JSON.stringify(file).includes(value.root), false);
    const lease = await value.store.acquire(scope, file);
    assert.deepEqual(await lease.read(0, png.length), png);
    await lease.release();
    await assert.rejects(
      value.owner.capture({
        ...input,
        eventId: "remote",
        source: { url: "https://untrusted.invalid/image.png" },
      }),
      code("UNSUPPORTED"),
    );
    await assert.rejects(
      value.owner.capture({ ...input, eventId: "path", source: { path: "/etc/passwd" } }),
      code("UNSUPPORTED"),
    );
  }));
test("trusted native occurrence uses Host path authority; late Stop fences capture and row publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "multiplex-asset-source-")),
    path = join(root, "source.txt");
  await writeFile(path, "authorized bytes");
  const gate = deferred<string>();
  let active = true;
  try {
    await fixture(
      async (value) => {
        const base: NativeMediaInput = {
          run,
          attachment: "a",
          stream: "native",
          eventId: "source",
          rowId: "row",
          assetId: "source",
          name: "source.txt",
          mediaType: "text/plain",
          source: { path },
        };
        const capture = value.owner.capture(base);
        await tick();
        active = false;
        gate.resolve("proved-occurrence");
        await assert.rejects(capture, code("FENCED"));
        assert.equal(value.store.usage().entries, 0);
        active = true;
        const file = await value.owner.capture({ ...base, eventId: "new" });
        assert.equal(file.origin, "capture");
        assert.equal(file.bytes, 16);
        assert.equal(JSON.stringify(file).includes(path), false);
        const window = new HistoryWindow({ run, attachment: "a", stream: "native" });
        const occurrence = { run, attachment: "a", rowId: "row", assetId: "source" };
        window.update({
          rows: [
            {
              id: "row",
              kind: "tool",
              lifecycle: "running",
              body: { kind: "partial", text: "old", missing: ["final"] },
              native: {
                assets: [
                  { id: "source", name: "source.txt", mediaType: "text/plain", state: "pending" },
                ],
              },
            },
          ],
        });
        window.update({
          rows: [
            {
              id: "row",
              kind: "tool",
              lifecycle: "completed",
              body: { kind: "complete", text: "new full output", evidence: "native" },
              native: window.getSnapshot().rows[0]!.native,
            },
          ],
        });
        assert.equal(
          replaceAsset(
            window,
            { ...occurrence, run: { ...run, generation: 2 } },
            { id: "source", name: "source.txt", mediaType: "text/plain", state: "ready", file },
          ),
          false,
        );
        assert.equal(
          replaceAsset(window, occurrence, {
            id: "source",
            name: "source.txt",
            mediaType: "text/plain",
            state: "ready",
            file,
          }),
          true,
        );
        const row = window.getSnapshot().rows[0]!;
        assert.equal(row.lifecycle, "completed");
        assert.equal(row.body.kind === "complete" && row.body.text, "new full output");
        window.close();
      },
      {
        paths: {
          async resolve(owner, key) {
            assert.deepEqual(owner, scope);
            assert.equal(key, "proved-occurrence");
            return { path, name: "source.txt", mediaType: "text/plain" };
          },
        },
        trustedSourceKey: () => gate.promise,
        assertCurrent() {
          if (!active) throw Object.assign(Error("FENCED"), { code: "FENCED" });
        },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Host authorization and bounded prepared-source leases remain local to the exact owner", () =>
  fixture(async (value) => {
    const file = await uploadFile(
      value.remote,
      value.files,
      { session: "s", file: spec("read", bytes("bytes")) },
      bytes("bytes"),
    );
    const transport = transferFixture(value.owner, scope);
    const viewer = assetRouter(value.owner).createCaller({
      identity: { connection: "c", principal: "p", actions: ["read"] },
      route: { authority: "root", host: "h", owner: "owner", routeEpoch: "e" },
      admit: () => () => {},
      bridge: transport.bridge,
    });
    await assert.rejects(
      viewer.begin({ session: "s", file: spec("denied", bytes("x")) }),
      code("FORBIDDEN"),
    );
    const sources = await Promise.allSettled(
      Array.from({ length: 40 }, () => value.owner.source(scope, file).prepare!()),
    );
    const leases = sources
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<NonNullable<ReturnType<typeof value.owner.source>["prepare"]>>>
        > => result.status === "fulfilled",
      )
      .map((result) => result.value);
    assert.equal(leases.length, 32);
    assert.equal(value.store.usage().leases, 32);
    assert.throws(() => value.owner.source({ ...scope, principal: "other" }, file), code("FENCED"));
    await Promise.all(leases.map((lease) => lease.close()));
    assert.equal(value.store.usage().leases, 0);
    const noBridge = assetRouter(value.owner).createCaller({
      identity: { connection: "c", principal: "p", actions: ["read"] },
      route: { authority: "root", host: "h", owner: "owner", routeEpoch: "e" },
      admit: () => () => {},
    });
    await assert.rejects(noBridge.acquire({ session: "s", file }), code("FORBIDDEN"));
  }));

test("actual Copilot adapter composition captures tool bytes and holds uploaded input until native consumption", () =>
  fixture(async (value) => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(16).fill(0)]),
      uploadSpec = { ...spec("copilot-image", png), name: "image.png", mediaType: "image/png" };
    const uploaded = await uploadFile(
      value.remote,
      value.files,
      { session: "s", file: uploadSpec },
      png,
    );
    const released = deferred<void>();
    const captured: Promise<StoredFile>[] = [];
    await copilotFixture(
      async (native) => {
        const { run, capsule, client } = await native.open();
        const receipt = await native.adapter.native.send({
          run,
          capsule,
          originalId: "with-image",
          message: { text: "inspect", files: [uploaded.id] },
        });
        assert.equal(receipt.state, "succeeded");
        assert.equal(value.store.usage().leases, 1);
        const call = client.calls.find((call) => call.method === "send")!,
          attachment = (call.input!.attachments as { path: string }[])[0]!;
        assert.deepEqual(await readFile(attachment.path), Buffer.from(png));
        client.emit("tool.execution_complete", {
          toolCallId: "image",
          success: true,
          result: {
            content: "image seen",
            binaryResultsForLlm: [
              { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
            ],
          },
        });
        await tick();
        await captured[0];
        await tick();
        const row = native.adapter.history(run).getSnapshot().rows[0]!;
        assert.equal((row.native.assets as { state: string }[])[0]!.state, "ready");
        assert.equal(JSON.stringify(row).includes(attachment.path), false);
        client.emit("user.message", {
          messageId: (receipt.result as { messageId: string }).messageId,
          content: "inspect",
        });
        client.emit("session.idle", {});
        await released.promise;
        assert.equal(value.store.usage().leases, 0);
        await native.adapter.native.stop(capsule);
      },
      {
        media: {
          capture(input) {
            const promise = value.owner.capture(input);
            captured.push(promise);
            return promise;
          },
        },
        prepareInputs: async (run, ids) => {
          const prepared = await value.owner.prepareCopilotInputs(run, ids);
          return {
            attachments: prepared.attachments,
            async release() {
              await prepared.release();
              released.resolve();
            },
          };
        },
      },
    );
  }));
