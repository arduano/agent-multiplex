import assert from "node:assert/strict";
import test from "node:test";
import { createTRPCUntypedClient } from "@trpc/client";
import { irohLink, type QuicConnection } from "@arduano/p2prpc-core/advanced";
import { CatalogAuthority } from "../src/authority/catalog.js";
import { CreationFixture, defer, fixture, request, scope, target, until } from "./fixtures.js";

test("committed creation and exact-original reads remain valid published RPC data after restart", async () => {
  const f = await fixture();
  try {
    const created = await f.authority.create(request());
    await f.reopen();
    const restored = await f.authority.creation(scope, created.original.id);
    assert.equal(restored?.state, "nativeCreated");
    assert.deepEqual(restored?.native, created.native);
    assert.deepEqual(restored?.original, request());
    assert.equal(f.host.creates.length, 1);
    for (const value of [created, restored]) {
      let written = 0, read = false, stopped = 0, reset = 0;
      const connection: QuicConnection = {
        remoteId: "fixture", side: "client",
        async openBi() { return {
          send: { async writeAll(bytes) { written += bytes.byteLength; }, async finish() {}, async reset() { reset++; }, async setPriority() {} },
          recv: { async readExact() { read = true; throw new Error("Scripted response unavailable"); }, async expectEnd() {}, async stop() { stopped++; } },
        }; },
        async acceptBi() { throw new Error("Unexpected accept"); }, async openUni() { throw new Error("Unexpected open"); }, async acceptUni() { throw new Error("Unexpected accept"); },
        async closed() { return "scripted"; }, close() {}, async stats() { return { rttMs: null, sentBytes: written, receivedBytes: 0, lostPackets: 0 }; },
      };
      // The published link applies the same serializer to request and response
      // values. A scripted stream stops immediately after the actual request
      // frame, proving DTO acceptance without an endpoint or another codec.
      const client = createTRPCUntypedClient({ links: [irohLink({ connection: async () => connection, ioTimeoutMs: 1000 })] });
      await assert.rejects(client.query("creationWireProbe", value), error => {
        assert(error instanceof Error && error.cause instanceof Error && "code" in error.cause);
        assert.equal(error.cause.code, "OUTCOME_UNKNOWN");
        assert(error.cause.cause instanceof Error);
        assert.equal(error.cause.cause.message, "Scripted response unavailable");
        return true;
      });
      assert(written > 1 && read, "Published RPC serializer must admit the complete Creation DTO");
      assert.equal(stopped, 1); assert.equal(reset, 1);
    }
  } finally { await f.dispose(); }
});

test("archive publication requires exact Host proof, retains committed inventory across restart and never dispatches Host mutation", async () => {
  const f = await fixture(), publication = { scope, session: "a", id: "archive-original", generation: 1 };
  try {
    await f.authority.create(request()); await assert.rejects(f.authority.publishArchive(publication), { code: "BUSY" });
    f.host.archived.add(JSON.stringify(["a", publication.id, 1]));
    const archived = await f.authority.publishArchive(publication); assert.deepEqual(archived.archive, { id: publication.id, generation: 1 });
    const reads = f.host.archiveReads.length; assert.deepEqual(await f.authority.publishArchive(publication), archived); assert.equal(f.host.archiveReads.length, reads);
    await assert.rejects(f.authority.publishArchive({ ...publication, generation: 2 }), { code: "CONFLICT" });
    await f.reopen(); assert.deepEqual(await f.authority.list(scope), [archived]);
    assert.equal(f.host.creates.length, 1); assert.equal(f.host.reads.length, 0);
  } finally { await f.dispose(); }
});

test("lost archive publication reconciles exact proof only; a replaced registered Host cannot complete an old proof", async () => {
  const f = await fixture(), publication = { scope, session: "a", id: "archive-original", generation: 1 }, gate = defer<boolean>();
  try {
    await f.authority.create(request()); f.host.archiveGate = gate.promise;
    const lost = f.authority.publishArchive(publication); await until(() => f.host.archiveReads.length === 1);
    await f.authority.terminate(); gate.resolve(true); await assert.rejects(lost, { code: "CLOSED" });
    f.host.archiveGate = undefined; f.host.archived.add(JSON.stringify(["a", publication.id, 1])); await f.reopen();
    assert.equal((await f.authority.get(scope, "a"))!.archive, undefined);
    assert.deepEqual((await f.authority.publishArchive(publication)).archive, { id: publication.id, generation: 1 }); assert.equal(f.host.creates.length, 1);
    await f.authority.create(request("create-b", "b")); const stale = defer<boolean>(); f.host.archiveGate = stale.promise;
    const pending = f.authority.publishArchive({ ...publication, session: "b" }); await until(() => f.host.archiveReads.length === 3);
    f.authority.register(new CreationFixture({ ...target, owner: "replacement" })); stale.resolve(true);
    await assert.rejects(pending, { code: "FENCED" }); assert.equal((await f.authority.get(scope, "b"))!.archive, undefined);
  } finally { gate.resolve(true); await f.dispose(); }
});
test("logical reservation, immutable original and initial metadata exist before exactly one Host create", async () => {
  const f = await fixture({ observationMs: 10 }); const gate = defer<void>(); f.host.gate = gate.promise;
  try {
    const base = request(); const mutable = { ...base, metadata: { ...base.metadata }, target: { ...base.target } }; const starting = f.authority.create(mutable); mutable.metadata.name = "changed"; mutable.metadata.cwd = "/other"; mutable.target.owner = "other";
    await until(() => f.host.creates.length === 1); const row = await f.authority.get(scope, "a"); assert.equal(row!.binding, null); assert.equal(row!.metadata.name, "Original"); assert.equal(row!.metadata.cwd, "/work/original");
    const pending = await starting; assert.equal(pending.state, "dispatching"); await f.authority.create(request()); assert.equal(f.host.creates.length, 1);
    await assert.rejects(f.authority.create({ ...request(), metadata: { name: "conflict", cwd: null } }), { code: "CONFLICT" }); await assert.rejects(f.authority.create(request("another", "a")), { code: "CONFLICT" });
    gate.resolve(); await until(async () => (await f.authority.creation(scope, "create-a"))?.state === "nativeCreated"); assert.equal(f.host.creates[0]!.target.owner, target.owner); assert.equal(f.host.creates[0]!.metadata.cwd, "/work/original");
  } finally { gate.resolve(); await f.dispose(); }
});
test("lost create reply reconciles exact original by read, never resubmits mutation", async () => {
  const f = await fixture(); f.host.lose = true;
  try { const c = await f.authority.create(request()); assert.equal(c.state, "outcomeUnknown"); const result = await f.authority.creation(scope, c.original.id); assert.equal(result!.state, "nativeCreated"); assert.equal(result!.native!.nativeSession, "real-a"); assert.equal(f.host.creates.length, 1); assert.deepEqual(f.host.reads[0], request()); await f.authority.create(request()); assert.equal(f.host.creates.length, 1); } finally { await f.dispose(); }
});
test("native creation survives publication failure and later read-only reconciliation", async () => {
  const f = await fixture(); const gate = defer<void>(); f.host.gate = gate.promise;
  try { const pending = f.authority.create(request()); await until(() => f.host.creates.length === 1); await f.authority.terminate(); gate.resolve(); const c = await pending; assert.equal(c.state, "nativeCreated"); assert.equal(c.publication, "pending"); assert.equal(c.native!.nativeSession, "real-a"); await f.reopen(); const reconciled = await f.authority.creation(scope, "create-a"); assert.equal(reconciled!.publication, "committed"); assert.equal(reconciled!.entry.binding!.nativeSession, "real-a"); assert.equal(f.host.creates.length, 1); } finally { gate.resolve(); await f.dispose(); }
});
test("restart after possible dispatch performs zero native replay, exact custody reads only", async () => {
  const f = await fixture({ observationMs: 5 }); const gate = defer<void>(); f.host.gate = gate.promise;
  try { await f.authority.create(request()); await until(() => f.host.creates.length === 1); await f.reopen(); assert.equal(f.host.creates.length, 1); assert.equal(f.host.reads.length, 0); const unknown = await f.authority.creation(scope, "create-a"); assert.equal(unknown!.state, "outcomeUnknown"); gate.resolve(); await until(() => f.host.statuses.has("create-a")); const created = await f.authority.creation(scope, "create-a"); assert.equal(created!.state, "nativeCreated"); assert.equal(f.host.creates.length, 1); } finally { gate.resolve(); await f.dispose(); }
});
test("new Host custody cannot receive an old create or receipt; same proved domain can reconnect", async () => {
  const f = await fixture(); f.host.lose = true;
  try { await f.authority.create(request()); await f.authority.close(); const a = await CatalogAuthority.open({ directory: f.directory, scope }); const other = new CreationFixture({ ...target, owner: "replacement-domain" }); a.register(other);
    assert.equal((await a.creation(scope, "create-a"))!.state, "outcomeUnknown"); assert.equal(other.reads.length, 0); assert.equal(other.creates.length, 0); const reconnect = new CreationFixture(target); reconnect.statuses.set("create-a", f.host.statuses.get("create-a")!); a.register(reconnect); assert.equal((await a.creation(scope, "create-a"))!.state, "nativeCreated"); assert.equal(reconnect.creates.length, 0); await a.close();
  } finally { await f.dispose(); }
});
test("metadata CAS and duplicate rename are independent of original creation and native identity", async () => {
  const f = await fixture();
  try { const c = await f.authority.create(request()); const r = { scope, id: "rename", session: "a", revision: 1, name: "Renamed" }; const next = await f.authority.rename(r); assert.equal(next.revision, 2); assert.equal(next.metadata.cwd, "/work/original"); assert.deepEqual(next.binding, c.native); assert.deepEqual(await f.authority.rename(r), next); await assert.rejects(f.authority.rename({ ...r, id: "stale" }), { code: "CONFLICT" }); await assert.rejects(f.authority.rename({ ...r, name: "different" }), { code: "CONFLICT" }); assert.equal((await f.authority.creation(scope, "create-a"))!.original.metadata.name, "Original"); assert.equal(f.host.creates.length, 1); } finally { await f.dispose(); }
});
test("private authority/account scope, strict launch fields and finite catalog cannot mutate existing rows", async () => {
  const f = await fixture({ maxSessions: 1, maxOperations: 2 });
  try { await f.authority.create(request()); for (const foreign of [{ ...scope, principal: "other" }, { ...scope, authority: "other" }, { ...scope, connection: "other" }]) { await assert.rejects(f.authority.list(foreign), { code: "FENCED" }); await assert.rejects(f.authority.creation(foreign, "create-a"), { code: "FENCED" }); }
    await assert.rejects(f.authority.create({ ...request("unsafe", "b"), providerUrl: "escape" } as unknown as ReturnType<typeof request>), { code: "INVALID" }); await assert.rejects(f.authority.create(request("second", "b")), { code: "FULL" }); assert.equal((await f.authority.list(scope)).length, 1); assert.equal(f.host.creates.length, 1);
  } finally { await f.dispose(); }
});
test("registering replacement Host custody retires old route capability without touching existing native work", async () => {
  const f = await fixture(); f.host.lose = true;
  try { await f.authority.create(request()); const replacement = new CreationFixture({ ...target, owner: "replacement" }); f.authority.register(replacement); const oldReads = f.host.reads.length; assert.equal((await f.authority.creation(scope, "create-a"))!.state, "outcomeUnknown"); assert.equal(f.host.reads.length, oldReads); assert.equal(replacement.reads.length, 0); assert.equal((await f.authority.create(request("old-owner-new-create", "b"))).state, "refused"); assert.equal(f.host.creates.length, 1); assert.equal(replacement.creates.length, 0); } finally { await f.dispose(); }
});
