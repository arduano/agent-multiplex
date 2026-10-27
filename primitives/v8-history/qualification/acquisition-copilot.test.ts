import assert from "node:assert/strict";
import test from "node:test";
import type { CopilotScope, Origin } from "../src/contracts/types.js";
import { PrimitiveError } from "../src/contracts/validation.js";
import { createCopilotHistoryPort, type CopilotNativeHistoryRequest } from "../src/native/copilot/history.js";

const origin: Origin = { connection: "fixture", principal: "reader", host: "host", nativeSession: "native-session", attachment: "capture" };
const root: CopilotScope = { kind: "copilot", origin, agentId: null };
const event = (id: string, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, type, data, parentId: null, timestamp: "2026-10-23T00:00:00Z", ...extra });
const page = (events: unknown[], hasMore = false, cursor = "next", cursorStatus = "ok") => ({ events, cursor, hasMore, cursorStatus });
const code = (value: string) => (error: unknown): boolean => error instanceof PrimitiveError && error.code === value;
const key = (kind: string, value: string) => JSON.stringify(["copilot", kind, value]);

test("Copilot active native port keeps chronological payload and exact original message identity", async () => {
  const calls: CopilotNativeHistoryRequest[] = [];
  const port = createCopilotHistoryPort({ scope: root, mode: "active", read: async request => {
    calls.push(request); return page([
      event("event-user", "user.message", { messageId: "logical-original", content: "same" }),
      event("event-answer", "assistant.message", { messageId: "answer", content: "response", originatingMessageId: "logical-original" }),
    ], true, "older");
  } });
  const result = await port.read({ scope: root, cursor: null, count: 4 });
  assert.deepEqual(calls, [{ max: 4, direction: "backward", includeEphemeral: false, agentScope: "primary" }]);
  assert.deepEqual(result.records.map(row => row.id), [key("user", "logical-original"), key("assistant", "answer")]);
  assert.equal(result.records[1]!.native.originatingMessageId, "logical-original");
  assert.equal(result.nextCursor, "older"); assert.equal(result.hasMore, true);
  assert.equal(Object.hasOwn(result.records[0]!, "version"), false);
  assert.equal(Object.hasOwn(result, "activity"), false); assert.equal(Object.isFrozen(result.records), true);
});

test("Copilot exact child filters never invent agent/tool aliases", async () => {
  const child: CopilotScope = { ...root, agentId: "child" }, calls: CopilotNativeHistoryRequest[] = [];
  const port = createCopilotHistoryPort({ scope: child, mode: "active", read: async request => {
    calls.push(request); return page([event("child-answer", "assistant.message", { messageId: "m", content: "child" }, { agentId: "child" })]);
  } });
  assert.equal((await port.read({ scope: child, cursor: "bound", count: 2 })).records[0]!.native.agentId, "child");
  assert.deepEqual(calls[0], { cursor: "bound", max: 2, direction: "backward", includeEphemeral: false, agentIds: ["child"] });
  const legacy: CopilotScope = { ...root, agentId: null, legacyParentToolCallId: "child" };
  const mismatch = createCopilotHistoryPort({ scope: legacy, mode: "active", read: async () => page([
    event("not-a-proved-alias", "assistant.message", { messageId: "m", content: "wrong domain" }, { agentId: "child" }),
  ]) });
  await assert.rejects(mismatch.read({ scope: legacy, cursor: null, count: 1 }), code("COPILOT_HISTORY_FOREIGN_OWNER"));
  const exact = createCopilotHistoryPort({ scope: legacy, mode: "active", read: async () => page([
    event("legacy", "assistant.message", { messageId: "m", content: "legacy", parentToolCallId: "child" }),
  ]) });
  assert.equal((await exact.read({ scope: legacy, cursor: null, count: 1 })).records[0]!.native.parentToolCallId, "child");
});

test("Copilot persisted filtering consumes one native record and preserves an empty continuing page", async () => {
  const calls: CopilotNativeHistoryRequest[] = [];
  const port = createCopilotHistoryPort({ scope: root, mode: "persisted", read: async request => {
    calls.push(request); return page([event("other-agent", "assistant.message", { messageId: "child-message", content: "child" }, { agentId: "child" })], true, "single-use-next");
  } });
  const result = await port.read({ scope: root, cursor: "single-use-input", count: 8 });
  assert.deepEqual(calls, [{ sessionId: "native-session", cursor: "single-use-input", max: 1, direction: "backward" }]);
  assert.deepEqual(result.records, []); assert.equal(result.hasMore, true); assert.equal(result.nextCursor, "single-use-next");
  assert.equal(Object.hasOwn(result, "snapshot"), false);
});

test("Copilot expired active replacement windows and persisted terminal pages cannot look complete", async () => {
  for (const mode of ["active", "persisted"] as const) {
    const port = createCopilotHistoryPort({ scope: root, mode, read: async () => page(mode === "active"
      ? [event("overlap", "assistant.message", { messageId: "old", content: "overlapping replacement" })] : [], false, "boundary", "expired") });
    const result = await port.read({ scope: root, cursor: "expired-input", count: 2 });
    assert.equal(result.status, "expired"); assert.deepEqual(result.records, []); assert.equal(result.nextCursor, null);
    assert.equal(result.gaps[0]!.kind, "nativeGap");
  }
  const malformed = createCopilotHistoryPort({ scope: root, mode: "persisted", read: async () => page([], true, "replacement", "expired") });
  await assert.rejects(malformed.read({ scope: root, cursor: "input", count: 2 }), code("COPILOT_PERSISTED_EXPIRED_PAGE"));
  const empty = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([], false, "") });
  assert.equal((await empty.read({ scope: root, cursor: null, count: 2 })).status, "ok");
});

test("Copilot historical tools preserve absent output and native lifecycle without changing current activity", async () => {
  const port = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([
    event("start", "tool.execution_start", { toolCallId: "t", toolName: "shell", arguments: { command: "native input" } }),
    event("partial", "tool.execution_partial_result", { toolCallId: "t", partialOutput: "captured prefix" }),
    event("end", "tool.execution_complete", { toolCallId: "t", success: true, result: null }),
    event("empty", "tool.execution_complete", { toolCallId: "empty", success: true, result: { content: "" } }),
    event("omitted", "tool.execution_complete", { toolCallId: "omitted", success: false, result: null }),
    event("old-idle", "session.idle", {}), event("old-start", "assistant.turn_start", { turnId: "old" }),
    event("rewind", "session.snapshot_rewind", {}),
  ]) });
  const result = await port.read({ scope: root, cursor: null, count: 8 });
  assert.deepEqual(result.records[0]!.body, { kind: "partial", text: "captured prefix", missing: ["final"] });
  assert.equal(result.records[0]!.lifecycle, "completed");
  assert.deepEqual(result.records[0]!.native.arguments, { command: "native input" });
  assert.deepEqual(result.records[1]!.body, { kind: "complete", text: "", evidence: "nativeFullBody" });
  assert.deepEqual(result.records[2]!.body, { kind: "unavailable", reason: "nativeOmitted" });
  assert.equal(result.records[2]!.lifecycle, "failed");
  assert.equal(result.gaps.filter(gap => gap.kind === "missingFinal").length, 2);
  assert.ok(result.gaps.some(gap => gap.kind === "nativeGap"));
  assert.equal(Object.hasOwn(result, "activity"), false); assert.equal(result.records.length, 3);
});

test("Copilot history event IDs deduplicate exact delivery and reject changed semantic payload", async () => {
  const original = event("same-event", "assistant.message", { messageId: "m", content: "body" });
  const make = (events: unknown[]) => createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page(events) });
  assert.equal((await make([original, original]).read({ scope: root, cursor: null, count: 2 })).records.length, 1);
  await assert.rejects(make([original, { ...original, data: { messageId: "m", content: "changed" } }]).read({ scope: root, cursor: null, count: 2 }), code("COPILOT_HISTORY_EVENT_CONFLICT"));
  const repeatedUnknown = await make([event("u1", "assistant.future", {}), event("u2", "assistant.future", {})]).read({ scope: root, cursor: null, count: 2 });
  assert.equal(repeatedUnknown.gaps.length, 1);
  const noLogical = await make([event("native-event", "user.message", { content: "saved user text" })]).read({ scope: root, cursor: null, count: 1 });
  assert.equal(noLogical.records[0]!.id, key("user", "native-event"));
  assert.equal(Object.hasOwn(noLogical.records[0]!.native, "messageId"), false); assert.equal(noLogical.gaps[0]!.kind, "identity");
});

test("Copilot distinct native events cannot replace immutable logical content, origin, kind or terminal state", async () => {
  const assistant = (id: string, content: string, originatingMessageId = "original") => event(id, "assistant.message", { messageId: "m", content, originatingMessageId });
  const tool = (id: string, content: string | null, success = true) => event(id, "tool.execution_complete", { toolCallId: "t", success, result: content === null ? null : { content } });
  let published = 0;
  const cases = [
    { events: [assistant("a1", "first"), assistant("a2", "changed")], error: "COPILOT_HISTORY_BODY_CONFLICT" },
    { events: [assistant("a1", "same"), assistant("a2", "same", "another-original")], error: "COPILOT_HISTORY_ORIGINAL_CONFLICT" },
    { events: [assistant("a1", "same"), event("u1", "user.message", { messageId: "m", content: "same" })], error: "COPILOT_HISTORY_KIND_CONFLICT" },
    { events: [tool("t1", "first"), tool("t2", "changed")], error: "COPILOT_HISTORY_BODY_CONFLICT" },
    { events: [tool("t1", "same"), tool("t2", "same", false)], error: "COPILOT_HISTORY_TERMINAL_CONFLICT" },
  ];
  for (const { events, error } of cases) {
    const port = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page(events) });
    await assert.rejects(port.read({ scope: root, cursor: null, count: 2 }).then(value => { published++; return value; }), code(error));
  }
  assert.equal(published, 0);
  const allowed = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([
    event("start", "tool.execution_start", { toolCallId: "t", toolName: "shell", arguments: { command: "input" } }),
    tool("end", "complete"), event("late-partial", "tool.execution_partial_result", { toolCallId: "t", partialOutput: "suffix" }),
    tool("missing-replay", null), tool("same-terminal", "complete"),
  ]) });
  const result = await allowed.read({ scope: root, cursor: null, count: 5 });
  assert.deepEqual(result.records[0]!.body, { kind: "complete", text: "complete", evidence: "nativeFullBody" });
  assert.equal(result.records[0]!.lifecycle, "completed"); assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.records[0]!.native.arguments, { command: "input" });
});

test("Copilot port retains bounded event meaning across pages and commits only whole valid batches", async () => {
  const answer = (id: string, messageId: string, content: string) => event(id, "assistant.message", { messageId, content });
  const original = answer("fixed-event", "original-message", "original body");
  let response = page([original]), published = 0;
  const port = createCopilotHistoryPort({ scope: root, mode: "active", limits: { maxRetainedEvents: 2 }, read: async () => response });
  const read = () => port.read({ scope: root, cursor: null, count: 2 }).then(value => { published++; return value; });
  const first = await read();
  response = page([answer("staged-event", "new-message", "uncommitted"), answer("fixed-event", "changed-message", "original body")]);
  await assert.rejects(read(), code("COPILOT_HISTORY_EVENT_CONFLICT")); assert.equal(published, 1);
  // The first event of the rejected page was staged, never retained.
  response = page([answer("staged-event", "new-message", "valid fresh body")]);
  assert.equal((await read()).records[0]!.body.kind, "complete");
  response = page([answer("fixed-event", "original-message", "changed body")]);
  await assert.rejects(read(), code("COPILOT_HISTORY_EVENT_CONFLICT")); assert.equal(published, 2);
  response = page([original]); assert.deepEqual(await read(), first);
  assert.deepEqual(first.records[0]!.body, { kind: "complete", text: "original body", evidence: "nativeFullBody" });
  response = page([answer("over-capacity", "third-message", "body")]);
  await assert.rejects(read(), code("COPILOT_HISTORY_IDENTITY_CAPACITY"));
  // Capacity exhaustion never evicts the original identity fence.
  response = page([answer("fixed-event", "another-message", "original body")]);
  await assert.rejects(read(), code("COPILOT_HISTORY_EVENT_CONFLICT"));
  const bytes = createCopilotHistoryPort({ scope: root, mode: "active", limits: { maxRetainedBytes: 16 }, read: async () => page([original]) });
  await assert.rejects(bytes.read({ scope: root, cursor: null, count: 1 }), code("COPILOT_HISTORY_IDENTITY_CAPACITY"));
});

test("Copilot primary nested lifecycle proves a read scope without adopting a live child or root-promoting its body", async () => {
  const port = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([
    event("nested-start", "subagent.started", { toolCallId: "child-task", parentId: "parent-task" }, { agentId: "nested-child" }),
    event("root-start", "subagent.started", { toolCallId: "root-task" }),
    event("finished", "subagent.completed", { toolCallId: "root-task" }),
    event("missing-parent", "subagent.completed", { toolCallId: "unknown-parent" }),
    event("assistant", "assistant.message", { messageId: "root-message", content: "root" }),
  ]) });
  const result = await port.read({ scope: root, cursor: null, count: 5 });
  assert.equal(result.records.length, 2); assert.equal(result.records[0]!.kind, "delegation");
  assert.equal(result.records[0]!.lifecycle, "unknown"); assert.equal(result.records[0]!.body.kind, "unavailable");
  assert.equal(Object.hasOwn(result.records[0]!.native, "agentId"), false); assert.equal(result.scope, port.scope);
  assert.deepEqual(result.discoveredScopes, [{ scope: { kind: "copilot", origin, agentId: "nested-child" } }]);
  assert.ok(result.gaps.some(gap => gap.kind === "identity"));
  const foreign = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([
    event("child", "assistant.message", { messageId: "m", content: "foreign" }, { agentId: "child" }),
  ]) });
  await assert.rejects(foreign.read({ scope: root, cursor: null, count: 1 }), code("COPILOT_HISTORY_FOREIGN_OWNER"));
});

test("Copilot native history bounds and binding failures publish no partial page", async () => {
  let reads = 0;
  const scope = { ...root, origin: { ...root.origin } };
  const port = createCopilotHistoryPort({ scope, mode: "active", limits: { maxBodyChars: 4 }, read: async () => {
    reads++; return page([event("too-big", "assistant.message", { messageId: "m", content: "12345" })]);
  } });
  scope.origin = { ...scope.origin, attachment: "caller-mutated" };
  await assert.rejects(port.read({ scope, cursor: null, count: 1 }), code("FOREIGN_PAGE_SCOPE")); assert.equal(reads, 0);
  await assert.rejects(port.read({ scope: root, cursor: null, count: 1 }), code("PAGE_TOO_LARGE")); assert.equal(reads, 1);
  const sameCursor = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([], true, "input") });
  await assert.rejects(sameCursor.read({ scope: root, cursor: "input", count: 1 }), code("NONADVANCING_CURSOR"));
  const ephemeral = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([
    event("not-durable", "tool.shell_output", { toolCallId: "t", text: "cannot be recovered", sequence: 0 }, { ephemeral: true }),
  ]) });
  await assert.rejects(ephemeral.read({ scope: root, cursor: null, count: 1 }), code("COPILOT_HISTORY_EPHEMERAL"));
});

test("Copilot system instructions remain uninspected while selected conversation bodies are admitted", async () => {
  let reads = 0; const data = { role: "system" };
  for (const name of ["content", "contentBlocks", "metadata"]) Object.defineProperty(data, name, { enumerable: true, get() { reads++; throw new Error("private instruction"); } });
  const port = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([
    event("system", "system.message", data), event("public", "assistant.message", { messageId: "m", content: "public answer" }),
  ]) });
  const result = await port.read({ scope: root, cursor: null, count: 2 });
  assert.equal(reads, 0); assert.equal(result.records.length, 1); assert.deepEqual(result.gaps, []);
  const wrongRole = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([
    event("wrong-role", "system.message", { role: "user", content: "human content cannot be silently discarded" }),
  ]) });
  await assert.rejects(wrongRole.read({ scope: root, cursor: null, count: 1 }), code("COPILOT_HISTORY_SYSTEM_ROLE"));
  const accessor = {}; Object.defineProperty(accessor, "role", { enumerable: true, get() { reads++; return "system"; } });
  const wrongRoleAccessor = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([event("accessor", "system.message", accessor)]) });
  await assert.rejects(wrongRoleAccessor.read({ scope: root, cursor: null, count: 1 }), code("COPILOT_HISTORY_ACCESSOR"));
  assert.equal(reads, 0);
  const diagnostic = {}; Object.defineProperty(diagnostic, "privatePayload", { enumerable: true, get() { reads++; throw new Error("unclassified private diagnostic"); } });
  const unknown = createCopilotHistoryPort({ scope: root, mode: "active", read: async () => page([event("unknown", "model.unknown_diagnostic", diagnostic)]) });
  assert.equal((await unknown.read({ scope: root, cursor: null, count: 1 })).gaps.length, 1); assert.equal(reads, 0);
});
