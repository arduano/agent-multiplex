import { describe, expect, it } from "vitest";
import { copilotEventNamesOwner, copilotObservedOwnerId, describeCopilotEvent } from "@arduano/agent-multiplex-protocol";
import { copilotHistoryDeliveryFacts, copilotLifecycleFacts } from "../packages/adapter-copilot/src/lifecycle.js";

describe("shared native Copilot ownership description", () => {
  it("keeps agent and tool ownership distinct and ignores event chronology", () => {
    const raw = { type: "subagent.started", agentId: "child", parentId: "prior-event",
      data: { agentId: "legacy", toolCallId: "invocation", parentToolCallId: "parent-invocation" } };
    expect(describeCopilotEvent(raw)).toEqual({ agentId: "child", legacyAgentId: "legacy", parentToolCallId: "parent-invocation",
      ownershipMarked: true, delegation: { agentId: "child", toolCallId: "invocation" } });
    expect(copilotObservedOwnerId(raw)).toBe("child");
    expect(copilotEventNamesOwner(raw, "legacy")).toBe(true);
    expect(copilotEventNamesOwner(raw, "invocation")).toBe(false);
    expect(copilotEventNamesOwner(raw, "prior-event")).toBe(false);
    expect(copilotLifecycleFacts(raw.type, raw)).toEqual([{ type: "child", id: "tool:invocation", state: "running" }]);
  });

  it("preserves strict root delivery for malformed ownership markers", () => {
    for (const marker of [null, "", 12]) {
      const event = { type: "user.message", data: { messageId: "exact", turnId: "consumed", agentId: marker } };
      expect(describeCopilotEvent(event).ownershipMarked).toBe(true);
      expect(copilotHistoryDeliveryFacts([event])).toEqual([]);
    }
    const event = { type: "user.message", parentId: "prior-event", data: { messageId: "exact", turnId: "consumed" } };
    expect(copilotHistoryDeliveryFacts([event])).toHaveLength(2);
    expect(copilotObservedOwnerId(event)).toBeUndefined();
  });
});
