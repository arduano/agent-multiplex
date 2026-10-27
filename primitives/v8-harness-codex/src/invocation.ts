import { NativeInputRefused, SessionError, type CodexAccess, type CodexEncodedInput, type CodexSelection, type ControlCommand, type Json, type NativeControlCommand, type NativeSendCommand, type NativeOutcome, type RunRef, type Selection } from "../../v8-session/src/contracts/types.js";
import { check, frozen } from "../../v8-session/src/contracts/validation.js";
import { validateSelection } from "../../v8-harness-defaults/src/validation.js";
import { validateOutcome, validateRun } from "../../v8-session/src/native/validation.js";
import { goal, nativeObject } from "../../v8-harness-defaults/src/state.js";
import { validateNativeCommand } from "../../v8-harness-defaults/src/prepared-send.js";
import { json, obj } from "../../v8-harness-defaults/src/invocation-helpers.js";
import { encodeCodexSandbox } from './access.js';

import type { CodexInvocationRpc, CodexNativeInput, CodexSettings } from "./request-contract.js";
export function codexThreadOutcome(value: unknown): NativeOutcome {
  const detail = json(value); check(detail && typeof detail === "object" && !Array.isArray(detail) && Object.keys(detail).length === 0, "Invalid Codex thread ACK");
  return validateOutcome({ status: "acknowledged", detail });
}
export function codexTurnOutcome(value: unknown): NativeOutcome {
  const detail = obj(value); check(Object.keys(detail).length === 1 && (detail.status === "applied" || detail.status === "targetUnavailable"));
  return validateOutcome({ status: detail.status, detail });
}
/** Injected RPC only; no SDK, process creation, provider discovery or ambient network. */
export function createCodexInvocation(options: Readonly<{
  run: RunRef; rpc: CodexInvocationRpc; encodeSandbox?: (access: CodexAccess) => Json;
  currentSelection?: () => CodexSelection;
  /** Exact no-body native method; separate from record-shaped thread RPCs. */
  reloadMcp?: () => Promise<unknown>;
  encodeInputs?: (inputs: NativeSendCommand<"codex">["nativeInputs"]) => Promise<readonly CodexEncodedInput[]>;
  answer?: (command: Extract<ControlCommand, { type: "answer" }>) => Promise<NativeOutcome>;
}>): (command: NativeControlCommand) => Promise<NativeOutcome> {
  const run = validateRun(options.run), rpc = options.rpc, encodeSandbox = options.encodeSandbox,
    currentSelection = options.currentSelection, answer = options.answer, encodeInputs = options.encodeInputs, reloadMcp = options.reloadMcp;
  async function messageInputs(command: Extract<NativeControlCommand, { type: "send" | "codex.steer" | "codex.queue.add" }>): Promise<CodexNativeInput[]> {
    const native = "nativeInputs" in command ? command.nativeInputs : undefined;
    if (native && (!encodeInputs || native.kind !== "codex")) throw new SessionError("UNSUPPORTED");
    const encoded = native ? await encodeInputs!(native as NativeSendCommand<"codex">["nativeInputs"]) : [];
    return [...(command.text ? [{ type: "text" as const, text: command.text, text_elements: [] }] : []), ...encoded];
  }
  function fields(value: Selection | undefined, threadScope = true): CodexSettings {
    if (!value) return {};
    const s = validateSelection("codex", value); check(s.kind === "codex"); const result: { -readonly [K in keyof CodexSettings]: CodexSettings[K] } = {};
    if (s.model !== undefined) result.model = s.model;
    if (s.effort !== undefined) result.effort = s.effort;
    let collaboration = s.collaboration;
    if (threadScope && !collaboration && (s.model !== undefined || s.effort !== undefined)) {
      // Native sticky collaboration settings take precedence over top-level
      // model/effort. Preserve the exact known instructions when patching them.
      // Absence in a partial observation cannot prove native built-in defaults.
      const current = currentSelection && validateSelection("codex", currentSelection());
      if (!current || current.kind !== "codex" || !current.collaboration || current.collaboration.instructions === undefined)
        throw new SessionError("UNSUPPORTED", "Codex model/effort update needs known collaboration and instructions");
      collaboration = { ...current.collaboration, ...(s.model === undefined ? {} : { model: s.model }), ...(s.effort === undefined ? {} : { effort: s.effort }) };
    }
    // An explicit new collaboration object deliberately selects built-in
    // instructions when omitted. A patch above never infers that omission.
    if (collaboration) result.collaborationMode = { mode: collaboration.mode, settings: { model: collaboration.model, reasoning_effort: collaboration.effort, developer_instructions: collaboration.instructions ?? null } };
    if (s.access) {
      result.approvalPolicy = s.access.approval;
      if (s.access.profile !== undefined) result.permissions = s.access.profile;
      else if (encodeSandbox) result.sandboxPolicy = json(encodeSandbox(s.access));
      else result.sandboxPolicy = encodeCodexSandbox(s.access);
    }
    return result;
  }
  return async input => {
    const command = validateNativeCommand("codex", input);
    if (command.type === "codex.continue") {
      let raw: unknown;
      try { raw = await rpc("turn/start", { threadId: run.nativeSession, input: [] }); }
      catch (error) { if (error instanceof NativeInputRefused) return { status: "refused", detail: { reason: error.reason } }; throw error; }
      const result = nativeObject(raw), turn = nativeObject(result.turn);
      check(typeof turn.id === "string" && turn.id.length > 0 && turn.id.length <= 256);
      return validateOutcome({ status: "accepted", detail: { turnId: turn.id } });
    }
    if (command.type === "codex.mcp.reload") {
      if (!reloadMcp) return { status: "refused", detail: { reason: "unsupportedNativeMethod" } };
      return codexThreadOutcome(await reloadMcp());
    }
    if (command.type === "codex.defaults") return codexThreadOutcome(await rpc("thread/settings/update", frozen({ threadId: run.nativeSession, ...fields(command.selection) })));
    if (command.type === "codex.turn") return codexTurnOutcome(await rpc("turn/settings/update", frozen({ threadId: run.nativeSession, turnId: command.turnId, ...fields(command.selection, false) })));
    if (command.type === "codex.interrupt") return codexThreadOutcome(await rpc("turn/interrupt", frozen({ threadId: run.nativeSession, turnId: command.turnId })));
    if (command.type === "codex.queue.add") {
      if (!("clientUserMessageId" in command)) return { status: "refused", detail: { reason: "originalIdentityRequired" } };
      const result = nativeObject(await rpc("thread/queue/add", { threadId: run.nativeSession, clientUserMessageId: command.clientUserMessageId, input: await messageInputs(command) }));
      const submission = nativeObject(result.queuedSubmission); check(typeof submission.id === "string" && submission.id.length > 0 && submission.id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(submission.id) && submission.clientUserMessageId === command.clientUserMessageId);
      return validateOutcome({ status: "accepted", detail: { queuedSubmission: { id: submission.id, clientUserMessageId: command.clientUserMessageId } } });
    }
    if (command.type === "codex.steer") {
      let raw: unknown;
      try { raw = await rpc("turn/steer", frozen({ threadId: run.nativeSession, expectedTurnId: command.expectedTurnId, input: await messageInputs(command) })); }
      catch (error) { if (error instanceof NativeInputRefused) return { status: "refused", detail: { reason: error.reason } }; throw error; }
      const result = nativeObject(raw); check(result.turnId === command.expectedTurnId); return validateOutcome({ status: "accepted", detail: { turnId: result.turnId } });
    }
    if (command.type === "codex.compact") return codexThreadOutcome(await rpc("thread/compact/start", { threadId: run.nativeSession }));
    if (command.type === "codex.terminal.terminate") {
      const result = nativeObject(await rpc("thread/backgroundTerminals/terminate", { threadId: run.nativeSession, processId: command.processId })); check(typeof result.terminated === "boolean");
      return validateOutcome({ status: "applied", detail: { processId: command.processId, terminated: result.terminated } });
    }
    if (command.type === "codex.terminals.clean") return codexThreadOutcome(await rpc("thread/backgroundTerminals/clean", { threadId: run.nativeSession }));
    if (command.type === "codex.goal.set") {
      const { type: _type, ...patch } = command, observed = goal(await rpc("thread/goal/set", { threadId: run.nativeSession, ...patch }), run.nativeSession, false)!;
      check((command.objective === undefined || observed.objective === command.objective) && (command.status === undefined || observed.status === command.status) && (command.tokenBudget === undefined || observed.tokenBudget === command.tokenBudget));
      return validateOutcome({ status: "applied", detail: { goal: observed } });
    }
    if (command.type === "codex.goal.clear") {
      const result = nativeObject(await rpc("thread/goal/clear", { threadId: run.nativeSession })); check(typeof result.cleared === "boolean");
      return validateOutcome({ status: "applied", detail: { cleared: result.cleared } });
    }
    if (command.type === "send") {
      // This compiler only reads validated selection/observed facts. Its failure
      // precedes native encoding, settings and RPC, so it is a definite refusal.
      // Encoding/RPC/result failures remain outside this catch: a native effect
      // may already have occurred and its original must stay uncertain.
      let selected: CodexSettings;
      try { selected = fields(command.selection); }
      catch { return validateOutcome({ status: "refused", detail: { sendDispatched: false, reason: "unsupportedSelection" } }); }
      const input = await messageInputs(command);
      const clientId = "clientUserMessageId" in command ? command.clientUserMessageId : undefined;
      let raw: unknown;
      try { raw = await rpc("turn/start", frozen({ threadId: run.nativeSession, input, ...(clientId ? { clientUserMessageId: clientId } : {}), ...selected })); }
      catch (error) { if (error instanceof NativeInputRefused) return { status: "refused", detail: { reason: error.reason } }; throw error; }
      // Native turn/start can echo complete input bodies. Only its bounded
      // acceptance identity belongs in an original receipt.
      check(raw && typeof raw === "object"); const turn = (raw as { turn?: unknown }).turn;
      check(turn && typeof turn === "object"); const turnId = (turn as { id?: unknown }).id;
      check(typeof turnId === "string" && turnId.length > 0 && turnId.length <= 256);
      return validateOutcome({ status: "accepted", detail: { turnId } });
    }
    if (command.type === "answer" && answer) return validateOutcome(await answer(command));
    throw new SessionError("UNSUPPORTED");
  };
}

