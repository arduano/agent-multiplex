import assert from "node:assert/strict";
import test from "node:test";
import { activateHost, defineHost, HostActivationError, hostProcedure, hostRouter, updateHost } from "../src/index.js";
import { context, fixture, route } from "./fixtures.js";

test("static composition is inert; exact plugin router dispatch retains public shape", async () => {
  const f = fixture();
  assert.equal(f.state().opens, 0);
  const host = await activateHost(f.definition, { route, storage: { privateSecret: "must-not-project" }, authenticate: () => context });
  assert.equal(f.state().opens, 1);
  const ctx = await host.context({ proof: {}, expected: host.manifest });
  const caller = host.router.createCaller(ctx);
  assert.deepEqual(await caller.extensions.workspace.inspect(), { directory: "directory", bytes: 42 });
  assert.equal(await caller.harness.thinking({ effort: "high" }), "high");
  assert.equal((await caller.system.manifest()).compositionId, host.manifest.compositionId);
  assert(!JSON.stringify(host.manifest).includes("must-not-project"));
  await host.close();
  await host.close();
  assert.equal(f.state().closes, 1);
  await assert.rejects(host.context({ proof: {}, expected: host.manifest }), /closed/);
});

test("wrong contract, route, session and permission never reach plugin behavior", async () => {
  const f = fixture();
  let verified = context;
  const host = await activateHost(f.definition, { route, storage: {}, authenticate: () => verified });
  await assert.rejects(host.context({ proof: {}, expected: { ...host.manifest, compositionId: "other" } }), /composition mismatch/);
  verified = { ...context, route: { ...route, routeEpoch: "old" } };
  await assert.rejects(host.context({ proof: {}, expected: host.manifest }), /scope denied/);
  verified = { ...context, session: { id: "session", generation: 1 } };
  await assert.rejects(host.context({ proof: {}, expected: host.manifest, session: { id: "session", generation: 2 } }), /scope denied/);
  await assert.rejects(host.context({ proof: {}, expected: host.manifest }), /Unexpected session/);
  await assert.rejects(host.context({ proof: {}, expected: host.manifest, session: { id: "session", generation: Number.NaN } }), /Invalid session/);
  const scoped = await host.context({ proof: {}, expected: host.manifest, session: verified.session! });
  const readOnly = host.router.createCaller({ ...scoped, identity: { ...scoped.identity, actions: ["read"] } });
  await assert.rejects(readOnly.extensions.workspace.claim.submit({ id: "request-1", input: { label: "claim" } }), /denied/);
  assert.equal(f.state().effects, 0);
  await host.close();
});

test("contribution conflicts, missing capability and incompatible custody records fail before open", async () => {
  const f = fixture();
  assert.throws(() => defineHost({ ...f.definition, harness: { ...f.definition.harness, contributions: [{ namespace: "mcp", key: "tool" }, { namespace: "mcp", key: "tool" }] } }), /Duplicate/);
  const missing = defineHost({ contract: f.definition.contract, harness: f.definition.harness, lifecycle: () => ({ ...f.definition.lifecycle({ harness: f.definition.harness, storage: {} }), requires: ["unavailable"] }) });
  await assert.rejects(activateHost(missing, { route, storage: {}, authenticate: () => context }), /Missing harness capability/);
  await assert.rejects(activateHost(f.definition, { route, storage: {}, authenticate: () => context, records: [{ kind: "lifecycle", identity: { id: "different", version: 1, recordVersion: 1 } }] }), /incompatible/);
  assert.equal(f.state().opens, 0);
});

test("invalid extension activation closes selected owner and never publishes host", async () => {
  const f = fixture();
  const bad = defineHost({ ...f.definition, extensions: () => ({ system: { identity: { id: "bad", version: 1, recordVersion: 1 }, public: f.definition.lifecycle({ harness: f.definition.harness, storage: {} }).public, router: hostRouter({}), readiness: () => ({ ready: true as const }), close() {} } }) });
  await assert.rejects(activateHost(bad, { route, storage: {}, authenticate: () => context }), /Reserved/);
  assert.deepEqual(f.state(), { opens: 1, closes: 1, effects: 0 });
});

test("original helper delegates one admission and exact lookup without another journal", async () => {
  const f = fixture();
  const host = await activateHost(f.definition, { route, storage: {}, authenticate: () => context });
  const caller = host.router.createCaller(await host.context({ proof: {}, expected: host.manifest }));
  await caller.extensions.workspace.claim.submit({ id: "request-1", input: { label: "original" } });
  // Simulate a lost observation: recover only the original, never submit another id.
  assert.deepEqual(await caller.extensions.workspace.claim.original({ id: "request-1" }), { id: "request-1", label: "original" });
  assert.equal(await caller.extensions.workspace.claim.original({ id: "absent" }), null);
  await caller.extensions.workspace.claim.submit({ id: "request-1", input: { label: "original" } });
  await assert.rejects(caller.extensions.workspace.claim.submit({ id: "request-1", input: { label: "changed" } }), /conflict/);
  assert.equal(f.state().effects, 1);
  await host.close();
});

test("restart-only update refuses unsettled custody and never resumes stopped sessions", async () => {
  const f = fixture(), next = fixture();
  const host = await activateHost(f.definition, { route, storage: {}, authenticate: () => context });
  f.setReady({ ready: false, reasons: ["session running", "allocation outcome unknown"] });
  await assert.rejects(updateHost(host, next.definition, { route, storage: {}, authenticate: () => context }), /settle custody/);
  assert.equal(next.state().opens, 0);
  assert.equal(f.state().closes, 0);
  f.setReady({ ready: true });
  const updated = await updateHost(host, next.definition, { route, storage: {}, authenticate: () => context });
  assert.equal(f.state().closes, 1);
  assert.equal(next.state().opens, 1);
  assert.deepEqual(await updated.router.createCaller(context).lifecycle.snapshot(), { phase: "stopped" });
  await updated.close();
});

test("retired contexts, late authentication and admitted async calls cannot bypass the update fence", async () => {
  let resolveAuth!: (value: typeof context) => void;
  const auth = new Promise<typeof context>(resolve => { resolveAuth = resolve; });
  const initial = fixture();
  const first = await activateHost(initial.definition, { route, storage: {}, authenticate: () => auth });
  const pendingContext = first.context({ proof: {}, expected: first.manifest });
  await first.close(); resolveAuth(context);
  await assert.rejects(pendingContext, /closed/);

  let entered!: () => void, release!: () => void, effects = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture();
  const definition = defineHost({ ...f.definition, extensions: () => ({ delayed: {
    identity: { id: "delayed", version: 1, recordVersion: 1 }, public: f.definition.lifecycle({ harness: f.definition.harness, storage: {} }).public,
    readiness: () => ({ ready: true as const }), close() {},
    router: hostRouter({ hold: hostProcedure.mutation(async () => { effects++; entered(); await gate; return "done"; }) }),
  } }) });
  const host = await activateHost(definition, { route, storage: {}, authenticate: () => context });
  const caller = host.router.createCaller(await host.context({ proof: {}, expected: host.manifest }));
  const work = caller.extensions.delayed.hold(); await started;
  assert.equal((await host.readiness()).ready, false);
  await assert.rejects(host.close(), /procedures still admitted/);
  assert.equal(f.state().closes, 0);
  release(); assert.equal(await work, "done");
  await host.close();
  await assert.rejects(caller.extensions.delayed.hold(), /admission is closed/);
  assert.equal(effects, 1);
});

test("failed extension close remains unsafe and never silently succeeds on a subsequent update", async () => {
  const f = fixture(), next = fixture(); let closes = 0;
  const definition = defineHost({ ...f.definition, extensions: () => ({ domain: {
    identity: { id: "domain", version: 1, recordVersion: 1 }, public: f.definition.lifecycle({ harness: f.definition.harness, storage: {} }).public,
    readiness: () => ({ ready: true as const }), close() { closes++; throw new Error("Native domain custody unproved"); }, router: hostRouter({}),
  } }) });
  const host = await activateHost(definition, { route, storage: {}, authenticate: () => context });
  await assert.rejects(host.close(), /custody unproved/);
  assert.deepEqual(await host.readiness(), { ready: false, reasons: ["Host is failed"] });
  await assert.rejects(host.close(), /custody unproved/);
  await assert.rejects(updateHost(host, next.definition, { route, storage: {}, authenticate: () => context }), /settle custody/);
  assert.equal(next.state().opens, 0); assert.equal(f.state().closes, 0); assert.equal(closes, 1);
});

test("failed composition retains every returned owner before validation and exposes only the exact definition's lifecycle controls", async () => {
  const f = fixture(), closes: string[] = [];
  f.setReady({ ready: false, reasons: ["native custody retained"] });
  const extension = (name: string) => ({
    identity: { id: name, version: 1, recordVersion: 1 }, public: f.definition.lifecycle({ harness: f.definition.harness, storage: {} }).public,
    router: hostRouter({}), readiness: () => ({ ready: true as const }), close() { closes.push(name); },
  });
  const definition = defineHost({ ...f.definition, extensions: () => ({ system: extension("first-invalid-key"), later: extension("later-returned-owner") }) });
  let error: unknown;
  try { await activateHost(definition, { route, storage: {}, authenticate: () => context }); } catch (failure) { error = failure; }
  assert.ok(error instanceof HostActivationError);
  const recovery = error.recoveryFor(definition); assert.ok(recovery);
  assert.equal(recovery.sessions.publicValue, "directory");
  assert.equal(error.recoveryFor({ ...definition }), null, "matching metadata does not transfer custody");
  assert.deepEqual([...recovery.extensions.keys()], ["system", "later"]);
  await assert.rejects(recovery.close(), /unsettled/);
  assert.deepEqual(closes, []); assert.equal(f.state().closes, 0);
  // This is the actual selected lifecycle's existing control, never a kernel
  // invented Stop or automatic recovery action.
  recovery.sessions.setReady({ ready: true });
  await recovery.close(); await recovery.close();
  assert.deepEqual(closes, ["later-returned-owner", "first-invalid-key"]);
  assert.equal(f.state().opens, 1); assert.equal(f.state().closes, 1);
});

test("activation cleanup failure retains failed and dependent owners without replaying close or reopening lifecycle", async () => {
  const f = fixture(); let successfulCloses = 0, failedCloses = 0;
  const extension = (name: string, close: () => void) => ({
    identity: { id: name, version: 1, recordVersion: 1 }, public: f.definition.lifecycle({ harness: f.definition.harness, storage: {} }).public,
    router: hostRouter({}), readiness: () => ({ ready: true as const }), close,
  });
  const definition = defineHost({ ...f.definition, extensions: () => ({
    retained: extension("retained", () => { failedCloses++; throw Error("domain cleanup unproved"); }),
    released: extension("released", () => { successfulCloses++; }),
  }), harnessRouter() { throw Error("router composition failed"); } });
  let error: unknown;
  try { await activateHost(definition, { route, storage: {}, authenticate: () => context }); } catch (failure) { error = failure; }
  assert.ok(error instanceof HostActivationError);
  const recovery = error.recoveryFor(definition); assert.ok(recovery);
  assert.deepEqual([...recovery.extensions.keys()], ["retained"]);
  (recovery.extensions as Map<string, unknown>).clear();
  assert.equal(recovery.extensions.size, 1);
  assert.deepEqual(await recovery.readiness(), { ready: false, reasons: ["Host owner cleanup unproved"] });
  await assert.rejects(recovery.close(), /domain cleanup unproved/);
  assert.equal(failedCloses, 1); assert.equal(successfulCloses, 1);
  assert.equal(f.state().closes, 0, "lifecycle dependency stays open while its extension owns unproved custody");
  assert.equal(f.state().opens, 1); assert.equal(recovery.sessions.publicValue, "directory");
});
