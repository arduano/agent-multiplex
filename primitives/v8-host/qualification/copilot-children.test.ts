import assert from "node:assert/strict";
import test from "node:test";
import type { CopilotSessionConfig } from "../../v8-harness-copilot/src/controller.js";
import type { NativeStart, SessionScope } from "../../v8-session/src/contracts/types.js";
import { scriptedHost } from "./fixture.js";

const scope: SessionScope = { connection: "child-routing", principal: "owner", host: "copilot", session: "logical" };
const start = (generation = 1, nativeSession: string | null = null): NativeStart => ({ scope, generation, nativeSession, placement: "dedicated", operationId: `open-${generation}`, policy: { kind: "copilot", provider: "copilot-only", permissions: "manual" } });
const permission = (requestId: string) => ({ requestId, permissionRequest: { kind: "shell", fullCommandText: "scripted harmless command" } });
const latestConfig = (driver: ReturnType<typeof scriptedHost>): CopilotSessionConfig => driver.requests.findLast(row => row.method === "session.create" || row.method === "session.resume")!.params as CopilotSessionConfig;

test("a failed Copilot child retires only its active attribution marker; peers still fence root callbacks and exact permissions settle independently", async () => {
  const driver = scriptedHost("copilot", { cwd: "/scripted" }), owned = await driver.controller.open(start(), () => {});
  const run = owned.identity.run, owner = driver.controller.interactions(run), config = latestConfig(driver);
  try {
    driver.event("subagent.started", { toolCallId: "task-a" }, "child-a");
    driver.event("permission.requested", permission("child-permission"), "child-a");
    const original = owner.current().items[0]!.prompt; assert.equal(original.owner.nativeAgent, "child-a");
    driver.event("subagent.started", { toolCallId: "task-b" }, "child-b");
    driver.event("subagent.failed", { toolCallId: "task-a", error: "scripted failure" }, "child-a");
    assert.equal(owner.current().items[0]!.prompt.id, original.id, "Child failure does not invent native permission completion");
    void config.onUserInputRequest({ question: "Ambiguous while peer runs?", choices: ["yes"] }, { sessionId: run.nativeSession });
    assert.equal(owner.current().items.length, 1, "The other live child still prevents session-only callback attribution");
    driver.event("subagent.completed", { toolCallId: "task-b" }, "child-b");
    driver.event("subagent.started", { toolCallId: "resumed-task-a" }, "child-a");
    driver.event("subagent.completed", { toolCallId: "task-a" }, "child-a");
    driver.event("subagent.failed", { toolCallId: "task-a", error: "late old failure" }, "child-a");
    void config.onUserInputRequest({ question: "Old terminals cannot retire resumed child?", choices: ["yes"] }, { sessionId: run.nativeSession });
    assert.equal(owner.current().items.length, 1, "Delayed old terminal events preserve the newer task's active attribution fence");
    driver.event("subagent.failed", { toolCallId: "resumed-task-a", error: "new task failed" }, "child-a");
    const response = config.onUserInputRequest({ question: "Root after terminal children?", choices: ["yes"] }, { sessionId: run.nativeSession });
    const question = owner.current().items.find(item => item.prompt.type === "copilot.question")!.prompt;
    assert.equal(question.owner.nativeAgent, run.nativeSession); assert.equal(question.owner.relation, "root");
    const result = await owner.invoke({ type: "answer", interactionId: question.id, choice: "submit", value: { type: "copilot.question", answer: "yes", wasFreeform: false } });
    assert.equal(result.status, "acknowledged"); assert.deepEqual(await response, { answer: "yes", wasFreeform: false });
    driver.event("permission.completed", { requestId: "child-permission" }, "child-a");
    assert.ok(!owner.current().items.some(item => item.prompt.id === original.id)); assert.equal(driver.counts.replies, 0);
    assert.equal((await owner.invoke({ type: "answer", interactionId: original.id, choice: "reject", value: { type: "copilot.permission", kind: "reject" } })).status, "targetUnavailable");
  } finally { await owned.stopTree(); driver.controller.dispose(); }
});

test("conflicting Copilot agent markers cannot admit children or complete permissions, and session-only callbacks remain quarantined for that generation", async () => {
  const driver = scriptedHost("copilot", { cwd: "/scripted" }); let owned = await driver.controller.open(start(), () => {});
  let run = owned.identity.run, owner = driver.controller.interactions(run);
  try {
    driver.event("subagent.started", { toolCallId: "task-a" }, "child-a");
    driver.event("permission.requested", permission("original"), "child-a"); const original = owner.current().items[0]!.prompt;
    driver.event("permission.completed", { requestId: "original", agentId: "child-b" }, "child-a");
    assert.equal(owner.current().items[0]!.prompt.id, original.id); assert.equal(owner.current().baseline, "partial");
    driver.event("subagent.started", { toolCallId: "conflicting-task", agentId: "child-d" }, "child-c");
    driver.event("permission.requested", permission("unproved-child"), "child-c");
    assert.equal(owner.current().items.length, 1, "Conflicting start did not grant either claimed child identity");
    driver.event("subagent.failed", { error: "missing exact task" }, "child-a");
    void latestConfig(driver).onUserInputRequest({ question: "Terminal without task identity?", choices: ["yes"] }, { sessionId: run.nativeSession });
    assert.equal(owner.current().items.length, 1, "Missing terminal task identity does not clear active attribution");
    driver.event("subagent.completed", { toolCallId: "task-a" }, "child-a");
    void latestConfig(driver).onUserInputRequest({ question: "Must stay unowned", choices: ["yes"] }, { sessionId: run.nativeSession });
    assert.equal(owner.current().items.length, 1, "An unadmitted ambiguous child cannot be mistaken for no children/root ownership");
    driver.event("permission.completed", { requestId: "original" }, "child-a"); assert.equal(owner.current().items.length, 0);
    driver.event("permission.requested", permission("exact-root"));
    assert.equal(owner.current().items[0]!.prompt.owner.nativeAgent, run.nativeSession, "Exact native permission identity remains usable despite a callback attribution gap");
    assert.equal(driver.counts.replies, 0);
    await owned.stopTree(); owned = await driver.controller.open(start(2, run.nativeSession), () => {}); run = owned.identity.run; owner = driver.controller.interactions(run);
    const response = latestConfig(driver).onUserInputRequest({ question: "New native owner?", choices: ["yes"] }, { sessionId: run.nativeSession });
    const current = owner.current().items[0]!.prompt; assert.equal(current.type, "copilot.question");
    await owner.invoke({ type: "answer", interactionId: current.id, choice: "submit", value: { type: "copilot.question", answer: "yes", wasFreeform: false } });
    assert.deepEqual(await response, { answer: "yes", wasFreeform: false });
  } finally { await owned.stopTree(); driver.controller.dispose(); }
});
