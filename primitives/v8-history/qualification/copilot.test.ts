import assert from "node:assert/strict";
import test from "node:test";
import type { CopilotScope, Origin, Row, RowKind } from "../src/contracts/types.js";
import { HistoryHub } from "../src/host/history-owner.js";
import { createCopilotCodec, PrimitiveError } from "../src/native/copilot/index.js";

const origin: Origin = { connection: "fixture", principal: "tester", host: "host", nativeSession: "native", attachment: "capture-1" };
const scope = (agentId: string | null = null, legacyParentToolCallId?: string): CopilotScope => legacyParentToolCallId
  ? { kind: "copilot", origin, agentId: null, legacyParentToolCallId }
  : { kind: "copilot", origin, agentId };
const key = (kind: RowKind, id: string): string => JSON.stringify(["copilot", kind, id]);
const event = (id: string, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, type, data, parentId: null, timestamp: "2026-10-23T00:00:00Z", ...extra });
function rig() {
  const hub = new HistoryHub(); const codec = createCopilotCodec({ origin, capture: hub, knownStart: true });
  const row = (kind: RowKind, id: string, agent: string | null = null, legacyParentToolCallId?: string): Row => {
    const value = hub.snapshot(scope(agent, legacyParentToolCallId)).rows.find(value => value.id === key(kind, id)); assert.ok(value); return value;
  };
  return { hub, codec, row, observe: codec.observe };
}
const body = (row: Row): string => row.body.kind === "unavailable" ? "" : row.body.text;
const code = (expected: string) => (error: unknown): boolean => error instanceof PrimitiveError && error.code === expected;

test("Copilot original identities deduplicate event IDs, never equal text or immutable conflicts", () => {
  const { hub, observe, row } = rig();
  const first = event("u-event-1", "user.message", { messageId: "request-1", content: "same" });
  observe(first); observe(first);
  observe(event("u-event-2", "user.message", { messageId: "request-2", content: "same" }));
  assert.equal(hub.snapshot(scope()).rows.length, 2);
  assert.equal(body(row("user", "request-1")), "same");
  assert.throws(() => observe({ ...first, data: { messageId: "request-1", content: "changed" } }), code("COPILOT_EVENT_CONFLICT"));
  assert.equal(body(row("user", "request-1")), "same");
});

test("Copilot logical finals are immutable across delivery IDs and conflict evidence survives full-body healing", () => {
  const cases = [
    { kind: "assistant" as const, type: "assistant.message", id: "messageId" },
    { kind: "reasoning" as const, type: "assistant.reasoning", id: "reasoningId" },
    { kind: "user" as const, type: "user.message", id: "messageId" },
    { kind: "tool" as const, type: "tool.execution_complete", id: "toolCallId" },
  ];
  for (const family of cases) {
    const { hub, codec, observe, row } = rig();
    const final = (text: string) => family.kind === "tool" ? { toolCallId: "logical", success: true, result: { content: text } } : { [family.id]: "logical", content: text };
    observe(event("first", family.type, final("accepted")));
    const sealed = hub.snapshot(scope());
    observe(event("identical", family.type, final("accepted")));
    assert.strictEqual(hub.snapshot(scope()), sealed, `${family.kind} duplicate final is inert`);
    observe(event("conflict", family.type, final("contradiction")));
    assert.equal(body(row(family.kind, "logical")), "accepted");
    assert.equal(row(family.kind, "logical").native.eventId, "first");
    assert.deepEqual(codec.diagnostics().quarantined, [{ eventId: "conflict", reason: "conflicting logical final" }]);
    const gaps = hub.snapshot(scope()).coverage.gaps;
    assert.ok(gaps.some(gap => gap.kind === "nativeGap" && gap.rowId === undefined));
    observe(event("correct-again", family.type, final("accepted")));
    observe(event("another-full", "assistant.message", { messageId: "other", content: "complete" }));
    assert.deepEqual(hub.snapshot(scope()).coverage.gaps, gaps);
    if (family.kind === "tool") {
      observe(event("lifecycle-conflict", family.type, { toolCallId: "logical", success: false, result: { content: "accepted" } }));
      assert.equal(row("tool", "logical").lifecycle, "completed");
      assert.equal(body(row("tool", "logical")), "accepted");
    }
  }
});

test("Copilot oversized system instructions remain untouched sideband while actual history and errors survive", () => {
  const { hub, codec, observe, row } = rig();
  const before = hub.snapshot(scope());
  const instructions = event("system", "system.message", { role: "system", content: "private instruction ".repeat(6000), contentBlocks: [{ content: "also private" }] });
  observe(instructions); observe(instructions);
  let accesses = 0;
  const privateData = { role: "developer" };
  for (const key of ["content", "contentBlocks", "metadata"]) Object.defineProperty(privateData, key, {
    enumerable: true, get() { accesses++; throw new Error("Instruction body must never be inspected"); },
  });
  observe(event("private-accessor", "system.message", privateData, { agentId: "child" }));
  assert.equal(accesses, 0); assert.strictEqual(hub.snapshot(scope()), before);
  assert.equal(codec.diagnostics().seenEvents, 2); assert.equal(codec.diagnostics().rows, 0);
  assert.throws(() => observe({ ...instructions, agentId: "different-owner" }), code("COPILOT_EVENT_CONFLICT"));
  observe(event("human", "assistant.message", { messageId: "visible", content: "actual child history" }, { agentId: "child" }));
  observe(event("critical", "session.error", { message: "native failure retained" }));
  assert.equal(body(row("assistant", "visible", "child")), "actual child history");
  assert.equal(hub.snapshot(scope()).rows[0]!.lifecycle, "failed");
  assert.equal(hub.snapshot(scope()).coverage.gaps.length, 0);
});

test("Copilot known startup/hook/queue metadata does not invent history gaps or hide unknown transcript forms", () => {
  const { hub, observe } = rig();
  const before = hub.snapshot(scope());
  for (const type of ["session.managed_settings_resolved", "session.skills_loaded", "session.mcp_servers_loaded",
    "session.tools_updated", "hook.start", "hook.end", "pending_messages.modified"]) observe(event(type, type, {}));
  assert.strictEqual(hub.snapshot(scope()), before);
  observe(event("future", "assistant.future_transcript_form", { content: "unclassified actual transcript" }));
  assert.ok(hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "unsupported"));
  assert.throws(() => observe(event("wrong-role", "system.message", { role: "user", content: "not a system instruction" })), code("COPILOT_SYSTEM_ROLE"));
  const limited = createCopilotCodec({ origin, capture: new HistoryHub(), limits: { maxEvents: 1 } });
  limited.observe(event("one", "system.message", { role: "system", content: "ignored" }));
  assert.throws(() => limited.observe(event("two", "session.tools_updated", {})), code("COPILOT_EVENT_COUNT_LIMIT"));
});

test("Copilot telemetry and unknown tool-input deliveries cannot flood per-owner feature gaps", () => {
  const { hub, observe } = rig();
  for (let index = 0; index < 200; index++) {
    observe(event(`diagnostic-${index}`, "model.turn_ended", { kind: "turn_ended", turn: index, modelInfo: { private: "sideband" } }, { ephemeral: true }));
    observe(event(`input-${index}`, "assistant.tool_call_delta", { toolCallId: "t", inputDelta: "input fragment" }, { ephemeral: true }));
  }
  assert.equal(hub.snapshot(scope()).coverage.gaps.length, 1);
  assert.equal(hub.snapshot(scope()).rows.length, 0);
  observe(event("child-input", "assistant.tool_call_delta", { toolCallId: "t", inputDelta: "child input" }, { agentId: "child", ephemeral: true }));
  assert.equal(hub.snapshot(scope("child")).coverage.gaps.length, 1);
  observe(event("wrong-diagnostic", "model.turn_ended", { kind: "human transcript", turn: 1 }, { ephemeral: true }));
  observe(event("non-ephemeral", "model.turn_ended", { kind: "turn_ended", turn: 1 }));
  assert.equal(hub.snapshot(scope()).coverage.gaps.length, 2);
  observe(event("permission", "permission.requested", { requestId: "exact", permissionRequest: { kind: "shell", managedApprovalRequired: true } }));
  assert.equal(hub.snapshot(scope()).coverage.gaps.length, 2);
});

test("Copilot native full tool input metadata survives independently of output and partial input support", () => {
  const { observe, row } = rig();
  const arguments_ = { command: "printf fixture", options: { environment: ["scripted"] } };
  const requests = [{ toolCallId: "t", name: "shell", arguments: arguments_ }];
  observe(event("assistant-tool-only", "assistant.message", { messageId: "m", content: "", toolRequests: requests }));
  observe(event("tool-start", "tool.execution_start", { toolCallId: "t", toolName: "shell", arguments: arguments_ }));
  observe(event("tool-end", "tool.execution_complete", { toolCallId: "t", success: true, result: { content: "output" } }));
  arguments_.command = "caller changed";
  assert.deepEqual(row("tool", "t").native.arguments, { command: "printf fixture", options: { environment: ["scripted"] } });
  assert.equal(body(row("tool", "t")), "output");
  assert.deepEqual(row("assistant", "m").native.toolRequests, [{ toolCallId: "t", name: "shell", arguments: { command: "printf fixture", options: { environment: ["scripted"] } } }]);
  assert.equal(body(row("assistant", "m")), "");
});

test("Copilot full message and reasoning finals replace deltas, including empty tool-only final", () => {
  const { observe, row } = rig();
  observe(event("start", "assistant.message_start", { messageId: "m" }));
  observe(event("delta", "assistant.message_delta", { messageId: "m", deltaContent: "provisional" }));
  observe(event("delta-2", "assistant.message_delta", { messageId: "m", deltaContent: "provisional" }));
  assert.equal(body(row("assistant", "m")), "provisionalprovisional");
  observe(event("reason-delta", "assistant.reasoning_delta", { reasoningId: "r", deltaContent: "suffix" }));
  assert.equal(row("reasoning", "r").body.kind, "partial");
  observe(event("final", "assistant.message", { messageId: "m", content: "", toolRequests: [{ toolCallId: "t", name: "shell" }], originatingMessageId: "original" }));
  observe(event("reason-final", "assistant.reasoning", { reasoningId: "r", content: "whole reasoning" }));
  assert.deepEqual(row("assistant", "m").body, { kind: "complete", text: "", evidence: "nativeFullBody" });
  assert.equal(row("assistant", "m").native.originatingMessageId, "original");
  assert.equal(body(row("reasoning", "r")), "whole reasoning");
  observe(event("late-delta", "assistant.message_delta", { messageId: "m", deltaContent: "late" }));
  assert.equal(body(row("assistant", "m")), "");
});

test("Copilot deprecated partial output is replacement; absent completion body never seals it", () => {
  const { observe, row } = rig();
  observe(event("tool-start", "tool.execution_start", { toolCallId: "t", toolName: "shell", arguments: { command: "not output" } }));
  observe(event("p1", "tool.execution_partial_result", { toolCallId: "t", partialOutput: "one" }));
  observe(event("p2", "tool.execution_partial_result", { toolCallId: "t", partialOutput: "one two" }));
  observe(event("tool-end", "tool.execution_complete", { toolCallId: "t", success: true }));
  assert.equal(body(row("tool", "t")), "one two");
  assert.equal(row("tool", "t").native.toolName, "shell");
  assert.equal(row("tool", "t").lifecycle, "completed");
  assert.equal(row("tool", "t").body.kind, "partial");
  const partial = row("tool", "t").body; assert.ok(partial.kind === "partial" && partial.missing.includes("final"));
  observe(event("empty-end", "tool.execution_complete", { toolCallId: "empty", success: true, result: { content: "" } }));
  assert.deepEqual(row("tool", "empty").body, { kind: "complete", text: "", evidence: "nativeFullBody" });
});

test("Copilot shell sequence is shared across streams; gaps and conflicts preserve captured bytes", () => {
  const { hub, observe, row } = rig();
  observe(event("start", "tool.execution_start", { toolCallId: "shell", toolName: "shell" }));
  observe(event("s0", "tool.shell_output", { toolCallId: "shell", sequence: 0, text: "A", stream: "stdout" }));
  observe(event("s1", "tool.shell_output", { toolCallId: "shell", sequence: 1, text: "B", stream: "stderr" }));
  observe(event("s1-again", "tool.shell_output", { toolCallId: "shell", sequence: 1, text: "B", stream: "stderr" }));
  assert.equal(body(row("tool", "shell")), "AB");
  observe(event("s3", "tool.shell_output", { toolCallId: "shell", sequence: 3, text: "D", stream: "stdout" }));
  observe(event("s3-conflict", "tool.shell_output", { toolCallId: "shell", sequence: 3, text: "wrong", stream: "stdout" }));
  observe(event("s2-late", "tool.shell_output", { toolCallId: "shell", sequence: 2, text: "C", stream: "stderr" }));
  observe(event("finish", "tool.execution_complete", { toolCallId: "shell", success: true }));
  assert.equal(body(row("tool", "shell")), "ABD");
  const partial = row("tool", "shell").body; assert.ok(partial.kind === "partial" && partial.missing.includes("interior") && partial.missing.includes("final"));
  assert.ok(hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "nativeGap"));
  observe(event("full", "tool.execution_complete", { toolCallId: "shell", success: true, result: { content: "short", detailedContent: "ABCD" } }));
  assert.deepEqual(row("tool", "shell").body, { kind: "complete", text: "ABCD", evidence: "nativeFullBody" });
  assert.equal(hub.snapshot(scope()).coverage.gaps.filter(gap => gap.rowId === key("tool", "shell")).length, 0);
});

test("Copilot late exact alias migrates a provisional child prefix without inventing completeness", () => {
  const { hub, observe, row } = rig();
  observe(event("early", "assistant.message_delta", { messageId: "early-message", deltaContent: "tail", parentToolCallId: "task" }));
  const legacy = scope(null, "task");
  assert.equal(body(row("assistant", "early-message", null, "task")), "tail");
  const oldWatch = hub.watch(legacy); oldWatch.drain();
  observe(event("child-start", "subagent.started", { toolCallId: "task", agentName: "worker", agentDisplayName: "Worker", agentDescription: "scripted" }, { agentId: "child" }));
  assert.equal(hub.snapshot(legacy).rows.length, 0);
  const moved = row("assistant", "early-message", "child");
  assert.equal(body(moved), "tail");
  assert.ok(moved.body.kind === "partial" && moved.body.missing.includes("prefix") && moved.body.missing.includes("final"));
  assert.ok(oldWatch.drain().some(frame => frame.kind === "commit" && frame.changes.some(change => change.kind === "retireRows" && change.evidence.includes("exact"))));
  observe(event("child-final", "assistant.message", { messageId: "early-message", content: "whole child" }, { agentId: "child" }));
  assert.equal(body(row("assistant", "early-message", "child")), "whole child");
  assert.equal(hub.snapshot(scope()).rows.filter(row => row.kind === "assistant").length, 0);
  void oldWatch.return();
});

test("Copilot nested summary routes by task parent, never chronological parentId or equal opaque IDs", () => {
  const { hub, observe, row } = rig();
  observe(event("parent-start", "subagent.started", { toolCallId: "parent-task", agentName: "p" }, { agentId: "parent-agent" }));
  observe(event("nested-start", "subagent.started", { toolCallId: "nested-task", parentId: "parent-task", agentName: "nested" }, { agentId: "nested-agent", parentId: "some-root-event" }));
  assert.equal(row("delegation", "nested-task", "parent-agent").native.agentName, "nested");
  assert.equal(hub.snapshot(scope()).rows.some(row => row.id === key("delegation", "nested-task")), false);
  observe(event("root-message", "assistant.message", { messageId: "root", content: "root" }, { parentId: "nested-start" }));
  assert.equal(body(row("assistant", "root")), "root");
  observe(event("opaque-agent", "assistant.message", { messageId: "separate", content: "actual" }, { agentId: "opaque" }));
  observe(event("opaque-tool", "assistant.message", { messageId: "separate", content: "legacy", parentToolCallId: "opaque" }));
  assert.equal(body(row("assistant", "separate", "opaque")), "actual");
  assert.equal(body(row("assistant", "separate", null, "opaque")), "legacy");
});

test("Copilot child configuration and settlement cannot overwrite root activity or complete another body", () => {
  const { hub, observe, row } = rig();
  observe(event("turn", "assistant.turn_start", { turnId: "root-turn" }));
  observe(event("new-turn", "assistant.turn_start", { turnId: "current-turn" }));
  observe(event("old-turn-end", "assistant.turn_end", { turnId: "root-turn" }));
  observe(event("root-prefix", "assistant.message_delta", { messageId: "root", deltaContent: "partial" }));
  observe(event("child-start", "subagent.started", { toolCallId: "task", agentName: "child" }, { agentId: "child" }));
  observe(event("config", "subagent.configured", { model: "child-model", multiTurn: false }, { agentId: "child" }));
  observe(event("child-cancelled", "subagent.completed", { toolCallId: "task", agentName: "child", cancelled: true }, { agentId: "child" }));
  observe(event("child-idle", "session.idle", {}, { agentId: "child" }));
  observe(event("assistant-idle", "assistant.idle", {}));
  assert.equal(hub.snapshot(scope()).activity.state, "working");
  assert.equal(hub.snapshot(scope()).activity.turnId, "current-turn");
  assert.equal(row("delegation", "task").lifecycle, "interrupted");
  assert.equal(hub.snapshot(scope("child")).rows[0]!.native.model, "child-model");
  assert.equal(hub.snapshot(scope()).rows.some(row => row.native.model === "child-model"), false);
  observe(event("idle", "session.idle", {}));
  assert.equal(hub.snapshot(scope()).activity.state, "idle");
  assert.equal(row("assistant", "root").body.kind, "partial");
});

test("Copilot malformed owners stay bounded and unclassified; admission limits reject explicitly", () => {
  const hub = new HistoryHub(); const codec = createCopilotCodec({ origin, capture: hub, limits: { maxUnknown: 1, maxEvents: 4 } });
  codec.observe(event("invalid", "assistant.message", { messageId: "m", content: "must not become root" }, { agentId: "" }));
  assert.equal(hub.snapshot(scope()).rows.length, 0);
  assert.equal(codec.diagnostics().quarantined.length, 1);
  assert.throws(() => codec.observe(event("invalid-2", "assistant.message", { messageId: "m", content: "still not root" }, { agentId: false })), code("COPILOT_UNKNOWN_LIMIT"));
  const bounded = createCopilotCodec({ origin, capture: new HistoryHub(), limits: { maxBodyChars: 3 } });
  assert.throws(() => bounded.observe(event("too-large", "assistant.message", { messageId: "m", content: "four" })), code("COPILOT_BODY_LIMIT"));
});

test("Copilot a missed nested start cannot turn a primary lifecycle summary into root-owned history", () => {
  const { hub, codec, observe } = rig();
  observe(event("orphan-end", "subagent.completed", { toolCallId: "unknown-task", agentName: "worker" }, { agentId: "child" }));
  assert.equal(hub.snapshot(scope()).rows.length, 0);
  assert.equal(codec.diagnostics().quarantined[0]!.reason, "subagent lifecycle parent was not captured");
});

test("Copilot a rejected Host publication latches the codec and cannot become an observed duplicate", () => {
  const hub = new HistoryHub(); let attempts = 0;
  const codec = createCopilotCodec({ origin, capture: {
    open: (scope, options) => hub.open(scope, options),
    emit: () => { attempts++; throw new Error("scripted Host capacity rejection"); },
    reset: (scope, reason) => hub.reset(scope, reason),
  } });
  const input = event("not-admitted", "assistant.message", { messageId: "m", content: "retained nowhere" });
  assert.throws(() => codec.observe(input), /scripted Host capacity rejection/);
  assert.equal(codec.diagnostics().failed, true); assert.equal(codec.diagnostics().seenEvents, 0);
  assert.throws(() => codec.observe(input), code("COPILOT_CAPTURE_FAILED"));
  assert.equal(attempts, 1); assert.equal(hub.snapshot(scope()).rows.length, 0);
});

test("Copilot native rewind fences the capture image; normal stream input never reads native history", () => {
  const { hub, observe } = rig();
  observe(event("message", "assistant.message", { messageId: "m", content: "before" }));
  const before = hub.snapshot(scope());
  observe(event("rewind", "session.snapshot_rewind", { upToEventId: "message", eventsRemoved: 1, eventIds: ["message"] }));
  const after = hub.snapshot(scope());
  assert.notEqual(after.generation, before.generation); assert.equal(after.rows.length, 0); assert.equal(after.coverage.knownStart, false);
  // The fixture supplies only CapturePort: no SDK, RPC, file, terminal or history-read port exists.
  assert.equal(after.olderEdge.state, "unknown");
});
