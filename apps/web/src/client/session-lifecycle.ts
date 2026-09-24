import type { SessionLifecycleView, SessionRecord } from "@arduano/agent-multiplex-protocol";

export type LifecycleTone = "good" | "warn" | "bad" | "neutral";
export type SessionLifecycleLabel =
  | "Offline"
  | "Unknown"
  | "Recovery unverified"
  | "Waiting for input"
  | "Failed"
  | "Interrupted"
  | "Working"
  | "Waiting for child/task"
  | "Finished"
  | "Ready";

const labels = {
  ready: "Ready",
  working: "Working",
  waitingForInput: "Waiting for input",
  waitingForBackground: "Waiting for child/task",
  interrupted: "Interrupted",
  failed: "Failed",
  finished: "Finished",
  unknown: "Unknown",
  offline: "Offline",
} as const satisfies Record<SessionLifecycleView["status"], SessionLifecycleLabel>;

/** Use the runtime-owned Copilot projection and fail closed if it is absent. */
export function sessionLifecycleLabel(session: SessionRecord, online = true): SessionLifecycleLabel {
  if (session.harness === "copilot") {
    if (!online || session.availability !== "active") return "Offline";
    if (!session.lifecycle) return "Unknown";
    if (session.lifecycle.status === "unknown" && session.lifecycle.health.state === "recovering" &&
        session.lifecycle.health.issues.some((issue) => issue.code === "incompleteNativeState")) {
      return "Recovery unverified";
    }
    return labels[session.lifecycle.status];
  }
  if (!online || session.availability !== "active") return "Offline";
  switch (session.runtimeStatus) {
    case "running": return "Working";
    case "waitingForInput": return "Waiting for input";
    case "idle": return "Ready";
    case "error": return "Failed";
    case "stopped": return "Offline";
    case "unknown": return "Unknown";
  }
}

/** Gate controls from the authoritative action projection, not the status label.
 * A fresh zero-message Copilot root is intentionally Unknown but may send or change settings. */
export function lifecycleActionAvailable(
  session: SessionRecord,
  action: keyof SessionLifecycleView["actions"],
): boolean {
  return session.harness === "copilot"
    ? session.lifecycle?.actions[action].available === true
    : session.availability === "active";
}

export function lifecycleTone(label: SessionLifecycleLabel): LifecycleTone {
  if (label === "Failed") return "bad";
  if (label === "Waiting for input" || label === "Waiting for child/task" ||
      label === "Interrupted") return "warn";
  if (label === "Working" || label === "Finished" || label === "Ready") return "good";
  return "neutral";
}

export function lifecycleRank(label: SessionLifecycleLabel): number {
  if (label === "Waiting for input") return 0;
  if (label === "Working" || label === "Waiting for child/task") return 1;
  if (label === "Failed" || label === "Interrupted" || label === "Unknown" || label === "Recovery unverified") return 3;
  if (label === "Ready" || label === "Finished") return 4;
  return 5;
}

export function lifecycleDot(label: SessionLifecycleLabel): "live" | "waiting" | "error" | "muted" {
  const tone = lifecycleTone(label);
  return tone === "good" ? "live" : tone === "warn" ? "waiting" : tone === "bad" ? "error" : "muted";
}
