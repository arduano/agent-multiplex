import assert from "node:assert/strict";
import test from "node:test";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { SessionWorkspace } from "../../v8-session/src/client/workspace.js";
import { ClientFixture } from "../../v8-session/qualification/client-fixture.js";
import { CatalogWorkspace } from "../src/client/workspace.js";
import type { CatalogPort, CatalogEntry, Creation } from "../src/contracts/types.js";
import { sessionScope } from "../src/contracts/types.js";
import { defer, fixture, request, scope, until } from "./fixtures.js";
test("provisional logical draft/pin has no fake history; actual SessionWorkspace binds real native once", async () => {
  const f = await fixture(); const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }); const native = new ClientFixture(), sessions = new SessionWorkspace({ history, port: native }); const workspace = new CatalogWorkspace({ scope, port: f.authority, sessions });
  try {
    const entry = workspace.entry("a"); workspace.setDraft("a", { text: "pre-create", files: ["local-draft"] }); workspace.setPinned("a", true); workspace.entry("b"); assert.equal(history.size, 0); assert.equal(entry.getSnapshot().bound, false);
    const c = await workspace.create(request()), s = sessionScope(request()); native.add(s, "codex"); native.publish(s, { nativeSession: c.native!.nativeSession }); const attachment = { kind: "codex" as const, origin: { connection: s.connection, principal: s.principal, host: s.host, nativeSession: c.native!.nativeSession, attachment: "proved-attachment" }, threadId: c.native!.nativeSession };
    const bound = await workspace.bindNative("a", attachment); assert.equal(history.size, 1); assert.deepEqual(bound.history.draft, { text: "pre-create", files: ["local-draft"] }); assert.equal(bound.history.pinned, true); assert.equal(await workspace.bindNative("a", attachment), bound);
    workspace.setDraft("a", "after bind"); bound.history.setDraft("edited in bound workspace"); sessions.setPinned(s, false); assert.equal(entry.getSnapshot().draft, "edited in bound workspace"); assert.equal(entry.getSnapshot().pinned, false); workspace.setDraft("a", "after bind"); workspace.setPinned("a", true); workspace.setConnected(false); workspace.entry("b"); assert.equal(entry.getSnapshot().draft, "after bind"); assert.equal(entry.getSnapshot().connected, false); workspace.setConnected(true); await workspace.check("a"); assert.equal(f.host.creates.length, 1); assert.equal(native.submitted.length, 0); assert.equal(entry.getSnapshot().original!.metadata.cwd, "/work/original");
  } finally { workspace.close(); sessions.close(); await f.dispose(); }
});
test("lost caller reply retains original and reconnect reads it without create replay or draft loss", async () => {
  const f = await fixture(); let creates = 0; const port: CatalogPort = { list: s => f.authority.list(s), get: (s, id) => f.authority.get(s, id), subscribe: (s, l) => f.authority.subscribe(s, l), rename: r => f.authority.rename(r), setWatched: r => f.authority.setWatched(r), metadataOriginal: (s, id) => f.authority.metadataOriginal(s, id), creation: (s, id) => f.authority.creation(s, id), async create(r) { creates++; await f.authority.create(r); throw new Error("browser reply lost"); } };
  const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), sessions = new SessionWorkspace({ history, port: new ClientFixture() }), workspace = new CatalogWorkspace({ scope, port, sessions });
  try { workspace.setDraft("a", "preserved"); workspace.setPinned("a", true); await assert.rejects(workspace.create(request())); assert.equal(workspace.entry("a").getSnapshot().transmission, "unavailable"); workspace.setConnected(false); workspace.setConnected(true); await workspace.check("a"); assert.equal(workspace.entry("a").getSnapshot().creation!.state, "nativeCreated"); await workspace.create(request()); assert.equal(creates, 1); assert.equal(f.host.creates.length, 1); assert.equal(history.size, 0); assert.equal(workspace.entry("a").getSnapshot().draft, "preserved"); } finally { workspace.close(); sessions.close(); await f.dispose(); }
});
test("creation while unmounted and pinned is retained; incomplete and foreign bindings cannot create history", async () => {
  const f = await fixture({ observationMs: 5 }); const gate = defer<void>(); f.host.gate = gate.promise; const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), sessions = new SessionWorkspace({ history, port: new ClientFixture() }), workspace = new CatalogWorkspace({ scope, port: f.authority, sessions, maxSessions: 2 });
  try { const entry = workspace.entry("a"), release = entry.subscribe(() => {}); workspace.setPinned("a", true); await workspace.create(request()); release(); workspace.entry("b"); assert.throws(() => workspace.entry("c"), { code: "FULL" }); const invalid = { kind: "codex" as const, origin: { connection: scope.connection, principal: scope.principal, host: "host", nativeSession: "placeholder", attachment: "fake" }, threadId: "placeholder" }; await assert.rejects(workspace.bindNative("a", invalid), { code: "FENCED" }); assert.equal(history.size, 0); gate.resolve(); await until(async () => (await workspace.check("a"))?.state === "nativeCreated"); await assert.rejects(workspace.bindNative("a", invalid), { code: "FENCED" }); assert.equal(history.size, 0); assert.equal(entry.getSnapshot().pinned, true); } finally { gate.resolve(); workspace.close(); sessions.close(); await f.dispose(); }
});
test("lightweight catalog enumeration never consumes retained native/history session capacity", async () => {
  const f = await fixture(); const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), sessions = new SessionWorkspace({ history, port: new ClientFixture() }), workspace = new CatalogWorkspace({ scope, port: f.authority, sessions, maxSessions: 1 });
  try { await f.authority.create(request("create-a", "a")); await f.authority.create(request("create-b", "b")); await f.authority.create(request("create-c", "c")); await workspace.refresh(); assert.equal(workspace.catalog().length, 3); assert.equal(history.size, 0); const selected = workspace.entry("c"); assert.equal(selected.getSnapshot().entry!.session, "c"); assert.throws(() => workspace.entry("a"), { code: "FULL" }); assert.equal(workspace.catalog().length, 3); assert.equal(history.size, 0); } finally { workspace.close(); sessions.close(); await f.dispose(); }
});


test("catalog admission waits older list I/O then reads one fresh baseline to recover the disconnected row gap", async () => {
  const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), sessions = new SessionWorkspace({ history, port: new ClientFixture() });
  const original = request(), first: CatalogEntry = { scope, session: original.session, target: original.target, createId: original.id, version: 1, revision: 1, metadata: original.metadata, binding: null }, added = { ...first, session: "b", createId: "create-b" };
  const held = defer<void>(); let rows: readonly CatalogEntry[] = [first], reads = 0, active = 0, peak = 0;
  const port: CatalogPort = {
    async list() { const captured = rows; reads++; active++; peak = Math.max(peak, active); try { if (reads === 1) await held.promise; return captured; } finally { active--; } },
    get: async () => null, creation: async () => { throw Error("No original exists"); }, create: async () => { throw Error("No replay"); }, rename: async () => { throw Error("No mutation"); }, setWatched: async () => { throw Error("No mutation"); }, metadataOriginal: async () => null, subscribe: () => () => {},
  };
  const workspace = new CatalogWorkspace({ scope, port, sessions });
  try {
    const older = workspace.refresh(); await until(() => reads === 1); workspace.setConnected(false); rows = [first, added]; workspace.setConnected(true);
    const recovery = workspace.reobserve(), duplicate = workspace.reobserve(); await Promise.resolve(); assert.equal(reads, 1);
    held.resolve(); await Promise.all([older, recovery, duplicate]); assert.equal(reads, 2); assert.equal(peak, 1); assert.deepEqual(workspace.catalog().map(row => row.session), ["a", "b"]); assert.equal(history.size, 0);
  } finally { held.resolve(); workspace.close(); sessions.close(); }
});

test("catalog recovery reads the exact receipt while original Create is held and skips terminal creations afterward", async () => {
  const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), sessions = new SessionWorkspace({ history, port: new ClientFixture() }), original = request();
  const binding = { kind: "codex" as const, placement: "shared" as const, generation: 1, nativeSession: "native-a" }, entry: CatalogEntry = { scope, session: original.session, target: original.target, createId: original.id, version: 2, revision: 2, metadata: original.metadata, binding };
  const creation: Creation = { original, entry, native: binding, publication: "committed", state: "nativeCreated" }, held = defer<void>(); let creates = 0, receipts = 0, settled = false;
  const port: CatalogPort = { list: async () => [], get: async () => null, async creation(s, id) { assert.deepEqual(s, scope); assert.equal(id, original.id); receipts++; return creation; }, async create(value) { assert.deepEqual(value, original); creates++; await held.promise; return creation; }, rename: async () => { throw Error("No mutation"); }, setWatched: async () => { throw Error("No mutation"); }, metadataOriginal: async () => null, subscribe: () => () => {} };
  const workspace = new CatalogWorkspace({ scope, port, sessions }), pending = workspace.create(original); void pending.then(() => { settled = true; });
  try {
    await until(() => creates === 1); workspace.setConnected(false); workspace.setConnected(true); await workspace.reobserve();
    assert.equal(settled, false); assert.equal(receipts, 1); assert.equal(workspace.entry("a").getSnapshot().creation?.state, "nativeCreated");
    await workspace.reobserve(); assert.equal(receipts, 1); assert.equal(creates, 1); held.resolve(); await pending; assert.equal(settled, true); assert.equal(history.size, 0);
  } finally { held.resolve(); await pending; workspace.close(); sessions.close(); }
});
