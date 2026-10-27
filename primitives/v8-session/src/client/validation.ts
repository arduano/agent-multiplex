import type { Interaction, Selection, SessionCommand, SessionSnapshot } from "../contracts/types.js";
import { canonical, check, copy, id, scope } from "../contracts/validation.js";
import { observedCopilotUsage } from "../contracts/usage.js";
import { observedAttention } from "../contracts/attention.js";

const commands = new Set(["send", "answer", "codex.continue", "codex.defaults", "codex.turn", "codex.interrupt", "copilot.continue", "copilot.model", "copilot.mode", "copilot.permissions", "copilot.abort", "codex.queue.add", "codex.steer", "codex.compact", "codex.goal.set", "codex.goal.clear", "codex.terminal.terminate", "codex.terminals.clean", "codex.mcp.reload", "codex.mcp.login", "copilot.mcp.reconnect", "copilot.mcp.login", "copilot.steer", "copilot.queue.promote", "copilot.compact", "copilot.task.cancel", "copilot.task.promote"]);
/** One closed runtime action vocabulary also validates inert original references. */
export function originalCommandType(value: unknown): asserts value is SessionCommand["type"] {
  check(typeof value === "string" && (commands.has(value) || ["create", "resume", "stop", "archive"].includes(value)));
}
export function observedSnapshot(value: unknown): SessionSnapshot {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const saved = copy(value) as SessionSnapshot; canonical(saved, 256 * 1024); scope(saved.scope);
  check(saved.kind === "codex" || saved.kind === "copilot");
  check(saved.placement === "shared" || saved.placement === "dedicated");
  check(Number.isSafeInteger(saved.epoch) && saved.epoch >= 1);
  check(Number.isSafeInteger(saved.revision) && saved.revision >= 0 && Number.isSafeInteger(saved.generation) && saved.generation >= 0);
  check(["starting", "running", "stopping", "stopped"].includes(saved.phase));
  check(["idle", "working", "waiting", "unknown"].includes(saved.activity));
  check(saved.nativeSession === null || typeof saved.nativeSession === "string"); if (saved.nativeSession !== null) id(saved.nativeSession);
  check(typeof saved.stopRequested === "boolean" && typeof saved.interactionsComplete === "boolean");
  check(saved.selection.kind === saved.kind); selection(saved.selection);
  check(Array.isArray(saved.interactions) && saved.interactions.length <= 256);
  const seen = new Set<string>();
  for (const item of saved.interactions) { interaction(item); check(!seen.has(item.id)); seen.add(item.id); }
  check(Array.isArray(saved.capabilities.commands) && saved.capabilities.commands.length <= commands.size && saved.capabilities.commands.every(v => commands.has(v)));
  if (saved.capabilities.reads !== undefined) check(Array.isArray(saved.capabilities.reads) && saved.capabilities.reads.length <= 6 && saved.capabilities.reads.every(type => type.startsWith(`${saved.kind}.`) && ["codex.goal", "codex.terminals", "copilot.queue", "copilot.tasks", "copilot.task.progress", "copilot.task.promotable"].includes(type)));
  check(typeof saved.capabilities.fullStop === "boolean" && typeof saved.capabilities.reopen === "boolean");
  check(saved.capabilities.createAndWait === undefined || typeof saved.capabilities.createAndWait === "boolean");
  check(saved.issue === undefined || ["stopUnconfirmed", "ownershipUnconfirmed", "startUnconfirmed", "storageUnavailable"].includes(saved.issue));
  if (saved.archive !== undefined) { id(saved.archive.id); check(Object.keys(saved.archive).length === 2 && ["pending", "complete"].includes(saved.archive.state) && saved.phase === "stopped"); }
  if (saved.usage !== undefined) { check(saved.kind === "copilot" && saved.nativeSession !== null); observedCopilotUsage(saved.usage, saved.nativeSession!); }
  if (saved.attention !== undefined) observedAttention(saved.attention, saved);
  return saved;
}
export function selection(value: Selection): void {
  canonical(value);
  check(value.kind === "codex" || value.kind === "copilot");
  if (value.model !== undefined) id(value.model);
  if (value.effort !== undefined && value.effort !== null) id(value.effort);
  if (value.kind === "copilot") {
    if (value.providerId !== undefined) id(value.providerId);
    if (value.mode !== undefined) check(["interactive", "plan", "autopilot"].includes(value.mode));
    if (value.permissions !== undefined) check(["manual", "assisted", "allow-all"].includes(value.permissions));
  } else {
    if (value.collaboration) {
      check(["default", "plan"].includes(value.collaboration.mode)); id(value.collaboration.model);
      if (value.collaboration.effort !== null) id(value.collaboration.effort);
      check(value.collaboration.instructions === undefined || value.collaboration.instructions === null || typeof value.collaboration.instructions === "string");
    }
    if (value.access) {
      check(["on-request", "untrusted", "never"].includes(value.access.approval));
      check((value.access.profile !== undefined) !== (value.access.sandbox !== undefined));
      if (value.access.profile !== undefined) id(value.access.profile);
      else check(["danger-full-access", "workspace-write", "read-only"].includes(value.access.sandbox));
    }
  }
}
function interaction(value: Interaction): void {
  id(value.id); id(value.owner); check(["approval", "permission", "userInput", "elicitation", "exitPlan"].includes(value.kind));
  check(value.blocking === undefined || typeof value.blocking === "boolean");
  check(Array.isArray(value.choices) && value.choices.length <= 64); for (const choice of value.choices) id(choice);
}
