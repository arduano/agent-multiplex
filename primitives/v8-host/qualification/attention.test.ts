import assert from "node:assert/strict";
import test from "node:test";
import type { AttentionSignal, NativeStart } from "../../v8-session/src/contracts/types.js";
import type { RuntimeEvent } from "../../v8-runtime/src/contracts.js";
import { scriptedHost } from "./fixture.js";

const scope = { connection: "account", principal: "owner", host: "host", session: "logical" };
const input = (kind: "codex" | "copilot"): NativeStart => ({ scope, generation: 1, placement: "dedicated", operationId: "create", nativeSession: null,
  policy: kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" } });
const collect = (values: AttentionSignal[]) => (event: RuntimeEvent): void => { if (event.type === "native" && event.event.type === "attention") values.push(event.event.attention); };

test("Codex attention uses exact root turn outcome, positive retry recovery and explicit gap evidence", async () => {
  const driver = scriptedHost("codex", { cwd: "/scripted" }), signals: AttentionSignal[] = [];
  const owned = await driver.controller.open(input("codex"), collect(signals)), threadId = owned.identity.run.nativeSession;
  const notify = (method: string, data: Record<string, unknown> = {}) => driver.notify(method, { threadId, turnId: "turn-1", ...data });
  const state = () => signals.at(-1)?.state;
  try {
    assert.equal(signals.length, 0, "fresh idle is not completed work");
    notify("turn/started", { turn: { id: "turn-1" } }); assert.equal(state(), "working");
    notify("error", { willRetry: true, error: { message: "private diagnostic" } }); assert.equal(state(), "retrying");
    notify("thread/status/changed", { status: { type: "idle" } }); assert.equal(state(), "retrying", "independent thread idle cannot settle an active turn");
    const count = signals.length;
    notify("item/commandExecution/outputDelta", { delta: "old tool output" });
    notify("item/completed", { item: { id: "old-tool", type: "commandExecution", status: "completed" } });
    notify("error", { threadId: "child", willRetry: false });
    notify("turn/completed", { turn: { id: "older-turn", status: "completed" } });
    assert.equal(signals.length, count, "tool results, children and stale turns cannot settle/recover the root");
    notify("item/agentMessage/delta", { delta: "actual model progress" }); assert.equal(state(), "working");
    notify("error", { willRetry: true });
    notify("item/started", { item: { id: "new-tool", type: "mcpToolCall", status: "inProgress" } }); assert.equal(state(), "working");
    notify("turn/completed", { turn: { id: "turn-1", status: "failed" } }); assert.equal(state(), "error");
    notify("thread/status/changed", { status: { type: "idle" } }); assert.equal(state(), "error", "idle cannot clear native failure");
    const terminalCount = signals.length; notify("turn/started", { turn: { id: "turn-1" } });
    assert.equal(signals.length, terminalCount, "a duplicate old start cannot revive its terminal turn");
    notify("turn/started", { turn: { id: "turn-2" } });
    notify("turn/completed", { turn: { id: "turn-2", status: "interrupted" } }); assert.equal(state(), "interrupted");
    notify("turn/started", { turn: { id: "turn-3" } });
    notify("turn/completed", { turn: { id: "turn-3", status: "inProgress" } }); assert.equal(state(), "unknown", "contradictory terminal is not success");
    notify("turn/completed", { turn: { id: "turn-3", status: "completed" } }); assert.equal(state(), "finished", "actual matching native outcome can resolve the observation");
    const beforeStop = signals.length; await owned.stopTree(); assert.equal(signals.length, beforeStop, "Stop does not invent an outcome");
    assert.equal(JSON.stringify(signals).includes("private diagnostic"), false);
  } finally { await owned.stopTree(); driver.controller.dispose(); }
});

test("Codex recent terminal proof rejects older starts without replacing newer work or imposing a lifetime turn quota", async () => {
  const driver = scriptedHost("codex", { cwd: "/scripted" }), signals: AttentionSignal[] = [];
  const owned = await driver.controller.open(input("codex"), collect(signals)), threadId = owned.identity.run.nativeSession;
  const start = (id: string) => driver.notify("turn/started", { threadId, turn: { id } });
  const complete = (id: string) => driver.notify("turn/completed", { threadId, turn: { id, status: "completed" } });
  try {
    start("A"); complete("A"); start("B");
    const activeCount = signals.length; start("A");
    assert.equal(signals.length, activeCount); assert.equal(signals.at(-1)?.cause.id, "B");
    complete("B"); const settledCount = signals.length; start("A");
    assert.equal(signals.length, settledCount); assert.equal(signals.at(-1)?.state, "finished");
    for (let index = 0; index < 300; index++) { start(`turn-${index}`); complete(`turn-${index}`); }
    const recentCount = signals.length; start("turn-299"); start("turn-45");
    assert.equal(signals.length, recentCount, "the most recent 256 positive terminal IDs remain protected");
    start("C"); assert.equal(signals.at(-1)?.cause.id, "C"); assert.equal(signals.at(-1)?.state, "working");
    complete("C"); assert.equal(signals.at(-1)?.state, "finished");
  } finally { await owned.stopTree(); driver.controller.dispose(); }
});

test("Copilot keeps root cycles, full idle, background children, errors, cancellation and gaps distinct", async () => {
  const driver = scriptedHost("copilot", { cwd: "/scripted" }), signals: AttentionSignal[] = [];
  const owned = await driver.controller.open(input("copilot"), collect(signals));
  const state = () => signals.at(-1)?.state;
  const start = () => driver.event("assistant.turn_start", { turnId: "0" });
  try {
    driver.event("session.error", { errorType: "configuration", message: "unrelated idle diagnostic" }); assert.equal(signals.length, 0);
    start(); const first = signals.at(-1)!.cause.id;
    driver.event("subagent.started", { toolCallId: "child-task" }, "child");
    driver.event("assistant.turn_end", { turnId: "0" }); assert.equal(state(), "working");
    driver.event("assistant.idle", {}); assert.equal(state(), "background");
    driver.event("session.error", { errorType: "query", message: "child error" }, "child"); assert.equal(state(), "background");
    driver.event("subagent.completed", { toolCallId: "child-task", cancelled: true }, "child"); assert.equal(state(), "background", "cancelled child teardown is not root completion");
    driver.event("session.idle", {}); assert.equal(state(), "finished");
    start(); assert.equal(state(), "working"); assert.notEqual(signals.at(-1)!.cause.id, first, "reused native turnId has a new native event identity");
    driver.event("assistant.idle", {}); assert.equal(state(), "working", "model idle with no proved child count is not full completion");
    driver.event("model.call_failure", { retryAttempt: 2 }); assert.equal(state(), "working", "failed attempt does not promise retry");
    driver.event("session.error", { errorType: "query", message: "root native error" }); assert.equal(state(), "error");
    const error = signals.at(-1); driver.event("session.idle", {}); assert.deepEqual(signals.at(-1), error, "idle cannot erase a native error");
    start(); driver.event("assistant.idle", { aborted: true }); assert.equal(state(), "interrupted");
    const interrupted = signals.at(-1); driver.event("session.idle", {}); assert.deepEqual(signals.at(-1), interrupted);
    start(); driver.event("subagent.started", { toolCallId: "next-child" }, "child");
    driver.event("session.idle", {}); assert.equal(state(), "unknown", "full-idle contradicting an exact live child stays unknown");
    driver.event("subagent.completed", { toolCallId: "next-child" }, "child");
    driver.event("session.idle", {}); assert.equal(state(), "unknown", "later idle cannot fill the missing successful outcome");
    start(); driver.event("session.idle", {}); assert.equal(state(), "finished", "a new observed cycle can settle normally");
    start(); driver.event("assistant.message_delta", { deltaContent: "x".repeat(70000) });
    assert.equal(state(), "unknown", "actual common capture-size loss invalidates that root cycle");
    driver.event("session.idle", {}); assert.equal(state(), "unknown", "native idle cannot fill a dropped native event");
    start(); driver.event("session.idle", {}); assert.equal(state(), "finished", "new positive root cycle rebases attention without clearing callback gap custody");
    assert.equal(signals.some(value => value.state === "retrying"), false);
  } finally { await owned.stopTree(); driver.controller.dispose(); }
});
