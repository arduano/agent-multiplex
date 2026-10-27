import test from "node:test";
import assert from "node:assert/strict";
import type { RunRef } from "../src/contracts/types.js";
import { managedPolicy, validateChoice, validateCommand, validateEvent, validateSelection } from '../../v8-harness-defaults/src/validation.js';
import { withManagedDefaults } from '../../v8-harness-defaults/src/invocation.js';
import { validateCatalog, validateOutcome, validateStopProof } from '../src/native/validation.js';

const run: RunRef = { scope: { connection: "test", principal: "owner", host: "host", session: "root" }, generation: 1, nativeSession: "native-root" };

test("native command validation rejects cross-harness controls, unknown settings and invalid native scopes before dispatch", () => {
  for (const command of [{ type: "codex.interrupt", turnId: "turn" }, { type: "codex.defaults", selection: { kind: "codex", model: "m" } }]) assert.throws(() => validateCommand("copilot", command));
  for (const command of [{ type: "copilot.abort" }, { type: "copilot.model", model: "m" }]) assert.throws(() => validateCommand("codex", command));
  for (const command of [
    { type: "send", text: "x", provider: "credit-fallback" }, { type: "resume", nativeSession: "replacement" },
    { type: "create", selection: { kind: "codex", model: "m", config: { provider: "replacement" } } },
    { type: "codex.turn", turnId: "turn", selection: { kind: "codex", access: { approval: "never", sandbox: "danger-full-access" } } },
    { type: "codex.turn", turnId: "turn", selection: { kind: "codex", collaboration: { mode: "plan", model: "m", effort: null } } },
    { type: "codex.defaults", selection: { kind: "codex" } },
    { type: "codex.steer", expectedTurnId: "bad\nidentity", text: "correction" },
    { type: "codex.steer", expectedTurnId: "exact", text: " " },
    { type: "codex.steer", expectedTurnId: "exact", text: "x", fallbackSend: true },
    { type: "codex.queue.add", text: "queued", clientUserMessageId: "caller-native-id" },
    { type: "codex.goal.set" }, { type: "codex.goal.set", objective: " " },
    { type: "codex.goal.set", tokenBudget: -1 }, { type: "codex.goal.set", status: "invented" },
  ]) assert.throws(() => validateCommand("codex", command));
  assert.throws(() => validateCommand("codex", { type: "copilot.queue.promote", id: "native" }));
  assert.throws(() => validateCommand("copilot", { type: "codex.goal.clear" }));
  assert.throws(() => validateCommand("copilot", { type: "copilot.task.cancel", id: "bad\nidentity" }));
  assert.deepEqual(validateCommand("codex", { type: "codex.turn", turnId: "exact", selection: { kind: "codex", model: "m", effort: null } }), { type: "codex.turn", turnId: "exact", selection: { kind: "codex", model: "m", effort: null } });
});

test("MCP command validation keeps native reload scope, configured-name reconnect and harness boundaries closed", () => {
  assert.deepEqual(validateCommand("codex", { type: "codex.mcp.reload" }), { type: "codex.mcp.reload" });
  assert.deepEqual(validateCommand("copilot", { type: "copilot.mcp.reconnect", serverName: "fixture" }), { type: "copilot.mcp.reconnect", serverName: "fixture" });
  assert.throws(() => validateCommand("copilot", { type: "codex.mcp.reload" }));
  assert.throws(() => validateCommand("codex", { type: "copilot.mcp.reconnect", serverName: "fixture" }));
  assert.throws(() => validateCommand("codex", { type: "codex.mcp.reload", serverName: "pretend-per-server" }));
  assert.throws(() => validateCommand("copilot", { type: "copilot.mcp.reconnect", serverName: "bad\nname" }));
  assert.throws(() => validateCommand("copilot", { type: "copilot.mcp.reconnect", serverName: "fixture", config: { url: "http://foreign.invalid" } }));
});

test("Codex terminal observations reject cross-harness, oversized or malformed pages without turning unknown metrics into zero", async () => {
  const { nativeReadResult, validateNativeRead, validateNativeReadResult } = await import("../../v8-harness-defaults/src/state.js");
  const request = { type: "codex.terminals", cursor: null, limit: 1 } as const;
  const terminal = { itemId: "item", processId: "process", command: "command", cwd: "/workspace", osPid: null, cpuPercent: null, rssKb: null };
  assert.deepEqual(validateNativeRead("codex", request), request);
  for (const value of [{ ...request, limit: 0 }, { ...request, limit: 101 }, { ...request, cursor: "" }, { ...request, id: "foreign" }, { ...request, threadId: "foreign" }]) assert.throws(() => validateNativeRead("codex", value));
  assert.throws(() => validateNativeRead("copilot", request));
  assert.throws(() => validateCommand("copilot", { type: "codex.terminal.terminate", processId: "process" }));
  assert.throws(() => validateCommand("codex", { type: "codex.terminal.terminate", processId: "bad\nidentity" }));
  assert.throws(() => validateCommand("codex", { type: "codex.terminals.clean", threadId: "foreign" }));
  const observed = nativeReadResult(run, request, { data: [{ ...terminal, privateExtra: "discard" }], nextCursor: null });
  assert.deepEqual(observed, { run, type: request.type, data: [terminal], nextCursor: null });
  assert.deepEqual(validateNativeReadResult(run, request, observed), observed);
  for (const raw of [
    { data: [terminal, terminal], nextCursor: null }, { data: [], nextCursor: "" }, { data: [{ ...terminal, rssKb: Number.MAX_SAFE_INTEGER + 1 }], nextCursor: null },
    { data: [{ ...terminal, cpuPercent: -1 }], nextCursor: null }, { data: [{ ...terminal, osPid: undefined }], nextCursor: null }, { data: [], nextCursor: null, privateExtra: "x".repeat(65536) },
  ]) assert.throws(() => nativeReadResult(run, request, raw));
  assert.throws(() => nativeReadResult(run, { type: "codex.terminals", limit: 2 }, { data: [terminal, terminal], nextCursor: null }));
});

test("native selections preserve effort omission/null and reject contradictory collaboration or profile/sandbox", () => {
  assert.deepEqual(validateSelection("copilot", { kind: "copilot", model: "m" }), { kind: "copilot", model: "m" });
  assert.deepEqual(validateSelection("copilot", { kind: "copilot", model: "m", effort: null }), { kind: "copilot", model: "m", effort: null });
  for (const value of [
    { kind: "codex", access: { approval: "on-request", profile: "selected", sandbox: "danger-full-access" } },
    { kind: "codex", model: "a", collaboration: { mode: "plan", model: "b", effort: "high" } },
    { kind: "codex", effort: "low", collaboration: { mode: "plan", model: "a", effort: "high" } },
  ]) assert.throws(() => validateSelection("codex", value));
  assert.deepEqual(validateSelection("copilot", { kind: "copilot", permissions: "assisted" }), { kind: "copilot", permissions: "assisted" });
  assert.throws(() => validateCommand("copilot", { type: "copilot.permissions", mode: "assisted" }));
});

test("private managed defaults preserve full access/on-request and explicit profiles without accepting provider escape fields", () => {
  const policy = managedPolicy("codex");
  assert.deepEqual(policy, { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "configured" });
  const explicit = { kind: "codex" as const, access: { approval: "on-request" as const, profile: "selected-profile" } };
  const selected = withManagedDefaults(policy, explicit);
  assert.deepEqual(selected, explicit); assert.ok(!("sandbox" in selected.access!));
  assert.throws(() => managedPolicy("codex", { ...policy, config: { modelProvider: "replacement" } }));
  assert.throws(() => validateCommand("codex", { type: "create", policy }));
  assert.deepEqual(managedPolicy("codex", { ...policy, provider: "copilot-only" }).provider, "copilot-only");
});

test("dynamic choices validate exact provider/model/effort without changing observed native facts", () => {
  const catalog = validateCatalog({ available: true, choices: [{ model: "same", providerId: "a", efforts: ["low"] }, { model: "same", providerId: "b", efforts: ["max"] }] });
  assert.throws(() => validateChoice("copilot", { kind: "copilot", model: "same" }, catalog));
  assert.deepEqual(validateChoice("copilot", { kind: "copilot", model: "same", providerId: "b", effort: "max" }, catalog), { kind: "copilot", model: "same", providerId: "b", effort: "max" });
  assert.throws(() => validateChoice("copilot", { kind: "copilot", model: "same", providerId: "a", effort: "max" }, catalog));
  assert.throws(() => validateChoice("codex", { kind: "codex", model: "missing" }, { available: false, choices: [] }));
  assert.deepEqual(validateSelection("codex", { kind: "codex", model: "not-in-catalog", effort: "native-extension" }), { kind: "codex", model: "not-in-catalog", effort: "native-extension" });
  const metadata = { model: 'native', efforts: ['low'], displayName: 'Native label', description: '', defaultEffort: 'native-default', inputModalities: ['text', 'image', 'audio'] };
  assert.deepEqual(validateCatalog({ available: true, choices: [metadata] }).choices[0], metadata);
  for (const patch of [{ displayName: '' }, { description: 'x'.repeat(4097) }, { defaultEffort: null }, { inputModalities: ['video'] }, { inputModalities: ['image', 'image'] }, { providerConfig: 'PRIVATE' }]) assert.throws(() => validateCatalog({ available: true, choices: [{ ...metadata, ...patch }] }));
});

test("native stop evidence requires the exact native tree/run and no automatic continuation", () => {
  const proof = { run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true };
  assert.deepEqual(validateStopProof(run, proof), proof);
  for (const value of [{}, { ...proof, scope: "controller" }, { ...proof, noAutomaticContinuation: false }, { ...proof, run: { ...run, generation: 2 } }, { ...proof, run: { ...run, nativeSession: "other" } }, { ...proof, run: { ...run, scope: { ...run.scope, principal: "other" } } }]) assert.throws(() => validateStopProof(run, value));
  assert.throws(() => validateEvent("codex", { run, type: "stopped", proof: { ...proof, run: { ...run, generation: 2 } } }));
  assert.throws(() => validateEvent("codex", { run, type: "selection", selection: { kind: "copilot", mode: "plan" } }));
});

test("native validation rejects getters, cyclic/sparse/oversized detail and duplicate callback choices without reading private accessors", () => {
  let called = false; const raw = { get status() { called = true; return "applied"; } };
  assert.throws(() => validateOutcome(raw)); assert.equal(called, false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; assert.throws(() => validateOutcome({ status: "acknowledged", detail: cyclic }));
  assert.throws(() => validateOutcome({ status: "acknowledged", detail: new Array(2) }));
  assert.throws(() => validateOutcome({ status: "acknowledged", detail: "x".repeat(100_000) }));
  assert.throws(() => validateEvent("codex", { run, type: "interactions", complete: true, items: [{ id: "request", owner: "root", kind: "approval", choices: ["accept", "accept"] }] }));
});

test("native state reads preserve explicit absence and repeated batch queue IDs, strip private metadata, and refuse malformed/oversize rather than invent empty", async () => {
  const { nativeReadResult, validateNativeReadResult } = await import("../../v8-harness-defaults/src/state.js");
  const run = { scope: { connection: "read", principal: "owner", host: "host", session: "logical" }, generation: 1, nativeSession: "native" };
  assert.deepEqual(nativeReadResult(run, { type: "codex.goal" }, { goal: null }), { run, type: "codex.goal", goal: null });
  assert.throws(() => nativeReadResult(run, { type: "codex.goal" }, {}));
  const queue = nativeReadResult(run, { type: "copilot.queue" }, { items: [0, 1].map(() => ({ id: "shared-batch", kind: "message", displayText: "queued", agentMode: "interactive", privateOwner: "secret" })), steeringMessages: ["immediate"], inFlightSteeringCount: 1 });
  assert.equal(queue.type === "copilot.queue" && queue.items.length, 2); assert.ok(!JSON.stringify(queue).includes("secret"));
  assert.deepEqual(validateNativeReadResult(run, { type: "copilot.queue" }, queue), queue);
  assert.throws(() => nativeReadResult(run, { type: "copilot.queue" }, { items: [], steeringMessages: [], inFlightSteeringCount: 1 }));
  assert.throws(() => nativeReadResult(run, { type: "copilot.tasks" }, { tasks: Array(129).fill({}) }));
  const task = { id: "task", type: "agent", description: "child", status: "running", startedAt: "now", toolCallId: "spawn", agentType: "general", model: null, latestResponse: "response", result: "r".repeat(9000), error: "failure", prompt: "private prompt", logPath: "/private" };
  const tasks = nativeReadResult(run, { type: "copilot.tasks" }, { tasks: [task] });
  assert.ok(!JSON.stringify(tasks).includes("private")); assert.deepEqual(validateNativeReadResult(run, { type: "copilot.tasks" }, tasks), tasks);
  assert.ok(tasks.type === 'copilot.tasks'); assert.equal(tasks.tasks[0]!.result?.length, 8192); assert.ok(tasks.tasks[0]!.result?.endsWith('…')); assert.equal(tasks.tasks[0]!.latestResponse, 'response'); assert.equal(tasks.tasks[0]!.error, 'failure');
  const client = nativeReadResult(run, { type: 'copilot.tasks' }, { tasks: [{ id: 'client', type: 'client', description: 'owned task', status: 'orphaned', startedAt: 'now', executionMode: 'background', canCancel: false, result: { private: 'opaque owner JSON' }, error: 'reported error' }] });
  assert.ok(!JSON.stringify(client).includes('private')); assert.ok(client.type === 'copilot.tasks'); assert.equal(client.tasks[0]!.error, 'reported error');
  assert.throws(() => nativeReadResult(run, { type: "copilot.task.progress", id: "task" }, { progress: { type: "shell", recentOutput: "x".repeat(32769) } }));
  assert.deepEqual(nativeReadResult(run, { type: "copilot.task.promotable" }, {}), { run, type: "copilot.task.promotable", task: null });
});
