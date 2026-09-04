import type {
  AttachmentId,
  CommandEnvelope,
  CommandId,
  CommandRecord,
  Harness,
  HostAttachmentRequest,
  HostBootId,
  HostId,
  HostSubtreeSnapshotPage,
  InteractionRecord,
  InventorySnapshot,
  LineageId,
  MetadataOperationRecord,
  NativeHistoryResult,
  NativeHistoryRequest,
  NativeModel,
  ResolveInteractionInput,
  ResumeCommand,
  SessionId,
  SpawnCommand,
  StreamCursor,
  WorkerBootId,
  WorkerId,
} from "@agent-multiplex/protocol";
export type { NativeHistoryRequest } from "@agent-multiplex/protocol";

/**
 * Transport-neutral view of a live worker. The p2prpc package adapts a remote
 * WorkerRouter proxy to this interface; tests and embedded deployments may use
 * an in-process implementation.
 */
export interface WorkerConnection {
  readonly workerId: WorkerId;
  readonly workerBootId: WorkerBootId;
  readonly endpointId?: string;

  refreshInventory(): Promise<InventorySnapshot>;
  listModels(harness: Harness): Promise<NativeModel[]>;
  spawn(command: SpawnCommand): Promise<CommandRecord>;
  resume(command: ResumeCommand): Promise<CommandRecord>;
  execute(command: CommandEnvelope): Promise<CommandRecord>;
  readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult>;
  resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord>;
  /** Deliver a terminal host-authoritative metadata receipt to this worker. */
  applyMetadata?(operation: MetadataOperationRecord): Promise<MetadataOperationRecord>;
  getCommand?(commandId: CommandId): Promise<CommandRecord | null>;
}

/**
 * Transport-neutral reverse link to one immediate child host. The child owns
 * all recursive routing below it; a parent never needs transport knowledge or
 * a direct connection to a grandchild.
 */
export interface ChildHostConnection {
  readonly hostId: HostId;
  readonly hostBootId: HostBootId;
  readonly endpointId?: string;

  readSubtreeSnapshot(request: {
    attachmentId: AttachmentId;
    lineageId: LineageId;
    pageToken?: string;
    limit?: number;
  }): Promise<HostSubtreeSnapshotPage>;
  subscribeAggregate(
    cursor: StreamCursor,
    signal?: AbortSignal,
  ): AsyncIterable<import("@agent-multiplex/protocol").FleetStreamItem>;

  listModels(workerId: WorkerId, harness: Harness): Promise<NativeModel[]>;
  refreshInventory(workerId: WorkerId): Promise<InventorySnapshot>;
  spawn(command: SpawnCommand): Promise<CommandRecord>;
  resume(command: ResumeCommand): Promise<CommandRecord>;
  execute(command: CommandEnvelope): Promise<CommandRecord>;
  readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult>;
  resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord>;
  getCommand?(commandId: CommandId): Promise<CommandRecord | null>;
  applyMetadata?(operation: MetadataOperationRecord): Promise<MetadataOperationRecord>;
}

/** A recursive route always points at exactly one immediate child. */
export interface ChildHostRoute {
  readonly workerId: WorkerId;
  readonly ownerHostId: HostId;
  readonly immediateChildHostId: HostId;
  readonly attachmentId: AttachmentId;
  readonly lineageId: LineageId;
}

/** Principal identity supplied only by an authenticated transport adapter. */
export interface AuthenticatedActorContext {
  readonly authenticatedActorId?: string | undefined;
}

export interface ChildHostIngressContext extends AuthenticatedActorContext {
  readonly authenticatedHostId?: HostId | undefined;
  readonly endpointId?: string | undefined;
  readonly childHostConnection?: ChildHostConnection | undefined;
  readonly createChildHostConnection?:
    | ((request: HostAttachmentRequest) => ChildHostConnection)
    | undefined;
}

/** Authenticated host-peer context used for both child ingress and parent link calls. */
export type HostPeerContext = ChildHostIngressContext;

export interface MetadataUpstreamConnection {
  pushMetadataOutbox(
    operations: readonly MetadataOperationRecord[],
  ): Promise<MetadataOperationRecord[]>;
}

export interface HostIngressContext extends AuthenticatedActorContext {
  /** Identity asserted and authenticated by the transport, when available. */
  readonly authenticatedWorkerId?: WorkerId | undefined;
  /** Stable transport endpoint identifier used only as descriptor metadata. */
  readonly endpointId?: string | undefined;
  /** Reverse RPC channel associated with the incoming worker connection. */
  readonly workerConnection?: WorkerConnection | undefined;
  /** Lazily creates the reverse channel once registration supplies logical IDs. */
  readonly createWorkerConnection?:
    | ((workerId: WorkerId, workerBootId: WorkerBootId) => WorkerConnection)
    | undefined;
}

export type FleetContext = AuthenticatedActorContext;
export type CompositeHostIngressContext = HostIngressContext & ChildHostIngressContext;
