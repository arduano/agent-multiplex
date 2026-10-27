import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openHost, type AgentHost } from "../../v8-lifecycle-default/src/node.js";
import type { Harness, ManagedPolicy, NativeStart, SessionScope } from "../../v8-session/src/contracts/types.js";
import { createCodexController, type CodexReverseRequest, type CodexTransport } from "../../v8-harness-codex/src/controller.js";
import { CodexStdioRpc, type CodexWire } from "../../v8-harness-codex/src/rpc.js";
import type { CopilotSessionConfig } from "../../v8-harness-copilot/src/controller.js";
import { scriptedHost, ScriptedContainment, deferred, until, type ScriptCounts } from "./fixture.js";

export const hostScope: SessionScope = { connection: "host-fixture", principal: "owner", host: "local", session: "logical" };
const policy = (kind: Harness): ManagedPolicy => kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" };
async function fixture(kind: Harness) {
  const directory = await mkdtemp(join(tmpdir(), "v8-host-assembly-")), driver = scriptedHost(kind, { cwd: directory });
  const options = { directory, cwd: directory, scope: hostScope, policy: policy(kind), controller: driver.controller, observationMs: 60000 };
  let host = await openHost(options);
  return { driver, directory, get host() { return host; }, async open() { await host.terminate(); host = await openHost(options); },
    async submit(command: Parameters<AgentHost["session"]["submit"]>[0]["command"], id: string) { return host.session.submit({ scope: hostScope, id, generation: (await host.session.snapshot(hostScope)).generation, command }); },
    async dispose() { await host.terminate(); await rm(directory, { recursive: true, force: true }); } };
}

test("archive cannot outlive an expired MCP observer while the actual native discovery remains owned", async () => {
  const f = await fixture("codex"), entered = deferred<void>(), released = deferred<void>(); let calls = 0;
  f.driver.controller.nativeMcp = () => ({ kind: "codex", status: async () => { calls++; entered.resolve(); await released.promise; return { data: [], nextCursor: null }; } });
  try {
    await f.submit({ type: "create" }, "create"); const binding = (await f.host.binding())!;
    const observation = f.host.mcp.refresh(binding.run, { timeoutMs: 1 }); void observation.catch(() => {}); await entered.promise;
    await assert.rejects(observation, { code: "TIMEOUT" }); await f.submit({ type: "stop" }, "stop");
    assert.equal((await f.submit({ type: "archive" }, "busy-mcp-archive")).state, "refused");
    assert.equal((await f.host.session.snapshot(hostScope)).archive, undefined);
    released.resolve(); await until(() => f.host.updateReadiness().ready);
    assert.equal((await f.submit({ type: "archive" }, "archive")).state, "acknowledged"); assert.equal(calls, 1);
  } finally { released.resolve(); await f.dispose(); }
});

for (const kind of ["codex", "copilot"] as const) test(`${kind} concrete controller assembles actual owners: no implicit start/discovery/read; Send text+tool+terminal persists without viewers; explicit Stop/Resume waits`, async () => {
  const f = await fixture(kind);
  try {
    assert.equal(await f.host.binding(), null); assert.equal(f.host.fileScope(), null); assert.equal(f.driver.counts.opens, 0); assert.equal(f.driver.counts.discovery, 0);
    const create = await f.submit({ type: "create" }, "original-create"); assert.equal(create.state, "acknowledged");
    const binding = (await f.host.binding())!; assert.equal(binding.run.nativeSession, f.host.fileScope()!.session); assert.notEqual(binding.run.nativeSession, hostScope.session);
    assert.equal(f.host.history.snapshot(binding.history).coverage.knownStart, true);
    await f.submit({ type: "send", text: "one original" }, "original-send"); await f.submit({ type: "send", text: "one original" }, "original-send");
    const rows = f.host.history.snapshot(binding.history).rows;
    assert.ok(rows.some(row => row.kind === "assistant" && row.body.kind !== "unavailable" && row.body.text.includes("one original")));
    assert.ok(rows.some(row => row.kind === "tool" && row.body.kind !== "unavailable" && row.body.text === "scripted terminal output\n"));
    assert.equal(f.driver.counts.sends, 1); assert.equal(f.driver.counts.bodyReads, 0); assert.equal(f.driver.counts.discovery, 0);
    assert.equal((await f.host.mcp.snapshot(binding.run)).freshness, "unobserved"); await f.host.mcp.refresh(binding.run); assert.equal(f.driver.counts.discovery, 1);
    await f.submit({ type: "stop" }, "original-stop"); assert.equal((await f.host.mcp.snapshot(binding.run)).freshness, "retired");
    const before = f.host.history.snapshot(binding.history).rows.length;
    await f.submit({ type: "resume" }, "original-resume");
    const resumed = (await f.host.binding())!; assert.equal(resumed.run.nativeSession, binding.run.nativeSession); assert.equal(resumed.run.generation, 2);
    assert.deepEqual(resumed.history, binding.history); assert.equal(f.host.history.snapshot(resumed.history).rows.length, before);
    assert.equal(f.driver.counts.sends, 1); assert.equal(f.driver.counts.opens, 1); assert.equal(f.driver.counts.resumes, 1);
    await f.submit({ type: "stop" }, "last-stop"); await f.host.close();
  } finally { await f.dispose(); }
});

for (const kind of ["codex", "copilot"] as const) test(`${kind} actual original answer receipt keeps native submission semantics and survives zero-viewer callback custody until exact halt`, async () => {
  const f = await fixture(kind);
  try {
    await f.submit({ type: "create" }, "create"); const binding = (await f.host.binding())!;
    const result = f.driver.requestForm(); await until(async () => (await f.host.interactions.snapshot(hostScope)).items.length === 1);
    const prompt = (await f.host.interactions.snapshot(hostScope)).items[0]!.prompt;
    const answer = await f.submit({ type: "answer", interactionId: prompt.id, choice: "accept", value: { type: prompt.type, action: "accept", content: { confirmed: true } } }, "original-answer");
    assert.equal(answer.state, "acknowledged"); assert.equal((await f.host.session.receipt(hostScope, "original-answer"))!.state, "acknowledged");
    await result; assert.equal(f.driver.counts.replies, 1);
    const current = await f.host.interactions.snapshot(hostScope);
    if (kind === "codex") { assert.equal(current.items.length, 0); assert.equal(current.baseline, "complete"); }
    else { assert.equal(current.items[0]!.state, "responseSubmitted"); assert.equal(current.baseline, "partial"); }
    const stop = deferred<ReturnType<typeof f.driver.containment.proof>>(); f.driver.containment.stopGate = stop.promise;
    const stopping = f.submit({ type: "stop" }, "stop"); await until(() => f.driver.counts.stops === 1);
    assert.notEqual((await f.host.mcp.snapshot(binding.run)).freshness, "retired");
    stop.resolve(f.driver.containment.proof()); await stopping;
    assert.equal((await f.host.interactions.snapshot(hostScope)).issue, "ownershipRetired"); assert.equal((await f.host.mcp.snapshot(binding.run)).freshness, "retired");
    assert.equal(f.driver.counts.replies, 1, "halt retires; it does not answer again");
  } finally { await f.dispose(); }
});

test("owned writer reopen inspects retained native controller without new Start or history fetch, advances Host epoch, retains exact callback", async () => {
  const f = await fixture("codex");
  try {
    await f.submit({ type: "create" }, "create"); const old = (await f.host.binding())!, oldEpoch = (await f.host.session.snapshot(hostScope)).epoch;
    const nativeResult = f.driver.requestForm(); const prompt = (await f.host.interactions.snapshot(hostScope)).items[0]!.prompt;
    await f.open(); const restored = (await f.host.binding())!;
    assert.equal(restored.run.generation, old.run.generation); assert.notEqual(restored.history.origin.attachment, old.history.origin.attachment);
    assert.ok((await f.host.session.snapshot(hostScope)).epoch > oldEpoch); assert.equal(f.host.history.snapshot(restored.history).coverage.knownStart, false);
    assert.equal(f.driver.counts.opens, 1); assert.equal(f.driver.counts.resumes, 0); assert.equal(f.driver.counts.bodyReads, 0);
    assert.equal((await f.host.interactions.snapshot(hostScope)).items[0]!.prompt.id, prompt.id);
    await f.submit({ type: "answer", interactionId: prompt.id, choice: "accept", value: { type: prompt.type, action: "accept", content: { confirmed: true } } }, "answer-after-reopen"); await nativeResult;
    await f.submit({ type: "stop" }, "stop");
  } finally { await f.dispose(); }
});

test("native-scoped FileHost remains independent of native Stop and reopens committed bytes; cold history stays explicitly unavailable", async () => {
  const f = await fixture("codex");
  try {
    await f.submit({ type: "create" }, "create"); const scope = f.host.fileScope()!, bytes = new TextEncoder().encode("owned file bytes"), manifest = { id: "fixture-upload", name: "fixture.txt", mediaType: "text/plain", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    await f.host.files.call("begin", { scope, manifest }); await f.host.files.call("write", { scope, id: manifest.id, offset: 0, data: bytes }); await f.host.files.call("commit", { scope, id: manifest.id });
    await assert.rejects(f.host.files.call("status", { scope: hostScope, id: manifest.id }), { code: "FENCED" });
    await f.submit({ type: "stop" }, "stop"); await f.open();
    assert.deepEqual(f.host.fileScope(), scope); assert.equal((await f.host.files.call("status", { scope, id: manifest.id })).state, "committed");
    assert.equal(f.host.historyRecovery.state, "unavailable"); assert.equal(f.driver.counts.bodyReads, 0); assert.equal(f.driver.counts.opens, 1);
  } finally { await f.dispose(); }
});

test("known native open remains retained through failed certificate; exact halt licenses only a new explicit controller Resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-host-open-")), driver = scriptedHost("codex", { cwd: directory }), gate = deferred<void>();
  driver.containment.certificateGate = gate.promise;
  const input: NativeStart = { scope: hostScope, generation: 1, placement: "dedicated", operationId: "open-original", nativeSession: null, policy: policy("codex") };
  const opening = driver.controller.open(input, () => {}); await until(() => driver.controller.current() !== null); gate.reject(Error("scripted certificate failure")); await assert.rejects(opening);
  const retained = driver.controller.current()!; assert.equal(driver.counts.opens, 1); assert.ok(retained.run.nativeSession);
  await assert.rejects(driver.controller.open({ ...input, generation: 2 }, () => {})); assert.equal(driver.counts.opens, 1);
  driver.containment.halt(); driver.containment.certificateGate = undefined;
  await driver.controller.open({ ...input, generation: 2, nativeSession: retained.run.nativeSession, operationId: "explicit-new-resume" }, () => {});
  assert.equal(driver.counts.resumes, 1); assert.equal(driver.counts.sends, 0); await driver.controller.inspect(driver.controller.current()!.run, () => {});
  driver.containment.halt(); driver.controller.dispose(); await rm(directory, { recursive: true, force: true });
});

test("Codex pending ingress is frozen before native open resolves, and reused vendor ID settles only its own transport capability", async () => {
  const counts: ScriptCounts = { opens: 0, resumes: 0, sends: 0, stops: 0, discovery: 0, bodyReads: 0, replies: 0 }, containment = new ScriptedContainment(counts), opened = deferred<unknown>();
  let receive: (request: CodexReverseRequest) => void = () => {};
  const transport: CodexTransport = { request: async () => opened.promise, onNotification: () => () => {}, onRequest: fn => { receive = fn; return () => {}; } };
  const controller = createCodexController({ transport, containment, cwd: "/scripted", model: "m", provider: { id: "p", copilotOnly: true }, catalog: async () => ({ available: true, choices: [] }) });
  const input: NativeStart = { scope: hostScope, generation: 1, placement: "dedicated", operationId: "create", nativeSession: null, policy: policy("codex") };
  const start = controller.open(input, () => {}), first = deferred<void>(), second = deferred<void>();
  const params = { threadId: "native", turnId: "turn", itemId: "item", command: "original", availableDecisions: ["accept", "decline"] };
  receive({ id: 1, method: "item/commandExecution/requestApproval", params, token: {}, settled: first.promise, respond: async () => ({ kind: "ack", success: true }) }); params.command = "mutated";
  opened.resolve({ thread: { id: "native" }, model: "m", modelProvider: "p", approvalPolicy: "on-request", sandbox: { type: "dangerFullAccess" } }); await start;
  const owner = controller.interactions(controller.current()!.run), original = owner.current().items[0]!.prompt;
  assert.ok(original.type === "codex.command"); assert.equal((original.detail as { command: string }).command, "original");
  receive({ id: 1, method: "item/commandExecution/requestApproval", params: { ...params, command: "replacement" }, token: {}, settled: second.promise, respond: async () => ({ kind: "ack", success: true }) });
  const replacement = owner.current().items[0]!.prompt; assert.notEqual(replacement.id, original.id); first.resolve(); await Promise.resolve();
  assert.equal(owner.current().items[0]!.prompt.id, replacement.id); second.resolve(); await Promise.resolve(); assert.equal(owner.current().items.length, 0);
  containment.halt(); controller.dispose();
});

test("unsupported named-profile Codex opening never reaches native transport", async () => {
  const driver = scriptedHost("codex", { cwd: "/scripted" });
  const input: NativeStart = { scope: hostScope, generation: 1, placement: "dedicated", operationId: "create", nativeSession: null, policy: policy("codex"), selection: { kind: "codex", access: { approval: "on-request", profile: "unavailable-profile-encoder" } } };
  await assert.rejects(driver.controller.open(input, () => {})); assert.equal(driver.counts.opens, 0); assert.equal(driver.requests.length, 0);
});

test("post-open certification failure preserves a visible answerable native owner across writer reopen; exact Stop enables only explicit Resume", async () => {
  const f = await fixture("codex"), certificate = deferred<void>(); f.driver.containment.certificateGate = certificate.promise;
  try {
    const creating = f.submit({ type: "create" }, "failed-original-create");
    await until(async () => (await f.host.session.snapshot(hostScope)).nativeSession !== null);
    const first = (await f.host.binding())!; assert.equal((await f.host.session.snapshot(hostScope)).phase, "starting");
    const nativeResult = f.driver.requestForm(); await until(async () => (await f.host.interactions.snapshot(hostScope)).items.length === 1);
    const prompt = (await f.host.interactions.snapshot(hostScope)).items[0]!.prompt;
    const answer = await f.submit({ type: "answer", interactionId: prompt.id, choice: "accept", value: { type: prompt.type, action: "accept", content: { confirmed: true } } }, "answer-during-init");
    assert.equal(answer.state, "acknowledged"); await nativeResult;
    assert.equal((await f.submit({ type: "send", text: "must not dispatch" }, "blocked-send")).state, "refused");
    certificate.reject(Error("scripted certification failed")); assert.equal((await creating).state, "outcomeUnknown");
    await f.open(); const restored = (await f.host.binding())!;
    assert.deepEqual(restored.run, first.run); assert.equal((await f.host.session.snapshot(hostScope)).phase, "starting");
    assert.equal(f.driver.counts.opens, 1); assert.equal(f.driver.counts.resumes, 0);
    assert.equal((await f.submit({ type: "stop" }, "stop-partial-open")).state, "acknowledged");
    f.driver.containment.certificateGate = undefined;
    assert.equal((await f.submit({ type: "resume" }, "new-explicit-resume")).state, "acknowledged");
    const resumed = (await f.host.binding())!; assert.equal(resumed.run.generation, 2); assert.equal(resumed.run.nativeSession, first.run.nativeSession);
    assert.equal((await f.host.session.snapshot(hostScope)).activity, "idle"); assert.equal(f.driver.counts.sends, 0); assert.equal(f.driver.counts.resumes, 1);
    assert.equal((await f.host.session.receipt(hostScope, "failed-original-create"))!.state, "outcomeUnknown");
    await f.submit({ type: "stop" }, "final-stop");
  } finally { await f.dispose(); }
});

test("urgent Stop bypasses unsettled Copilot initialization; old metadata completion cannot dispatch steps or change explicit Resume", async () => {
  const f = await fixture("copilot"), metadata = deferred<unknown>(); f.driver.metadataGate = metadata.promise;
  try {
    const creating = f.submit({ type: "create" }, "pending-original-create");
    await until(async () => (await f.host.session.snapshot(hostScope)).nativeSession !== null && f.driver.requests.some(row => row.method === "model.getCurrent"));
    const oldConfig = f.driver.requests.find(row => row.method === "session.create")!.params as CopilotSessionConfig;
    const first = (await f.host.binding())!; assert.equal((await f.host.session.snapshot(hostScope)).phase, "starting");
    assert.equal((await f.submit({ type: "stop" }, "urgent-stop-init")).state, "acknowledged");
    assert.equal((await creating).state, "outcomeUnknown"); assert.equal(f.driver.counts.stops, 1);
    f.driver.metadataGate = undefined;
    assert.equal((await f.submit({ type: "resume" }, "explicit-resume-before-old-settles")).state, "acknowledged");
    const resumed = (await f.host.binding())!; assert.equal(resumed.run.generation, 2); assert.equal(resumed.run.nativeSession, first.run.nativeSession);
    const permissionSteps = f.driver.requests.filter(row => row.method.startsWith("permissions.")).length;
    oldConfig.onEvent({ id: "late-old-event", type: "assistant.turn_start", data: { turnId: "dead-old-turn" } });
    void oldConfig.onUserInputRequest({ question: "dead old callback", choices: ["yes"] }, { sessionId: first.run.nativeSession });
    metadata.resolve({ modelId: "scripted-model", providerId: "scripted-provider" });
    await new Promise(done => setTimeout(done, 20));
    assert.equal(f.driver.requests.filter(row => row.method.startsWith("permissions.")).length, permissionSteps);
    assert.deepEqual((await f.host.binding())!.run, resumed.run); assert.equal((await f.host.session.snapshot(hostScope)).phase, "running");
    assert.equal((await f.host.session.snapshot(hostScope)).activity, "idle"); assert.equal(f.driver.counts.opens, 1); assert.equal(f.driver.counts.resumes, 1); assert.equal(f.driver.counts.sends, 0);
    assert.equal((await f.host.interactions.snapshot(hostScope)).items.length, 0); assert.equal((await f.host.interactions.snapshot(hostScope)).baseline, "complete");
    await f.submit({ type: "stop" }, "final-stop");
  } finally { metadata.resolve({ modelId: "scripted-model", providerId: "scripted-provider" }); await f.dispose(); }
});

test("Copilot unique permission completion settles independently; reused vendor ID cannot let delayed raw completion clear replacement", async () => {
  const driver = scriptedHost("copilot", { cwd: "/scripted" });
  const input: NativeStart = { scope: hostScope, generation: 1, placement: "dedicated", operationId: "permission-lifetime", nativeSession: null, policy: policy("copilot") };
  await driver.controller.open(input, () => {});
  const run = driver.controller.current()!.run, owner = driver.controller.interactions(run);
  const requested = (requestId: string) => driver.event("permission.requested", { requestId, permissionRequest: { kind: "shell", fullCommandText: "scripted harmless command" } });
  requested("vendor-id"); const first = owner.current().items[0]!.prompt;
  driver.event("permission.completed", { requestId: "vendor-id" });
  assert.equal(owner.current().items.length, 0); assert.equal(owner.current().baseline, "complete"); assert.equal(driver.counts.replies, 0);
  requested("vendor-id"); const replacement = owner.current().items[0]!.prompt; assert.notEqual(replacement.id, first.id);
  driver.event("permission.completed", { requestId: "vendor-id" });
  assert.equal(owner.current().items[0]!.prompt.id, replacement.id); assert.equal(owner.current().baseline, "partial");
  assert.equal((await owner.invoke({ type: "answer", interactionId: first.id, choice: "reject", value: { type: "copilot.permission", kind: "reject" } })).status, "targetUnavailable");
  assert.equal((await owner.invoke({ type: "answer", interactionId: replacement.id, choice: "reject", value: { type: "copilot.permission", kind: "reject" } })).status, "acknowledged");
  assert.equal(driver.counts.replies, 1); assert.equal(owner.current().items.length, 0);
  // The ambiguity was a real native observation gap. Answer ACK settles its
  // original, but does not manufacture a newly complete callback baseline.
  assert.equal(owner.current().baseline, "partial");
  requested("independent-id"); driver.event("permission.completed", { requestId: "independent-id" }); assert.equal(owner.current().items.length, 0);
  driver.containment.halt(); driver.controller.dispose();
});

for (const kind of ["codex", "copilot"] as const) test(`${kind} actual Host native actions reuse original journal, preserve native no-op outcomes, and fence held reads across Stop/Resume`, async () => {
  const f = await fixture(kind), gate = deferred<unknown>();
  try {
    await f.submit({ type: "create" }, "create"); const binding = (await f.host.binding())!, readType = kind === "codex" ? "codex.goal" as const : "copilot.queue" as const;
    const state = await f.host.session.read(binding.run, { type: readType }); assert.equal(state.type, readType);
    const revision = (await f.host.session.snapshot(hostScope)).revision;
    if (kind === "codex") f.driver.notify("thread/goal/updated", { threadId: binding.run.nativeSession }); else f.driver.event("pending_messages.modified", {});
    assert.ok((await f.host.session.snapshot(hostScope)).revision > revision, "native state invalidation reaches the retained Session stream");
    if (kind === "codex") {
      assert.deepEqual((await f.submit({ type: "codex.steer", expectedTurnId: "exact-turn", text: "steer once" }, "original-steer")).outcome, { status: "accepted", detail: { turnId: "exact-turn" } });
      assert.equal((await f.submit({ type: "codex.compact" }, "compact")).outcome?.status, "acknowledged");
      assert.equal((await f.submit({ type: "codex.goal.set", objective: "Scripted goal", tokenBudget: null }, "goal")).outcome?.status, "applied");
      assert.deepEqual((await f.submit({ type: "codex.goal.clear" }, "clear")).outcome?.detail, { cleared: false });
    } else {
      assert.equal((await f.submit({ type: "copilot.steer", text: "immediate once" }, "original-steer")).outcome?.status, "accepted");
      assert.deepEqual((await f.submit({ type: "copilot.queue.promote", id: "scripted-queue" }, "promote-queue")).outcome?.detail, { id: "scripted-queue", steered: false });
      const queue = await f.host.session.read(binding.run, { type: "copilot.queue" }); assert.equal(queue.type === "copilot.queue" && queue.items[0]?.id, "scripted-queue");
      await f.submit({ type: "copilot.compact" }, "compact");
      assert.deepEqual((await f.submit({ type: "copilot.task.cancel", id: "scripted-task" }, "cancel-task")).outcome?.detail, { id: "scripted-task", cancelled: false });
      await f.submit({ type: "copilot.task.promote", id: "scripted-task" }, "promote-task");
      const tasks = await f.host.session.read(binding.run, { type: "copilot.tasks" }); assert.equal(tasks.type === "copilot.tasks" && tasks.tasks.length, 1);
      const methods = f.driver.requests.map(call => call.method); assert.ok(methods.indexOf("tasks.refresh") < methods.indexOf("tasks.list"));
      assert.equal((await f.host.session.read(binding.run, { type: "copilot.task.progress", id: "scripted-task" })).type, "copilot.task.progress");
      assert.equal((await f.host.session.read(binding.run, { type: "copilot.task.promotable" })).type, "copilot.task.promotable");
    }
    const before = f.driver.requests.length;
    await f.submit(kind === "codex" ? { type: "codex.steer", expectedTurnId: "exact-turn", text: "steer once" } : { type: "copilot.steer", text: "immediate once" }, "original-steer");
    assert.equal(f.driver.requests.length, before, "the original ID never dispatches twice");
    f.driver.action = async () => gate.promise;
    const pending = f.host.session.read(binding.run, { type: readType }), same = f.host.session.read(binding.run, { type: readType }); assert.equal(same, pending);
    await until(() => f.driver.requests.length > before);
    const late = assert.rejects(pending, (error: unknown) => error instanceof Error && "code" in error && error.code === "FENCED");
    await f.submit({ type: "stop" }, "stop");
    f.driver.action = undefined; await f.submit({ type: "resume" }, "resume");
    gate.resolve(kind === "codex" ? { goal: null } : { items: [], steeringMessages: [] }); await late;
    await assert.rejects(async () => f.host.session.read(binding.run, { type: readType }), (error: unknown) => error instanceof Error && "code" in error && error.code === "FENCED");
    const current = (await f.host.binding())!; assert.equal((await f.host.session.read(current.run, { type: readType })).run.generation, 2);
    assert.ok(!f.driver.requests.some(call => call.method === "turn/start"), "actions never fallback to ordinary Send");
    await f.submit({ type: "stop" }, "last-stop");
  } finally { gate.resolve({}); await f.dispose(); }
});

for (const kind of ["codex", "copilot"] as const) test(`${kind} a lost native action reply remains one uncertain original and is never replayed on receipt lookup`, async () => {
  const f = await fixture(kind);
  try {
    await f.submit({ type: "create" }, "create"); let effects = 0;
    f.driver.action = async () => { effects++; throw new Error("scripted reply lost after native effect"); };
    const command = kind === "codex" ? { type: "codex.compact" as const } : { type: "copilot.queue.promote" as const, id: "exact-native-queue" };
    const receipt = await f.submit(command, "uncertain-original"); assert.equal(receipt.state, "outcomeUnknown"); assert.equal(effects, 1);
    assert.equal((await f.host.session.receipt(hostScope, "uncertain-original"))?.state, "outcomeUnknown"); await f.submit(command, "uncertain-original"); assert.equal(effects, 1);
    await f.submit({ type: "stop" }, "stop");
  } finally { await f.dispose(); }
});

test("Codex explicit native enqueue derives causal identity from the durable original, strips echoed input and never retries a lost reply", async () => {
  const f = await fixture("codex");
  try {
    await f.submit({ type: "create" }, "create");
    const command = { type: "codex.queue.add" as const, text: "one exact queued original" }, receipt = await f.submit(command, "queue-original");
    assert.equal(receipt.state, "acknowledged"); assert.deepEqual(receipt.outcome, { status: "accepted", detail: { queuedSubmission: { id: "scripted-native-queue", clientUserMessageId: "queue-original" } } });
    await f.submit(command, "queue-original");
    const calls = f.driver.requests.filter(call => call.method === "thread/queue/add"); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.params, { threadId: (await f.host.binding())!.run.nativeSession, clientUserMessageId: "queue-original", input: [{ type: "text", text: command.text, text_elements: [] }] });
    assert.ok(!JSON.stringify(receipt).includes(command.text), "receipt keeps only the exact native acceptance identities");
    let effects = 0; f.driver.action = async (method, params) => { assert.equal(method, "thread/queue/add"); assert.equal((params as { clientUserMessageId: string }).clientUserMessageId, "queue-reply-lost"); effects++; throw Error("scripted reply lost after enqueue"); };
    const lost = await f.submit(command, "queue-reply-lost"); assert.equal(lost.state, "outcomeUnknown");
    await f.host.session.receipt(hostScope, "queue-reply-lost"); await f.submit(command, "queue-reply-lost"); assert.equal(effects, 1);
    assert.equal(f.driver.requests.filter(call => call.method === "turn/start" || call.method === "turn/steer").length, 0, "explicit enqueue never falls back to another native action");
    await f.submit({ type: "stop" }, "stop");
  } finally { await f.dispose(); }
});


/** Actual JSON frame/reverse-capability owner, with an in-memory native peer.
 * No process, SDK, service, network or model is created by this fixture. */
function confirmationWireFixture(cwd: string, startup?: () => void) {
  const counts: ScriptCounts = { opens: 0, resumes: 0, sends: 0, stops: 0, discovery: 0, bodyReads: 0, replies: 0 };
  const containment = new ScriptedContainment(counts), data = new Set<(value: string) => void>(), closed = new Set<() => void>();
  const notifications = new Set<(value: import("../../v8-harness-codex/src/controller.js").CodexNotification) => void>();
  const requests = new Set<(value: CodexReverseRequest) => void>(), lost = new Set<() => void>();
  const frame = (value: unknown) => { for (const emit of data) emit(JSON.stringify(value) + "\n"); };
  const notify = (method: string, params: unknown) => frame({ method, params });
  const wire: CodexWire = {
    onData: fn => { data.add(fn); return () => { data.delete(fn); }; },
    onClose: fn => { closed.add(fn); return () => { closed.delete(fn); }; }, close: async () => {},
    write: async text => {
      const message = JSON.parse(text) as { id?: string | number; method?: string; params?: { model?: string; modelProvider?: string; approvalPolicy?: string } };
      if (message.method === "thread/start") {
        counts.opens++; startup?.(); const params = message.params!;
        frame({ id: message.id, result: { thread: { id: "wire-root" }, model: params.model, modelProvider: params.modelProvider, approvalPolicy: params.approvalPolicy, sandbox: { type: "dangerFullAccess" } } });
      } else if (message.method === "turn/start") {
        counts.sends++; const turn = { id: `wire-send-${counts.sends}`, status: "inProgress" };
        notify("turn/started", { threadId: "wire-root", turn });
        notify("turn/completed", { threadId: "wire-root", turn: { ...turn, status: "completed" } });
        frame({ id: message.id, result: { turn } });
      } else if (message.method === undefined && message.id !== undefined) {
        counts.replies++; notify("serverRequest/resolved", { threadId: "wire-root", requestId: message.id });
      } else frame({ id: message.id, result: {} });
    },
  };
  const rpc = new CodexStdioRpc(wire, value => { for (const fn of notifications) fn(value); }, value => { for (const fn of requests) fn(value); }, () => { for (const fn of lost) fn(); });
  const transport: CodexTransport = { request: (method, params) => rpc.request(method, params),
    onNotification: fn => { notifications.add(fn); return () => { notifications.delete(fn); }; },
    onRequest: fn => { requests.add(fn); return () => { requests.delete(fn); }; },
    onDisconnect: fn => { lost.add(fn); return () => { lost.delete(fn); }; } };
  const controller = createCodexController({ transport, containment, cwd, model: "wire-model", provider: { id: "wire-provider", copilotOnly: true }, catalog: async () => ({ available: true, choices: [] }) });
  containment.onCertified = () => notify("thread/status/changed", { threadId: "wire-root", status: { type: "idle" } });
  return { controller, counts, containment, rpc, frame, notify, disconnect: () => { for (const fn of closed) fn(); } };
}

test("Codex ordinary frame/metadata/history loss stays separate from exact root confirmation custody", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-confirmation-ingress-")), f = confirmationWireFixture(directory);
  const facet = f.controller.historyFacet;
  Object.defineProperty(f.controller, "historyFacet", { value: { ...facet, codec: (...args: Parameters<typeof facet.codec>) => {
    const codec = facet.codec(...args);
    return { observe(value: unknown) { if ((value as { method?: string }).method === "fixture/captureFailure") throw Error("Scripted capture failure"); codec.observe(value); } };
  } } });
  let host: AgentHost | undefined;
  try {
    host = await openHost({ directory, cwd: directory, scope: hostScope, policy: policy("codex"), controller: f.controller, observationMs: 60000 });
    const submit = async (command: Parameters<AgentHost["session"]["submit"]>[0]["command"], id: string) => host!.session.submit({ scope: hostScope, generation: (await host!.session.snapshot(hostScope)).generation, id, command });
    assert.equal((await submit({ type: "create" }, "create")).state, "acknowledged"); const binding = (await host.binding())!;
    f.notify("turn/started", { threadId: "wire-root", turn: { id: "observed-turn", status: "inProgress" } });
    f.notify("item/completed", { threadId: "wire-root", turnId: "observed-turn", item: { id: "large-tool", type: "commandExecution", command: "scripted", status: "completed", aggregatedOutput: "x".repeat(70 * 1024), exitCode: 0 } });
    assert.equal(f.rpc.observation().connected, true, "actual pinned framing admits a 70KiB ordinary frame");
    assert.equal((await host.interactions.snapshot(hostScope)).baseline, "complete", "transcript size cannot revoke reverse capability continuity");
    assert.ok(host.history.snapshot(binding.history).coverage.gaps.length > 0, "history retains its honest bounded-body gap");
    f.notify("thread/started", { thread: { id: "unproved-child" } });
    assert.equal((await host.interactions.snapshot(hostScope)).baseline, "complete", "unproved optional metadata does not invent a lost root callback");
    assert.equal((await host.session.snapshot(hostScope)).activity, "unknown");
    f.notify("fixture/captureFailure", { threadId: "wire-root" });
    assert.equal((await host.interactions.snapshot(hostScope)).baseline, "complete", "throwing transcript consumer is not confirmation authority");
    assert.ok(host.history.snapshot(binding.history).coverage.gaps.some(gap => gap.id === "host:capture-gap"));
    f.notify("turn/completed", { threadId: "wire-root", turn: { id: "observed-turn", status: "completed" } });
    f.frame({ id: "root-approval", method: "item/commandExecution/requestApproval", params: { threadId: "wire-root", turnId: "approval-turn", itemId: "approval-item", command: "scripted", availableDecisions: ["accept", "decline"] } });
    const prompt = (await host.interactions.snapshot(hostScope)).items[0]!.prompt; assert.equal(prompt.type, "codex.command");
    const answer = { type: "answer" as const, interactionId: prompt.id, choice: "decision:0", value: { type: "codex.command" as const, decisionId: "decision:0" } };
    assert.equal((await submit(answer, "answer-once")).state, "acknowledged"); await submit(answer, "answer-once");
    await until(async () => (await host!.interactions.snapshot(hostScope)).items.length === 0);
    assert.equal(f.counts.replies, 1); assert.equal((await host.interactions.snapshot(hostScope)).baseline, "complete");
    assert.equal((await submit({ type: "send", text: "ordinary idle send" }, "one-send")).state, "acknowledged");
    assert.equal((await host.session.snapshot(hostScope)).phase, "running"); assert.equal((await host.session.snapshot(hostScope)).activity, "idle");
    assert.equal(f.counts.sends, 1); assert.equal(f.counts.bodyReads, 0); assert.equal(f.counts.resumes, 0);
    f.frame({ id: "unproved-child-approval", method: "item/commandExecution/requestApproval", params: { threadId: "unproved-child", command: "never answer", availableDecisions: ["accept"] } });
    assert.equal((await host.interactions.snapshot(hostScope)).baseline, "partial", "an actual unprovable child callback still fails closed");
    assert.equal((await host.interactions.snapshot(hostScope)).items.length, 0); assert.equal(f.counts.replies, 1);
  } finally { await host?.terminate(); if (f.containment.identities.length) f.containment.halt(); f.controller.dispose(); await f.rpc.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Codex startup observation overflow preserves callback certificate, while actual reverse overflow and disconnect remain partial", async () => {
  for (const loss of ["observation-overflow", "reverse-overflow", "disconnect"] as const) {
    let fixture: ReturnType<typeof confirmationWireFixture>;
    const captures: import("../src/contracts.js").NativeCapture[] = [];
    fixture = confirmationWireFixture("/scripted", () => {
      if (loss === "disconnect") return;
      if (loss === "observation-overflow") for (let index = 0; index < 65; index++) fixture.notify("thread/status/changed", { threadId: "wire-root", status: { type: "idle" } });
      else fixture.frame({ id: "too-large-reverse", method: "item/commandExecution/requestApproval", params: { threadId: "wire-root", command: "x".repeat(70 * 1024), availableDecisions: ["accept"] } });
    });
    const f = fixture;
    try {
      f.controller.observe(value => { captures.push(value); });
      await f.controller.open({ scope: hostScope, generation: 1, placement: "dedicated", operationId: "create", nativeSession: null, policy: policy("codex") }, () => {});
      const owner = f.controller.interactions(f.controller.current()!.run);
      if (loss === "disconnect") { assert.equal(owner.current().baseline, "complete"); f.disconnect(); }
      assert.equal(owner.current().baseline, loss === "observation-overflow" ? "complete" : "partial", loss);
      assert.ok(captures.some(value => value.kind === "historyGap"), "all actual observation loss remains visible to history");
      assert.equal(f.counts.replies, 0); assert.equal(f.counts.sends, 0); assert.equal(f.counts.resumes, 0);
    } finally { if (f.containment.identities.length) f.containment.halt(); f.controller.dispose(); await f.rpc.close(); }
  }
});
