import { materialize, object, text, identity, validateStopProof, validateInteractions, validateCatalog, run } from "../../v8-session/src/native/validation.js";
import { SessionError, type CodexAccess, type Harness, type ManagedPolicy, type NativeEvent, type Selection, type SessionCommand } from "../../v8-session/src/contracts/types.js";
import { check, frozen } from "../../v8-session/src/contracts/validation.js";
import { validateSendInputs } from "../../v8-session/src/contracts/send-inputs.js";
import { copilotCheckpoint } from "../../v8-session/src/contracts/usage.js";
import { attentionSignal } from "../../v8-session/src/contracts/attention.js";

type Obj = Record<string, unknown>;
/** Installed Codex/Copilot facade, independent of the generic lifecycle engine. */
const modes = ["interactive", "plan", "autopilot"];
function access(value: unknown): CodexAccess {
  const v = object(value, ["approval", "sandbox", "profile"]);
  check(["on-request", "untrusted", "never"].includes(String(v.approval)));
  check((v.profile !== undefined) !== (v.sandbox !== undefined));
  if (v.profile !== undefined) identity(v.profile);
  else check(["danger-full-access", "workspace-write", "read-only"].includes(String(v.sandbox)));
  return frozen(v) as CodexAccess;
}
function selection(kind: Harness, value: unknown): Selection {
  const v = object(value, kind === "codex" ? ["kind", "model", "effort", "collaboration", "access"] : ["kind", "model", "providerId", "effort", "mode", "permissions"]);
  check(v.kind === kind);
  if (v.model !== undefined) identity(v.model);
  if (v.effort !== undefined && v.effort !== null) identity(v.effort);
  if (kind === "codex") {
    if (v.access !== undefined) access(v.access);
    if (v.collaboration !== undefined) {
      const c = object(v.collaboration, ["mode", "model", "effort", "instructions"]);
      check(c.mode === "plan" || c.mode === "default"); identity(c.model);
      check(c.effort === null || typeof c.effort === "string"); if (c.effort !== null) identity(c.effort);
      if (c.instructions !== undefined && c.instructions !== null) text(c.instructions, 4096, true);
      check(v.model === undefined || v.model === c.model, "Collaboration model conflicts with thread model");
      check(v.effort === undefined || v.effort === c.effort, "Collaboration effort conflicts with thread effort");
    }
  } else {
    if (v.providerId !== undefined) identity(v.providerId);
    check(v.providerId === undefined || v.model !== undefined, "Provider without model");
    if (v.mode !== undefined) check(modes.includes(String(v.mode)));
    if (v.permissions !== undefined) check(["manual", "assisted", "allow-all"].includes(String(v.permissions)));
  }
  return frozen(v) as Selection;
}
export function validateSelection(kind: Harness, value: unknown): Selection { check(kind === "codex" || kind === "copilot"); return selection(kind, materialize(value)); }

export function validateCommand(kind: Harness, value: unknown): SessionCommand {
  check(kind === "codex" || kind === "copilot"); const v = materialize(value) as Obj;
  check(v && typeof v === "object" && typeof v.type === "string");
  switch (v.type) {
    case "resume": case "stop": case "archive": object(v, ["type"]); break;
    case "create":
      object(v, ["type", "selection"]);
      if (v.selection !== undefined) { const s = selection(kind, v.selection); if (s.kind === "copilot" && s.permissions === "assisted") throw new SessionError("UNSUPPORTED", "Assisted is observation-only"); }
      break;
    case "send":
      object(v, ["type", "text", "selection", "inputs"]); text(v.text, 8192, true);
      if (v.selection !== undefined) selection(kind, v.selection);
      if (v.inputs !== undefined) v.inputs = validateSendInputs(kind, v.inputs);
      check(v.text.trim().length > 0 || v.inputs !== undefined, "Empty Send");
      break;
    case "answer":
      object(v, ["type", "interactionId", "choice", "value"]); identity(v.interactionId); identity(v.choice); break;
    case "codex.defaults": case "codex.turn": {
      check(kind === "codex"); object(v, v.type === "codex.turn" ? ["type", "turnId", "selection"] : ["type", "selection"]);
      const s = selection(kind, v.selection); check(Object.keys(s).length > 1, "Empty settings update");
      if (v.type === "codex.turn") {
        identity(v.turnId);
        if ("access" in s || "collaboration" in s) throw new SessionError("UNSUPPORTED", "These are thread settings, not running-turn settings");
        check(s.model !== undefined || s.effort !== undefined && s.effort !== null, "Empty running-turn update");
      }
      break;
    }
    case "codex.interrupt": check(kind === "codex"); object(v, ["type", "turnId"]); identity(v.turnId); break;
    case "codex.queue.add": case "codex.steer": case "copilot.steer":
      check(kind === (v.type === "copilot.steer" ? "copilot" : "codex"));
      object(v, v.type === "codex.steer" ? ["type", "expectedTurnId", "text", "inputs"] : ["type", "text", "inputs"]);
      if (v.type === "codex.steer") identity(v.expectedTurnId);
      text(v.text, 8192, true); if (v.inputs !== undefined) v.inputs = validateSendInputs(kind, v.inputs);
      check(v.text.trim().length > 0 || v.inputs !== undefined, "Empty message"); break;
    case "codex.continue": case "codex.compact": case "codex.goal.clear": case "codex.terminals.clean": case "codex.mcp.reload": check(kind === "codex"); object(v, ["type"]); break;
    case "codex.terminal.terminate": check(kind === "codex"); object(v, ["type", "processId"]); identity(v.processId); break;
    case "codex.mcp.login": check(kind === "codex"); object(v, ["type", "serverName"]); identity(v.serverName); break;
    case "codex.goal.set":
      check(kind === "codex"); object(v, ["type", "objective", "status", "tokenBudget"]); check(Object.keys(v).length > 1);
      if (v.objective !== undefined) text(v.objective, 4000);
      if (v.status !== undefined) check(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(v.status)));
      if (v.tokenBudget !== undefined) check(v.tokenBudget === null || Number.isSafeInteger(v.tokenBudget) && Number(v.tokenBudget) >= 0); break;
    case "copilot.continue": check(kind === "copilot"); object(v, ["type"]); break;
    case "copilot.compact": check(kind === "copilot"); object(v, ["type"]); break;
    case "copilot.mcp.reconnect": check(kind === "copilot"); object(v, ["type", "serverName"]); identity(v.serverName); break;
    case "copilot.mcp.login": check(kind === "copilot"); object(v, ["type", "serverName", "forceReauth"]); identity(v.serverName); if (v.forceReauth !== undefined) check(typeof v.forceReauth === "boolean"); break;
    case "copilot.queue.promote": case "copilot.task.cancel": case "copilot.task.promote":
      check(kind === "copilot"); object(v, ["type", "id"]); identity(v.id); break;
    case "copilot.model":
      check(kind === "copilot"); object(v, ["type", "model", "providerId", "effort"]); identity(v.model);
      if (v.providerId !== undefined) identity(v.providerId); if (v.effort !== undefined && v.effort !== null) identity(v.effort); break;
    case "copilot.mode": check(kind === "copilot"); object(v, ["type", "mode"]); check(modes.includes(String(v.mode))); break;
    case "copilot.permissions": check(kind === "copilot"); object(v, ["type", "mode"]); check(v.mode === "manual" || v.mode === "allow-all"); break;
    case "copilot.abort": check(kind === "copilot"); object(v, ["type"]); break;
    default: throw new SessionError("UNSUPPORTED", "Unsupported session command");
  }
  return frozen(v) as SessionCommand;
}

export function validateEvent(kind: Harness, value: unknown): NativeEvent {
  check(kind === "codex" || kind === "copilot");
  const v = materialize(value) as Obj; check(v && typeof v === "object"); const current = run(v.run);
  switch (v.type) {
    case "selection": object(v, ["run", "type", "selection"]); selection(kind, v.selection); break;
    case "activity": object(v, ["run", "type", "activity"]); check(["idle", "working", "waiting", "unknown"].includes(String(v.activity))); break;
    case "copilot.usage": object(v, ["run", "type", "totalNanoAiu", "reportedAt"]); check(kind === "copilot" && copilotCheckpoint(v.totalNanoAiu, v.reportedAt)?.reportedAt === v.reportedAt); break;
    case "attention": object(v, ["run", "type", "attention"]); attentionSignal(v.attention, kind); break;
    case "nativeState": case "controlLost": object(v, ["run", "type"]); break;
    case "interactions": object(v, ["run", "type", "complete", "items"]); check(typeof v.complete === "boolean"); validateInteractions(v.items); break;
    case "stopped": object(v, ["run", "type", "proof"]); validateStopProof(current, v.proof); break;
    default: throw new SessionError("UNSUPPORTED", "Unsupported native event");
  }
  return frozen(v) as NativeEvent;
}

/** Admission only: catalog absence never erases an observed selection. */
export function validateChoice(kind: Harness, value: unknown, catalogValue: unknown): Selection {
  const s = validateSelection(kind, value), catalog = validateCatalog(catalogValue);
  if (s.model === undefined) return s;
  check(catalog.available, "Model catalog unavailable");
  const provider = s.kind === "copilot" ? s.providerId : undefined;
  const matches = catalog.choices.filter(c => c.model === s.model && (provider === undefined || c.providerId === provider));
  check(matches.length === 1, "Unavailable or ambiguous model/provider choice");
  if (s.effort !== undefined && s.effort !== null) check(matches[0]!.efforts.includes(s.effort), "Unsupported model effort");
  return s;
}
/** Private construction helper; never accepts browser native/config fields. */
export function managedPolicy(kind: Harness, value?: unknown): ManagedPolicy {
  if (value === undefined) return frozen(kind === "codex" ? { kind, access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "configured" } : { kind, permissions: "manual", provider: "configured" });
  const v = object(materialize(value), kind === "codex" ? ["kind", "access", "provider"] : ["kind", "permissions", "provider"]);
  check(v.kind === kind && ["copilot-only", "configured"].includes(String(v.provider)));
  if (kind === "codex") access(v.access); else check(v.permissions === "manual" || v.permissions === "allow-all");
  return frozen(v) as ManagedPolicy;
}
