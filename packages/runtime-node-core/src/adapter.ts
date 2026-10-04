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
  LifecycleFact,
  NativeHistoryRequest,
  NativeStateRequest,
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
  sortDirection?: "asc" | "desc";
  unavailableItem?: { reason: "exceedsWireLimit"; nativeItemId?: string; nativeType?: string };
  /** Private exact root-message evidence from the returned native page only,
   * bounded to at most two facts per requested native item.
   * Never replay historical work, interactions or recovery as live events. */
  messageDeliveryFacts?: Array<Extract<LifecycleFact, { type: "messageDisplayed" | "messageConsumed" }>>;
}

export type AdapterNativeStateResult = Pick<AdapterNativeHistoryResult, "harness" | "vendorSessionId" | "payload">;

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
  /** Used only when a native recovery snapshot omits root/child ownership. */
  lifecycleOwner?: "unattributed";
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

export type AdapterEvent = (
  | { kind: "lifecycle"; fact: LifecycleFact }
  | AdapterNativeEvent
  | AdapterInteractionEvent
  | AdapterInteractionSettledEvent
  | AdapterStatusEvent
  | AdapterSettingsEvent) & {
    /** Private, nonenumerable adapter correlation; never serialized or persisted. */
    readonly diagnosticNativeEventOrdinal?: number;
  };

export interface AdapterSession {
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly vendorSessionId: string;
  readonly cwd: string | null;
  readonly runtimeEpoch: RuntimeEpoch;
  /** Process-local SDK attachment ordinal shared with an embedding Host's read log. */
  readonly incidentTraceAttachmentId?: number;
  status(): SessionRuntimeStatus;
  /** Last settings acknowledged by the native harness, when observable. */
  settings?(): HarnessSessionSettings | undefined;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
  execute(command: HarnessCommand): Promise<JsonValue | undefined>;
  readNativeHistory(request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult>;
  /** Optional active-session observation; does not mutate the native session. */
  readNativeState?(request: NativeStateRequest): Promise<AdapterNativeStateResult>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly imageCodec?: NativeImageCodec;
  /** Trusted harness policy for one confirmed optional context snapshot only.
   * Missing, malformed, unknown and authoritative events remain required.
   * This never grants admission or permits truncating a native payload. */
  optionalNativeTelemetry?(event: AdapterNativeEvent): boolean;
  describe(): Promise<HarnessCatalogEntry>;
  listModels(): Promise<NativeModel[]>;
  listSessions(): Promise<NativeInventoryItem[]>;
  /** Harness-native launch hook selected through a runtime launch provider. */
  spawn(options: HarnessSpawnOptions): Promise<AdapterSession>;
  resume(options: HarnessResumeOptions): Promise<AdapterSession>;
  /** Optional idempotent release of backend-owned state during archive. */
  releaseSession?(session: RuntimeNodeSessionRecord): Promise<void>;
  /** Optional synchronous shutdown fence for pending read/attachment waits.
   * It does not release native ownership; close() must still prove cleanup. */
  beginClose?(): void;
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

/** Fixed native-state diagnostics only. Never retain values, vendor IDs, error
 * messages or unrecognized property names in an incident trace. */
export const ADAPTER_NATIVE_STATE_DIAGNOSTIC_FIELDS = [
  "tasks", "task", "progress", "id", "type", "description", "status", "startedAt", "completedAt",
  "executionMode", "canPromoteToBackground", "toolCallId", "agentType", "prompt", "model", "resolvedModel",
  "displayName", "command", "attachmentMode", "pid", "logPath", "clientTaskId", "canCancel", "owner",
  "participantId", "joinId", "kind", "presence", "updatedAt", "activeTimeMs", "sequence", "recentActivity",
  "message", "timestamp", "latestIntent", "recentOutput", "percentage", "phase", "lastMessage", "unknownField",
] as const;
export const ADAPTER_NATIVE_STATE_VALIDATION_CODES = [
  "invalid_type", "invalid_value", "too_big", "too_small", "invalid_union", "unrecognized_keys", "invalid_format",
  "not_multiple_of", "invalid_key", "invalid_element", "custom", "unknownIssue",
] as const;
export const ADAPTER_NATIVE_STATE_VALUE_TYPES = [
  "undefined", "null", "date", "array", "string", "number", "boolean", "object", "other",
] as const;
export const ADAPTER_NATIVE_STATE_VALIDATION_REASONS = [
  "snapshotMalformed", "snapshotTooLarge", "snapshotWireInvalid", "projectionMalformed",
] as const;
export type AdapterNativeStateValidationReason = typeof ADAPTER_NATIVE_STATE_VALIDATION_REASONS[number];
export interface AdapterNativeStateValidationIssue {
  /** At most eight segments. Array indices saturate at 1,000. */
  readonly path: readonly (typeof ADAPTER_NATIVE_STATE_DIAGNOSTIC_FIELDS[number] | number)[];
  readonly code: typeof ADAPTER_NATIVE_STATE_VALIDATION_CODES[number];
  readonly valueType: typeof ADAPTER_NATIVE_STATE_VALUE_TYPES[number];
}

/** A validation failure remains a failed read; metadata only improves diagnosis.
 * Copy and bound each field here so adapters cannot forward raw issue objects. */
export class AdapterNativeStateValidationError extends TypeError {
  public readonly reason: AdapterNativeStateValidationReason;
  public readonly issues: readonly AdapterNativeStateValidationIssue[];

  public constructor(reason: AdapterNativeStateValidationReason, issues: readonly AdapterNativeStateValidationIssue[] = []) {
    const safeReason = ADAPTER_NATIVE_STATE_VALIDATION_REASONS.includes(reason) ? reason : "snapshotMalformed";
    super(safeReason === "snapshotTooLarge" ? "Native state snapshot exceeds the bounded envelope"
      : safeReason === "snapshotWireInvalid" ? "Native state snapshot requires plain JSON wire data"
      : safeReason === "projectionMalformed" ? "Native state lifecycle projection is malformed" : "Unrecognized native state snapshot");
    this.name = "AdapterNativeStateValidationError";
    this.reason = safeReason;
    this.issues = Object.freeze(issues.slice(0, 8).map(issue => Object.freeze({
      path: Object.freeze(issue.path.slice(0, 8).map(segment => typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0
        ? Math.min(segment, 1_000) : ADAPTER_NATIVE_STATE_DIAGNOSTIC_FIELDS.includes(segment as never) ? segment : "unknownField")),
      code: ADAPTER_NATIVE_STATE_VALIDATION_CODES.includes(issue.code) ? issue.code : "unknownIssue",
      valueType: ADAPTER_NATIVE_STATE_VALUE_TYPES.includes(issue.valueType) ? issue.valueType : "other",
    })));
  }
}
