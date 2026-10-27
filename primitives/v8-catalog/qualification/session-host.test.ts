import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { SessionHost } from "../../v8-lifecycle-default/src/session/index.js";
import { ScriptedPort } from "../../v8-session/qualification/host-fixture.js";
import { sessionCreationHost } from "../../v8-lifecycle-default/src/catalog.js";
import { sessionScope } from "../src/contracts/types.js";
import type { Creation } from "../src/contracts/types.js";
import { fixture, request, scope, defer } from "./fixtures.js";
test("real SessionHost durable create receipt bridges Codex/Copilot identities; read never opens or starts native", async () => {
  for (const kind of ["codex", "copilot"] as const) {
    const f = await fixture(); const r = { ...request(), target: { ...request().target, kind }, selection: { kind, model: "model-a" } }; const native = new ScriptedPort(kind); let host: SessionHost | undefined; const modes: string[] = []; let cwd = ""; const published = defer<void>(), acknowledged = defer<void>();
    const off = f.authority.subscribe(scope, entry => { if (entry.session === r.session && entry.binding) published.resolve(); });
    try { f.authority.register(sessionCreationHost({ target: r.target, async resolve(original, mode) { modes.push(mode); cwd = original.metadata.cwd!; if (!host && mode === "create") host = await SessionHost.open({ directory: join(f.directory, "logical-host"), scope: sessionScope(original), port: native, observationMs: 10000, policy: kind === "codex" ? { kind, access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" } : { kind, permissions: "manual", provider: "copilot-only" } }); if (host && mode === "create") host.subscribeReceipt(sessionScope(original), original.id, receipt => { if (receipt.state === "acknowledged") acknowledged.resolve(); }); return host ?? null; } }));
      await f.authority.create(r); await published.promise; await acknowledged.promise; const created = (await f.authority.creation(scope, r.id))!; assert.equal(created.state, "nativeCreated"); assert.equal(created.native!.nativeSession, "native-original"); assert.equal(cwd, "/work/original"); assert.equal(native.starts.length, 1); assert.equal("continuePendingWork" in native.starts[0]!, false); assert.equal(native.starts[0]!.policy.provider, "copilot-only"); assert.deepEqual(modes, ["read", "create"]); await f.authority.creation(scope, r.id); assert.equal(native.starts.length, 1);
    } finally { off(); await host?.terminate(); await f.dispose(); }
  }
});
test("late original creation publication after Stop/Resume accepts stable native identity, not current lifecycle generation", async () => {
  const f = await fixture(); const r = request(), native = new ScriptedPort(); let host: SessionHost | undefined;
  const unknown = defer<{ value: Creation } | { error: unknown }>(), initialized = defer<void>(), published = defer<void>();
  let allowPublication = false, observedUnknown = false;
  // Observe exact persisted creation state after catalog changes. A bounded
  // caller return can still be dispatching and is not lifecycle completion.
  const off = f.authority.subscribe(scope, entry => {
    if (entry.session !== r.session) return;
    if (entry.binding) published.resolve();
    else if (!observedUnknown) void f.authority.creation(scope, r.id).then(value => { if (value?.state === "outcomeUnknown") { observedUnknown = true; unknown.resolve({ value }); } }, error => { observedUnknown = true; unknown.resolve({ error }); });
  });
  try {
    const adapter = sessionCreationHost({ target: r.target, async resolve(original, mode) {
      if (!host && mode === "create") {
        host = await SessionHost.open({ directory: join(f.directory, "logical-host"), scope: sessionScope(original), port: native, observationMs: 10000, policy: { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" } });
        host.subscribeReceipt(sessionScope(original), original.id, receipt => { if (receipt.state === "acknowledged") initialized.resolve(); });
      }
      return host ?? null;
    } });
    f.authority.register({ target: r.target, async create(original) { await adapter.create(original); throw new Error("first publication reply lost"); }, // Keep publication deferred until the explicit post-Resume receipt read.
    // Host acknowledgement remains independently observed throughout.
    read: original => allowPublication ? adapter.read(original) : Promise.resolve({ state: "unknown" as const }) });
    await f.authority.create(r); const observed = await unknown.promise; if ("error" in observed) throw observed.error; assert.equal(observed.value.state, "outcomeUnknown"); await initialized.promise;
    const s = sessionScope(r), stopped = defer<void>(), resumed = defer<void>();
    const offStop = host!.subscribeReceipt(s, "stop", receipt => { if (receipt.state === "acknowledged") stopped.resolve(); });
    const offResume = host!.subscribeReceipt(s, "resume", receipt => { if (receipt.state === "acknowledged") resumed.resolve(); });
    try {
      await host!.submit({ scope: s, id: "stop", generation: 1, command: { type: "stop" } }); await stopped.promise;
      await host!.submit({ scope: s, id: "resume", generation: 1, command: { type: "resume" } }); await resumed.promise; assert.equal((await host!.snapshot(s)).generation, 2);
      allowPublication = true; await f.authority.creation(scope, r.id); await published.promise; const created = await f.authority.creation(scope, r.id);
      assert.equal(created!.state, "nativeCreated"); assert.equal(created!.native!.generation, 1); assert.equal(created!.native!.nativeSession, "native-original"); assert.equal(native.starts.length, 2); assert.equal(native.starts[1]!.nativeSession, "native-original");
    } finally { offStop(); offResume(); }
  } finally { off(); await host?.terminate(); await f.dispose(); }
});
