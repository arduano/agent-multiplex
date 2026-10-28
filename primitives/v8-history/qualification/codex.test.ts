import test from "node:test";
import assert from "node:assert/strict";
import { HistoryHub } from "../src/host/history-owner.js";
import type { CodexScope, Origin, Row } from "../src/contracts/types.js";
import { codexRowId, createCodexCodec, proveCodexLineage, type CodexCodecLimits } from "../src/native/codex/index.js";
import { codexOptionalQuestions } from "../src/native/codex/questions.js";
import { codexErrorRow } from "../src/native/codex/errors.js";

const origin: Origin = { connection: "scripted", principal: "owner", host: "host", nativeSession: "root", attachment: "epoch-1" };
const scope = (threadId = "root"): CodexScope => ({ kind: "codex", origin, threadId });
function rig(limits?: Partial<CodexCodecLimits>) {
  const hub = new HistoryHub();
  const codec = createCodexCodec({ origin, rootThreadId: "root", capture: hub, knownStart: true, ...(limits ? { limits } : {}) });
  const emit = (method: string, params: object) => codec.observe({ method, params });
  const turn = (id: string, status = "inProgress", threadId = "root") => emit(status === "inProgress" ? "turn/started" : "turn/completed", { threadId, turn: { id, status, items: [], itemsView: "notLoaded" } });
  const item = (id: string, text: string, completed = false, turnId = "t1", threadId = "root") => emit(completed ? "item/completed" : "item/started", { threadId, turnId, item: { type: "agentMessage", id, text, phase: "final_answer" } });
  const row = (id: string, threadId = "root"): Row => {
    const found = hub.snapshot(scope(threadId)).rows.find(value => value.id === id);
    assert.ok(found, `expected scoped row ${id}`); return found;
  };
  return { hub, codec, emit, turn, item, row };
}
function text(row: Row): string { assert.notEqual(row.body.kind, "unavailable"); return row.body.kind === "unavailable" ? "" : row.body.text; }
const meta = (id: string, context = id, parent?: string) => ({ id, sessionId: context, ...(parent ? { parentThreadId: parent } : {}) });

test("Codex directly captured text, command and MCP final use the real Host without native read surfaces", () => {
  const r = rig(); r.turn("t1"); r.item("answer", "");
  r.emit("item/agentMessage/delta", { threadId: "root", turnId: "t1", itemId: "answer", delta: "Hello " });
  r.emit("item/agentMessage/delta", { threadId: "root", turnId: "t1", itemId: "answer", delta: "there" });
  const command = { type: "commandExecution", id: "shell", command: "echo scripted", processId: "pty-1", aggregatedOutput: null, status: "inProgress" };
  r.emit("item/started", { threadId: "root", turnId: "t1", item: command });
  r.emit("item/commandExecution/outputDelta", { threadId: "root", turnId: "t1", itemId: "shell", delta: "scripted\n" });
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { ...command, aggregatedOutput: "scripted\n", status: "completed", exitCode: 0 } });
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { type: "mcpToolCall", id: "mcp", server: "fixture", tool: "lookup", status: "completed", result: { content: [{ type: "text", text: "tool result" }] } } });
  r.item("answer", "Hello there", true); r.turn("t1", "completed");
  const snapshot = r.hub.snapshot(scope());
  assert.equal(snapshot.coverage.knownStart, true);
  assert.deepEqual(snapshot.coverage.gaps, []);
  assert.deepEqual(snapshot.rows.map(row => text(row)), ["Hello there", "scripted\n", "tool result"]);
  assert.ok(snapshot.rows.every(row => row.lifecycle === "completed" && row.body.kind === "complete"));
  assert.equal(r.row(codexRowId("root", "t1", "shell")).native.processId, "pty-1");
  // The codec has only CapturePort; no SDK, endpoint or history-reader exists in this rig.
  assert.equal(r.codec.diagnostics().bufferedEvents, 0);
});

test("Codex optional question metadata survives live capture without becoming a callback or rejecting message text", () => {
  const r = rig(), questions = [{ title: "Pick a route", options: ["Keep this exact label", "Another route"] },
    { title: "Explain your preference", options: null }, { title: "x".repeat(501), options: ["Too long"] }, { title: "Bad options", options: [12] }];
  const item = { type: "agentMessage", id: "optional", text: "Pick a route\n- Keep this exact label\n- Another route", phase: "final_answer", delivery: "async", questions };
  r.turn("t1");
  r.emit("item/started", { threadId: "root", turnId: "t1", item });
  r.emit("item/completed", { threadId: "root", turnId: "t1", item });
  const row = r.row(codexRowId("root", "t1", item.id));
  assert.equal(row.native.delivery, "async");
  assert.deepEqual(row.native.questions, [{ title: "Pick a route", options: ["Keep this exact label", "Another route"] }, { title: "Explain your preference", options: [] }]);
  assert.equal(row.native.questionsOmitted, 2);
  assert.equal(text(row), item.text); assert.deepEqual(r.hub.snapshot(scope()).coverage.gaps, []);
  assert.equal(r.hub.snapshot(scope()).activity.state, "working");
  assert.equal(r.codec.diagnostics().rejected, 0);
});

test("Codex optional question bounds omit whole questions while preserving exact accepted text and native message", () => {
  const title = "😀".repeat(250), label = "界".repeat(200), raw = Array.from({ length: 9 }, () => ({ title, options: Array(8).fill(label) }));
  const optional = codexOptionalQuestions(raw);
  assert.equal(optional.questions.length, 2); assert.equal(optional.omitted, 7);
  assert.equal(optional.questions[0]!.title, title); assert.equal(optional.questions[0]!.options[0], label);
  assert.ok(new TextEncoder().encode(JSON.stringify(optional)).byteLength <= 12 * 1024);
  assert.deepEqual(codexOptionalQuestions(null), { questions: [], omitted: 0 });
  assert.deepEqual(codexOptionalQuestions({ future: true }), { questions: [], omitted: 1 });
  assert.deepEqual(codexOptionalQuestions([{ title: "Invalid", options: Array(9).fill("a") }, { title: "Invalid", options: ["x".repeat(201)] }, { title: "Valid exact spaces  ", options: undefined }]),
    { questions: [{ title: "Valid exact spaces  ", options: [] }], omitted: 2 });
  const r = rig();
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { type: "agentMessage", id: "bounded", text: "Native fallback remains intact", delivery: "async", questions: raw } });
  const row = r.row(codexRowId("root", "t1", "bounded"));
  assert.deepEqual(row.native.questions, optional.questions.slice(0, 1)); assert.equal(row.native.questionsOmitted, 8);
  assert.ok(new TextEncoder().encode(JSON.stringify(row.native)).byteLength <= 8_192);
  assert.equal(text(row), "Native fallback remains intact"); assert.equal(r.codec.diagnostics().rejected, 0);
});

test("Codex optional questions over the live metadata budget cannot discard their assistant message", () => {
  const r = rig(), questions = Array.from({ length: 8 }, () => ({ title: "q".repeat(500), options: Array(3).fill("o".repeat(200)) }));
  assert.equal(codexOptionalQuestions(questions).omitted, 0);
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { type: "agentMessage", id: "overflow", text: "Native fallback survives optional presentation overflow", delivery: "async", questions } });
  const row = r.row(codexRowId("root", "t1", "overflow"));
  assert.ok(Array.isArray(row.native.questions)); assert.ok(typeof row.native.questionsOmitted === "number" && row.native.questionsOmitted > 0);
  assert.equal(text(row), "Native fallback survives optional presentation overflow");
  assert.deepEqual(r.hub.snapshot(scope()).coverage.gaps, []); assert.equal(r.codec.diagnostics().rejected, 0);
});

test("Codex orphan suffix is not served as a prefix; an absolute final heals only the exact item", () => {
  const r = rig();
  r.emit("item/agentMessage/delta", { threadId: "root", turnId: "t1", itemId: "lost", delta: "suffix" });
  assert.equal(r.hub.snapshot(scope()).rows.length, 0);
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "missingPrefix"));
  r.item("lost", "Full native answer", true);
  const row = r.row(codexRowId("root", "t1", "lost"));
  assert.equal(text(row), "Full native answer"); assert.equal(row.body.kind, "complete");
  assert.deepEqual(r.hub.snapshot(scope()).coverage.gaps, []);
  r.item("lost", "", false);
  r.emit("item/agentMessage/delta", { threadId: "root", turnId: "t1", itemId: "lost", delta: "duplicate suffix" });
  assert.equal(text(r.row(row.id)), "Full native answer");
});

test("Codex nullable command completion preserves captured bytes without inventing an empty body", () => {
  const r = rig();
  const command = { type: "commandExecution", id: "shell", status: "inProgress", aggregatedOutput: null };
  r.emit("item/started", { threadId: "root", turnId: "t1", item: command });
  r.emit("item/commandExecution/outputDelta", { threadId: "root", turnId: "t1", itemId: "shell", delta: "retained output" });
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { ...command, status: "completed" } });
  const captured = r.row(codexRowId("root", "t1", "shell"));
  assert.equal(text(captured), "retained output");
  assert.equal(captured.body.kind, "partial");
  if (captured.body.kind === "partial") assert.deepEqual(new Set(captured.body.missing), new Set(["prefix", "final"]));
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { ...command, id: "unseen", status: "completed" } });
  const unavailable = r.row(codexRowId("root", "t1", "unseen"));
  assert.equal(unavailable.lifecycle, "completed"); assert.notEqual(unavailable.body.kind, "complete");
});

test("actual-shaped Codex .162.1 command loses startup delta; only full final aggregate proves FIRST plus SECOND", () => {
  const r = rig();
  const command = { type: "commandExecution", id: "shell", command: "printf 'FIRST\\n'; sleep 1; printf 'SECOND\\n'",
    status: "inProgress", aggregatedOutput: null };
  r.emit("item/started", { threadId: "root", turnId: "t1", item: command });
  r.emit("item/commandExecution/outputDelta", { threadId: "root", turnId: "t1", itemId: "shell", delta: "SECOND\n" });
  const id = codexRowId("root", "t1", "shell"), live = r.row(id);
  assert.equal(text(live), "SECOND\n"); assert.equal(live.body.kind, "partial");
  if (live.body.kind === "partial") assert.ok(live.body.missing.includes("prefix"));
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { ...command, status: "completed", aggregatedOutput: "FIRST\nSECOND\n" } });
  const final = r.row(id);
  assert.deepEqual(final.body, { kind: "complete", text: "FIRST\nSECOND\n", evidence: "nativeFullBody" });
  assert.deepEqual(r.hub.snapshot(scope()).coverage.gaps, []);
});

test("Codex orphan command suffix and absent final retain partial provenance without sealing bytes", () => {
  const r = rig();
  r.emit("item/commandExecution/outputDelta", { threadId: "root", turnId: "t1", itemId: "orphan", delta: "SECOND\n" });
  const id = codexRowId("root", "t1", "orphan");
  assert.equal(text(r.row(id)), "SECOND\n");
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { type: "commandExecution", id: "orphan", status: "completed" } });
  const final = r.row(id);
  assert.equal(final.lifecycle, "completed"); assert.equal(final.body.kind, "partial");
  if (final.body.kind === "partial") assert.deepEqual(new Set(final.body.missing), new Set(["prefix", "final"]));
});

test("Codex scoped moderation metadata is validated sideband and repeated observations do not change history", () => {
  const r = rig(); r.turn("t1"); r.item("answer", "native text", true);
  const before = r.hub.snapshot(scope());
  for (let index = 0; index < 2; index++) r.emit("turn/moderationMetadata", { threadId: "root", turnId: "t1", metadata: { fixture: true, index } });
  assert.strictEqual(r.hub.snapshot(scope()), before);
  assert.deepEqual(before.coverage.gaps, []);
  r.emit("turn/moderationMetadata", { threadId: "root", metadata: {} });
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "unsupported"));
});

test("Codex global account and MCP sidebands do not require a transcript scope or manufacture history gaps", () => {
  const r = rig(); r.turn("t1"); r.item("answer", "native text", true); r.turn("t1", "completed");
  const before = r.hub.snapshot(scope());
  r.emit("account/updated", { authMode: null, planType: null });
  r.emit("account/rateLimits/updated", { rateLimits: { limitId: "fixture", primary: null, secondary: null, credits: null, planType: null } });
  r.emit("skills/changed", {});
  r.emit("mcpServer/startupStatus/updated", { threadId: null, name: "fixture", status: "ready", error: null, failureReason: null });
  r.emit("mcpServer/startupStatus/updated", { threadId: "root", name: "fixture", status: "starting", error: null, failureReason: null });
  r.emit("mcpServer/oauthLogin/completed", { threadId: null, name: "fixture", loginId: "attempt", success: true });
  assert.strictEqual(r.hub.snapshot(scope()), before);
  assert.deepEqual(before.coverage.gaps, []);
  assert.equal(r.codec.diagnostics().rejected, 0);
  // Known sidebands establish no body, completion or ancestry. Missing scope
  // on an actual transcript frame or unknown notification remains a gap.
  r.emit("item/agentMessage/delta", { threadId: null, turnId: "t1", itemId: "answer", delta: "bad suffix" });
  r.emit("unknown/notification", {});
  assert.equal(r.codec.diagnostics().rejected, 2);
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.id === "codex:scope"));
  assert.equal(text(r.row(codexRowId("root", "t1", "answer"))), "native text");
});

test("Codex native errors retain exact turn-scoped diagnostics without taking turn outcome authority", () => {
  const r = rig(); r.turn("t1");
  const before = r.hub.snapshot(scope());
  const error = { message: "fixture provider unavailable", codexErrorInfo: "other", additionalDetails: null, misalignment: null };
  for (const willRetry of [true, false]) r.emit("error", { threadId: "root", turnId: "t1", error, willRetry });
  const notices = r.hub.snapshot(scope());
  assert.equal(notices.rows.length, 2);
  assert.deepEqual(notices.rows.map(row => [row.kind, text(row), row.native.type, row.native.turnId, row.native.willRetry]),
    [["notice", error.message, "turnError", "t1", true], ["notice", error.message, "turnError", "t1", false]]);
  assert.deepEqual(notices.activity, before.activity);
  assert.deepEqual(notices.coverage.gaps, []);
  r.emit("turn/completed", { threadId: "root", turn: { id: "t1", status: "failed", error } });
  assert.equal(r.hub.snapshot(scope()).rows.length, 2);
  assert.deepEqual(r.hub.snapshot(scope()).activity, { turnId: "t1", state: "failed" });
  r.turn("t2");
  assert.equal(r.hub.snapshot(scope()).rows.length, 2);
  r.emit("error", { threadId: "root", turnId: "t1", error, willRetry: "false" });
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.id === "codex:invalidNativeEvent"));
});

test("Codex terminal turn errors survive missed sidebands, duplicate completions and later turns", () => {
  const r = rig(), message = "Selected model is at capacity. Please try a different model.";
  const error = { message, codexErrorInfo: "serverOverloaded", additionalDetails: "private provider diagnostic", misalignment: null };
  r.turn("failed-turn");
  const failure = { threadId: "root", turn: { id: "failed-turn", status: "failed", error } };
  r.emit("turn/completed", failure); r.emit("turn/completed", failure);
  r.turn("new-turn"); r.item("new-answer", "A later answer", true, "new-turn"); r.turn("new-turn", "completed");
  const rows = r.hub.snapshot(scope()).rows;
  assert.equal(rows.length, 2); assert.deepEqual(codexErrorRow(rows[0]!), { message, willRetry: false });
  assert.equal(rows[0]!.native.turnId, "failed-turn"); assert.equal(rows[0]!.native.codexErrorInfo, "serverOverloaded");
  assert.equal(JSON.stringify(rows).includes(error.additionalDetails), false);
  assert.deepEqual(r.hub.snapshot(scope()).coverage.gaps, []);
  assert.equal(codexErrorRow(rows[1]!), undefined);
});

test("Codex reasoning indexes and summary/content channels never concatenate", () => {
  const r = rig();
  r.emit("item/started", { threadId: "root", turnId: "t1", item: { type: "reasoning", id: "r", summary: [], content: [] } });
  for (const [method, indexField, index, delta] of [
    ["item/reasoning/summaryTextDelta", "summaryIndex", 0, "summary zero"],
    ["item/reasoning/textDelta", "contentIndex", 0, "content zero"],
    ["item/reasoning/summaryTextDelta", "summaryIndex", 1, "summary one"],
  ] as const) r.emit(method, { threadId: "root", turnId: "t1", itemId: "r", [indexField]: index, delta });
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { type: "reasoning", id: "r", summary: ["S0 final", "S1 final"], content: ["C0 final"] } });
  for (const [channel, index, expected] of [["summary", 0, "S0 final"], ["summary", 1, "S1 final"], ["content", 0, "C0 final"]] as const) {
    const row = r.row(codexRowId("root", "t1", "r", channel, index));
    assert.equal(text(row), expected); assert.equal(row.native.channel, channel); assert.equal(row.native.index, index);
  }
});

test("Codex terminal turn before late ACK/final cannot finish a newer turn", () => {
  const r = rig(); r.turn("old"); r.item("old-item", "captured prefix", false, "old"); r.turn("old", "completed");
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "missingFinal"));
  r.turn("new");
  r.codec.observe({ id: 7, result: { turn: { id: "old", status: "inProgress" } } });
  r.turn("old", "completed"); r.item("old-item", "late full final", true, "old");
  assert.deepEqual(r.hub.snapshot(scope()).activity, { turnId: "new", state: "working" });
  assert.equal(text(r.row(codexRowId("root", "old", "old-item"))), "late full final");
});

test("Codex A/B completion remains a distinct native item without text aliases", () => {
  const r = rig(); r.item("A", "identical text"); r.item("B", "identical text", true);
  assert.deepEqual(r.hub.snapshot(scope()).rows.map(row => row.id), [codexRowId("root", "t1", "A"), codexRowId("root", "t1", "B")]);
  assert.equal(r.row(codexRowId("root", "t1", "A")).lifecycle, "running");
  r.item("B", "conflicting second completion", true);
  assert.equal(text(r.row(codexRowId("root", "t1", "B"))), "identical text");
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "nativeGap"));
});

test("Cold lineage proof does not authorize live capture; native live ancestry does, without root lifecycle contamination", () => {
  const r = rig();
  proveCodexLineage({ rootThreadId: "root", threadId: "child", metadata: [meta("root"), meta("child", "child", "root")] });
  r.turn("child-turn", "inProgress", "child"); r.item("child-item", "child secret", true, "child-turn", "child");
  assert.equal(r.codec.diagnostics().authorizedThreads, 1);
  assert.equal(r.hub.snapshot(scope()).rows.length, 0);
  r.turn("root-turn");
  r.emit("thread/started", { thread: meta("child", "child", "root") });
  assert.equal(r.codec.diagnostics().authorizedThreads, 2);
  assert.equal(text(r.row(codexRowId("child", "child-turn", "child-item"), "child")), "child secret");
  r.turn("child-turn", "completed", "child");
  assert.deepEqual(r.hub.snapshot(scope()).activity, { turnId: "root-turn", state: "working" });
  assert.deepEqual(r.hub.snapshot(scope("child")).activity, { turnId: "child-turn", state: "idle" });
  assert.equal(r.codec.diagnostics().bufferedEvents, 0);
});

test("actual-shaped .162.1 parent activity grants live child routing without thread/started or invented native context", () => {
  const r = rig(); r.turn("parent-turn");
  // Early child notifications remain withheld until a positive owned-parent
  // reference arrives. This is routing evidence, never a cold-history proof.
  r.turn("child-turn", "inProgress", "child"); r.item("child-answer", "", false, "child-turn", "child");
  const started = { type: "subAgentActivity", id: "call-started", kind: "started", agentThreadId: "child",
    agentPath: "/root/requested_child", model: "gpt-6-luna", reasoningEffort: "medium" };
  r.emit("item/started", { threadId: "root", turnId: "parent-turn", item: started });
  assert.deepEqual(r.codec.threadOwnership("child"), { ownership: { kind: "parentActivity", parentThreadId: "root", activityItemId: "call-started" } });
  assert.equal(r.codec.threadOwnership("root")?.nativeContext, undefined);
  assert.equal(r.codec.diagnostics().bufferedEvents, 0);
  r.emit("item/completed", { threadId: "root", turnId: "parent-turn", item: started });
  const wait = { type: "collabAgentToolCall", id: "call-wait", tool: "wait", status: "inProgress", senderThreadId: "root",
    receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} };
  r.emit("item/started", { threadId: "root", turnId: "parent-turn", item: wait });
  r.emit("item/agentMessage/delta", { threadId: "child", turnId: "child-turn", itemId: "child-answer", delta: "V8_CDX_CHILD_DONE" });
  r.item("child-answer", "V8_CDX_CHILD_DONE", true, "child-turn", "child");
  const completed = { ...started, id: "subagent-completed-child-turn", kind: "completed", model: null, reasoningEffort: null };
  r.emit("item/started", { threadId: "root", turnId: "parent-turn", item: completed });
  r.turn("child-turn", "completed", "child");
  r.emit("item/completed", { threadId: "root", turnId: "parent-turn", item: completed });
  r.emit("item/completed", { threadId: "root", turnId: "parent-turn", item: { ...wait, status: "completed" } });
  assert.deepEqual(r.hub.snapshot(scope()).activity, { turnId: "parent-turn", state: "working" });
  const rootRows = r.hub.snapshot(scope()).rows;
  assert.equal(rootRows.length, 3); assert.equal(new Set(rootRows.map(row => row.id)).size, 3);
  for (const row of rootRows) assert.deepEqual(row.body, { kind: "unavailable", reason: "nativeOmitted" });
  assert.equal(rootRows[0]?.native.model, "gpt-6-luna"); assert.equal(rootRows[1]?.native.model, null);
  assert.equal(rootRows[2]?.native.model, null); assert.equal(rootRows[2]?.native.agentThreadId, "child");
  assert.deepEqual(r.hub.snapshot(scope()).coverage.gaps, []);
  const child = r.row(codexRowId("child", "child-turn", "child-answer"), "child");
  assert.equal(text(child), "V8_CDX_CHILD_DONE"); assert.equal(child.native.threadId, "child");
  assert.equal(r.hub.snapshot(scope("child")).scope.origin.nativeSession, "root");
  assert.equal(r.hub.snapshot(scope("child")).coverage.knownStart, false);
  r.emit("thread/started", { thread: meta("child", "child", "root") });
  assert.equal(r.codec.threadOwnership("child")?.nativeContext, "child");
});

test("Codex completed activity/wait references cannot grant child capture; conflicting positive parents retire descendants", () => {
  const r = rig();
  const activity = (id: string, kind: string, child: string) => ({ type: "subAgentActivity", id, kind, agentThreadId: child, agentPath: "/root/child" });
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: activity("finished", "completed", "foreign") });
  r.emit("item/started", { threadId: "root", turnId: "t1", item: { type: "collabAgentToolCall", id: "wait", tool: "wait", status: "inProgress",
    senderThreadId: "root", receiverThreadIds: ["foreign"], prompt: null, model: null, reasoningEffort: null, agentsStates: {} } });
  assert.equal(r.codec.diagnostics().authorizedThreads, 1);
  r.emit("item/started", { threadId: "root", turnId: "t1", item: activity("grant-child", "started", "child") });
  r.emit("item/started", { threadId: "root", turnId: "t1", item: activity("grant-other", "started", "other") });
  r.emit("item/started", { threadId: "child", turnId: "ct", item: activity("grant-grandchild", "started", "grandchild") });
  r.item("before", "owned", true, "ct", "child");
  r.emit("item/started", { threadId: "other", turnId: "ot", item: activity("conflict", "started", "child") });
  r.item("after", "must not serve", true, "ct", "child");
  assert.equal(r.codec.threadOwnership("child"), undefined); assert.equal(r.codec.threadOwnership("grandchild"), undefined);
  assert.equal(r.hub.snapshot(scope("child")).rows.length, 0);
  assert.equal(r.codec.diagnostics().authorizedThreads, 2);
  assert.ok(r.hub.snapshot(scope("other")).coverage.gaps.some(gap => gap.kind === "nativeGap"));
});

test("contradictory first native context revokes activity-granted child routing and every descendant", () => {
  const r = rig(); r.turn("root-turn"); r.item("root-answer", "root stays owned");
  const activity = (id: string, child: string) => ({ type: "subAgentActivity", id, kind: "started", agentThreadId: child, agentPath: "/root/child" });
  r.emit("item/started", { threadId: "root", turnId: "root-turn", item: activity("grant-child", "child") });
  r.emit("item/started", { threadId: "child", turnId: "child-turn", item: activity("grant-grandchild", "grandchild") });
  r.item("child-before", "previously routed child", true, "child-turn", "child");
  r.item("grandchild-before", "previously routed descendant", true, "grandchild-turn", "grandchild");
  const childGeneration = r.hub.snapshot(scope("child")).generation;
  const grandchildGeneration = r.hub.snapshot(scope("grandchild")).generation;
  assert.equal(r.codec.threadOwnership("child")?.nativeContext, undefined);

  r.emit("thread/started", { thread: meta("child", "foreign-context", "root") });
  assert.equal(r.codec.threadOwnership("child"), undefined);
  assert.equal(r.codec.threadOwnership("grandchild"), undefined);
  assert.equal(r.codec.diagnostics().authorizedThreads, 1);
  assert.notEqual(r.hub.snapshot(scope("child")).generation, childGeneration);
  assert.notEqual(r.hub.snapshot(scope("grandchild")).generation, grandchildGeneration);
  for (const thread of ["child", "grandchild"]) {
    assert.deepEqual(r.hub.snapshot(scope(thread)).rows, []);
    assert.ok(r.hub.snapshot(scope(thread)).coverage.gaps.some(gap => gap.id === "codex:changedLiveAncestry"));
    r.item("after-contradiction", "must never serve", true, "late-turn", thread);
    assert.deepEqual(r.hub.snapshot(scope(thread)).rows, []);
  }
  assert.deepEqual(r.hub.snapshot(scope()).activity, { turnId: "root-turn", state: "working" });
  assert.equal(text(r.row(codexRowId("root", "t1", "root-answer"))), "root stays owned");
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.id === "codex:unverifiedLiveAncestry"));
  assert.equal(r.codec.diagnostics().bufferedEvents, 0);
});

test("quarantined native and activity identities keep their admission slots across unique churn", () => {
  const r = rig({ maxThreads: 3 });
  const activity = (child: string) => ({ type: "subAgentActivity", id: `grant-${child}`, kind: "started", agentThreadId: child, agentPath: "/root/child" });
  r.emit("thread/started", { thread: meta("native-child", "native-child", "root") });
  r.emit("thread/started", { thread: meta("native-child", "foreign-context", "root") });
  r.emit("item/started", { threadId: "root", turnId: "t1", item: activity("activity-child") });
  r.emit("thread/started", { thread: meta("activity-child", "foreign-context", "root") });
  assert.equal(r.codec.diagnostics().authorizedThreads, 1);

  for (let index = 0; index < 8; index++) {
    const native = `replacement-native-${index}`, fromActivity = `replacement-activity-${index}`;
    r.emit("thread/started", { thread: meta(native, native, "root") });
    r.emit("item/started", { threadId: "root", turnId: "t1", item: activity(fromActivity) });
    assert.equal(r.codec.threadOwnership(native), undefined);
    assert.equal(r.codec.threadOwnership(fromActivity), undefined);
    assert.equal(r.codec.diagnostics().authorizedThreads, 1);
  }
  for (const retired of ["native-child", "activity-child"]) {
    r.emit("thread/started", { thread: meta(retired, retired, "root") });
    r.item("late", "must stay fenced", true, "late-turn", retired);
    assert.equal(r.codec.threadOwnership(retired), undefined);
    assert.deepEqual(r.hub.snapshot(scope(retired)).rows, []);
  }
  assert.equal(r.codec.diagnostics().bufferedEvents, 0);
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.id === "codex:threadCapacity"));
});

test("Codex unknown-thread queue and item capacity are actual bounds, not silent foreign delivery", () => {
  const r = rig({ maxBufferedEvents: 2, maxBufferedBytes: 2_048, maxItems: 1 });
  for (let index = 0; index < 8; index++) r.item(`foreign-${index}`, "never serve", true, "foreign-turn", `foreign-${index}`);
  assert.equal(r.codec.diagnostics().bufferedEvents, 2);
  assert.ok(r.codec.diagnostics().bufferedBytes <= 2_048);
  assert.equal(r.hub.snapshot(scope()).rows.length, 0);
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "nativeGap"));
  r.item("one", "accepted"); r.item("two", "capacity refused");
  assert.equal(r.codec.diagnostics().trackedItems, 1);
  assert.deepEqual(r.hub.snapshot(scope()).rows.map(row => text(row)), ["accepted"]);
});

test("Codex completed item and turn caches roll without imposing a lifetime message quota", () => {
  const r = rig({ maxItems: 2, maxTurns: 2 });
  r.turn("long");
  for (let index = 0; index < 12; index++) {
    r.item(`message-${index}`, "", false, "long");
    r.item(`message-${index}`, `Full message ${index}`, true, "long");
    assert.ok(r.codec.diagnostics().trackedItems <= 2);
  }
  assert.equal(text(r.row(codexRowId("root", "long", "message-11"))), "Full message 11");
  // A late suffix whose accumulator has left the cache cannot downgrade the
  // exact full body still owned by history. It cannot be appended to that body.
  r.emit("item/agentMessage/delta", { threadId: "root", turnId: "long", itemId: "message-0", delta: "late suffix" });
  assert.equal(text(r.row(codexRowId("root", "long", "message-0"))), "Full message 0");
  assert.equal(r.row(codexRowId("root", "long", "message-0")).body.kind, "complete");
  r.turn("long", "completed");
  for (let index = 0; index < 6; index++) {
    const turn = `next-${index}`; r.turn(turn); r.item(`final-${index}`, "Latest answer", true, turn); r.turn(turn, "completed");
    assert.deepEqual(r.hub.snapshot(scope()).activity, { turnId: turn, state: "idle" });
    assert.ok(r.codec.diagnostics().trackedItems <= 2);
  }
  const latest = r.hub.snapshot(scope());
  assert.ok(!latest.coverage.gaps.some(gap => ["codex:itemCapacity", "codex:turnCapacity"].includes(gap.id)));
});

test("Codex rejected chunk prevents nullable completion from certifying a broken body chain", () => {
  const r = rig({ maxTextBytes: 32 });
  const command = { type: "commandExecution", id: "shell", status: "inProgress", aggregatedOutput: null };
  r.emit("item/started", { threadId: "root", turnId: "t1", item: command });
  r.emit("item/commandExecution/outputDelta", { threadId: "root", turnId: "t1", itemId: "shell", delta: "prefix" });
  r.emit("item/commandExecution/outputDelta", { threadId: "root", turnId: "t1", itemId: "shell", delta: "x".repeat(33) });
  r.emit("item/completed", { threadId: "root", turnId: "t1", item: { ...command, status: "completed" } });
  const row = r.row(codexRowId("root", "t1", "shell"));
  assert.equal(text(row), "prefix"); assert.notEqual(row.body.kind, "complete");
  assert.ok(r.hub.snapshot(scope()).coverage.gaps.some(gap => gap.kind === "nativeGap" && gap.rowId === row.id));
});

test("Codex revert resets only its affected native history generation and fences old rows", () => {
  const r = rig(); r.item("root-item", "root");
  r.emit("thread/started", { thread: meta("child", "child", "root") });
  r.item("child-item", "child", true, "child-turn", "child");
  const rootGeneration = r.hub.snapshot(scope()).generation, childGeneration = r.hub.snapshot(scope("child")).generation;
  r.emit("thread/reverted", { threadId: "child" });
  assert.equal(r.hub.snapshot(scope()).generation, rootGeneration);
  assert.notEqual(r.hub.snapshot(scope("child")).generation, childGeneration);
  assert.equal(r.hub.snapshot(scope("child")).rows.length, 0);
  assert.equal(r.hub.snapshot(scope()).rows.length, 1);
});

test("Codex conflicting live ancestry retires that child before further native data is served", () => {
  const r = rig(); r.emit("thread/started", { thread: meta("child", "child", "root") });
  r.item("before", "known child", true, "child-turn", "child");
  r.emit("thread/started", { thread: meta("child", "child", "foreign") });
  r.item("after", "must not serve", true, "child-turn", "child");
  assert.equal(r.hub.snapshot(scope("child")).rows.length, 0);
  assert.equal(r.codec.diagnostics().authorizedThreads, 1);
});

test("Codex native child closure preserves captured history and leaves the root owner running", () => {
  const r = rig(); r.turn("root-turn"); r.emit("thread/started", { thread: meta("child", "child", "root") });
  r.item("before", "retained completed history", true, "child-turn", "child");
  r.emit("thread/closed", { threadId: "child" });
  r.item("after", "not a continuation after closure", true, "child-turn", "child");
  assert.deepEqual(r.hub.snapshot(scope()).activity, { turnId: "root-turn", state: "working" });
  assert.deepEqual(r.hub.snapshot(scope("child")).rows.map(row => text(row)), ["retained completed history"]);
  assert.equal(r.hub.snapshot(scope("child")).activity.state, "unknown");
});

test("Codex surfaces a rejected Host transaction and cannot continue from uncommitted codec state", () => {
  const hub = new HistoryHub(), failure = new Error("scripted capture unavailable");
  const codec = createCodexCodec({ origin, rootThreadId: "root", capture: {
    open: (scope, options) => hub.open(scope, options), reset: (scope, reason) => hub.reset(scope, reason),
    emit: () => { throw failure; },
  } });
  const event = { method: "item/completed", params: { threadId: "root", turnId: "t", item: { type: "agentMessage", id: "x", text: "not committed" } } };
  assert.throws(() => codec.observe(event), error => error === failure);
  assert.throws(() => codec.observe(event), error => error === failure);
  assert.equal(hub.snapshot(scope()).rows.length, 0);
});

test("Codex .44 supplied lineage proves full chain, accepts own/inherited context and rejects foreign/conflicting/cyclic claims", () => {
  const root = meta("root", "root-context"), parent = meta("parent", "parent", "root");
  assert.deepEqual(proveCodexLineage({ rootThreadId: "root", threadId: "child", metadata: [root, parent, meta("child", "parent", "parent")] }).ancestors, ["parent", "root"]);
  for (const child of [meta("child", "foreign-context", "parent"),
    { ...meta("child", "child", "parent"), source: { subagent: { thread_spawn: { parent_thread_id: "foreign" } } } },
    meta("child", "child", "child")])
    assert.throws(() => proveCodexLineage({ rootThreadId: "root", threadId: "child", metadata: [root, parent, child] }), /CODEX_LINEAGE_UNVERIFIED/);
  assert.throws(() => proveCodexLineage({ rootThreadId: "root", threadId: "child", metadata: [root, meta("parent", "child", "root"), meta("child", "child", "parent")] }), /CODEX_LINEAGE_UNVERIFIED/);
  const chain = [root, ...Array.from({ length: 32 }, (_, index) => meta(`c${index}`, `c${index}`, index ? `c${index - 1}` : "root"))];
  assert.equal(proveCodexLineage({ rootThreadId: "root", threadId: "c31", metadata: chain }).ancestors.length, 32);
  assert.throws(() => proveCodexLineage({ rootThreadId: "root", threadId: "c32", metadata: [...chain, meta("c32", "c32", "c31")] }), /CODEX_LINEAGE_UNVERIFIED/);
  for (const spelling of ["subagent", "subAgent"])
    assert.equal(proveCodexLineage({ rootThreadId: "root", threadId: "legacy", metadata: [root,
      { id: "legacy", sessionId: "legacy", source: { [spelling]: { thread_spawn: { parent_thread_id: "root" } } } }] }).threadId, "legacy");
});
