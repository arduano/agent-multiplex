import type { SessionRecord } from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";
import { lifecycleRank, sessionLifecycleLabel, type SessionLifecycleLabel } from "../apps/web/src/client/session-lifecycle.js";

function session(input: Partial<SessionRecord>): SessionRecord {
  return { harness: "copilot", availability: "active", runtimeStatus: "idle", ...input } as SessionRecord;
}

describe("web lifecycle projection", () => {
  it("uses the server projection and fails closed when an active Copilot projection is absent", () => {
    expect(sessionLifecycleLabel(session({}))).toBe("Unknown");
    expect(sessionLifecycleLabel(session({ lifecycle: { status: "waitingForBackground" } as SessionRecord["lifecycle"] }))).toBe("Waiting for child/task");
    expect(sessionLifecycleLabel(session({ lifecycle: { status: "offline" } as SessionRecord["lifecycle"] }))).toBe("Offline");
    expect(sessionLifecycleLabel(session({ availability: "resumable" }))).toBe("Offline");
  });

  it("keeps non-Copilot sessions usable and ranks actionable lifecycle states first", () => {
    expect(sessionLifecycleLabel(session({ harness: "codex", runtimeStatus: "running" }))).toBe("Working");
    const order: SessionLifecycleLabel[] = ["Offline", "Ready", "Unknown", "Working", "Waiting for input"];
    expect([...order].sort((a, b) => lifecycleRank(a) - lifecycleRank(b))).toEqual([
      "Waiting for input", "Working", "Unknown", "Ready", "Offline",
    ]);
  });
});
