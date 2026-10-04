import { copilotImageCodec } from "./images.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type ElicitationHandler,
  type ExitPlanModeHandler,
  type ModelInfo,
  type ModelCapabilities,
  type PermissionHandler,
  type ProviderConfig,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionMetadata,
} from "@github/copilot-sdk";
export type { ProviderConfig as CopilotProviderConfig } from "@github/copilot-sdk";
import {
  adapterScopeIdSchema,
  newRuntimeEpoch,
  type AdapterScopeId,
  type HarnessCatalogEntry,
  type HarnessResumeOptions,
  type HarnessSessionSettings,
  type HarnessSpawnOptions,
  type JsonObject,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeEpoch,
  type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import {
  AdapterOutcomeUnknownError,
  RuntimeNodeProtocolError,
  type AdapterSession,
  type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";

import { copilotJson } from "./json.js";
import { copilotOptionalNativeTelemetry } from "./native-event-policy.js";
import { COPILOT_READ_TIMEOUT_MS, CopilotReadRequests } from "./reads.js";
import { CopilotNativeOperations } from "./operations.js";
import {
  CopilotAdapterSession,
  CopilotSessionBridge,
  COPILOT_SESSION_DISCONNECT_TIMEOUT_MS,
  elicitationResponse,
  exitPlanResponse,
  type CopilotNativeSession,
  type CopilotOwnershipDiagnostic,
  userInputResponse,
} from "./session.js";

export const COPILOT_SDK_VERSION = "1.0.14";
export const COPILOT_GRACEFUL_SHUTDOWN_MS = COPILOT_SESSION_DISCONNECT_TIMEOUT_MS;
export const COPILOT_ATTACHMENT_TIMEOUT_MS = COPILOT_READ_TIMEOUT_MS;

interface PendingAttachment {
  bridge: CopilotSessionBridge;
  native?: CopilotNativeSession;
  cancel(): void;
}

export interface CopilotRuntimeStatus {
  version: string;
  protocolVersion: number;
}

/** The client subset used by the adapter. Exported to support deterministic tests. */
export interface CopilotAdapterClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  getStatus(): Promise<CopilotRuntimeStatus>;
  listModels(): Promise<ModelInfo[]>;
  listSessions(): Promise<SessionMetadata[]>;
  createSession(config: SessionConfig): Promise<CopilotNativeSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotNativeSession>;
}

export interface CopilotAdapterOptions {
  /** Stable scope for the Copilot account/runtime home represented by this adapter. */
  adapterScopeId?: string | AdapterScopeId;
  /** Passed to the SDK. Defaults to CLI-compatible behavior for a trusted runtime node. */
  clientOptions?: CopilotClientOptions;
  /** Runtime-node-local BYOK provider. Credentials in this object never cross the fleet RPC. */
  provider?: ProviderConfig;
  /** Default model required for runtime-node-local BYOK sessions. */
  defaultModel?: string;
  /** Models exposed by listModels while using the runtime-node-local provider. */
  providerModels?: readonly string[];
  /** Non-secret capability declarations for configured BYOK models. Unknown models stay conservative in the SDK. */
  providerModelCapabilities?: Readonly<Record<string, ModelCapabilities>>;
  /** Test/embedding seam; production callers normally leave this unset. */
  clientFactory?: (options: CopilotClientOptions) => CopilotAdapterClient;
  /** Test seam for deterministic runtime epochs. */
  runtimeEpochFactory?: () => RuntimeEpoch;
  /** Private ownership-stage diagnostics; a sink failure cannot change native results. */
  onOwnershipDiagnostic?(record: CopilotOwnershipDiagnostic): void;
}

export class CopilotAgentAdapter implements AgentAdapter {
  public readonly imageCodec = copilotImageCodec;
  public readonly optionalNativeTelemetry = copilotOptionalNativeTelemetry;
  public readonly harness = "copilot" as const;
  public readonly adapterScopeId: AdapterScopeId;
  readonly #client: CopilotAdapterClient;
  readonly #epoch: () => RuntimeEpoch;
  readonly #ownershipDiagnostic: CopilotAdapterOptions["onOwnershipDiagnostic"];
  readonly #provider: ProviderConfig | undefined;
  readonly #defaultModel: string | undefined;
  readonly #providerModels: readonly string[];
  readonly #providerModelCapabilities: Readonly<Record<string, ModelCapabilities>>;
  readonly #active = new Map<string, CopilotAdapterSession>();
  readonly #nativeOwners = new WeakSet<CopilotNativeSession>();
  readonly #attachments = new Map<string, PendingAttachment>();
  readonly #reads = new CopilotReadRequests();
  readonly #operations = new CopilotNativeOperations();
  #startupPending = false;
  #startupFailedUnproved = false;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #started = false;
  #closed = false;

  public constructor(options: CopilotAdapterOptions = {}) {
    this.adapterScopeId = adapterScopeIdSchema.parse(options.adapterScopeId ?? "copilot:default");
    this.#provider = options.provider;
    this.#defaultModel = nonempty(options.defaultModel, "defaultModel");
    if (this.#provider && !this.#defaultModel) {
      throw new TypeError("Copilot BYOK provider requires a defaultModel");
    }
    this.#providerModels = providerModels(options.providerModels, this.#defaultModel);
    this.#providerModelCapabilities = structuredClone(options.providerModelCapabilities ?? {});
    const configuredExecutable =
      options.clientOptions?.env?.COPILOT_CLI_PATH ??
      process.env.COPILOT_CLI_PATH;
    const bundledExecutable = options.clientFactory === undefined
      ? configuredExecutable ?? bundledCopilotExecutable()
      : configuredExecutable;
    const clientOptions: CopilotClientOptions = {
      mode: "copilot-cli",
      // @github/copilot@1.0.88 keeps the tightened platform-package exports and the
      // pinned SDK's automatic `@github/copilot-<platform>/sdk` resolver can
      // no longer see that subpath. Resolve the executable exported by the
      // package explicitly; embedders can still override `connection` below.
      ...(bundledExecutable
        ? { connection: RuntimeConnection.forStdio({ path: bundledExecutable }) }
        : {}),
      ...(this.#provider ? { useLoggedInUser: false } : {}),
      ...(this.#provider
        ? { onListModels: () => this.#providerModels.map((id) => providerModelInfo(id, this.#providerModelCapabilities[id])) }
        : {}),
      ...options.clientOptions,
    };
    const factory = options.clientFactory ?? ((config) =>
      new CopilotClient(config) as unknown as CopilotAdapterClient);
    this.#client = factory(clientOptions);
    this.#epoch = options.runtimeEpochFactory ?? newRuntimeEpoch;
    this.#ownershipDiagnostic = options.onOwnershipDiagnostic;
  }

  public async describe(): Promise<HarnessCatalogEntry> {
    try {
      await this.ensureStarted();
      const status = await this.runtimeStatus();
      return {
        harness: "copilot",
        adapterScopeId: this.adapterScopeId,
        available: true,
        version: COPILOT_SDK_VERSION,
        runtimeVersion: status.version,
        capabilities: capabilities(status.protocolVersion),
      };
    } catch (error) {
      return {
        harness: "copilot",
        adapterScopeId: this.adapterScopeId,
        available: false,
        version: COPILOT_SDK_VERSION,
        capabilities: capabilities(),
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async listModels(): Promise<NativeModel[]> {
    if (this.#provider) {
      return this.#providerModels.map((id) => ({
        harness: "copilot",
        id,
        name: id,
        native: copilotJson({
          ...providerModelInfo(id, this.#providerModelCapabilities[id]),
          imageSupport: this.#providerModelCapabilities[id]
            ? this.#providerModelCapabilities[id].supports.vision ? "supported" : "unsupported"
            : COPILOT_CODEX_LB_MODELS[id] ? "supported" : "unknown",
          byok: true,
          providerType: this.#provider?.type ?? "openai",
          wireApi: this.#provider?.wireApi ?? "completions",
          transport: this.#provider?.transport ?? "http",
          isDefault: id === this.#defaultModel,
        }),
      }));
    }
    await this.ensureStarted();
    const models = await this.#reads.read("adapter:models", "", () => this.#client.listModels());
    this.assertOpen();
    return models.map((model) => ({
      harness: "copilot",
      id: model.id,
      name: model.name,
      native: copilotJson(model),
    }));
  }

  public async listSessions(): Promise<NativeInventoryItem[]> {
    await this.ensureStarted();
    // Reconcile missed root lifecycle events from the existing native handle.
    // This is observation only: never resume/replace a handle to query activity.
    const [metadata] = await Promise.all([
      this.#reads.read("adapter:sessions", "", () => this.#client.listSessions()),
      Promise.all([...this.#active.values()].filter(session => session.status() !== "stopped").map(session => session.readActivity())),
    ]);
    this.assertOpen();
    const byId = new Map(metadata.map((entry) => [entry.sessionId, entry]));
    const result = metadata.map((entry) => this.inventoryItem(entry));
    for (const session of this.#active.values()) {
      if (session.status() === "stopped") continue;
      if (byId.has(session.vendorSessionId)) continue;
      result.push({
        harness: "copilot",
        adapterScopeId: this.adapterScopeId,
        vendorSessionId: session.vendorSessionId,
        cwd: session.cwd,
        availability: "active",
        runtimeStatus: session.status(),
        runtimeEpoch: session.runtimeEpoch,
        harnessSettings: session.settings(),
        lastActivityAt: null,
      });
    }
    return result;
  }

  public async spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    this.assertOpen();
    if (options.harness !== "copilot") {
      throw new TypeError(`Copilot adapter cannot spawn ${options.harness}`);
    }
    await this.ensureStarted();
    this.assertOpen();

    const bridge = new CopilotSessionBridge();
    // This baseline must precede any callback or event that createSession can
    // synchronously buffer. Later positive interaction facts then extend it.
    bridge.interactionHydration(true);
    const vendorSessionId = nativeSessionId(options.native) ?? randomUUID();
    this.assertAttachmentAvailable(vendorSessionId);
    const model = options.model ?? this.#defaultModel;
    const config = this.sessionConfig(
      bridge,
      options.native,
      {
        sessionId: vendorSessionId,
        workingDirectory: options.cwd,
        ...(model ? { model } : {}),
        ...(this.#provider ? { provider: this.#provider } : {}),
        ...(options.reasoningEffort
          ? {
              reasoningEffort: options.reasoningEffort as NonNullable<
                SessionConfig["reasoningEffort"]
              >,
            }
          : {}),
        ...(options.additionalDirectories
          ? { additionalDirectories: options.additionalDirectories }
          : {}),
      },
    );

    let native: CopilotNativeSession;
    try {
      native = await this.requestAttachment(vendorSessionId, bridge, () => this.#client.createSession(config));
    } catch (cause) {
      bridge.close();
      throw new AdapterOutcomeUnknownError(
        `Copilot session ${vendorSessionId} may have been created, but creation was not acknowledged`,
        { cause },
      );
    }
    if (this.#closed) return this.rejectLateAttachment(native, bridge);
    const session = this.attach(
      vendorSessionId,
      native,
      options.cwd,
      bridge,
      initialSettings(config.model, options.mode, config.reasoningEffort),
    );
    if (options.mode) {
      try {
        await this.attachmentMode(native, session.runtimeEpoch, options.mode);
      } catch (cause) {
        await session.stop().catch(() => undefined);
        throw new AdapterOutcomeUnknownError(
          `Copilot session ${native.sessionId} was created but its requested mode was not acknowledged`,
          { cause },
        );
      }
    }
    await Promise.all([session.readPermissions(), session.readModel(), session.readMode(), session.readActivity()]);
    if (this.#closed) throw new AdapterOutcomeUnknownError("Copilot adapter closed before the created session could be returned");
    return session;
  }

  public async resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    this.assertOpen();
    if (options.harness !== "copilot") {
      throw new TypeError(`Copilot adapter cannot resume ${options.harness}`);
    }
    await this.ensureStarted();
    this.assertOpen();

    this.assertAttachmentAvailable(options.vendorSessionId, true);
    // A stopped local bridge is not proof of native release. prior.stop()
    // retains the original disconnect wait until acknowledgement/owner close.
    const prior = this.#active.get(options.vendorSessionId);
    if (prior) await prior.stop();
    this.assertOpen();
    this.assertAttachmentAvailable(options.vendorSessionId);

    const bridge = new CopilotSessionBridge();
    // Resume cannot prove absence because pending callbacks are ephemeral, but
    // its partial baseline must still precede any callback replay.
    bridge.interactionHydration(false);
    const cwd = options.cwd ?? null;
    const model = options.model ?? this.#defaultModel;
    const config = this.resumeConfig(
      bridge,
      options.native,
      {
        ...(options.cwd ? { workingDirectory: options.cwd } : {}),
        ...(model ? { model } : {}),
        ...(this.#provider ? { provider: this.#provider } : {}),
        ...(options.reasoningEffort
          ? {
              reasoningEffort: options.reasoningEffort as NonNullable<
                ResumeSessionConfig["reasoningEffort"]
              >,
            }
          : {}),
        ...(options.additionalDirectories
          ? { additionalDirectories: options.additionalDirectories }
          : {}),
        continuePendingWork: options.continuePendingWork,
      },
    );

    let native: CopilotNativeSession;
    try {
      native = await this.requestAttachment(options.vendorSessionId, bridge,
        () => this.#client.resumeSession(options.vendorSessionId, config));
    } catch (cause) {
      bridge.close();
      // Copilot can keep a never-used session in memory only.
      // Its explicit load refusal means no resume effect occurred; retaining
      // outcomeUnknown here would unnecessarily wedge the durable lifecycle.
      // Keep the predicate exact: timeouts, transport failures and unrelated
      // native errors remain ambiguous and must not be blindly retried.
      if (isMissingNativeSession(cause, options.vendorSessionId)) {
        throw new Error(
          "Copilot has no saved history for this session. An empty session may not survive a host restart. Stop and archive this entry, then create a new session.",
          { cause },
        );
      }
      throw new AdapterOutcomeUnknownError(
        `Copilot session ${options.vendorSessionId} may have resumed, but resume was not acknowledged`,
        { cause },
      );
    }
    if (this.#closed) return this.rejectLateAttachment(native, bridge);
    const session = this.attach(
      options.vendorSessionId,
      native,
      cwd,
      bridge,
      initialSettings(config.model, options.mode, config.reasoningEffort),
    );
    if (options.mode) {
      try {
        await this.attachmentMode(native, session.runtimeEpoch, options.mode);
      } catch (cause) {
        await session.stop().catch(() => undefined);
        throw new AdapterOutcomeUnknownError(
          `Copilot session ${native.sessionId} resumed but its requested mode was not acknowledged`,
          { cause },
        );
      }
    }
    await Promise.all([
      session.readPermissions(),
      session.readPendingPermissions(),
      session.readModel(),
      session.readMode(),
      session.readActivity(),
    ]);
    if (this.#closed) throw new AdapterOutcomeUnknownError("Copilot adapter closed before the resumed session could be returned");
    return session;
  }

  private async rejectLateAttachment(native: CopilotNativeSession, bridge: CopilotSessionBridge): Promise<never> {
    bridge.close();
    await this.detachLateAttachment(native, bridge);
    throw new AdapterOutcomeUnknownError("Copilot adapter closed during attachment; the late native handle was detached");
  }

  /** Retire pending read/attachment caller waits before Runtime drains them.
   * Native ownership remains retained until close() proves backend termination. */
  public beginClose(): void {
    if (!this.#closed) this.ownershipDiagnostic({ stage: "shutdown", outcome: "retired" });
    this.#closed = true;
    this.#reads.close();
    this.#operations.close();
    for (const pending of this.#attachments.values()) pending.cancel();
  }

  public async releaseSession(record: RuntimeNodeSessionRecord): Promise<void> {
    this.assertOpen();
    if (record.harness !== this.harness || record.adapterScopeId !== this.adapterScopeId) {
      throw new RuntimeNodeProtocolError("FENCED", "Copilot archive targets another adapter scope");
    }
    if (this.#attachments.has(record.vendorSessionId)) {
      throw new AdapterOutcomeUnknownError("Copilot archive cannot certify release while native attachment ownership is pending");
    }
    // Native history remains vendor-owned. Only certify that a retired local
    // controller has actually disconnected before Runtime releases its state.
    await this.#active.get(record.vendorSessionId)?.stop();
  }

  public close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.beginClose();
    this.#closePromise = this.closeNativeRuntime();
    return this.#closePromise;
  }

  private async closeNativeRuntime(): Promise<void> {
    const errors: unknown[] = [];
    const gracefulDeadline = Date.now() + COPILOT_GRACEFUL_SHUTDOWN_MS;
    const stopped = await settleWithin(
      Promise.allSettled(
      [...this.#active.values()].map((session) => session.stop()),
      ),
      COPILOT_GRACEFUL_SHUTDOWN_MS,
    );
    let force = stopped.status !== "fulfilled";
    if (stopped.status === "fulfilled") {
      for (const result of stopped.value) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      force ||= errors.length > 0;
    } else {
      errors.push(stopped.status === "timedOut"
        ? new Error("Copilot sessions did not disconnect within the graceful shutdown window")
        : stopped.reason);
    }
    this.#active.clear();
    // A failed/eager UI-server probe may have constructed and started the
    // client without advancing this adapter's lazy-start flag. Always close
    // the client; stop implementations are required to be idempotent.
    if (!force) {
      const stoppedClient = await settleWithin(
        this.#client.stop(),
        Math.max(0, gracefulDeadline - Date.now()),
      );
      if (stoppedClient.status === "fulfilled") {
        errors.push(...stoppedClient.value);
        force = stoppedClient.value.length > 0;
      } else {
        force = true;
        errors.push(stoppedClient.status === "timedOut"
          ? new Error("Copilot CLI did not stop within the graceful shutdown window")
          : stoppedClient.reason);
      }
    }
    if (force) {
      // The pinned SDK's forceStop() suppresses child.kill() errors and clears
      // cliProcess without waiting for exit. Capture the owned child first;
      // a fulfilled forceStop alone cannot authorize another native owner.
      const exitProof = captureOwnedCliExit(this.#client);
      const forced = await settleWithin(this.#client.forceStop(), COPILOT_GRACEFUL_SHUTDOWN_MS);
      if (forced.status !== "fulfilled") {
        exitProof?.cancel();
        errors.push(forced.status === "timedOut"
          ? new Error("Copilot CLI process termination could not be proved")
          : forced.reason);
      } else if (exitProof && await exitProof.wait) {
        // The old native owner is gone. Earlier disconnect/stop failures no
        // longer prevent the runtime supervisor from safely reattaching.
        errors.length = 0;
      } else {
        errors.push(new Error("Copilot CLI process termination could not be proved"));
      }
    }
    // A pending SDK start can still acquire a process after a stop/forceStop.
    // Terminating the currently visible child does not certify that this
    // unacknowledged startup request cannot create another one later.
    if (this.#startupPending || this.#startupFailedUnproved) errors.push(new Error("Copilot SDK startup ownership remains unproved; native owner termination could not be proved"));
    this.ownershipDiagnostic({ stage: "shutdown", outcome: errors.length > 0 ? "unacknowledged" : "closed" });
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close Copilot adapter cleanly");
  }

  private attach(
    expectedSessionId: string,
    native: CopilotNativeSession,
    cwd: string | null,
    bridge: CopilotSessionBridge,
    settings: HarnessSessionSettings,
  ): CopilotAdapterSession {
    // Validate before replacing any existing map entry or releasing a request
    // reservation. SDK identity mistakes cannot become a second logical owner.
    if (native.sessionId !== expectedSessionId || this.#attachments.get(expectedSessionId)?.bridge !== bridge ||
      this.#active.has(expectedSessionId)) {
      throw new AdapterOutcomeUnknownError("Copilot native attachment does not match its reserved ownership fence");
    }
    const session = new CopilotAdapterSession({
      adapterScopeId: this.adapterScopeId,
      cwd,
      runtimeEpoch: this.#epoch(),
      native,
      bridge,
      settings,
      reads: this.#reads,
      operations: this.#operations,
      onOwnershipDiagnostic: record => this.ownershipDiagnostic(record),
      onStopped: () => {
        this.#nativeOwners.delete(native);
        if (this.#active.get(native.sessionId) === session) {
          this.#active.delete(native.sessionId);
        }
      },
    });
    this.#nativeOwners.add(native);
    this.#active.set(native.sessionId, session);
    if (this.#attachments.get(native.sessionId)?.bridge === bridge) this.#attachments.delete(native.sessionId);
    return session;
  }

  private assertAttachmentAvailable(sessionId: string, allowPrior = false): void {
    if (this.#attachments.has(sessionId) || (!allowPrior && this.#active.has(sessionId))) {
      throw new RuntimeNodeProtocolError("CONFLICT", "Copilot native attachment ownership is pending; wait for acknowledged release or recover the Host");
    }
  }

  private requestAttachment(
    sessionId: string,
    bridge: CopilotSessionBridge,
    action: () => Promise<CopilotNativeSession>,
  ): Promise<CopilotNativeSession> {
    this.assertAttachmentAvailable(sessionId);
    let finish!: (native: CopilotNativeSession) => void;
    let fail!: (cause: unknown) => void;
    let settled = false;
    let dispatched = false;
    const result = new Promise<CopilotNativeSession>((resolve, reject) => { finish = resolve; fail = reject; });
    const abandon = (cause: unknown, outcome: "retired" | "timedOut" | "unacknowledged"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bridge.close();
      this.ownershipDiagnostic({ vendorSessionId: sessionId, stage: "attachment", outcome });
      fail(new AdapterOutcomeUnknownError("Copilot native attachment was not acknowledged; native ownership remains pending", { cause }));
    };
    const entry: PendingAttachment = { bridge, cancel: () => abandon(new Error("Copilot adapter is closing"), "retired") };
    this.#attachments.set(sessionId, entry);
    const timer = setTimeout(() => abandon(new Error("Copilot native attachment timed out"), "timedOut"), COPILOT_ATTACHMENT_TIMEOUT_MS);
    timer.unref?.();
    void Promise.resolve().then(() => {
      this.assertOpen();
      dispatched = true;
      this.ownershipDiagnostic({ vendorSessionId: sessionId, stage: "attachment", outcome: "dispatched" });
      return action();
    }).then(native => {
      if (native.sessionId !== sessionId) {
        entry.native = native;
        abandon(new Error("Copilot SDK returned a different native session identity"), "unacknowledged");
        // Keep the requested-key reservation through cleanup. Also fence an
        // otherwise unowned actual ID; never overwrite an existing owner/fence.
        if (!this.#active.has(native.sessionId) && !this.#attachments.has(native.sessionId)) {
          this.#attachments.set(native.sessionId, entry);
        }
        void this.detachLateAttachment(native, bridge, sessionId).catch(() => undefined);
        return;
      }
      this.ownershipDiagnostic({ vendorSessionId: sessionId, stage: "attachment", outcome: settled ? "lateAcknowledged" : "acknowledged",
        ...(native.incidentTraceAttachmentId === undefined ? {} : { attachmentId: native.incidentTraceAttachmentId }) });
      if (settled || this.#closed) {
        // This handle was never handed to Runtime. Do not publish late events
        // or admit another SDK owner until its exact disconnect acknowledges.
        void this.detachLateAttachment(native, bridge, sessionId).catch(() => undefined);
        return;
      }
      settled = true;
      clearTimeout(timer);
      finish(native);
    }, cause => {
      this.ownershipDiagnostic({ vendorSessionId: sessionId, stage: "attachment", outcome: "unacknowledged" });
      if ((!dispatched || isMissingNativeSession(cause, sessionId)) && this.#attachments.get(sessionId) === entry) {
        this.#attachments.delete(sessionId);
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bridge.close();
      fail(cause);
    });
    return result;
  }

  private async detachLateAttachment(native: CopilotNativeSession, bridge: CopilotSessionBridge, expectedSessionId = native.sessionId): Promise<void> {
    bridge.close();
    const actualFence = this.#attachments.get(native.sessionId);
    if (this.#nativeOwners.has(native) || this.#active.has(native.sessionId) || actualFence && actualFence.bridge !== bridge) {
      // A malformed response can even reuse the correct owner's exact object.
      // SDK disconnect detaches by native ID, so even a DISTINCT returned
      // object colliding with an existing owner cannot be safely disconnected.
      // Retain it for whole-owner shutdown without disrupting the correct one.
      this.ownershipDiagnostic({ vendorSessionId: expectedSessionId, stage: "detach", outcome: "unacknowledged" });
      throw new AdapterOutcomeUnknownError("Copilot mismatched attachment references an already owned native handle; Host recovery is required");
    }
    this.ownershipDiagnostic({ vendorSessionId: native.sessionId, stage: "detach", outcome: "dispatched" });
    const released = Promise.resolve().then(() => native.disconnect()).then(() => {
      this.ownershipDiagnostic({ vendorSessionId: native.sessionId, stage: "detach", outcome: "acknowledged" });
      for (const key of [expectedSessionId, native.sessionId]) {
        if (this.#attachments.get(key)?.bridge === bridge) this.#attachments.delete(key);
      }
    });
    const result = await settleWithin(released, COPILOT_SESSION_DISCONNECT_TIMEOUT_MS);
    if (result.status !== "fulfilled") {
      this.ownershipDiagnostic({ vendorSessionId: native.sessionId, stage: "detach", outcome: result.status === "timedOut" ? "timedOut" : "unacknowledged" });
      throw new AdapterOutcomeUnknownError("Late Copilot attachment native release remains unacknowledged",
        { cause: result.status === "rejected" ? result.reason : new Error("native disconnect timed out") });
    }
  }

  private async attachmentMode(native: CopilotNativeSession, epoch: RuntimeEpoch, mode: NonNullable<Extract<HarnessResumeOptions, { harness: "copilot" }>["mode"]>): Promise<void> {
    await this.#operations.run(JSON.stringify([native.sessionId, epoch]), "command", () => {
      this.assertOpen();
      return native.rpc.mode.set({ mode });
    }, outcome => this.ownershipDiagnostic({ vendorSessionId: native.sessionId, stage: "attachmentMode", outcome }));
  }

  private ownershipDiagnostic(record: CopilotOwnershipDiagnostic): void {
    try { this.#ownershipDiagnostic?.(record); }
    catch { /* A private diagnostic sink cannot alter native ownership. */ }
  }

  private inventoryItem(metadata: SessionMetadata): NativeInventoryItem {
    const owned = this.#active.get(metadata.sessionId);
    const active = owned?.status() === "stopped" ? undefined : owned;
    return {
      harness: "copilot",
      adapterScopeId: this.adapterScopeId,
      vendorSessionId: metadata.sessionId,
      cwd: active?.cwd ?? metadata.context?.workingDirectory ?? null,
      availability: active ? "active" : "resumable",
      runtimeStatus: active?.status() ?? "stopped",
      runtimeEpoch: active?.runtimeEpoch ?? null,
      ...(active ? { harnessSettings: active.settings() } : {}),
      nativeSummary: copilotJson({
        summary: metadata.summary,
        startTime: metadata.startTime,
        modifiedTime: metadata.modifiedTime,
        isRemote: metadata.isRemote,
        context: metadata.context,
      }),
      lastActivityAt: metadata.modifiedTime.toISOString(),
    };
  }

  private sessionConfig(
    bridge: CopilotSessionBridge,
    native: JsonObject | undefined,
    controlled: Partial<SessionConfig>,
  ): SessionConfig {
    return {
      ...(native as unknown as Partial<SessionConfig>),
      ...controlled,
      clientName: "agent-multiplex",
      streaming: true,
      ...interactionHandlers(bridge),
      onEvent: (event) => bridge.nativeEvent(event),
    } as SessionConfig;
  }

  private resumeConfig(
    bridge: CopilotSessionBridge,
    native: JsonObject | undefined,
    controlled: Partial<ResumeSessionConfig>,
  ): ResumeSessionConfig {
    return {
      ...(native as unknown as Partial<ResumeSessionConfig>),
      ...controlled,
      clientName: "agent-multiplex",
      streaming: true,
      ...interactionHandlers(bridge),
      onEvent: (event) => bridge.nativeEvent(event),
    } as ResumeSessionConfig;
  }

  private async ensureStarted(): Promise<void> {
    this.assertOpen();
    if (this.#started) return;
    if (this.#startPromise) return this.#startPromise;
    const pending = this.#operations.run("adapter:startup", "start", async () => {
      this.#startupPending = true;
      let startupChild: unknown;
      try {
        const starting = this.#client.start();
        // Configured stdio startup spawns synchronously in the pinned SDK.
        // Keep the exact child object even if SDK failure clears its getter.
        startupChild = Reflect.get(this.#client, "cliProcess");
        await starting;
      }
      catch (error) {
        // Pinned SDK startup failure internally forceStops and may clear its
        // child reference without exit acknowledgement. A later empty stop
        // result cannot retroactively prove that lost child's termination.
        const exitProof = captureOwnedCliExit(this.#client, startupChild);
        this.#startupFailedUnproved = exitProof === undefined || !await exitProof.wait;
        throw error;
      }
      finally {
        this.#startupPending = false;
        if (this.#closed) {
          // Do not race the original close attempt. It may already have
          // reported uncertain cleanup; that result remains unchanged.
          await this.#closePromise?.catch(() => undefined);
          await this.closeNativeRuntime();
        }
      }
    }, outcome => this.ownershipDiagnostic({ stage: "startup", outcome })).then(() => {
      this.assertOpen();
      this.#started = true;
    });
    // Retain a failed/timed-out start for this adapter's lifetime. SDK startup
    // has no cancellation contract, and an eager forceStop cannot prove that
    // the original request will not create a late native owner.
    this.#startPromise = pending;
    await pending;
  }

  private async runtimeStatus(): Promise<CopilotRuntimeStatus> {
    const status = await this.#reads.read("adapter:status", "", () => this.#client.getStatus());
    this.assertOpen();
    return status;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Copilot adapter is closed");
  }
}

function isMissingNativeSession(error: unknown, sessionId: string): boolean {
  return error instanceof Error && "code" in error && error.code === -32603 &&
    error.message === `Request session.resume failed with message: Failed to load session events: Session not found: ${sessionId}`;
}

function bundledCopilotExecutable(): string | undefined {
  const candidates = process.platform === "linux"
    ? [`@github/copilot-linux-${process.arch}`, `@github/copilot-linuxmusl-${process.arch}`]
    : [`@github/copilot-${process.platform}-${process.arch}`];
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try the next libc variant when installed.
    }
  }
  // Preserve the SDK's own diagnostic/fallback when the platform package is
  // genuinely absent.
  return undefined;
}

export function createCopilotAdapter(options: CopilotAdapterOptions = {}): CopilotAgentAdapter {
  return new CopilotAgentAdapter(options);
}

/** Concise constructor name used by reference runtime node applications. */
export { CopilotAgentAdapter as CopilotAdapter };

function interactionHandlers(bridge: CopilotSessionBridge): {
  onPermissionRequest: PermissionHandler;
  onUserInputRequest: NonNullable<SessionConfig["onUserInputRequest"]>;
  onElicitationRequest: ElicitationHandler;
  onExitPlanModeRequest: ExitPlanModeHandler;
} {
  return {
    // The SDK callback omits native requestId. Its native broadcast carries the
    // exact identity, so the bridge handles that event and responds through the
    // supported permission RPC. No callback can independently approve a tool.
    onPermissionRequest: () => ({ kind: "no-result" }),
    onUserInputRequest: async (request, invocation) =>
      userInputResponse(
        await bridge.interaction(
          "userInput",
          { request, invocation },
          {
            ephemeral: true,
            cancelValue: { answer: "", wasFreeform: true },
            parseResponse: (response) => copilotJson(userInputResponse(response)),
          },
        ),
      ),
    onElicitationRequest: async (context) =>
      elicitationResponse(
        await bridge.interaction(
          "elicitation",
          context,
          {
            ephemeral: true,
            cancelValue: { action: "cancel" },
            parseResponse: (response) => copilotJson(elicitationResponse(response)),
          },
        ),
      ),
    onExitPlanModeRequest: async (request, invocation) =>
      exitPlanResponse(
        await bridge.interaction(
          "exitPlan",
          { request, invocation },
          {
            ephemeral: true,
            cancelValue: {
              approved: false,
              feedback: "Adapter session disconnected before the plan was reviewed",
            },
            parseResponse: (response) => copilotJson(exitPlanResponse(response)),
          },
        ),
      ),
  };
}

function nativeSessionId(native: JsonObject | undefined): string | undefined {
  const value = native?.sessionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function initialSettings(
  model: string | undefined,
  mode: "interactive" | "plan" | "autopilot" | undefined,
  effort: string | undefined,
): HarnessSessionSettings {
  return {
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(effort ? { effort } : {}),
  };
}

function nonempty(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${name} must not be empty`);
  return trimmed;
}

function providerModels(
  configured: readonly string[] | undefined,
  defaultModel: string | undefined,
): readonly string[] {
  const result: string[] = [];
  for (const model of configured ?? []) {
    const trimmed = model.trim();
    if (!trimmed) throw new TypeError("providerModels entries must not be empty");
    if (!result.includes(trimmed)) result.push(trimmed);
  }
  if (defaultModel && !result.includes(defaultModel)) result.unshift(defaultModel);
  return result;
}

function providerModelInfo(id: string, configured?: ModelCapabilities): ModelInfo {
  if (configured) return { id, name: id, capabilities: configured };
  const codexLbModel = codexLbModelInfo(id);
  if (codexLbModel) return codexLbModel;
  return {
    id,
    name: id,
    capabilities: {
      // An arbitrary OpenAI-compatible provider supplies no discovery
      // contract. Keep unknown models deliberately conservative instead of
      // claiming capabilities that may make the Copilot runtime send an
      // unsupported request shape.
      supports: { vision: false, reasoningEffort: false },
      limits: { max_context_window_tokens: 128_000 },
    },
  };
}

function codexLbModelInfo(id: string): ModelInfo | undefined {
  const model = COPILOT_CODEX_LB_MODELS[id];
  if (!model) return undefined;
  return {
    id,
    name: model.name,
    capabilities: {
      family: id,
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      supports: {
        vision: true,
        reasoningEffort: true,
        reasoning_effort: model.efforts,
        adaptive_thinking: "unsupported",
        parallel_tool_calls: true,
        streaming: true,
        structured_outputs: true,
        tool_calls: true,
      },
      limits: {
        max_prompt_tokens: 922_000,
        max_context_window_tokens: 1_050_000,
        max_output_tokens: 128_000,
        vision: {
          supported_media_types: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "application/pdf",
          ],
          max_prompt_images: 1,
          max_prompt_image_size: 3_145_728,
        },
      },
    },
    supportedReasoningEfforts: model.efforts,
    modelPickerCategory: model.category,
    modelPickerPriceCategory: model.price,
  } as unknown as ModelInfo;
}

// Historical exact non-policy/non-billing entries reported by Copilot 1.0.79.
// This table supplies conservative BYOK defaults only. Stock Copilot models,
// including newly released models, always pass through native discovery above.
// The wire catalog includes `none` and several capability properties that are
// absent from the narrower SDK 1.0.14 TypeScript declaration.
const COPILOT_CODEX_LB_MODELS: Record<string, {
  name: string;
  efforts: readonly string[];
  category: string;
  price: string;
}> = {
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    category: "powerful",
    price: "medium",
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    category: "versatile",
    price: "medium",
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    category: "lightweight",
    price: "low",
  },
  "gpt-5.4": {
    name: "GPT-5.4",
    efforts: ["none", "low", "medium", "high", "xhigh"],
    category: "powerful",
    price: "medium",
  },
};

type TimedSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timedOut" };

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedSettlement<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TimedSettlement<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timedOut" }), Math.max(0, timeoutMs));
    void promise.then(
      value => finish({ status: "fulfilled", value }),
      reason => finish({ status: "rejected", reason }),
    );
  });
}

interface OwnedCliExitProof {
  wait: Promise<boolean>;
  cancel(): void;
}

/** Only the pinned SDK's locally spawned CLI can establish process ownership. */
function captureOwnedCliExit(client: CopilotAdapterClient, capturedChild?: unknown): OwnedCliExitProof | undefined {
  if (Reflect.get(client, "isExternalServer") !== false) return undefined;
  const child: unknown = capturedChild ?? Reflect.get(client, "cliProcess");
  if (!child || typeof child !== "object") return undefined;
  const process = child as {
    pid?: unknown;
    exitCode?: unknown;
    signalCode?: unknown;
    once?: (event: string, listener: () => void) => void;
    removeListener?: (event: string, listener: () => void) => void;
  };
  if (!Number.isSafeInteger(process.pid) || Number(process.pid) < 1 ||
    typeof process.once !== "function" || typeof process.removeListener !== "function") return undefined;
  const exited = (): boolean => process.exitCode !== null && process.exitCode !== undefined ||
    process.signalCode !== null && process.signalCode !== undefined;
  let finish!: (value: boolean) => void;
  const wait = new Promise<boolean>(resolve => { finish = resolve; });
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (value: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    process.removeListener?.("exit", onExit);
    finish(value);
  };
  const onExit = (): void => settle(exited());
  if (exited()) {
    settle(true);
  } else {
    process.once("exit", onExit);
    if (exited()) settle(true);
    else timer = setTimeout(() => settle(false), COPILOT_GRACEFUL_SHUTDOWN_MS);
  }
  return { wait, cancel: () => settle(false) };
}

function capabilities(protocolVersion?: number): HarnessCatalogEntry["capabilities"] {
  const version = protocolVersion === undefined ? undefined : String(protocolVersion);
  return [
    { name: "sessions.list", version, experimental: false },
    { name: "session.create", version, experimental: false },
    { name: "session.resume", version, experimental: false },
    { name: "history.native", version, experimental: false },
    { name: "history.native.primary", version: "v1", experimental: true },
    { name: "history.native.child", version: "v1", experimental: true },
    { name: "prompt.enqueue", version, experimental: false },
    { name: "prompt.steer.immediate", version, experimental: false },
    { name: "interrupt", version, experimental: false },
    { name: "models.list", version, experimental: false },
    { name: "models.switch", version, experimental: false },
    { name: "reasoning-effort.create-resume", version, experimental: false },
    { name: "reasoning-effort.switch", version: "v1", experimental: false },
    { name: "mode.native", version, experimental: true },
    { name: "permissions.mode", version: "v1", experimental: true },
    { name: "context.compact", version: "v1", experimental: true },
    { name: "queue.pending", version: "v1", experimental: true },
    { name: "queue.sendNow", version: "v1", experimental: true },
    { name: "tasks.list", version: "v1", experimental: true },
    { name: "tasks.progress", version: "v1", experimental: true },
    { name: "tasks.promoteToBackground", version: "v1", experimental: true },
    { name: "tasks.cancel", version: "v1", experimental: true },
    { name: "interactions.permission", version, experimental: false },
    { name: "interactions.userInput", version, experimental: false },
    { name: "interactions.elicitation", version, experimental: true },
    { name: "interactions.exitPlan", version, experimental: true },
  ].map((entry) =>
    entry.version === undefined
      ? { name: entry.name, experimental: entry.experimental }
      : entry,
  );
}
