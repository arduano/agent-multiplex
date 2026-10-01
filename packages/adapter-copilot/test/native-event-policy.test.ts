import { describe, expect, it } from "vitest";
import type { AdapterNativeEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { copilotOptionalNativeTelemetry } from "../src/native-event-policy.js";

const snapshot = (): AdapterNativeEvent => ({
  kind: "native", nativeType: "model.messages_snapshot", ephemeral: true,
  payload: { type: "model.messages_snapshot", ephemeral: true,
    data: { kind: "messages_snapshot", messages: [{ role: "user", content: "synthetic context" }] } },
});

describe("pinned Copilot optional native telemetry policy", () => {
  it("accepts only the explicitly identified native context copy", () => {
    expect(copilotOptionalNativeTelemetry(snapshot())).toBe(true);
    expect(copilotOptionalNativeTelemetry({ ...snapshot(), payload: { type: "model.messages_snapshot", ephemeral: true,
      data: { kind: "messages_snapshot", messages: [] } } })).toBe(true);
  });

  it.each(["session.idle", "permission.requested", "permission.completed", "user_input.requested",
    "exit_plan_mode.requested", "elicitation.requested", "model.log", "model.response", "private-unknown-type"])(
    "does not trust the ephemeral marker on %s", (type) => {
      expect(copilotOptionalNativeTelemetry({ ...snapshot(), nativeType: type,
        payload: { type, ephemeral: true, data: { kind: "messages_snapshot", messages: [] } } })).toBe(false);
    },
  );

  it.each([
    { type: "permission.requested", ephemeral: true, data: { kind: "messages_snapshot", messages: [] } },
    { type: "model.messages_snapshot", data: { kind: "messages_snapshot", messages: [] } },
    { type: "model.messages_snapshot", ephemeral: false, data: { kind: "messages_snapshot", messages: [] } },
    { type: "model.messages_snapshot", ephemeral: "true", data: { kind: "messages_snapshot", messages: [] } },
    { type: "model.messages_snapshot", ephemeral: true, data: { messages: [] } },
    { type: "model.messages_snapshot", ephemeral: true, data: { kind: "messages_snapshot", messages: "invalid" } },
    { type: "model.messages_snapshot", ephemeral: true, data: null },
  ])("rejects mismatched or incomplete snapshot metadata %#", (payload) => {
    expect(copilotOptionalNativeTelemetry({ ...snapshot(), payload })).toBe(false);
  });

  it("requires the outer adapter ephemeral flag to be explicitly true too", () => {
    expect(copilotOptionalNativeTelemetry({ ...snapshot(), ephemeral: false })).toBe(false);
    expect(copilotOptionalNativeTelemetry({ ...snapshot(), ephemeral: "true" } as unknown as AdapterNativeEvent)).toBe(false);
  });
});
