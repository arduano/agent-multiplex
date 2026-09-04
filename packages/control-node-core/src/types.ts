import type {
  AccessStreamItem,
  ArchiveOperationId,
  ArchiveRecord,
  ArchiveRequest,
  AttachmentId,
  CommandEnvelope,
  CommandId,
  CommandRecord,
  ControlNodeAttachmentRequest,
  ControlNodeBootId,
  ControlNodeId,
  ControlNodeSubtreeSnapshotPage,
  Harness,
  InteractionRecord,
  InventorySnapshot,
  LaunchId,
  LaunchListInput,
  LaunchListPage,
  LaunchProfileDescriptor,
  LaunchProfileIdentity,
  LaunchRecord,
  LaunchRequest,
  LineageId,
  MetadataOperationRecord,
  MetadataPatch,
  NativeHistoryRequest,
  NativeHistoryResult,
  NativeModel,
  ResolveInteractionInput,
  ResumeCommand,
  RuntimeNodeBootId,
  RuntimeNodeEventItem,
  RuntimeNodeId,
  SessionId,
  SessionRecord,
  SessionSearchInput,
  SessionSearchPage,
  StopCommand,
  StreamCursor,
  TerminalAttachInput,
  TerminalDescriptor,
  TerminalGetInput,
  TerminalInput,
  TerminalInputResult,
  TerminalLeaseAcquireInput,
  TerminalLeaseAcquireResult,
  TerminalLeaseReleaseInput,
  TerminalLeaseReleaseResult,
  TerminalLeaseRenewInput,
  TerminalLeaseRenewResult,
  TerminalOpenInput,
  TerminalOpenResult,
  TerminalStreamItem,
  TerminalTerminateInput,
} from "@arduano/agent-multiplex-protocol";

/** Reverse RPC port associated with one authenticated runtime-node peer. */
export interface RuntimeNodeConnection {
  readonly runtimeNodeId: RuntimeNodeId;
  readonly runtimeNodeBootId: RuntimeNodeBootId;
  readonly endpointId?: string | undefined;
  refreshInventory(): Promise<InventorySnapshot>;
  listModels(harness: Harness): Promise<NativeModel[]>;
  listLaunchProfiles(): Promise<LaunchProfileDescriptor[]>;
  listLaunchProfileModels(
    profile: LaunchProfileIdentity,
    harness: Harness,
  ): Promise<NativeModel[]>;
  createLaunch(request: LaunchRequest): Promise<LaunchRecord>;
  getLaunch(launchId: LaunchId): Promise<LaunchRecord | null>;
  listLaunches(query: LaunchListInput): Promise<LaunchListPage>;
  resume(command: ResumeCommand): Promise<CommandRecord>;
  stop(command: StopCommand): Promise<CommandRecord>;
  archive(request: ArchiveRequest): Promise<ArchiveRecord>;
  getArchive(archiveOperationId: ArchiveOperationId): Promise<ArchiveRecord | null>;
  execute(command: CommandEnvelope): Promise<CommandRecord>;
  readNativeHistory(sessionId: SessionId, request: NativeHistoryRequest): Promise<NativeHistoryResult>;
  getTerminal?(input: TerminalGetInput): Promise<TerminalDescriptor | null>;
  openTerminal?(input: TerminalOpenInput): Promise<TerminalOpenResult>;
  attachTerminal?(input: TerminalAttachInput, signal?: AbortSignal): AsyncIterable<TerminalStreamItem>;
  acquireTerminalLease?(input: TerminalLeaseAcquireInput): Promise<TerminalLeaseAcquireResult>;
  renewTerminalLease?(input: TerminalLeaseRenewInput): Promise<TerminalLeaseRenewResult>;
  releaseTerminalLease?(input: TerminalLeaseReleaseInput): Promise<TerminalLeaseReleaseResult>;
  sendTerminalInput?(input: TerminalInput): Promise<TerminalInputResult>;
  terminateTerminal?(input: TerminalTerminateInput): Promise<TerminalDescriptor>;
  resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord>;
  applyMetadata?(operation: MetadataOperationRecord): Promise<MetadataOperationRecord>;
  getCommand?(commandId: CommandId): Promise<CommandRecord | null>;
  subscribeEvents?(
    cursor: import("@arduano/agent-multiplex-protocol").RuntimeNodeEventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeNodeEventItem>;
}

/** One immediate child; recursive routing stays behind this typed boundary. */
export interface ChildControlNodeConnection {
  readonly controlNodeId: ControlNodeId;
  readonly controlNodeBootId: ControlNodeBootId;
  readonly endpointId?: string | undefined;
  readSubtreeSnapshot(request: {
    attachmentId: AttachmentId;
    lineageId: LineageId;
    pageToken?: string;
    limit?: number;
  }): Promise<ControlNodeSubtreeSnapshotPage>;
  subscribeAggregate(cursor: StreamCursor, signal?: AbortSignal): AsyncIterable<AccessStreamItem>;
  listModels(runtimeNodeId: RuntimeNodeId, harness: Harness): Promise<NativeModel[]>;
  listLaunchProfileModels(
    runtimeNodeId: RuntimeNodeId,
    profile: LaunchProfileIdentity,
    harness: Harness,
  ): Promise<NativeModel[]>;
  refreshInventory(runtimeNodeId: RuntimeNodeId): Promise<InventorySnapshot>;
  createLaunch(request: LaunchRequest): Promise<LaunchRecord>;
  getLaunch(launchId: LaunchId): Promise<LaunchRecord | null>;
  listLaunches(query: LaunchListInput): Promise<LaunchListPage>;
  searchSessions(query: SessionSearchInput): Promise<SessionSearchPage>;
  getSession(sessionId: SessionId): Promise<SessionRecord | null>;
  resume(command: ResumeCommand): Promise<CommandRecord>;
  stop(command: StopCommand): Promise<CommandRecord>;
  archive(request: ArchiveRequest): Promise<ArchiveRecord>;
  getArchive(archiveOperationId: ArchiveOperationId): Promise<ArchiveRecord | null>;
  execute(command: CommandEnvelope): Promise<CommandRecord>;
  readNativeHistory(sessionId: SessionId, request: NativeHistoryRequest): Promise<NativeHistoryResult>;
  getTerminal?(input: TerminalGetInput): Promise<TerminalDescriptor | null>;
  openTerminal?(input: TerminalOpenInput): Promise<TerminalOpenResult>;
  attachTerminal?(input: TerminalAttachInput, signal?: AbortSignal): AsyncIterable<TerminalStreamItem>;
  acquireTerminalLease?(input: TerminalLeaseAcquireInput): Promise<TerminalLeaseAcquireResult>;
  renewTerminalLease?(input: TerminalLeaseRenewInput): Promise<TerminalLeaseRenewResult>;
  releaseTerminalLease?(input: TerminalLeaseReleaseInput): Promise<TerminalLeaseReleaseResult>;
  sendTerminalInput?(input: TerminalInput): Promise<TerminalInputResult>;
  terminateTerminal?(input: TerminalTerminateInput): Promise<TerminalDescriptor>;
  resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord>;
  getCommand?(commandId: CommandId): Promise<CommandRecord | null>;
  applyMetadata?(operation: MetadataOperationRecord): Promise<MetadataOperationRecord>;
  applyDetachment?(
    receipt: import("@arduano/agent-multiplex-protocol").TopologyDetachmentReceipt,
  ): Promise<import("@arduano/agent-multiplex-protocol").TopologyDetachmentReceipt>;
}

export interface MetadataUpstreamConnection {
  pushMetadataOutbox(operations: readonly MetadataOperationRecord[]): Promise<MetadataOperationRecord[]>;
}

export interface AuthenticatedActorContext {
  readonly authenticatedActorId?: string | undefined;
}

export interface RuntimeNodeIngressContext extends AuthenticatedActorContext {
  readonly authenticatedRuntimeNodeId?: RuntimeNodeId | undefined;
  readonly endpointId?: string | undefined;
  readonly runtimeNodeConnection?: RuntimeNodeConnection | undefined;
  readonly createRuntimeNodeConnection?: ((
    runtimeNodeId: RuntimeNodeId,
    runtimeNodeBootId: RuntimeNodeBootId,
  ) => RuntimeNodeConnection | undefined) | undefined;
}

export interface ChildControlNodeIngressContext extends AuthenticatedActorContext {
  readonly authenticatedControlNodeId?: ControlNodeId | undefined;
  readonly endpointId?: string | undefined;
  readonly childControlNodeConnection?: ChildControlNodeConnection | undefined;
  readonly createChildControlNodeConnection?: ((
    identity: Pick<
      ControlNodeAttachmentRequest,
      "controlNodeId" | "controlNodeBootId"
    >,
  ) => ChildControlNodeConnection | undefined) | undefined;
}

export type ControlNodePeerContext = ChildControlNodeIngressContext;
export type CompositeControlNodeIngressContext = RuntimeNodeIngressContext & ChildControlNodeIngressContext;

export interface AccessContext extends AuthenticatedActorContext {
  readonly grantedScopes?: readonly import("@arduano/agent-multiplex-protocol").ActionScope[] | undefined;
}

export interface MetadataProposalConnection {
  patchMetadata(patch: MetadataPatch): Promise<MetadataOperationRecord>;
}
