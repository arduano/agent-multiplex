import assert from "node:assert/strict";
import test from "node:test";
import type { NativeEvent, NativeOpening, NativeRun, NativeStart, OpeningCapsule, OpeningStopProof, Receipt, RunRef, SessionPort } from "../src/contracts/types.js";
import { defer, fixture, scope, ScriptedPort, until } from "./host-fixture.js";

type Attempt = {
  input: NativeStart; capsule: OpeningCapsule; opening: NativeOpening;
  emit: (event: NativeEvent) => void; onOwned: ((run: NativeRun) => Promise<void>) | undefined;
  published: ReturnType<typeof defer<void>>; result: ReturnType<typeof defer<NativeRun>>;
};

/** A private acquisition capability exists before any vendor ID. No native
 * executable or provider is used; the real SessionHost/journal owns admission. */
class OpeningPort extends ScriptedPort {
  readonly attempts: Attempt[] = [];
  readonly openingInspections: OpeningCapsule[] = [];
  openingStops = 0;
  stopResults: Array<(attempt: Attempt) => Promise<OpeningStopProof>> = [];
  inspectOpeningResult: NativeOpening | OpeningStopProof | null | undefined;
  override async start(input: NativeStart, emit: (event: NativeEvent) => void, onOwned?: (run: NativeRun) => Promise<void>, onOpening?: (opening: NativeOpening) => Promise<void>): Promise<NativeRun> {
    this.starts.push(input);
    const capsule: OpeningCapsule = {
      opening: { scope: input.scope, generation: input.generation, operationId: input.operationId },
      identity: { attachment: `private-opening-${input.generation}`, process: `private-process-${input.generation}`, containment: `private-containment-${input.generation}`, placement: this.placement },
    };
    let attempt!: Attempt;
    const opening: NativeOpening = { ...capsule, stop: async () => { this.openingStops++; return this.stopResults.shift()?.(attempt) ?? this.openingProof(attempt); } };
    attempt = { input, capsule, opening, emit, onOwned, published: defer<void>(), result: defer<NativeRun>() };
    this.attempts.push(attempt);
    await onOpening?.(opening); attempt.published.resolve();
    return attempt.result.promise;
  }
  openingProof(attempt = this.attempts.at(-1)!): OpeningStopProof { return { ...attempt.capsule, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true }; }
  async inspectOpening(capsule: OpeningCapsule): Promise<NativeOpening | OpeningStopProof | null> {
    this.openingInspections.push(structuredClone(capsule));
    return this.inspectOpeningResult === undefined ? this.attempts.find(attempt => attempt.input.operationId === capsule.opening.operationId)!.opening : this.inspectOpeningResult;
  }
  native(attempt: Attempt, nativeSession = attempt.input.nativeSession ?? "actual-native-id"): NativeRun {
    const run: RunRef = { scope: attempt.input.scope, generation: attempt.input.generation, nativeSession };
    return { ...super.handle(run), initializationComplete: true };
  }
  async publishId(attempt: Attempt, nativeSession?: string): Promise<NativeRun> {
    const native = this.native(attempt, nativeSession); await attempt.onOwned?.({ ...native, initializationComplete: false }); return native;
  }
  settleAll(): void { for (const attempt of this.attempts) attempt.result.resolve(this.native(attempt)); }
}

const original = (id: string, generation = 0) => ({ scope, id, generation, command: { type: "create" as const } });
async function ready(port: OpeningPort, index = 0): Promise<Attempt> { await until(() => port.attempts.length > index); const attempt = port.attempts[index]!; await attempt.published.promise; return attempt; }
async function acknowledged(port: SessionPort, id: string): Promise<void> { await until(async () => (await port.receipt(scope, id))?.state === "acknowledged"); }
function privateBoundary(snapshot: unknown, receipt?: Receipt): void {
  const projected = JSON.stringify([snapshot, receipt ?? null]);
  assert.ok(!projected.includes("private-process-")); assert.ok(!projected.includes("private-containment-")); assert.ok(!projected.includes("private-opening-"));
}

test("a hung pre-ID Create remains unknown and nonreplaceable while its durable opening capability makes exact Stop possible", async () => {
  const port = new OpeningPort(), stopped = defer<OpeningStopProof>(), f = await fixture(port, { observationMs: 25 });
  try {
    const creating = f.host.submit(original("original-create")); const attempt = await ready(port); const observed = await creating;
    assert.equal(observed.state, "outcomeUnknown"); const starting = await f.host.snapshot(scope);
    assert.equal(starting.phase, "starting"); assert.equal(starting.nativeSession, null); privateBoundary(starting, observed);
    assert.equal((await f.host.submit(original("replacement-while-opening", starting.generation))).state, "refused"); assert.equal(port.starts.length, 1);
    port.stopResults.push(() => stopped.promise);
    const stopping = f.host.submit({ scope, id: "stop-original-opening", generation: starting.generation, command: { type: "stop" } });
    await until(() => port.openingStops === 1); assert.equal((await f.host.snapshot(scope)).phase, "stopping"); assert.equal(port.stops, 0);
    stopped.resolve(port.openingProof(attempt)); await stopping; await acknowledged(f.host, "stop-original-opening");
    const halted = await f.host.snapshot(scope); assert.equal(halted.phase, "stopped"); assert.equal(halted.nativeSession, null);
    assert.equal((await f.host.receipt(scope, "original-create"))!.state, "outcomeUnknown");
    assert.equal((await f.host.submit(original("replacement-after-sealed-stop", halted.generation))).state, "refused");
    assert.equal((await f.host.submit({ scope, id: "resume-without-identity", generation: halted.generation, command: { type: "resume" } })).state, "refused");
    assert.equal(port.starts.length, 1); assert.equal(port.openingStops, 1); privateBoundary(halted);
    await f.host.close();
  } finally { if (port.attempts.length) stopped.resolve(port.openingProof()); port.settleAll(); await f.dispose(); }
});

test("a foreign or unsealed opening proof cannot certify Stopped or license a replacement native acquisition", async () => {
  const port = new OpeningPort(), f = await fixture(port, { observationMs: 25 });
  try {
    const creating = f.host.submit(original("proof-original")); const attempt = await ready(port); await creating;
    const generation = (await f.host.snapshot(scope)).generation;
    port.stopResults.push(async current => ({ ...port.openingProof(current), identity: { ...current.capsule.identity, containment: "foreign-private-containment" } }));
    const wrong = await f.host.submit({ scope, id: "wrong-owner-stop", generation, command: { type: "stop" } }); assert.equal(wrong.state, "outcomeUnknown");
    assert.equal((await f.host.snapshot(scope)).phase, "stopping"); assert.equal((await f.host.snapshot(scope)).nativeSession, null);
    assert.equal((await f.host.submit(original("replacement-after-foreign-proof", generation))).state, "refused");
    port.stopResults.push(async current => ({ ...port.openingProof(current), acquisitionSealed: false } as unknown as OpeningStopProof));
    const unsealed = await f.host.submit({ scope, id: "unsealed-stop", generation, command: { type: "stop" } }); assert.equal(unsealed.state, "outcomeUnknown"); assert.equal((await f.host.snapshot(scope)).phase, "stopping");
    await f.host.submit({ scope, id: "valid-explicit-stop", generation, command: { type: "stop" } }); await acknowledged(f.host, "valid-explicit-stop");
    assert.equal((await f.host.snapshot(scope)).phase, "stopped"); assert.equal(port.starts.length, 1); assert.equal(port.openingStops, 3); assert.equal(port.stops, 0); privateBoundary(await f.host.snapshot(scope));
    // Exact original receipt reads do not cause a second native Stop.
    assert.equal((await f.host.receipt(scope, "wrong-owner-stop"))!.state, "outcomeUnknown"); assert.equal(port.openingStops, 3);
    assert.equal(attempt.capsule.opening.operationId, "proof-original");
  } finally { port.settleAll(); await f.dispose(); }
});

test("actual ID promotion changes custody to that native run; late opening/ID/final events cannot revive or poison its explicit Resume", async () => {
  const port = new OpeningPort(), f = await fixture(port, { observationMs: 25 });
  try {
    const creating = f.host.submit(original("promoted-original")); const first = await ready(port), owned = await port.publishId(first); await creating;
    const starting = await f.host.snapshot(scope); assert.equal(starting.phase, "starting"); assert.equal(starting.nativeSession, owned.run.nativeSession); privateBoundary(starting);
    await f.host.submit({ scope, id: "stop-promoted-run", generation: starting.generation, command: { type: "stop" } }); await acknowledged(f.host, "stop-promoted-run");
    assert.equal(port.stops, 1); assert.equal(port.openingStops, 0, "promotion must not leave two independently stoppable owners");
    const halted = await f.host.snapshot(scope); assert.equal(halted.phase, "stopped"); assert.equal(halted.nativeSession, owned.run.nativeSession);
    const resuming = f.host.submit({ scope, id: "explicit-resume", generation: halted.generation, command: { type: "resume" } }); const second = await ready(port, 1);
    assert.equal(second.input.nativeSession, owned.run.nativeSession); assert.equal("continuePendingWork" in second.input, false);
    const resumed = await port.publishId(second); second.result.resolve(resumed); await resuming; await acknowledged(f.host, "explicit-resume");
    const beforeLate = await f.host.snapshot(scope);
    await first.onOwned?.({ ...port.native(first, "late-old-native-id"), initializationComplete: false }).catch(() => {});
    first.emit({ type: "selection", run: owned.run, selection: { kind: "codex", model: "poison-old-model" } });
    first.emit({ type: "activity", run: owned.run, activity: "working" });
    first.result.resolve({ ...owned, selection: { kind: "codex", model: "poison-old-final" } });
    await new Promise<void>(done => setImmediate(done)); await f.host.receipt(scope, "promoted-original");
    const current = await f.host.snapshot(scope); assert.equal(current.phase, "running"); assert.equal(current.generation, 2); assert.equal(current.nativeSession, owned.run.nativeSession); assert.ok(!JSON.stringify(current).includes("poison-old"));
    assert.equal(current.activity, beforeLate.activity); assert.deepEqual(current.selection, beforeLate.selection); assert.equal(current.issue, beforeLate.issue); assert.equal(port.starts.length, 2); assert.equal(port.calls.length, 0);
    assert.equal((await f.host.receipt(scope, "promoted-original"))!.state, "outcomeUnknown");
    await f.host.submit({ scope, id: "last-stop", generation: current.generation, command: { type: "stop" } }); await acknowledged(f.host, "last-stop"); await f.host.close();
  } finally { port.settleAll(); await f.dispose(); }
});

test("writer reopen inspects the exact private pre-ID capsule without activation or replay and retains uncertainty until explicit exact Stop", async () => {
  const port = new OpeningPort(), f = await fixture(port, { observationMs: 25 });
  try {
    const creating = f.host.submit(original("durable-opening")); const attempt = await ready(port); await creating;
    const prior = await f.host.snapshot(scope); assert.equal(prior.nativeSession, null); await f.reopen();
    assert.deepEqual(port.openingInspections, [attempt.capsule]); assert.equal(port.inspections.length, 0); assert.equal(port.starts.length, 1); assert.equal(port.openingStops, 0); assert.equal(port.stops, 0);
    const restored = await f.host.snapshot(scope); assert.ok(restored.epoch > prior.epoch); assert.equal(restored.generation, prior.generation); assert.equal(restored.nativeSession, null); assert.notEqual(restored.phase, "stopped"); privateBoundary(restored, (await f.host.receipt(scope, "durable-opening"))!);
    assert.equal((await f.host.submit(original("replacement-after-reopen", restored.generation))).state, "refused"); assert.equal(port.starts.length, 1);
    await f.host.submit({ scope, id: "stop-reopened-opening", generation: restored.generation, command: { type: "stop" } }); await acknowledged(f.host, "stop-reopened-opening"); assert.equal(port.openingStops, 1);
    assert.equal((await f.host.snapshot(scope)).phase, "stopped"); assert.equal((await f.host.snapshot(scope)).nativeSession, null);
    assert.equal((await f.host.receipt(scope, "durable-opening"))!.state, "outcomeUnknown");
    assert.equal((await f.host.submit(original("replacement-after-reopened-stop", restored.generation))).state, "refused");
    await f.host.close();
  } finally { port.settleAll(); await f.dispose(); }
});
