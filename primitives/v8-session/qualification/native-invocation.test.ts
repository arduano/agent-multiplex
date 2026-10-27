import test from "node:test";
import assert from "node:assert/strict";
import type { Json, NativeOutcome, RunRef } from "../src/contracts/types.js";
import { codexThreadOutcome, codexTurnOutcome, createCodexInvocation } from '../../v8-harness-codex/src/invocation.js';
import { copilotModelOutcome, copilotModeOutcome, createCopilotInvocation, type CopilotControlRpc } from '../../v8-harness-copilot/src/invocation.js';
import { fullStop, nativeRun } from '../../v8-harness-defaults/src/invocation.js';
import { SelectionOwner } from '../../v8-harness-defaults/src/selection.js';

const run: RunRef = { scope: { connection: "test", principal: "owner", host: "host", session: "root" }, generation: 1, nativeSession: "native-root" };

test("MCP native commands keep reload scope, reconnect without asserting an OAuth login, and never return private replies", async () => {
  let reloads = 0;
  const codex = createCodexInvocation({ run, rpc: async () => assert.fail("Reload must not use a record-shaped thread RPC"), reloadMcp: async (...args) => { assert.deepEqual(args, []); reloads++; return {}; } });
  assert.deepEqual(await codex({ type: "codex.mcp.reload" }), { status: "acknowledged", detail: {} }); assert.equal(reloads, 1);
  assert.equal((await createCodexInvocation({ run, rpc: async () => assert.fail("Unsupported native reload") })({ type: "codex.mcp.reload" })).status, "refused");
  const calls: unknown[] = [], fixture = rpcFixture(), transports = { remote: "http" as const, local: "stdio" as const }, rows = ["remote", "local"].map(name => ({ name, enabled: true, live: { status: "connected" } }));
  const nativeMcp = { listConfigured: async () => { calls.push("configured"); return { servers: rows }; }, restartServer: async (input: Readonly<{ serverName: string }>) => { calls.push(["restart", input]); return { authorizationUrl: "https://private.invalid", privateToken: "not-an-outcome" }; }, oauth: { authenticationStateChanged: async () => { throw Object.assign(Error("No successful persisted OAuth login"), { code: -32603 }); } } };
  fixture.rpc.mcp = nativeMcp;
  const invoke = createCopilotInvocation({ rpc: fixture.rpc, mcpTransports: transports });
  transports.remote = "stdio" as never;
  assert.deepEqual(await invoke({ type: "copilot.mcp.reconnect", serverName: "remote" }), { status: "acknowledged" });
  assert.deepEqual(calls, ["configured", ["restart", { serverName: "remote" }]]);
  calls.length = 0; assert.deepEqual(await invoke({ type: "copilot.mcp.reconnect", serverName: "local" }), { status: "acknowledged" }); assert.deepEqual(calls, ["configured", ["restart", { serverName: "local" }]]);
  calls.length = 0; assert.equal((await invoke({ type: "copilot.mcp.reconnect", serverName: "unknown" })).status, "refused"); assert.equal(calls.length, 0);
  rows[0]!.enabled = false; assert.equal((await invoke({ type: "copilot.mcp.reconnect", serverName: "remote" })).status, "refused"); assert.deepEqual(calls, ["configured"]);
});

test("MCP reconnect never reports completion or retries after a restart reply was lost", async () => {
  const fixture = rpcFixture(), calls: string[] = [];
  fixture.rpc.mcp = { listConfigured: async () => ({ servers: [{ name: "remote", enabled: true, live: { status: "connected" } }] }), restartServer: async () => { calls.push("restart"); throw Error("reply lost"); } };
  const invoke = createCopilotInvocation({ rpc: fixture.rpc, mcpTransports: { remote: "sse" } });
  await assert.rejects(invoke({ type: "copilot.mcp.reconnect", serverName: "remote" }), /reply lost/); assert.deepEqual(calls, ["restart"]);
});
function rpcFixture() {
  const calls: { method: string; input?: unknown }[] = []; let result: unknown = {};
  const call = async (method: string, input?: unknown) => { calls.push({ method, ...(input === undefined ? {} : { input }) }); return result; };
  const rpc: CopilotControlRpc = { model: { switchTo: input => call("model.switchTo", input) }, mode: { set: input => call("mode.set", input) }, permissions: { setMode: input => call("permissions.setMode", input) }, send: input => call("send", input), abort: () => call("abort") };
  return { calls, rpc, result(value: unknown) { result = value; } };
}

test("Codex thread ACK and exact-turn applied/targetUnavailable remain distinct from execution and stop", async () => {
  assert.deepEqual(codexThreadOutcome({}), { status: "acknowledged", detail: {} });
  assert.deepEqual(codexTurnOutcome({ status: "targetUnavailable" }), { status: "targetUnavailable", detail: { status: "targetUnavailable" } });
  assert.equal(codexTurnOutcome({ status: "applied" }).status, "applied"); assert.throws(() => codexThreadOutcome({ status: "applied" }));
  const calls: { method: string; input: unknown }[] = [];
  const invoke = createCodexInvocation({ run, rpc: async (method, input) => { calls.push({ method, input }); return method === "turn/settings/update" ? { status: "targetUnavailable" } : {}; } });
  const selection = { kind: "codex" as const, model: "model", effort: "high", collaboration: { mode: "plan" as const, model: "model", effort: "high", instructions: "explicit instructions" } };
  assert.equal((await invoke({ type: "codex.defaults", selection })).status, "acknowledged");
  assert.deepEqual(calls[0], { method: "thread/settings/update", input: { threadId: run.nativeSession, model: "model", effort: "high", collaborationMode: { mode: "plan", settings: { model: "model", reasoning_effort: "high", developer_instructions: "explicit instructions" } } } });
  assert.equal((await invoke({ type: "codex.turn", turnId: "original-turn", selection: { kind: "codex", model: "next", effort: null } })).status, "targetUnavailable");
  assert.deepEqual(calls[1], { method: "turn/settings/update", input: { threadId: run.nativeSession, turnId: "original-turn", model: "next", effort: null } });
  assert.equal((await invoke({ type: "codex.interrupt", turnId: "original-turn" })).status, "acknowledged");
  assert.equal(calls[2]!.method, "turn/interrupt"); assert.ok(!calls.some(c => /unsubscribe|stop/.test(c.method)));
});

test("Codex Send preserves sticky native selection fields and profiles rather than injecting a conflicting sandbox", async () => {
  const calls: unknown[] = [];
  const invoke = createCodexInvocation({ run, currentSelection: () => ({ kind: "codex", collaboration: { mode: "plan", model: "previous", effort: "high", instructions: "retained instructions" } }), rpc: async (method, input) => { calls.push(input); return method === 'turn/start' ? { turn: { id: "native-turn", status: "inProgress" } } : {}; } });
  const outcome = await invoke({ type: "send", text: "original", selection: { kind: "codex", model: "m", effort: "ultra", access: { approval: "on-request", profile: "selected" } } });
  assert.equal(outcome.status, "accepted");
  assert.deepEqual(calls[0], { threadId: run.nativeSession, input: [{ type: "text", text: "original", text_elements: [] }], model: "m", effort: "ultra", collaborationMode: { mode: "plan", settings: { model: "m", reasoning_effort: "ultra", developer_instructions: "retained instructions" } }, approvalPolicy: "on-request", permissions: "selected" });
  await invoke({ type: "codex.defaults", selection: { kind: "codex", access: { approval: "on-request", sandbox: "workspace-write" } } });
  assert.deepEqual(calls[1], { threadId: run.nativeSession, approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
  await invoke({ type: 'codex.defaults', selection: { kind: 'codex', access: { approval: 'untrusted', sandbox: 'read-only' } } });
  assert.deepEqual(calls[2], { threadId: run.nativeSession, approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
});

test("Codex thread patches require known mode instructions, while explicit collaboration and exact-turn updates remain scoped", async () => {
  for (const current of [undefined, { kind: "codex" as const }, { kind: "codex" as const, collaboration: { mode: "plan" as const, model: "old", effort: null } }]) {
    let effects = 0, encoded = 0;
    const invoke = createCodexInvocation({ run, ...(current === undefined ? {} : { currentSelection: () => current }), encodeInputs: async () => { encoded++; return []; }, rpc: async () => { effects++; return {}; } });
    await assert.rejects(invoke({ type: "codex.defaults", selection: { kind: "codex", model: "new" } }), /known collaboration and instructions/);
    assert.deepEqual(await invoke({ type: "send", text: "original", selection: { kind: "codex", effort: null } }), { status: "refused", detail: { sendDispatched: false, reason: "unsupportedSelection" } });
    assert.deepEqual(await invoke({ type: "send", text: "original", selection: { kind: "codex", effort: null }, nativeInputs: { kind: "codex", items: [{ type: "localImage", path: "/owned-image.png" }] } }), { status: "refused", detail: { sendDispatched: false, reason: "unsupportedSelection" } });
    assert.equal(encoded, 0, "Pure selection compilation refuses before native encoding");
    assert.equal(effects, 0);
  }
  const calls: unknown[] = [], invoke = createCodexInvocation({ run, rpc: async (method, input) => { calls.push(input); return method === "turn/settings/update" ? { status: "applied" } : {}; } });
  await invoke({ type: "codex.defaults", selection: { kind: "codex", collaboration: { mode: "default", model: "new", effort: null } } });
  assert.deepEqual(calls[0], { threadId: run.nativeSession, collaborationMode: { mode: "default", settings: { model: "new", reasoning_effort: null, developer_instructions: null } } });
  await invoke({ type: "codex.turn", turnId: "running", selection: { kind: "codex", model: "turn-only", effort: "high" } });
  assert.deepEqual(calls[1], { threadId: run.nativeSession, turnId: "running", model: "turn-only", effort: "high" });
});

test("Codex snapshots command, current collaboration, sandbox and callback identities before a pending native RPC", async () => {
  let resolve!: (value: unknown) => void; const pending = new Promise<unknown>(r => { resolve = r; });
  const calls: Readonly<Record<string, Json>>[] = [];
  const current = { kind: "codex" as const, collaboration: { mode: "plan" as const, model: "old", effort: "high", instructions: "private preserved" } };
  const sandbox = { type: "workspaceWrite", writableRoots: ["/allowed"], networkAccess: false };
  const options = { run, rpc: async (_method: string, input: Readonly<Record<string, Json>>) => { calls.push(input); return pending; }, currentSelection: () => current, encodeSandbox: () => sandbox };
  const invoke = createCodexInvocation(options);
  const command = { type: "codex.defaults" as const, selection: { kind: "codex" as const, model: "chosen", effort: null, access: { approval: "on-request" as const, sandbox: "workspace-write" as const } } };
  const result = invoke(command);
  // Changes after invocation cannot retarget the callback or mutate its input.
  command.selection.model = "mutated"; current.collaboration!.instructions = "mutated"; sandbox.writableRoots.push("/unexpected");
  options.rpc = async () => { throw new Error("replacement RPC used"); };
  options.currentSelection = () => { throw new Error("replacement current selection used"); };
  options.encodeSandbox = () => { throw new Error("replacement encoder used"); };
  assert.deepEqual(calls[0], { threadId: run.nativeSession, model: "chosen", effort: null, collaborationMode: { mode: "plan", settings: { model: "chosen", reasoning_effort: null, developer_instructions: "private preserved" } }, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/allowed"], networkAccess: false } });
  assert.ok(Object.isFrozen(calls[0])); assert.ok(Object.isFrozen(calls[0]!.collaborationMode));
  resolve({}); assert.equal((await result).status, "acknowledged");
  // Construction captured the callbacks, not only the first request.
  assert.equal((await invoke({ type: "codex.defaults", selection: { kind: "codex", model: "later" } })).status, "acknowledged");
  assert.equal(calls.length, 2);
});

test("native event may beat Codex thread ACK without regressing paired selection or turning receipt into execution", async () => {
  const old = { kind: "codex" as const, model: "old", effort: "high", collaboration: { mode: "plan" as const, model: "old", effort: "high", instructions: "keep exactly" } };
  const owner = new SelectionOwner("codex", run, old), oldRead = owner.fence();
  let resolve!: (value: unknown) => void; const pending = new Promise<unknown>(r => { resolve = r; });
  const invoke = createCodexInvocation({ run, currentSelection: () => owner.snapshot().selection, rpc: async (method, params) => {
    assert.equal(method, "thread/settings/update");
    if (method !== "thread/settings/update") throw Error("Unexpected native method");
    owner.codexEvent({ method: "thread/settings/updated", params: { threadId: run.nativeSession, threadSettings: { model: params.model, effort: params.effort, collaborationMode: params.collaborationMode } } });
    return pending;
  } });
  owner.beginChange();
  const result = invoke({ type: "codex.defaults", selection: { kind: "codex", model: "new", effort: null } });
  const early = owner.snapshot();
  assert.deepEqual(early.selection, { kind: "codex", model: "new", effort: null, collaboration: { mode: "plan", model: "new", effort: null, instructions: "keep exactly" } });
  assert.equal(owner.acceptRead(oldRead, old), false);
  resolve({}); const ack = owner.acknowledge(await result);
  assert.equal(ack.status, "acknowledged"); assert.deepEqual(owner.snapshot(), early);
});

test("Copilot native-shaped mode results preserve partial/deferred/confirmation detail without a void success projection", () => {
  const partial = { status: "precondition_failed", modelChanged: true, modeApplied: false, warning: "mode precondition no longer held" };
  assert.deepEqual(copilotModeOutcome(partial), { status: "acknowledged", detail: partial });
  const deferred = { status: "success", modelChanged: false, modeApplied: true, deferImplementation: true, armInteractiveContinuation: true };
  assert.deepEqual(copilotModeOutcome(deferred), { status: "deferred", detail: deferred });
  const confirmation = { status: "confirmation_required", modelChanged: false, confirmation: { targetModelDisplayName: "Model", currentTokens: 10, targetLimit: 5 } };
  assert.deepEqual(copilotModeOutcome(confirmation), { status: "confirmationRequired", detail: confirmation });
  assert.throws(() => copilotModeOutcome(undefined));
  assert.equal(copilotModeOutcome({ status: "success", modelChanged: false, modeApplied: true }).status, "applied");
});

test("Copilot model queue ID remains exact even when returned current model differs or persistence failed", () => {
  const queued = { deferred: true, queueId: "original-queue", modelId: "old", status: "queued", modelState: { modelId: "old", providerId: "provider-a" } };
  assert.deepEqual(copilotModelOutcome(queued, { model: "new" }), { status: "deferred", detail: queued });
  const partial = { modelId: "new", persistenceError: "write_failed", modelState: { modelId: "new", providerId: "provider-a" } };
  assert.deepEqual(copilotModelOutcome(partial, { model: "new", providerId: "provider-a" }), { status: "acknowledged", detail: partial });
  assert.equal(copilotModelOutcome({ modelId: "same", modelState: { modelId: "same", providerId: "b" } }, { model: "same", providerId: "a" }).status, "acknowledged");
});

test("Copilot model invocation keeps provider identity and omitted-keep versus null-clear effort", async () => {
  const f = rpcFixture(); f.result({ modelId: "same", modelState: { modelId: "same", providerId: "a" } });
  const authorized: (string | undefined)[] = []; const invoke = createCopilotInvocation({ rpc: f.rpc, authorizeProvider: provider => { authorized.push(provider); } });
  await invoke({ type: "copilot.model", model: "same", providerId: "a" });
  await invoke({ type: "copilot.model", model: "same", providerId: "a", effort: null });
  assert.deepEqual(f.calls.map(c => c.input), [{ modelId: "same", providerId: "a" }, { modelId: "same", providerId: "a", reasoningEffort: null }]);
  assert.deepEqual(authorized, ["a", "a"]);
  const refused = createCopilotInvocation({ rpc: f.rpc, authorizeProvider: () => { throw new Error("private provider policy"); } });
  await assert.rejects(refused({ type: "copilot.model", model: "paid", providerId: "unselected" }), /private provider policy/); assert.equal(f.calls.length, 2);
});

test("Copilot requested effort requires paired exact native evidence; null-clear remains unverified", () => {
  const observed = { modelId: "same", modelState: { modelId: "same", providerId: "a", reasoningEffort: "low" } };
  assert.equal(copilotModelOutcome(observed, { model: "same", providerId: "a", effort: "high" }).status, "acknowledged");
  assert.equal(copilotModelOutcome(observed, { model: "same", providerId: "a", effort: "low" }).status, "applied");
  assert.equal(copilotModelOutcome(observed, { model: "same", providerId: "a" }).status, "applied");
  assert.equal(copilotModelOutcome({ ...observed, modelState: { ...observed.modelState, reasoningEffort: null } }, { model: "same", providerId: "a", effort: null }).status, "acknowledged");
});

test("Copilot Send refuses unrepresentable frozen selection before any native step; abort ACK is not stopped", async () => {
  const f = rpcFixture(), invoke = createCopilotInvocation({ rpc: f.rpc });
  await assert.rejects(invoke({ type: "send", text: "original", selection: { kind: "copilot", model: "wanted" } }), /Host-ordered substeps/); assert.equal(f.calls.length, 0);
  f.result({ messageId: "native-message" }); assert.equal((await invoke({ type: "send", text: "original" })).status, "accepted");
  f.result(undefined); assert.deepEqual(await invoke({ type: "copilot.abort" }), { status: "acknowledged" });
  assert.deepEqual(f.calls.map(c => c.method), ["send", "abort"]);
});

test("Copilot snapshots command and bound native callback identities before settlement", async () => {
  let resolve!: (value: unknown) => void; const pending = new Promise<unknown>(r => { resolve = r; });
  const inputs: unknown[] = [], authorized: unknown[] = [];
  const f = rpcFixture();
  const model = { switchTo: async function (input: Parameters<CopilotControlRpc["model"]["switchTo"]>[0]) { assert.equal(this, model); inputs.push(input); return pending; } }; f.rpc.model = model;
  const options = { rpc: f.rpc, authorizeProvider: (provider: string | undefined) => { authorized.push(provider); } };
  const invoke = createCopilotInvocation(options), command = { type: "copilot.model" as const, model: "original", providerId: "private-provider", effort: null };
  const result = invoke(command); command.model = "mutated"; command.providerId = "other-provider";
  model.switchTo = async () => { throw new Error("replacement native method used"); };
  options.authorizeProvider = () => { throw new Error("replacement provider guard used"); };
  assert.deepEqual(inputs, [{ modelId: "original", providerId: "private-provider", reasoningEffort: null }]); assert.ok(Object.isFrozen(inputs[0]));
  resolve({ modelId: "original", modelState: { modelId: "original", providerId: "private-provider" } });
  assert.equal((await result).status, "acknowledged", "null-clear has no exact native completion proof");
  assert.equal((await invoke({ type: "copilot.model", model: "original", providerId: "private-provider" })).status, "applied");
  assert.deepEqual(authorized, ["private-provider", "private-provider"]);
});

test("only explicit exact-tree stop supplier can finish native Stop; disconnect/interrupt/PID ACKs cannot", async () => {
  const proof = { run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true };
  for (const result of [{}, { disconnected: true }, { terminated: true }, { run, state: "stopped", scope: "controller", noAutomaticContinuation: true }]) await assert.rejects(fullStop(run, async () => result)());
  const controller = nativeRun({ kind: "codex", run, selection: { kind: "codex", model: "m" }, interactionsComplete: true, interactions: [], invoke: async () => ({ status: "acknowledged" }), stopProof: async () => proof });
  assert.deepEqual(await controller.stop(), proof);
  assert.equal((await controller.invoke({ type: "codex.interrupt", turnId: "t" }) as NativeOutcome).status, "acknowledged");
});

test("native action compilers preserve exact targets, native no-op results and start-only compaction without Send fallbacks", async () => {
  const calls: { method: string; input: unknown }[] = [];
  const goal = { threadId: run.nativeSession, objective: "bounded goal", status: "paused", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 3, updatedAt: 4 };
  const codex = createCodexInvocation({ run, rpc: async (method, input) => { calls.push({ method, input }); if (method === "turn/steer") return { turnId: input.expectedTurnId }; if (method === "thread/goal/set") return { goal }; if (method === "thread/goal/clear") return { cleared: false }; return {}; } });
  assert.deepEqual(await codex({ type: "codex.steer", expectedTurnId: "turn-original", text: "change only this turn" }), { status: "accepted", detail: { turnId: "turn-original" } });
  assert.deepEqual(calls[0], { method: "turn/steer", input: { threadId: run.nativeSession, expectedTurnId: "turn-original", input: [{ type: "text", text: "change only this turn", text_elements: [] }] } });
  assert.equal((await codex({ type: "codex.compact" })).status, "acknowledged");
  assert.equal((await codex({ type: "codex.goal.set", objective: "bounded goal", status: "paused", tokenBudget: null })).status, "applied");
  assert.deepEqual(await codex({ type: "codex.goal.clear" }), { status: "applied", detail: { cleared: false } });
  const queueCalls: unknown[] = [], enqueue = createCodexInvocation({ run, rpc: async (method, input) => { assert.equal(method, "thread/queue/add"); queueCalls.push(input); return { queuedSubmission: { id: "native-queued", clientUserMessageId: input.clientUserMessageId, input: "private echo" } }; } });
  assert.deepEqual(await enqueue({ type: "codex.queue.add", text: "unadmitted" }), { status: "refused", detail: { reason: "originalIdentityRequired" } }); assert.equal(queueCalls.length, 0);
  assert.deepEqual(await enqueue({ type: "codex.queue.add", text: "queued once", clientUserMessageId: "exact-original" }), { status: "accepted", detail: { queuedSubmission: { id: "native-queued", clientUserMessageId: "exact-original" } } });
  const wrongQueue = createCodexInvocation({ run, rpc: async () => ({ queuedSubmission: { id: "native-queued", clientUserMessageId: "different-original" } }) });
  await assert.rejects(wrongQueue({ type: "codex.queue.add", text: "queued once", clientUserMessageId: "exact-original" }));
  const malformed = createCodexInvocation({ run, rpc: async () => ({ turnId: "replacement" }) });
  await assert.rejects(malformed({ type: "codex.steer", expectedTurnId: "original", text: "never retarget" }));
  assert.ok(calls.every(call => call.method !== "turn/start"));

  const f = rpcFixture(), queue = { async sendNow(input: { id: string }) { assert.equal(this, queue); calls.push({ method: "queue.sendNow", input }); return { steered: false }; } },
    tasks = { async cancel(input: { id: string }) { assert.equal(this, tasks); calls.push({ method: "tasks.cancel", input }); return { cancelled: false }; }, async promoteToBackground(input: { id: string }) { assert.equal(this, tasks); calls.push({ method: "tasks.promote", input }); return { promoted: true }; } },
    history = { async compact(input: { trigger: "manual" }) { assert.equal(this, history); calls.push({ method: "history.compact", input }); return { success: false, tokensRemoved: 0, messagesRemoved: 0, summaryContent: "private summary" }; } };
  const copilot = createCopilotInvocation({ rpc: { ...f.rpc, queue, tasks, history } });
  f.result({ messageId: "native-immediate-message" });
  assert.deepEqual(await copilot({ type: "copilot.steer", text: "native immediate" }), { status: "accepted", detail: { messageId: "native-immediate-message" } });
  assert.deepEqual(f.calls, [{ method: "send", input: { prompt: "native immediate", mode: "immediate" } }]);
  assert.deepEqual(await copilot({ type: "copilot.queue.promote", id: "exact-queued" }), { status: "applied", detail: { id: "exact-queued", steered: false } });
  assert.deepEqual(await copilot({ type: "copilot.task.cancel", id: "exact-task" }), { status: "applied", detail: { id: "exact-task", cancelled: false } });
  assert.deepEqual(await copilot({ type: "copilot.task.promote", id: "exact-task" }), { status: "applied", detail: { id: "exact-task", promoted: true } });
  assert.deepEqual(await copilot({ type: "copilot.compact" }), { status: "applied", detail: { success: false, tokensRemoved: 0, messagesRemoved: 0 } });
  assert.equal(f.calls.length, 1, "queue/task/compaction never submit synthetic prompts");
});
