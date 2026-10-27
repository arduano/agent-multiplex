import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHost } from "../../v8-lifecycle-default/src/session/index.js";
import { SessionWorkspace } from "../src/client/index.js";
import { SessionError, type Harness, type ManagedPolicy, type SessionPort, type SessionScope } from "../src/contracts/types.js";
import { FixturePool, ProcessFixturePort } from "./process-fixture.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { ScriptedLink } from "../../v8-history/src/scripted/link.js";
import { createCodexCodec } from "../../v8-history/src/native/codex/index.js";
import { createCopilotCodec } from "../../v8-history/src/native/copilot/index.js";
import type { Scope } from "../../v8-history/src/contracts/types.js";
import { FileHost } from "../../v8-files/src/host/index.js";
import { FileWorkspace } from "../../v8-files/src/client/workspace.js";
import { MemoryDraftPersistence } from "../../v8-files/src/client/persistence.js";

function historyScope(kind: Harness, scope: SessionScope, generation = 1): Scope {
  const origin = { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: `fixture-${scope.session}`, attachment: String(generation) };
  return kind === "codex" ? { kind, origin, threadId: origin.nativeSession } : { kind, origin, agentId: null };
}
function capture(kind: Harness, scope: Scope, hub: HistoryHub): void {
  if (kind === "codex") {
    const codec = createCodexCodec({ origin: scope.origin, capture: hub, rootThreadId: scope.origin.nativeSession, knownStart: true });
    codec.observe({ method: "turn/started", params: { threadId: scope.origin.nativeSession, turn: { id: "turn", status: "inProgress", items: [], itemsView: "notLoaded" } } });
    codec.observe({ method: "item/completed", params: { threadId: scope.origin.nativeSession, turnId: "turn", item: { type: "agentMessage", id: "answer", text: "retained answer" } } });
  } else {
    const codec = createCopilotCodec({ origin: scope.origin, capture: hub, knownStart: true });
    codec.observe({ id: "start", type: "assistant.turn_start", data: { turnId: "turn" }, parentId: null, timestamp: "2026-10-23T00:00:00Z" });
    codec.observe({ id: "answer", type: "assistant.message", data: { messageId: "answer", content: "retained answer" }, parentId: null, timestamp: "2026-10-23T00:00:01Z" });
  }
}
for (const kind of ["codex", "copilot"] as const) test(`${kind}: durable session Stop/Resume composes with actual retained history/files and preserves shared peers`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-session-composition-"));
  const pool = await FixturePool.open();
  const cleanups: (() => void | Promise<void>)[] = [];
  try {
  const a: SessionScope = { connection: "fixture", principal: "owner", host: kind, session: "root-a" };
  const b: SessionScope = { ...a, session: "root-b" };
  const nativeA = new ProcessFixturePort(kind, "shared", pool), nativeB = new ProcessFixturePort(kind, "shared", pool);
  const policy: ManagedPolicy = kind === "codex" ? { kind, access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" } : { kind, permissions: "manual", provider: "copilot-only" };
  const hostA = await SessionHost.open({ directory: join(directory, "a"), scope: a, port: nativeA, policy, observationMs: 5000 });
  cleanups.push(() => hostA.terminate());
  const hostB = await SessionHost.open({ directory: join(directory, "b"), scope: b, port: nativeB, policy, observationMs: 5000 });
  cleanups.push(() => hostB.terminate());
  const hosts = new Map([[a.session, hostA], [b.session, hostB]]);
  const hostFor = (scope: SessionScope) => { const value = hosts.get(scope.session); if (!value) throw new SessionError("FENCED"); return value; };
  let dropped = false;
  const port: SessionPort = {
    snapshot: scope => hostFor(scope).snapshot(scope), receipt: (scope, id) => hostFor(scope).receipt(scope, id),
    subscribe: (scope, listener) => hostFor(scope).subscribe(scope, listener),
    submit: async request => { const receipt = await hostFor(request.scope).submit(request); if (request.id === "original-send" && !dropped) { dropped = true; throw new SessionError("IO", "Fixture dropped original reply"); } return receipt; },
  };
  const history = new HistoryWorkspace({ connection: a.connection, principal: a.principal });
  const fileScope = { ...a, session: `fixture-${a.session}` };
  const files = await FileHost.open({ directory: join(directory, "files"), bindings: [{ scope: fileScope, cwd: directory, dialect: "posix" }] });
  cleanups.push(() => files.close());
  const fileWorkspace = new FileWorkspace({ history, persistence: new MemoryDraftPersistence(), port: files });
  cleanups.push(() => fileWorkspace.close());
  const workspace = new SessionWorkspace({ history, files: fileWorkspace, port });
  cleanups.push(() => workspace.close());
  const ha = historyScope(kind, a), hb = historyScope(kind, b), hub = new HistoryHub();
  hub.open(ha, { knownStart: true });
  const link = new ScriptedLink(hub, history, ha);
  cleanups.push(() => link.disconnect());
    await workspace.bind(a, ha); await workspace.bind(b, hb);
    assert.equal(nativeA.starts + nativeB.starts, 0);
    await workspace.request(a, { type: "create" }, "create-a").result;
    await workspace.request(b, { type: "create" }, "create-b").result;
    await workspace.rebind(a, ha); await workspace.rebind(b, hb);
    await fileWorkspace.bind(fileScope, ha);
    const draft = await fileWorkspace.saveDraft(fileScope, { id: "input", name: "input.txt", mediaType: "text/plain", blob: new Blob(["original file"]) });
    await fileWorkspace.upload(fileScope, draft.manifest.id);
    await files.call("protect", { scope: fileScope, operationId: "original-send", artifactIds: ["input"], consumers: ["native-consumer"] });
    await assert.rejects(workspace.request(a, { type: "send", text: "original Send" }, "original-send").result, { code: "IO" });
    await fileWorkspace.recordRequest(fileScope, "input", "original-send");
    assert.equal(nativeA.invokes, 1);
    const selected = workspace.select(a); workspace.setPinned(a, true); history.session(ha).setDraft("later draft");
    link.connect(); await link.disconnect(); workspace.setConnected(false); selected.release(); workspace.select(b);
    capture(kind, ha, hub);
    workspace.setConnected(true); await workspace.refresh(a); await workspace.checkReceipt(a, "original-send");
    link.connect(); workspace.select(a);
    assert.equal(nativeA.invokes, 1); assert.equal((await hostA.receipt(a, "original-send"))!.state, "acknowledged");
    assert.equal(history.session(ha).draft, "later draft"); assert.equal(history.session(ha).pinned, true);
    assert.ok(history.session(ha).client.view().getSnapshot().rows.some(row => row.kind === "assistant" && row.body.kind !== "unavailable" && row.body.text === "retained answer"));
    assert.equal(workspace.entry(a).getSnapshot().active, true); assert.equal((await hostA.snapshot(a)).activity, "idle");
    await workspace.request(a, { type: "stop" }, "stop-a").result;
    assert.equal((await hostA.snapshot(a)).phase, "stopped"); assert.equal(workspace.entry(a).getSnapshot().active, false);
    assert.equal((await hostB.snapshot(b)).phase, "running");
    const held = await files.call("acquire", { scope: fileScope, id: "input" }); await files.call("release", { scope: fileScope, leaseId: held.leaseId });
    await link.disconnect();
    await workspace.request(a, { type: "resume" }, "resume-a").result;
    assert.equal(nativeA.starts, 2); assert.equal(nativeA.invokes, 1); // Resume opens and waits, no input replay.
    const next = historyScope(kind, a, 2); await workspace.rebind(a, next);
    assert.equal(workspace.entry(a).getSnapshot().native!.generation, 2); assert.equal(history.session(next).draft, "later draft");
    assert.equal(history.session(next).client.view().getSnapshot().includesPriorGeneration, true);
    assert.equal((await hostA.receipt(a, "original-send"))!.generation, 1);
    await workspace.request(a, { type: "stop" }, "stop-a-2").result;
    await workspace.request(b, { type: "stop" }, "stop-b").result;
    assert.deepEqual(link.counters, { nativeBodyReads: 0, nativeMetadataReads: 0, nativeStops: 0 });
    assert.equal((await files.call("status", { scope: fileScope, id: "input" })).state, "committed");
  } finally {
    const failures: unknown[] = [];
    for (const close of [() => pool.forceOwnGroup(), ...cleanups.reverse(), () => rm(directory, { recursive: true, force: true })]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Owned composition cleanup failed");
  }
});
