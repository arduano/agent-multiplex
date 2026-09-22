import { describe, expect, it } from "vitest";
import { copilotLifecycleFacts } from "../src/lifecycle.js";

const event = (data: unknown = {}, extra: object = {}) => ({ id: "event-uuid", parentId: "chronological-parent",
  timestamp: "2026-09-22T00:00:00Z", data, ...extra });

describe("Copilot lifecycle evidence normalization", () => {
  it("preserves missing message identity without substituting text, UUID or preceding event", () => {
    expect(copilotLifecycleFacts("user.message", event({ content: "same text", interactionId: "telemetry" }))).toEqual([]);
    expect(copilotLifecycleFacts("user.message", event({ content: "same text", messageId: "native-message" }))).toEqual([
      { type: "messageDisplayed", messageId: "native-message", owner: "root" },
    ]);
    expect(copilotLifecycleFacts("user.message", event({ messageId: "native-message", turnId: "native-turn" }))).toEqual([
      { type: "messageDisplayed", messageId: "native-message", owner: "root" },
    ]);
  });
  it.each(["agentId", "parentToolCallId"])("fences legacy %s child evidence without treating parentId as ownership", owner => {
    expect(copilotLifecycleFacts("user.message", event({ messageId: "message", [owner]: "child" }))).toEqual([]);
    expect(copilotLifecycleFacts("session.error", event({ [owner]: "child" }))).toEqual([{ type: "child", id: "agent:child", state: "failed" }]);
    expect(copilotLifecycleFacts("session.idle", event())).toEqual([{ type: "rootIdle", aborted: false }]);
  });
  it("uses the unique observed start fence instead of a reusable native loop counter", () => {
    expect(copilotLifecycleFacts("assistant.turn_start", event({ turnId: "0" }, { id: "first" }))).toEqual([{ type: "rootStarted", cycleId: "first" }]);
    expect(copilotLifecycleFacts("assistant.turn_start", event({ turnId: "0" }, { id: "second" }))).toEqual([{ type: "rootStarted", cycleId: "second" }]);
    expect(copilotLifecycleFacts("assistant.turn_start", { data: { turnId: "0" } })).toEqual([]);
  });
  it("separates model pause, whole-session idle and interruption", () => {
    expect(copilotLifecycleFacts("assistant.idle", event())).toEqual([{ type: "rootModelIdle" }]);
    expect(copilotLifecycleFacts("assistant.turn_end", event())).toEqual([]);
    expect(copilotLifecycleFacts("session.idle", event({ aborted: true }))).toEqual([{ type: "rootIdle", aborted: true }]);
    expect(copilotLifecycleFacts("session.idle", event({}, { agentId: "child" }))).toEqual([{ type: "child", id: "agent:child", state: "completed" }]);
  });
  it("keeps native task/tool and agent identities separate and refuses nameless children", () => {
    expect(copilotLifecycleFacts("subagent.started", event({ agentName: "same", toolCallId: "exact" }))).toEqual([{ type: "child", id: "tool:exact", state: "running" }]);
    expect(copilotLifecycleFacts("subagent.completed", event({ toolCallId: "exact" }))).toEqual([{ type: "child", id: "tool:exact", state: "completed" }]);
    expect(copilotLifecycleFacts("subagent.failed", event({ toolCallId: "exact" }))).toEqual([{ type: "child", id: "tool:exact", state: "failed" }]);
    expect(copilotLifecycleFacts("subagent.started", event({ agentName: "same" }))).toEqual([]);
  });
  it("keeps compaction observations uncorrelated with command and provider IDs", () => {
    expect(copilotLifecycleFacts("session.compaction_start", event())).toEqual([{ type: "compaction", phase: "running" }]);
    expect(copilotLifecycleFacts("session.compaction_complete", event({ requestId: "provider-request", success: false }))).toEqual([{ type: "compaction", phase: "observedComplete" }]);
    expect(copilotLifecycleFacts("session.compaction_complete", event({}, { agentId: "child" }))).toEqual([]);
  });
  it.each([
    ["session.background_tasks_changed", "tasksInvalidated"], ["pending_messages.modified", "queueInvalidated"],
  ])("uses %s only to invalidate its observation", (nativeType, type) => {
    expect(copilotLifecycleFacts(nativeType, event())).toEqual([{ type }]);
  });
  it.each([null, [], "event", { data: null }, { data: [] }])("ignores malformed native envelopes", payload => {
    expect(copilotLifecycleFacts("session.idle", payload)).toEqual([]);
  });
});
