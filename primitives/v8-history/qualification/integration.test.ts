import assert from "node:assert/strict";
import test from "node:test";
import { HistoryHub } from "../src/host/history-owner.js";
import { HistoryWorkspace } from "../src/client/workspace.js";
import { createCodexCodec } from "../src/native/codex/index.js";
import { createCopilotCodec } from "../src/native/copilot/index.js";
import { ScriptedActionOwner, ScriptedLink } from "../src/scripted/link.js";
import type { CodexScope, CopilotScope, NativeCodec, Scope } from "../src/contracts/types.js";

function native(kind: "codex" | "copilot", hub: HistoryHub) {
  const origin = { connection: "scripted", principal: "owner", host: kind, nativeSession: `${kind}-root`, attachment: "owned-1" };
  const scope: Scope = kind === "codex" ? { kind, origin, threadId: origin.nativeSession } : { kind, origin, agentId: null };
  const codec: NativeCodec = kind === "codex" ? createCodexCodec({ origin, capture: hub, rootThreadId: origin.nativeSession, knownStart: true }) : createCopilotCodec({ origin, capture: hub, knownStart: true });
  let sequence = 0;
  const observe = (type: string, data: Record<string, unknown>) => codec.observe(kind === "codex" ? { method: type, params: { threadId: origin.nativeSession, turnId: "turn", ...data } } : { id: `event-${++sequence}`, type, data, parentId: null, timestamp: "2026-10-23T00:00:00Z" });
  return {
    scope, codec,
    begin() {
      if (kind === "codex") {
        observe("turn/started", { turn: { id: "turn", status: "inProgress", items: [], itemsView: "notLoaded" } });
        observe("item/started", { item: { type: "userMessage", id: "original-native", content: [{ type: "text", text: "original Send" }] } });
        observe("item/completed", { item: { type: "userMessage", id: "original-native", content: [{ type: "text", text: "original Send" }] } });
        observe("item/started", { item: { type: "agentMessage", id: "answer", text: "" } });
        observe("item/agentMessage/delta", { itemId: "answer", delta: "Hello " });
      } else {
        observe("assistant.turn_start", { turnId: "turn" });
        observe("user.message", { messageId: "original-native", content: "original Send" });
        observe("assistant.message_start", { messageId: "answer" });
        observe("assistant.message_delta", { messageId: "answer", deltaContent: "Hello " });
      }
    },
    finish() {
      if (kind === "codex") {
        observe("item/started", { item: { type: "commandExecution", id: "terminal", command: "echo fixture", processId: "script-pty", status: "inProgress", aggregatedOutput: null } });
        observe("item/commandExecution/outputDelta", { itemId: "terminal", delta: "fixture\n" });
        observe("item/completed", { item: { type: "commandExecution", id: "terminal", command: "echo fixture", processId: "script-pty", status: "completed", aggregatedOutput: "fixture\n", exitCode: 0 } });
        observe("item/completed", { item: { type: "agentMessage", id: "answer", text: "Hello world" } });
        observe("turn/completed", { turn: { id: "turn", status: "completed", items: [], itemsView: "notLoaded" } });
      } else {
        observe("tool.execution_start", { toolCallId: "terminal", toolName: "shell" });
        observe("tool.shell_output", { toolCallId: "terminal", sequence: 0, text: "fixture\n", stream: "stdout" });
        observe("tool.execution_complete", { toolCallId: "terminal", success: true, result: { content: "fixture\n" } });
        observe("assistant.message", { messageId: "answer", content: "Hello world", originatingMessageId: "original-native" });
        observe("assistant.turn_end", { turnId: "turn" });
      }
    },
  };
}
for (const kind of ["codex", "copilot"] as const) {
  test(`${kind}: original Send, text and terminal survive browser loss and retained Host snapshot with zero native reads`, async () => {
    const hub = new HistoryHub({ maxReplayFrames: 1 }), fixture = native(kind, hub);
    const workspace = new HistoryWorkspace({ connection: "scripted", principal: "owner" });
    const session = workspace.session(fixture.scope), lease = workspace.select(fixture.scope);
    const link = new ScriptedLink(hub, workspace, fixture.scope), actions = new ScriptedActionOwner(fixture.scope);
    link.connect(); link.send(actions, "original-id", { type: "send", text: "original Send" }, true);
    fixture.begin(); link.flush();
    assert.equal(session.operations[0]!.settled, false); // A matching transcript is not the original receipt.
    session.setDraft("next draft"); session.setPinned(true); lease.release();
    await link.disconnect(); fixture.finish(); // Host capture continues without any viewer.
    assert.equal(hub.owner(fixture.scope).subscriberCount, 0);
    assert.ok(hub.snapshot(fixture.scope).rows.some(row => row.kind === "tool"));
    link.connect(); assert.equal(link.retainedSnapshots, 2); // Replay miss uses only retained memory.
    const nextLease = workspace.select(fixture.scope);
    const view = nextLease.view.getSnapshot();
    assert.equal(session.draft, "next draft"); assert.equal(session.pinned, true);
    assert.deepEqual(view.rows.filter(row => row.kind === "assistant").map(row => row.body.kind !== "unavailable" && row.body.text), ["Hello world"]);
    assert.ok(view.rows.some(row => row.kind === "tool" && row.body.kind === "complete" && row.body.text === "fixture\n"));
    assert.equal(session.operations[0]!.settled, false); link.checkOriginal(actions, "original-id");
    assert.equal(session.operations[0]!.settled, true); assert.equal(actions.submitted, 1); assert.equal(actions.checked, 1);
    assert.deepEqual(link.counters, { nativeBodyReads: 0, nativeMetadataReads: 0, nativeStops: 0 });
    nextLease.release(); await link.disconnect(); assert.equal(actions.submitted, 1);
  });
}

test("one shared workspace switches host kinds without draft, original request, expansion, anchor or pinned session loss", () => {
  const hub = new HistoryHub(), codex = native("codex", hub), copilot = native("copilot", hub);
  const workspace = new HistoryWorkspace({ connection: "scripted", principal: "owner" });
  const a = workspace.session(codex.scope), b = workspace.session(copilot.scope);
  const la = new ScriptedLink(hub, workspace, codex.scope), lb = new ScriptedLink(hub, workspace, copilot.scope); la.connect(); lb.connect();
  const first = workspace.select(codex.scope); codex.begin(); la.flush();
  const row = first.view.getSnapshot().rows.find(row => row.kind === "assistant")!;
  first.view.expand(row.id, true); first.view.viewport.userScroll("earlier", false); first.view.viewport.report({ rowId: row.id, offsetPx: 11 });
  a.setDraft({ text: "retained", attachments: ["scripted-reference"] }); a.setPinned(true);
  a.recordOperation("original", { text: "unobserved original" });
  workspace.select(copilot.scope); b.setDraft("different draft"); copilot.begin(); copilot.finish(); lb.flush();
  codex.finish(); la.flush(); assert.equal(a.mountedReferences, 0); assert.equal(a.observationReferences, 1);
  const restored = workspace.select(codex.scope); first.release(); // Stale cleanup cannot unmount the new selection.
  assert.equal(a.mountedReferences, 1); assert.equal(restored.view, first.view);
  assert.deepEqual(restored.view.getSnapshot().expansions, [row.id]); assert.equal(restored.view.viewport.state.anchor!.offsetPx, 11);
  assert.equal(restored.view.viewport.state.intent, "readingHistory"); assert.deepEqual(a.draft, { text: "retained", attachments: ["scripted-reference"] });
  assert.equal(a.operations[0]!.settled, false); assert.equal(b.draft, "different draft");
});

test("native attachment change fences stale history and old receipt scope without resending the original", async () => {
  const hub = new HistoryHub(), fixture = native("copilot", hub), old = fixture.scope as CopilotScope;
  const workspace = new HistoryWorkspace({ connection: "scripted", principal: "owner" }), link = new ScriptedLink(hub, workspace, old), owner = new ScriptedActionOwner(old);
  const session = workspace.session(old); workspace.select(old); link.connect(); link.send(owner, "original", { text: "original" }, true);
  fixture.begin(); link.flush(); const oldFrame = { kind: "snapshot", snapshot: hub.snapshot(old) };
  await link.disconnect();
  const next: CopilotScope = { ...old, origin: { ...old.origin, attachment: "owned-2" } }; hub.open(next); workspace.rebind(next);
  session.client.apply({ kind: "snapshot", snapshot: hub.snapshot(next) });
  assert.throws(() => session.client.apply(oldFrame), /retired history scope/);
  assert.throws(() => owner.check(next, "original"), /FOREIGN_RECEIPT_SCOPE/);
  assert.equal(session.operations[0]!.settled, false); assert.equal(owner.submitted, 1);
  assert.equal(session.client.view().getSnapshot().includesPriorGeneration, true);
  assert.equal(session.client.current!.rows.length, 0);
});


test('operation markers bound unresolved admission separately from recent display and preserve one retirement reservation', () => {
  const workspace = new HistoryWorkspace({ connection: 'scripted', principal: 'owner', maxOperationsPerSession: 1 });
  const scope: CodexScope = { kind: 'codex', threadId: 'root', origin: { connection: 'scripted', principal: 'owner', host: 'host', nativeSession: 'root', attachment: 'one' } };
  const session = workspace.session(scope); session.recordOperation('unknown', { type: 'send' });
  assert.throws(() => session.recordOperation('overflow', { type: 'send' }), /capacity/);
  session.recordOperation('urgent', { type: 'stop' }, true); session.observeOperation('urgent', { state: 'acknowledged' }, true);
  assert.throws(() => session.recordOperation('still-full', { type: 'send' }), /capacity/);
  for (let i = 0; i < 40; i++) {
    session.recordOperation(`stop-${i}`, { type: 'stop' }, true); session.observeOperation(`stop-${i}`, { state: 'acknowledged' }, true);
  }
  assert.equal(session.operations.length, 33); assert.equal(session.operations[0]!.id, 'unknown');
  assert.equal(session.operations[0]!.settled, false);
  session.observeOperation('unknown', { state: 'refused' }, true);
  session.recordOperation('next', { type: 'send' }); assert.equal(session.operations.length, 33);
});
