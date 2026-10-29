import { realSdkClient } from "./sdk.js";
import type { CopilotOptions, CopilotNative, CopilotAdapter } from "../node-contracts.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  scopeKey,
  type Json,
  type Original,
  type RunRef,
  type SessionScope,
} from "../../protocol/index.js";
import {
  canonical,
  openingProof,
  type NativeAllocation,
  type NativeOpening,
  type OpeningCapsule,
  type OpeningRef,
  type OpeningStopProof,
  type ReaderCustodyPort,
} from "../../runtime/index.js";
import type { NativeObservation, NativeOpenResult, NativeResult } from "../../host/index.js";
import type {
  CallbackSink,
  CallbackDispatcher,
  CapabilityRef,
  Answer,
} from "../../interactions/index.js";
import type { HistoryReadPort } from "../../history/index.js";
import {
  copilotCommandSchema,
  copilotMessageSchema,
  copilotSelectionSchema,
  copilotObservedSelectionSchema,
  COPILOT_CLI_VERSION,
  type CopilotCommand,
  type CopilotDiagnostic,
  type CopilotLoginLink,
  type CopilotMessage,
  type CopilotModel,
  type CopilotObservedSelection,
  type CopilotRead,
  type CopilotReadResult,
  type CopilotReadResultFor,
  type CopilotTask,
} from "../contracts.js";
import {
  type Invocation,
  type SdkClient,
  type SdkSession,
  type SessionConfig,
} from "../sdk-contracts.js";
import { CopilotHistory, event, historyPort, boundedMetadata } from "./history.js";
import { CopilotReader } from "./reader.js";
import { CopilotMedia } from "./media.js";
import { normalizeCallback } from "./callbacks.js";
import { check, CopilotError, json, object, same, text } from "./validation.js";
export const COPILOT_CLI_ARGS = Object.freeze([
  "--headless",
  "--no-auto-update",
  "--log-level",
  "error",
  "--stdio",
  "--no-auto-login",
]);
type InputHold = {
  nativeId: string | null;
  release(): Promise<void>;
  releasing: boolean;
};
type Slot = {
  owner: NativeAllocation;
  capsule: OpeningCapsule;
  cwd: string;
  home: string;
  claimed: boolean;
  stopped: boolean;
  cleaned: boolean;
  client?: SdkClient;
  session?: SdkSession;
  run?: RunRef;
  selection?: CopilotObservedSelection;
  history?: CopilotHistory;
  media?: CopilotMedia;
  sink?: CallbackSink & Partial<CallbackDispatcher>;
  events: unknown[];
  eventBytes: number;
  stagedCallbacks: Set<() => void>;
  pending: Set<(error: Error) => void>;
  links: Map<
    string,
    {
      url: string;
      expiresAt: number;
    }
  >;
  callbackLinks: Map<number, string>;
  permissionTokens: Map<string, object>;
  inputs: Set<InputHold>;
  sequence: number;
  idleSequence: number;
  consumed: Map<string, number>;
  cleanupFailure: boolean;
  cleanupComplete: boolean;
};
const openingKey = (opening: OpeningRef): string =>
  JSON.stringify([scopeKey(opening.scope), opening.generation, opening.operationId]);
const homeKey = (scope: SessionScope): string =>
  createHash("sha256").update(scopeKey(scope)).digest("hex");
/** Static adapter composition is inert. Only explicit lifecycle methods launch. */
export function createCopilotAdapter(options: CopilotOptions): CopilotAdapter {
  for (const path of [options.binary, options.packageRoot, options.directory, options.homeRoot])
    check(isAbsolute(path), "PRIVATE_PATH");
  check(!options.requireCopilotOnly || options.provider.copilotOnly, "PROVIDER_POLICY");
  if (Object.keys(options.provider.config).length)
    check(options.catalog, "CUSTOM_CATALOG_REQUIRED");
  const staticOptions = json(options.sessionOptions ?? {}, 2 * 1024 * 1024) as Record<string, Json>;
  check(
    Object.keys(staticOptions).every((key) =>
      [
        "availableTools",
        "excludedTools",
        "mcpServers",
        "mcpOAuthTokenStorage",
        "enableConfigDiscovery",
        "enableManagedSettings",
        "customAgents",
        "skillDirectories",
        "systemMessage",
        "modelCapabilities",
        "managedSettings",
      ].includes(key),
    ),
    "STATIC_OPTION",
  );
  const slots = new Map<string, Slot>();
  const unprovedAllocations = new Set<NativeAllocation>();
  const actual = new Set<Promise<unknown>>();
  const readers = new Set<CopilotReader>();
  let closed = false;
  let closing = false;
  let closeFailed = false;
  const makeClient = options.client ?? realSdkClient;
  const now = options.now ?? Date.now;
  function track<T>(promise: Promise<T>): Promise<T> {
    actual.add(promise);
    void promise.finally(() => actual.delete(promise)).catch(() => {});
    return promise;
  }
  const diagnostic = (stage: CopilotDiagnostic["stage"], code: string): void => {
    try {
      options.diagnostic?.({ stage, code });
    } catch {
      /* Diagnostics cannot own native work. */
    }
  };
  function lookup(capsule: OpeningCapsule): Slot {
    check(!closed, "CLOSED");
    const slot = slots.get(openingKey(capsule.opening));
    check(slot && same(slot.capsule, capsule), "OPENING_FENCED");
    return slot;
  }
  function active(run: RunRef): Slot {
    const slot = [...slots.values()].find((value) => value.run && same(value.run, run));
    check(slot && !slot.stopped && slot.session && slot.selection, "RUN_FENCED");
    return slot;
  }
  function environment(home: string): Record<string, string> {
    for (const [name, value] of Object.entries(options.environment))
      check(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string" && !value.includes("\0"),
        "ENVIRONMENT",
      );
    return {
      ...options.environment,
      HOME: home,
      COPILOT_HOME: home,
      XDG_CONFIG_HOME: join(home, "xdg-config"),
      XDG_CACHE_HOME: join(home, "xdg-cache"),
      XDG_DATA_HOME: join(home, "xdg-data"),
    };
  }
  function allocate(opening: OpeningRef, cwd: string, kind: "agent" | "reader"): NativeAllocation {
    check(!closed, "CLOSED");
    const home = join(options.homeRoot, homeKey(opening.scope));
    return options.allocation.allocate({
      directory: options.directory,
      binary: options.binary,
      packageRoot: options.packageRoot,
      home,
      cwd,
      args: COPILOT_CLI_ARGS,
      environment: environment(home),
      reference: canonical(opening),
      kind,
    });
  }
  async function models(client: SdkClient): Promise<readonly CopilotModel[]> {
    if (options.catalog) {
      const result = await options.catalog();
      check(result.length > 0 && result.length <= 256, "MODEL_CATALOG");
      return result.map((value) => ({
        model: text(value.model),
        efforts: value.efforts.map((effort) => text(effort)),
        ...(value.name === undefined ? {} : { name: text(value.name) }),
        ...(value.defaultEffort === undefined ? {} : { defaultEffort: text(value.defaultEffort) }),
      }));
    }
    const values = await client.listModels();
    check(values.length > 0 && values.length <= 256, "MODEL_CATALOG");
    return values.map((value) => {
      const row = object(value);
      check(
        row.supportedReasoningEfforts === undefined || Array.isArray(row.supportedReasoningEfforts),
      );
      return {
        model: text(row.id),
        name: text(row.name),
        efforts: ((row.supportedReasoningEfforts ?? []) as unknown[]).map((value) => text(value)),
        ...(typeof row.defaultReasoningEffort === "string"
          ? { defaultEffort: row.defaultReasoningEffort }
          : {}),
      };
    });
  }
  async function choice(
    client: SdkClient,
    model: string,
    effort: string | null | undefined,
  ): Promise<readonly string[]> {
    const catalog = await models(client);
    const selected = catalog.find((item) => item.model === model);
    check(selected, "MODEL_UNAVAILABLE");
    if (typeof effort === "string") check(selected.efforts.includes(effort), "EFFORT_UNAVAILABLE");
    return catalog.map((item) => item.model);
  }
  async function observed(slot: Slot): Promise<NativeObservation<CopilotObservedSelection>> {
    check(slot.run && slot.session && !slot.stopped, "RUN_FENCED");
    const [model, mode, permission, activity] = await Promise.all([
      slot.session.rpc.model.getCurrent(),
      slot.session.rpc.mode.get(),
      slot.session.rpc.permissions.getMode(),
      slot.session.rpc.metadata.activity(),
    ]);
    check(!slot.stopped, "RUN_FENCED");
    const current = object(model),
      permissions = object(permission),
      state = object(activity);
    check(
      ["interactive", "plan", "autopilot"].includes(String(mode)) &&
        ["manual", "assisted", "allow-all"].includes(String(permissions.mode)),
      "SELECTION_UNOBSERVED",
    );
    check(
      typeof state.hasActiveWork === "boolean" && typeof state.abortable === "boolean",
      "ACTIVITY_SHAPE",
    );
    const parsed = copilotSelectionSchema.parse({
      kind: "copilot",
      model: text(current.modelId),
      ...(current.reasoningEffort === undefined ? {} : { effort: current.reasoningEffort }),
      mode,
      permissions: permissions.mode,
    });
    slot.selection = {
      ...parsed,
      nativeProviderId: typeof current.providerId === "string" ? text(current.providerId) : null,
    };
    const value: NativeObservation<CopilotObservedSelection> = {
      run: slot.run,
      selection: copilotObservedSelectionSchema.parse(slot.selection),
      activity: state.hasActiveWork || state.abortable ? "working" : "idle",
    };
    try {
      options.observe?.(value);
    } catch {
      /* Consumers do not own effects. */
    }
    return value;
  }
  function gap(slot: Slot, code: string): void {
    slot.history?.gap(code);
    slot.sink?.nativeGap();
    diagnostic("history", code);
  }
  function callbackGap(slot: Slot, code: string): void {
    slot.history?.root().update({ gaps: [{ id: `copilot:callback:${code}`, kind: "identity" }] });
    slot.sink?.nativeGap();
    diagnostic("callback", code);
  }
  function cleaned(slot: Slot): void {
    slot.cleaned =
      slot.stopped && slot.cleanupComplete && !slot.cleanupFailure && slot.inputs.size === 0;
  }
  function releaseInput(slot: Slot, hold: InputHold): void {
    if (hold.releasing) return;
    hold.releasing = true;
    void track(
      hold.release().then(
        () => {
          slot.inputs.delete(hold);
          cleaned(slot);
        },
        () => {
          slot.cleanupFailure = true;
          diagnostic("sdk", "INPUT_RELEASE_UNPROVED");
        },
      ),
    );
  }
  function releaseConsumed(slot: Slot): void {
    for (const hold of slot.inputs)
      if (
        hold.nativeId !== null &&
        slot.consumed.has(hold.nativeId) &&
        slot.idleSequence > slot.consumed.get(hold.nativeId)!
      )
        releaseInput(slot, hold);
  }
  function acceptEvent(slot: Slot, raw: unknown): void {
    try {
      if (slot.stopped) return;
      if (!slot.history) {
        const encoded = json(raw, 8 * 1024 * 1024);
        check(
          slot.events.length < 256 &&
            slot.eventBytes + JSON.stringify(encoded).length * 2 <= 16 * 1024 * 1024,
          "EARLY_EVENT_CAPACITY",
        );
        slot.events.push(encoded);
        slot.eventBytes += JSON.stringify(encoded).length * 2;
        return;
      }
      const value = slot.history.observe(slot.media!.project(event(raw)));
      if (!value) return;
      slot.sequence++;
      if (!value.agentId && slot.inputs.size) {
        const message =
          value.type === "user.message"
            ? value.data.messageId
            : value.type === "assistant.message"
              ? value.data.originatingMessageId
              : undefined;
        if (typeof message === "string") {
          slot.consumed.set(message, slot.sequence);
          while (slot.consumed.size > 128) slot.consumed.delete(slot.consumed.keys().next().value!);
        }
        if (value.type === "session.idle") slot.idleSequence = slot.sequence;
        releaseConsumed(slot);
      }
      try {
        if (value.type === "permission.requested" && value.data.resolvedByHook !== true) {
          check(slot.run && slot.sink && slot.session, "CALLBACK_SINK_REQUIRED");
          const requestId = text(value.data.requestId),
            owner = slot.history.owner(value),
            request = json(value.data.permissionRequest, 65536),
            nativeKey = JSON.stringify([owner.nativeAgent, requestId]);
          check(
            slot.permissionTokens.size < 128 && !slot.permissionTokens.has(nativeKey),
            "PERMISSION_ID_REUSE",
          );
          const capability = {};
          slot.permissionTokens.set(nativeKey, capability);
          const managed = object(request).managedApprovalRequired === true;
          slot.sink.capture({
            run: slot.run,
            attachment: slot.capsule.identity.attachment,
            owner,
            nativeRequestId: requestId,
            capability,
            prompt: {
              type: "copilot.permission",
              title: "Tool permission",
              request,
              managedApprovalRequired: managed,
            },
            reply: async (answer) => {
              active(slot.run!);
              const response = object(
                await slot.session!.rpc.permissions.handlePendingPermissionRequest({
                  requestId,
                  result: {
                    kind: answer.kind,
                    ...(answer.feedback === undefined ? {} : { feedback: answer.feedback }),
                  },
                }),
              );
              check(typeof response.success === "boolean", "PERMISSION_ACK");
              return { kind: "confirmed", accepted: response.success };
            },
          });
        }
        if (value.type === "permission.completed" && slot.run && slot.sink) {
          const owner = slot.history.owner(value),
            capability = slot.permissionTokens.get(
              JSON.stringify([owner.nativeAgent, text(value.data.requestId)]),
            );
          if (capability)
            slot.sink.confirm(slot.run, slot.capsule.identity.attachment, capability, true);
        }
      } catch (error) {
        callbackGap(slot, error instanceof CopilotError ? error.code : "PERMISSION_CAPTURE_FAILED");
      }
      if (
        !value.agentId &&
        [
          "session.model_change",
          "session.mode_changed",
          "session.permissions_changed",
          "session.idle",
          "assistant.turn_start",
          "session.error",
        ].includes(value.type)
      )
        void track(
          observed(slot).catch(() => {
            if (!slot.stopped) {
              slot.sink?.disconnected();
              diagnostic("sdk", "OBSERVATION_FAILED");
            }
          }),
        );
    } catch (error) {
      gap(slot, error instanceof CopilotError ? error.code : "EVENT_INVALID");
    }
  }
  function callback(
    slot: Slot,
    type: "question" | "plan" | "elicitation",
    request: unknown,
    invocation: Invocation,
  ): Promise<Json> {
    return new Promise((resolve, reject) => {
      check(!slot.stopped, "NATIVE_STOPPED");
      check(slot.pending.size < 128, "CALLBACK_CAPACITY");
      const refuse = (error: Error): void => {
        slot.pending.delete(refuse);
        reject(error);
      };
      slot.pending.add(refuse);
      const capture = (): void => {
        try {
          check(slot.run && slot.history && slot.sink && !slot.stopped, "CALLBACK_SINK_REQUIRED");
          check(invocation.sessionId === slot.run.nativeSession, "CALLBACK_SESSION_FENCED");
          const owner = slot.history.rootCallbackOwner(),
            normalized = normalizeCallback(type, request),
            capability = {};
          const ref = slot.sink.capture({
            run: slot.run,
            attachment: slot.capsule.identity.attachment,
            owner,
            nativeRequestId: null,
            capability,
            prompt: normalized.prompt,
            reply: async (answer) => {
              active(slot.run!);
              const result = normalized.encode(answer);
              slot.pending.delete(refuse);
              resolve(result);
              return { kind: "submitted" };
            },
          });
          if (normalized.privateUrl) slot.callbackLinks.set(ref.incarnation, normalized.privateUrl);
        } catch (error) {
          callbackGap(slot, "CALLBACK_OWNER_UNPROVED");
          refuse(error instanceof Error ? error : new CopilotError("CALLBACK_INVALID"));
        }
      };
      if (slot.run) capture();
      else {
        check(slot.stagedCallbacks.size < 128, "CALLBACK_CAPACITY");
        slot.stagedCallbacks.add(capture);
      }
    });
  }
  async function stopSlot(slot: Slot): Promise<OpeningStopProof> {
    const identity = await slot.owner.stop();
    const proof = openingProof(slot.capsule, {
      ...slot.capsule,
      identity,
      state: "stopped",
      scope: "nativeTree",
      noAutomaticContinuation: true,
      acquisitionSealed: true,
    });
    if (!slot.stopped) {
      slot.stopped = true;
      slot.sink?.confirmedStopped({
        run: slot.run!,
        attachment: slot.capsule.identity.attachment,
        confirmed: true,
      });
      for (const reject of [...slot.pending]) reject(new CopilotError("NATIVE_STOPPED"));
      slot.stagedCallbacks.clear();
      slot.links.clear();
      slot.callbackLinks.clear();
      slot.history?.close();
      void track(
        (async () => {
          const cleanup = await Promise.allSettled([
            slot.client?.forceStop(),
            ...[...slot.inputs]
              .filter((hold) => !hold.releasing)
              .map(async (hold) => {
                hold.releasing = true;
                await hold.release();
                slot.inputs.delete(hold);
              }),
          ]);
          slot.cleanupFailure ||= cleanup.some((value) => value.status === "rejected");
          slot.cleanupComplete = true;
          cleaned(slot);
          if (slot.cleanupFailure) diagnostic("sdk", "CLEANUP_UNPROVED");
        })(),
      );
    }
    return proof;
  }
  const rawNative: Omit<CopilotNative, "readiness" | "close"> = {
    identity: { id: "multiplex.copilot", version: 1, recordVersion: 1 },
    commandInput: copilotCommandSchema,
    messageInput: copilotMessageSchema,
    selectionInput: copilotSelectionSchema,
    selectionOutput: copilotObservedSelectionSchema,
    async prepare(input) {
      if (input.mode === "create" && input.selectionSource !== "requested")
        return { state: "refused", noAllocation: true, code: "INVALID" } as const;
      const selection = (
        input.selectionSource === "observed"
          ? copilotObservedSelectionSchema
          : copilotSelectionSchema
      ).safeParse(input.selection);
      if (!selection.success)
        return { state: "refused", noAllocation: true, code: "INVALID" } as const;
      if (selection.data.effort === null)
        return { state: "refused", noAllocation: true, code: "UNSUPPORTED" } as const;
      if (input.mode === "reopen" && input.previousSelection !== undefined) {
        const requested = object(input.selection),
          previous = object(input.previousSelection);
        for (const key of ["mode", "permissions"]) {
          if (
            Object.hasOwn(requested, key) &&
            (typeof previous[key] !== "string" || requested[key] !== previous[key])
          )
            return { state: "refused", noAllocation: true, code: "UNSUPPORTED" } as const;
        }
      }
      for (const [key, slot] of slots) if (slot.cleaned) slots.delete(key);
      if (
        [...slots.values()].some(
          (slot) => scopeKey(slot.capsule.opening.scope) === scopeKey(input.opening.scope),
        )
      )
        return { state: "refused", noAllocation: true, code: "BUSY" } as const;
      check(slots.size < 128, "OPENING_CAPACITY");
      const id = openingKey(input.opening);
      check(!slots.has(id), "OPENING_REUSE");
      const owner = allocate(input.opening, input.cwd, "agent");
      let held: NativeOpening;
      try {
        held = await owner.opening(input.opening);
      } catch (error) {
        try {
          await owner.stop();
        } catch (cleanup) {
          unprovedAllocations.add(owner);
          throw new AggregateError(
            [error, cleanup],
            "Copilot parked acquisition cleanup unproved",
            { cause: cleanup },
          );
        }
        throw error;
      }
      const capsule = { opening: held.opening, identity: held.identity };
      const slot: Slot = {
        owner,
        capsule,
        cwd: input.cwd,
        home: join(options.homeRoot, homeKey(input.opening.scope)),
        claimed: false,
        stopped: false,
        cleaned: false,
        events: [],
        eventBytes: 0,
        stagedCallbacks: new Set(),
        pending: new Set(),
        links: new Map(),
        callbackLinks: new Map(),
        permissionTokens: new Map(),
        inputs: new Set(),
        sequence: 0,
        idleSequence: 0,
        consumed: new Map(),
        cleanupFailure: false,
        cleanupComplete: false,
      };
      slots.set(id, slot);
      return { ...capsule, stop: () => stopSlot(slot) };
    },
    async open(input): Promise<NativeOpenResult<CopilotObservedSelection>> {
      const slot = lookup(input.capsule);
      check(!slot.claimed && !slot.stopped && slot.cwd === input.cwd, "OPENING_USED");
      slot.claimed = true;
      const selected = (
        input.selectionSource === "observed"
          ? copilotObservedSelectionSchema
          : copilotSelectionSchema
      ).parse(input.selection);
      check(
        !(input.mode === "create" && selected.effort === null),
        "CREATE_CLEAR_EFFORT_UNSUPPORTED",
      );
      await mkdir(slot.home, { recursive: true, mode: 0o700 });
      const launcher = await slot.owner.prepare();
      slot.owner.assertLaunchable();
      slot.client = await makeClient({
        launcher: launcher.launcher,
        home: slot.home,
        cwd: slot.cwd,
        environment: environment(slot.home),
      });
      if (slot.stopped) {
        await slot.client.forceStop();
        throw new CopilotError("NATIVE_STOPPED");
      }
      await slot.client.start();
      if (slot.stopped) {
        await slot.client.forceStop();
        throw new CopilotError("NATIVE_STOPPED");
      }
      check((await slot.client.getStatus()).version === COPILOT_CLI_VERSION, "CLI_PIN");
      const allowedModels = await choice(slot.client, selected.model, selected.effort);
      check(!slot.stopped && !slot.owner.sealed, "NATIVE_STOPPED");
      const sessionId = input.mode === "create" ? randomUUID() : text(input.nativeSession);
      const config: SessionConfig = {
        ...staticOptions,
        sessionId,
        model: selected.model,
        allowedModels,
        ...(Object.keys(options.provider.config).length
          ? { provider: json(options.provider.config) }
          : {}),
        workingDirectory: slot.cwd,
        ...(typeof selected.effort === "string" ? { reasoningEffort: selected.effort } : {}),
        streaming: true,
        includeSubAgentStreamingEvents: true,
        mcpOAuthTokenStorage: staticOptions.mcpOAuthTokenStorage ?? "in-memory",
        onEvent: (raw) => acceptEvent(slot, raw),
        onPermissionRequest: () => ({ kind: "no-result" }),
        onUserInputRequest: (request, invocation) =>
          callback(slot, "question", request, invocation),
        onExitPlanModeRequest: (request, invocation) => callback(slot, "plan", request, invocation),
        onElicitationRequest: (request) =>
          callback(slot, "elicitation", request, { sessionId: text(object(request).sessionId) }),
      };
      slot.session =
        input.mode === "create"
          ? await slot.client.createSession(config)
          : await slot.client.resumeSession(sessionId, {
              ...config,
              continuePendingWork: true,
              allowTranscriptRecovery: false,
            });
      check(slot.session.sessionId === sessionId, "SESSION_ID_FENCED");
      slot.run = {
        scope: input.capsule.opening.scope,
        generation: input.capsule.opening.generation,
        nativeSession: slot.session.sessionId,
      };
      input.commitBinding(slot.run);
      if (slot.stopped) {
        await slot.client.forceStop();
        throw new CopilotError("NATIVE_STOPPED");
      }
      slot.history = new CopilotHistory(
        slot.run,
        input.capsule.identity.attachment,
        input.mode === "create",
      );
      slot.media = new CopilotMedia(
        slot.run,
        input.capsule.identity.attachment,
        options.media,
        track,
        (asset) => {
          if (slot.stopped || !slot.history) return;
          try {
            for (const stream of slot.history.streams()) {
              const window = slot.history.window(stream);
              for (const row of window.getSnapshot().rows) {
                const assets = row.native.assets;
                if (
                  !Array.isArray(assets) ||
                  !assets.some(
                    (value) =>
                      value &&
                      typeof value === "object" &&
                      !Array.isArray(value) &&
                      value.id === asset.id,
                  )
                )
                  continue;
                window.update({
                  rows: [
                    {
                      id: row.id,
                      kind: row.kind,
                      lifecycle: row.lifecycle,
                      body: row.body,
                      native: boundedMetadata({
                        ...row.native,
                        assets: assets.map((value) =>
                          value &&
                          typeof value === "object" &&
                          !Array.isArray(value) &&
                          value.id === asset.id
                            ? asset
                            : value,
                        ),
                      }),
                    },
                  ],
                });
              }
            }
          } catch {
            diagnostic("history", "MEDIA_PUBLICATION_FAILED");
          }
        },
      );
      if (options.interactions)
        slot.sink = options.interactions(slot.run, input.capsule.identity.attachment);
      for (const raw of slot.events) acceptEvent(slot, raw);
      slot.events = [];
      slot.eventBytes = 0;
      for (const capture of slot.stagedCallbacks) capture();
      slot.stagedCallbacks.clear();
      if (input.mode === "create") {
        const permission = object(
          await slot.session.rpc.permissions.setMode({ mode: selected.permissions }),
        );
        check(
          permission.success === true && permission.mode === selected.permissions,
          "PERMISSION_REFUSED",
        );
        const mode = object(
          await slot.session.rpc.mode.set({
            mode: selected.mode,
            planModelConfigured: true,
            planModel: selected.model,
            restorePlanModel: false,
            ...(typeof selected.effort === "string"
              ? { planReasoningEffort: selected.effort }
              : {}),
          }),
        );
        check(
          mode.modeApplied === true &&
            mode.modelChanged === false &&
            !mode.confirmation &&
            !mode.deferImplementation,
          "MODE_UNAPPLIED",
        );
      }
      check(
        object(await slot.session.rpc.permissions.setRequired({ required: true })).success === true,
        "PERMISSION_BRIDGE_REQUIRED",
      );
      const observation = await observed(slot);
      check(slot.selection!.model === selected.model, "SELECTED_MODEL_CHANGED");
      if (typeof selected.effort === "string")
        check(slot.selection!.effort === selected.effort, "SELECTED_EFFORT_CHANGED");
      if (input.mode === "create") {
        check(observation.activity === "idle", "CREATE_NOT_QUIESCENT");
        return { ...observation, kind: "created", quiescent: true };
      }
      return { ...observation, kind: "reopened" };
    },
    async inspect(capsule) {
      const slot = slots.get(openingKey(capsule.opening));
      if (slot && same(slot.capsule, capsule)) {
        if (slot.stopped)
          return openingProof(capsule, {
            ...capsule,
            state: "stopped",
            scope: "nativeTree",
            noAutomaticContinuation: true,
            acquisitionSealed: true,
          });
        if (slot.run) return observed(slot);
      }
      const found = await options.allocation.inspectOpening(capsule);
      return found && "state" in found ? found : null;
    },
    stop: async (capsule) => {
      const slot = slots.get(openingKey(capsule.opening));
      if (slot) return stopSlot(lookup(capsule));
      const found = await options.allocation.inspectOpening(capsule);
      check(found, "OPENING_UNAVAILABLE");
      return openingProof(capsule, "state" in found ? found : await found.stop());
    },
    async send(input) {
      const slot = lookup(input.capsule);
      check(slot === active(input.run), "RUN_FENCED");
      return send(slot, copilotMessageSchema.parse(input.message), "enqueue");
    },
    async command(input) {
      const slot = lookup(input.capsule);
      check(slot === active(input.run), "RUN_FENCED");
      return command(slot, input.originalId, input.command, input.original);
    },
  };
  async function send(
    slot: Slot,
    message: CopilotMessage,
    mode: "enqueue" | "immediate",
  ): Promise<NativeResult> {
    check(slot.run && slot.session, "RUN_FENCED");
    let prepared: Awaited<ReturnType<NonNullable<CopilotOptions["prepareInputs"]>>> | undefined;
    let hold: InputHold | undefined;
    let dispatched = false;
    try {
      if (message.files.length) {
        check(options.prepareInputs, "INPUT_PREPARER_REQUIRED");
        prepared = await options.prepareInputs(slot.run, message.files);
        active(slot.run);
        check(slot.inputs.size < 32, "INPUT_HOLD_CAPACITY");
        hold = { nativeId: null, release: () => prepared!.release(), releasing: false };
        slot.inputs.add(hold);
      }
      dispatched = true;
      const id = await slot.session.send({
        prompt: message.text,
        mode,
        ...(prepared === undefined ? {} : { attachments: prepared.attachments }),
      });
      if (hold) {
        hold.nativeId = text(id);
        releaseConsumed(slot);
      }
      active(slot.run);
      return { state: "succeeded", result: { messageId: text(id), delivery: mode } };
    } catch (error) {
      if (!dispatched) await prepared?.release();
      throw error;
    }
  }
  async function command(
    slot: Slot,
    original: string,
    input: CopilotCommand,
    admitted: Original,
  ): Promise<NativeResult> {
    check(slot.session && slot.client && slot.run && slot.selection, "RUN_FENCED");
    const session = slot.session;
    let result: Json;
    switch (input.type) {
      case "answer": {
        if (!slot.sink?.dispatch)
          return { state: "refused", result: { reason: "INTERACTION_DISPATCH_UNAVAILABLE" } };
        check(
          same(input.reference.run, slot.run) &&
            input.reference.attachment === slot.capsule.identity.attachment,
          "CALLBACK_FENCED",
        );
        check(
          admitted.id === original && scopeKey(admitted.scope) === scopeKey(slot.run.scope),
          "ORIGINAL_FENCED",
        );
        const view = await slot.sink.dispatch(
          input.reference,
          admitted,
          json(input.answer) as Answer,
        );
        check(view.state !== "unknown" && view.state !== "submitting", "CALLBACK_DELIVERY_UNKNOWN");
        return {
          state: view.state === "retired" ? "refused" : "succeeded",
          result: { reference: json(view.reference), state: view.state, accepted: view.accepted },
        };
      }
      case "model": {
        await choice(slot.client, input.model, input.effort);
        active(slot.run);
        const response = object(
          await session.rpc.model.switchTo({
            modelId: input.model,
            ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
            requireAvailable: true,
          }),
        );
        await observed(slot);
        result = {
          status: response.confirmation
            ? "confirmationRequired"
            : response.deferred
              ? "deferred"
              : slot.selection.model === input.model &&
                  (input.effort === undefined ||
                    (typeof input.effort === "string" && slot.selection.effort === input.effort))
                ? "applied"
                : "submitted",
          selection: json(slot.selection),
        };
        break;
      }
      case "mode": {
        const response = object(
          await session.rpc.mode.set({
            mode: input.mode,
            planModelConfigured: true,
            planModel: slot.selection.model,
            restorePlanModel: false,
          }),
        );
        await observed(slot);
        result = {
          status: response.confirmation
            ? "confirmationRequired"
            : response.deferImplementation
              ? "deferred"
              : slot.selection.mode === input.mode
                ? "applied"
                : "submitted",
          selection: json(slot.selection),
        };
        break;
      }
      case "permissions": {
        const response = object(await session.rpc.permissions.setMode({ mode: input.mode }));
        check(typeof response.success === "boolean");
        await observed(slot);
        result = {
          applied: response.success && slot.selection.permissions === input.mode,
          selection: json(slot.selection),
        };
        break;
      }
      case "abort":
        await session.abort();
        result = { acknowledged: true };
        break;
      case "steer":
        return send(slot, input.message, "immediate");
      case "queue.promote": {
        const response = object(await session.rpc.queue.sendNow({ id: input.id }));
        check(typeof response.steered === "boolean");
        result = { id: input.id, steered: response.steered };
        break;
      }
      case "task.cancel":
      case "task.promote": {
        const response = object(
          await (input.type === "task.cancel"
            ? session.rpc.tasks.cancel({ id: input.id })
            : session.rpc.tasks.promoteToBackground({ id: input.id })),
        );
        const key = input.type === "task.cancel" ? "cancelled" : "promoted";
        check(typeof response[key] === "boolean");
        result = { id: input.id, [key]: response[key] as boolean };
        break;
      }
      case "compact": {
        const response = object(await session.rpc.history.compact({ trigger: "manual" }));
        check(
          typeof response.success === "boolean" &&
            Number.isSafeInteger(response.tokensRemoved) &&
            Number.isSafeInteger(response.messagesRemoved),
        );
        result = {
          success: response.success,
          tokensRemoved: response.tokensRemoved as number,
          messagesRemoved: response.messagesRemoved as number,
        };
        break;
      }
      case "mcp.restart":
      case "mcp.login": {
        const config = object(staticOptions.mcpServers ?? {});
        check(Object.hasOwn(config, input.server), "MCP_UNKNOWN_CONFIGURATION");
        const configured = object(config[input.server]);
        const response = object(await session.rpc.mcp.listConfigured());
        active(slot.run);
        check(
          Array.isArray(response.servers) &&
            response.servers.some((raw) => {
              const row = object(raw);
              return row.name === input.server && row.enabled === true;
            }),
          "MCP_DISABLED",
        );
        if (input.type === "mcp.restart") {
          await session.rpc.mcp.restartServer({ serverName: input.server });
          result = { acknowledged: true };
        } else {
          check(
            staticOptions.mcpOAuthTokenStorage !== "persistent" &&
              ["http", "sse"].includes(String(configured.type)),
            "MCP_CREDENTIAL_SCOPE_UNSUPPORTED",
          );
          check(!slot.links.has(original) && slot.links.size < 16, "MCP_LOGIN_CAPACITY");
          slot.links.set(original, { url: "", expiresAt: now() + 300000 });
          const login = object(
            await session.rpc.mcp.oauth.login({
              serverName: input.server,
              ...(input.forceReauth === undefined ? {} : { forceReauth: input.forceReauth }),
            }),
          );
          if (login.authorizationUrl !== undefined) {
            const url = new URL(text(login.authorizationUrl, 8192));
            check(url.protocol === "https:" && !url.username && !url.password, "MCP_LOGIN_URL");
            slot.links.set(original, { url: url.href, expiresAt: now() + 300000 });
          }
          result = { login: login.authorizationUrl === undefined ? "reused" : "initiated" };
        }
        break;
      }
    }
    active(slot.run);
    return { state: "succeeded", result };
  }
  async function read(run: RunRef, request: CopilotRead): Promise<CopilotReadResult> {
    const slot = active(run),
      session = slot.session!;
    if (request.type === "selection") return (await observed(slot)).selection;
    if (request.type === "models") return { choices: await models(slot.client!) };
    if (request.type === "queue") {
      const result = object(await session.rpc.queue.pendingItems());
      const items = result.items;
      check(
        Array.isArray(items) &&
          items.length <= 128 &&
          Array.isArray(result.steeringMessages) &&
          result.steeringMessages.length <= 128,
        "QUEUE_BOUND",
      );
      return {
        items: items.map((raw) => {
          const item = object(raw);
          return {
            id: text(item.id),
            text: typeof item.displayText === "string" ? item.displayText : "",
            kind: text(item.kind),
            agentMode: text(item.agentMode),
            ...(typeof item.messageId === "string" ? { messageId: item.messageId } : {}),
          };
        }),
        steeringMessages: result.steeringMessages.map((value) => text(value, 65536)),
        ...(Number.isSafeInteger(result.inFlightSteeringCount)
          ? { inFlightSteeringCount: result.inFlightSteeringCount as number }
          : {}),
        ...(typeof result.withdrawableTurnMessageId === "string"
          ? { withdrawableTurnMessageId: result.withdrawableTurnMessageId }
          : {}),
      };
    }
    if (request.type === "mcp") {
      const result = object(await session.rpc.mcp.listConfigured());
      check(Array.isArray(result.servers) && result.servers.length <= 128);
      return result.servers.map((raw) => {
        const server = object(raw),
          live = object(server.live);
        check(typeof server.enabled === "boolean");
        return { name: text(server.name), enabled: server.enabled, status: text(live.status) };
      });
    }
    if (request.type === "tasks") {
      await session.rpc.tasks.refresh();
      active(run);
      const result = object(await session.rpc.tasks.list());
      check(Array.isArray(result.tasks) && result.tasks.length <= 128);
      return { tasks: result.tasks.map(task) };
    }
    if (request.type === "task.progress") {
      const response = object(await session.rpc.tasks.getProgress({ id: text(request.id) }));
      if (response.progress === null || response.progress === undefined) return { progress: null };
      const progress = object(response.progress),
        safe: Record<string, Json> & { type: string } = { type: text(progress.type) };
      for (const key of [
        "recentOutput",
        "latestIntent",
        "phase",
        "lastMessage",
        "status",
        "updatedAt",
      ])
        if (typeof progress[key] === "string") safe[key] = text(progress[key], 16384);
      for (const key of ["sequence", "percentage"])
        if (typeof progress[key] === "number" && Number.isFinite(progress[key]))
          safe[key] = progress[key];
      if (Array.isArray(progress.recentActivity)) {
        check(progress.recentActivity.length <= 128, "TASK_PROGRESS_BOUND");
        safe.recentActivity = progress.recentActivity.map((raw) => {
          const line = object(raw);
          return { message: text(line.message, 4096), timestamp: text(line.timestamp) };
        });
      }
      json(safe, 32768);
      return { progress: safe };
    }
    const value = object(await session.rpc.tasks.getCurrentPromotable());
    return value.task === undefined ? { task: null } : { task: task(value.task) };
  }
  function task(raw: unknown): CopilotTask {
    const value = object(raw);
    const result = {
      id: text(value.id),
      kind: (value.type === "agent"
        ? "agent"
        : value.type === "shell"
          ? "shell"
          : "client") as CopilotTask["kind"],
      status: text(value.status),
      description: typeof value.description === "string" ? value.description : "",
    } as { -readonly [K in keyof CopilotTask]: CopilotTask[K] };
    for (const key of ["model", "resolvedModel", "error", "result"] as const)
      if (typeof value[key] === "string") result[key] = value[key];
    if (typeof value.canPromoteToBackground === "boolean")
      result.canPromote = value.canPromoteToBackground;
    return result;
  }
  async function coldHistory(
    run: RunRef,
    custody: ReaderCustodyPort,
    stream = "root",
  ): Promise<
    Readonly<{
      port: HistoryReadPort;
      close(): Promise<void>;
      usable(): boolean;
    }>
  > {
    check(!closed, "CLOSED");
    check(readers.size < 4, "READER_CAPACITY");
    check(![...readers].some((reader) => reader.logicalScope === scopeKey(run.scope)), "BUSY");
    const opening: OpeningRef = {
      scope: run.scope,
      generation: run.generation,
      operationId: `history:${randomUUID()}`,
    };
    const home = join(options.homeRoot, homeKey(run.scope));
    const media = new CopilotMedia(run, opening.operationId, options.media, track, () => {});
    const reader = new CopilotReader(
      {
        run,
        opening,
        stream,
        custody,
        project: (input) => media.settled(media.project(input)),
        allocate: () => allocate(opening, options.directory, "reader"),
        client: makeClient,
        input: (launcher) => ({
          launcher,
          home,
          cwd: options.directory,
          environment: environment(home),
        }),
      },
      () => readers.delete(reader),
    );
    readers.add(reader);
    await reader.open();
    const port = reader.port();
    return {
      usable: () => reader.usable,
      port: { ...port, read: (input, current) => track(port.read(input, current)) },
      close: () => track(reader.close()),
    };
  }
  function readiness() {
    return !closing &&
      !closeFailed &&
      unprovedAllocations.size === 0 &&
      actual.size === 0 &&
      [...slots.values()].every((slot) => slot.cleaned)
      ? { ready: true as const }
      : { ready: false as const, reasons: ["Copilot native or auxiliary custody remains"] };
  }
  const native: CopilotNative = {
    ...rawNative,
    prepare: (input) => track(rawNative.prepare(input)),
    open: (input) => track(rawNative.open(input)),
    inspect: (input) => track(rawNative.inspect(input)),
    stop: (input) => track(rawNative.stop(input)),
    send: (input) => track(rawNative.send(input)),
    command: (input) => track(rawNative.command(input)),
    readiness,
    async close() {
      if (closed && !closeFailed) return;
      check(readiness().ready, "COPILOT_BUSY");
      closed = true;
      closing = true;
      try {
        const results = await Promise.allSettled([...readers].map((reader) => reader.close()));
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Copilot reader cleanup unproved",
          );
        slots.clear();
      } catch (error) {
        closeFailed = true;
        throw error;
      } finally {
        closing = false;
      }
    },
  };
  return {
    native,
    read: <Request extends CopilotRead>(
      run: RunRef,
      request: Request,
    ): Promise<CopilotReadResultFor<Request>> =>
      track(
        read(run, request).then((value) => {
          active(run);
          return value as CopilotReadResultFor<Request>;
        }),
      ),
    coldHistory: (run: RunRef, custody: ReaderCustodyPort, stream = "root") =>
      track(coldHistory(run, custody, stream)),
    historyScopes(run: RunRef) {
      const history = active(run).history!;
      return history.streams().map((stream) => history.window(stream).scope);
    },
    history(run: RunRef, stream = "root") {
      return active(run).history!.window(stream);
    },
    historyRead(run: RunRef, stream = "root") {
      const slot = active(run),
        window = slot.history!.window(stream),
        port = historyPort(
          window.scope,
          "active",
          (input) => {
            active(run);
            return track(slot.session!.rpc.eventLog.read(input));
          },
          (input) => slot.media!.settled(slot.media!.project(input)),
        );
      return {
        ...port,
        read(input: Parameters<HistoryReadPort["read"]>[0], current: () => void) {
          active(run);
          const release = slot.history!.protect(stream);
          return track(
            port
              .read(input, () => {
                active(run);
                current();
              })
              .finally(release),
          );
        },
      };
    },
    loginLink(run: RunRef, original: string): CopilotLoginLink {
      const value = active(run).links.get(original);
      return !value
        ? { state: "unknown" }
        : value.expiresAt <= now()
          ? { state: "expired" }
          : !value.url
            ? { state: "unknown" }
            : { state: "ready", url: value.url, expiresAt: value.expiresAt };
    },
    callbackLink(run: RunRef, reference: CapabilityRef): string | null {
      const slot = active(run);
      check(
        same(reference.run, run) && reference.attachment === slot.capsule.identity.attachment,
        "CALLBACK_FENCED",
      );
      return slot.callbackLinks.get(reference.incarnation) ?? null;
    },
  };
}
