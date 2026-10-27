import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Capabilities, NativeOutcome, Receipt, SessionPort, SessionSnapshot, StopProof } from "../src/contracts/types.js";
import { createCopilotInvocation } from '../../v8-harness-copilot/src/invocation.js';
import { defer, fixture, scope, ScriptedPort, until } from "./host-fixture.js";
import { SessionWorkspace } from '../src/client/workspace.js';
import { readJournalOriginal, readJournalFacts, readJournalArchivedHistory } from "../../v8-lifecycle-default/src/session/receipt-reader.js";
import { defaultRecordIdentity, SessionJournal, sessionLimits } from "../../v8-lifecycle-default/src/session/journal.js";
import { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';

test('a final durable receipt pulses the existing session watch after the last native frame and automatically settles the exact client original', async () => {
  for (const outcome of [{ status: 'accepted' }, { status: 'refused', detail: { reason: 'native-refusal' } }] as const) {
    const port = new ScriptedPort(), invoke = defer<NativeOutcome>(), f = await fixture(port, { observationMs: 20 });
    let client: SessionWorkspace | undefined, detach = () => {};
    try {
      await f.create(); await until(async () => (await f.host.snapshot(scope)).phase === 'running'); port.invokeGate = invoke.promise;
      const snapshots: SessionSnapshot[] = [], reads: string[] = [], committed = defer<Receipt>();
      const session: SessionPort = { snapshot: value => f.host.snapshot(value), submit: value => f.host.submit(value),
        receipt: (value, id) => { reads.push(id); return f.host.receipt(value, id); },
        subscribe: (value, listener) => f.host.subscribe(value, snapshot => { snapshots.push(snapshot); listener(snapshot); }) };
      client = new SessionWorkspace({ history: new HistoryWorkspace({ connection: scope.connection, principal: scope.principal }), port: session });
      const native = port.run!;
      const entry = await client.bind(scope, { kind: 'codex', origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: native.nativeSession, attachment: 'watched' }, threadId: native.nativeSession });
      port.emit({ type: 'activity', run: native, activity: 'working' });
      const original = client.request(scope, { type: 'send', text: 'one original' }, 'late-final-original');
      assert.equal((await original.result).state, 'outcomeUnknown');
      await until(() => entry.getSnapshot().activeJobs === 0); assert.deepEqual(reads, [original.id]);
      const before = await f.host.snapshot(scope), events = snapshots.length;
      detach = f.host.subscribeReceipt(scope, original.id, receipt => { if (['acknowledged', 'refused'].includes(receipt.state)) committed.resolve(receipt); });
      invoke.resolve(outcome); const final = await committed.promise;
      const expected = outcome.status === 'refused' ? 'refused' : 'acknowledged'; assert.equal(final.state, expected);
      await until(() => entry.getSnapshot().operations[0]!.receipt?.state === expected, 2000);
      assert.deepEqual(reads, [original.id, original.id], 'only the exact original is read; no manual check/reconnect');
      const { revision: previousRevision, ...previousFacts } = before, { revision, ...facts } = await f.host.snapshot(scope);
      assert.equal(revision, previousRevision + 1); assert.deepEqual(facts, previousFacts, 'receipt progress changes no native facts'); assert.equal(snapshots.length, events + 1);
      assert.equal(port.calls.length, 1); assert.equal(port.starts.length, 1);
      client.close(); detach(); await f.submit({ type: 'stop' }); await until(() => f.host.updateReadiness().ready); await f.host.close();
    } finally { invoke.resolve(outcome); detach(); client?.close(); await f.dispose(); }
  }
});

test("archive is one stopped-only original; busy preflight leaves no seal and committed retirement never resumes", async () => {
  const released = defer<void>(); let ready = false, releases = 0;
  const f = await fixture(new ScriptedPort(), { archive: { ready: async () => ready, release: async () => { releases++; await released.promise; } } });
  try {
    await f.create(); assert.equal((await f.submit({ type: "archive" })).state, "refused");
    await f.submit({ type: "stop" }); await until(() => f.host.updateReadiness().ready);
    assert.equal((await f.submit({ type: "archive" })).state, "refused"); assert.equal((await f.host.snapshot(scope)).archive, undefined);
    ready = true;
    const request = { scope, id: "archive-original", generation: 1, command: { type: "archive" as const } };
    const first = f.host.submit(request), second = f.host.submit(request);
    await until(() => releases === 1); assert.equal(f.host.archiving, true);
    assert.equal((await f.host.snapshot(scope)).archive?.state, "pending");
    assert.equal((await f.submit({ type: "resume" })).state, "refused");
    released.resolve(); assert.equal((await first).state, "acknowledged"); assert.deepEqual(await second, await first);
    assert.equal((await f.host.snapshot(scope)).archive?.state, "complete");
    await f.reopen(); assert.equal((await f.host.snapshot(scope)).archive?.state, "complete");
    assert.equal((await f.submit({ type: "resume" })).reason, "archived");
    await until(() => f.host.updateReadiness().ready);
    assert.equal(f.port.starts.length, 1); assert.equal(releases, 1);
    const receipt = await f.host.submit(request); assert.equal(receipt.state, "acknowledged");
    await until(() => f.host.updateReadiness().ready); await f.host.close();
    const filename = join(f.directory, 'session.sqlite'), identity = defaultRecordIdentity('codex');
    assert.deepEqual(readJournalOriginal(filename, scope, request.id, identity, 1), receipt);
    assert.deepEqual(readJournalFacts(filename, scope, identity), {});
    assert.deepEqual(readJournalArchivedHistory(filename, scope, identity), { nativeSession: 'native-original', generation: 1, archiveId: request.id });
    const db = new DatabaseSync(filename);
    try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 6); db.exec('PRAGMA user_version=7'); } finally { db.close(); }
    assert.throws(() => readJournalOriginal(filename, scope, request.id, identity), { code: 'FENCED' });
    assert.throws(() => readJournalFacts(filename, scope, identity), { code: 'FENCED' });
    assert.throws(() => readJournalArchivedHistory(filename, scope, identity), { code: 'FENCED' });
  } finally { released.resolve(); await f.dispose(); }
});

test("archive seal survives a lost cleanup result; original lookup cannot retry cleanup or clear uncertainty", async () => {
  const release = defer<void>(); let releases = 0;
  const f = await fixture(new ScriptedPort(), { observationMs: 25, archive: { ready: async () => true, release: async () => { releases++; await release.promise; } } });
  try {
    await f.create(); await f.submit({ type: "stop" }); await until(() => f.host.updateReadiness().ready);
    const request = { scope, id: "lost-archive", generation: 1, command: { type: "archive" as const } };
    const pending = f.host.submit(request); await until(() => releases === 1);
    assert.equal((await pending).state, "outcomeUnknown");
    await f.reopen(); assert.equal((await f.host.snapshot(scope)).archive?.state, "pending");
    assert.equal((await f.host.submit(request)).state, "outcomeUnknown");
    assert.equal((await f.submit({ type: "resume" })).reason, "archived"); assert.equal(releases, 1);
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.host.receipt(scope, request.id))?.state, "outcomeUnknown");
    assert.equal((await f.host.snapshot(scope)).archive?.state, "pending");
  } finally { release.resolve(); await f.dispose(); }
});

test("reader allocation intent survives writer loss and cannot be flattened to no reader during archive", async () => {
  let releases = 0;
  const f = await fixture(new ScriptedPort(), { archive: { ready: async () => true, release: async () => { releases++; } } });
  try {
    await f.create(); await f.submit({ type: "stop" }); await until(() => f.host.updateReadiness().ready);
    const run = f.port.run!, opening = { scope, generation: run.generation, operationId: "reader-original" };
    await f.host.readers.begin(run, opening); await f.reopen();
    assert.deepEqual(await f.host.readers.read(), { state: "allocating", run, opening });
    assert.equal((await f.submit({ type: "archive" })).reason, "readerCustodyUnconfirmed");
    assert.equal((await f.host.snapshot(scope)).archive, undefined); assert.equal(releases, 0); assert.equal(f.port.starts.length, 1);
  } finally { await f.dispose(); }
});

test("Host observed selection, idle execution, immutable original receipt and exact replay", async () => {
  const f = await fixture(); try {
    assert.equal((await f.create()).state, "acknowledged");
    assert.equal((await f.host.snapshot(scope)).phase, "running");
    f.port.emit({ run: f.port.run!, type: "activity", activity: "idle" });
    assert.equal((await f.host.snapshot(scope)).phase, "running");
    const request = { scope, id: "frozen-model", generation: 1, command: { type: "codex.defaults" as const, selection: { kind: "codex" as const, model: "model-b" } } };
    assert.equal((await f.host.submit(request)).state, "acknowledged");
    assert.equal((await f.host.snapshot(scope)).selection.model, "model-a");
    assert.deepEqual(await f.host.submit(request), await f.host.receipt(scope, request.id)); assert.equal(f.port.calls.length, 1);
    await assert.rejects(async () => f.host.submit({ ...request, command: { ...request.command, selection: { kind: "codex", model: "model-a" } } }), { code: "CONFLICT" });
    f.port.emit({ run: f.port.run!, type: "selection", selection: { kind: "codex", model: "model-b" } });
    assert.equal((await f.host.snapshot(scope)).selection.model, "model-b");
    await f.submit({ type: "stop" }); await f.host.close();
  } finally { await f.dispose(); }
});

test("Host immediate Stop closes admission before any Create native effect", async () => {
  const f = await fixture(); try {
    const create = f.host.submit({ scope, id: "create", generation: 0, command: { type: "create" } });
    const stop = f.host.submit({ scope, id: "stop", generation: 0, command: { type: "stop" } });
    assert.equal((await create).state, "refused"); assert.equal((await stop).state, "acknowledged");
    assert.equal(f.port.starts.length, 0); assert.equal((await f.host.snapshot(scope)).phase, "stopped"); await f.host.close();
  } finally { await f.dispose(); }
});

test("Host Stop during startup joins one native halt, timeout owns slot until late proof", async () => {
  const port = new ScriptedPort(), start = defer<void>(), stop = defer<StopProof>(); port.startGate = start.promise; port.stopGate = stop.promise;
  // Keep native startup held, but allow real journal admission/dispatch commits
  // before expiring the observer. Expiry during admission is tested separately.
  const f = await fixture(port, { observationMs: 2000 }); try {
    const create = f.create(); await until(() => port.starts.length === 1);
    const stopOne = f.submit({ type: "stop" }); const stopTwo = f.submit({ type: "stop" });
    assert.equal((await stopOne).state, "outcomeUnknown"); assert.equal((await stopTwo).state, "outcomeUnknown");
    assert.equal((await f.host.snapshot(scope)).phase, "stopping"); await assert.rejects(f.host.close(), { code: "BUSY" });
    start.resolve(); await until(() => port.stops === 1); stop.resolve(port.proof());
    await until(async () => (await f.host.snapshot(scope)).phase === "stopped"); await create;
    await until(async () => { try { await f.host.close(); return true; } catch { return false; } });
    assert.equal(port.stops, 1);
  } finally { start.resolve(); stop.resolve(port.proof()); await f.dispose(); }
});

test("Host positive tree halt leaves original Send unknown and a closed Host ignores its late result without reopening writer", async () => {
  const port = new ScriptedPort(), invoke = defer<NativeOutcome>(); const f = await fixture(port); try {
    await f.create(); port.invokeGate = invoke.promise; let publications = 0; const off = f.host.subscribe(scope, () => { publications++; });
    const send = f.host.submit({ scope, id: "orphan-send", generation: 1, command: { type: "send", text: "one message" } }); await until(() => port.calls.length === 1);
    assert.equal((await f.submit({ type: "stop" })).state, "acknowledged");
    assert.equal((await f.host.receipt(scope, "orphan-send"))?.state, "outcomeUnknown");
    await until(async () => { try { await f.host.close(); return true; } catch { return false; } });
    assert.equal((await send).state, "outcomeUnknown"); const closedPublications = publications; invoke.resolve({ status: "applied" });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(publications, closedPublications, 'a closed writer cannot publish late receipt pulses'); off();
    await f.reopen(); assert.equal((await f.host.receipt(scope, "orphan-send"))?.state, "outcomeUnknown"); assert.equal(port.starts.length, 1);
  } finally { invoke.resolve({ status: "applied" }); await f.dispose(); }
});

test("Host exact early Stop proof retires startup even when native start Promise never settles", async () => {
  const port = new ScriptedPort(), start = defer<void>(); port.startGate = start.promise;
  const f = await fixture(port); try {
    const create = f.create(); await until(() => port.starts.length === 1);
    const stop = f.submit({ type: "stop" }); await until(async () => (await f.host.snapshot(scope)).phase === "stopping");
    port.emit({ run: port.run!, type: "stopped", proof: port.proof() });
    assert.equal((await stop).state, "acknowledged"); assert.equal((await create).state, "outcomeUnknown");
    await until(async () => { try { await f.host.close(); return true; } catch { return false; } });
    start.resolve(); assert.equal(port.stops, 0);
  } finally { start.resolve(); await f.dispose(); }
});

test("Host Stop bypasses blocked settings catalog and prevents its late dispatch", async () => {
  const port = new ScriptedPort(), catalog = defer<Awaited<ReturnType<ScriptedPort["catalog"]>>>(); const f = await fixture(port); try {
    await f.create(); port.catalogGate = catalog.promise;
    const update = f.submit({ type: "codex.defaults", selection: { kind: "codex", model: "model-b" } });
    await new Promise(resolve => setTimeout(resolve, 5));
    await f.submit({ type: "stop" }); catalog.resolve({ available: true, choices: [{ model: "model-b", efforts: ["low"] }] }); await update;
    assert.equal(port.calls.length, 0); await f.host.close();
  } finally { catalog.resolve({ available: false, choices: [] }); await f.dispose(); }
});

test("Host partial interactions allow only exact private reply and its late result settles without journaling private body", async () => {
  const port = new ScriptedPort(), reply = defer<NativeOutcome>(); port.complete = false; port.interactions = [{ id: "prompt", owner: "child", kind: "userInput", choices: ["submit"] }]; const f = await fixture(port); try {
    await f.create(); assert.equal((await f.submit({ type: "send", text: "blocked" })).state, "refused");
    assert.equal((await f.submit({ type: "answer", interactionId: "prompt", choice: "unknown" })).state, "refused");
    port.invokeGate = reply.promise;
    const answer = f.submit({ type: "answer", interactionId: "prompt", choice: "submit", value: { private: "PRIVATE-ANSWER-823b" } }); await until(() => port.calls.length === 1);
    await f.submit({ type: "stop" }); const original = await answer; assert.equal(original.state, "outcomeUnknown");
    reply.resolve({ status: "applied", detail: { echoed: "PRIVATE-ANSWER-823b" } });
    await until(async () => (await f.host.receipt(scope, original.id))?.state === "acknowledged");
    assert.deepEqual((await f.host.receipt(scope, original.id))?.outcome, { status: "applied" }); assert.equal(port.calls.length, 1); await f.host.close();
    for (const name of await readdir(f.directory)) assert.equal((await readFile(join(f.directory, name))).includes(Buffer.from("PRIVATE-ANSWER-823b")), false);
  } finally { reply.resolve({ status: "applied" }); await f.dispose(); }
});

test("Host startup event order wins over initial snapshot and foreign generation cannot overwrite", async () => {
  const port = new ScriptedPort(); port.onStart = () => { port.emit({ run: port.run!, type: "selection", selection: { kind: "codex", model: "model-b" } }); }; const f = await fixture(port); try {
    await f.create(); assert.equal((await f.host.snapshot(scope)).selection.model, "model-b");
    port.emit({ run: { ...port.run!, generation: 99 }, type: "selection", selection: { kind: "codex", model: "foreign" } });
    assert.equal((await f.host.snapshot(scope)).selection.model, "model-b"); await f.submit({ type: "stop" }); await f.host.close();
  } finally { await f.dispose(); }
});

test("Host invalid stop proof leaves stopping and cannot release shared execution", async () => {
  const port = new ScriptedPort(); const f = await fixture(port); try {
    await f.create(); port.stopGate = Promise.resolve({ ...port.proof(), scope: "controller" } as unknown as StopProof);
    assert.equal((await f.submit({ type: "stop" })).state, "outcomeUnknown"); assert.equal((await f.host.snapshot(scope)).phase, "stopping");
    await assert.rejects(f.host.close(), { code: "BUSY" }); assert.equal((await f.submit({ type: "resume" })).state, "refused"); assert.equal(port.starts.length, 1);
  } finally { await f.dispose(); }
});

test("Host reopen only inspects stored native identity; explicit cold Resume keeps identity and disables continuation", async () => {
  const f = await fixture(); try {
    await f.create(); await f.reopen(); assert.equal(f.port.starts.length, 1); assert.equal(f.port.inspections.length, 1);
    await f.submit({ type: "stop" }); await f.host.close(); await f.reopen(); assert.equal(f.port.inspections.length, 1);
    await f.submit({ type: "resume" }); assert.equal(f.port.starts.length, 2); assert.equal(f.port.starts[1]?.nativeSession, "native-original"); assert.equal("continuePendingWork" in f.port.starts[1]!, false); assert.equal(f.port.starts[1]?.generation, 2);
    await f.submit({ type: "stop" }); await f.host.close();
  } finally { await f.dispose(); }
});

test("Host dynamically rejects invalid effort-only or collaboration pairs before native calls", async () => {
  const f = await fixture(); try {
    await f.create(); assert.equal((await f.submit({ type: "codex.defaults", selection: { kind: "codex", effort: "invalid" } })).state, "refused");
    assert.equal((await f.submit({ type: "codex.defaults", selection: { kind: "codex", collaboration: { mode: "plan", model: "model-b", effort: "high" } } })).state, "refused");
    assert.equal(f.port.calls.length, 0); await f.submit({ type: "stop" }); await f.host.close();
  } finally { await f.dispose(); }
});

test("Host Copilot frozen Send applies bounded mode/model/permission steps then bare Send without projecting ACK", async () => {
  const f = await fixture(new ScriptedPort("copilot")); try {
    await f.create(); assert.equal((await f.submit({ type: "send", text: "frozen", selection: { kind: "copilot", mode: "plan", effort: "high", permissions: "allow-all" } })).state, "acknowledged");
    assert.deepEqual(f.port.calls, [{ type: "copilot.mode", mode: "plan" }, { type: "copilot.model", model: "model-a", providerId: "provider", effort: "high" }, { type: "copilot.permissions", mode: "allow-all" }, { type: "send", text: "frozen" }]);
    assert.equal((await f.host.snapshot(scope)).selection.effort, "low"); await f.submit({ type: "stop" }); await f.host.close();
  } finally { await f.dispose(); }
});

test("actual Host cannot Send after high-effort request returns native low-effort state", async () => {
  const port = new ScriptedPort("copilot"), originalHandle = port.handle.bind(port); let switches = 0, sends = 0;
  const invoke = createCopilotInvocation({ rpc: {
    model: { switchTo: async () => { switches++; return { modelState: { modelId: "model-a", providerId: "provider", reasoningEffort: "low" } }; } },
    mode: { set: async () => ({}) }, permissions: { setMode: async () => ({}) }, abort: async () => ({}),
    send: async () => { sends++; return { messageId: "must-not-exist" }; },
  } });
  port.handle = run => ({ ...originalHandle(run), invoke });
  const f = await fixture(port);
  try {
    await f.create(); const receipt = await f.submit({ type: "send", text: "requires high", selection: { kind: "copilot", effort: "high" } });
    assert.equal(receipt.outcome?.status, "acknowledged"); assert.equal((receipt.outcome?.detail as Record<string, unknown>).sendDispatched, false);
    assert.equal(switches, 1); assert.equal(sends, 0); assert.equal((await f.host.snapshot(scope)).selection.effort, "low");
    await f.submit({ type: "stop" });
  } finally { await f.dispose(); }
});

test("Host Copilot frozen Send stops at non-applied substep and preserves partial evidence", async () => {
  const f = await fixture(new ScriptedPort("copilot")); try {
    await f.create(); f.port.outcomes.push({ status: "applied" }, { status: "confirmationRequired", detail: { ticket: "opaque-confirmation" } });
    const receipt = await f.submit({ type: "send", text: "must not send", selection: { kind: "copilot", mode: "plan", model: "model-a" } });
    assert.equal(receipt.outcome?.status, "confirmationRequired"); assert.deepEqual(receipt.outcome?.detail, { native: { ticket: "opaque-confirmation" }, sendDispatched: false, completedSubsteps: ["copilot.mode"] }); assert.equal(f.port.calls.length, 2);
    await f.submit({ type: "stop" }); await f.host.close();
  } finally { await f.dispose(); }
});

test("Host positive event proof releases orphan native.stop without accepting a controller acknowledgement", async () => {
  const port = new ScriptedPort(), stop = defer<StopProof>(); const f = await fixture(port); try {
    await f.create(); port.stopGate = stop.promise; const pending = f.submit({ type: "stop" }); await until(() => port.stops === 1);
    port.emit({ run: port.run!, type: "stopped", proof: port.proof() }); assert.equal((await pending).state, "acknowledged");
    await until(async () => { try { await f.host.close(); return true; } catch { return false; } });
  } finally { stop.resolve(port.proof()); await f.dispose(); }
});

test("Host unresolved capacity reserves Stop while permanent compact receipts survive growth and restart", async () => {
  const port = new ScriptedPort(), gate = defer<NativeOutcome>();
  const f = await fixture(port, { limits: { maxOperations: 2, maxMetadataBytes: 64 * 1024 } });
  try {
    await f.create();
    const original = { scope, id: "retained-first", generation: 1, command: { type: "send" as const, text: "exact private original" } };
    const first = await f.host.submit(original); assert.equal(first.state, "acknowledged");
    for (let i = 0; i < 40; i++) assert.equal((await f.submit({ type: "send", text: `later ${i}` })).state, "acknowledged");
    assert.deepEqual(await f.host.submit(original), first); assert.equal(port.calls.length, 41);
    await assert.rejects(f.host.submit({ ...original, command: { type: "send", text: "changed" } }), { code: "CONFLICT" });
    port.invokeGate = gate.promise; const held = f.submit({ type: "send", text: "unresolved" }); await until(() => port.calls.length === 42);
    await assert.rejects(f.submit({ type: "send", text: "ordinary pressure" }), { code: "FULL" });
    assert.equal((await f.submit({ type: "stop" })).state, "acknowledged");
    gate.resolve({ status: "accepted" }); await held; await until(() => f.host.updateReadiness().ready);
    await f.reopen(); assert.deepEqual(await f.host.receipt(scope, original.id), first);
    assert.deepEqual(await f.host.submit(original), first); assert.equal(port.calls.length, 42);
    const db = new DatabaseSync(join(f.directory, "session.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT payload,allocation,hash FROM operations WHERE id=?").get(original.id)!;
      assert.equal(row.payload, "null"); assert.equal(row.allocation, 0); assert.equal(typeof row.hash, "string");
      assert.ok(Number(db.prepare("SELECT COUNT(*) n FROM operations").get()!.n) > 40);
    } finally { db.close(); }
    await f.host.close();
  } finally { gate.resolve({ status: "accepted" }); await f.dispose(); }
});

test("Host capabilities require explicit true and captured descriptors cannot change after open", async () => {
  const port = new ScriptedPort(); (port.capabilities as unknown as { fullStop: unknown }).fullStop = "truthy";
  const f = await fixture(port); try { assert.equal((await f.create()).state, "refused"); assert.equal(port.starts.length, 0); await f.host.close(); } finally { await f.dispose(); }
  const immutablePort = new ScriptedPort(); const good = await fixture(immutablePort); try {
    (immutablePort.capabilities as unknown as { fullStop: boolean }).fullStop = false;
    assert.equal((await good.create()).state, "acknowledged"); await good.submit({ type: "stop" }); await good.host.close();
  } finally { await good.dispose(); }
  const evolving = new ScriptedPort(), reopened = await fixture(evolving); try {
    const original = await reopened.create(), before = await reopened.host.snapshot(scope);
    const updated: Capabilities = { fullStop: true, createAndWait: true, reopen: true, commands: ["send", "answer", "codex.queue.add"], reads: ["codex.goal"] };
    Object.assign(evolving.capabilities, updated);
    assert.deepEqual((await reopened.host.snapshot(scope)).capabilities, before.capabilities, "a running Host owns its captured descriptors");
    await reopened.reopen(); const current = await reopened.host.snapshot(scope);
    assert.deepEqual(current.capabilities, updated, "reopen advertises the current trusted driver, never stale persisted capabilities");
    assert.equal(current.nativeSession, before.nativeSession); assert.equal(current.generation, before.generation); assert.equal(current.selection.model, before.selection.model);
    assert.equal((await reopened.host.receipt(scope, original.id))?.state, "acknowledged"); assert.equal(evolving.starts.length, 1);
    await reopened.submit({ type: "stop" }); await reopened.host.close();
  } finally { await reopened.dispose(); }
});

test("Host scope, listener and operation identity are fenced without native side effects", async () => {
  const f = await fixture(new ScriptedPort(), { limits: { maxListeners: 1 } }); try {
    const unlisten = f.host.subscribe(scope, () => {}); assert.throws(() => f.host.subscribe(scope, () => {}), { code: "BUSY" }); unlisten();
    await assert.rejects(f.host.snapshot({ ...scope, principal: "other" }), { code: "FENCED" });
    assert.throws(() => f.host.submit({ scope: { ...scope, session: "other" }, id: "bad", generation: 0, command: { type: "create" } }), { code: "FENCED" });
    await f.create(); const reopened = await f.reopen(); assert.equal((await reopened.snapshot(scope)).generation, 1); assert.equal(f.port.starts.length, 1);
    await f.submit({ type: "stop" }); await f.host.close(); await assert.rejects(f.host.snapshot(scope), { code: "CLOSED" });
  } finally { await f.dispose(); }
});

test("Host Copilot Stop after applied substep prevents remaining steps and Send", async () => {
  const port = new ScriptedPort("copilot"), step = defer<NativeOutcome>(); const f = await fixture(port); try {
    await f.create(); port.invokeGate = step.promise;
    const send = f.submit({ type: "send", text: "never after stop", selection: { kind: "copilot", mode: "plan", model: "model-a", permissions: "allow-all" } });
    await until(() => port.calls.length === 1); await f.submit({ type: "stop" }); step.resolve({ status: "applied" });
    assert.equal((await send).state, "outcomeUnknown"); assert.equal(port.calls.length, 1); await f.host.close();
  } finally { step.resolve({ status: "applied" }); await f.dispose(); }
});

test("Host reopen null inspection never turns unknown existing execution into Stopped", async () => {
  const f = await fixture(); try {
    await f.create(); f.port.inspectResult = null; await f.reopen(); assert.equal((await f.host.snapshot(scope)).phase, "running"); assert.equal((await f.host.snapshot(scope)).issue, "ownershipUnconfirmed");
    assert.equal((await f.submit({ type: "resume" })).state, "refused"); assert.equal((await f.submit({ type: "stop" })).state, "outcomeUnknown"); assert.equal((await f.host.snapshot(scope)).phase, "stopping"); assert.equal(f.port.starts.length, 1);
    await assert.rejects(f.host.close(), { code: "BUSY" });
  } finally { await f.dispose(); }
});

test("Host duplicate halt proofs retire old work before Resume and exact late original results settle only old receipts", async () => {
  const port = new ScriptedPort(), invoke = defer<NativeOutcome>(), interruptResult = defer<NativeOutcome>(), stopping = defer<StopProof>(); const f = await fixture(port); try {
    await f.create(); const oldRun = port.run!; port.invokeGate = invoke.promise; port.stopGate = stopping.promise;
    const send = f.submit({ type: "send", text: "old orphan" }); await until(() => port.calls.length === 1);
    port.invokeGate = interruptResult.promise;
    const interrupt = f.submit({ type: "codex.interrupt", turnId: "old-turn" }); await until(() => port.calls.length === 2);
    const stop = f.submit({ type: "stop" }); await until(() => port.stops === 1);
    let resume: ReturnType<typeof f.host.submit> | undefined, stoppedNotifications = 0, wasStopped = false;
    const unlisten = f.host.subscribe(scope, snapshot => {
      const stopped = snapshot.phase === "stopped" && snapshot.generation === 1;
      if (stopped && !wasStopped) {
        stoppedNotifications++; port.invokeGate = undefined; port.stopGate = undefined;
        resume ??= f.host.submit({ scope, id: "resume-from-stopped", generation: 1, command: { type: "resume" } });
      }
      wasStopped = stopped;
    });
    port.emit({ run: oldRun, type: "stopped", proof: port.proof(oldRun) });
    port.emit({ run: oldRun, type: "stopped", proof: port.proof(oldRun) }); stopping.resolve(port.proof(oldRun));
    await until(() => resume !== undefined); assert.equal((await resume!).state, "acknowledged");
    const sendUnknown = await send, interruptUnknown = await interrupt;
    assert.equal(sendUnknown.state, "outcomeUnknown"); assert.equal(interruptUnknown.state, "outcomeUnknown"); await stop;
    assert.equal(stoppedNotifications, 1); assert.equal((await f.host.snapshot(scope)).generation, 2); assert.equal((await f.host.snapshot(scope)).phase, "running");
    const current = await f.host.snapshot(scope);
    invoke.resolve({ status: "applied" }); interruptResult.resolve({ status: "refused", detail: { reason: "original-turn-ended" } });
    await until(async () => (await f.host.receipt(scope, sendUnknown.id))?.state === "acknowledged" && (await f.host.receipt(scope, interruptUnknown.id))?.state === "refused");
    assert.deepEqual((await f.host.receipt(scope, sendUnknown.id))?.outcome, { status: "applied" });
    assert.deepEqual((await f.host.receipt(scope, interruptUnknown.id))?.outcome, { status: "refused", detail: { reason: "original-turn-ended" } });
    const { revision: priorRevision, ...priorFacts } = current, { revision: nextRevision, ...nextFacts } = await f.host.snapshot(scope);
    assert.deepEqual(nextFacts, priorFacts); assert.equal(nextRevision, priorRevision + 2, 'late final originals wake the current watch without changing new-run facts');
    const settledSend = await f.host.receipt(scope, sendUnknown.id);
    assert.deepEqual(await f.host.submit({ scope, id: sendUnknown.id, generation: 1, command: { type: "send", text: "old orphan" } }), settledSend);
    assert.equal((await f.submit({ type: "send", text: "new generation remains usable" })).state, "acknowledged");
    assert.equal(port.calls.length, 3); unlisten(); await f.submit({ type: "stop" }); await f.host.close();
  } finally { invoke.resolve({ status: "applied" }); interruptResult.resolve({ status: "refused" }); stopping.resolve(port.proof()); await f.dispose(); }
});

test("Host observation epoch advances across reopen after many RAM observations without restarting native generation", async () => {
  const f = await fixture(); try {
    const original = await f.create();
    for (let i = 0; i < 100; i++) f.port.emit({ run: f.port.run!, type: "activity", activity: i % 2 ? "idle" : "working" });
    const before = await f.host.snapshot(scope); assert.ok(before.epoch > 0); assert.ok(before.revision >= 100);
    await f.reopen(); const after = await f.host.snapshot(scope);
    assert.ok(after.epoch > before.epoch); assert.ok(after.revision < before.revision); assert.equal(after.generation, before.generation); assert.equal(after.nativeSession, before.nativeSession);
    assert.equal(f.port.starts.length, 1); assert.equal(f.port.inspections.length, 1); assert.deepEqual(await f.host.receipt(scope, original.id), original);
    f.port.emit({ run: f.port.run!, type: "activity", activity: "working" });
    const observed = await f.host.snapshot(scope); assert.equal(observed.epoch, after.epoch); assert.ok(observed.revision > after.revision);
    assert.equal((await f.submit({ type: "stop" })).state, "acknowledged"); await f.host.close();
    await f.reopen(); assert.ok((await f.host.snapshot(scope)).epoch > after.epoch); assert.equal((await f.host.snapshot(scope)).generation, before.generation); assert.equal(f.port.starts.length, 1); await f.host.close();
  } finally { await f.dispose(); }
});

test("Host observation epoch rejects invalid or exhausted persisted counters before native inspection or receipt changes", async () => {
  const f = await fixture(); try {
    await f.create(); await f.host.terminate();
    for (const epoch of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "2", undefined]) {
      const db = new DatabaseSync(join(f.directory, "session.sqlite"));
      const state = JSON.parse(String(db.prepare("SELECT json FROM state WHERE singleton=1").get()!.json)) as Record<string, unknown>;
      const changed = JSON.stringify({ ...state, epoch }); db.prepare("UPDATE state SET json=? WHERE singleton=1").run(changed);
      const receipts = db.prepare("SELECT id,receipt FROM operations ORDER BY id").all(); db.close();
      await assert.rejects(f.reopen(), { code: "INVALID" }); assert.equal(f.port.inspections.length, 0); assert.equal(f.port.starts.length, 1);
      const verify = new DatabaseSync(join(f.directory, "session.sqlite"));
      assert.equal(verify.prepare("SELECT json FROM state WHERE singleton=1").get()!.json, changed); assert.deepEqual(verify.prepare("SELECT id,receipt FROM operations ORDER BY id").all(), receipts); verify.close();
    }
  } finally { await f.dispose(); }
});

test("Host 66 exact late results wait through competing journal pressure and block close until durable drain", { timeout: 120000 }, async t => {
  const port = new ScriptedPort(), result = defer<NativeOutcome>();
  const f = await fixture(port, { observationMs: 120000, limits: { maxPending: 64 } });
  t.after(async () => { result.resolve({ status: "applied" }); await f.dispose(); });
  const originals: string[] = [];
  for (let generation = 1; generation <= 2; generation++) {
    await f.submit({ type: generation === 1 ? "create" : "resume" }); port.invokeGate = result.promise;
    const pending = Array.from({ length: 33 }, (_, index) => {
      const id = `burst-${generation}-${index}`; originals.push(id);
      return f.host.submit({ scope, id, generation, command: { type: "codex.interrupt", turnId: `turn-${generation}-${index}` } });
    });
    await until(() => port.calls.length === generation * 33, 90000);
    assert.equal((await f.submit({ type: "stop" })).state, "acknowledged");
    assert.ok((await Promise.all(pending)).every(receipt => receipt.state === "outcomeUnknown"));
  }
  const before = await f.host.snapshot(scope); assert.equal(before.phase, "stopped");
  // Fill the actual facade's64 RPC slots before the serialized proof writer attempts admission.
  const reads = Array.from({ length: 64 }, () => f.host.receipt(scope, originals[0]!));
  result.resolve({ status: "applied", detail: { originalResponse: true } });
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.host.close(), { code: "BUSY" }); await Promise.all(reads);
  await until(async () => { try { await f.host.close(); return true; } catch (error) { if ((error as { code?: string }).code !== "BUSY") throw error; return false; } }, 90000);
  await f.reopen(); const after = await f.host.snapshot(scope);
  assert.equal(after.phase, before.phase); assert.equal(after.generation, before.generation); assert.equal(after.nativeSession, before.nativeSession); assert.deepEqual(after.selection, before.selection);
  for (const id of originals) { const receipt = await f.host.receipt(scope, id); assert.equal(receipt?.state, "acknowledged"); assert.deepEqual(receipt?.outcome, { status: "applied", detail: { originalResponse: true } }); }
  assert.equal(port.starts.length, 2); assert.equal(port.calls.length, 66); assert.equal(port.stops, 2); await f.host.close();
});


test('configured journal quota preserves exact receipts and reserves durable Stop when ordinary originals are full', async () => {
  const f = await fixture(); let journal: SessionJournal | undefined;
  try {
    const created = await f.create(); await f.submit({ type: 'stop' });
    const initial = await f.host.snapshot(scope); await until(() => f.host.updateReadiness().ready); await f.host.close();
    journal = (await SessionJournal.open(f.directory, scope, sessionLimits({ maxMetadataBytes: 1024 * 1024, maxJournalBytes: 128 * 1024 }), initial)).journal;
    let failed: Receipt | undefined;
    for (let i = 0; i < 100; i++) {
      const admitted: Receipt = { scope, id: `disk-${i}`, generation: 1, type: 'send', state: 'admitted' };
      try {
        await journal.call('admit', { receipt: admitted, hash: `fixed-hash-${i}`, payload: { text: 'small' } });
        await journal.call('transition', { receipt: { ...admitted, state: 'acknowledged', outcome: { status: 'applied', detail: { proof: 'x'.repeat(8000) } } } });
      } catch (error) { assert.equal((error as { code: string }).code, 'FULL'); failed = admitted; break; }
    }
    assert.ok(failed, 'the physical journal quota is finite independently of active reservation bytes');
    const persisted = await journal.call<Receipt | null>('receipt', { id: failed.id });
    assert.equal(persisted, null, 'refused quota admission cannot publish an acknowledgement');
    const stop: Receipt = { scope, id: 'quota-reserved-stop', generation: 1, type: 'stop', state: 'admitted' };
    assert.deepEqual(await journal.call('admit', { receipt: stop, hash: 'exact-stop-hash', payload: { command: { type: 'stop' } } }), { fresh: true, receipt: stop });
    const acknowledged: Receipt = { ...stop, state: 'acknowledged', outcome: { status: 'acknowledged' } };
    assert.deepEqual(await journal.call('transition', { receipt: acknowledged }), acknowledged);
    assert.deepEqual(await journal.call('receipt', { id: stop.id }), acknowledged);
    assert.deepEqual(await journal.call('receipt', { id: created.id }), created);
    await journal.close(); journal = undefined;
  } finally { await journal?.terminate(); await f.dispose(); }
});
