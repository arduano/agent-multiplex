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
} from "@arduano/agent-multiplex-protocol";
import {
  AdapterOutcomeUnknownError,
  type AdapterSession,
  type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";

import { copilotJson } from "./json.js";
import {
  CopilotAdapterSession,
  CopilotSessionBridge,
  elicitationResponse,
  exitPlanResponse,
  permissionResponse,
  type CopilotNativeSession,
  userInputResponse,
} from "./session.js";

export const COPILOT_SDK_VERSION = "1.0.11";

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
}

export class CopilotAgentAdapter implements AgentAdapter {
  public readonly imageCodec = copilotImageCodec;
  public readonly harness = "copilot" as const;
  public readonly adapterScopeId: AdapterScopeId;
  readonly #client: CopilotAdapterClient;
  readonly #epoch: () => RuntimeEpoch;
  readonly #provider: ProviderConfig | undefined;
  readonly #defaultModel: string | undefined;
  readonly #providerModels: readonly string[];
  readonly #providerModelCapabilities: Readonly<Record<string, ModelCapabilities>>;
  readonly #active = new Map<string, CopilotAdapterSession>();
  #startPromise: Promise<void> | undefined;
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
      // @github/copilot@1.0.81 tightened its platform-package exports and the
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
    const models = await this.#client.listModels();
    return models.map((model) => ({
      harness: "copilot",
      id: model.id,
      name: model.name,
      native: copilotJson(model),
    }));
  }

  public async listSessions(): Promise<NativeInventoryItem[]> {
    await this.ensureStarted();
    const metadata = await this.#client.listSessions();
    const byId = new Map(metadata.map((entry) => [entry.sessionId, entry]));
    const result = metadata.map((entry) => this.inventoryItem(entry));
    for (const session of this.#active.values()) {
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

    const bridge = new CopilotSessionBridge();
    const vendorSessionId = nativeSessionId(options.native) ?? randomUUID();
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
      native = await this.#client.createSession(config);
    } catch (cause) {
      bridge.close();
      throw new AdapterOutcomeUnknownError(
        `Copilot session ${vendorSessionId} may have been created, but creation was not acknowledged`,
        { cause },
      );
    }
    const session = this.attach(
      native,
      options.cwd,
      bridge,
      initialSettings(config.model, options.mode, config.reasoningEffort),
    );
    if (options.mode) {
      try {
        await native.rpc.mode.set({ mode: options.mode });
      } catch (cause) {
        await session.stop().catch(() => undefined);
        throw new AdapterOutcomeUnknownError(
          `Copilot session ${native.sessionId} was created but its requested mode was not acknowledged`,
          { cause },
        );
      }
    }
    return session;
  }

  public async resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    this.assertOpen();
    if (options.harness !== "copilot") {
      throw new TypeError(`Copilot adapter cannot resume ${options.harness}`);
    }
    await this.ensureStarted();

    // One SDK handle is the sole upstream controller. An explicit resume is
    // also the recovery path after a runtime failure, so replace stale handles.
    const prior = this.#active.get(options.vendorSessionId);
    if (prior) await prior.stop();

    const bridge = new CopilotSessionBridge();
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
      native = await this.#client.resumeSession(options.vendorSessionId, config);
    } catch (cause) {
      bridge.close();
      throw new AdapterOutcomeUnknownError(
        `Copilot session ${options.vendorSessionId} may have resumed, but resume was not acknowledged`,
        { cause },
      );
    }
    const session = this.attach(
      native,
      cwd,
      bridge,
      initialSettings(config.model, options.mode, config.reasoningEffort),
    );
    if (options.mode) {
      try {
        await native.rpc.mode.set({ mode: options.mode });
      } catch (cause) {
        await session.stop().catch(() => undefined);
        throw new AdapterOutcomeUnknownError(
          `Copilot session ${native.sessionId} resumed but its requested mode was not acknowledged`,
          { cause },
        );
      }
    }
    return session;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    const stopped = await Promise.allSettled(
      [...this.#active.values()].map((session) => session.stop()),
    );
    for (const result of stopped) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    this.#active.clear();
    // A failed/eager UI-server probe may have constructed and started the
    // client without advancing this adapter's lazy-start flag. Always close
    // the client; stop implementations are required to be idempotent.
    try {
      errors.push(...(await this.#client.stop()));
    } catch (error) {
      errors.push(error);
      try {
        await this.#client.forceStop();
      } catch (forceError) {
        errors.push(forceError);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close Copilot adapter cleanly");
  }

  private attach(
    native: CopilotNativeSession,
    cwd: string | null,
    bridge: CopilotSessionBridge,
    settings: HarnessSessionSettings,
  ): CopilotAdapterSession {
    const session = new CopilotAdapterSession({
      adapterScopeId: this.adapterScopeId,
      cwd,
      runtimeEpoch: this.#epoch(),
      native,
      bridge,
      settings,
      onStopped: () => {
        if (this.#active.get(native.sessionId) === session) {
          this.#active.delete(native.sessionId);
        }
      },
    });
    this.#active.set(native.sessionId, session);
    return session;
  }

  private inventoryItem(metadata: SessionMetadata): NativeInventoryItem {
    const active = this.#active.get(metadata.sessionId);
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
    const pending = this.#client.start().then(() => {
      this.#started = true;
    });
    this.#startPromise = pending;
    try {
      await pending;
    } catch (error) {
      this.#started = false;
      await this.#client.forceStop().catch(() => undefined);
      throw error;
    } finally {
      if (this.#startPromise === pending) this.#startPromise = undefined;
    }
  }

  private async runtimeStatus(): Promise<CopilotRuntimeStatus> {
    return this.#client.getStatus();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Copilot adapter is closed");
  }
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
    onPermissionRequest: async (request, invocation) =>
      permissionResponse(
        await bridge.interaction(
          "permission",
          { permissionRequest: request, invocation },
          {
            ephemeral: false,
            cancelValue: { kind: "cancelled", reason: "adapter session disconnected" },
            parseResponse: (response) => copilotJson(permissionResponse(response)),
          },
        ),
      ),
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

// Exact non-policy/non-billing entries reported by the pinned Copilot 1.0.79
// runtime. Its wire catalog includes `none` and several capability properties
// that are absent from the narrower SDK 1.0.11 TypeScript declaration.
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

function capabilities(protocolVersion?: number): HarnessCatalogEntry["capabilities"] {
  const version = protocolVersion === undefined ? undefined : String(protocolVersion);
  return [
    { name: "sessions.list", version, experimental: false },
    { name: "session.create", version, experimental: false },
    { name: "session.resume", version, experimental: false },
    { name: "history.native", version, experimental: false },
    { name: "prompt.enqueue", version, experimental: false },
    { name: "prompt.steer.immediate", version, experimental: false },
    { name: "interrupt", version, experimental: false },
    { name: "models.list", version, experimental: false },
    { name: "models.switch", version, experimental: false },
    { name: "reasoning-effort.create-resume", version, experimental: false },
    { name: "mode.native", version, experimental: true },
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
