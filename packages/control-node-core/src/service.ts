import { randomUUID } from "node:crypto";

import {
  accessAttachInputSchema,
  archiveRecordSchema,
  archiveRequestSchema,
  authorityPromoteInputSchema,
  canonicalJson,
  canonicalProtocolRecordJson,
  commandRecordSchema,
  controlNodeSubtreeSnapshotPageSchema,
  controlNodeSubtreeSnapshotRequestSchema,
  gatewayEnrollmentSchema,
  interactionRecordSchema,
  inventorySnapshotSchema,
  jsonValueSchema,
  launchListInputSchema,
  launchListPageSchema,
  launchRecordSchema,
  launchRequestSchema,
  metadataOperationRecordSchema,
  metadataPatchSchema,
  runtimeNodeEventItemSchema,
  runtimeNodeRegistrationSchema,
  resumeCommandSchema,
  sessionSearchInputSchema,
  sessionSearchPageSchema,
  stopCommandSchema,
  terminalDescriptorSchema,
  terminalOpenResultSchema,
  terminalStreamItemSchema,
  type AccessAttachInput,
  type AccessSnapshot,
  type ActionScope,
  type ArchiveOperationId,
  type ArchiveRecord,
  type ArchiveRequest,
  type AuthorityPromoteInput,
  type AuthorityPromotionReceipt,
  type AttachmentId,
  type CommandEnvelope,
  type CommandId,
  type CommandRecord,
  type ControlNodeAttachmentRequest,
  type ControlNodeBootId,
  type ControlNodeId,
  type ControlNodeLinkFence,
  type ControlNodeSubtreeSnapshotPage,
  type ControlNodeSubtreeSnapshotRequest,
  type FeedControlItem,
  type GatewayEnrollment,
  type Harness,
  type HarnessCatalogEntry,
  type InteractionRecord,
  type InventorySnapshot,
  type LaunchId,
  type LaunchListInput,
  type LaunchListPage,
  type LaunchProfileDescriptor,
  type LaunchProfileIdentity,
  type LaunchRecord,
  type LaunchRequest,
  type LineageId,
  type MetadataOperationRecord,
  type MetadataPatch,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeModel,
  type ResolveInteractionInput,
  type ResumeCommand,
  type RuntimeNodeEventItem,
  type RuntimeNodeFence,
  type RuntimeNodeId,
  type RuntimeNodeRegistration,
  type SessionId,
  type SessionRecord,
  type SessionSearchInput,
  type SessionSearchPage,
  type StopCommand,
  type StreamCursor,
  type TerminalAttachInput,
  type TerminalDescriptor,
  type TerminalGetInput,
  type TerminalInput,
  type TerminalInputResult,
  type TerminalLeaseAcquireInput,
  type TerminalLeaseAcquireResult,
  type TerminalLeaseReleaseInput,
  type TerminalLeaseReleaseResult,
  type TerminalLeaseRenewInput,
  type TerminalLeaseRenewResult,
  type TerminalOpenInput,
  type TerminalOpenResult,
  type TerminalStreamItem,
  type TerminalTarget,
  type TerminalTerminateInput,
  type TopologyDetachInput,
  type TopologyDetachmentReceipt,
  type TopologyForceDetachInput,
} from "@arduano/agent-multiplex-protocol";

import { ControlNodeCatalog, type RuntimeNodeRoute, type SessionFilter } from "./catalog.js";
import { ControlNodeCoreError } from "./errors.js";
import { ControlNodeEventHub } from "./event-hub.js";
import type {
  AccessContext,
  ChildControlNodeConnection,
  ChildControlNodeIngressContext,
  ControlNodePeerContext,
  MetadataUpstreamConnection,
  RuntimeNodeConnection,
  RuntimeNodeIngressContext,
} from "./types.js";

function compareSessionSearchOrder(
  left: SessionRecord,
  right: SessionRecord,
): number {
  const leftActivity = left.lastActivityAt ?? left.updatedAt;
  const rightActivity = right.lastActivityAt ?? right.updatedAt;
  if (leftActivity !== rightActivity) {
    return leftActivity > rightActivity ? -1 : 1;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

function compareLaunchListOrder(left: LaunchRecord, right: LaunchRecord): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  return left.launchId.localeCompare(right.launchId);
}

const ALL_SCOPES: readonly ActionScope[] = [
  "read",
  "agent-control",
  "agent-launch",
  "agent-archive",
  "terminal-view",
  "terminal-control",
  "metadata-propose",
  "topology-admin",
  "authority-admin",
];

export interface ControlNodeServiceOptions {
  readonly catalog: ControlNodeCatalog;
  readonly events?: ControlNodeEventHub;
  readonly instanceId?: string;
  readonly metadataUpstream?: MetadataUpstreamConnection;
  readonly p2pTicket?: () => string | undefined;
  readonly now?: () => Date;
  readonly snapshotTraversalTtlMs?: number;
  readonly maximumSnapshotItems?: number;
  readonly maximumSnapshotTraversals?: number;
  readonly grantedGatewayScopes?: (
    enrollment: GatewayEnrollment,
    context: AccessContext,
  ) => readonly ActionScope[];
  readonly onRuntimeNodeConnectionAttached?: (connection: RuntimeNodeConnection) => void;
  readonly onChildControlNodeConnectionAttached?: (connection: ChildControlNodeConnection) => void;
  readonly onChildControlNodePumpError?: (
    controlNodeId: ControlNodeId,
    error: unknown,
  ) => void;
}

interface SnapshotTraversal {
  readonly snapshot: AccessSnapshot;
  readonly attachmentId: import("@arduano/agent-multiplex-protocol").AttachmentId;
  readonly lineageId: import("@arduano/agent-multiplex-protocol").LineageId;
  readonly expiresAt: number;
  index: number;
}

interface ChildPump {
  readonly connection: ChildControlNodeConnection;
  readonly controller: AbortController;
  task: Promise<void>;
  settled: boolean;
}

interface ChildSynchronization {
  readonly generation: number;
  readonly connection: ChildControlNodeConnection;
  readonly controlNodeBootId: ControlNodeBootId;
  readonly endpointId: string | undefined;
  readonly attachmentId: AttachmentId;
  readonly lineageId: LineageId;
  readonly task: Promise<void>;
}

interface DispatchRouteFence {
  readonly runtimeNodeId: RuntimeNodeId;
  readonly runtimeNodeBootId: import("@arduano/agent-multiplex-protocol").RuntimeNodeBootId;
  readonly childControlNodeId?: ControlNodeId;
  readonly childControlNodeBootId?: import("@arduano/agent-multiplex-protocol").ControlNodeBootId;
  readonly attachmentId?: import("@arduano/agent-multiplex-protocol").AttachmentId;
  readonly lineageId?: import("@arduano/agent-multiplex-protocol").LineageId;
}

type TerminalConnection = Required<Pick<
  RuntimeNodeConnection,
  | "getTerminal"
  | "openTerminal"
  | "attachTerminal"
  | "acquireTerminalLease"
  | "renewTerminalLease"
  | "releaseTerminalLease"
  | "sendTerminalInput"
  | "terminateTerminal"
>>;

/** Application orchestration around the synchronous canonical catalog. */
export class ControlNodeService {
  public readonly catalog: ControlNodeCatalog;
  public readonly events: ControlNodeEventHub;
  readonly #ownsEvents: boolean;
  readonly #instanceId: string;
  readonly #metadataUpstream: MetadataUpstreamConnection | undefined;
  readonly #p2pTicket: (() => string | undefined) | undefined;
  readonly #now: () => Date;
  readonly #snapshotTraversalTtlMs: number;
  readonly #maximumSnapshotItems: number;
  readonly #maximumSnapshotTraversals: number;
  readonly #grantedGatewayScopes: NonNullable<ControlNodeServiceOptions["grantedGatewayScopes"]>;
  readonly #onRuntimeNodeConnectionAttached: ((connection: RuntimeNodeConnection) => void) | undefined;
  readonly #onChildControlNodeConnectionAttached: ((connection: ChildControlNodeConnection) => void) | undefined;
  readonly #onChildControlNodePumpError: ((controlNodeId: ControlNodeId, error: unknown) => void) | undefined;
  readonly #runtimeConnections = new Map<RuntimeNodeId, RuntimeNodeConnection>();
  readonly #childConnections = new Map<ControlNodeId, ChildControlNodeConnection>();
  readonly #pendingChildSynchronizations = new Set<ControlNodeId>();
  readonly #childSynchronizations = new Map<ControlNodeId, ChildSynchronization>();
  readonly #childSynchronizationGenerations = new Map<ControlNodeId, number>();
  readonly #childPumps = new Map<ControlNodeId, ChildPump>();
  readonly #dispatches = new Map<string, Promise<CommandRecord>>();
  readonly #launchDispatches = new Map<
    string,
    { readonly request: LaunchRequest; readonly promise: Promise<LaunchRecord> }
  >();
  readonly #archiveDispatches = new Map<
    string,
    { readonly request: ArchiveRequest; readonly promise: Promise<ArchiveRecord> }
  >();
  readonly #interactionResolutions = new Map<
    string,
    { readonly response: string; readonly promise: Promise<InteractionRecord> }
  >();
  readonly #snapshotTraversals = new Map<string, SnapshotTraversal>();
  #closed = false;
  #metadataUpstreamFlush: Promise<number> | null = null;
  #metadataDeliveryFlush: Promise<number> | null = null;

  public constructor(options: ControlNodeServiceOptions) {
    this.catalog = options.catalog;
    this.events = options.events ?? new ControlNodeEventHub({ catalog: options.catalog });
    this.#ownsEvents = options.events === undefined;
    this.#instanceId = options.instanceId ?? this.catalog.localControlNode().controlNodeId;
    this.#metadataUpstream = options.metadataUpstream;
    this.#p2pTicket = options.p2pTicket;
    this.#now = options.now ?? (() => new Date());
    this.#snapshotTraversalTtlMs = options.snapshotTraversalTtlMs ?? 60_000;
    this.#maximumSnapshotItems = options.maximumSnapshotItems ?? 1_000_000;
    this.#maximumSnapshotTraversals = options.maximumSnapshotTraversals ?? 64;
    if (!Number.isSafeInteger(this.#maximumSnapshotItems) || this.#maximumSnapshotItems < 1) {
      throw new RangeError("maximumSnapshotItems must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maximumSnapshotTraversals) || this.#maximumSnapshotTraversals < 1) {
      throw new RangeError("maximumSnapshotTraversals must be a positive integer");
    }
    this.#grantedGatewayScopes = options.grantedGatewayScopes ?? ((request) =>
      ALL_SCOPES.filter((scope) => request.requestedScopes.includes(scope)));
    this.#onRuntimeNodeConnectionAttached = options.onRuntimeNodeConnectionAttached;
    this.#onChildControlNodeConnectionAttached = options.onChildControlNodeConnectionAttached;
    this.#onChildControlNodePumpError = options.onChildControlNodePumpError;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controlNodeId of this.#childSynchronizations.keys()) {
      this.#invalidateChildSynchronization(controlNodeId);
    }
    for (const pump of this.#childPumps.values()) pump.controller.abort();
    this.#childPumps.clear();
    this.#pendingChildSynchronizations.clear();
    if (this.#ownsEvents) this.events.close();
  }

  public describe() {
    return {
      application: "agent-multiplex" as const,
      protocolVersion: 4 as const,
      componentKind: "control-node" as const,
      dataAuthority: "control-node" as const,
      instanceId: this.#instanceId,
      capabilities: this.catalog.localControlNode().capabilities,
    };
  }

  public sourceManifest() { return this.catalog.sourceManifest(); }
  public sourceSnapshot() { return this.catalog.accessSnapshot(); }
  public listControlNodes() { return this.catalog.listControlNodes(); }
  public getControlNode(id: ControlNodeId) { return this.catalog.getControlNode(id); }
  public watchControlNodes(cursor: StreamCursor, signal?: AbortSignal) { return this.events.watchControlNodes(cursor, signal); }
  public listRuntimeNodes() { return this.catalog.listRuntimeNodes(); }
  public watchRuntimeNodes(cursor: StreamCursor, signal?: AbortSignal) { return this.events.watchRuntimeNodes(cursor, signal); }
  public listSessions(filter: SessionFilter = {}) { return this.catalog.listSessions(filter); }
  public async searchSessions(inputValue: SessionSearchInput): Promise<SessionSearchPage> {
    const input = sessionSearchInputSchema.parse(inputValue);
    const local = this.catalog.searchSessions(input);
    const children = input.states.includes("archived")
      ? this.#recursiveChildren(input.runtimeNodeIds)
      : [];
    if (children.length === 0) return local;

    // Ask every immediate branch for the same authority-fenced keyset page.
    // Hot rows may be present both locally and below; identity de-duplication
    // keeps the authority projection canonical while cold archived rows remain
    // discoverable even when they predate attachment. The same identity from
    // two sibling branches is corruption, not a replay, and must fail closed.
    const childPages = await Promise.all(children.map(async (child) => {
      const page = sessionSearchPageSchema.parse(await child.searchSessions(input));
      this.#assertRecursiveChildCurrent(child);
      for (const session of page.sessions) {
        this.#assertRecursiveSessionOwner(child, session);
      }
      return { child, page };
    }));
    const childOwnerBySession = new Map<SessionId, ControlNodeId>();
    for (const { child, page } of childPages) {
      for (const session of page.sessions) {
        const previousOwner = childOwnerBySession.get(session.sessionId);
        if (previousOwner !== undefined && previousOwner !== child.controlNodeId) {
          throw new ControlNodeCoreError(
            "CONFLICT",
            `session ${session.sessionId} exists in multiple child subtrees`,
          );
        }
        childOwnerBySession.set(session.sessionId, child.controlNodeId);
      }
    }
    const pages = childPages.map(({ page }) => page);
    const candidates = [local, ...pages]
      .flatMap((page) => page.sessions)
      .filter((session, index, all) =>
        all.findIndex((candidate) => candidate.sessionId === session.sessionId) === index)
      .sort(compareSessionSearchOrder);
    const sessions = candidates.slice(0, input.limit);
    const anySourceHasMore = local.nextCursor !== null ||
      pages.some((page) => page.nextCursor !== null);
    const hasMore = candidates.length > input.limit || anySourceHasMore;
    const tail = hasMore ? sessions.at(-1) : undefined;
    return sessionSearchPageSchema.parse({
      sessions,
      nextCursor: tail === undefined
        ? null
        : this.catalog.sessionSearchCursor(input, tail),
    });
  }
  public async getSession(id: SessionId): Promise<SessionRecord | null> {
    const local = this.catalog.getSession(id);
    if (local !== null) return local;
    const matches = (await Promise.all(this.#recursiveChildren().map(async (child) => {
      const session = await child.getSession(id);
      this.#assertRecursiveChildCurrent(child);
      if (session !== null) this.#assertRecursiveSessionOwner(child, session);
      return session;
    }))).filter((session): session is SessionRecord => session !== null);
    if (matches.length > 1) {
      throw new ControlNodeCoreError("CONFLICT", `session ${id} exists in multiple child subtrees`);
    }
    return matches[0] ?? null;
  }
  public async getLaunch(id: LaunchId): Promise<LaunchRecord | null> {
    const local = this.catalog.getLaunch(id);
    const matches = (await Promise.all(this.#recursiveChildren().map(async (child) => {
      const input = await child.getLaunch(id);
      this.#assertRecursiveChildCurrent(child);
      const launch = input === null ? null : launchRecordSchema.parse(input);
      return launch === null ? null : { child, launch };
    }))).filter((match): match is {
      child: ChildControlNodeConnection;
      launch: LaunchRecord;
    } => match !== null);
    if (matches.length > 1) {
      throw new ControlNodeCoreError("CONFLICT", `launch ${id} exists in multiple child subtrees`);
    }
    const match = matches[0];
    if (match !== undefined) {
      this.#assertRecursiveRuntimeOwner(match.child, match.launch.runtimeNodeId);
    }
    if (local !== null && match !== undefined) {
      // A projected operation is expected to appear both in this catalog and
      // at its owning child. recordLaunch validates the complete immutable
      // identity and monotonically reconciles lifecycle progress/recency.
      return this.catalog.recordLaunch(match.launch, match.child.controlNodeId);
    }
    if (local !== null) {
      if (isTerminalLaunch(local)) return local;
      return this.#refreshLaunch(local);
    }
    return match?.launch ?? null;
  }
  public async listLaunches(inputValue: LaunchListInput): Promise<LaunchListPage> {
    const input = launchListInputSchema.parse(inputValue);
    const children = this.#recursiveChildren(
      input.runtimeNodeId === undefined ? undefined : [input.runtimeNodeId],
    );
    if (children.length === 0) return this.catalog.listLaunches(input);
    const childPages = await Promise.all(children.map(async (child) => {
      const result = launchListPageSchema.parse(await child.listLaunches(input));
      this.#assertRecursiveChildCurrent(child);
      return { child, page: result };
    }));

    // Operation IDs are globally unique. Seeing one ID in two sibling
    // branches is topology corruption even when both records are byte-for-byte
    // equal; silently selecting either result would make later routing depend
    // on response order.
    const childLaunches = new Map<LaunchId, {
      readonly child: ChildControlNodeConnection;
      readonly launch: LaunchRecord;
    }>();
    for (const { child, page } of childPages) {
      for (const launch of page.launches) {
        const previous = childLaunches.get(launch.launchId);
        if (previous !== undefined) {
          throw new ControlNodeCoreError(
            "CONFLICT",
            `launch ${launch.launchId} exists in multiple child subtrees`,
          );
        }
        childLaunches.set(launch.launchId, { child, launch });
      }
    }
    for (const { child, launch } of childLaunches.values()) {
      this.#assertRecursiveRuntimeOwner(child, launch.runtimeNodeId);
    }

    // Reconcile expected local-projection/owner overlap before re-reading the
    // local page. Re-reading matters when progress moves a record into or out
    // of a state-filtered query, and prevents a stale local row from winning
    // merely because it was concatenated first.
    const coldLaunches: LaunchRecord[] = [];
    for (const { child, launch } of childLaunches.values()) {
      if (this.catalog.getLaunch(launch.launchId) === null) {
        coldLaunches.push(launch);
      } else {
        this.catalog.recordLaunch(launch, child.controlNodeId);
      }
    }
    const local = this.catalog.listLaunches(input);
    const candidates = [...local.launches, ...coldLaunches]
      .sort(compareLaunchListOrder);
    const launches = candidates.slice(0, input.limit);
    const hasMore = candidates.length > input.limit || local.nextCursor !== null ||
      childPages.some(({ page }) => page.nextCursor !== null);
    const tail = hasMore ? launches.at(-1) : undefined;
    return {
      launches,
      nextCursor: tail === undefined ? null : this.catalog.launchListCursor(input, tail),
    };
  }
  public async getArchive(id: ArchiveOperationId): Promise<ArchiveRecord | null> {
    const local = this.catalog.getArchive(id);
    const matches = (await Promise.all(this.#recursiveChildren().map(async (child) => {
      const input = await child.getArchive(id);
      this.#assertRecursiveChildCurrent(child);
      const archive = input === null ? null : archiveRecordSchema.parse(input);
      return archive === null ? null : { child, archive };
    }))).filter((match): match is {
      child: ChildControlNodeConnection;
      archive: ArchiveRecord;
    } => match !== null);
    if (matches.length > 1) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        `archive operation ${id} exists in multiple child subtrees`,
      );
    }
    const match = matches[0];
    if (match !== undefined) {
      this.#assertRecursiveRuntimeOwner(match.child, match.archive.runtimeNodeId);
    }
    if (local !== null && match !== undefined) {
      return this.catalog.recordArchive(match.archive, match.child.controlNodeId);
    }
    if (local !== null) {
      if (isTerminalArchive(local)) return local;
      return this.#refreshArchive(local);
    }
    return match?.archive ?? null;
  }
  public watchSessions(input: AccessAttachInput, signal?: AbortSignal) { return this.events.attach(accessAttachInputSchema.parse(input), signal); }
  public getMetadata(id: SessionId) { return this.catalog.getMetadata(id); }
  public getMetadataOperation(id: string) { return this.catalog.getMetadataOperation(id); }
  public listMetadataOperations(options = {}) { return this.catalog.listMetadataOperations(options); }
  public watchMetadataOperations(cursor: StreamCursor, signal?: AbortSignal) { return this.events.watchMetadataOperations(cursor, signal); }
  public listInteractions(options = {}) { return this.catalog.listInteractions(options); }
  public getCommand(id: CommandId) { return this.catalog.getCommand(id); }

  public enrollGateway(inputValue: GatewayEnrollment, context: AccessContext = {}) {
    const input = gatewayEnrollmentSchema.parse(inputValue);
    const endpointId = context.authenticatedActorId;
    if (!endpointId) throw new ControlNodeCoreError("UNAUTHORIZED", "gateway enrollment requires authenticated transport identity");
    const grantedScopes = [...new Set(this.#grantedGatewayScopes(input, context))]
      .filter((scope): scope is ActionScope => ALL_SCOPES.includes(scope));
    this.catalog.enrollPeer(endpointId, "access-gateway", endpointId, grantedScopes);
    const p2pTicket = this.#p2pTicket?.();
    return {
      accepted: true,
      canonical: this.catalog.localControlNode(),
      grantedScopes,
      ...(p2pTicket ? { p2pTicket } : {}),
    };
  }

  public async attachChild(
    input: ControlNodeAttachmentRequest,
    context: ChildControlNodeIngressContext = {},
  ) {
    const request = input;
    const endpointId = this.#assertChildEnrollmentIdentity(request.controlNodeId, context);
    const connection = context.childControlNodeConnection ??
      context.createChildControlNodeConnection?.(request);
    if (connection && (
      connection.controlNodeId !== request.controlNodeId ||
      connection.controlNodeBootId !== request.controlNodeBootId ||
      connection.endpointId !== endpointId
    )) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child reverse connection does not match the authenticated attachment",
      );
    }
    const result = this.catalog.attachChild({
      ...request,
      endpointId,
    });
    if (connection) {
      // The child cannot apply the returned attachment fence until this RPC
      // completes. Remember the reverse port now and synchronize on its first
      // fenced heartbeat, after the child has committed the role transition.
      this.#rememberChildConnection(connection);
      this.#pendingChildSynchronizations.add(connection.controlNodeId);
    }
    return {
      accepted: true,
      canonical: result.child,
      attachment: result.attachment,
      parentCheckpoint: this.catalog.feedCheckpoint(),
    };
  }

  public async attachChildConnection(connection: ChildControlNodeConnection): Promise<void> {
    return this.#synchronizeChildConnection(connection);
  }

  public detachChildConnection(connection: ChildControlNodeConnection): void;
  public detachChildConnection(id: ControlNodeId, bootId?: string): void;
  public detachChildConnection(
    connectionOrId: ChildControlNodeConnection | ControlNodeId,
    bootId?: string,
  ): void {
    const explicitConnection = typeof connectionOrId === "string"
      ? undefined
      : connectionOrId;
    const id = explicitConnection?.controlNodeId ??
      (connectionOrId as ControlNodeId);
    const current = this.#childConnections.get(id);
    const synchronization = this.#childSynchronizations.get(id);
    // Passing the connection object is the generation-safe transport teardown
    // API. The ID/boot overload is retained for callers that cannot yet retain
    // their reverse port; it targets the installed connection before a pending
    // replacement so an old channel closing cannot cancel that replacement.
    const target = explicitConnection ?? current ?? synchronization?.connection;
    if (!target || (bootId !== undefined && target.controlNodeBootId !== bootId)) {
      return;
    }

    let removed = false;
    if (synchronization?.connection === target) {
      this.#invalidateChildSynchronization(id);
      removed = true;
    }
    if (current === target) {
      this.#childConnections.delete(id);
      removed = true;
    }
    const pump = this.#childPumps.get(id);
    if (pump?.connection === target) {
      pump.controller.abort();
      this.#childPumps.delete(id);
      removed = true;
    }
    if (!removed) return;
    if (!this.#childConnections.has(id) && !this.#childSynchronizations.has(id)) {
      this.#pendingChildSynchronizations.delete(id);
    }
    if (!this.#childPumps.has(id) && !this.#childSynchronizations.has(id)) {
      this.catalog.markChildDisconnected(id, target.controlNodeBootId);
    }
  }

  public async heartbeatChild(input: ControlNodeLinkFence & { checkpoint: import("@arduano/agent-multiplex-protocol").FeedCheckpoint }, context: ChildControlNodeIngressContext = {}) {
    this.#assertChildFence(input, context);
    const inFlight = this.#childSynchronizations.get(input.controlNodeId);
    if (inFlight && this.#synchronizationMatchesHeartbeat(inFlight, input, context)) {
      await inFlight.task;
    } else {
      let connection = this.#childConnections.get(input.controlNodeId);
      if (!connection) {
        connection = context.createChildControlNodeConnection?.({
          controlNodeId: input.controlNodeId,
          controlNodeBootId: input.controlNodeBootId,
        });
      }
      if (connection) {
        if (
          connection.controlNodeId !== input.controlNodeId ||
          connection.controlNodeBootId !== input.controlNodeBootId ||
          connection.endpointId !== context.endpointId
        ) {
          throw new ControlNodeCoreError(
            "FENCED",
            "child heartbeat factory returned another authenticated reverse connection",
          );
        }
        this.#assertChildConnectionMatchesActiveAttachment(connection);
        const pump = this.#childPumps.get(input.controlNodeId);
        const imported = this.catalog.childCheckpoint(input.controlNodeId);
        if (
          this.#pendingChildSynchronizations.has(input.controlNodeId) ||
          !imported ||
          imported.feedId !== input.checkpoint.feedId ||
          !pump ||
          pump.settled ||
          pump.connection !== connection
        ) {
          await this.#synchronizeChildConnection(connection);
        }
      }
    }
    if (!this.catalog.heartbeatChild(input.controlNodeId, input.controlNodeBootId)) {
      throw new ControlNodeCoreError("FENCED", "stale child control-node boot ID");
    }
    return {
      accepted: true,
      parentCheckpoint: this.catalog.feedCheckpoint(),
      ...(this.#p2pTicket?.() ? { p2pTicket: this.#p2pTicket!() } : {}),
    };
  }

  public async detachTopology(_input: TopologyDetachInput): Promise<TopologyDetachmentReceipt> {
    // A truthful graceful detach needs a durable prepare/drain/commit protocol:
    // freeze new subtree proposals, settle the independently transported
    // metadata outbox through the authority, persist an idempotent hand-off,
    // then acknowledge both sides. Committing the parent edge first leaves an
    // unrecoverable acknowledgement window and can strand queued operations.
    // Until that protocol exists, fail before changing either catalog. The
    // explicit audited force-detach path is the supported v3 escape hatch.
    throw new ControlNodeCoreError(
      "UNAVAILABLE",
      "graceful topology detach requires prepare/drain/commit and is not supported by protocol v4; use audited forceDetach on the branch",
    );
  }

  public forceDetachTopology(input: TopologyForceDetachInput): TopologyDetachmentReceipt {
    return this.catalog.forceDetach(input);
  }

  public promoteAuthority(input: AuthorityPromoteInput): AuthorityPromotionReceipt {
    return this.catalog.promote(authorityPromoteInputSchema.parse(input));
  }

  public applyDetachmentFromParent(receipt: TopologyDetachmentReceipt, fence: ControlNodeLinkFence, context: ControlNodePeerContext = {}) {
    this.#assertParentFence(fence, context);
    return this.catalog.applyDetachmentReceipt(receipt);
  }

  /** Validate that a recursive RPC came from this branch's currently attached parent. */
  public assertParentLink(
    fence: ControlNodeLinkFence,
    context: ControlNodePeerContext = {},
  ): void {
    this.#assertParentFence(fence, context);
  }

  public readSubtreeSnapshot(inputValue: ControlNodeSubtreeSnapshotRequest, context: ControlNodePeerContext = {}): ControlNodeSubtreeSnapshotPage {
    const input = controlNodeSubtreeSnapshotRequestSchema.parse(inputValue);
    this.#assertParentFence(input, context);
    this.#pruneTraversals();
    let traversal: SnapshotTraversal;
    let token = input.pageToken;
    if (token === undefined) {
      if (this.#snapshotTraversals.size >= this.#maximumSnapshotTraversals) {
        throw new ControlNodeCoreError("UNAVAILABLE", "too many concurrent subtree snapshot traversals");
      }
      token = randomUUID();
      const snapshot = this.catalog.accessSnapshot();
      if (accessSnapshotItemCount(snapshot) > this.#maximumSnapshotItems) {
        throw new ControlNodeCoreError("UNAVAILABLE", `subtree snapshot exceeds ${this.#maximumSnapshotItems} items`);
      }
      traversal = {
        snapshot,
        attachmentId: input.attachmentId,
        lineageId: input.lineageId,
        expiresAt: this.#now().getTime() + this.#snapshotTraversalTtlMs,
        index: 0,
      };
      this.#snapshotTraversals.set(token, traversal);
    } else {
      const found = this.#snapshotTraversals.get(token);
      if (!found || found.attachmentId !== input.attachmentId || found.lineageId !== input.lineageId) {
        throw new ControlNodeCoreError("FENCED", "snapshot page token is missing, expired, or fenced");
      }
      traversal = found;
    }
    const flattened = flattenSnapshot(traversal.snapshot);
    const page = flattened.slice(traversal.index, traversal.index + input.limit);
    traversal.index += page.length;
    const done = traversal.index >= flattened.length;
    if (done) this.#snapshotTraversals.delete(token);
    const split = splitSnapshotItems(page);
    return controlNodeSubtreeSnapshotPageSchema.parse({
      source: traversal.snapshot.source,
      attachmentId: traversal.attachmentId,
      lineageId: traversal.lineageId,
      checkpoint: {
        feedId: traversal.snapshot.source.manifest.feedId,
        controlCursor: traversal.snapshot.source.manifest.controlCursor,
      },
      capturedAt: traversal.snapshot.capturedAt,
      ...split,
      nextPageToken: done ? null : token,
    });
  }

  public subscribeAggregate(cursor: StreamCursor, fence: ControlNodeLinkFence, context: ControlNodePeerContext = {}, signal?: AbortSignal) {
    this.#assertParentFence(fence, context);
    return this.events.attach({ sessions: "all", cursor, includeNative: true }, signal);
  }

  public attachRuntimeNodeConnection(connection: RuntimeNodeConnection): void {
    const descriptor = this.catalog.getRuntimeNode(connection.runtimeNodeId);
    if (
      !descriptor ||
      descriptor.runtimeNodeBootId !== connection.runtimeNodeBootId ||
      (descriptor.endpointId !== undefined &&
        descriptor.endpointId !== connection.endpointId)
    ) {
      throw new ControlNodeCoreError("FENCED", "runtime connection does not match registration");
    }
    this.#runtimeConnections.set(connection.runtimeNodeId, connection);
    this.#onRuntimeNodeConnectionAttached?.(connection);
    void this.flushMetadataDeliveries();
  }

  public detachRuntimeNodeConnection(id: RuntimeNodeId, bootId?: string): void {
    const current = this.#runtimeConnections.get(id);
    if (current && (bootId === undefined || current.runtimeNodeBootId === bootId)) {
      this.#runtimeConnections.delete(id);
      this.catalog.markRuntimeNodeDisconnected(id, current.runtimeNodeBootId);
    }
  }

  public registerRuntimeNode(input: RuntimeNodeRegistration, context: RuntimeNodeIngressContext = {}) {
    const registration = runtimeNodeRegistrationSchema.parse(input);
    const endpointId = this.#assertRuntimeEnrollmentIdentity(
      registration.runtimeNodeId,
      context,
    );
    const connection = context.runtimeNodeConnection ?? context.createRuntimeNodeConnection?.(
      registration.runtimeNodeId,
      registration.runtimeNodeBootId,
    );
    if (connection && (
      connection.runtimeNodeId !== registration.runtimeNodeId ||
      connection.runtimeNodeBootId !== registration.runtimeNodeBootId ||
      connection.endpointId !== endpointId
    )) {
      throw new ControlNodeCoreError(
        "FENCED",
        "runtime reverse connection does not match the authenticated registration",
      );
    }
    const canonical = this.catalog.registerRuntimeNode(registration, endpointId);
    if (connection) this.attachRuntimeNodeConnection(connection);
    return { accepted: true, canonical };
  }

  public heartbeatRuntimeNode(input: { runtimeNodeId: RuntimeNodeId; runtimeNodeBootId: import("@arduano/agent-multiplex-protocol").RuntimeNodeBootId }, context: RuntimeNodeIngressContext = {}) {
    this.#assertRuntimeFence(input, context);
    if (!this.#runtimeConnections.has(input.runtimeNodeId)) {
      const connection = context.createRuntimeNodeConnection?.(
        input.runtimeNodeId,
        input.runtimeNodeBootId,
      );
      if (connection) this.attachRuntimeNodeConnection(connection);
    }
    this.catalog.heartbeatRuntimeNode(input.runtimeNodeId, input.runtimeNodeBootId);
    return {
      accepted: true,
      controlCursor: this.catalog.controlCursor(),
      ...(this.#p2pTicket?.() ? { p2pTicket: this.#p2pTicket!() } : {}),
    };
  }

  public reconcile(
    input: RuntimeNodeFence & { snapshot: InventorySnapshot },
    context: RuntimeNodeIngressContext = {},
  ) {
    const snapshot = inventorySnapshotSchema.parse(input.snapshot);
    this.#assertRuntimeFence(input, context);
    if (snapshot.runtimeNodeId !== input.runtimeNodeId) {
      throw new ControlNodeCoreError("FENCED", "inventory does not match runtime-node fence");
    }
    return { sessions: this.catalog.reconcileInventory(snapshot), controlCursor: this.catalog.controlCursor() };
  }

  public publishRuntimeEvent(
    input: RuntimeNodeFence & { event: RuntimeNodeEventItem },
    context: RuntimeNodeIngressContext = {},
  ) {
    this.#assertRuntimeFence(input, context);
    const event = runtimeNodeEventItemSchema.parse(input.event);
    if (event.kind === "control") {
      switch (event.change.type) {
        case "session.upsert":
          this.#assertRuntimeEventOwner(input.runtimeNodeId, event.change.session.runtimeNodeId);
          this.catalog.mergeRuntimeSession(event.change.session);
          break;
        case "interaction.changed": {
          const session = this.catalog.getSession(event.change.interaction.sessionId);
          // Runtime event delivery and inventory reconciliation are independent
          // streams. Do not acknowledge an interaction before its session bind.
          if (!session) return { accepted: false };
          this.#assertRuntimeEventOwner(input.runtimeNodeId, session.runtimeNodeId);
          this.catalog.publishInteraction(event.change.interaction);
          break;
        }
        case "launch.changed":
          this.#assertRuntimeEventOwner(input.runtimeNodeId, event.change.launch.runtimeNodeId);
          this.catalog.recordLaunch(event.change.launch);
          break;
        case "archive.changed":
          this.#assertRuntimeEventOwner(input.runtimeNodeId, event.change.archive.runtimeNodeId);
          this.catalog.recordArchive(event.change.archive);
          break;
      }
    } else if (event.kind === "native" || event.kind === "nativeGap") {
      const session = this.catalog.getSession(event.sessionId);
      // See the interaction case above. Returning false is an explicit
      // transient negative acknowledgement, not successful ingestion. In
      // particular, the reverse-feed pump must leave its native cursor
      // untouched so sequence zero remains replayable.
      if (!session || session.catalogState === "archived") return { accepted: false };
      this.#assertRuntimeEventOwner(input.runtimeNodeId, session.runtimeNodeId);
      if (event.kind === "native" && (
        event.harness !== session.harness ||
        event.runtimeEpoch !== session.runtimeEpoch
      )) {
        throw new ControlNodeCoreError(
          "FENCED",
          "native event targets a stale session harness or runtime epoch",
        );
      }
      this.events.publishRuntimeItem(event);
    }
    return { accepted: true };
  }

  public publishInteraction(
    input: RuntimeNodeFence & { interaction: InteractionRecord },
    context: RuntimeNodeIngressContext = {},
  ) {
    this.#assertRuntimeFence(input, context);
    const session = this.catalog.getSession(input.interaction.sessionId);
    if (!session) throw new ControlNodeCoreError("NOT_FOUND", "interaction session is unknown");
    this.#assertRuntimeEventOwner(input.runtimeNodeId, session.runtimeNodeId);
    return this.catalog.publishInteraction(input.interaction);
  }

  public harnessCatalog(runtimeNodeId?: RuntimeNodeId): HarnessCatalogEntry[] {
    const entries = this.catalog.listRuntimeNodes()
      .filter((node) => runtimeNodeId === undefined || node.runtimeNodeId === runtimeNodeId)
      .flatMap((node) => node.harnesses);
    return entries.filter((entry, index) => entries.findIndex((candidate) =>
      candidate.harness === entry.harness && candidate.adapterScopeId === entry.adapterScopeId,
    ) === index);
  }

  public listModels(runtimeNodeId: RuntimeNodeId, harness: Harness): Promise<NativeModel[]> {
    const route = this.#route(runtimeNodeId);
    return route.immediateChildControlNodeId
      ? this.#child(route).listModels(runtimeNodeId, harness)
      : this.#runtime(runtimeNodeId).listModels(harness);
  }

  public listLaunchProfiles(options: {
    runtimeNodeId?: RuntimeNodeId;
    providerId?: string;
    harness?: Harness;
  } = {}): LaunchProfileDescriptor[] {
    return this.catalog.listRuntimeNodes()
      .filter((node) => options.runtimeNodeId === undefined || node.runtimeNodeId === options.runtimeNodeId)
      .flatMap((node) => node.launchProfiles)
      .filter((profile) => options.providerId === undefined || profile.providerId === options.providerId)
      .filter((profile) => options.harness === undefined || profile.harnesses.includes(options.harness))
      .filter((profile, index, profiles) => profiles.findIndex((candidate) =>
        candidate.providerId === profile.providerId &&
        candidate.profileId === profile.profileId &&
        candidate.contractVersion === profile.contractVersion &&
        candidate.requestSchemaHash === profile.requestSchemaHash &&
        candidate.implementationVersion === profile.implementationVersion
      ) === index);
  }

  public listLaunchProfileModels(
    runtimeNodeId: RuntimeNodeId,
    profile: LaunchProfileIdentity,
    harness: Harness,
  ): Promise<NativeModel[]> {
    const runtime = this.catalog.getRuntimeNode(runtimeNodeId);
    const advertised = runtime?.launchProfiles.some((candidate) =>
      candidate.providerId === profile.providerId &&
      candidate.profileId === profile.profileId &&
      candidate.contractVersion === profile.contractVersion &&
      candidate.requestSchemaHash === profile.requestSchemaHash &&
      candidate.available &&
      candidate.harnesses.includes(harness)
    );
    if (!advertised) {
      throw new ControlNodeCoreError("NOT_FOUND", "launch profile is not available on the selected runtime node");
    }
    const route = this.#route(runtimeNodeId);
    return route.immediateChildControlNodeId
      ? this.#child(route).listLaunchProfileModels(runtimeNodeId, profile, harness)
      : this.#runtime(runtimeNodeId).listLaunchProfileModels(profile, harness);
  }

  public async refresh(runtimeNodeId: RuntimeNodeId): Promise<InventorySnapshot> {
    const route = this.#route(runtimeNodeId);
    const fence = this.#captureDispatchFence(runtimeNodeId);
    const snapshot = inventorySnapshotSchema.parse(route.immediateChildControlNodeId
      ? await this.#child(route).refreshInventory(runtimeNodeId)
      : await this.#runtime(runtimeNodeId).refreshInventory());
    this.#assertDispatchFence(fence);
    if (snapshot.runtimeNodeId !== runtimeNodeId) {
      throw new ControlNodeCoreError(
        "FENCED",
        "inventory response belongs to another runtime node",
      );
    }
    if (!route.immediateChildControlNodeId) this.catalog.reconcileInventory(snapshot);
    return snapshot;
  }

  public createLaunch(inputValue: LaunchRequest): Promise<LaunchRecord> {
    const request = launchRequestSchema.parse(inputValue);
    const current = this.catalog.getLaunch(request.launchId);
    if (current) {
      assertLaunchRequest(current, request);
    }
    const inFlight = this.#launchDispatches.get(request.launchId);
    if (inFlight) {
      assertSameLaunchRequest(inFlight.request, request);
      return inFlight.promise;
    }
    if (current) {
      return isTerminalLaunch(current)
        ? Promise.resolve(current)
        : this.#refreshLaunch(current);
    }
    if (this.catalog.getSession(request.sessionId)) {
      throw new ControlNodeCoreError("CONFLICT", `logical session ${request.sessionId} is already bound`);
    }
    const route = this.#route(request.runtimeNodeId);
    const fence = this.#captureDispatchFence(request.runtimeNodeId);
    const runtime = this.catalog.getRuntimeNode(request.runtimeNodeId);
    const profile = runtime?.launchProfiles.find((candidate) =>
      candidate.providerId === request.profile.providerId &&
      candidate.profileId === request.profile.profileId &&
      candidate.contractVersion === request.profile.contractVersion &&
      candidate.requestSchemaHash === request.profile.requestSchemaHash &&
      candidate.available &&
      candidate.harnesses.includes(request.harness)
    );
    if (!profile) {
      throw new ControlNodeCoreError(
        "NOT_FOUND",
        "launch profile is not available on the selected runtime node",
      );
    }

    // The control node must durably reserve the logical session before the
    // request crosses a process boundary. Native inventory and the runtime's
    // binding event use independent streams and can otherwise overtake the
    // launch response, causing inventory to import the just-created native
    // session under a fresh logical ID. Each forwarding control records its
    // own admission timestamp; record merging retains that local timestamp.
    const admittedAt = this.#now().toISOString();
    this.catalog.recordLaunch(launchRecordSchema.parse({
      ...request,
      implementationVersion: profile.implementationVersion,
      state: "accepted",
      createdAt: admittedAt,
      updatedAt: admittedAt,
    }), route.immediateChildControlNodeId ?? null);

    const promise = (async () => {
      let resultValue: LaunchRecord;
      try {
        resultValue = route.immediateChildControlNodeId
          ? await this.#child(route).createLaunch(request)
          : await this.#runtime(request.runtimeNodeId).createLaunch(request);
      } catch (cause) {
        const durable = this.catalog.getLaunch(request.launchId);
        if (durable) return durable;
        throw cause;
      }
      const result = launchRecordSchema.parse(resultValue);
      this.#assertDispatchFence(fence);
      assertLaunchRequest(result, request);
      return this.catalog.recordLaunch(
        result,
        route.immediateChildControlNodeId ?? null,
      );
    })();
    this.#launchDispatches.set(request.launchId, { request, promise });
    const release = () => {
      if (this.#launchDispatches.get(request.launchId)?.promise === promise) {
        this.#launchDispatches.delete(request.launchId);
      }
    };
    void promise.then(release, release);
    return promise;
  }

  public resume(command: ResumeCommand): Promise<CommandRecord> {
    this.#assertOpenBinding(command.sessionId, command.runtimeNodeId, command.bindingRevision);
    return this.#dispatch(command.commandId, command, () => {
      const route = this.#route(command.runtimeNodeId);
      return route.immediateChildControlNodeId
        ? this.#child(route).resume(command)
        : this.#runtime(command.runtimeNodeId).resume(command);
    }, true);
  }

  public stop(commandValue: StopCommand): Promise<CommandRecord> {
    const command = stopCommandSchema.parse(commandValue);
    this.#assertOpenBinding(command.sessionId, command.runtimeNodeId, command.bindingRevision);
    return this.#dispatch(command.commandId, command, () => {
      const route = this.#route(command.runtimeNodeId);
      return route.immediateChildControlNodeId
        ? this.#child(route).stop(command)
        : this.#runtime(command.runtimeNodeId).stop(command);
    }, true).then((record) => {
      if (record.state === "succeeded") {
        this.catalog.markSessionStopped(command.sessionId, command.bindingRevision);
      }
      return record;
    });
  }

  public archive(inputValue: ArchiveRequest): Promise<ArchiveRecord> {
    const request = archiveRequestSchema.parse(inputValue);
    const current = this.catalog.getArchive(request.archiveOperationId);
    if (current) {
      assertArchiveRequest(current, request);
      return isTerminalArchive(current)
        ? Promise.resolve(current)
        : this.#refreshArchive(current);
    }
    this.#assertOpenBinding(request.sessionId, request.runtimeNodeId, request.bindingRevision);
    const session = this.catalog.getSession(request.sessionId)!;
    if (session.availability === "active" || session.runtimeStatus !== "stopped") {
      throw new ControlNodeCoreError("CONFLICT", "stop the session before archiving it");
    }
    if (!sameAuthority(request.expectedAuthority, this.catalog.authority())) {
      throw new ControlNodeCoreError("FENCED", "archive request carries a stale authority epoch");
    }
    const inFlight = this.#archiveDispatches.get(request.archiveOperationId);
    if (inFlight) {
      assertSameArchiveRequest(inFlight.request, request);
      return inFlight.promise;
    }
    const route = this.#route(request.runtimeNodeId);
    const fence = this.#captureDispatchFence(request.runtimeNodeId);
    const promise = (async () => {
      try {
        const result = archiveRecordSchema.parse(route.immediateChildControlNodeId
          ? await this.#child(route).archive(request)
          : await this.#runtime(request.runtimeNodeId).archive(request));
        this.#assertDispatchFence(fence);
        assertArchiveRequest(result, request);
        return this.catalog.recordArchive(
          result,
          route.immediateChildControlNodeId ?? null,
        );
      } catch (cause) {
        const durable = this.catalog.getArchive(request.archiveOperationId);
        if (durable) return durable;
        throw cause;
      } finally {
        this.#archiveDispatches.delete(request.archiveOperationId);
      }
    })();
    this.#archiveDispatches.set(request.archiveOperationId, { request, promise });
    return promise;
  }

  public execute(command: CommandEnvelope): Promise<CommandRecord> {
    const session = this.catalog.getSession(command.sessionId);
    if (!session || session.catalogState !== "open" || session.runtimeNodeId !== command.runtimeNodeId || session.bindingRevision !== command.bindingRevision) {
      throw new ControlNodeCoreError("FENCED", "agent command carries a stale session binding");
    }
    return this.#dispatch(command.commandId, command, () => {
      const route = this.#route(command.runtimeNodeId);
      return route.immediateChildControlNodeId
        ? this.#child(route).execute(command)
        : this.#runtime(command.runtimeNodeId).execute(command);
    });
  }

  public readNativeHistory(sessionId: SessionId, request: NativeHistoryRequest): Promise<NativeHistoryResult> {
    const session = this.catalog.getSession(sessionId);
    if (!session) throw new ControlNodeCoreError("NOT_FOUND", "session is unknown");
    if (session.catalogState === "archived") {
      throw new ControlNodeCoreError("CONFLICT", "archived session resources have been released");
    }
    const route = this.#route(session.runtimeNodeId);
    return route.immediateChildControlNodeId
      ? this.#child(route).readNativeHistory(sessionId, request)
      : this.#runtime(session.runtimeNodeId).readNativeHistory(sessionId, request);
  }

  public async getTerminal(input: TerminalGetInput): Promise<TerminalDescriptor | null> {
    this.#assertTerminalTarget(input);
    const fence = this.#captureDispatchFence(input.runtimeNodeId);
    const route = this.#route(input.runtimeNodeId);
    const connection = this.#terminal(route.immediateChildControlNodeId
      ? this.#child(route)
      : this.#runtime(input.runtimeNodeId));
    const result = terminalDescriptorSchema.nullable().parse(
      await connection.getTerminal(input),
    );
    this.#assertDispatchFence(fence);
    this.#assertTerminalTarget(input);
    if (result !== null) this.#assertTerminalDescriptor(input, result);
    return result;
  }

  public async openTerminal(input: TerminalOpenInput): Promise<TerminalOpenResult> {
    this.#assertTerminalTarget(input, true);
    const fence = this.#captureDispatchFence(input.runtimeNodeId);
    const route = this.#route(input.runtimeNodeId);
    const connection = this.#terminal(route.immediateChildControlNodeId
      ? this.#child(route)
      : this.#runtime(input.runtimeNodeId));
    const result = terminalOpenResultSchema.parse(
      await connection.openTerminal(input),
    );
    this.#assertDispatchFence(fence);
    this.#assertTerminalTarget(input, true);
    this.#assertTerminalDescriptor(input, result.terminal);
    return result;
  }

  public attachTerminal(
    input: TerminalAttachInput,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalStreamItem> {
    this.#assertTerminalTarget(input);
    const fence = this.#captureDispatchFence(input.runtimeNodeId);
    const route = this.#route(input.runtimeNodeId);
    const connection = this.#terminal(route.immediateChildControlNodeId
      ? this.#child(route)
      : this.#runtime(input.runtimeNodeId));
    return this.#guardTerminalStream(
      input,
      fence,
      (streamSignal) => connection.attachTerminal(input, streamSignal),
      signal,
    );
  }

  public async acquireTerminalLease(
    input: TerminalLeaseAcquireInput,
  ): Promise<TerminalLeaseAcquireResult> {
    return this.#dispatchTerminalMutation(input, (connection) =>
      connection.acquireTerminalLease(input));
  }

  public async renewTerminalLease(
    input: TerminalLeaseRenewInput,
  ): Promise<TerminalLeaseRenewResult> {
    return this.#dispatchTerminalMutation(input, (connection) =>
      connection.renewTerminalLease(input));
  }

  public async releaseTerminalLease(
    input: TerminalLeaseReleaseInput,
  ): Promise<TerminalLeaseReleaseResult> {
    return this.#dispatchTerminalMutation(input, (connection) =>
      connection.releaseTerminalLease(input));
  }

  public async sendTerminalInput(input: TerminalInput): Promise<TerminalInputResult> {
    return this.#dispatchTerminalMutation(input, (connection) =>
      connection.sendTerminalInput(input));
  }

  public async terminateTerminal(input: TerminalTerminateInput): Promise<TerminalDescriptor> {
    const descriptor = await this.#dispatchTerminalMutation(input, (connection) =>
      connection.terminateTerminal(input));
    const parsed = terminalDescriptorSchema.parse(descriptor);
    this.#assertTerminalDescriptor(input, parsed);
    return parsed;
  }

  public async patchMetadata(patch: MetadataPatch): Promise<MetadataOperationRecord> {
    const operation = this.catalog.submitMetadataPatch(patch);
    if (operation.status === "queued") {
      try { await this.flushMetadataOutbox(); }
      catch { /* The durable queued operation remains retryable. */ }
    }
    const current = this.catalog.getMetadataOperation(operation.operationId) ?? operation;
    if (current.status !== "queued") void this.flushMetadataDeliveries();
    return current;
  }

  public async pushRuntimeMetadataOutbox(
    input: RuntimeNodeFence & { patches: MetadataPatch[] },
    context: RuntimeNodeIngressContext = {},
  ) {
    this.#assertRuntimeFence(input, context);
    const patches = input.patches.map((patch) => metadataPatchSchema.parse(patch));
    for (const patch of patches) {
      const session = this.catalog.getSession(patch.sessionId);
      if (!session) throw new ControlNodeCoreError("NOT_FOUND", "metadata session is unknown");
      this.#assertRuntimeEventOwner(input.runtimeNodeId, session.runtimeNodeId);
    }
    const operations = patches.map((patch) => this.catalog.submitMetadataPatch(patch));
    try { await this.flushMetadataOutbox(); }
    catch { /* Return each durable local state; the outbox remains retryable. */ }
    void this.flushMetadataDeliveries();
    return operations.map((operation) =>
      this.catalog.getMetadataOperation(operation.operationId) ?? operation,
    );
  }

  public async pushChildMetadataOutbox(
    input: ControlNodeLinkFence & { operations: MetadataOperationRecord[] },
    context: ChildControlNodeIngressContext = {},
  ): Promise<MetadataOperationRecord[]> {
    this.#assertChildFence(input, context);
    const awaitingSessionProjection = new Set<MetadataOperationRecord>();
    const results = input.operations.map((operation) => {
      const parsed = metadataOperationRecordSchema.parse(operation);
      if (parsed.status !== "queued") {
        throw new ControlNodeCoreError("CONFLICT", "child outbox accepts queued proposals only");
      }
      const session = this.catalog.getSession(parsed.sessionId);
      if (!session) {
        // The child's durable metadata outbox and aggregate control feed are
        // independent streams. A new session's proposal can therefore reach
        // us before its session.upsert projection. Do not persist or forward
        // an operation whose route cannot yet be authenticated; echoing the
        // queued record leaves it in the child's outbox for a later retry.
        awaitingSessionProjection.add(parsed);
        return parsed;
      }
      const route = this.catalog.routeForRuntimeNode(session.runtimeNodeId);
      if (route?.immediateChildControlNodeId !== input.controlNodeId) {
        throw new ControlNodeCoreError("FENCED", "child metadata proposal targets a session outside its subtree");
      }
      if (!this.catalog.isControlNodeProjectedThrough(input.controlNodeId, parsed.originControlNodeId)) {
        throw new ControlNodeCoreError("FENCED", "child metadata proposal has a foreign origin control node");
      }
      return this.catalog.dataRole().role === "authority"
        ? this.catalog.applyMetadataAtAuthority(parsed)
        : this.catalog.submitMetadataPatch(parsed.patch, parsed.originControlNodeId);
    });
    try { await this.flushMetadataOutbox(); }
    catch { /* Every input is already journaled locally. */ }
    void this.flushMetadataDeliveries();
    return results.map((operation) =>
      awaitingSessionProjection.has(operation)
        ? operation
        : this.catalog.getMetadataOperation(operation.operationId) ?? operation,
    );
  }

  public async flushMetadataOutbox(): Promise<number> {
    if (this.#metadataUpstreamFlush) return this.#metadataUpstreamFlush;
    const task = this.#flushMetadataOutboxOnce();
    this.#metadataUpstreamFlush = task;
    try { return await task; }
    finally {
      if (this.#metadataUpstreamFlush === task) this.#metadataUpstreamFlush = null;
    }
  }

  public async applyMetadataFromParent(operation: MetadataOperationRecord, fence: ControlNodeLinkFence, context: ControlNodePeerContext = {}) {
    this.#assertParentFence(fence, context);
    const settled = this.catalog.settleMetadataOperation(operation, {
      authenticatedParent: true,
    });
    void this.flushMetadataDeliveries();
    return settled;
  }

  /** Best-effort terminal receipt delivery. Durable intents survive failures. */
  public async flushMetadataDeliveries(): Promise<number> {
    if (this.#metadataDeliveryFlush) return this.#metadataDeliveryFlush;
    const task = this.#flushMetadataDeliveriesOnce();
    this.#metadataDeliveryFlush = task;
    try { return await task; }
    finally {
      if (this.#metadataDeliveryFlush === task) this.#metadataDeliveryFlush = null;
    }
  }

  public async resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord> {
    const current = this.catalog.getInteraction(input.interactionId);
    if (!current || current.sessionId !== input.sessionId || current.harness !== input.harness) {
      throw new ControlNodeCoreError("FENCED", "interaction identity is stale");
    }
    if (current.state !== "pending") {
      if (
        current.state === "resolved" &&
        current.resolution !== undefined &&
        sameJson(current.resolution, input.response)
      ) return current;
      throw new ControlNodeCoreError(
        "CONFLICT",
        `interaction is already ${current.state}`,
      );
    }
    if (
      current.expiresAt !== null &&
      Date.parse(current.expiresAt) <= this.#now().getTime()
    ) {
      this.catalog.updateInteraction({
        ...current,
        state: "expired",
        resolvedAt: this.#now().toISOString(),
      });
      throw new ControlNodeCoreError("CONFLICT", "interaction has expired");
    }
    const session = this.catalog.getSession(input.sessionId);
    if (
      !session ||
      session.harness !== current.harness ||
      session.runtimeEpoch !== current.runtimeEpoch
    ) {
      throw new ControlNodeCoreError("FENCED", "interaction targets a stale runtime epoch");
    }

    const response = canonicalJson(jsonValueSchema.parse(input.response));
    const inFlight = this.#interactionResolutions.get(input.interactionId);
    if (inFlight) {
      if (inFlight.response !== response) {
        throw new ControlNodeCoreError(
          "CONFLICT",
          "interaction resolution is already in progress with another response",
        );
      }
      return inFlight.promise;
    }

    const promise = (async () => {
      const route = this.#route(session.runtimeNodeId);
      const fence = this.#captureDispatchFence(session.runtimeNodeId);
      const result = interactionRecordSchema.parse(
        route.immediateChildControlNodeId
          ? await this.#child(route).resolveInteraction(input)
          : await this.#runtime(session.runtimeNodeId).resolveInteraction(input),
      );
      this.#assertDispatchFence(fence);
      assertInteractionResponse(current, result, input.response);
      return this.catalog.updateInteraction(result);
    })();
    this.#interactionResolutions.set(input.interactionId, { response, promise });
    try {
      return await promise;
    } finally {
      if (this.#interactionResolutions.get(input.interactionId)?.promise === promise) {
        this.#interactionResolutions.delete(input.interactionId);
      }
    }
  }

  public async recoverCommand(id: CommandId): Promise<CommandRecord | null> {
    const current = this.catalog.getCommand(id);
    if (!current) return null;
    if (current.state !== "outcomeUnknown") {
      await this.#repairLifecycleBinding(current);
      return current;
    }
    const route = this.catalog.routeForRuntimeNode(current.runtimeNodeId);
    if (!route) return current;
    let getCommand: ((commandId: CommandId) => Promise<CommandRecord | null>) | undefined;
    try {
      const connection = route.immediateChildControlNodeId
        ? this.#child(route)
        : this.#runtime(current.runtimeNodeId);
      getCommand = connection.getCommand?.bind(connection);
    } catch (cause) {
      if (cause instanceof ControlNodeCoreError && cause.code === "UNAVAILABLE") return current;
      throw cause;
    }
    if (!getCommand) return current;

    let recoveredInput: CommandRecord | null;
    try {
      recoveredInput = await getCommand(id);
    } catch {
      // Reading recovery state is safe to retry. Keep the durable ambiguous
      // result when the owning route is temporarily unavailable.
      return current;
    }
    if (!recoveredInput) return current;
    let recovered: CommandRecord;
    try {
      recovered = commandRecordSchema.parse(recoveredInput);
    } catch (cause) {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        `recovered command ${id} is malformed`,
        undefined,
        { cause },
      );
    }
    assertRecoveredCommandResponse(current, recovered);
    if (recovered.state === "outcomeUnknown") return current;
    const recoveredRecord = this.catalog.recoverCommandOutcome({
      ...recovered,
      createdAt: current.createdAt,
    });
    await this.#repairLifecycleBinding(recoveredRecord);
    return recoveredRecord;
  }

  #dispatch(
    id: CommandId,
    input: ResumeCommand | StopCommand | CommandEnvelope,
    operation: () => Promise<CommandRecord>,
    refreshLifecycle = false,
  ): Promise<CommandRecord> {
    const current = this.catalog.getCommand(id);
    if (current) {
      assertCommandRequest(current, input);
      if (current.state === "outcomeUnknown") {
        return this.recoverCommand(id).then((recovered) => recovered ?? current);
      }
      if (current.state !== "received" && current.state !== "started") {
        return this.#repairLifecycleBinding(current, refreshLifecycle).then(() => current);
      }
    }
    const inFlight = this.#dispatches.get(id);
    if (inFlight) return inFlight;
    if (current) {
      // A non-terminal record without an in-memory dispatch can only be an
      // interrupted dispatch. Never issue the command a second time.
      const unknown = commandRecordSchema.parse({
        ...current,
        state: "outcomeUnknown",
        error: "control-node dispatch ownership was lost before a terminal response",
        updatedAt: this.#now().toISOString(),
      });
      return Promise.resolve(this.catalog.updateCommand(unknown));
    }
    // Resolve and snapshot every process/link epoch before the first durable
    // dispatch marker. A response is accepted only while this exact route is
    // still current.
    const dispatchFence = this.#captureDispatchFence(input.runtimeNodeId);
    const timestamp = this.#now().toISOString();
    this.catalog.acceptCommand(commandRecordSchema.parse({
        commandId: id,
        payloadHash: input.payloadHash,
        sessionId: input.sessionId,
        runtimeNodeId: input.runtimeNodeId,
        state: "started",
        request: input,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    const promise = (async () => {
      try {
        const result = commandRecordSchema.parse(await operation());
        this.#assertDispatchFence(dispatchFence);
        assertCommandResponse(result, input);
        const accepted = this.catalog.getCommand(id)!;
        const stored = this.catalog.updateCommand(commandRecordSchema.parse({
          ...result,
          createdAt: accepted.createdAt,
        }));
        // The native side effect and command receipt are already final. A
        // failed inventory refresh is durable repair work and must never make
        // callers replay a lifecycle command.
        await this.#repairLifecycleBinding(stored, refreshLifecycle);
        return stored;
      } catch (cause) {
        const durable = this.catalog.getCommand(id)!;
        if (durable.state === "succeeded" || durable.state === "failed") {
          return durable;
        }
        if (durable.state !== "outcomeUnknown") {
          const unknown = commandRecordSchema.parse({
            ...durable,
            state: "outcomeUnknown",
            error: cause instanceof Error ? cause.message : String(cause),
            updatedAt: this.#now().toISOString(),
          });
          this.catalog.updateCommand(unknown);
        }
        throw new ControlNodeCoreError(
          "OUTCOME_UNKNOWN",
          `command ${id} was dispatched once; its outcome is unknown and it was not retried`,
          { commandId: id },
          { cause },
        );
      } finally {
        this.#dispatches.delete(id);
      }
    })();
    this.#dispatches.set(id, promise);
    return promise;
  }

  async #repairLifecycleBinding(
    record: CommandRecord,
    refreshLifecycle = true,
  ): Promise<void> {
    if (record.state !== "succeeded") return;
    const stopped = stopCommandSchema.safeParse(record.request);
    if (stopped.success) {
      try {
        this.catalog.markSessionStopped(
          stopped.data.sessionId,
          stopped.data.bindingRevision,
        );
      } catch (cause) {
        if (!(cause instanceof ControlNodeCoreError) || cause.code !== "FENCED") throw cause;
      }
      return;
    }
    if (refreshLifecycle && resumeCommandSchema.safeParse(record.request).success) {
      await this.refresh(record.runtimeNodeId).catch(() => undefined);
    }
  }

  async #flushMetadataOutboxOnce(): Promise<number> {
    const pending = this.catalog.pendingMetadataOutbox();
    if (pending.length === 0 || !this.#metadataUpstream) return 0;
    const requested = new Map(pending.map((operation) => [operation.operationId, operation]));
    const responses = await this.#metadataUpstream.pushMetadataOutbox(pending);
    let count = 0;
    const seen = new Set<string>();
    for (const responseInput of responses) {
      const response = metadataOperationRecordSchema.parse(responseInput);
      const original = requested.get(response.operationId);
      if (!original || !sameJson(original.patch, response.patch) || seen.has(response.operationId)) {
        throw new ControlNodeCoreError("FENCED", "metadata authority returned an unrequested or duplicate operation");
      }
      seen.add(response.operationId);
      if (response.status !== "queued") {
        this.catalog.settleMetadataOperation(response);
        count += 1;
      }
    }
    if (count > 0) void this.flushMetadataDeliveries();
    return count;
  }

  async #flushMetadataDeliveriesOnce(): Promise<number> {
    let delivered = 0;
    for (const intent of this.catalog.pendingMetadataDeliveries()) {
      const session = this.catalog.getSession(intent.operation.sessionId);
      if (!session || session.runtimeNodeId !== intent.destinationRuntimeNodeId) continue;
      let acknowledgement: MetadataOperationRecord;
      try {
        const route = this.#route(intent.destinationRuntimeNodeId);
        const fence = this.#captureDispatchFence(intent.destinationRuntimeNodeId);
        const connection = route.immediateChildControlNodeId
          ? this.#child(route)
          : this.#runtime(intent.destinationRuntimeNodeId);
        if (!connection.applyMetadata) continue;
        acknowledgement = metadataOperationRecordSchema.parse(
          await connection.applyMetadata(intent.operation),
        );
        this.#assertDispatchFence(fence);
      } catch {
        continue;
      }
      if (acknowledgement.status === "queued" || !sameJson(acknowledgement, intent.operation)) continue;
      if (this.catalog.acknowledgeMetadataDelivery(
        intent.sequence,
        intent.destinationRuntimeNodeId,
        intent.operation.operationId,
      )) delivered += 1;
    }
    return delivered;
  }

  async #loadChildSnapshot(
    connection: ChildControlNodeConnection,
    attachmentId: import("@arduano/agent-multiplex-protocol").AttachmentId,
    lineageId: import("@arduano/agent-multiplex-protocol").LineageId,
  ): Promise<AccessSnapshot> {
    const pages: ControlNodeSubtreeSnapshotPage[] = [];
    const seenPageTokens = new Set<string>();
    let itemCount = 0;
    let pageToken: string | undefined;
    do {
      const page = await connection.readSubtreeSnapshot({
        attachmentId,
        lineageId,
        ...(pageToken ? { pageToken } : {}),
        limit: 500,
      });
      const parsed = controlNodeSubtreeSnapshotPageSchema.parse(page);
      pages.push(parsed);
      itemCount += snapshotPageItemCount(parsed);
      if (itemCount > this.#maximumSnapshotItems) {
        throw new ControlNodeCoreError("UNAVAILABLE", `child snapshot exceeds ${this.#maximumSnapshotItems} items`);
      }
      pageToken = parsed.nextPageToken ?? undefined;
      if (pageToken !== undefined && seenPageTokens.has(pageToken)) {
        throw new ControlNodeCoreError("CONFLICT", "child snapshot repeated a page token");
      }
      if (pageToken !== undefined) seenPageTokens.add(pageToken);
    } while (pageToken !== undefined);
    const first = pages[0];
    if (!first) throw new ControlNodeCoreError("UNAVAILABLE", "child returned no snapshot pages");
    for (const page of pages) {
      if (JSON.stringify(page.source) !== JSON.stringify(first.source) ||
        JSON.stringify(page.checkpoint) !== JSON.stringify(first.checkpoint) ||
        page.capturedAt !== first.capturedAt || page.attachmentId !== attachmentId || page.lineageId !== lineageId) {
        throw new ControlNodeCoreError("CONFLICT", "child snapshot pages do not share one immutable barrier");
      }
    }
    return {
      source: first.source,
      capturedAt: first.capturedAt,
      controlNodes: pages.flatMap((page) => page.controlNodes),
      runtimeNodes: pages.flatMap((page) => page.runtimeNodes),
      sessions: pages.flatMap((page) => page.sessions),
      interactions: pages.flatMap((page) => page.interactions),
      metadataOperations: pages.flatMap((page) => page.metadataOperations),
    };
  }

  /**
   * Establish one immutable subtree snapshot barrier per child. Concurrent
   * heartbeats share the same work; a detach, reattach, or newer connection
   * generation prevents an older traversal from mutating the projection.
   */
  #synchronizeChildConnection(
    connection: ChildControlNodeConnection,
  ): Promise<void> {
    const identity = this.#assertChildConnectionMatchesActiveAttachment(connection);
    const existing = this.#childSynchronizations.get(connection.controlNodeId);
    if (
      existing &&
      existing.connection === connection &&
      existing.controlNodeBootId === identity.controlNodeBootId &&
      existing.endpointId === identity.endpointId &&
      existing.attachmentId === identity.attachmentId &&
      existing.lineageId === identity.lineageId
    ) return existing.task;

    const generation =
      (this.#childSynchronizationGenerations.get(connection.controlNodeId) ?? 0) + 1;
    this.#childSynchronizationGenerations.set(connection.controlNodeId, generation);
    let resolveTask!: () => void;
    let rejectTask!: (cause: unknown) => void;
    const task = new Promise<void>((resolve, reject) => {
      resolveTask = () => resolve();
      rejectTask = reject;
    });
    const synchronization = Object.freeze({
      generation,
      connection,
      ...identity,
      task,
    });
    // Publish the generation before aborting the old iterator or invoking the
    // reverse port. Abort listeners and RPC implementations are user code and
    // may synchronously reenter this service; they must see this generation so
    // they can only join or supersede it, never install an older record later.
    this.#childSynchronizations.set(connection.controlNodeId, synchronization);
    // A snapshot is a replacement barrier, not an update layered underneath a
    // live feed. Stop the prior iterator before the first snapshot await so it
    // cannot advance the durable checkpoint past the captured barrier and then
    // have that state rolled back by replaceChildSnapshot().
    this.#quiesceChildPump(connection.controlNodeId);

    const operation = (async () => {
      try {
        this.#assertChildSynchronizationCurrent(synchronization);
        const snapshot = await this.#loadChildSnapshot(
          connection,
          identity.attachmentId,
          identity.lineageId,
        );
        this.#assertChildSynchronizationCurrent(synchronization);
        this.catalog.replaceChildSnapshot(
          connection.controlNodeId,
          identity.attachmentId,
          snapshot,
        );
        // replaceChildSnapshot is synchronous. Recheck before publishing the
        // live route so a reentrant catalog callback cannot win this race.
        this.#assertChildSynchronizationCurrent(synchronization);
        const previous = this.#childConnections.get(connection.controlNodeId);
        this.#childConnections.set(connection.controlNodeId, connection);
        this.#pendingChildSynchronizations.delete(connection.controlNodeId);
        // Install internal state before notifying an observer. A callback that
        // closes, detaches, or supersedes this connection then tears down this
        // exact pump instead of letting it leak after the callback returns.
        this.#startChildPump(connection);
        if (previous !== connection) {
          this.#onChildControlNodeConnectionAttached?.(connection);
        }
        this.#assertChildSynchronizationCurrent(synchronization);
        void this.flushMetadataDeliveries();
      } catch (cause) {
        if (
          this.#childSynchronizations.get(connection.controlNodeId) ===
            synchronization
        ) {
          const pump = this.#childPumps.get(connection.controlNodeId);
          if (pump?.connection === connection) {
            pump.controller.abort();
            this.#childPumps.delete(connection.controlNodeId);
          }
          if (this.#childConnections.get(connection.controlNodeId) === connection) {
            this.#childConnections.delete(connection.controlNodeId);
          }
          this.catalog.markChildDisconnected(
            connection.controlNodeId,
            connection.controlNodeBootId,
          );
        }
        throw cause;
      }
    })();
    void operation.then(() => {
      if (this.#childSynchronizations.get(connection.controlNodeId) === synchronization) {
        this.#childSynchronizations.delete(connection.controlNodeId);
      }
      resolveTask();
    }, (cause: unknown) => {
      if (this.#childSynchronizations.get(connection.controlNodeId) === synchronization) {
        this.#childSynchronizations.delete(connection.controlNodeId);
      }
      rejectTask(cause);
    });
    return task;
  }

  #assertChildConnectionMatchesActiveAttachment(
    connection: ChildControlNodeConnection,
  ): Omit<ChildSynchronization, "generation" | "connection" | "task"> {
    const attachment = this.catalog.getAttachment(connection.controlNodeId);
    const child = this.catalog.getControlNode(connection.controlNodeId);
    if (
      !attachment ||
      !child ||
      child.controlNodeBootId !== connection.controlNodeBootId ||
      (child.endpointId !== undefined && child.endpointId !== connection.endpointId)
    ) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child reverse connection does not match its active attachment",
      );
    }
    return {
      controlNodeBootId: child.controlNodeBootId,
      endpointId: child.endpointId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
    };
  }

  #assertChildSynchronizationCurrent(
    synchronization: ChildSynchronization,
  ): void {
    if (
      this.#closed ||
      this.#childSynchronizations.get(synchronization.connection.controlNodeId) !==
        synchronization ||
      this.#childSynchronizationGenerations.get(
        synchronization.connection.controlNodeId,
      ) !== synchronization.generation
    ) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child synchronization was superseded",
      );
    }
    const current = this.#assertChildConnectionMatchesActiveAttachment(
      synchronization.connection,
    );
    if (
      current.controlNodeBootId !== synchronization.controlNodeBootId ||
      current.endpointId !== synchronization.endpointId ||
      current.attachmentId !== synchronization.attachmentId ||
      current.lineageId !== synchronization.lineageId
    ) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child attachment changed during synchronization",
      );
    }
  }

  #synchronizationMatchesHeartbeat(
    synchronization: ChildSynchronization,
    heartbeat: ControlNodeLinkFence,
    context: ChildControlNodeIngressContext,
  ): boolean {
    return (
      synchronization.controlNodeBootId === heartbeat.controlNodeBootId &&
      synchronization.endpointId === context.endpointId &&
      synchronization.attachmentId === heartbeat.attachmentId &&
      synchronization.lineageId === heartbeat.lineageId
    );
  }

  #invalidateChildSynchronization(controlNodeId: ControlNodeId): void {
    this.#childSynchronizations.delete(controlNodeId);
    this.#childSynchronizationGenerations.set(
      controlNodeId,
      (this.#childSynchronizationGenerations.get(controlNodeId) ?? 0) + 1,
    );
  }

  #quiesceChildPump(controlNodeId: ControlNodeId): void {
    const pump = this.#childPumps.get(controlNodeId);
    if (!pump) return;
    pump.controller.abort();
    if (this.#childPumps.get(controlNodeId) === pump) {
      this.#childPumps.delete(controlNodeId);
    }
  }

  #startChildPump(connection: ChildControlNodeConnection): void {
    this.#quiesceChildPump(connection.controlNodeId);
    const controller = new AbortController();
    const pump: ChildPump = {
      connection,
      controller,
      task: Promise.resolve(),
      settled: false,
    };
    pump.task = (async () => {
      try {
        const attachment = this.catalog.getAttachment(connection.controlNodeId);
        if (!attachment) return;
        const checkpoint = this.catalog.childCheckpoint(connection.controlNodeId);
        if (!checkpoint) return;
        for await (const item of connection.subscribeAggregate({ ...checkpoint, native: {} }, controller.signal)) {
          if (controller.signal.aborted) return;
          if (item.kind === "control") {
            this.catalog.importChildControl(connection.controlNodeId, attachment.attachmentId, item);
            if (requiresChildResnapshot(item)) {
              if (
                this.#childPumps.get(connection.controlNodeId) !== pump ||
                this.#childConnections.get(connection.controlNodeId) !== connection ||
                (this.#childSynchronizations.has(connection.controlNodeId) &&
                  this.#childSynchronizations.get(connection.controlNodeId)?.connection !==
                    connection)
              ) return;
              await this.#synchronizeChildConnection(connection);
              return;
            }
          }
          else if (item.kind === "native" || item.kind === "nativeGap") {
            const session = this.catalog.getSession(item.sessionId);
            const route = session
              ? this.catalog.routeForRuntimeNode(session.runtimeNodeId)
              : null;
            if (
              !session ||
              route?.immediateChildControlNodeId !== connection.controlNodeId ||
              !sameJson(item.provenance.authority, this.catalog.authority()) ||
              !this.catalog.isControlNodeProjectedThrough(
                connection.controlNodeId,
                item.provenance.originControlNodeId,
              ) ||
              (item.kind === "native" && (
                item.harness !== session.harness ||
                item.runtimeEpoch !== session.runtimeEpoch
              ))
            ) {
              throw new ControlNodeCoreError(
                "FENCED",
                "child native event is outside its current subtree or runtime epoch",
              );
            }
            this.events.publish(item);
          }
          else if (item.kind === "streamReset") {
            if (
              this.#childPumps.get(connection.controlNodeId) !== pump ||
              this.#childConnections.get(connection.controlNodeId) !== connection ||
              (this.#childSynchronizations.has(connection.controlNodeId) &&
                this.#childSynchronizations.get(connection.controlNodeId)?.connection !==
                  connection)
            ) return;
            await this.#synchronizeChildConnection(connection);
            return;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.#onChildControlNodePumpError?.(connection.controlNodeId, error);
        }
      }
    })().finally(() => {
      pump.settled = true;
      if (this.#childPumps.get(connection.controlNodeId) !== pump) return;
      this.#childPumps.delete(connection.controlNodeId);
      if (
        !controller.signal.aborted &&
        !this.#closed &&
        this.#childConnections.get(connection.controlNodeId) === connection
      ) {
        // A subscription can finish even though its reverse RPC peer remains
        // usable. Keep the connection, fence its cached subtree, and let the
        // next authenticated heartbeat establish a fresh snapshot barrier.
        this.catalog.markChildDisconnected(connection.controlNodeId, connection.controlNodeBootId);
      }
    });
    this.#childPumps.set(connection.controlNodeId, pump);
  }

  #rememberChildConnection(connection: ChildControlNodeConnection): void {
    const previous = this.#childConnections.get(connection.controlNodeId);
    this.#childConnections.set(connection.controlNodeId, connection);
    if (previous !== connection) this.#onChildControlNodeConnectionAttached?.(connection);
  }

  async #dispatchTerminalMutation<T>(
    input: TerminalTarget,
    operation: (
      connection: TerminalConnection,
    ) => Promise<T>,
  ): Promise<T> {
    this.#assertTerminalTarget(input);
    const fence = this.#captureDispatchFence(input.runtimeNodeId);
    const route = this.#route(input.runtimeNodeId);
    const connection = this.#terminal(route.immediateChildControlNodeId
      ? this.#child(route)
      : this.#runtime(input.runtimeNodeId));
    const result = await operation(connection);
    this.#assertDispatchFence(fence);
    this.#assertTerminalTarget(input);
    return result;
  }

  async *#guardTerminalStream(
    input: TerminalAttachInput,
    fence: DispatchRouteFence,
    attach: (signal: AbortSignal) => AsyncIterable<TerminalStreamItem>,
    signal?: AbortSignal,
  ): AsyncGenerator<TerminalStreamItem> {
    if (signal?.aborted) return;
    const controller = new AbortController();
    let routeInvalid = false;
    const abort = (): void => controller.abort();
    const checkRoute = (): void => {
      try {
        this.#assertDispatchFence(fence);
        this.#assertTerminalTarget(input);
      } catch {
        routeInvalid = true;
        controller.abort();
      }
    };
    const unsubscribe = this.catalog.onControl(checkRoute);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const value of attach(controller.signal)) {
        if (controller.signal.aborted) break;
        checkRoute();
        if (routeInvalid) break;
        const item = terminalStreamItemSchema.parse(value);
        if (item.cursor.terminalId !== input.terminalId) {
          throw new ControlNodeCoreError(
            "PAYLOAD_MISMATCH",
            "terminal stream returned another terminal identity",
          );
        }
        if (item.kind === "reset" || item.kind === "changed") {
          this.#assertTerminalDescriptor(input, item.terminal);
        }
        yield item;
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  #assertTerminalTarget(input: TerminalTarget, requireActive = false): SessionRecord {
    const session = this.catalog.getSession(input.sessionId);
    if (!session) {
      throw new ControlNodeCoreError("NOT_FOUND", "terminal session is unknown");
    }
    if (
      session.runtimeNodeId !== input.runtimeNodeId ||
      session.bindingRevision !== input.bindingRevision
    ) {
      throw new ControlNodeCoreError("FENCED", "terminal request carries a stale session binding");
    }
    if (requireActive && session.availability !== "active") {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "terminal opening requires an active structured session; resume it first",
      );
    }
    return session;
  }

  #assertOpenBinding(
    sessionId: SessionId,
    runtimeNodeId: RuntimeNodeId,
    bindingRevision: number,
  ): SessionRecord {
    const session = this.catalog.getSession(sessionId);
    if (
      !session ||
      session.catalogState !== "open" ||
      session.runtimeNodeId !== runtimeNodeId ||
      session.bindingRevision !== bindingRevision
    ) {
      throw new ControlNodeCoreError("FENCED", "operation carries a stale or archived session binding");
    }
    return session;
  }

  #assertTerminalDescriptor(
    target: TerminalTarget,
    descriptor: TerminalDescriptor,
  ): void {
    if (
      descriptor.sessionId !== target.sessionId ||
      descriptor.runtimeNodeId !== target.runtimeNodeId ||
      descriptor.bindingRevision !== target.bindingRevision
    ) {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        "runtime returned a terminal descriptor for another session binding",
      );
    }
    const runtime = this.catalog.getRuntimeNode(target.runtimeNodeId);
    if (!runtime || runtime.runtimeNodeBootId !== descriptor.runtimeNodeBootId) {
      throw new ControlNodeCoreError(
        "FENCED",
        "runtime returned a terminal descriptor from a stale runtime boot",
      );
    }
  }

  #terminal(
    connection: RuntimeNodeConnection | ChildControlNodeConnection,
  ): TerminalConnection {
    const methods: readonly (keyof TerminalConnection)[] = [
      "getTerminal",
      "openTerminal",
      "attachTerminal",
      "acquireTerminalLease",
      "renewTerminalLease",
      "releaseTerminalLease",
      "sendTerminalInput",
      "terminateTerminal",
    ];
    if (methods.some((method) => typeof connection[method] !== "function")) {
      throw new ControlNodeCoreError(
        "UNSUPPORTED",
        "selected runtime route does not support terminal.side-channel.v1",
      );
    }
    return connection as TerminalConnection;
  }

  /**
   * Reconcile a locally durable, nonterminal launch with its owning worker.
   * Worker launch journals are durable while control-event delivery is not,
   * so a read repairs a terminal event missed during an outage or restart.
   */
  async #refreshLaunch(current: LaunchRecord): Promise<LaunchRecord> {
    let recoveredInput: LaunchRecord | null;
    let route: RuntimeNodeRoute;
    try {
      route = this.#route(current.runtimeNodeId);
      const fence = this.#captureDispatchFence(current.runtimeNodeId);
      const owner = route.immediateChildControlNodeId
        ? this.#child(route)
        : this.#runtime(current.runtimeNodeId);
      recoveredInput = await owner.getLaunch(current.launchId);
      if (recoveredInput === null && current.state === "accepted") {
        // A crash can occur after local durable admission but before the first
        // downstream dispatch. Reissuing an accepted request is safe because
        // every runtime/child journals launchId before doing provider work and
        // rejects reuse with a different immutable payload.
        recoveredInput = await owner.createLaunch(launchRequestFromRecord(current));
      }
      this.#assertDispatchFence(fence);
    } catch {
      // Reads are safe to retry. Preserve the durable local progress marker
      // while the owning route is temporarily unavailable.
      return current;
    }
    if (recoveredInput === null) return current;
    const recovered = launchRecordSchema.parse(recoveredInput);
    assertLaunchRequest(recovered, launchRequestFromRecord(current));
    return this.catalog.recordLaunch(
      recovered,
      route.immediateChildControlNodeId ?? null,
    );
  }

  /** Archive cleanup uses the same durable-worker/transient-event split. */
  async #refreshArchive(current: ArchiveRecord): Promise<ArchiveRecord> {
    let recoveredInput: ArchiveRecord | null;
    let route: RuntimeNodeRoute;
    try {
      route = this.#route(current.runtimeNodeId);
      const fence = this.#captureDispatchFence(current.runtimeNodeId);
      recoveredInput = route.immediateChildControlNodeId
        ? await this.#child(route).getArchive(current.archiveOperationId)
        : await this.#runtime(current.runtimeNodeId).getArchive(current.archiveOperationId);
      this.#assertDispatchFence(fence);
    } catch {
      return current;
    }
    if (recoveredInput === null) return current;
    const recovered = archiveRecordSchema.parse(recoveredInput);
    assertArchiveRequest(recovered, archiveRequestFromRecord(current));
    return this.catalog.recordArchive(
      recovered,
      route.immediateChildControlNodeId ?? null,
    );
  }

  #route(id: RuntimeNodeId): RuntimeNodeRoute {
    const route = this.catalog.routeForRuntimeNode(id);
    if (!route) throw new ControlNodeCoreError("UNAVAILABLE", `runtime node ${id} has no reachable route`);
    return route;
  }

  #captureDispatchFence(runtimeNodeId: RuntimeNodeId): DispatchRouteFence {
    const route = this.#route(runtimeNodeId);
    const runtime = this.catalog.getRuntimeNode(runtimeNodeId);
    if (!runtime) {
      throw new ControlNodeCoreError("UNAVAILABLE", `runtime node ${runtimeNodeId} disappeared`);
    }
    if (route.immediateChildControlNodeId === undefined) {
      // This also validates that the retained reverse connection belongs to
      // the descriptor's current boot.
      this.#runtime(runtimeNodeId);
      return {
        runtimeNodeId,
        runtimeNodeBootId: runtime.runtimeNodeBootId,
      };
    }
    const child = this.catalog.getControlNode(route.immediateChildControlNodeId);
    if (!child || route.attachmentId === undefined || route.lineageId === undefined) {
      throw new ControlNodeCoreError("FENCED", "child dispatch route is incomplete");
    }
    this.#child(route);
    return {
      runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      childControlNodeId: route.immediateChildControlNodeId,
      childControlNodeBootId: child.controlNodeBootId,
      attachmentId: route.attachmentId,
      lineageId: route.lineageId,
    };
  }

  #assertDispatchFence(fence: DispatchRouteFence): void {
    const runtime = this.catalog.getRuntimeNode(fence.runtimeNodeId);
    if (!runtime || runtime.runtimeNodeBootId !== fence.runtimeNodeBootId) {
      throw new ControlNodeCoreError("FENCED", "runtime-node boot changed while command was in flight");
    }
    if (fence.childControlNodeId === undefined) {
      const route = this.catalog.routeForRuntimeNode(fence.runtimeNodeId);
      if (!route || route.immediateChildControlNodeId !== undefined) {
        throw new ControlNodeCoreError("FENCED", "command route changed while it was in flight");
      }
      this.#runtime(fence.runtimeNodeId);
      return;
    }
    const route = this.catalog.routeForRuntimeNode(fence.runtimeNodeId);
    const child = this.catalog.getControlNode(fence.childControlNodeId);
    if (
      !route ||
      route.immediateChildControlNodeId !== fence.childControlNodeId ||
      route.attachmentId !== fence.attachmentId ||
      route.lineageId !== fence.lineageId ||
      !child ||
      child.controlNodeBootId !== fence.childControlNodeBootId
    ) {
      throw new ControlNodeCoreError("FENCED", "child route changed while command was in flight");
    }
    this.#child(route);
  }

  #runtime(id: RuntimeNodeId): RuntimeNodeConnection {
    const connection = this.#runtimeConnections.get(id);
    if (!connection) throw new ControlNodeCoreError("UNAVAILABLE", `runtime node ${id} is disconnected`);
    const descriptor = this.catalog.getRuntimeNode(id);
    if (
      !descriptor ||
      descriptor.runtimeNodeBootId !== connection.runtimeNodeBootId ||
      (descriptor.endpointId !== undefined && descriptor.endpointId !== connection.endpointId)
    ) {
      throw new ControlNodeCoreError("FENCED", `runtime node ${id} connection belongs to a stale boot`);
    }
    return connection;
  }

  #child(route: RuntimeNodeRoute): ChildControlNodeConnection {
    const id = route.immediateChildControlNodeId;
    const connection = id ? this.#childConnections.get(id) : undefined;
    if (!connection) throw new ControlNodeCoreError("UNAVAILABLE", "child control-node route is disconnected");
    const child = this.catalog.getControlNode(id!);
    const attachment = this.catalog.getAttachment(id!);
    if (
      !child ||
      !attachment ||
      child.controlNodeBootId !== connection.controlNodeBootId ||
      (child.endpointId !== undefined && child.endpointId !== connection.endpointId) ||
      attachment.attachmentId !== route.attachmentId ||
      attachment.lineageId !== route.lineageId
    ) {
      throw new ControlNodeCoreError("FENCED", "child control-node route carries a stale connection fence");
    }
    return connection;
  }

  #recursiveChildren(
    runtimeNodeIds?: readonly RuntimeNodeId[],
  ): ChildControlNodeConnection[] {
    const localControlNodeId = this.catalog.localControlNode().controlNodeId;
    const childIds = runtimeNodeIds === undefined
      ? this.catalog.listControlNodes().flatMap((node) =>
          node.dataRole.role === "branch" &&
          node.dataRole.branch.lifecycle === "attached" &&
          node.dataRole.branch.parentControlNodeId === localControlNodeId
            ? [node.controlNodeId]
            : [])
      : [...new Set(runtimeNodeIds.flatMap((runtimeNodeId) => {
          const childId = this.catalog.routeForRuntimeNode(runtimeNodeId)
            ?.immediateChildControlNodeId;
          return childId === undefined ? [] : [childId];
        }))];
    return childIds.map((controlNodeId) => {
      const connection = this.#childConnections.get(controlNodeId);
      if (!connection) {
        throw new ControlNodeCoreError(
          "UNAVAILABLE",
          `child control-node ${controlNodeId} is disconnected during cold search`,
        );
      }
      this.#assertChildConnectionMatchesActiveAttachment(connection);
      return connection;
    });
  }

  #assertRecursiveChildCurrent(connection: ChildControlNodeConnection): void {
    if (this.#childConnections.get(connection.controlNodeId) !== connection) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child control-node connection changed during recursive lookup",
      );
    }
    this.#assertChildConnectionMatchesActiveAttachment(connection);
  }

  #assertRecursiveRuntimeOwner(
    connection: ChildControlNodeConnection,
    runtimeNodeId: RuntimeNodeId,
  ): void {
    const route = this.catalog.routeForRuntimeNode(runtimeNodeId);
    if (route?.immediateChildControlNodeId !== connection.controlNodeId) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child recursive result targets a runtime outside its subtree",
      );
    }
  }

  #assertRecursiveSessionOwner(
    connection: ChildControlNodeConnection,
    session: SessionRecord,
  ): void {
    this.#assertRecursiveRuntimeOwner(connection, session.runtimeNodeId);
    if (!sameAuthority(session.metadataAuthority, this.catalog.authority())) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child recursive result carries a stale metadata authority",
      );
    }
  }

  #assertRuntimeEnrollmentIdentity(
    id: RuntimeNodeId,
    context: RuntimeNodeIngressContext,
  ): string {
    if (!context.endpointId) {
      throw new ControlNodeCoreError(
        "UNAUTHORIZED",
        "runtime-node registration requires an authenticated endpoint",
      );
    }
    if (
      context.authenticatedRuntimeNodeId !== undefined &&
      context.authenticatedRuntimeNodeId !== id
    ) {
      throw new ControlNodeCoreError("UNAUTHORIZED", "authenticated runtime-node identity mismatch");
    }
    return context.endpointId;
  }

  #assertRuntimeIdentity(id: RuntimeNodeId, context: RuntimeNodeIngressContext): void {
    if (context.authenticatedRuntimeNodeId !== id || !context.endpointId) {
      throw new ControlNodeCoreError(
        "UNAUTHORIZED",
        "runtime-node endpoint is not enrolled for this identity",
      );
    }
    const runtime = this.catalog.getRuntimeNode(id);
    const enrollment = this.catalog.activePeerEnrollment(context.endpointId);
    if (
      !runtime ||
      runtime.endpointId !== context.endpointId ||
      enrollment?.role !== "runtime-node" ||
      enrollment.principalId !== id
    ) {
      throw new ControlNodeCoreError(
        "UNAUTHORIZED",
        "runtime-node endpoint does not match its durable enrollment",
      );
    }
  }

  #assertRuntimeFence(
    fence: RuntimeNodeFence,
    context: RuntimeNodeIngressContext,
  ): void {
    this.#assertRuntimeIdentity(fence.runtimeNodeId, context);
    const runtime = this.catalog.getRuntimeNode(fence.runtimeNodeId);
    if (
      !runtime ||
      runtime.ownerControlNodeId !== this.catalog.localControlNode().controlNodeId ||
      runtime.runtimeNodeBootId !== fence.runtimeNodeBootId
    ) {
      throw new ControlNodeCoreError("FENCED", "runtime-node boot fence is stale");
    }
  }

  #assertRuntimeEventOwner(expected: RuntimeNodeId, actual: RuntimeNodeId): void {
    if (expected !== actual) {
      throw new ControlNodeCoreError(
        "FENCED",
        "runtime-node event targets a session owned by another runtime node",
      );
    }
  }

  #assertChildEnrollmentIdentity(
    id: ControlNodeId,
    context: ChildControlNodeIngressContext,
  ): string {
    if (!context.endpointId) {
      throw new ControlNodeCoreError(
        "UNAUTHORIZED",
        "child attachment requires an authenticated endpoint",
      );
    }
    if (
      context.authenticatedControlNodeId !== undefined &&
      context.authenticatedControlNodeId !== id
    ) {
      throw new ControlNodeCoreError("UNAUTHORIZED", "authenticated child control-node identity mismatch");
    }
    return context.endpointId;
  }

  #assertChildIdentity(id: ControlNodeId, context: ChildControlNodeIngressContext): void {
    if (context.authenticatedControlNodeId !== id || !context.endpointId) {
      throw new ControlNodeCoreError(
        "UNAUTHORIZED",
        "child control-node endpoint is not enrolled for this identity",
      );
    }
    const child = this.catalog.getControlNode(id);
    const enrollment = this.catalog.activePeerEnrollment(context.endpointId);
    if (
      !child ||
      child.endpointId !== context.endpointId ||
      enrollment?.role !== "child-control-node" ||
      enrollment.principalId !== id
    ) {
      throw new ControlNodeCoreError(
        "UNAUTHORIZED",
        "child control-node endpoint does not match its durable enrollment",
      );
    }
  }

  #assertChildFence(fence: ControlNodeLinkFence, context: ChildControlNodeIngressContext): void {
    this.#assertChildIdentity(fence.controlNodeId, context);
    const attachment = this.catalog.getAttachment(fence.controlNodeId);
    const child = this.catalog.getControlNode(fence.controlNodeId);
    if (!attachment || !child || child.controlNodeBootId !== fence.controlNodeBootId ||
      attachment.attachmentId !== fence.attachmentId || attachment.lineageId !== fence.lineageId) {
      throw new ControlNodeCoreError("FENCED", "child control-node fence is stale");
    }
  }

  #assertParentFence(fence: ControlNodeLinkFence, context: ControlNodePeerContext): void {
    const local = this.catalog.localControlNode();
    const role = this.catalog.dataRole();
    if (fence.controlNodeId !== local.controlNodeId || fence.controlNodeBootId !== local.controlNodeBootId ||
      role.role !== "branch" || role.branch.lifecycle !== "attached" ||
      role.branch.attachmentId !== fence.attachmentId || role.branch.lineageId !== fence.lineageId) {
      throw new ControlNodeCoreError("FENCED", "parent link targets a stale local attachment");
    }
    if (
      !context.endpointId ||
      context.authenticatedControlNodeId !== role.branch.parentControlNodeId
    ) {
      throw new ControlNodeCoreError("UNAUTHORIZED", "link caller is not the attached parent");
    }
    const enrollment = this.catalog.activePeerEnrollment(context.endpointId);
    if (
      enrollment?.role !== "parent-control-node" ||
      enrollment.principalId !== role.branch.parentControlNodeId
    ) {
      throw new ControlNodeCoreError(
        "UNAUTHORIZED",
        "parent endpoint does not match its durable enrollment",
      );
    }
  }

  #pruneTraversals(): void {
    const now = this.#now().getTime();
    for (const [token, traversal] of this.#snapshotTraversals) {
      if (traversal.expiresAt <= now) this.#snapshotTraversals.delete(token);
    }
  }
}

type SnapshotItem =
  | { kind: "controlNode"; value: AccessSnapshot["controlNodes"][number] }
  | { kind: "runtimeNode"; value: AccessSnapshot["runtimeNodes"][number] }
  | { kind: "session"; value: AccessSnapshot["sessions"][number] }
  | { kind: "interaction"; value: AccessSnapshot["interactions"][number] }
  | { kind: "metadataOperation"; value: AccessSnapshot["metadataOperations"][number] };

function flattenSnapshot(snapshot: AccessSnapshot): SnapshotItem[] {
  return [
    ...snapshot.controlNodes.map((value) => ({ kind: "controlNode" as const, value })),
    ...snapshot.runtimeNodes.map((value) => ({ kind: "runtimeNode" as const, value })),
    ...snapshot.sessions.map((value) => ({ kind: "session" as const, value })),
    ...snapshot.interactions.map((value) => ({ kind: "interaction" as const, value })),
    ...snapshot.metadataOperations.map((value) => ({ kind: "metadataOperation" as const, value })),
  ];
}

function splitSnapshotItems(items: readonly SnapshotItem[]) {
  return {
    controlNodes: items.flatMap((item) => item.kind === "controlNode" ? [item.value] : []),
    runtimeNodes: items.flatMap((item) => item.kind === "runtimeNode" ? [item.value] : []),
    sessions: items.flatMap((item) => item.kind === "session" ? [item.value] : []),
    interactions: items.flatMap((item) => item.kind === "interaction" ? [item.value] : []),
    metadataOperations: items.flatMap((item) => item.kind === "metadataOperation" ? [item.value] : []),
  };
}

function snapshotPageItemCount(page: ControlNodeSubtreeSnapshotPage): number {
  return page.controlNodes.length + page.runtimeNodes.length + page.sessions.length +
    page.interactions.length + page.metadataOperations.length;
}

function accessSnapshotItemCount(snapshot: AccessSnapshot): number {
  return snapshot.controlNodes.length + snapshot.runtimeNodes.length + snapshot.sessions.length +
    snapshot.interactions.length + snapshot.metadataOperations.length;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalProtocolRecordJson(left) === canonicalProtocolRecordJson(right);
}

function assertCommandRequest(
  record: CommandRecord,
  input: ResumeCommand | StopCommand | CommandEnvelope,
): void {
  if (
    record.commandId !== input.commandId ||
    record.payloadHash !== input.payloadHash ||
    record.sessionId !== input.sessionId ||
    record.runtimeNodeId !== input.runtimeNodeId ||
    !sameJson(record.request, input)
  ) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      `command ${input.commandId} was already used with another payload`,
    );
  }
}

function assertCommandResponse(
  record: CommandRecord,
  input: ResumeCommand | StopCommand | CommandEnvelope,
): void {
  assertCommandRequest(record, input);
  if (record.state === "received" || record.state === "started") {
    throw new ControlNodeCoreError(
      "OUTCOME_UNKNOWN",
      `command ${input.commandId} returned without a terminal outcome`,
    );
  }
}

function assertRecoveredCommandResponse(
  accepted: CommandRecord,
  recovered: CommandRecord,
): void {
  if (
    accepted.commandId !== recovered.commandId ||
    accepted.payloadHash !== recovered.payloadHash ||
    accepted.sessionId !== recovered.sessionId ||
    accepted.runtimeNodeId !== recovered.runtimeNodeId ||
    !sameJson(accepted.request, recovered.request)
  ) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      `recovered command ${accepted.commandId} does not match the accepted request`,
    );
  }
  if (recovered.state === "received" || recovered.state === "started") {
    throw new ControlNodeCoreError(
      "OUTCOME_UNKNOWN",
      `recovered command ${accepted.commandId} is still nonterminal`,
    );
  }
}

function launchRequestFromRecord(record: LaunchRecord): LaunchRequest {
  const { implementationVersion: _implementationVersion, state: _state,
    result: _result, statusMessage: _statusMessage, error: _error,
    createdAt: _createdAt, updatedAt: _updatedAt, ...identity } = record;
  return identity;
}

function assertLaunchRequest(record: LaunchRecord, request: LaunchRequest): void {
  const identity = launchRequestFromRecord(record);
  if (!sameJson(identity, request)) {
    throw new ControlNodeCoreError("PAYLOAD_MISMATCH", `launch ${request.launchId} was reused with another request`);
  }
}

function assertSameLaunchRequest(current: LaunchRequest, proposed: LaunchRequest): void {
  if (!sameJson(current, proposed)) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      `launch ${proposed.launchId} was reused with another request`,
    );
  }
}

function archiveRequestFromRecord(record: ArchiveRecord): ArchiveRequest {
  const { authority: _authority, state: _state, releasedAt: _releasedAt,
    catalogRevision: _catalogRevision, error: _error, createdAt: _createdAt,
    updatedAt: _updatedAt, ...identity } = record;
  return identity;
}

function assertArchiveRequest(record: ArchiveRecord, request: ArchiveRequest): void {
  const identity = archiveRequestFromRecord(record);
  if (!sameJson(identity, request)) {
    throw new ControlNodeCoreError("PAYLOAD_MISMATCH", `archive operation ${request.archiveOperationId} was reused with another request`);
  }
}

function assertSameArchiveRequest(current: ArchiveRequest, proposed: ArchiveRequest): void {
  if (!sameJson(current, proposed)) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      `archive operation ${proposed.archiveOperationId} was reused with another request`,
    );
  }
}

function isTerminalLaunch(record: LaunchRecord): boolean {
  return record.state === "succeeded" ||
    record.state === "failed" ||
    record.state === "outcomeUnknown";
}

function isTerminalArchive(record: ArchiveRecord): boolean {
  return record.state === "succeeded" ||
    record.state === "failed" ||
    record.state === "outcomeUnknown";
}

function sameAuthority(
  left: import("@arduano/agent-multiplex-protocol").AuthorityRef,
  right: import("@arduano/agent-multiplex-protocol").AuthorityRef,
): boolean {
  return left.realmId === right.realmId &&
    left.controlNodeId === right.controlNodeId &&
    left.epochId === right.epochId;
}

function assertInteractionResponse(
  pending: InteractionRecord,
  resolved: InteractionRecord,
  response: ResolveInteractionInput["response"],
): void {
  const requestIdentity = (interaction: InteractionRecord) => ({
    interactionId: interaction.interactionId,
    sessionId: interaction.sessionId,
    harness: interaction.harness,
    runtimeEpoch: interaction.runtimeEpoch,
    ...(interaction.nativeRequestId === undefined
      ? {}
      : { nativeRequestId: interaction.nativeRequestId }),
    requestType: interaction.requestType,
    payload: interaction.payload,
    ephemeral: interaction.ephemeral,
    createdAt: interaction.createdAt,
    expiresAt: interaction.expiresAt,
  });
  if (!sameJson(requestIdentity(pending), requestIdentity(resolved))) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      "runtime returned a response for another interaction request",
    );
  }
  if (
    resolved.state !== "resolved" ||
    resolved.resolution === undefined ||
    resolved.resolvedAt === null ||
    !sameJson(resolved.resolution, response)
  ) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      "runtime interaction response does not match the submitted resolution",
    );
  }
}

function requiresChildResnapshot(item: FeedControlItem): boolean {
  return item.change.type === "controlNode.attached" ||
    item.change.type === "controlNode.detached" ||
    item.change.type === "authority.promoted";
}
