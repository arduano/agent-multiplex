import type {
  AdapterScopeId,
  Harness,
  HarnessCatalogEntry,
  HarnessCommand,
  CommandImageBinding,
  HarnessResumeOptions,
  HarnessSessionSettings,
  HarnessSpawnOptions,
  JsonValue,
  LaunchBackendId,
  NativeHistoryRequest,
  NativePayload,
  NativeImageSlot,
  NativeInventoryItem,
  NativeModel,
  RuntimeEpoch,
  RuntimeNodeSessionRecord,
  SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";

/** Adapter results retain harness-native JSON until runtime-owned image extraction. */
export interface AdapterNativeHistoryResult {
  harness: Harness;
  vendorSessionId: string;
  payload: JsonValue;
  complete?: boolean;
  nextCursor?: string;
}

export interface NativeImageSink {
  storeBase64(input: { dataBase64: string; mediaType: string }): Promise<NativeImageSlot["image"]>;
  snapshotPath(input: { sourceKey: string; path: string }): Promise<NativeImageSlot["image"]>;
}

export interface NativeImageCodec {
  externalize(payload: JsonValue, sink: NativeImageSink): Promise<NativePayload>;
  validateCommand?(command: HarnessCommand): void;
  acceptsCommandImage?(command: HarnessCommand, image: CommandImageBinding): boolean;
}

export interface AdapterNativeEvent {
  kind: "native";
  nativeType: string;
  payload: JsonValue;
  ephemeral: boolean;
}

export interface AdapterInteractionEvent {
  kind: "interaction";
  nativeRequestId?: string;
  requestType:
    | "approval"
    | "permission"
    | "userInput"
    | "elicitation"
    | "exitPlan"
    | "other";
  payload: JsonValue;
  ephemeral: boolean;
  expiresAt?: string;
  resolve(response: JsonValue): Promise<void>;
}

/**
 * Signals that a native reverse request was cleared without a controller-side
 * resolution (for example because its turn completed or was interrupted).
 */
export interface AdapterInteractionSettledEvent {
  kind: "interactionSettled";
  nativeRequestId: string;
  state: "expired" | "stale";
}

export interface AdapterStatusEvent {
  kind: "status";
  status: SessionRuntimeStatus;
}

/** A native-harness settings snapshot changed outside the metadata plane. */
export interface AdapterSettingsEvent {
  kind: "settings";
  settings: HarnessSessionSettings;
}

export type AdapterEvent =
  | AdapterNativeEvent
  | AdapterInteractionEvent
  | AdapterInteractionSettledEvent
  | AdapterStatusEvent
  | AdapterSettingsEvent;

export interface AdapterSession {
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly vendorSessionId: string;
  readonly cwd: string | null;
  readonly runtimeEpoch: RuntimeEpoch;
  status(): SessionRuntimeStatus;
  /** Last settings acknowledged by the native harness, when observable. */
  settings?(): HarnessSessionSettings | undefined;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
  execute(command: HarnessCommand): Promise<JsonValue | undefined>;
  readNativeHistory(request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly imageCodec?: NativeImageCodec;
  describe(): Promise<HarnessCatalogEntry>;
  listModels(): Promise<NativeModel[]>;
  listSessions(): Promise<NativeInventoryItem[]>;
  /** Harness-native launch hook selected through a runtime launch provider. */
  spawn(options: HarnessSpawnOptions): Promise<AdapterSession>;
  resume(options: HarnessResumeOptions): Promise<AdapterSession>;
  /** Optional idempotent release of backend-owned state during archive. */
  releaseSession?(session: RuntimeNodeSessionRecord): Promise<void>;
  close(): Promise<void>;
}

/**
 * One statically composed native execution target. Backend identity is opaque
 * to protocol core and lets a runtime expose multiple app-server scopes for a
 * single harness without making launch providers own adapter plumbing.
 */
export interface RuntimeAgentBackend {
  readonly backendId: LaunchBackendId;
  readonly adapter: AgentAdapter;
  /** Read inside a custom backend's own filesystem. There is never host fallback. */
  readonly readImageFile?: (input: {
    session: RuntimeNodeSessionRecord;
    path: string;
    maximumBytes: number;
  }) => Promise<Uint8Array>;
  /** Optional backend-specific cleanup for one archived logical session. */
  releaseSession?(session: RuntimeNodeSessionRecord): Promise<void>;
}

/** Preserve one-adapter composition as a first-class protocol-v4 backend. */
export function runtimeBackendForAdapter(
  adapter: AgentAdapter,
  backendId: LaunchBackendId = `${adapter.harness}:${adapter.adapterScopeId}` as LaunchBackendId,
): RuntimeAgentBackend {
  return {
    backendId,
    adapter,
    ...(adapter.releaseSession === undefined
      ? {}
      : {
          releaseSession: (session: RuntimeNodeSessionRecord) =>
            adapter.releaseSession!(session),
        }),
  };
}

/** Signals that a native side effect may have occurred and must not be retried. */
export class AdapterOutcomeUnknownError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdapterOutcomeUnknownError";
  }
}
