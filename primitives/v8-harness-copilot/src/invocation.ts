import { SessionError, type CopilotEncodedAttachment, type ControlCommand, type Json, type NativeControlCommand, type NativeSendCommand, type NativeOutcome } from "../../v8-session/src/contracts/types.js";
import { check, copy, frozen } from "../../v8-session/src/contracts/validation.js";
import { validateOutcome } from "../../v8-session/src/native/validation.js";
import { nativeObject } from "../../v8-harness-defaults/src/state.js";
import { copilotModelMatches } from "./model.js";
import { validateNativeCommand } from "../../v8-harness-defaults/src/prepared-send.js";
import { json, obj, optionalString, optionalBoolean } from "../../v8-harness-defaults/src/invocation-helpers.js";
import type { McpTransports } from "../../v8-mcp/src/contracts.js";
import { copilotConfigured } from "../../v8-mcp/src/native.js";

export function copilotModelOutcome(value: unknown, requested: Readonly<{ model: string; providerId?: string; effort?: string | null }>): NativeOutcome {
  const detail = obj(value);
  for (const key of ["modelId", "queueId", "status", "persistenceError", "warning", "message"]) optionalString(detail, key);
  optionalBoolean(detail, "deferred");
  if (detail.confirmation !== undefined) obj(detail.confirmation);
  let status: NativeOutcome["status"] = "acknowledged";
  if (detail.confirmation !== undefined) status = "confirmationRequired";
  else if (detail.deferred === true) status = "deferred";
  else if (detail.persistenceError !== undefined) status = "acknowledged"; // Applied in memory may coexist with persistence failure.
  else if (detail.status === "refused" || detail.status === "cancelled") status = "refused";
  else {
    const state = detail.modelState === undefined ? undefined : obj(detail.modelState);
    if (copilotModelMatches({ modelId: state?.modelId ?? detail.modelId, providerId: state?.providerId, reasoningEffort: state?.reasoningEffort }, requested)) status = "applied";
  }
  return validateOutcome({ status, detail });
}
export function copilotModeOutcome(value: unknown): NativeOutcome {
  const detail = obj(value); check(typeof detail.status === "string" && typeof detail.modelChanged === "boolean");
  optionalBoolean(detail, "modeApplied"); optionalBoolean(detail, "deferImplementation"); optionalBoolean(detail, "armInteractiveContinuation");
  if (detail.confirmation !== undefined) obj(detail.confirmation);
  let status: NativeOutcome["status"] = "acknowledged";
  if (detail.confirmation !== undefined) status = "confirmationRequired";
  else if (detail.deferImplementation === true) status = "deferred";
  else if (detail.modeApplied === false) status = detail.modelChanged ? "acknowledged" : "refused";
  else if (detail.modeApplied === true) status = "applied";
  return validateOutcome({ status, detail });
}
export interface CopilotControlRpc {
  /** Pinned genuine promptless API. Capability remains withheld until active-empty semantics are qualified. */
  sendMessages?(input: Readonly<{ messages: readonly []; mode: "immediate" }>): Promise<unknown>;
  model: Readonly<{ switchTo(input: Readonly<{ modelId: string; providerId?: string; reasoningEffort?: string | null }>): Promise<unknown> }>;
  mode: Readonly<{ set(input: Readonly<{ mode: "interactive" | "plan" | "autopilot" }>): Promise<unknown> }>;
  permissions: Readonly<{ setMode(input: Readonly<{ mode: "manual" | "allow-all" }>): Promise<unknown> }>;
  queue?: Readonly<{ sendNow(input: Readonly<{ id: string }>): Promise<unknown> }>;
  history?: Readonly<{ compact(input: Readonly<{ trigger: "manual" }>): Promise<unknown> }>;
  tasks?: Readonly<{ cancel(input: Readonly<{ id: string }>): Promise<unknown>; promoteToBackground(input: Readonly<{ id: string }>): Promise<unknown> }>;
  mcp?: Readonly<{ listConfigured(): Promise<unknown>; restartServer(input: Readonly<{ serverName: string }>): Promise<unknown> }>;
  send(input: Readonly<{ prompt: string; mode: "enqueue" | "immediate"; attachments?: readonly CopilotEncodedAttachment[] }>): Promise<unknown>;
  abort(): Promise<unknown>;
}
export function createCopilotInvocation(options: Readonly<{
  rpc: CopilotControlRpc; authorizeProvider?: (providerId: string | undefined) => void;
  mcpTransports?: McpTransports;
  encodeInputs?: (inputs: NativeSendCommand<"copilot">["nativeInputs"]) => Promise<readonly CopilotEncodedAttachment[]>;
  answer?: (command: Extract<ControlCommand, { type: "answer" }>) => Promise<NativeOutcome>;
}>): (command: NativeControlCommand) => Promise<NativeOutcome> {
  const model = options.rpc.model, mode = options.rpc.mode, permissions = options.rpc.permissions, rpc = options.rpc;
  const switchModel = model.switchTo.bind(model), setMode = mode.set.bind(mode), setPermissions = permissions.setMode.bind(permissions),
    send = rpc.send.bind(rpc), abort = rpc.abort.bind(rpc), sendNow = rpc.queue?.sendNow.bind(rpc.queue), cancelTask = rpc.tasks?.cancel.bind(rpc.tasks), promoteTask = rpc.tasks?.promoteToBackground.bind(rpc.tasks), compact = rpc.history?.compact.bind(rpc.history), authorizeProvider = options.authorizeProvider, answer = options.answer, encodeInputs = options.encodeInputs;
  const transports = copy(options.mcpTransports ?? {}), configured = rpc.mcp?.listConfigured.bind(rpc.mcp), restart = rpc.mcp?.restartServer.bind(rpc.mcp);
  return async input => {
    const command = validateNativeCommand("copilot", input);
    if (command.type === "copilot.continue") {
      if (!rpc.sendMessages) return { status: "refused", detail: { reason: "unsupportedNativeMethod" } };
      const result = nativeObject(await rpc.sendMessages({ messages: [], mode: "immediate" }));
      check(Array.isArray(result.messageIds) && result.messageIds.length === 0);
      return { status: "accepted" };
    }
    if (command.type === "copilot.mcp.reconnect") {
      const transport = Object.hasOwn(transports, command.serverName) ? transports[command.serverName] : undefined;
      if (!transport || !configured || !restart) return { status: "refused", detail: { reason: "unsupportedMcpServer" } };
      // This passive read is preparation inside the original, never a second
      // effect/read owner. Unknown, missing or disabled configuration refuses.
      let servers;
      try { servers = copilotConfigured(await configured(), transports); }
      catch { return { status: "refused", detail: { reason: "mcpConfigurationUnavailable" } }; }
      const matches = servers.filter(server => server.name === command.serverName);
      if (matches.length !== 1 || !matches[0]!.enabled) return { status: "refused", detail: { reason: "mcpServerUnavailable" } };
      // Reconnect does not assert that OAuth succeeded or changed persisted
      // credentials. That separate native notification belongs to a positively
      // correlated login, not to every HTTP/SSE connection.
      await restart(frozen({ serverName: command.serverName }));
      return { status: "acknowledged" };
    }
    if (command.type === "copilot.model") {
      authorizeProvider?.(command.providerId);
      const result = await switchModel(frozen({ modelId: command.model,
        ...(command.providerId === undefined ? {} : { providerId: command.providerId }), ...(command.effort === undefined ? {} : { reasoningEffort: command.effort }) }));
      return copilotModelOutcome(result, command);
    }
    if (command.type === "copilot.mode") return copilotModeOutcome(await setMode(frozen({ mode: command.mode })));
    if (command.type === "copilot.permissions") {
      const detail = obj(await setPermissions(frozen({ mode: command.mode }))); check(typeof detail.success === "boolean" && ["manual", "assisted", "allow-all"].includes(String(detail.mode)));
      return validateOutcome({ status: detail.success && detail.mode === command.mode ? "applied" : "refused", detail });
    }
    if (command.type === "copilot.steer") {
      const native = "nativeInputs" in command ? command.nativeInputs : undefined;
      if (native && (!encodeInputs || native.kind !== "copilot")) throw new SessionError("UNSUPPORTED");
      const attachments = native ? await encodeInputs!(native as NativeSendCommand<"copilot">["nativeInputs"]) : undefined;
      const result = nativeObject(await send({ prompt: command.text, mode: "immediate", ...(attachments ? { attachments } : {}) })); check(typeof result.messageId === "string" && result.messageId.length > 0 && result.messageId.length <= 256);
      return validateOutcome({ status: "accepted", detail: { messageId: result.messageId } });
    }
    if (command.type === "copilot.queue.promote" || command.type === "copilot.task.cancel" || command.type === "copilot.task.promote") {
      const method = command.type === "copilot.queue.promote" ? sendNow : command.type === "copilot.task.cancel" ? cancelTask : promoteTask;
      if (!method) return { status: "refused", detail: { reason: "unsupportedNativeMethod" } };
      const key = command.type === "copilot.queue.promote" ? "steered" : command.type === "copilot.task.cancel" ? "cancelled" : "promoted";
      const result = nativeObject(await method({ id: command.id })); check(typeof result[key] === "boolean");
      return validateOutcome({ status: "applied", detail: { id: command.id, [key]: result[key] } });
    }
    if (command.type === "copilot.compact") {
      if (!compact) return { status: "refused", detail: { reason: "unsupportedNativeMethod" } };
      const result = nativeObject(await compact({ trigger: "manual" }));
      check(typeof result.success === "boolean" && typeof result.tokensRemoved === "number" && Number.isFinite(result.tokensRemoved) && typeof result.messagesRemoved === "number" && Number.isFinite(result.messagesRemoved));
      // A summary is transcript content, never copied to the original receipt.
      return validateOutcome({ status: "applied", detail: { success: result.success, tokensRemoved: result.tokensRemoved, messagesRemoved: result.messagesRemoved } });
    }
    if (command.type === "copilot.abort") {
      const result = await abort(); return validateOutcome({ status: "acknowledged", ...(result === undefined ? {} : { detail: json(result) }) });
    }
    if (command.type === "send") {
      // SDK send has no atomic model+mode+permission selection override.
      // Host ordering may apply separate defaults, but this pure port never
      // silently drops a frozen selection or pretends the steps are atomic.
      if (command.selection && Object.keys(command.selection).length > 1) throw new SessionError("UNSUPPORTED", "Copilot Send selection requires explicit Host-ordered substeps");
      const native = "nativeInputs" in command ? command.nativeInputs : undefined;
      if (native && (!encodeInputs || native.kind !== "copilot")) throw new SessionError("UNSUPPORTED");
      const attachments = native ? await encodeInputs!(native as NativeSendCommand<"copilot">["nativeInputs"]) : undefined;
      const raw = await send(frozen({ prompt: command.text, mode: "enqueue", ...(attachments === undefined ? {} : { attachments }) }));
      check(raw && typeof raw === "object"); const messageId = (raw as { messageId?: unknown }).messageId;
      check(typeof messageId === "string" && messageId.length > 0 && messageId.length <= 256);
      return validateOutcome({ status: "accepted", detail: { messageId } });
    }
    if (command.type === "answer" && answer) return validateOutcome(await answer(command));
    throw new SessionError("UNSUPPORTED");
  };
}

