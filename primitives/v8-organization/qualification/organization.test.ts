import assert from "node:assert/strict";
import test from "node:test";
import { CatalogWorkspace } from "../../v8-catalog/src/client/workspace.js";
import { catalogKey, type CatalogEntry, type CatalogPort, type CatalogScope } from "../../v8-catalog/src/contracts/types.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { SessionWorkspace } from "../../v8-session/src/client/workspace.js";
import { ClientFixture } from "../../v8-session/qualification/client-fixture.js";
import { pinStorageKey, queryCatalog, SessionPins, type PinStorage } from "../src/index.js";

const scope: CatalogScope = { connection: "connection", principal: "principal", authority: "authority" };
const row = (session: string, name: string | null = session, kind: "codex" | "copilot" = "codex", host = "host"): CatalogEntry => ({
  scope, session, target: { kind, host, owner: "owner", placement: "shared" }, createId: `create-${session}`, version: 1, revision: 1,
  metadata: { name, cwd: `/work/${session}` }, binding: { kind, placement: "shared", generation: 1, nativeSession: `native-${session}` },
});
class Storage implements PinStorage {
  readonly values = new Map<string, string>(); writes = 0; fail = false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.writes++; if (this.fail) throw new Error("unavailable"); this.values.set(key, value); }
  seed(ids: readonly string[], recordScope = scope): void { this.values.set(pinStorageKey(scope), JSON.stringify({ version: 1, scope: recordScope, pinned: ids })); }
}
function fixture(maxSessions = 8) {
  let values: readonly CatalogEntry[] = []; let effects = 0;
  const port: CatalogPort = {
    async list(s) { assert.equal(catalogKey(s), catalogKey(scope)); return values; },
    async get(s, session) { assert.equal(catalogKey(s), catalogKey(scope)); return values.find(entry => entry.session === session) ?? null; },
    async create() { effects++; throw new Error("organization cannot create"); }, async creation() { return null; },
    async rename() { effects++; throw new Error("organization cannot rename"); }, subscribe() { return () => {}; },
    async setWatched() { effects++; throw new Error("organization cannot change watched metadata"); }, async metadataOriginal() { return null; },
  };
  const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal, maxSessions }), native = new ClientFixture();
  const sessions = new SessionWorkspace({ history, port: native, maxSessions }), catalog = new CatalogWorkspace({ scope, port, sessions, maxSessions });
  return { history, native, sessions, catalog, get effects() { return effects; },
    async load(entries: readonly CatalogEntry[]) { values = entries; await catalog.refresh(); },
    async bind(session: string) {
      const entry = catalog.catalog().find(value => value.session === session)!;
      const s = { connection: scope.connection, principal: scope.principal, session, host: entry.target.host };
      native.add(s, entry.target.kind);
      const origin = { connection: scope.connection, principal: scope.principal, host: s.host, nativeSession: `native-${session}`, attachment: `attachment-${session}` };
      const attachment = entry.target.kind === "codex" ? { kind: "codex" as const, origin, threadId: origin.nativeSession } : { kind: "copilot" as const, origin, agentId: null };
      return { bound: await catalog.bindNative(session, attachment), attachment, scope: s };
    }, close() { catalog.close(); sessions.close(); },
  };
}

test("metadata query has a deterministic total order, bounded pages, exact filters and observed-only coverage", async () => {
  const f = fixture(1);
  try {
    const entries = [row("z", "same"), row("b", "same", "copilot", "other"), row("a", "same"), { ...row("unbound", null), binding: null }];
    await f.load(entries); const result = queryCatalog(f.catalog.catalog(), scope, { sort: "name", limit: 2 }, ["z", "missing"]);
    assert.equal(result.coverage, "observed"); assert.deepEqual(result.rows.map(value => value.entry.session), ["a", "b"]); assert.equal(result.nextOffset, 2); assert.deepEqual(result.unobservedPinned, ["missing"]);
    assert.deepEqual(queryCatalog([...entries].reverse(), scope, { sort: "name", pinnedFirst: true }, ["z"]).rows.map(value => value.entry.session), ["z", "a", "b", "unbound"]);
    assert.deepEqual(queryCatalog(entries, scope, { text: " /WORK/B ", kind: "copilot", host: "other", binding: "bound" }).rows.map(value => value.entry.session), ["b"]);
    assert.deepEqual(queryCatalog(entries, scope, { binding: "unbound" }).rows.map(value => value.entry.session), ["unbound"]);
    await f.load([]); assert.equal(queryCatalog(f.catalog.catalog(), scope).totalObserved, 4, "missing refresh is not deletion proof");
    assert.equal(f.history.size, 0); assert.equal(f.effects, 0); assert.equal(f.native.submitted.length, 0);
  } finally { f.close(); }
});
test("query rejects cross-scope and duplicate identities instead of mixing namespaces or picking a winner", () => {
  assert.throws(() => queryCatalog([{ ...row("a"), scope: { ...scope, principal: "other" } }], scope), { code: "FENCED" });
  assert.throws(() => queryCatalog([row("a"), row("a")], scope), { code: "CONFLICT" });
  assert.throws(() => queryCatalog([row("a")], scope, { limit: 101 }), { code: "INVALID" });
});
test("pins hold actual retained background references across A/B/A, offline and unmount without native effects", async () => {
  const f = fixture(); const storage = new Storage(); const pins = new SessionPins({ catalog: f.catalog, scope, storage });
  try {
    await f.load([row("a"), row("b", "B", "copilot")]);
    const a = await f.bind("a"), b = await f.bind("b");
    a.bound.history.setDraft({ text: "retained", files: ["file-intent"] }); a.bound.history.recordOperation("original", { text: "original Send" });
    assert.deepEqual(pins.setPinned("a", true), { persistence: "saved" });
    assert.equal(a.bound.history.backgroundReferenceHeld, true); assert.equal(a.bound.history.observationReferences, 1);
    const old = f.history.select(a.attachment); f.history.select(b.attachment); const current = f.history.select(a.attachment); old.release();
    assert.equal(a.bound.history.mountedReferences, 1); assert.equal(a.bound.history.observationReferences, 2);
    current.release(); f.catalog.setConnected(false);
    assert.equal(a.bound.history.observationReferences, 1); assert.deepEqual(pins.snapshot(), [{ session: "a", retention: "background" }]);
    assert.deepEqual(a.bound.history.draft, { text: "retained", files: ["file-intent"] }); assert.equal(a.bound.history.operations[0]!.settled, false);
    pins.setPinned("a", false); assert.equal(a.bound.history.observationReferences, 0); assert.equal(a.bound.history.operations.length, 1);
    assert.equal(f.history.size, 2); assert.equal(f.native.submitted.length, 0); assert.equal(f.effects, 0);
  } finally { f.close(); }
});
test("unbound pin is provisional and transfers into actual workspace only after native binding proof", async () => {
  const f = fixture(); const pins = new SessionPins({ catalog: f.catalog, scope });
  try {
    pins.setPinned("a", true); assert.deepEqual(pins.snapshot(), [{ session: "a", retention: "provisional" }]); assert.equal(f.history.size, 0);
    await f.load([row("a")]); const a = await f.bind("a"); f.native.publish(a.scope, { phase: "stopped" });
    assert.equal(a.bound.history.backgroundReferenceHeld, true); assert.deepEqual(pins.snapshot(), [{ session: "a", retention: "background" }]); assert.equal(f.native.submitted.length, 0, "pin never resumes a stopped session");
  } finally { f.close(); }
});
test("storage failures report applied visit-only pin; retention capacity failure never claims persistence or compensates", () => {
  const f = fixture(1), storage = new Storage(), pins = new SessionPins({ catalog: f.catalog, scope, storage });
  try {
    storage.fail = true; assert.deepEqual(pins.setPinned("a", true), { persistence: "unavailable" }); assert.equal(f.catalog.entry("a").getSnapshot().pinned, true);
    const before = storage.writes; assert.throws(() => pins.setPinned("b", true), { code: "FULL" }); assert.equal(storage.writes, before);
    assert.deepEqual(pins.snapshot(), [{ session: "a", retention: "provisional" }]); assert.equal(f.catalog.entry("a").getSnapshot().pinned, true);
  } finally { f.close(); }
});
test("restore exposes partial retention and preserves failed desired pins and protected existing pins", () => {
  const f = fixture(1), storage = new Storage(), pins = new SessionPins({ catalog: f.catalog, scope, storage, maxPins: 3 });
  try {
    pins.setPinned("a", true); f.catalog.setDraft("a", "keep me"); storage.seed(["b"]);
    assert.deepEqual(pins.restore(), { state: "partial", applied: [], blocked: ["b"] });
    assert.deepEqual(pins.snapshot(), [{ session: "a", retention: "provisional" }, { session: "b", retention: "notHeld" }]);
    pins.setPinned("a", true); assert.deepEqual(JSON.parse(storage.getItem(pinStorageKey(scope))!).pinned, ["a", "b"], "unrelated save preserves unresolved preference");
    pins.setPinned("b", false); assert.equal(f.catalog.entry("a").getSnapshot().pinned, true); assert.equal(f.catalog.entry("a").getSnapshot().draft, "keep me");
    assert.equal(f.history.size, 0); assert.equal(f.native.submitted.length, 0);
  } finally { f.close(); }
});
test("foreign, malformed and oversized preference records fail before any retained workspace effect", () => {
  const f = fixture(), storage = new Storage(), pins = new SessionPins({ catalog: f.catalog, scope, storage });
  try {
    assert.notEqual(pinStorageKey(scope), pinStorageKey({ ...scope, authority: "other" }));
    storage.seed(["a"], { ...scope, principal: "other" }); assert.equal(pins.restore().state, "invalid");
    storage.seed(["a", "a"]); assert.equal(pins.restore().state, "invalid");
    storage.seed(Array.from({ length: 9 }, (_, i) => `session-${i}`)); assert.equal(pins.restore().state, "invalid");
    assert.deepEqual(pins.snapshot(), []); assert.equal(f.history.size, 0); assert.equal(storage.writes, 0);
  } finally { f.close(); }
});
test("an empty or partial catalog still proves its exact preference namespace", async () => {
  const f = fixture();
  try {
    assert.throws(() => new SessionPins({ catalog: f.catalog, scope: { ...scope, principal: "other" } }), { code: "FENCED" });
    await f.load([row("a")]); await f.load([]);
    assert.throws(() => new SessionPins({ catalog: f.catalog, scope: { ...scope, authority: "other" } }), { code: "FENCED" });
    const observedScope = f.catalog.getScope(); assert.deepEqual(observedScope, scope); assert.equal(Object.isFrozen(observedScope), true);
    assert.equal(f.history.size, 0); assert.equal(f.native.submitted.length, 0);
  } finally { f.close(); }
});
test("restore refuses an over-budget union atomically instead of dropping an already protected preference", () => {
  const f = fixture(), storage = new Storage(), pins = new SessionPins({ catalog: f.catalog, scope, storage, maxPins: 1 });
  try {
    pins.setPinned("a", true); storage.seed(["b"]); const writes = storage.writes;
    assert.deepEqual(pins.restore(), { state: "partial", applied: [], blocked: ["b"] });
    assert.deepEqual(pins.snapshot(), [{ session: "a", retention: "provisional" }]); assert.equal(storage.writes, writes);
    assert.deepEqual(JSON.parse(storage.getItem(pinStorageKey(scope))!).pinned, ["b"], "saved intent stays available for an explicit retry");
    assert.equal(f.catalog.entry("a").getSnapshot().pinned, true); assert.equal(f.native.submitted.length, 0);
  } finally { f.close(); }
});
