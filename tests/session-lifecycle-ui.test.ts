import type { SessionRecord } from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";
import { lifecycleActionAvailable, sessionLifecycleLabel } from "../apps/web/src/client/session-lifecycle.js";

const actionNames = ["send", "steer", "interrupt", "changeSettings", "resolveInteraction", "stop"] as const;

function copilot(
  status: "ready" | "unknown",
  issues: Array<"incompleteNativeState" | "observationPending"> = [],
  available: readonly (typeof actionNames)[number][] = [],
): SessionRecord {
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
      actions: Object.fromEntries(actionNames.map(action => [action, available.includes(action)
        ? { available: true, reason: "available" }
        : { available: false, reason: "notWorking" }])) as unknown as NonNullable<SessionRecord["lifecycle"]>["actions"],
    },
  } as unknown as SessionRecord;
}

describe("Copilot lifecycle labels", () => {
  it("distinguishes online recovery without complete native evidence from Ready", () => {
    expect(sessionLifecycleLabel(copilot("unknown", ["incompleteNativeState"]), true)).toBe("Recovery unverified");
    expect(sessionLifecycleLabel(copilot("unknown", ["observationPending"]), true)).toBe("Unknown");
    expect(sessionLifecycleLabel(copilot("ready"), true)).toBe("Ready");
  });

  it("lets a fresh zero-message session expose authoritative actions without inventing Ready", () => {
    const fresh = copilot("unknown", [], ["send", "changeSettings", "stop"]);
    expect(sessionLifecycleLabel(fresh, true)).toBe("Unknown");
    expect(lifecycleActionAvailable(fresh, "send")).toBe(true);
    expect(lifecycleActionAvailable(fresh, "changeSettings")).toBe(true);
    expect(lifecycleActionAvailable(fresh, "steer")).toBe(false);
    expect(lifecycleActionAvailable(fresh, "interrupt")).toBe(false);
  });

  it("lets current host reachability override a stale online projection", () => {
    expect(sessionLifecycleLabel(copilot("unknown", ["incompleteNativeState"]), false)).toBe("Offline");
    expect(sessionLifecycleLabel({ ...copilot("ready"), availability: "resumable" }, true)).toBe("Offline");
  });
});
