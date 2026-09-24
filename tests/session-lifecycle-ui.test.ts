import type { SessionRecord } from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";
import { sessionLifecycleLabel } from "../apps/web/src/client/session-lifecycle.js";

function copilot(status: "ready" | "unknown", issues: Array<"incompleteNativeState" | "observationPending"> = []): SessionRecord {
  return {
    harness: "copilot",
    availability: "active",
    lifecycle: {
      version: 2,
      observationId: "00000000-0000-4000-8000-000000000001",
      status,
      health: {
        state: issues.length > 0 ? "recovering" : "healthy",
        issues: issues.map(code => ({ scope: code === "observationPending" ? "tasks" : "lifecycle", code })),
      },
      actions: Object.fromEntries(["send", "steer", "interrupt", "changeSettings", "resolveInteraction", "stop"]
        .map(action => [action, { available: false, reason: "notWorking" }])) as unknown as NonNullable<SessionRecord["lifecycle"]>["actions"],
    },
  } as unknown as SessionRecord;
}

describe("Copilot lifecycle labels", () => {
  it("distinguishes online recovery without complete native evidence from Ready", () => {
    expect(sessionLifecycleLabel(copilot("unknown", ["incompleteNativeState"]), true)).toBe("Recovery unverified");
    expect(sessionLifecycleLabel(copilot("unknown", ["observationPending"]), true)).toBe("Recovery unverified");
    expect(sessionLifecycleLabel(copilot("ready"), true)).toBe("Ready");
  });

  it("lets current host reachability override a stale online projection", () => {
    expect(sessionLifecycleLabel(copilot("unknown", ["incompleteNativeState"]), false)).toBe("Offline");
    expect(sessionLifecycleLabel({ ...copilot("ready"), availability: "resumable" }, true)).toBe("Offline");
  });
});
