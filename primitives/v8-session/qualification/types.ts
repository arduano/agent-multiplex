import type { SessionAgent } from "../src/client/workspace.js";
declare const agent: SessionAgent;
if (agent.kind === "copilot") {
  agent.actions.setMode?.("plan"); agent.actions.reconnectMcp?.("known-server");
  // @ts-expect-error Copilot cannot reload a Codex app-server.
  agent.actions.reloadMcp?.();
  // @ts-expect-error A Copilot branch cannot target a Codex turn.
  agent.actions.updateTurn("turn", { kind: "codex" });
  // @ts-expect-error Assisted is observable but this writable subset excludes it.
  agent.actions.setPermissions?.("assisted");
  // @ts-expect-error Send cannot inject another harness's selection.
  agent.actions.send?.("wrong", { kind: "codex", model: "m" });
}
if (agent.kind === "codex") {
  agent.actions.updateTurn?.("turn", { kind: "codex", effort: null }); agent.actions.reloadMcp?.();
  // @ts-expect-error Codex cannot invoke a Copilot per-server reconnect.
  agent.actions.reconnectMcp?.("known-server");
  // @ts-expect-error Codex has no Copilot mode setter.
  agent.actions.setMode("autopilot");
  // @ts-expect-error Exact Codex interrupt requires a turn ID.
  agent.actions.interrupt?.();
  // @ts-expect-error Native sandbox cannot be combined with a named profile.
  agent.actions.setDefaults?.({ kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access", profile: "named" } });
}
if (agent.kind === "unsupported") {
  // @ts-expect-error Unsupported branches expose no callable native actions.
  agent.actions.stop();
}

if (agent.kind === "codex") {
  agent.actions.enqueue?.("native queued text");
  agent.actions.terminateTerminal?.("exact-native-process"); agent.actions.cleanTerminals?.();
  agent.actions.read?.({ type: "codex.terminals", cursor: "next-page", limit: 10 });
  agent.actions.steer?.("exact-turn", "correction"); agent.actions.read?.({ type: "codex.goal" });
  // @ts-expect-error Codex cannot invoke native Copilot queue actions.
  agent.actions.promoteQueued?.("queue");
  // @ts-expect-error Codex Steer requires the exact native turn ID.
  agent.actions.steer?.("missing target");
  // @ts-expect-error Codex cannot read native Copilot tasks.
  agent.actions.read?.({ type: "copilot.tasks" });
}
if (agent.kind === "copilot") {
  agent.actions.steer?.("immediate"); agent.actions.read?.({ type: "copilot.task.progress", id: "exact-task" });
  // @ts-expect-error Native Codex enqueue is distinct from Copilot Send.
  agent.actions.enqueue?.("native queue");
  // @ts-expect-error Copilot exposes no native Codex goal setter.
  agent.actions.setGoal?.({ objective: "goal" });
  // @ts-expect-error A Copilot session cannot control native Codex terminals.
  agent.actions.terminateTerminal?.("process");
  // @ts-expect-error A Copilot session cannot read native Codex terminal pages.
  agent.actions.read?.({ type: "codex.terminals" });
  // @ts-expect-error A task progress read requires its exact target identity.
  agent.actions.read?.({ type: "copilot.task.progress" });
}
