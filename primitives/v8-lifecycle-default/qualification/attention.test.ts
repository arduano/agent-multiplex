import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defaultLifecycle } from "../src/plugin.js";
import { existingDirectoryWorkspace } from "../src/workspace.js";
import { readJournalFacts } from "../src/session/receipt-reader.js";
import { scriptedHost, until } from "../../v8-host/qualification/fixture.js";
import { fixture, ScriptedPort, scope as sessionScope } from "../../v8-session/qualification/host-fixture.js";
import { observedSnapshot } from "../../v8-session/src/client/validation.js";
import { scopeKey, type SessionScope, type SessionSnapshot } from "../../v8-session/src/contracts/types.js";
import { canonical } from "../../v8-session/src/contracts/validation.js";

test("attention is committed once under the current run; settings and Stop do not mint unseen markers", async () => {
  const f = await fixture(new ScriptedPort());
  try {
    await f.create(); const run = f.port.run!;
    const signal = { state: "finished", cause: { source: "codex.turn", id: "turn" } } as const;
    f.port.emit({ type: "attention", run, attention: signal });
    await until(async () => (await f.host.snapshot(sessionScope)).attention?.state === "finished");
    const first = (await f.host.snapshot(sessionScope)).attention!;
    f.port.emit({ type: "selection", run, selection: { kind: "codex", model: "model-b" } });
    f.port.emit({ type: "nativeState", run }); f.port.emit({ type: "attention", run, attention: signal });
    await until(() => !f.host.updateReadiness().reasons.includes("journal-io-unsettled"));
    assert.deepEqual((await f.host.snapshot(sessionScope)).attention, first);
    assert.ok((await f.host.snapshot(sessionScope)).revision > first.revision);
    await f.submit({ type: "stop" }); assert.deepEqual((await f.host.snapshot(sessionScope)).attention, first);
    await f.submit({ type: "resume" });
    const resumed = await f.host.snapshot(sessionScope); assert.equal(resumed.generation, 2); assert.deepEqual(resumed.attention, first);
    f.port.emit({ type: "attention", run, attention: { state: "error", cause: { source: "codex.turn", id: "old" } } });
    assert.deepEqual((await f.host.snapshot(sessionScope)).attention, first, "old generation cannot report current work");
    f.port.emit({ type: "attention", run: f.port.run!, attention: { state: "working", cause: { source: "codex.turn", id: "new" } } });
    await until(async () => (await f.host.snapshot(sessionScope)).attention?.generation === 2);
    const current = await f.host.snapshot(sessionScope); observedSnapshot(current);
    assert.throws(() => observedSnapshot({ ...current, attention: { ...current.attention!, nativeSession: "foreign" } }), { code: "INVALID" });
    assert.throws(() => observedSnapshot({ ...current, attention: { ...current.attention!, generation: 3 } }), { code: "INVALID" });
    assert.throws(() => observedSnapshot({ ...current, attention: { ...current.attention!, cause: { source: "copilot.event", id: "foreign" } } }), { code: "INVALID" });
  } finally { await f.dispose(); }
});

test("native attention persists before publication and cold saved discovery needs no writer, controller or history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-observed-attention-"));
  const scope: SessionScope = { connection: "account", principal: "owner", host: "host", session: "logical" };
  const context = { route: { authority: "authority", owner: "durable-owner", host: "host", routeEpoch: "epoch" }, storage: null };
  const driver = scriptedHost("codex", { cwd: directory }); let factories = 0;
  const harness = { kind: "harness" as const, nativeKind: "codex" as const, protocol: driver.controller.protocol, identity: { id: "scripted.codex", version: 1, recordVersion: 1 }, capabilities: [], async create() { factories++; return { controller: driver.controller }; } };
  const options = { directory: join(directory, "host"), harness, workspace: existingDirectoryWorkspace(), policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } as const };
  let runtime = await defaultLifecycle(options).open(context); let detach = () => {};
  const filename = join(options.directory, "sessions", createHash("sha256").update(scopeKey(scope)).digest("hex"), "session", "session.sqlite");
  const saved = (): SessionSnapshot => { const db = new DatabaseSync(filename, { readOnly: true }); try { return JSON.parse(String(db.prepare("SELECT json FROM state").get()!.json)) as SessionSnapshot; } finally { db.close(); } };
  try {
    await runtime.sessions.create(scope, "create", { cwd: directory });
    await until(async () => (await runtime.sessions.original(scope, "create"))?.state === "acknowledged");
    const host = runtime.sessions.attached(scope)!.session;
    const published: string[] = [];
    detach = host.subscribe(scope, snapshot => { if (snapshot.attention) published.push(canonical(saved().attention)); });
    await runtime.sessions.submit({ scope, id: "send", generation: 1, command: { type: "send", text: "scripted attention" } });
    await until(async () => (await host.snapshot(scope)).attention?.state === "finished");
    await until(() => !host.updateReadiness().reasons.some(reason => ["admitted-work-unsettled", "journal-io-unsettled"].includes(reason)));
    const final = (await host.snapshot(scope)).attention!;
    assert.ok(published.includes(canonical(final)), "durable saved marker already exists at publication");
    assert.deepEqual(saved().attention, final);
    assert.equal(runtime.sessions.list()[0]!.attention, undefined, "live fact has one projection under native");
    await runtime.sessions.submit({ scope, id: "stop", generation: 1, command: { type: "stop" } });
    await until(() => runtime.readiness().ready); detach(); await runtime.close();
    const epoch = saved().epoch;
    const identity = { lifecycle: { id: "multiplex.default-lifecycle", recordVersion: 1 }, harness: { id: harness.identity.id, recordVersion: 1 }, workspace: { id: "multiplex.existing-directory", recordVersion: 1 } };
    assert.deepEqual(readJournalFacts(filename, scope, identity)?.attention, final);
    assert.throws(() => readJournalFacts(filename, { ...scope, principal: "foreign" }, identity), { code: "FENCED" });
    runtime = await defaultLifecycle(options).open(context);
    assert.equal(runtime.sessions.list()[0]!.native, null); assert.deepEqual(runtime.sessions.list()[0]!.attention, final);
    assert.equal(factories, 1); assert.equal(driver.counts.bodyReads, 0); assert.equal(driver.counts.resumes, 0);
    assert.equal(saved().epoch, epoch, "cold list did not acquire a writer or advance provenance");
  } finally { detach(); await runtime.sessions.terminate(); await rm(directory, { recursive: true, force: true }); }
});
