import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedPolicy, NativeEvent, NativeStart, RunRef } from "../../v8-session/src/contracts/types.js";
import { SessionHost } from "../../v8-lifecycle-default/src/session/index.js";
import { RuntimeSupervisor, type OwnedAttachment, type RuntimeHalt } from "../src/index.js";
import { ScriptedRuntimeOwnership, deferred, runtimeScope, until } from "./fixture.js";

const policy: ManagedPolicy = { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" };
const start = (patch: Partial<NativeStart> = {}): NativeStart => ({ scope: runtimeScope, generation: 1, placement: "shared", operationId: "create-original", nativeSession: null, selection: { kind: "codex", model: "scripted-model" }, policy, ...patch });

test("explicit open preserves exact policy, selection and original meaning; unsupported continuation never dispatches", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const input = start(); const native = await supervisor.start(input, () => {});
  assert.deepEqual(ownership.opens, [input]); assert.equal(native.run.generation, 1); assert.deepEqual(ownership.opens[0]!.policy, policy);
  assert.notEqual(ownership.opens[0], input); assert.ok(Object.isFrozen(ownership.opens[0]));
  const other = new ScriptedRuntimeOwnership(), refused = new RuntimeSupervisor({ scope: runtimeScope, ownership: other });
  await assert.rejects(refused.start({ ...input, continuePendingWork: true } as never, () => {})); assert.equal(other.opens.length, 0);
});

test("unexpected returned ownership stays quarantined; no replacement launch, implicit stop or command is attempted", async () => {
  const ownership = new ScriptedRuntimeOwnership(); ownership.overrideOpen = ownership.owned({ scope: { ...runtimeScope, session: "foreign" }, generation: 1, nativeSession: "foreign-native" });
  const supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  await assert.rejects(supervisor.start(start(), () => {}));
  await assert.rejects(supervisor.start(start({ generation: 2 }), () => {}));
  assert.equal(ownership.opens.length, 1); assert.equal(ownership.stopCalls, 0); assert.deepEqual(ownership.calls, []);
  assert.equal(supervisor.snapshot().issue, "ownershipUnconfirmed");
});

test("transport/controller loss and leader exit are observations, never Stop; null inspect is unknown and read-only", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership }), events: NativeEvent[] = [];
  const native = await supervisor.start(start(), event => events.push(event));
  ownership.observe({ controller: "lost", transport: "lost", leader: "exited" });
  assert.equal(supervisor.snapshot().observation.leader, "exited"); assert.deepEqual(events, [{ type: "controlLost", run: native.run }]);
  assert.deepEqual(await native.invoke({ type: "send", text: "must not dispatch" }), { status: "refused", detail: { reason: "nativeControlUnavailable" } }); assert.equal(ownership.calls.length, 0);
  ownership.inspection = null; assert.equal(await supervisor.inspect(native.run, event => events.push(event)), null);
  assert.equal(ownership.opens.length, 1); assert.equal(ownership.inspections.length, 1); assert.equal(ownership.stopCalls, 0);
  assert.equal(supervisor.snapshot().issue, "ownershipUnconfirmed");
});

test("shared Stop requires exact attachment and peer-preservation proof; refused proof cannot dispatch a second Stop", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const native = await supervisor.start(start(), () => {}), invalid = { ...ownership.proof(), boundary: { kind: "shared", peersPreserved: false } } as unknown as RuntimeHalt;
  ownership.stopGate = Promise.resolve(invalid);
  await assert.rejects(native.stop()); await assert.rejects(native.stop()); assert.equal(ownership.stopCalls, 1);
  ownership.emit({ type: "halt", halt: { ...ownership.proof(), identity: { ...ownership.attachment!.identity, attachment: "replacement" } } });
  assert.equal(supervisor.snapshot().issue, "invalidEvidence");
  await assert.rejects(native.invoke({ type: "codex.interrupt", turnId: "exact-turn" })); assert.equal(ownership.calls.length, 0);
});

test("one actual Stop owner survives a caller race and inspection; exact later proof settles that owner", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership }), gate = deferred<RuntimeHalt>();
  ownership.stopGate = gate.promise; const native = await supervisor.start(start(), () => {}), first = native.stop(), second = native.stop();
  assert.equal(first, second); await until(() => ownership.stopCalls === 1);
  await Promise.race([first, Promise.resolve("caller-stopped-waiting")]);
  const inspected = await supervisor.inspect(native.run, () => {}); assert.ok(inspected && !("state" in inspected));
  assert.equal(inspected.stop(), first); gate.resolve(ownership.proof()); assert.deepEqual(await first, ownership.proof().proof);
  assert.equal(ownership.stopCalls, 1); await assert.rejects(native.invoke({ type: "send", text: "stale" }));
});

test("dedicated containment must retire; shared peers keep their independent capabilities", async () => {
  const dedicated = new ScriptedRuntimeOwnership("codex", "dedicated"), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership: dedicated });
  const native = await supervisor.start(start({ placement: "dedicated" }), () => {});
  dedicated.stopGate = Promise.resolve({ ...dedicated.proof(), boundary: { kind: "dedicated", containmentRetired: false } } as unknown as RuntimeHalt);
  await assert.rejects(native.stop());
  const a = new ScriptedRuntimeOwnership(), b = new ScriptedRuntimeOwnership(), peerScope = { ...runtimeScope, session: "peer" };
  const first = new RuntimeSupervisor({ scope: runtimeScope, ownership: a }), peer = new RuntimeSupervisor({ scope: peerScope, ownership: b });
  const runA = await first.start(start(), () => {}), runB = await peer.start(start({ scope: peerScope }), () => {});
  assert.equal(a.attachment!.identity.process, b.attachment!.identity.process); await runA.stop();
  await runB.invoke({ type: "send", text: "peer survives" }); assert.equal(b.stopCalls, 0); assert.equal(b.calls.length, 1);
});

test("early events wait for exact ownership; old attachment events cannot halt a resumed generation", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership }), events: NativeEvent[] = [];
  ownership.beforeReturn = (attachment, emit) => emit({ type: "native", identity: attachment.identity, event: { type: "activity", run: attachment.identity.run, activity: "working" } });
  const old = await supervisor.start(start(), event => events.push(event)); assert.equal(events[0]!.type, "activity");
  const oldProof = ownership.proof(), oldEmit = ownership.emissions[0]!; await old.stop();
  const resumed = await supervisor.start(start({ generation: 2, nativeSession: old.run.nativeSession, operationId: "resume-original" }), event => events.push(event));
  const before = events.length; oldEmit({ type: "halt", halt: oldProof }); assert.equal(events.length, before);
  assert.equal(supervisor.snapshot().identity!.run.generation, 2); await resumed.invoke({ type: "send", text: "new generation" });
  await assert.rejects(old.invoke({ type: "send", text: "old" }));
});

test("fresh supervisor inspection recovers exact retained ownership without opening or continuing native work", async () => {
  const ownership = new ScriptedRuntimeOwnership(), run: RunRef = { scope: runtimeScope, generation: 4, nativeSession: "retained-native" };
  ownership.attachment = ownership.owned(run); const supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const found = await supervisor.inspect(run, () => {}); assert.ok(found && !("state" in found)); assert.deepEqual(found.run, run);
  assert.equal(ownership.opens.length, 0); assert.equal(ownership.calls.length, 0); assert.equal(ownership.stopCalls, 0);
  await found.stop();
  await assert.rejects(supervisor.start(start({ generation: 5, nativeSession: "different-native" }), () => {})); assert.equal(ownership.opens.length, 0);
});

test("same-owner inspection refreshes baseline/dispatch and old callback uses the current sink without replacing Stop ownership", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership }), oldEvents: NativeEvent[] = [], freshEvents: NativeEvent[] = [];
  const native = await supervisor.start(start(), event => oldEvents.push(event)), originalEmit = ownership.emissions[0]!;
  const initial = ownership.attachment!; let refreshedCalls = 0;
  ownership.inspection = { ...initial, native: { ...initial.native, selection: { kind: "codex", model: "refreshed-model" }, interactionsComplete: false, invoke: async () => { refreshedCalls++; return { status: "acknowledged" }; } } };
  const inspected = await supervisor.inspect(native.run, event => freshEvents.push(event)); assert.ok(inspected && !("state" in inspected));
  assert.deepEqual(inspected.selection, { kind: "codex", model: "refreshed-model" }); assert.equal(inspected.interactionsComplete, false);
  originalEmit({ type: "native", identity: initial.identity, event: { type: "activity", run: native.run, activity: "waiting" } });
  assert.equal(oldEvents.length, 0); assert.equal(freshEvents.length, 1);
  await native.invoke({ type: "send", text: "uses exact refreshed controller" }); assert.equal(refreshedCalls, 1); assert.equal(ownership.calls.length, 0);
});

test("same-run handover receives a continuous stream during inspection and stale baseline cannot erase newer loss or issue", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const oldEvents: NativeEvent[] = [], freshEvents: NativeEvent[] = [], pending = deferred<OwnedAttachment>();
  const native = await supervisor.start(start(), event => oldEvents.push(event)), initial = ownership.attachment!;
  ownership.inspect = async () => pending.promise;
  const reading = supervisor.inspect(native.run, event => freshEvents.push(event));
  for (let n = 0; n < 8; n++) ownership.emit({ type: "native", identity: initial.identity, event: { type: "activity", run: native.run, activity: n % 2 ? "waiting" : "working" } });
  ownership.observe({ controller: "lost", transport: "lost", leader: "present" });
  ownership.emit({ type: "native", identity: initial.identity, event: { type: "activity", run: { ...native.run, generation: 99 }, activity: "idle" } });
  const latest = supervisor.snapshot(); pending.resolve(initial);
  const inspected = await reading; assert.ok(inspected && !("state" in inspected));
  assert.equal(oldEvents.length, 0); assert.equal(freshEvents.filter(event => event.type === "activity").length, 8);
  assert.deepEqual(supervisor.snapshot(), latest); assert.equal(latest.issue, "invalidEvidence");
  assert.deepEqual(await inspected.invoke({ type: "send", text: "blocked by retained loss" }), { status: "refused", detail: { reason: "nativeControlUnavailable" } });
  assert.equal(ownership.calls.length, 0);
  const latestSink: NativeEvent[] = [], next = deferred<OwnedAttachment>(); ownership.inspect = async () => next.promise;
  const nextReading = supervisor.inspect(native.run, event => latestSink.push(event));
  assert.deepEqual(latestSink, [{ type: "controlLost", run: native.run }], "new Host receives existing loss immediately");
  next.resolve(initial); await nextReading; await native.stop();
  const retained = new ScriptedRuntimeOwnership(), restored = new RuntimeSupervisor({ scope: runtimeScope, ownership: retained });
  retained.inspection = { ...initial, observation: { controller: "lost", transport: "lost", leader: "present" } };
  const restoredEvents: NativeEvent[] = [], found = await restored.inspect(native.run, event => restoredEvents.push(event));
  assert.ok(found && !("state" in found)); assert.deepEqual(restoredEvents, [{ type: "controlLost", run: native.run }], "a newly installed lost baseline reports control loss too");
  await found.stop();
});

test("actual SessionHost writer reopen retains native events during held inspection without waiting for a quiet stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-runtime-handover-")), ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  let host = await SessionHost.open({ directory, scope: runtimeScope, port: supervisor, policy, observationMs: 2000 });
  const pending = deferred<OwnedAttachment>();
  try {
    await host.submit({ scope: runtimeScope, id: "create-handover", generation: 0, command: { type: "create" } });
    const initial = ownership.attachment!; await host.terminate();
    ownership.inspect = async run => { ownership.inspections.push(run); return pending.promise; };
    const reopening = SessionHost.open({ directory, scope: runtimeScope, port: supervisor, policy, observationMs: 2000 });
    await until(() => ownership.inspections.length === 1);
    for (let n = 0; n < 8; n++) ownership.emit({ type: "native", identity: initial.identity, event: { type: "selection", run: initial.identity.run, selection: { kind: "codex", model: `stream-model-${n}` } } });
    ownership.observe({ controller: "lost", transport: "lost", leader: "present" });
    pending.resolve(initial); host = await reopening;
    const restored = await host.snapshot(runtimeScope);
    assert.equal(restored.selection.model, "stream-model-7"); assert.equal(restored.issue, "ownershipUnconfirmed");
    assert.equal(restored.phase, "running"); assert.equal(ownership.opens.length, 1); assert.equal(ownership.calls.length, 0);
    await host.submit({ scope: runtimeScope, id: "stop-handover", generation: 1, command: { type: "stop" } });
  } finally { pending.resolve(ownership.attachment!); await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

test("inspection cannot substitute another generation or ownership capability; Copilot policy/provider remains concrete", async () => {
  const ownership = new ScriptedRuntimeOwnership("copilot"), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const input = start({ selection: { kind: "copilot", model: "scripted-model", providerId: "selected-provider" }, policy: { kind: "copilot", permissions: "manual", provider: "copilot-only" } });
  const native = await supervisor.start(input, () => {}); assert.deepEqual(ownership.opens[0], input);
  await assert.rejects(supervisor.inspect({ ...native.run, generation: 2 }, () => {})); assert.equal(ownership.inspections.length, 0);
  ownership.inspection = { ...ownership.attachment!, identity: { ...ownership.attachment!.identity, process: "different-process-capability" } };
  await assert.rejects(supervisor.inspect(native.run, () => {})); assert.equal(supervisor.snapshot().identity!.process, "owned-process-capability");
  assert.equal(ownership.opens.length, 1); assert.equal(ownership.stopCalls, 0);
});

test("delayed inspection cannot downgrade a resumed run or a newer concurrent retained inspection", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const old = await supervisor.start(start(), () => {}), pending = deferred<OwnedAttachment>();
  ownership.inspect = async run => { ownership.inspections.push(run); return pending.promise; };
  const reading = supervisor.inspect(old.run, () => {}); await until(() => ownership.inspections.length === 1);
  const oldAttachment = ownership.attachment!; await old.stop();
  const resumed = await supervisor.start(start({ generation: 2, nativeSession: old.run.nativeSession, operationId: "resume-after-inspect" }), () => {});
  const current = supervisor.snapshot(); pending.resolve(oldAttachment); await assert.rejects(reading);
  assert.deepEqual(supervisor.snapshot(), current); await resumed.invoke({ type: "send", text: "current remains usable" });
  const concurrent = new ScriptedRuntimeOwnership(), fresh = new RuntimeSupervisor({ scope: runtimeScope, ownership: concurrent }), four = deferred<OwnedAttachment>(), five = deferred<OwnedAttachment>();
  concurrent.inspect = async run => run.generation === 4 ? four.promise : five.promise;
  const run4: RunRef = { scope: runtimeScope, generation: 4, nativeSession: "retained-native" }, run5 = { ...run4, generation: 5 };
  const reading4 = fresh.inspect(run4, () => {}), reading5 = fresh.inspect(run5, () => {});
  five.resolve(concurrent.owned(run5)); await reading5; const newer = fresh.snapshot();
  four.resolve(concurrent.owned(run4)); await assert.rejects(reading4); assert.deepEqual(fresh.snapshot(), newer);
  const haltedOwner = new ScriptedRuntimeOwnership(), haltedSupervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership: haltedOwner });
  const stillOld = await haltedSupervisor.start(start(), () => {}), stale = deferred<OwnedAttachment>();
  haltedOwner.inspect = async () => stale.promise; const sameGenerationRead = haltedSupervisor.inspect(stillOld.run, () => {}), captured = haltedOwner.attachment!;
  const haltProof = await stillOld.stop(), haltedSnapshot = haltedSupervisor.snapshot(); stale.resolve(captured);
  assert.deepEqual(await sameGenerationRead, haltProof); assert.deepEqual(haltedSupervisor.snapshot(), haltedSnapshot);
});

test("same-run inspection completed backwards cannot replace the latest baseline, dispatch closure or Host sink", async () => {
  const ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const native = await supervisor.start(start(), () => {}), first = deferred<OwnedAttachment>(), second = deferred<OwnedAttachment>();
  let reads = 0, freshDispatches = 0; const oldEvents: NativeEvent[] = [], newEvents: NativeEvent[] = [], original = ownership.attachment!;
  ownership.inspect = async () => ++reads === 1 ? first.promise : second.promise;
  const readingOld = supervisor.inspect(native.run, event => oldEvents.push(event)), readingNew = supervisor.inspect(native.run, event => newEvents.push(event));
  second.resolve({ ...original, native: { ...original.native, selection: { kind: "codex", model: "latest-baseline" }, invoke: async () => { freshDispatches++; return { status: "acknowledged" }; } } });
  const refreshed = await readingNew; assert.ok(refreshed && !("state" in refreshed)); assert.deepEqual(refreshed.selection, { kind: "codex", model: "latest-baseline" });
  const snapshot = supervisor.snapshot(); first.resolve(original); await assert.rejects(readingOld, { code: "FENCED" }); assert.deepEqual(supervisor.snapshot(), snapshot);
  ownership.emissions[0]!({ type: "native", identity: original.identity, event: { type: "activity", run: native.run, activity: "waiting" } });
  assert.equal(oldEvents.length, 0); assert.equal(newEvents.length, 1);
  await native.invoke({ type: "send", text: "uses latest accepted controller" }); assert.equal(freshDispatches, 1); assert.equal(ownership.calls.length, 0);
  const positive = deferred<RuntimeHalt>(), baseline = deferred<OwnedAttachment>(); reads = 0;
  ownership.inspect = async () => ++reads === 1 ? positive.promise : baseline.promise;
  const readingProof = supervisor.inspect(native.run, () => {}), readingBaseline = supervisor.inspect(native.run, () => {});
  positive.resolve(ownership.proof()); assert.deepEqual(await readingProof, ownership.proof().proof);
  baseline.resolve(original); assert.deepEqual(await readingBaseline, ownership.proof().proof);
  await assert.rejects(native.invoke({ type: "send", text: "must remain halted" }));
  const retained = new ScriptedRuntimeOwnership(), fresh = new RuntimeSupervisor({ scope: runtimeScope, ownership: retained }), run: RunRef = { scope: runtimeScope, generation: 7, nativeSession: "retained-halted" };
  const identity = retained.owned(run).identity; retained.inspection = retained.proof(identity);
  assert.deepEqual(await fresh.inspect(run, () => {}), retained.proof(identity).proof);
  retained.inspection = retained.owned(run); assert.deepEqual(await fresh.inspect(run, () => {}), retained.proof(identity).proof);
  assert.equal(retained.inspections.length, 1, "a retained exact halt cannot be replaced by another same-run read");
});

test("actual SessionHost retains Running through controller loss, Stopping through deadline, then only exact tree proof permits Stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-runtime-host-")), ownership = new ScriptedRuntimeOwnership(), supervisor = new RuntimeSupervisor({ scope: runtimeScope, ownership }), stop = deferred<RuntimeHalt>();
  ownership.stopGate = stop.promise;
  let host = await SessionHost.open({ directory, scope: runtimeScope, port: supervisor, policy, observationMs: 30 });
  try {
    await host.submit({ scope: runtimeScope, id: "create-host-original", generation: 0, command: { type: "create" } });
    await until(async () => (await host.receipt(runtimeScope, "create-host-original"))?.state === "acknowledged");
    ownership.observe({ controller: "lost", transport: "lost", leader: "exited" });
    assert.equal((await host.snapshot(runtimeScope)).phase, "running");
    const receipt = await host.submit({ scope: runtimeScope, id: "stop-host-original", generation: 1, command: { type: "stop" } });
    assert.equal(receipt.state, "outcomeUnknown"); assert.equal((await host.snapshot(runtimeScope)).phase, "stopping"); assert.equal(ownership.stopCalls, 1);
    stop.resolve(ownership.proof()); await until(async () => (await host.snapshot(runtimeScope)).phase === "stopped");
    await until(async () => (await host.receipt(runtimeScope, "stop-host-original"))?.state === "acknowledged");
    assert.equal(ownership.stopCalls, 1); assert.equal(ownership.opens.length, 1);
    await host.close(); host = await SessionHost.open({ directory, scope: runtimeScope, port: supervisor, policy, observationMs: 30 });
    assert.equal((await host.snapshot(runtimeScope)).phase, "stopped"); assert.equal(ownership.opens.length, 1); assert.equal(ownership.inspections.length, 0);
  } finally { await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});
