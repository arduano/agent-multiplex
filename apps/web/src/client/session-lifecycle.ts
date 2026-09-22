import type { LifecycleLabel, SessionRecord } from "@arduano/agent-multiplex-protocol";

export type LifecycleTone = "good" | "warn" | "bad" | "neutral";

/** Use the runtime-owned Copilot projection and fail closed if it is absent. */
export function sessionLifecycleLabel(session: SessionRecord, online = true): LifecycleLabel {
  if (!online || session.availability !== "active") return "Offline";
  if (session.lifecycle) return session.lifecycle.label;
  if (session.harness === "copilot") return "Unknown";
  switch (session.runtimeStatus) {
    case "running": return "Working";
    case "waitingForInput": return "Waiting for input";
    case "idle": return "Ready";
    case "error": return "Failed";
    case "stopped": return "Offline";
    case "unknown": return "Unknown";
  }
}

export function lifecycleTone(label: LifecycleLabel): LifecycleTone {
  if (label === "Failed") return "bad";
  if (label === "Waiting for input" || label === "Waiting for child/task" ||
      label === "Queued" || label === "Interrupted") return "warn";
  if (label === "Working" || label === "Finished" || label === "Ready") return "good";
  return "neutral";
}

export function lifecycleRank(label: LifecycleLabel): number {
  if (label === "Waiting for input") return 0;
  if (label === "Working" || label === "Waiting for child/task") return 1;
  if (label === "Queued") return 2;
  if (label === "Failed" || label === "Interrupted" || label === "Unknown") return 3;
  if (label === "Ready" || label === "Finished") return 4;
  return 5;
}

export function lifecycleDot(label: LifecycleLabel): "live" | "waiting" | "error" | "muted" {
  const tone = lifecycleTone(label);
  return tone === "good" ? "live" : tone === "warn" ? "waiting" : tone === "bad" ? "error" : "muted";
}
