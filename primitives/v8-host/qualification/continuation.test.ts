import assert from "node:assert/strict";
import test from "node:test";
import { CodexStdioRpc, type CodexWire } from "../../v8-harness-codex/src/rpc.js";
import { createCodexInvocation } from "../../v8-harness-codex/src/invocation.js";
import { createCopilotInvocation, type CopilotControlRpc } from "../../v8-harness-copilot/src/invocation.js";

test("Codex promptless wire has zero native input and no synthetic user message; only exact active-empty rejection is a no-effect refusal", async () => {
  const frames: Record<string, unknown>[] = [], listeners = new Set<(text: string) => void>();
  let failure: unknown;
  const wire: CodexWire = { onData: listener => { listeners.add(listener); return () => listeners.delete(listener); }, onClose: () => () => {}, close: async () => {},
    write: async text => { const value = JSON.parse(text) as Record<string, unknown>; frames.push(value); for (const listener of listeners) listener(JSON.stringify({ id: value.id, ...(failure ? { error: failure } : { result: { turn: { id: "actual-native-turn" } } }) }) + "\n"); } };
  const rpc = new CodexStdioRpc(wire, () => {}, () => {}), run = { scope: { connection: "fixture", principal: "owner", host: "host", session: "root" }, generation: 1, nativeSession: "native-thread" };
  try {
    const invoke = createCodexInvocation({ run, rpc: (method, params) => rpc.request(method, params) });
    assert.deepEqual(await invoke({ type: "codex.continue" }), { status: "accepted", detail: { turnId: "actual-native-turn" } });
    assert.deepEqual(frames[0], { id: 1, method: "turn/start", params: { threadId: "native-thread", input: [] } });
    failure = { code: -32603, message: "failed to submit turn input: EmptyInput" };
    assert.deepEqual(await invoke({ type: "codex.continue" }), { status: "refused", detail: { reason: "alreadyWorking" } });
    failure = { code: -32603, message: "unrelated private native failure" };
    await assert.rejects(invoke({ type: "codex.continue" }), /Pinned Codex native request rejected/);
    failure = { code: -32603, message: "failed to submit turn input: EmptyInput" };
    await assert.rejects(invoke({ type: "send", text: "actual user message" }), /Pinned Codex native request rejected/);
    assert.ok(!JSON.stringify(rpc.diagnostics()).includes("private native failure"));
  } finally { await rpc.close(); }
});

test("Copilot prepared zero-message encoder uses explicit immediate API, never empty Send or default enqueue; default controller capability is withheld", async () => {
  const calls: unknown[] = [];
  const rpc: CopilotControlRpc = { model: { switchTo: async () => ({}) }, mode: { set: async () => ({}) }, permissions: { setMode: async () => ({}) }, abort: async () => ({}), send: async () => assert.fail("No synthetic empty Send"), sendMessages: async input => { calls.push(input); return { messageIds: [] }; } };
  assert.deepEqual(await createCopilotInvocation({ rpc })({ type: "copilot.continue" }), { status: "accepted" });
  assert.deepEqual(calls, [{ messages: [], mode: "immediate" }]);
  const { sendMessages: _method, ...unavailable } = rpc;
  assert.deepEqual(await createCopilotInvocation({ rpc: unavailable })({ type: "copilot.continue" }), { status: "refused", detail: { reason: "unsupportedNativeMethod" } });
});


test("Codex primary Send never silently queues after a pinned rejection; only explicit Queue admits a queued original", async () => {
  const frames: Record<string, unknown>[] = [], listeners = new Set<(text: string) => void>();
  let message = "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }";
  const wire: CodexWire = { onData: listener => { listeners.add(listener); return () => listeners.delete(listener); }, onClose: () => () => {}, close: async () => {},
    write: async text => { const value = JSON.parse(text) as Record<string, unknown>; frames.push(value); const params = value.params as Record<string, unknown>;
      for (const listener of listeners) listener(JSON.stringify({ id: value.id, ...(value.method === "thread/queue/add" ? { result: { queuedSubmission: { id: "native-queue-id", clientUserMessageId: params.clientUserMessageId, input: "private echo omitted" } } } : { error: { code: -32603, message } }) }) + "\n"); } };
  const rpc = new CodexStdioRpc(wire, () => {}, () => {}), run = { scope: { connection: "fixture", principal: "owner", host: "host", session: "root" }, generation: 1, nativeSession: "native-thread" };
  try {
    const { codexProtocol } = await import("../../v8-harness-codex/src/protocol.js");
    const invoke = createCodexInvocation({ run, rpc: (method, params) => rpc.request(method, params) });
    const original = codexProtocol.prepare({ type: "send", text: "original input" }, "one-original");
    assert.deepEqual(await invoke(original), { status: "refused", detail: { reason: "activeTurnNotSteerable" } });
    assert.deepEqual(frames.map(value => value.method), ["turn/start"]);
    assert.deepEqual(await invoke(codexProtocol.prepare({ type: "codex.queue.add", text: "explicit queued input" }, "explicit-queue")), { status: "accepted", detail: { queuedSubmission: { id: "native-queue-id", clientUserMessageId: "explicit-queue" } } });
    assert.deepEqual(frames.map(value => value.method), ["turn/start", "thread/queue/add"]);
    const before = frames.length;
    assert.equal((await invoke(codexProtocol.prepare({ type: "send", text: "selected input", selection: { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" } } }, "selected-original"))).status, "refused");
    assert.equal(frames.length, before + 1, "a selected primary Send also refuses instead of silently queueing");
    message = "failed to submit turn input: Other";
    await assert.rejects(invoke(original), /Pinned Codex native request rejected/);
    assert.equal(frames.length, before + 2, "unknown error never retries or queues");
  } finally { await rpc.close(); }
});
