import assert from "node:assert/strict";
import test from "node:test";
import { CodexCodec, codexRowId } from "../../v8-history/src/native/codex/index.js";
import { HistoryHub } from "../../v8-history/src/host/history-owner.js";
import { scriptedHost, deferred } from "./fixture.js";
import type { NativeStart } from "../../v8-session/src/contracts/types.js";

const scope = { connection: "lineage", principal: "owner", host: "host", session: "logical" };
const input: NativeStart = { scope, generation: 1, operationId: "create", nativeSession: null, placement: "dedicated", policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } };
async function fixture() {
  const driver = scriptedHost("codex", { cwd: "/scripted" }), attached = await driver.controller.open(input, () => {}), root = attached.identity.run.nativeSession;
  const history = new HistoryHub(), historyScope = { kind: "codex" as const, origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: root, attachment: "capture" }, threadId: root };
  const codec = new CodexCodec({ origin: historyScope.origin, rootThreadId: root, capture: history });
  let serial = 0, responses = 0, historyGaps = 0;
  const detach = driver.controller.observe(capture => { if (capture.kind === "codex") codec.observe(capture.value); else if (capture.kind === "historyGap") historyGaps++; });
  const request = (threadId: string) => { const settled = deferred<void>(); driver.reverse({ id: ++serial, method: "item/commandExecution/requestApproval", token: {}, params: { threadId, turnId: "turn", itemId: `item-${serial}`, command: "fixture", availableDecisions: ["accept", "decline"] }, settled: settled.promise, respond: async () => { responses++; return { kind: "submitted" }; } }); return settled; };
  const activity = (parent: string, child: string, method = "item/started") => driver.notify(method, { threadId: parent, turnId: "turn", item: { id: `spawn-${child}`, type: "subAgentActivity", kind: "started", agentThreadId: child, agentPath: child } });
  const metadata = (id: string, parent: string, context = root) => driver.notify("thread/started", { thread: { id, sessionId: context, parentThreadId: parent, source: { subAgent: { thread_spawn: { parent_thread_id: parent } } } } });
  return { driver, attached, root, codec, history, historyScope, request, activity, metadata, get historyGaps() { return historyGaps; }, get responses() { return responses; }, owner: driver.controller.interactions(attached.identity.run), async close() { detach(); await attached.stopTree(); driver.controller.dispose(); } };
}

test("Codex pending valid ancestry preserves capture until its parent proof arrives without reporting observation loss", async () => {
  const f = await fixture(); try {
    f.driver.notify("turn/started", { threadId: f.root, turn: { id: "root-turn", status: "inProgress" } });
    const rootActivity = f.history.snapshot(f.historyScope).activity;
    f.metadata("grandchild", "child", "grandchild");
    f.driver.notify("turn/started", { threadId: "grandchild", turn: { id: "child-turn", status: "inProgress" } });
    f.driver.notify("item/completed", { threadId: "grandchild", turnId: "child-turn", item: { type: "agentMessage", id: "answer", text: "Retained out-of-order child output" } });
    assert.equal(f.historyGaps, 0, "Successfully queued proof is pending evidence, not a dropped observation");
    assert.equal(f.codec.threadOwnership("grandchild"), undefined);
    assert.equal(f.owner.current().baseline, "complete"); assert.equal(f.owner.current().items.length, 0);
    assert.deepEqual(f.history.snapshot(f.historyScope).activity, rootActivity);
    f.activity(f.root, "child");
    assert.ok(f.codec.threadOwnership("grandchild")); assert.equal(f.codec.diagnostics().bufferedEvents, 0);
    const rows = f.history.snapshot({ ...f.historyScope, threadId: "grandchild" }).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0]!.id, codexRowId("grandchild", "child-turn", "answer"));
    assert.deepEqual(rows[0]!.body, { kind: "complete", text: "Retained out-of-order child output", evidence: "nativeFullBody" });
    assert.equal(f.historyGaps, 0); assert.deepEqual(f.history.snapshot(f.historyScope).coverage.gaps, []);
    assert.deepEqual(f.history.snapshot(f.historyScope).activity, rootActivity);
    assert.equal(f.owner.current().baseline, "complete"); assert.equal(f.owner.current().items.length, 0);
    assert.equal(f.driver.counts.bodyReads, 0); assert.equal(f.driver.counts.sends, 0); assert.equal(f.driver.counts.resumes, 0);
  } finally { await f.close(); }
});

test("Codex pending ancestry overflow and invalid context still report observation loss without granting authority", async () => {
  for (const invalid of [false, true]) {
    const f = await fixture(); try {
      if (invalid) f.metadata("invalid-context", f.root, "foreign-context");
      else {
        for (let index = 0; index < 8; index++) f.metadata(`pending-${index}`, "missing-parent");
        assert.equal(f.historyGaps, 0);
        f.metadata("overflow", "missing-parent");
      }
      assert.ok(f.historyGaps > 0);
      assert.equal(f.owner.current().items.length, 0); assert.equal(f.responses, 0);
      assert.equal(f.codec.threadOwnership(invalid ? "invalid-context" : "overflow"), undefined);
    } finally { await f.close(); }
  }
});

test("Codex callback ancestry matches codec for buffered nested known-parent activity and validated thread-started descendants", async () => {
  const f = await fixture(); try {
    f.request("grandchild"); f.request("metadata-child");
    f.activity("child", "grandchild"); f.metadata("metadata-child", "grandchild");
    assert.equal(f.owner.current().items.length, 0); assert.equal(f.codec.threadOwnership("grandchild"), undefined);
    f.activity(f.root, "child");
    const prompts = f.owner.current().items.map(item => item.prompt);
    assert.deepEqual(new Set(prompts.map(prompt => prompt.owner.nativeAgent)), new Set(["grandchild", "metadata-child"]));
    for (const id of ["child", "grandchild", "metadata-child"]) assert.ok(f.codec.threadOwnership(id), `history and callbacks must share authority for ${id}`);
    assert.ok(prompts.every(prompt => prompt.owner.relation === "child"));
    const prompt = prompts.find(prompt => prompt.owner.nativeAgent === "metadata-child")!;
    await f.owner.invoke({ type: "answer", interactionId: prompt.id, choice: "decision:1", value: { type: "codex.command", decisionId: "decision:1" } }); assert.equal(f.responses, 1);
  } finally { await f.close(); }
});

test("Codex forged receiver/activity and conflicting context grant no callback authority; existing descendant response is fenced", async () => {
  const f = await fixture(); try {
    f.request("receiver"); f.request("forged");
    f.driver.notify("item/started", { threadId: f.root, turnId: "turn", item: { id: "collab", type: "collabAgentToolCall", senderThreadId: f.root, tool: "spawnAgent", receiverThreadIds: ["receiver"], agentsStates: {} } });
    f.activity(f.root, "forged", "turn/completed");
    const rejected = f.codec.diagnostics().rejected;
    f.driver.notify("item/started", { threadId: f.root, turnId: "turn", item: { id: "malformed-proof", type: "subAgentActivity", kind: "started", agentThreadId: "forged" } });
    assert.ok(f.codec.diagnostics().rejected > rejected, "callback-proof validation must not swallow the history decoder's own native-gap evidence");
    assert.equal(f.owner.current().items.length, 0);
    f.activity(f.root, "child"); f.activity("child", "descendant"); f.request("descendant");
    const prompt = f.owner.current().items[0]!.prompt; assert.equal(prompt.owner.nativeAgent, "descendant");
    f.metadata("child", f.root, "unrelated-context");
    assert.equal(f.codec.threadOwnership("child"), undefined); assert.equal(f.codec.threadOwnership("descendant"), undefined);
    await assert.rejects(f.owner.invoke({ type: "answer", interactionId: prompt.id, choice: "decision:1", value: { type: "codex.command", decisionId: "decision:1" } }));
    assert.equal(f.responses, 0); assert.equal(f.owner.current().baseline, "partial");
    f.request("descendant"); assert.equal(f.owner.current().items.length, 1, "contradicted native ownership cannot register a replacement callback");
  } finally { await f.close(); }
});

test("Codex native generation resets live ancestry and buffered originals; old exact settlement cannot clear replacement", async () => {
  const f = await fixture(); try {
    f.activity(f.root, "child"); const old = f.request("child"); assert.equal(f.owner.current().items.length, 1); await f.attached.stopTree();
    const next = await f.driver.controller.open({ ...input, generation: 2, operationId: "resume-new", nativeSession: f.root }, () => {}), owner = f.driver.controller.interactions(next.identity.run);
    f.request("child"); assert.equal(owner.current().items.length, 0, "prior-generation ancestry is not reusable");
    f.activity(f.root, "child"); const prompt = owner.current().items[0]!.prompt; old.resolve(); await Promise.resolve();
    assert.equal(owner.current().items[0]!.prompt.id, prompt.id); assert.equal(f.responses, 0); await next.stopTree();
  } finally { await f.close(); }
});

test("Codex closed live children release callback ancestry capacity while retained history keeps its independent 32-scope limit", async () => {
  const f = await fixture(); try {
    for (let index = 0; index < 40; index++) {
      const child = `sequential-${index}`; f.activity(f.root, child);
      const settled = f.request(child), prompt = f.owner.current().items.at(-1)!.prompt;
      assert.equal(prompt.owner.nativeAgent, child);
      assert.equal((await f.owner.invoke({ type: "answer", interactionId: prompt.id, choice: "decision:1", value: { type: "codex.command", decisionId: "decision:1" } })).status, "acknowledged");
      settled.resolve(); await Promise.resolve();
      f.driver.notify("thread/closed", { threadId: child });
    }
    assert.equal(f.responses, 40); assert.equal(f.owner.current().baseline, "complete");
    assert.equal(f.codec.diagnostics().authorizedThreads, 32, "retained history ownership was not deleted or expanded by live callback retirement");
    assert.ok(f.codec.threadOwnership("sequential-0")); assert.equal(f.codec.threadOwnership("sequential-39"), undefined);
    assert.ok(f.codec.diagnostics().rejected > 0, "the existing retained-history bound stays explicit");
  } finally { await f.close(); }
});

test("Codex closed ancestors remain for active descendants and old pending callbacks cannot use a fresh same-ID incarnation", async () => {
  const f = await fixture(); try {
    f.metadata("parent", f.root); f.metadata("leaf", "parent");
    f.driver.notify("thread/closed", { threadId: "parent" });
    for (let index = 0; index < 40; index++) { const id = `retired-${index}`; f.activity(f.root, id); f.driver.notify("thread/closed", { threadId: id }); }
    f.metadata("grandchild", "leaf", "parent"); const descendant = f.request("grandchild");
    const descendantPrompt = f.owner.current().items.at(-1)!.prompt; assert.equal(descendantPrompt.owner.nativeAgent, "grandchild");
    await f.owner.invoke({ type: "answer", interactionId: descendantPrompt.id, choice: "decision:1", value: { type: "codex.command", decisionId: "decision:1" } });
    descendant.resolve(); await Promise.resolve();

    f.activity(f.root, "reused-child"); const old = f.request("reused-child"), oldPrompt = f.owner.current().items.at(-1)!.prompt;
    f.driver.notify("thread/closed", { threadId: "reused-child" });
    assert.ok(f.owner.current().items.some(item => item.prompt.id === oldPrompt.id), "native closure cannot invent callback settlement");
    f.metadata("reused-child", f.root); const replacement = f.request("reused-child"), currentPrompt = f.owner.current().items.at(-1)!.prompt;
    assert.notEqual(currentPrompt.id, oldPrompt.id);
    const before = f.responses;
    await assert.rejects(f.owner.invoke({ type: "answer", interactionId: oldPrompt.id, choice: "decision:1", value: { type: "codex.command", decisionId: "decision:1" } }));
    assert.equal(f.responses, before, "an old callback cannot regain authority from a new node with the same native ID");
    old.resolve(); await Promise.resolve(); assert.ok(f.owner.current().items.some(item => item.prompt.id === currentPrompt.id));
    assert.equal((await f.owner.invoke({ type: "answer", interactionId: currentPrompt.id, choice: "decision:1", value: { type: "codex.command", decisionId: "decision:1" } })).status, "acknowledged");
    replacement.resolve(); await Promise.resolve();
  } finally { await f.close(); }
});
