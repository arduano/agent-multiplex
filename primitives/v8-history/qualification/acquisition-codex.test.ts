import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CodexScope, Row } from "../src/contracts/types.js";
import { createCodexHistoryPort, createCodexTimelineHistoryPort, type CodexItemsPage, type CodexItemsRequest, type CodexTimelineRequest } from "../src/native/codex/history.js";
import { codexErrorRow } from "../src/native/codex/errors.js";
import { codexRowId, createCodexCodec } from "../src/native/codex/index.js";
import { HistoryHub } from "../src/host/history-owner.js";
import { HistoryAcquisition } from "../src/acquisition/owner.js";

const scope: CodexScope = { kind: "codex", threadId: "root", origin: {
  connection: "scripted", principal: "owner", host: "host", nativeSession: "root", attachment: "attachment" } };
const entry = (item: unknown, turnId = "turn") => ({ turnId, item, startedAtMs: null, completedAtMs: null });
const page = (data: CodexItemsPage["data"], nextCursor: string | null = null): CodexItemsPage => ({ data, nextCursor, backwardsCursor: data.length ? "backwards-only" : null });
const input = (cursor: string | null = null, count = 16) => ({ scope, cursor, count });

test("Codex canonical timeline retains zero-item failed turns, complete items and one native paging frontier", async () => {
  const calls: CodexTimelineRequest[] = [], error = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded", additionalDetails: "not retained" };
  const port = createCodexTimelineHistoryPort({ scope, context: "attachment:timeline-v1", authorize: async () => {}, list: async request => {
    calls.push(request);
    return { data: request.cursor === null ? [
      { type: "item", position: 100, turnId: "good", item: { type: "agentMessage", id: "answer", text: "Completed native item", phase: "final_answer" } },
      { type: "turnCompleted", position: 101, turnId: "empty-failed", status: "failed", error },
    ] : [{ type: "item", position: 98, turnId: "older", item: { type: "userMessage", id: "question", content: [{ type: "text", text: "Older native prompt" }] } },
      { type: "turnCompleted", position: 99, turnId: "older", status: "completed", error: null }],
      nextCursor: request.cursor === null ? "earlier-window" : null, activeRealtimeSessionAtPageStart: null };
  } });
  const latest = await port.read(input(null, 2));
  assert.deepEqual(calls, [{ threadId: "root", cursor: null, limit: 2 }]);
  assert.deepEqual(latest.records.map(row => row.native.turnId), ["good", "empty-failed"]);
  assert.deepEqual(latest.records[0]!.body, { kind: "complete", text: "Completed native item", evidence: "nativeFullBody" });
  assert.equal(latest.records[0]!.native.completedAtMs, null, "Canonical ItemCompleted provenance does not fabricate a timestamp or depend on a turn boundary");
  assert.deepEqual(codexErrorRow(latest.records[1]!), { message: error.message, willRetry: false });
  assert.equal(JSON.stringify(latest).includes(error.additionalDetails), false);
  assert.equal(latest.nextCursor, "earlier-window");
  const older = await port.read(input(latest.nextCursor, 2));
  assert.equal(older.nextCursor, null); assert.equal(older.hasMore, false);
  assert.equal(older.records[0]!.native.turnId, "older");

  // Both acquisition orders preserve the same diagnostic identity and bytes.
  for (const readFirst of [false, true]) {
    const hub = new HistoryHub(), codec = createCodexCodec({ origin: scope.origin, rootThreadId: scope.threadId, capture: hub });
    const acquisition = new HistoryAcquisition(hub.owner(scope), port);
    const live = () => codec.observe({ method: "turn/completed", params: { threadId: "root", turn: { id: "empty-failed", status: "failed", error } } });
    if (!readFirst) live();
    const settled = await acquisition.baseline("E01", "error-baseline").wait(1000);
    assert.equal(settled.state, "value");
    if (readFirst) live();
    const notices = hub.snapshot(scope).rows.filter(row => codexErrorRow(row));
    assert.equal(notices.length, 1); assert.equal(notices[0]!.id, latest.records[1]!.id);
    assert.deepEqual(codexErrorRow(notices[0]!), { message: error.message, willRetry: false });
    assert.deepEqual(hub.snapshot(scope).coverage.gaps, []);
  }
});

test("Codex timeline rejects reordered entries and retires a stale read before native error publication", async () => {
  const turn = { type: "turnCompleted", position: 10, turnId: "failed", status: "failed", error: { message: "native error" } };
  const wrongOrder = createCodexTimelineHistoryPort({ scope, authorize: async () => {}, list: async () => ({ data: [turn, { ...turn, position: 9 }], nextCursor: null, activeRealtimeSessionAtPageStart: null }) });
  await assert.rejects(wrongOrder.read(input()), /CODEX_TIMELINE_ORDER/);
  const foreign = createCodexTimelineHistoryPort({ scope, authorize: async () => {}, list: async () => ({ data: [{ ...turn, threadId: "foreign" }], nextCursor: null, activeRealtimeSessionAtPageStart: null }) });
  await assert.rejects(foreign.read(input()), /CODEX_HISTORY_FOREIGN_THREAD/);
  let current = true, calls = 0;
  const stale = createCodexTimelineHistoryPort({ scope, authorize: async () => {}, assertCurrent: () => { assert.ok(current, "retired attachment"); }, list: async () => {
    calls++; current = false; return { data: [turn], nextCursor: null, activeRealtimeSessionAtPageStart: null };
  } });
  await assert.rejects(stale.read(input()), /retired attachment/); assert.equal(calls, 1);
});

test("Codex native timeline preserves tied rollout item and turn boundary order without accepting duplicate entries", async () => {
  const item = { type: "item", position: 7, turnId: "turn", item: { type: "agentMessage", id: "answer", text: "Native body at the same rollout ordinal" } };
  const completed = { type: "turnCompleted", position: 7, turnId: "turn", status: "failed", error: { message: "Native error at the same rollout ordinal" } };
  const port = (data: readonly unknown[]) => createCodexTimelineHistoryPort({ scope, authorize: async () => {}, list: async () => ({ data, nextCursor: null, activeRealtimeSessionAtPageStart: null }) });
  const page = await port([item, completed]).read(input());
  assert.deepEqual(page.records.map(row => row.body.kind !== "unavailable" && row.body.text), [item.item.text, completed.error.message]);
  assert.equal(page.records[0]!.lifecycle, "completed"); assert.equal(page.records[1]!.native.type, "turnError");
  await assert.rejects(port([item, item]).read(input()), /CODEX_TIMELINE_ORDER/);
  await assert.rejects(port([completed, item]).read(input()), /CODEX_TIMELINE_ORDER/);
  const unsupported = port([{ type: "realtime", position: 5, item: { id: "voice-a" } }, { type: "realtime", position: 6, item: { id: "voice-b" } }, completed]);
  const hub = new HistoryHub(); hub.open(scope);
  const result = await new HistoryAcquisition(hub.owner(scope), unsupported).baseline("E01", "native-page-with-realtime").wait(1000);
  assert.equal(result.state, "value");
  assert.deepEqual(hub.snapshot(scope).coverage.gaps, [{ id: "codex:history:unsupported:realtime", kind: "unsupported" }]);
  assert.deepEqual(codexErrorRow(hub.snapshot(scope).rows[0]!), { message: completed.error.message, willRetry: false });
});

test("Codex canonical timeline completion admits generated media without fabricating item timestamps", async () => {
  let captured = 0;
  const port = createCodexTimelineHistoryPort({ scope, authorize: async () => {}, media: ({ bytes }) => {
    captured++; assert.deepEqual(bytes, new TextEncoder().encode("scripted-image")); return { state: "available", artifactId: "owned-image" };
  }, list: async () => ({ data: [{ type: "item", position: 1, turnId: "turn", item: { type: "imageGeneration", id: "generated", status: "completed", result: btoa("scripted-image") } }], nextCursor: null, activeRealtimeSessionAtPageStart: null }) });
  const page = await port.read(input());
  assert.equal(captured, 1); assert.equal(page.records[0]!.native.completedAtMs, null);
  const media = page.records[0]!.native.media as readonly { state: string; artifactId: string }[];
  assert.equal(media[0]!.state, "available"); assert.equal(media[0]!.artifactId, "owned-image");
});

test("Codex native page preserves exact identities and direction without claiming an atomic/final assistant body", async () => {
  const calls: CodexItemsRequest[] = [];
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async request => {
    calls.push(request);
    return page([entry({ type: "agentMessage", id: "new", text: "current" }),
      entry({ type: "userMessage", id: "old", clientId: "original", content: [{ type: "text", text: "hello" }] })], "older");
  } });
  const result = await port.read(input());
  assert.deepEqual(calls, [{ threadId: "root", turnId: null, cursor: null, limit: 16, sortDirection: "desc" }]);
  assert.deepEqual(result.records.map(row => row.native.nativeItemId), ["old", "new"]);
  assert.equal(result.records[1]!.id, codexRowId("root", "turn", "new"));
  assert.deepEqual(result.records[1]!.body, { kind: "partial", text: "current", missing: ["final"] });
  assert.equal(result.records[1]!.lifecycle, "unknown");
  assert.equal(result.records[0]!.native.clientId, "original");
  assert.deepEqual(result.records[0]!.body, { kind: "complete", text: "hello", evidence: "nativeFullBody" });
  assert.equal(result.nextCursor, "older"); assert.equal(result.hasMore, true);
  assert.ok(!("backwardsCursor" in result)); assert.ok(!("generation" in result));
});

test("Codex command null, missing, empty, running and terminal bodies remain distinct", async () => {
  const items = [
    { type: "commandExecution", id: "null", status: "completed", aggregatedOutput: null },
    { type: "commandExecution", id: "missing", status: "completed" },
    { type: "commandExecution", id: "empty", status: "completed", aggregatedOutput: "" },
    { type: "commandExecution", id: "open", status: "inProgress", aggregatedOutput: "prefix" },
    { type: "commandExecution", id: "failed", status: "failed", aggregatedOutput: "failure" },
  ];
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => page(items.map(item => ({ ...entry(item),
    completedAtMs: item.status === "inProgress" ? null : 30 })).reverse()) });
  const result = await port.read(input());
  assert.deepEqual(result.records.map(record => record.lifecycle), ["completed", "completed", "completed", "running", "failed"]);
  assert.deepEqual(result.records.map(record => record.body), [
    { kind: "unavailable", reason: "nativeOmitted" }, { kind: "unavailable", reason: "notCaptured" },
    { kind: "complete", text: "", evidence: "nativeFullBody" }, { kind: "partial", text: "prefix", missing: ["final"] },
    { kind: "complete", text: "failure", evidence: "nativeFullBody" },
  ]);
});

test("Codex completed item envelopes converge from live capture to a cold read without granting activity", async () => {
  // Minimized shape from the owned .162.1 seeded run: both persisted message
  // items omit status, and their item_completed records carry completion times.
  // This does not parse the vendor journal or replay any native mutation.
  const entries = [
    { turnId: "turn", startedAtMs: 10, completedAtMs: 10,
      item: { type: "userMessage", id: "user", clientId: null, content: [{ type: "text", text: "owned question", text_elements: [] }] } },
    { turnId: "turn", startedAtMs: 20, completedAtMs: 21,
      item: { type: "agentMessage", id: "assistant", text: "owned answer", phase: "final_answer" } },
  ];
  const live = new HistoryHub(), codec = createCodexCodec({ origin: scope.origin, rootThreadId: scope.threadId, capture: live, knownStart: true });
  codec.observe({ method: "turn/started", params: { threadId: scope.threadId, turn: { id: "turn", status: "inProgress", items: [], itemsView: "notLoaded" } } });
  for (const entry of entries) {
    const params = { threadId: scope.threadId, ...entry };
    codec.observe({ method: "item/started", params });
    codec.observe({ method: "item/completed", params });
  }
  codec.observe({ method: "turn/completed", params: { threadId: scope.threadId, turn: { id: "turn", status: "completed", items: [], itemsView: "notLoaded" } } });
  const cold = new HistoryHub(); cold.open(scope);
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => page([...entries].reverse()) });
  const outcome = await new HistoryAcquisition(cold.owner(scope), port).baseline("E01", "owned-completed-items").wait(1000);
  assert.equal(outcome.state, "value"); if (outcome.state === "value") assert.equal(outcome.value.status, "ready");
  const content = (row: Row) => ({ id: row.id, kind: row.kind, lifecycle: row.lifecycle, body: row.body });
  assert.deepEqual(cold.snapshot(scope).rows.map(content), live.snapshot(scope).rows.map(content));
  assert.equal(cold.snapshot(scope).olderEdge.state, "end");
  assert.equal(cold.snapshot(scope).activity.state, "unknown");
  assert.equal(cold.snapshot(scope).coverage.knownStart, false);
});

test("Codex optional questions retain exact metadata through native pages and either live/read ordering", async () => {
  const questions = [{ title: "Which path?", options: ["A  preserved", "B"] }, { title: "Free response", options: null }, { title: "Invalid option", options: [false] }];
  const item = { type: "agentMessage", id: "optional", text: "Which path?\n- A  preserved\n- B\n\nFree response", delivery: "async", questions };
  const expected = [{ title: "Which path?", options: ["A  preserved", "B"] }, { title: "Free response", options: [] }];
  let calls = 0;
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => { calls++; return page([{ ...entry(item), completedAtMs: 21 }]); } });
  const batch = await port.read(input());
  assert.equal(batch.records[0]!.native.delivery, "async");
  assert.deepEqual(batch.records[0]!.native.questions, expected);
  assert.equal(batch.records[0]!.native.questionsOmitted, 1); assert.deepEqual(batch.gaps, []);
  for (const readFirst of [true, false]) {
    const hub = new HistoryHub(), codec = createCodexCodec({ origin: scope.origin, rootThreadId: scope.threadId, capture: hub });
    const acquire = async () => {
      const outcome = await new HistoryAcquisition(hub.owner(scope), port).baseline("E01", `optional-${readFirst}`).wait(1000);
      assert.equal(outcome.state, "value");
    };
    if (readFirst) await acquire();
    for (const method of ["item/started", "item/completed"]) codec.observe({ method, params: { threadId: scope.threadId, turnId: "turn", item } });
    if (!readFirst) await acquire();
    const row = hub.snapshot(scope).rows[0]!;
    assert.equal(row.native.delivery, "async"); assert.deepEqual(row.native.questions, expected); assert.equal(row.native.questionsOmitted, 1);
    assert.equal(row.body.kind, "complete"); assert.equal(row.body.text, item.text);
  }
  assert.equal(calls, 3);
  // Native pages must use the same lower metadata budget as live capture.
  const large = { ...item, id: "large", questions: Array.from({ length: 8 }, () => ({ title: "q".repeat(500), options: Array(3).fill("o".repeat(200)) })) };
  const largePort = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => page([{ ...entry(large), completedAtMs: 21 }]) });
  const historical = (await largePort.read(input())).records[0]!;
  const hub = new HistoryHub(), codec = createCodexCodec({ origin: scope.origin, rootThreadId: scope.threadId, capture: hub });
  codec.observe({ method: "item/completed", params: { threadId: scope.threadId, turnId: "turn", item: large } });
  const live = hub.snapshot(scope).rows[0]!;
  assert.deepEqual(historical.native.questions, live.native.questions); assert.equal(historical.native.questionsOmitted, live.native.questionsOmitted);
  assert.ok(typeof live.native.questionsOmitted === "number" && live.native.questionsOmitted > 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(historical.native)).byteLength <= 8_192);
  assert.deepEqual(historical.body, live.body); assert.deepEqual(hub.snapshot(scope).coverage.gaps, []);
});

test("Codex reasoning preserves channel/index and historical child activity has no live side effect", async () => {
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => page([
    entry({ type: "subAgentActivity", id: "activity", agentThreadId: "child", agentPath: "0/1", kind: "started" }),
    entry({ type: "reasoning", id: "reason", summary: ["a", "b"], content: ["c"] }),
  ]) });
  const result = await port.read(input());
  assert.deepEqual(result.records.map(row => [row.native.nativeItemId, row.native.channel, row.native.index]), [
    ["reason", "summary", 0], ["reason", "summary", 1], ["reason", "content", 0], ["activity", "body", undefined],
  ]);
  assert.equal(result.records[0]!.id, codexRowId("root", "turn", "reason", "summary", 0));
  assert.equal(result.records[3]!.native.agentThreadId, "child");
  assert.deepEqual(result.records[3]!.body, { kind: "unavailable", reason: "nativeOmitted" });
  assert.equal(result.records[3]!.lifecycle, "unknown");
});

test("Codex selected child authorization happens before each read and revoked attachment cannot return a late page", async () => {
  const child: CodexScope = { ...scope, threadId: "child" };
  let authorized = true, listCalls = 0, authorizationCalls = 0, current = true;
  const port = createCodexHistoryPort({ scope: child,
    authorize: async () => { authorizationCalls++; if (!authorized) throw new Error("lineage refused"); },
    assertCurrent: () => { if (!current) throw new Error("attachment retired"); },
    list: async request => { listCalls++; assert.equal(request.threadId, "child"); return page([]); },
  });
  await port.read({ scope: child, cursor: null, count: 1 });
  authorized = false;
  await assert.rejects(port.read({ scope: child, cursor: "old", count: 1 }), /lineage refused/);
  assert.equal(listCalls, 1); assert.equal(authorizationCalls, 2);
  const delayed = createCodexHistoryPort({ scope, authorize: async () => {}, assertCurrent: () => { if (!current) throw new Error("attachment retired"); },
    list: async () => { current = false; return page([]); } });
  await assert.rejects(delayed.read(input()), /attachment retired/);
});

test("Codex historical collaboration retains exact sender/receivers without child capture or invented bodies", async () => {
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => page([
    entry({ type: "collabAgentToolCall", id: "collab", senderThreadId: "root", receiverThreadIds: ["child"],
      tool: "spawnAgent", status: "completed", prompt: null, agentsStates: { child: { status: "running" } } }),
  ]) });
  const result = await port.read(input());
  assert.equal(result.records.length, 1); assert.deepEqual(result.records[0]!.native.receiverThreadIds, ["child"]);
  assert.deepEqual(result.records[0]!.body, { kind: "unavailable", reason: "nativeOmitted" });
  assert.equal(result.records[0]!.lifecycle, "completed"); assert.equal(result.gaps.length, 0);
});

test("Codex page rejects malformed identity, duplicate items, scope drift and nonadvancing cursors as whole results", async () => {
  const malformed: unknown[] = [
    page([entry({ type: "agentMessage", id: "x", text: "a" }), entry({ type: "agentMessage", id: "x", text: "b" })]),
    page([entry({ type: "agentMessage", id: "x", text: "a", threadId: "foreign" })]),
    { ...page([entry({ type: "agentMessage", id: "x", text: "a" })]), threadId: "foreign" },
    page([{ ...entry({ type: "agentMessage", id: "x", text: "a" }), threadId: "foreign" } as ReturnType<typeof entry>]),
    page([entry({ type: "agentMessage", id: "x", text: "a", turnId: "foreign" })]),
    page([{ ...entry({ type: "agentMessage", id: "x", text: "a" }), completedAtMs: -1 }]),
    page([{ ...entry({ type: "commandExecution", id: "x", status: "inProgress", aggregatedOutput: "prefix" }), completedAtMs: 1 }]),
    { data: [], nextCursor: "same", backwardsCursor: null },
    { data: [], nextCursor: null, backwardsCursor: "impossible" },
    page([entry({ type: "commandExecution", id: "x", status: "invalid", aggregatedOutput: "a" })]),
  ];
  for (const value of malformed) {
    const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => value as CodexItemsPage });
    await assert.rejects(port.read(input("same")));
  }
  let calls = 0;
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => { calls++; return page([]); } });
  await assert.rejects(port.read({ ...input(), scope: { ...scope, threadId: "foreign" } }), /FOREIGN_SCOPE/);
  assert.equal(calls, 0);
});

test("Codex unsupported types/media retain visible unavailable rows with bounded stable facts", async () => {
  const port = createCodexHistoryPort({ scope, authorize: async () => {}, list: async () => page([
    entry({ type: "futureNativeItem", id: "first" }), entry({ type: "futureNativeItem", id: "second" }),
    entry({ type: "userMessage", id: "media", content: [{ type: "image", url: "opaque-native-reference" }] }),
  ]) });
  const result = await port.read(input());
  assert.equal(result.records.length, 3); assert.equal(result.gaps.length, 2);
  assert.ok(result.records.every(row => row.body.kind === "unavailable" && row.body.reason === "unsupported"));
  assert.equal(result.records.find(row => row.native.nativeItemId === "media")!.kind, "user");
  assert.equal(result.nextCursor, null); assert.equal(result.hasMore, false);
});

test("Codex read-shaped fixture uses minimized actual .162.1 completion payloads without replaying callbacks", async () => {
  // The captured file contains real notifications. This test constructs an
  // item-list response shape from their item payloads; it does not claim that
  // the captured transport itself called items/list or supplied timestamps.
  const captured = JSON.parse(await readFile(new URL("../../qualification/fixtures/codex-live-20261023.json", import.meta.url), "utf8")) as {
    cases: { rootThreadId: string; events: { method: string; params: { threadId?: string; turnId?: string; item?: unknown } }[] }[];
  };
  const sample = captured.cases[0]!, selected = sample.events.filter(event => event.method === "item/completed" && event.params.threadId === sample.rootThreadId);
  const capturedScope: CodexScope = { ...scope, threadId: sample.rootThreadId,
    origin: { ...scope.origin, nativeSession: sample.rootThreadId } };
  const port = createCodexHistoryPort({ scope: capturedScope, authorize: async () => {},
    list: async () => page(selected.map(event => entry(event.params.item, event.params.turnId)).reverse()) });
  const result = await port.read({ scope: capturedScope, count: 32, cursor: null });
  assert.ok(result.records.some(row => row.native.type === "commandExecution" && row.body.kind === "complete" && row.body.text === "V8_CDX_FIRST\nV8_CDX_SECOND\n"));
  assert.ok(result.records.some(row => row.native.type === "agentMessage" && row.lifecycle === "unknown" && row.body.kind === "partial"));
  assert.equal(result.gaps.length, 0);
});
