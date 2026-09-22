import type { LifecycleLabel, SessionRecord } from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";
import { lifecycleRank, sessionLifecycleLabel } from "../apps/web/src/client/session-lifecycle.js";

function session(input: Partial<SessionRecord>): SessionRecord {
  return { harness: "copilot", availability: "active", runtimeStatus: "idle", ...input } as SessionRecord;
}

describe("web lifecycle projection", () => {
  it("uses the server projection and fails closed when an active Copilot projection is absent", () => {
    expect(sessionLifecycleLabel(session({}))).toBe("Unknown");
    expect(sessionLifecycleLabel(session({ lifecycle: { label: "Waiting for child/task" } as SessionRecord["lifecycle"] }))).toBe("Waiting for child/task");
    expect(sessionLifecycleLabel(session({ lifecycle: { label: "Working" } as SessionRecord["lifecycle"] }), false)).toBe("Offline");
    expect(sessionLifecycleLabel(session({ availability: "resumable" }))).toBe("Offline");
  });

  it("keeps non-Copilot sessions usable and ranks actionable lifecycle states first", () => {
    expect(sessionLifecycleLabel(session({ harness: "codex", runtimeStatus: "running" }))).toBe("Working");
    const order: LifecycleLabel[] = ["Offline", "Ready", "Unknown", "Queued", "Working", "Waiting for input"];
    expect([...order].sort((a, b) => lifecycleRank(a) - lifecycleRank(b))).toEqual([
      "Waiting for input", "Working", "Queued", "Unknown", "Ready", "Offline",
    ]);
  });
});
