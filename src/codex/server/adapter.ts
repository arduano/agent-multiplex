import type { CodexOptions, CodexPreparedInputs, CodexNative } from "../node-contracts.js";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  CallbackSink,
  CallbackDispatcher,
  CapabilityRef,
} from "../../interactions/contracts.js";
import type { HistoryReadPort } from "../../history/index.js";
import type {
  NativeObservation,
  NativeOpenResult,
  NativePreparationRefusal,
  NativeResult,
  UpdateReadiness,
} from "../../host/index.js";
import {
  canonical,
  openingCapsule,
  openingProof,
  sameOpening,
  type NativeAllocation,
  type NativeOpening,
  type OpeningCapsule,
  type OpeningRef,
  type OpeningStopProof,
} from "../../runtime/index.js";
import { scopeKey, type RunRef } from "../../protocol/index.js";
import {
  codexCommandSchema,
  codexInputSchema,
  codexMessageSchema,
  codexSelectionSchema,
  codexObservedSelectionSchema,
  type CodexDiagnostic,
  type CodexInput,
  type CodexMessage,
  type CodexPrivateLoginLink,
  type CodexRead,
  type CodexReadResultFor,
  type CodexObservedSelection,
} from "../contracts.js";
import { codexConfig, prepareCodexHome } from "./config.js";
import { invoke, send } from "./commands.js";
import { normalizeCallback } from "./callbacks.js";
import { codexTimelinePage, CodexHistory } from "./history.js";
import { readCodex, readModels } from "./reads.js";
import { CodexMedia } from "./media.js";
import { CodexReader } from "./reader.js";
import type { CodexReaderLease, Notification, ReverseRequest } from "../node-contracts.js";
import { CodexRpc, spawnCodexWire } from "./rpc.js";
import { check, CodexError, equal, object, text } from "./validation.js";
import { json } from "./validation.js";
import { CodexObservation } from "./observation.js";
import { callbackSchema, nativeResults } from "./native-validation.js";
import { proveLineage, threadMetadata } from "./lineage.js";
import type { CodexCaptureCursor, CodexPendingCallback } from "../native-contracts.js";

type InputHold = { prepared: CodexPreparedInputs; turnId: string | null; release?: Promise<void> };
type Held = {
  opening: OpeningRef;
  owner: NativeAllocation;
  capsule?: OpeningCapsule;
  rpc?: CodexRpc;
  run?: RunRef;
  selection?: CodexObservedSelection;
  media?: CodexMedia;
  history?: CodexHistory;
  observation?: CodexObservation;
  nativeCallbacks: Map<number, { value: CodexPendingCallback; reverse: ReverseRequest }>;
  callbackIncarnation: number;
  callbackObservers: Set<() => void>;
  callbacks?: CallbackSink & CallbackDispatcher;
  ready: boolean;
  stopped: boolean;
  starting: boolean;
  pending: (Notification | ReverseRequest)[];
  inputs: Map<string, InputHold>;
  privateLinks: Map<number, string>;
  reverseWaiting: ReverseRequest[];
  logins: Map<string, { link: CodexPrivateLoginLink; loginId?: string; server: string }>;
  cleanup?: Promise<void>;
  cleanupDone?: boolean;
  preparingInputs: number;
};
const safeRefusal = new Set([
  "ALREADY_WORKING",
  "QUEUE_UNAVAILABLE",
  "NO_ACTIVE_TURN",
  "CONTINUE_REQUIRES_POSITIVE_IDLE",
  "COLLABORATION_UNOBSERVED",
  "EMPTY_MESSAGE",
  "INPUT_PREPARER_REQUIRED",
  "MCP_LOGIN_UNSUPPORTED",
  "EMPTY_PREPARED_INPUT",
  "NATIVE_EFFECT_TARGET",
  "NATIVE_ORIGINAL_MISMATCH",
  "NATIVE_CALLBACK_FENCED",
]);

/** Explicit native process adapter. It owns attachment/capture/input leases;
 * default lifecycle alone owns durable originals and logical session state. */
export class CodexAdapter implements CodexNative {
  readonly identity = Object.freeze({ id: "multiplex.codex", version: 1, recordVersion: 1 });
  readonly commandInput = codexCommandSchema;
  readonly messageInput = codexMessageSchema;
  readonly selectionInput = codexSelectionSchema;
  readonly selectionOutput = codexObservedSelectionSchema;
  readonly #sessions = new Map<string, Held>();
  readonly #preparing = new Set<string>();
  readonly #readers = new Set<CodexReader>();
  #closed = false;
  constructor(private readonly options: CodexOptions) {
    for (const path of [
      options.node,
      options.binary,
      options.packageRoot,
      options.directory,
      options.homeRoot,
    ])
      check(isAbsolute(path), "EXPLICIT_PATH_REQUIRED");
    check(
      !options.requireCopilotOnly || options.provider.copilotOnly,
      "COPILOT_ONLY_ROUTE_REQUIRED",
    );
    check(
      typeof options.environment[options.provider.environmentKey] === "string",
      "PROVIDER_CREDENTIAL_REQUIRED",
    );
  }
  #home(scope: RunRef["scope"]): string {
    return join(this.options.homeRoot, createHash("sha256").update(scopeKey(scope)).digest("hex"));
  }
  #key(capsule: { opening: OpeningRef }): string {
    return JSON.stringify([
      scopeKey(capsule.opening.scope),
      capsule.opening.generation,
      capsule.opening.operationId,
    ]);
  }
  #held(capsule: OpeningCapsule): Held {
    const held = this.#sessions.get(this.#key(capsule));
    check(held?.capsule && sameOpening(held.capsule, capsule), "NATIVE_CAPSULE_FENCED");
    return held;
  }
  #current(held: Held, run: RunRef): void {
    check(
      !this.#closed &&
        !held.stopped &&
        !held.owner.sealed &&
        held.rpc?.observation.connected &&
        equal(held.run, run),
      "NATIVE_RUN_FENCED",
    );
  }
  #diagnose(value: CodexDiagnostic): void {
    try {
      this.options.diagnostic?.(value);
    } catch {}
  }
  async prepare(
    input: Parameters<CodexNative["prepare"]>[0],
  ): Promise<NativeOpening | NativePreparationRefusal> {
    if (this.#closed || !isAbsolute(input.cwd))
      return { state: "refused", noAllocation: true, code: "INVALID" };
    const selected = (
      input.selectionSource === "observed" ? codexObservedSelectionSchema : codexSelectionSchema
    ).safeParse(input.selection);
    if (
      !selected.success ||
      (input.mode === "create" && input.selectionSource !== "requested") ||
      (input.mode === "reopen" &&
        (selected.data.access === undefined || selected.data.model === undefined))
    )
      return { state: "refused", noAllocation: true, code: "INVALID" };
    // A requested effort-only Reopen cannot safely replace sticky native
    // collaboration instructions that this small creation policy cannot know.
    // Full native settings remain available after an explicit successful open.
    if (
      input.mode === "reopen" &&
      input.selectionSource === "requested" &&
      selected.data.effort !== undefined &&
      !selected.data.collaboration
    )
      return { state: "refused", noAllocation: true, code: "UNSUPPORTED" };
    try {
      codexConfig(this.options);
    } catch {
      return { state: "refused", noAllocation: true, code: "INVALID" };
    } // Pure local configuration validation, before any resource work.
    const scope = scopeKey(input.opening.scope),
      key = this.#key(input);
    if (this.#preparing.has(scope)) return { state: "refused", noAllocation: true, code: "BUSY" };
    for (const previous of this.#sessions.values())
      if (
        scopeKey(previous.opening.scope) === scope &&
        (!previous.stopped ||
          !previous.cleanupDone ||
          previous.inputs.size ||
          previous.preparingInputs)
      )
        return { state: "refused", noAllocation: true, code: "BUSY" };
    const readers = [...this.#readers].filter(
      (reader) => scopeKey(reader.lease.opening.scope) === scope,
    );
    if (readers.some((reader) => !reader.readyToClose()))
      return { state: "refused", noAllocation: true, code: "BUSY" };
    for (const [id, previous] of this.#sessions)
      if (
        previous.stopped &&
        previous.cleanupDone &&
        !previous.inputs.size &&
        !previous.history?.observed
      ) {
        previous.history?.close();
        this.#sessions.delete(id);
      }
    if (this.#sessions.size + this.#preparing.size >= 256 || this.#sessions.has(key))
      return { state: "refused", noAllocation: true, code: "BUSY" };
    this.#preparing.add(scope);
    try {
      for (const reader of readers) await reader.close();
      const home = this.#home(input.opening.scope);
      await prepareCodexHome(home, this.options);
      const owner = this.options.allocation.allocate({
        directory: this.options.directory,
        binary: this.options.binary,
        packageRoot: this.options.packageRoot,
        home,
        cwd: input.cwd,
        args: ["app-server", "--stdio"],
        environment: { ...this.options.environment, CODEX_HOME: home },
        reference: canonical(input.opening),
        kind: "agent",
      });
      const held: Held = {
        opening: structuredClone(input.opening),
        owner,
        ready: false,
        stopped: false,
        starting: false,
        pending: [],
        reverseWaiting: [],
        inputs: new Map(),
        nativeCallbacks: new Map(),
        callbackIncarnation: 0,
        callbackObservers: new Set(),
        preparingInputs: 0,
        privateLinks: new Map(),
        logins: new Map(),
      };
      this.#sessions.set(key, held);
      const prepared = await owner.opening(input.opening),
        capsule = openingCapsule({ opening: prepared.opening, identity: prepared.identity });
      held.capsule = capsule;
      return { ...capsule, stop: () => this.stop(capsule) };
    } finally {
      this.#preparing.delete(scope);
    }
  }
  async open(
    input: Parameters<CodexNative["open"]>[0],
  ): Promise<NativeOpenResult<CodexObservedSelection>> {
    const held = this.#held(input.capsule);
    check(!held.starting && !held.stopped && !held.owner.sealed, "OPEN_ALREADY_ATTEMPTED");
    held.starting = true;
    if (input.selectionSource === "observed") {
      const observed = codexObservedSelectionSchema.parse(input.selection);
      check(
        input.mode === "reopen" && observed.access !== undefined && observed.model !== undefined,
        "REOPEN_PERMISSIONS_UNOBSERVED",
      );
    }
    if (input.mode === "reopen")
      check(object(input.selection).access !== undefined, "REOPEN_PERMISSIONS_UNOBSERVED");
    const selection = codexSelectionSchema.parse(input.selection),
      access = selection.access,
      home = this.#home(input.capsule.opening.scope);
    const prepared = await held.owner.prepare();
    held.owner.assertLaunchable();
    const rpc = new CodexRpc(
      (this.options.wire ?? spawnCodexWire)({
        node: this.options.node,
        launcher: prepared.launcher,
        cwd: input.cwd,
        environment: { ...this.options.environment, CODEX_HOME: home },
      }),
      (value) => this.#notification(held, value),
      (value) => this.#reverse(held, value),
      () => this.#lost(held),
    );
    held.rpc = rpc;
    await rpc.initialize();
    held.owner.assertLaunchable();
    const fields = {
      model: selection.collaboration?.model ?? selection.model,
      modelProvider: this.options.provider.id,
      cwd: input.cwd,
      approvalPolicy: access.approval,
      ...("profile" in access ? { permissions: access.profile } : { sandbox: access.sandbox }),
      ...(this.options.developerInstructions
        ? { developerInstructions: this.options.developerInstructions }
        : {}),
    };
    check(
      input.mode === "create" ? input.nativeSession === null : !!input.nativeSession,
      "OPEN_MODE",
    );
    const raw = object(
        await rpc.request(
          input.mode === "create" ? "thread/start" : "thread/resume",
          input.mode === "create"
            ? { ...fields, ephemeral: false }
            : { ...fields, threadId: input.nativeSession, excludeTurns: true },
        ),
      ),
      thread = object(raw.thread),
      threadId = text(thread.id);
    check(input.mode === "create" || threadId === input.nativeSession, "RESUME_CHANGED_IDENTITY");
    held.run = {
      scope: input.capsule.opening.scope,
      generation: input.capsule.opening.generation,
      nativeSession: threadId,
    };
    // Identity is a native fact before settings can succeed or their reply can
    // be lost. The lifecycle synchronously commits it in the original journal.
    input.commitBinding(held.run);
    held.observation = new CodexObservation(
      held.run,
      input.capsule.identity.attachment,
      undefined,
      input.mode === "create" ? "created" : "resumed",
    );
    held.observation.observe({ method: "thread/started", params: { thread } });
    check(
      raw.model === fields.model &&
        raw.modelProvider === this.options.provider.id &&
        raw.approvalPolicy === access.approval,
      "OBSERVED_SELECTION_DIFFERS",
    );
    if ("profile" in access)
      check(
        object(raw.activePermissionProfile).id === access.profile,
        "OBSERVED_PERMISSIONS_DIFFER",
      );
    else
      check(
        object(raw.sandbox).type ===
          (
            {
              "danger-full-access": "dangerFullAccess",
              "workspace-write": "workspaceWrite",
              "read-only": "readOnly",
            } as const
          )[access.sandbox],
        "OBSERVED_SANDBOX_DIFFERS",
      );
    const observedAccess =
      raw.activePermissionProfile != null
        ? { approval: access.approval, profile: text(object(raw.activePermissionProfile).id) }
        : access;
    held.selection = {
      kind: "codex",
      model: raw.model as string,
      access: observedAccess,
      ...(raw.reasoningEffort === null || typeof raw.reasoningEffort === "string"
        ? { effort: raw.reasoningEffort }
        : {}),
    };
    this.#settings(held, {
      ...raw,
      sandboxPolicy: raw.sandbox,
      ...(raw.reasoningEffort === undefined ? {} : { effort: raw.reasoningEffort }),
    });
    held.media = new CodexMedia(
      held.run,
      input.capsule.identity.attachment,
      this.options.media,
      (stream) => {
        try {
          return held.history?.window(stream);
        } catch {
          return undefined;
        }
      },
      () => !held.stopped && !this.#closed,
    );
    held.history = new CodexHistory(
      held.run,
      input.capsule.identity.attachment,
      (value) => this.#diagnose(value),
      input.mode === "create",
      held.media,
    );
    held.history.ingest({ method: "thread/started", params: { thread } });
    if (this.options.interactions)
      held.callbacks = this.options.interactions(held.run, input.capsule.identity.attachment);
    for (const pending of held.pending.splice(0))
      if ("capability" in pending) this.#reverse(held, pending);
      else this.#notification(held, pending);
    if (
      input.mode === "reopen" &&
      input.selectionSource === "observed" &&
      !selection.collaboration &&
      selection.effort !== undefined
    )
      check(raw.reasoningEffort === selection.effort, "REOPEN_EFFORT_UNOBSERVED");
    else if (selection.effort !== undefined || selection.collaboration) {
      const collaboration = selection.collaboration ?? {
        mode: "default" as const,
        model: selection.model,
        effort: selection.effort!,
        instructions: null,
      };
      const result = object(
        await rpc.request("thread/settings/update", {
          threadId,
          ...(selection.effort === undefined ? {} : { effort: selection.effort }),
          collaborationMode: {
            mode: collaboration.mode,
            settings: {
              model: collaboration.model,
              reasoning_effort: collaboration.effort,
              developer_instructions: collaboration.instructions,
            },
          },
        }),
      );
      check(Object.keys(result).length === 0, "INITIAL_SETTINGS_ACK");
    }
    const status = object(thread.status).type,
      observation = rpc.observation;
    if (input.mode === "create")
      check(
        ["idle", "notLoaded"].includes(String(status)) &&
          observation.connected &&
          observation.turnStarts === 0 &&
          observation.itemStarts === 0 &&
          observation.reverse === 0,
        "FRESH_QUIESCENCE_UNPROVED",
      );
    const captured = held.history.activity();
    const activity =
      captured.state === "working" || status === "active"
        ? "working"
        : captured.state === "idle" ||
            captured.state === "failed" ||
            (status === "idle" && observation.turnStarts === 0 && observation.itemStarts === 0) ||
            input.mode === "create"
          ? "idle"
          : "unknown";
    if (captured.state === "unknown")
      held.history.window().update({ activity: { state: activity, turnId: captured.turnId } });
    held.ready = true;
    setImmediate(() => {
      if (!held.stopped && !this.#closed) this.#publish(held);
    });
    return {
      kind: input.mode === "create" ? "created" : "reopened",
      ...(input.mode === "create" ? { quiescent: true as const } : {}),
      run: held.run,
      activity,
      selection: codexObservedSelectionSchema.parse(held.selection),
    } as NativeOpenResult<CodexObservedSelection>;
  }
  #settings(held: Held, raw: Record<string, unknown>): void {
    if (!held.selection) return;
    const selected = { ...held.selection };
    if (Object.hasOwn(raw, "model")) {
      delete selected.model;
      if (typeof raw.model === "string") selected.model = text(raw.model);
      if (raw.effort === undefined) delete selected.effort;
    }
    if (Object.hasOwn(raw, "effort")) {
      delete selected.effort;
      if (raw.effort === null || typeof raw.effort === "string") selected.effort = raw.effort;
    }
    if (Object.hasOwn(raw, "collaborationMode")) {
      delete selected.collaboration;
      if (raw.collaborationMode != null) {
        const mode = object(raw.collaborationMode),
          value = object(mode.settings);
        if (
          value.developer_instructions === null ||
          typeof value.developer_instructions === "string"
        )
          selected.collaboration = {
            mode: mode.mode as "plan" | "default",
            model: text(value.model),
            effort: value.reasoning_effort === null ? null : text(value.reasoning_effort),
            instructions: value.developer_instructions,
          };
      }
    } else if (raw.model !== undefined || raw.effort !== undefined) delete selected.collaboration;
    if (
      raw.approvalPolicy !== undefined ||
      raw.sandboxPolicy !== undefined ||
      raw.activePermissionProfile !== undefined
    ) {
      delete selected.access;
      const approval = raw.approvalPolicy;
      if (["on-request", "never", "untrusted"].includes(String(approval))) {
        if (raw.activePermissionProfile)
          selected.access = {
            approval: approval as "on-request",
            profile: text(object(raw.activePermissionProfile).id),
          };
        else if (raw.sandboxPolicy) {
          const type = object(raw.sandboxPolicy).type,
            mode =
              type === "dangerFullAccess"
                ? "danger-full-access"
                : type === "workspaceWrite"
                  ? "workspace-write"
                  : type === "readOnly"
                    ? "read-only"
                    : null;
          if (mode) selected.access = { approval: approval as "on-request", sandbox: mode };
        }
      }
    }
    held.selection = codexObservedSelectionSchema.parse(selected);
  }
  #notification(held: Held, value: Notification): void {
    if (held.stopped) return;
    if (!held.run || !held.history) {
      check(held.pending.length < 64, "PREBIND_CAPACITY");
      held.pending.push(value);
      return;
    }
    // Capture the validated native envelope independently of the optional
    // generic UI projection. A projection failure cannot lose native evidence.
    try {
      held.observation?.observe(value);
    } catch {
      held.observation?.gap();
      this.#diagnose({ stage: "codec", code: "NATIVE_OBSERVATION_REJECTED" });
    }
    try {
      const params = value.params && typeof value.params === "object" ? object(value.params) : {};
      if (value.method === "thread/settings/updated" && params.threadId === held.run.nativeSession)
        this.#settings(held, object(params.threadSettings));
      held.history.ingest(value);
      for (const request of [...held.reverseWaiting])
        if (
          held.observation?.owner(String(object(request.params).threadId)) ||
          held.history.owner(String(object(request.params).threadId))
        ) {
          held.reverseWaiting.splice(held.reverseWaiting.indexOf(request), 1);
          this.#reverse(held, request);
        }
      if (value.method === "turn/completed" && params.threadId === held.run.nativeSession) {
        const turnId = text(object(params.turn).id);
        for (const hold of held.inputs.values())
          if (hold.turnId === turnId) void this.#releaseInput(held, hold).catch(() => {});
      }
      if (
        ["item/started", "item/completed"].includes(value.method) &&
        params.threadId === held.run.nativeSession &&
        params.item
      ) {
        const item = object(params.item),
          originalId = item.clientUserMessageId;
        if (item.type === "userMessage" && typeof originalId === "string") {
          const hold = held.inputs.get(originalId);
          if (hold) {
            hold.turnId = text(params.turnId);
            if (held.history.terminalTurn(hold.turnId))
              void this.#releaseInput(held, hold).catch(() => {});
          }
        }
      }
      if (
        value.method === "mcpServer/oauthLogin/completed" &&
        params.threadId === held.run.nativeSession
      )
        for (const login of held.logins.values())
          if (
            login.loginId === params.loginId &&
            login.server === params.name &&
            typeof params.success === "boolean"
          )
            login.link = { state: "complete", success: params.success };
      if (held.ready) this.#publish(held);
    } catch {
      if (value.method === "thread/settings/updated") held.selection = { kind: "codex" };
      this.#diagnose({ stage: "codec", code: "NOTIFICATION_REJECTED" });
      held.history.lost();
      if (held.ready) this.#publish(held);
    }
  }
  #reverse(held: Held, request: ReverseRequest): void {
    if (held.stopped) return;
    if (!held.run || !held.history) {
      check(held.pending.length < 64, "PREBIND_CAPACITY");
      held.pending.push(request);
      return;
    }
    this.#captureNativeCallback(held, request);
    let release: (() => void) | undefined;
    try {
      const thread = text(object(request.params).threadId),
        owner = held.observation?.owner(thread) ?? held.history.owner(thread);
      if (!owner) {
        check(held.reverseWaiting.length < 8, "CALLBACK_ANCESTRY_CAPACITY");
        held.reverseWaiting.push(request);
        void request.settled.catch(() => {
          const index = held.reverseWaiting.indexOf(request);
          if (index >= 0) held.reverseWaiting.splice(index, 1);
        });
        return;
      }
      // The native request handle is sufficient custody. Normalized popup
      // integration is an optional projection of that same one-shot handle.
      if (!held.callbacks) return;
      const normalized = normalizeCallback(request, thread),
        run = held.run,
        attachment = held.capsule!.identity.attachment;
      release = held.history.owner(thread) ? held.history.protect(thread) : () => {};
      const ref = held.callbacks.capture({
        run,
        attachment,
        owner,
        nativeRequestId: JSON.stringify(request.id),
        capability: request.capability,
        prompt: normalized.prompt,
        reply: async (answer) => {
          this.#current(held, run);
          check(held.history!.owner(thread), "CALLBACK_OWNER_RETIRED");
          await request.reply(normalized.encode(answer));
          return { kind: "submitted" };
        },
      });
      if (normalized.privateUrl) held.privateLinks.set(ref.incarnation, normalized.privateUrl);
      const heldRelease = release;
      release = undefined;
      void request.settled
        .then(
          () => {
            try {
              held.callbacks?.confirm(run, attachment, request.capability, true);
            } finally {
              held.privateLinks.delete(ref.incarnation);
              heldRelease();
            }
          },
          (error) => {
            try {
              if (error instanceof CodexError && error.code === "REVERSE_WITHDRAWN")
                held.callbacks?.confirm(run, attachment, request.capability, false);
              else held.callbacks?.nativeGap();
            } finally {
              held.privateLinks.delete(ref.incarnation);
              heldRelease();
            }
          },
        )
        .catch(() => {
          held.callbacks?.nativeGap();
        });
    } catch {
      release?.();
      held.callbacks?.nativeGap();
      this.#diagnose({ stage: "callback", code: "REVERSE_REJECTED" });
    }
  }
  #captureNativeCallback(held: Held, reverse: ReverseRequest): void {
    if (
      !held.run ||
      !held.observation ||
      [...held.nativeCallbacks.values()].some((value) => value.reverse === reverse)
    )
      return;
    try {
      const request = callbackSchema.parse({ method: reverse.method, params: reverse.params });
      check(
        held.observation.owner(text(object(request.params).threadId)),
        "CALLBACK_OWNER_UNPROVED",
      );
      check(
        held.nativeCallbacks.size < 32 && held.callbackIncarnation < Number.MAX_SAFE_INTEGER,
        "CALLBACK_CAPACITY",
      );
      const incarnation = ++held.callbackIncarnation;
      const value: CodexPendingCallback = {
        reference: {
          run: held.run,
          attachment: held.capsule!.identity.attachment,
          requestId: reverse.id,
          incarnation,
        },
        request,
        submitted: false,
      };
      held.nativeCallbacks.set(incarnation, { value, reverse });
      for (const notify of held.callbackObservers) notify();
      const retire = () => {
        held.nativeCallbacks.delete(incarnation);
        for (const notify of held.callbackObservers) notify();
      };
      void reverse.settled.then(retire, retire);
    } catch {
      this.#diagnose({ stage: "callback", code: "NATIVE_CALLBACK_UNAVAILABLE" });
    }
  }
  #publish(held: Held): void {
    if (!held.run || !held.selection || !held.history || held.stopped) return;
    const state = held.history.activity().state;
    try {
      this.options.observe?.({
        run: held.run,
        selection: codexObservedSelectionSchema.parse(held.selection),
        activity:
          state === "working"
            ? "working"
            : state === "idle" || state === "failed"
              ? "idle"
              : "unknown",
      });
    } catch {
      this.#diagnose({ stage: "codec", code: "LIFECYCLE_OBSERVER_REJECTED" });
    }
  }
  #lost(held: Held): void {
    if (held.stopped) return;
    held.history?.lost();
    held.observation?.gap();
    held.callbacks?.disconnected();
    this.#publish(held);
    this.#diagnose({ stage: "wire", code: "WIRE_LOST" });
  }
  async inspect(
    capsule: OpeningCapsule,
  ): Promise<NativeObservation<CodexObservedSelection> | OpeningStopProof | null> {
    const native = await this.options.allocation.inspectOpening(capsule);
    if (!native) return null;
    if ("state" in native) return openingProof(capsule, native);
    const held = this.#sessions.get(this.#key(capsule));
    if (!held?.run || !held.selection) return null;
    const activity = held.history?.activity().state;
    return {
      run: held.run,
      selection: codexObservedSelectionSchema.parse(held.selection),
      activity: !held.rpc?.observation.connected
        ? "unknown"
        : activity === "working"
          ? "working"
          : activity === "idle" || activity === "failed"
            ? "idle"
            : "unknown",
    };
  }
  async stop(capsule: OpeningCapsule): Promise<OpeningStopProof> {
    capsule = openingCapsule({ opening: capsule.opening, identity: capsule.identity });
    const held = this.#sessions.get(this.#key(capsule));
    const observed =
      held?.capsule && sameOpening(held.capsule, capsule)
        ? {
            ...capsule,
            stop: async () => ({
              ...capsule,
              identity: await held.owner.stop(),
              state: "stopped" as const,
              scope: "nativeTree" as const,
              acquisitionSealed: true as const,
              noAutomaticContinuation: true as const,
            }),
          }
        : await this.options.allocation.inspectOpening(capsule);
    check(observed, "NATIVE_STOP_OWNER_UNPROVED");
    const proof = openingProof(capsule, "state" in observed ? observed : await observed.stop());
    if (held) {
      held.stopped = true;
      held.media?.seal();
      held.privateLinks.clear();
      held.logins.clear();
      held.observation?.close();
      held.nativeCallbacks.clear();
      for (const notify of held.callbackObservers) notify();
      held.reverseWaiting.length = 0;
      if (held.run)
        held.callbacks?.confirmedStopped({
          run: held.run,
          attachment: capsule.identity.attachment,
          confirmed: true,
        });
      held.cleanup ??= (async () => {
        const cleanup = await Promise.allSettled([
          held.rpc?.close(),
          held.media?.settled(),
          ...[...held.inputs.values()].map((value) => this.#releaseInput(held, value)),
        ]);
        check(
          cleanup.every((value) => value.status === "fulfilled"),
          "NATIVE_ATTACHMENT_CLEANUP_UNKNOWN",
        );
        held.cleanupDone = true;
      })();
      void held.cleanup.catch(() => {});
    }
    return proof;
  }
  async #releaseInput(held: Held, hold: InputHold): Promise<void> {
    await (hold.release ??= hold.prepared.release());
    for (const [id, value] of held.inputs) if (value === hold) held.inputs.delete(id);
  }
  async #input(
    held: Held,
    run: RunRef,
    originalId: string,
    message: CodexMessage,
  ): Promise<readonly CodexInput[]> {
    if (!message.attachments.length) return [];
    check(this.options.prepareInputs, "INPUT_PREPARER_REQUIRED");
    check(held.inputs.size < 128, "INPUT_LEASE_CAPACITY");
    held.preparingInputs++;
    let prepared: CodexPreparedInputs;
    try {
      prepared = await this.options.prepareInputs({
        run,
        originalId,
        attachments: message.attachments,
      });
    } finally {
      held.preparingInputs--;
    }
    const hold: InputHold = { prepared, turnId: null };
    held.inputs.set(originalId, hold);
    try {
      this.#current(held, run);
      check(prepared.inputs.length > 0, "EMPTY_PREPARED_INPUT");
      return prepared.inputs.map((value) => codexInputSchema.parse(value));
    } catch (error) {
      await this.#releaseInput(held, hold);
      throw error;
    }
  }
  async send(input: Parameters<CodexNative["send"]>[0]): Promise<NativeResult> {
    const held = this.#held(input.capsule);
    this.#current(held, input.run);
    let message: CodexMessage;
    try {
      message = codexMessageSchema.parse(input.message);
    } catch {
      return { state: "refused", result: { reason: "Invalid Codex message" } };
    }
    try {
      const prepared = await this.#input(held, input.run, input.originalId, message);
      this.#current(held, input.run);
      const result = await send(
        held.rpc!,
        input.run.nativeSession,
        input.originalId,
        message,
        held.selection!,
        prepared,
      );
      const hold = held.inputs.get(input.originalId);
      if (hold) {
        hold.turnId = text(object(result).turnId);
        if (held.history!.terminalTurn(hold.turnId))
          void this.#releaseInput(held, hold).catch(() => {});
      }
      return { state: "succeeded", result };
    } catch (error) {
      if (error instanceof CodexError && safeRefusal.has(error.code)) {
        const hold = held.inputs.get(input.originalId);
        if (hold) await this.#releaseInput(held, hold);
        return { state: "refused", result: { reason: error.code } };
      }
      throw error;
    }
  }
  async command(input: Parameters<CodexNative["command"]>[0]): Promise<NativeResult> {
    const held = this.#held(input.capsule);
    this.#current(held, input.run);
    const command = codexCommandSchema.parse(input.command);
    try {
      if (command.type === "nativeAnswer") {
        const reference = command.reference;
        check(
          equal(reference.run, input.run) &&
            reference.attachment === held.capsule!.identity.attachment,
          "NATIVE_CALLBACK_FENCED",
        );
        const callback = held.nativeCallbacks.get(reference.incarnation);
        check(
          callback &&
            equal(callback.value.reference, reference) &&
            callback.value.request.method === command.answer.method &&
            !callback.value.submitted &&
            held.observation?.owner(text(object(callback.value.request.params).threadId)),
          "NATIVE_CALLBACK_FENCED",
        );
        callback.value = { ...callback.value, submitted: true };
        for (const notify of held.callbackObservers) notify();
        await callback.reverse.reply(json(command.answer.response));
        this.#current(held, input.run);
        return { state: "succeeded", result: { submitted: true } };
      }
      if (command.type === "native") {
        check(command.params.threadId === input.run.nativeSession, "NATIVE_EFFECT_TARGET");
        if (
          (command.method === "turn/start" ||
            command.method === "turn/steer" ||
            command.method === "thread/queue/add") &&
          command.params.clientUserMessageId != null
        )
          check(
            command.params.clientUserMessageId === input.originalId,
            "NATIVE_ORIGINAL_MISMATCH",
          );
        const params =
          command.method === "turn/start" || command.method === "turn/steer"
            ? {
                ...command.params,
                clientUserMessageId: command.params.clientUserMessageId ?? input.originalId,
              }
            : command.params;
        const raw = await held.rpc!.request(command.method, json(params));
        this.#current(held, input.run);
        const output =
          command.method === "turn/start"
            ? nativeResults.turnStart
            : command.method === "turn/steer"
              ? nativeResults.turnSteer
              : command.method === "turn/interrupt"
                ? nativeResults.turnInterrupt
                : command.method === "turn/settings/update"
                  ? nativeResults.turnSettingsUpdate
                  : command.method === "thread/settings/update"
                    ? nativeResults.settingsUpdate
                    : command.method === "thread/queue/add"
                      ? nativeResults.queueAdd
                      : command.method === "thread/queue/start"
                        ? nativeResults.queueStart
                        : command.method === "thread/queue/update"
                          ? nativeResults.queueUpdate
                          : command.method === "thread/queue/delete"
                            ? nativeResults.queueDelete
                            : command.method === "thread/queue/reorder"
                              ? nativeResults.queueReorder
                              : command.method === "thread/goal/set"
                                ? nativeResults.goalSet
                                : command.method === "thread/goal/clear"
                                  ? nativeResults.goalClear
                                  : command.method === "thread/backgroundTerminals/terminate"
                                    ? nativeResults.terminalTerminate
                                    : command.method === "thread/backgroundTerminals/clean"
                                      ? nativeResults.terminalsClean
                                      : nativeResults.compactStart;
        return { state: "succeeded", result: json(output.parse(raw)) };
      }
      if (command.type === "answer") {
        check(
          held.callbacks &&
            equal(command.reference.run, input.run) &&
            command.reference.attachment === held.capsule!.identity.attachment,
          "CALLBACK_SCOPE_FENCED",
        );
        check(
          input.original.id === input.originalId &&
            scopeKey(input.original.scope) === scopeKey(input.run.scope),
          "CALLBACK_ORIGINAL_FENCED",
        );
        const result = await held.callbacks.dispatch(
          command.reference,
          input.original,
          command.answer,
        );
        check(
          result.state === "submitted" || result.state === "confirmed",
          "CALLBACK_DELIVERY_UNKNOWN",
        );
        return { state: "succeeded", result: { status: result.state, accepted: result.accepted } };
      }
      if (command.type === "mcp.login") {
        check(
          this.options.mcpServers?.[command.serverName]?.type === "http",
          "MCP_LOGIN_UNSUPPORTED",
        );
        for (const [id, login] of held.logins)
          if (
            login.link.state === "complete" ||
            login.link.state === "expired" ||
            (login.link.state === "ready" && login.link.expiresAt <= Date.now())
          )
            held.logins.delete(id);
        check(held.logins.size < 8, "LOGIN_CAPACITY");
        const login: { link: CodexPrivateLoginLink; loginId?: string; server: string } = {
          link: { state: "unknown" },
          server: command.serverName,
        };
        held.logins.set(input.originalId, login);
        const result = object(
          await held.rpc!.request("mcpServer/oauth/login", {
            threadId: input.run.nativeSession,
            name: command.serverName,
            timeoutSecs: 120,
          }),
        );
        this.#current(held, input.run);
        const url = new URL(text(result.authorizationUrl, 8192));
        check(["http:", "https:"].includes(url.protocol) && !url.username && !url.password);
        login.loginId = text(result.loginId);
        login.link = { state: "ready", url: url.href, expiresAt: Date.now() + 120000 };
        return { state: "succeeded", result: { login: "initiated" } };
      }
      const prepared =
        command.type === "queue" || command.type === "steer"
          ? await this.#input(held, input.run, input.originalId, command.message)
          : [];
      this.#current(held, input.run);
      const result = await invoke(
        held.rpc!,
        input.run.nativeSession,
        input.originalId,
        command,
        held.selection!,
        held.history!.activity(),
        prepared,
      );
      const hold = held.inputs.get(input.originalId);
      if (hold && command.type === "steer") {
        hold.turnId = command.expectedTurnId;
        if (held.history!.terminalTurn(hold.turnId))
          void this.#releaseInput(held, hold).catch(() => {});
      }
      return { state: "succeeded", result };
    } catch (error) {
      if (error instanceof CodexError && safeRefusal.has(error.code)) {
        const hold = held.inputs.get(input.originalId);
        if (hold) await this.#releaseInput(held, hold);
        return { state: "refused", result: { reason: error.code } };
      }
      throw error;
    }
  }
  history(run: RunRef): CodexHistory {
    for (const held of this.#sessions.values())
      if (equal(held.run, run) && held.history) return held.history;
    throw new CodexError("HISTORY_BINDING_MISSING");
  }
  #forRun(run: RunRef): Held {
    const held = [...this.#sessions.values()].find((value) => equal(value.run, run));
    check(held, "NATIVE_RUN_FENCED");
    this.#current(held, run);
    return held;
  }
  observation(run: RunRef) {
    const held = this.#forRun(run);
    check(held.observation, "NATIVE_OBSERVATION_UNAVAILABLE");
    return held.observation.snapshot();
  }
  watchObservation(run: RunRef, after?: CodexCaptureCursor) {
    const held = this.#forRun(run);
    check(held.observation, "NATIVE_OBSERVATION_UNAVAILABLE");
    return held.observation.watch(after);
  }
  pendingCallbacks(run: RunRef): readonly CodexPendingCallback[] {
    const held = this.#forRun(run);
    // JSON cloning intentionally removes shared RunRef aliases across pending
    // handles; published transports require a plain DTO tree, not a graph.
    return json(
      [...held.nativeCallbacks.values()].map((value) => value.value),
    ) as unknown as readonly CodexPendingCallback[];
  }
  watchCallbacks(run: RunRef): AsyncIterableIterator<readonly CodexPendingCallback[]> {
    const held = this.#forRun(run);
    check(held.callbackObservers.size < 32, "CALLBACK_OBSERVER_CAPACITY");
    let queued: readonly CodexPendingCallback[] | undefined = this.pendingCallbacks(run),
      ended = false;
    let waiting: ((part: IteratorResult<readonly CodexPendingCallback[]>) => void) | undefined;
    const close = () => {
      ended = true;
      queued = undefined;
      held.callbackObservers.delete(notify);
      waiting?.({ done: true, value: undefined });
      waiting = undefined;
    };
    const notify = () => {
      if (held.stopped || this.#closed) {
        close();
        return;
      }
      const snapshot = this.pendingCallbacks(run);
      if (waiting) {
        const current = waiting;
        waiting = undefined;
        current({ done: false, value: snapshot });
      } else queued = snapshot;
    };
    held.callbackObservers.add(notify);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        check(!waiting, "CONCURRENT_CALLBACK_NEXT");
        if (ended) return { done: true, value: undefined };
        if (queued) {
          const value = queued;
          queued = undefined;
          return { done: false, value };
        }
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      return: async () => {
        close();
        return { done: true, value: undefined };
      },
    };
  }
  /** Exact read-only native methods. Child reads prove metadata ancestry; a
   * proof never creates live ownership or resumes a selected child. */
  async nativeRead(run: RunRef, method: string, input: unknown): Promise<unknown> {
    const held = this.#forRun(run),
      params = object(json(input));
    check(
      [
        "thread/read",
        "thread/turns/list",
        "thread/items/list",
        "model/list",
        "thread/queue/list",
        "thread/goal/get",
        "thread/backgroundTerminals/list",
        "mcpServerStatus/list",
      ].includes(method),
      "NATIVE_READ_UNSUPPORTED",
    );
    if (params.limit != null)
      check(
        Number.isSafeInteger(params.limit) &&
          Number(params.limit) > 0 &&
          Number(params.limit) <= 128,
        "NATIVE_READ_BOUND",
      );
    if (method.startsWith("thread/")) {
      const selected = text(params.threadId);
      if (selected !== run.nativeSession) {
        const metadata: unknown[] = [];
        const root = object(
          await held.rpc!.request("thread/read", {
            threadId: run.nativeSession,
            includeTurns: false,
          }),
        ).thread;
        this.#current(held, run);
        check(object(root).id === run.nativeSession, "NATIVE_READ_ROOT");
        metadata.push(root);
        const seen = new Set<string>();
        let current = selected;
        for (let depth = 0; current !== run.nativeSession && depth < 32; depth++) {
          check(!seen.has(current), "ANCESTRY_CYCLE");
          seen.add(current);
          const node = object(
            await held.rpc!.request("thread/read", { threadId: current, includeTurns: false }),
          ).thread;
          this.#current(held, run);
          check(object(node).id === current, "NATIVE_READ_THREAD");
          metadata.push(node);
          const parent = threadMetadata(node).parent;
          check(parent, "ANCESTRY_UNPROVED");
          current = parent;
        }
        proveLineage(run.nativeSession, selected, metadata);
      }
    }
    this.#current(held, run);
    const raw = json(await held.rpc!.request(method, params));
    this.#current(held, run);
    if (method === "thread/read")
      check(object(object(raw).thread).id === params.threadId, "NATIVE_READ_THREAD");
    if (method === "thread/items/list" && params.turnId != null) {
      const rows = object(raw).data;
      check(Array.isArray(rows), "NATIVE_READ_ITEMS");
      check(
        rows.every((row) => object(row).turnId === params.turnId),
        "NATIVE_READ_TURN",
      );
    }
    return raw;
  }
  /** Read-only exception port on the retained live attachment. The07
   * acquisition owner supplies the shared actual-I/O budget and public cursor. */
  historyRead(run: RunRef, stream = run.nativeSession): HistoryReadPort {
    const held = [...this.#sessions.values()].find((value) => equal(value.run, run));
    check(held?.history, "HISTORY_BINDING_MISSING");
    this.#current(held, run);
    check(held.history.owner(stream, true), "UNPROVED_THREAD");
    const window = held.history.window(stream);
    return {
      scope: window.scope,
      mode: "repeatable",
      read: async (input, assertCurrent) => {
        this.#current(held, run);
        assertCurrent();
        check(held.history!.owner(stream, true), "UNPROVED_THREAD");
        check(
          Number.isSafeInteger(input.count) &&
            input.count > 0 &&
            input.count <= 128 &&
            (input.cursor === null ||
              (typeof input.cursor === "string" && input.cursor.length <= 8192)),
          "HISTORY_READ_INPUT",
        );
        const release = held.history!.protect(stream, true);
        try {
          const raw = await held.rpc!.request("thread/timeline/list", {
            threadId: stream,
            cursor: input.cursor,
            limit: input.count,
          });
          this.#current(held, run);
          assertCurrent();
          check(held.history!.owner(stream, true), "UNPROVED_THREAD");
          codexTimelinePage(window.scope, raw);
          await held.media?.preparePage(
            raw,
            () => {
              this.#current(held, run);
              assertCurrent();
            },
            stream,
          );
          this.#current(held, run);
          assertCurrent();
          return codexTimelinePage(window.scope, raw, held.media);
        } finally {
          release();
        }
      },
    };
  }
  async read<Request extends CodexRead>(
    run: RunRef,
    request: Request,
  ): Promise<CodexReadResultFor<Request>> {
    const held = [...this.#sessions.values()].find((value) => equal(value.run, run));
    check(held, "NATIVE_RUN_FENCED");
    this.#current(held, run);
    return readCodex(held.rpc!, run.nativeSession, request, () => this.#current(held, run));
  }
  loginLink(run: RunRef, originalId: string): CodexPrivateLoginLink {
    const held = [...this.#sessions.values()].find((value) => equal(value.run, run));
    check(held, "NATIVE_RUN_FENCED");
    this.#current(held, run);
    const login = held.logins.get(originalId);
    check(login, "LOGIN_ORIGINAL_MISSING");
    if (login.link.state === "ready" && login.link.expiresAt <= Date.now())
      login.link = { state: "expired" };
    return structuredClone(login.link);
  }
  requestLink(reference: CapabilityRef): string {
    const held = [...this.#sessions.values()].find(
      (value) =>
        equal(value.run, reference.run) &&
        value.capsule?.identity.attachment === reference.attachment,
    );
    check(held, "CALLBACK_SCOPE_FENCED");
    this.#current(held, reference.run);
    const url = held.privateLinks.get(reference.incarnation);
    check(url, "CALLBACK_LINK_MISSING");
    return url;
  }
  async reader(lease: CodexReaderLease): Promise<CodexReader> {
    check(!this.#closed && this.#readers.size < 2, "READER_CAPACITY");
    const scope = scopeKey(lease.opening.scope);
    check(
      !this.#preparing.has(scope) &&
        ![...this.#readers].some((reader) => reader.logicalScope === scope),
      "BUSY",
    );
    const reader = new CodexReader(
      { ...this.options, home: this.#home(lease.opening.scope), cwd: this.options.directory },
      lease,
      () => {
        this.#readers.delete(reader);
      },
    );
    this.#readers.add(reader);
    let opening = false;
    try {
      for (const held of this.#sessions.values())
        if (scopeKey(held.opening.scope) === scope)
          check(
            held.stopped && (await held.owner.inspect()) === "gone",
            "LIVE_NATIVE_READER_REFUSED",
          );
      check(!this.#closed, "ADAPTER_CLOSED");
      opening = true;
      await reader.open();
      return reader;
    } catch (error) {
      if (!opening) this.#readers.delete(reader); // No lease or native resource was acquired.
      throw error; // Failed actual cleanup remains retained; no replacement is licensed.
    }
  }
  async models(lease: CodexReaderLease) {
    const reader = await this.reader(lease);
    try {
      return await readModels(reader, () => reader.assertCurrent());
    } finally {
      await reader.close();
      this.#readers.delete(reader);
    }
  }
  readiness(): UpdateReadiness {
    return !this.#preparing.size &&
      [...this.#readers].every((value) => value.readyToClose()) &&
      [...this.#sessions.values()].every(
        (value) =>
          value.stopped && value.cleanupDone && !value.inputs.size && value.preparingInputs === 0,
      )
      ? { ready: true }
      : { ready: false, reasons: ["Codex retains native, input or reader custody"] };
  }
  async close(): Promise<void> {
    check(
      !this.#preparing.size && [...this.#sessions.values()].every((value) => value.stopped),
      "STOP_SESSIONS_BEFORE_ADAPTER_CLOSE",
    );
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#readers]
        .map((reader) => reader.close())
        .concat(
          [...this.#sessions.values()].flatMap((held) => (held.cleanup ? [held.cleanup] : [])),
        ),
    );
    check(
      results.every((value) => value.status === "fulfilled") && this.readiness().ready,
      "ADAPTER_CLEANUP_UNKNOWN",
    );
    for (const held of this.#sessions.values()) held.history?.close();
    this.#sessions.clear();
  }
}

export function createCodexAdapter(options: CodexOptions): CodexAdapter {
  return new CodexAdapter(options);
}
export function codexHarness(options: CodexOptions) {
  const adapter = createCodexAdapter(options);
  return Object.freeze({
    identity: adapter.identity,
    nativeKind: "codex" as const,
    capabilities: ["history.streaming", "lifecycle.full-stop", "native.codex"] as const,
    adapter,
  });
}
