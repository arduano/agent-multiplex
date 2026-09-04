import { randomUUID } from "node:crypto";

import {
  APPLICATION_ID,
  PROTOCOL_VERSION,
  authorityForceAdoptInputSchema,
  authorityHandoffAcceptInputSchema,
  authorityHandoffConsumeInputSchema,
  authorityHandoffOfferInputSchema,
  canonicalJson,
  commandRecordSchema,
  hostSubtreeSnapshotPageSchema,
  hostAttachmentRequestSchema,
  jsonValueSchema,
  metadataOperationRecordSchema,
  metadataValuesSchema,
  workerEventItemSchema,
  type CommandEnvelope,
  type CommandId,
  type CommandRecord,
  type AuthorityAdoptionReceipt,
  type AuthorityForceAdoptInput,
  type AuthorityHandoffAcceptance,
  type AuthorityHandoffAcceptInput,
  type AuthorityHandoffConsumeInput,
  type AuthorityHandoffOffer,
  type AuthorityHandoffOfferInput,
  type FeedCheckpoint,
  type FeedControlItem,
  type FleetStreamItem,
  type Harness,
  type HarnessCatalogEntry,
  type HostAttachment,
  type HostAttachmentRequest,
  type HostDescriptor,
  type HostId,
  type HostLinkFence,
  type HostSubtreeSnapshotPage,
  type HostSubtreeSnapshotRequest,
  type InteractionRecord,
  type InventorySnapshot,
  type JsonValue,
  type MetadataPatch,
  type MetadataOperationRecord,
  type NativeHistoryResult,
  type NativeModel,
  type ObserverEnrollment,
  type ResolveInteractionInput,
  type ResumeCommand,
  type SessionId,
  type SessionRecord,
  type SpawnCommand,
  type StreamCursor,
  type WorkerEventItem,
  type WorkerDescriptor,
  type WorkerId,
  type WorkerRegistration,
} from "@agent-multiplex/protocol";

import {
  HostCatalog,
  nativeInventoryKey,
  type AggregateRoute,
  type ReconcileOptions,
  type SessionFilter,
} from "./catalog.js";
import type { AuthorityAcceptanceSigner } from "./authority-proof.js";
import { HostCoreError } from "./errors.js";
import { FleetEventHub } from "./event-hub.js";
import type {
  ChildHostConnection,
  ChildHostIngressContext,
  HostIngressContext,
  HostPeerContext,
  MetadataUpstreamConnection,
  NativeHistoryRequest,
  WorkerConnection,
} from "./types.js";

export interface HostServiceOptions {
  catalog: HostCatalog;
  events?: FleetEventHub;
  instanceId: string;
  now?: () => Date;
  /**
   * Called after a reverse worker connection has been fenced, persisted, and
   * attached. Transport integrations can safely start event ingestion here:
   * events cannot race ahead of the worker registration at this point.
   */
  onWorkerConnectionAttached?: (connection: WorkerConnection) => void;
  onChildHostConnectionAttached?: (connection: ChildHostConnection) => void;
  metadataUpstream?: MetadataUpstreamConnection;
  /** Optional transport locator renewed to connected workers on heartbeat. */
  p2pTicket?: () => string | undefined;
  snapshotTraversalTtlMs?: number;
  /** Persistent signer for destination-authenticated authority acceptance. */
  authorityAcceptanceSigner?: AuthorityAcceptanceSigner;
}

type DispatchInput = SpawnCommand | ResumeCommand | CommandEnvelope;

const terminalStates = new Set(["succeeded", "failed", "outcomeUnknown"]);

interface ChildPump {
  connection: ChildHostConnection;
  attachmentId: HostAttachment["attachmentId"];
  abort: AbortController;
  done: Promise<void>;
}

interface ChildPumpReplacement {
  connection: ChildHostConnection;
  attachmentId: HostAttachment["attachmentId"];
  done: Promise<void>;
}

type SnapshotEntity =
  | { kind: "host"; value: HostDescriptor }
  | { kind: "worker"; value: WorkerDescriptor }
  | { kind: "session"; value: SessionRecord }
  | { kind: "interaction"; value: InteractionRecord }
  | { kind: "metadataOperation"; value: MetadataOperationRecord };

interface SnapshotTraversal {
  attachmentId: HostAttachment["attachmentId"];
  lineageId: HostAttachment["lineageId"];
  checkpoint: FeedCheckpoint;
  capturedAt: string;
  entities: SnapshotEntity[];
  offset: number;
  expiresAt: number;
}

export class HostService {
  readonly catalog: HostCatalog;
  readonly events: FleetEventHub;
  readonly #ownsEvents: boolean;
  readonly #instanceId: string;
  readonly #now: () => Date;
  readonly #onWorkerConnectionAttached:
    | ((connection: WorkerConnection) => void)
    | undefined;
  readonly #onChildHostConnectionAttached:
    | ((connection: ChildHostConnection) => void)
    | undefined;
  readonly #metadataUpstream: MetadataUpstreamConnection | undefined;
  readonly #p2pTicket: (() => string | undefined) | undefined;
  readonly #snapshotTraversalTtlMs: number;
  readonly #authorityAcceptanceSigner: AuthorityAcceptanceSigner | undefined;
  readonly #connections = new Map<WorkerId, WorkerConnection>();
  readonly #childConnections = new Map<HostId, ChildHostConnection>();
  readonly #childPumps = new Map<HostId, ChildPump>();
  readonly #childPumpReplacements = new Map<HostId, ChildPumpReplacement>();
  readonly #childImportTails = new Map<HostId, Promise<void>>();
  readonly #snapshotTraversals = new Map<string, SnapshotTraversal>();
  readonly #dispatches = new Map<string, Promise<CommandRecord>>();
  #closed = false;

  public constructor(options: HostServiceOptions) {
    this.catalog = options.catalog;
    this.events = options.events ?? new FleetEventHub({ catalog: options.catalog });
    this.#ownsEvents = options.events === undefined;
    this.#instanceId = options.instanceId;
    this.#now = options.now ?? (() => new Date());
    this.#onWorkerConnectionAttached = options.onWorkerConnectionAttached;
    this.#onChildHostConnectionAttached = options.onChildHostConnectionAttached;
    this.#metadataUpstream = options.metadataUpstream;
    this.#p2pTicket = options.p2pTicket;
    this.#snapshotTraversalTtlMs = options.snapshotTraversalTtlMs ?? 5 * 60_000;
    this.#authorityAcceptanceSigner = options.authorityAcceptanceSigner;
    if (!Number.isSafeInteger(this.#snapshotTraversalTtlMs) || this.#snapshotTraversalTtlMs < 1) {
      throw new RangeError("snapshotTraversalTtlMs must be a positive integer");
    }
  }

  public close(): void {
    this.#closed = true;
    for (const pump of this.#childPumps.values()) pump.abort.abort();
    this.#childPumps.clear();
    this.#childConnections.clear();
    this.#snapshotTraversals.clear();
    if (this.#ownsEvents) this.events.close();
    this.#connections.clear();
  }

  public describe(): {
    application: typeof APPLICATION_ID;
    protocolVersion: typeof PROTOCOL_VERSION;
    role: "host";
    instanceId: string;
    capabilities: string[];
  } {
    return {
      application: APPLICATION_ID,
      protocolVersion: PROTOCOL_VERSION,
      role: "host",
      instanceId: this.#instanceId,
      capabilities: [
        "catalog.sqlite",
        "metadata.cas",
        "metadata.queued",
        "authority.handoff",
        "authority.force-adopt",
        "commands.idempotent",
        "stream.control-replay",
        "stream.native-ring",
        "stream.feed-checkpoints",
        "topology.nested-hosts",
        "routing.recursive",
      ],
    };
  }

  public describeHost(context: HostPeerContext = {}): HostDescriptor {
    const local = this.catalog.localHost();
    if (
      context.authenticatedHostId !== undefined &&
      local.parentHostId !== null &&
      context.authenticatedHostId !== local.parentHostId
    ) {
      throw new HostCoreError("FENCED", "authenticated host is not this host's parent");
    }
    return local;
  }

  public enrollObserver(
    input: ObserverEnrollment,
    context: HostPeerContext = {},
  ): { accepted: true; canonical: HostDescriptor } {
    if (!context.endpointId) {
      throw new HostCoreError("FENCED", "observer enrollment requires a transport endpoint");
    }
    this.catalog.enrollPeer(context.endpointId, "observer", context.endpointId);
    void input.name;
    return { accepted: true, canonical: this.catalog.localHost() };
  }

  public listHosts(): HostDescriptor[] {
    return this.catalog.listHosts();
  }

  public getHost(hostId: HostId): HostDescriptor | null {
    return this.catalog.getHost(hostId);
  }

  public watchHosts(cursor: StreamCursor, signal?: AbortSignal) {
    return this.events.watchHosts(cursor, signal);
  }

  /** Mint an offer at this tree's source authority. Cross-root orchestration calls each root. */
  public async offerAuthorityHandoff(
    input: AuthorityHandoffOfferInput,
  ): Promise<AuthorityHandoffOffer> {
    const request = authorityHandoffOfferInputSchema.parse(input);
    return this.catalog.offerAuthorityHandoff(request);
  }

  /** Accept an offer at this independent destination root. */
  public async acceptAuthorityHandoff(
    input: AuthorityHandoffAcceptInput,
  ): Promise<AuthorityHandoffAcceptance> {
    const request = authorityHandoffAcceptInputSchema.parse(input);
    if (!this.#authorityAcceptanceSigner) {
      throw new HostCoreError(
        "UNSUPPORTED",
        "this host has no persistent authority-acceptance signer",
      );
    }
    return this.catalog.acceptAuthorityHandoff(
      request,
      this.#authorityAcceptanceSigner,
    );
  }

  /** Consume the one-shot capability at this tree's source authority. */
  public async consumeAuthorityHandoff(
    input: AuthorityHandoffConsumeInput,
  ): Promise<AuthorityAdoptionReceipt> {
    const request = authorityHandoffConsumeInputSchema.parse(input);
    return this.catalog.consumeAuthorityHandoff(request);
  }

  /** Perform audited recovery at this independent destination root. */
  public async forceAdoptAuthority(
    input: AuthorityForceAdoptInput,
    context: HostPeerContext = {},
  ): Promise<AuthorityAdoptionReceipt> {
    if (!context.authenticatedActorId) {
      throw new HostCoreError(
        "FENCED",
        "force-adopt requires an authenticated transport actor",
      );
    }
    const presented = authorityForceAdoptInputSchema.parse(input);
    const request = authorityForceAdoptInputSchema.parse({
      ...presented,
      audit: {
        ...presented.audit,
        actorId: context.authenticatedActorId,
      },
    });
    return this.catalog.forceAdoptAuthority(request);
  }

  public async attachChild(
    requestInput: HostAttachmentRequest,
    context: ChildHostIngressContext = {},
  ): Promise<{
    accepted: true;
    canonical: HostDescriptor;
    attachment: HostAttachment;
    parentCheckpoint: FeedCheckpoint;
  }> {
    const presented = hostAttachmentRequestSchema.parse(requestInput);
    this.#assertChildIngressIdentity(presented.hostId, context);
    if (
      presented.endpointId !== undefined &&
      context.endpointId !== undefined &&
      presented.endpointId !== context.endpointId
    ) {
      throw new HostCoreError(
        "FENCED",
        "child host payload endpoint does not match its authenticated transport endpoint",
      );
    }
    const request = hostAttachmentRequestSchema.parse({
      ...presented,
      ...(context.endpointId === undefined ? {} : { endpointId: context.endpointId }),
    });
    const connection =
      context.childHostConnection ?? context.createChildHostConnection?.(request);
    if (
      connection &&
      (connection.hostId !== request.hostId || connection.hostBootId !== request.hostBootId)
    ) {
      throw new HostCoreError(
        "FENCED",
        "reverse child connection identity does not match attachment request",
      );
    }
    if (
      connection?.endpointId !== undefined &&
      context.endpointId !== undefined &&
      connection.endpointId !== context.endpointId
    ) {
      throw new HostCoreError(
        "FENCED",
        "reverse child connection endpoint does not match attachment transport",
      );
    }

    const { attachment } = this.catalog.attachChild(request);
    if (context.endpointId) {
      this.catalog.enrollPeer(context.endpointId, "childHost", request.hostId);
    }
    if (connection) {
      this.#installChildConnection(connection);
    }
    return {
      accepted: true,
      canonical: this.catalog.getHost(request.hostId)!,
      attachment,
      parentCheckpoint: this.catalog.feedCheckpoint(),
    };
  }

  /** Attach a reverse child channel after transport bootstrap has completed. */
  public async attachChildConnection(connection: ChildHostConnection): Promise<void> {
    const child = this.catalog.getHost(connection.hostId);
    const attachment = this.catalog.getAttachment(connection.hostId);
    if (!child || !attachment) {
      throw new HostCoreError("NOT_FOUND", `child host ${connection.hostId} is not attached`);
    }
    if (child.hostBootId !== connection.hostBootId) {
      throw new HostCoreError("FENCED", "child connection has a stale boot ID");
    }
    if (
      child.endpointId !== undefined &&
      connection.endpointId !== undefined &&
      child.endpointId !== connection.endpointId
    ) {
      throw new HostCoreError("FENCED", "child connection has another transport endpoint");
    }
    this.#installChildConnection(connection);
    await this.#replaceChildPumpWithSnapshot(connection, attachment);
  }

  /** Transport loss retains topology and the cached subtree, but fences routing. */
  public detachChildConnection(hostId: HostId, hostBootId?: string): void {
    const connection = this.#childConnections.get(hostId);
    if (
      !connection ||
      (hostBootId !== undefined && connection.hostBootId !== hostBootId)
    ) {
      return;
    }
    this.#childPumps.get(hostId)?.abort.abort();
    this.#childPumps.delete(hostId);
    this.#childConnections.delete(hostId);
    this.catalog.markChildDisconnected(hostId, connection.hostBootId);
  }

  /** Explicit graceful detach changes topology; ordinary disconnects must not call this. */
  public detachChild(hostId: HostId, attachmentId?: HostAttachment["attachmentId"]): boolean {
    const attachment = this.catalog.getAttachment(hostId);
    if (!attachment || (attachmentId !== undefined && attachment.attachmentId !== attachmentId)) {
      return false;
    }
    this.#childPumps.get(hostId)?.abort.abort();
    this.#childPumps.delete(hostId);
    this.#childConnections.delete(hostId);
    return this.catalog.detachChild(hostId, attachment.attachmentId);
  }

  public async heartbeatChild(
    input: HostLinkFence & { checkpoint: FeedCheckpoint },
    context: ChildHostIngressContext = {},
  ): Promise<{
    accepted: boolean;
    parentCheckpoint: FeedCheckpoint;
    p2pTicket?: string;
  }> {
    this.#assertChildFence(input, context);
    const childWasOnline = this.catalog.getHost(input.hostId)?.presence === "online";
    const accepted = this.catalog.heartbeatChild(
      input.hostId,
      input.hostBootId,
      input.attachmentId,
      input.lineageId,
    );
    const imported = this.catalog.childCheckpoint(input.hostId, input.attachmentId);
    const connection = this.#childConnections.get(input.hostId);
    const attachment = this.catalog.getAttachment(input.hostId);
    const pump = this.#childPumps.get(input.hostId);
    // Installing a replacement reverse connection deliberately aborts the old
    // pump. A same-feed reconnect still needs a fresh snapshot barrier before
    // replay starts on that connection, even when its durable checkpoint exists.
    if (
      connection &&
      attachment &&
      (!childWasOnline ||
        !imported ||
        imported.feedId !== input.checkpoint.feedId ||
        !pump ||
        pump.connection !== connection ||
        pump.attachmentId !== attachment.attachmentId)
    ) {
      try {
        await this.#replaceChildPumpWithSnapshot(connection, attachment);
      } catch (error) {
        this.catalog.markChildDisconnected(connection.hostId, connection.hostBootId);
        throw error;
      }
    }
    // Terminal receipts are durable across a disconnected child link. A
    // heartbeat is the normal retry signal once the reverse RPC is usable
    // again, including when no resnapshot barrier was required.
    await this.#flushDownstreamMetadata(input.hostId);
    const p2pTicket = this.#p2pTicket?.();
    return {
      accepted,
      parentCheckpoint: this.catalog.feedCheckpoint(),
      ...(p2pTicket ? { p2pTicket } : {}),
    };
  }

  /** Apply the attachment returned by this host's parent transport. */
  public applyParentAttachment(attachment: HostAttachment): HostDescriptor {
    return this.catalog.applyParentAttachment(attachment);
  }

  public readSubtreeSnapshot(
    request: HostSubtreeSnapshotRequest,
    context: HostPeerContext = {},
  ): HostSubtreeSnapshotPage {
    this.#assertParentFence(request, context);
    this.#pruneSnapshotTraversals();
    const limit = request.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("snapshot page limit must be between 1 and 5,000");
    }

    let traversal: SnapshotTraversal;
    if (request.pageToken === undefined) {
      const checkpoint = this.catalog.feedCheckpoint();
      traversal = {
        attachmentId: request.attachmentId,
        lineageId: request.lineageId,
        checkpoint,
        capturedAt: this.#now().toISOString(),
        entities: [
          ...this.#snapshotHostsInTopologyOrder().map((value) => ({
            kind: "host" as const,
            value,
          })),
          ...this.catalog.listWorkers().map((value) => ({ kind: "worker" as const, value })),
          ...this.catalog.listSessions().map((value) => ({ kind: "session" as const, value })),
          ...this.catalog
            .listInteractions({ pendingOnly: false })
            .map((value) => ({ kind: "interaction" as const, value })),
          ...this.catalog
            .listMetadataOperations({ limit: 10_000 })
            .map((value) => ({ kind: "metadataOperation" as const, value })),
        ],
        offset: 0,
        expiresAt: Date.now() + this.#snapshotTraversalTtlMs,
      };
    } else {
      const existing = this.#snapshotTraversals.get(request.pageToken);
      if (!existing || existing.expiresAt <= Date.now()) {
        this.#snapshotTraversals.delete(request.pageToken);
        throw new HostCoreError("NOT_FOUND", "snapshot page token is unknown or expired");
      }
      if (
        existing.attachmentId !== request.attachmentId ||
        existing.lineageId !== request.lineageId
      ) {
        throw new HostCoreError("FENCED", "snapshot page token belongs to another host lineage");
      }
      traversal = existing;
    }

    const pageEntities = traversal.entities.slice(traversal.offset, traversal.offset + limit);
    const nextOffset = traversal.offset + pageEntities.length;
    let nextPageToken: string | null = null;
    if (nextOffset < traversal.entities.length) {
      nextPageToken = randomUUID();
      this.#snapshotTraversals.set(nextPageToken, {
        ...traversal,
        offset: nextOffset,
      });
    }
    return hostSubtreeSnapshotPageSchema.parse({
      rootHostId: this.catalog.localHost().hostId,
      attachmentId: traversal.attachmentId,
      lineageId: traversal.lineageId,
      checkpoint: traversal.checkpoint,
      capturedAt: traversal.capturedAt,
      hosts: pageEntities.flatMap((entity) =>
        entity.kind === "host" ? [entity.value] : [],
      ),
      workers: pageEntities.flatMap((entity) =>
        entity.kind === "worker" ? [entity.value] : [],
      ),
      sessions: pageEntities.flatMap((entity) =>
        entity.kind === "session" ? [entity.value] : [],
      ),
      interactions: pageEntities.flatMap((entity) =>
        entity.kind === "interaction" ? [entity.value] : [],
      ),
      metadataOperations: pageEntities.flatMap((entity) =>
        entity.kind === "metadataOperation" ? [entity.value] : [],
      ),
      nextPageToken,
    });
  }

  public async *subscribeAggregate(
    input: HostLinkFence & { cursor: StreamCursor },
    context: HostPeerContext = {},
    signal?: AbortSignal,
  ): AsyncGenerator<FleetStreamItem> {
    this.#assertParentFence(input, context);
    for await (const item of this.events.attach(
      { sessions: "all", includeNative: true, cursor: input.cursor },
      signal,
    )) {
      yield item;
    }
  }

  public listModelsFromParent(
    input: HostLinkFence & { workerId: WorkerId; harness: Harness },
    context: HostPeerContext = {},
  ): Promise<NativeModel[]> {
    this.#assertParentFence(input, context);
    return this.listModels(input.workerId, input.harness);
  }

  public refreshFromParent(
    input: HostLinkFence & { workerId: WorkerId },
    context: HostPeerContext = {},
  ): Promise<InventorySnapshot> {
    this.#assertParentFence(input, context);
    return this.refresh(input.workerId);
  }

  public spawnFromParent(
    input: HostLinkFence & { command: SpawnCommand },
    context: HostPeerContext = {},
  ): Promise<CommandRecord> {
    this.#assertParentFence(input, context);
    return this.spawn(input.command);
  }

  public resumeFromParent(
    input: HostLinkFence & { command: ResumeCommand },
    context: HostPeerContext = {},
  ): Promise<CommandRecord> {
    this.#assertParentFence(input, context);
    return this.resume(input.command);
  }

  public executeFromParent(
    input: HostLinkFence & { command: CommandEnvelope },
    context: HostPeerContext = {},
  ): Promise<CommandRecord> {
    this.#assertParentFence(input, context);
    return this.execute(input.command);
  }

  public readNativeHistoryFromParent(
    input: HostLinkFence & { sessionId: SessionId; request: NativeHistoryRequest },
    context: HostPeerContext = {},
  ): Promise<NativeHistoryResult> {
    this.#assertParentFence(input, context);
    return this.readNativeHistory(input.sessionId, input.request);
  }

  public getCommandFromParent(
    input: HostLinkFence & { commandId: CommandId },
    context: HostPeerContext = {},
  ): Promise<CommandRecord | null> {
    this.#assertParentFence(input, context);
    return this.recoverCommand(input.commandId);
  }

  public resolveInteractionFromParent(
    input: HostLinkFence & { interaction: ResolveInteractionInput },
    context: HostPeerContext = {},
  ): Promise<InteractionRecord> {
    this.#assertParentFence(input, context);
    return this.resolveInteraction(input.interaction);
  }

  public applyMetadataFromParent(
    input: HostLinkFence & { operation: MetadataOperationRecord },
    context: HostPeerContext = {},
  ): MetadataOperationRecord {
    this.#assertParentFence(input, context);
    const operation = metadataOperationRecordSchema.parse(input.operation);
    const settled = this.catalog.settleMetadataOperation(operation, {
      acceptAuthorityEpochFromParent: true,
    });
    this.#queueTerminalDownstream(settled);
    return settled;
  }

  public offerAuthorityHandoffFromParent(
    input: HostLinkFence & { request: AuthorityHandoffOfferInput },
    context: HostPeerContext = {},
  ): Promise<AuthorityHandoffOffer> {
    this.#assertParentFence(input, context);
    return this.offerAuthorityHandoff(input.request);
  }

  public acceptAuthorityHandoffFromParent(
    input: HostLinkFence & { request: AuthorityHandoffAcceptInput },
    context: HostPeerContext = {},
  ): Promise<AuthorityHandoffAcceptance> {
    this.#assertParentFence(input, context);
    return this.acceptAuthorityHandoff(input.request);
  }

  public consumeAuthorityHandoffFromParent(
    input: HostLinkFence & { request: AuthorityHandoffConsumeInput },
    context: HostPeerContext = {},
  ): Promise<AuthorityAdoptionReceipt> {
    this.#assertParentFence(input, context);
    return this.consumeAuthorityHandoff(input.request);
  }

  public forceAdoptAuthorityFromParent(
    input: HostLinkFence & { request: AuthorityForceAdoptInput },
    context: HostPeerContext = {},
  ): Promise<AuthorityAdoptionReceipt> {
    this.#assertParentFence(input, context);
    return this.forceAdoptAuthority(input.request, context);
  }

  public attachWorkerConnection(connection: WorkerConnection): void {
    const descriptor = this.catalog.getWorker(connection.workerId);
    if (descriptor && descriptor.workerBootId !== connection.workerBootId) {
      throw new HostCoreError("FENCED", "worker connection has a stale boot ID");
    }
    this.#connections.set(connection.workerId, connection);
    this.#onWorkerConnectionAttached?.(connection);
    void this.#flushWorkerMetadata(connection.workerId);
  }

  public detachWorkerConnection(workerId: WorkerId, workerBootId?: string): void {
    const connection = this.#connections.get(workerId);
    if (!connection || (workerBootId !== undefined && connection.workerBootId !== workerBootId)) {
      return;
    }
    this.#connections.delete(workerId);
    this.catalog.setWorkerPresence(workerId, "offline", connection.workerBootId);
  }

  public registerWorker(
    registration: WorkerRegistration,
    context: HostIngressContext = {},
  ): { accepted: true; canonical: WorkerDescriptor } {
    this.#assertIngressIdentity(registration.workerId, context);
    const existing = this.catalog.getWorker(registration.workerId);
    if (
      existing?.endpointId !== undefined &&
      context.endpointId !== undefined &&
      existing.endpointId !== context.endpointId
    ) {
      throw new HostCoreError(
        "FENCED",
        `worker ${registration.workerId} is pinned to another transport endpoint`,
      );
    }
    if (
      context.endpointId !== undefined &&
      this.catalog
        .listWorkers()
        .some(
          (worker) =>
            worker.workerId !== registration.workerId &&
            worker.endpointId === context.endpointId,
        )
    ) {
      throw new HostCoreError(
        "FENCED",
        "transport endpoint is already enrolled as another worker",
      );
    }
    const workerConnection =
      context.workerConnection ??
      context.createWorkerConnection?.(registration.workerId, registration.workerBootId);
    if (
      workerConnection &&
      (workerConnection.workerId !== registration.workerId ||
        workerConnection.workerBootId !== registration.workerBootId)
    ) {
      throw new HostCoreError("FENCED", "reverse worker connection identity does not match registration");
    }
    const canonical = this.catalog.registerWorker(registration, context.endpointId);
    if (context.endpointId) {
      this.catalog.enrollPeer(context.endpointId, "worker", registration.workerId);
    }
    if (workerConnection) this.attachWorkerConnection(workerConnection);
    return { accepted: true, canonical };
  }

  public heartbeat(
    workerId: WorkerId,
    workerBootId: string,
    context: HostIngressContext = {},
  ): { accepted: boolean; hostCursor: number; p2pTicket?: string } {
    this.#assertIngressIdentity(workerId, context);
    const p2pTicket = this.#p2pTicket?.();
    const accepted = this.catalog.heartbeat(workerId, workerBootId);
    if (accepted) void this.#flushWorkerMetadata(workerId);
    return {
      accepted,
      hostCursor: this.catalog.controlCursor(),
      ...(p2pTicket ? { p2pTicket } : {}),
    };
  }

  public reconcile(
    snapshot: InventorySnapshot,
    context: HostIngressContext = {},
  ): { sessions: SessionRecord[]; hostCursor: number } {
    this.#assertIngressIdentity(snapshot.workerId, context);
    const sessions = this.#reconcileInventory(snapshot);
    return { sessions, hostCursor: this.catalog.controlCursor() };
  }

  public listWorkers(): WorkerDescriptor[] {
    return this.catalog.listWorkers();
  }

  public watchWorkers(cursor: StreamCursor | number, signal?: AbortSignal) {
    return this.events.watchWorkers(this.#streamCursor(cursor), signal);
  }

  public watchSessions(input: import("@agent-multiplex/protocol").AttachInput, signal?: AbortSignal) {
    return this.events.attach(input, signal);
  }

  public listSessions(filter: SessionFilter = {}): SessionRecord[] {
    return this.catalog.listSessions(filter);
  }

  public getSession(sessionId: SessionId): SessionRecord | null {
    return this.catalog.getSession(sessionId);
  }

  public harnessCatalog(workerId?: WorkerId): HarnessCatalogEntry[] {
    const workers = workerId
      ? [this.#worker(workerId)]
      : this.catalog.listWorkers();
    return workers.flatMap((worker) => worker.harnesses);
  }

  public async listModels(workerId: WorkerId, harness: Harness): Promise<NativeModel[]> {
    const route = this.#workerRoute(workerId);
    return route
      ? this.#childConnection(route).listModels(workerId, harness)
      : this.#connection(workerId).listModels(harness);
  }

  public async refresh(workerId: WorkerId): Promise<InventorySnapshot> {
    const route = this.#workerRoute(workerId);
    const snapshot = route
      ? await this.#childConnection(route).refreshInventory(workerId)
      : await this.#connection(workerId).refreshInventory();
    if (snapshot.workerId !== workerId) {
      throw new HostCoreError("FENCED", "worker returned inventory for another worker ID");
    }
    if (route) {
      const connection = this.#childConnection(route);
      const attachment = this.catalog.getAttachment(route.immediateChildHostId);
      if (!attachment) {
        throw new HostCoreError("FENCED", "child route attachment is no longer active");
      }
      await this.#replaceChildPumpWithSnapshot(connection, attachment);
    } else {
      this.#reconcileInventory(snapshot);
    }
    return snapshot;
  }

  public async spawn(input: SpawnCommand): Promise<CommandRecord> {
    metadataValuesSchema.parse(input.metadata ?? {});
    if (this.catalog.getSession(input.sessionId)) {
      const existing = this.catalog.getCommand(input.commandId);
      if (!existing) {
        throw new HostCoreError("CONFLICT", `logical session ${input.sessionId} already exists`);
      }
    }
    const route = this.#workerRoute(input.workerId);
    const target = route ? this.#childConnection(route) : this.#connection(input.workerId);
    const invoke = () => target.spawn(input);
    return this.#dispatch(input, invoke, (record) =>
      this.#reconcileAfterLifecycle(input, record),
    );
  }

  public async resume(input: ResumeCommand): Promise<CommandRecord> {
    const session = this.catalog.getSession(input.sessionId);
    if (session && session.harness !== input.request.harness) {
      throw new HostCoreError("FENCED", "resume harness does not match the logical session");
    }
    const nativeCollision = this.catalog
      .listSessions({ workerId: input.workerId, harness: input.request.harness })
      .find(
        (candidate) =>
          candidate.vendorSessionId === input.request.vendorSessionId &&
          candidate.sessionId !== input.sessionId,
      );
    if (nativeCollision) {
      throw new HostCoreError(
        "FENCED",
        `native session ${input.request.vendorSessionId} is already bound to ${nativeCollision.sessionId}`,
      );
    }
    const route = this.#workerRoute(input.workerId);
    const target = route ? this.#childConnection(route) : this.#connection(input.workerId);
    const invoke = () => target.resume(input);
    return this.#dispatch(input, invoke, (record) =>
      this.#reconcileAfterLifecycle(input, record),
    );
  }

  public async execute(input: CommandEnvelope): Promise<CommandRecord> {
    const session = this.catalog.getSession(input.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "session is not registered");
    if (
      session.workerId !== input.workerId ||
      session.bindingRevision !== input.bindingRevision ||
      session.harness !== input.request.harness
    ) {
      throw new HostCoreError("FENCED", "command targets a stale session binding");
    }
    const route = this.#workerRoute(input.workerId);
    const target = route ? this.#childConnection(route) : this.#connection(input.workerId);
    return this.#dispatch(
      input,
      () => target.execute(input),
    );
  }

  public async readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult> {
    const session = this.catalog.getSession(sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "session is not registered");
    if (session.harness !== request.harness) {
      throw new HostCoreError("FENCED", "history request harness does not match session");
    }
    const route = this.#workerRoute(session.workerId);
    return route
      ? this.#childConnection(route).readNativeHistory(sessionId, request)
      : this.#connection(session.workerId).readNativeHistory(sessionId, request);
  }

  public getMetadata(sessionId: SessionId) {
    return this.catalog.getMetadata(sessionId);
  }

  public patchMetadata(patch: MetadataPatch): MetadataOperationRecord {
    const operation = this.catalog.submitMetadataPatch(patch);
    if (operation.status === "queued") {
      void this.#flushMetadataUpstream([operation]);
    } else {
      this.#queueTerminalDownstream(operation);
    }
    return operation;
  }

  public getMetadataOperation(operationId: string): MetadataOperationRecord | null {
    return this.catalog.getMetadataOperation(operationId);
  }

  public listMetadataOperations(
    filter: {
      sessionId?: SessionId | undefined;
      originHostId?: HostId | undefined;
      statuses?: readonly MetadataOperationRecord["status"][] | undefined;
      limit?: number | undefined;
    } = {},
  ): MetadataOperationRecord[] {
    return this.catalog.listMetadataOperations({
      ...(filter.sessionId === undefined ? {} : { sessionId: filter.sessionId }),
      ...(filter.originHostId === undefined ? {} : { originHostId: filter.originHostId }),
      ...(filter.statuses === undefined ? {} : { statuses: filter.statuses }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
    });
  }

  public watchMetadataOperations(cursor: StreamCursor, signal?: AbortSignal) {
    return this.events.watchMetadataOperations(cursor, signal);
  }

  public pushMetadataOutbox(
    workerId: WorkerId,
    patches: readonly MetadataPatch[],
    context: HostIngressContext = {},
  ): MetadataOperationRecord[] {
    this.#assertIngressIdentity(workerId, context);
    const operations = patches.map((patch) => {
      const session = this.catalog.getSession(patch.sessionId);
      if (!session) throw new HostCoreError("NOT_FOUND", "metadata session is not registered");
      if (session.workerId !== workerId) {
        throw new HostCoreError("FENCED", "worker cannot patch metadata for another worker's session");
      }
      return this.catalog.submitMetadataPatch(patch);
    });
    const queued = operations.filter((operation) => operation.status === "queued");
    for (const operation of queued) {
      this.catalog.trackWorkerMetadataReplication(workerId, operation);
    }
    for (const operation of operations) {
      if (operation.status !== "queued") this.#queueTerminalDownstream(operation);
    }
    if (queued.length > 0) {
      void this.#flushMetadataUpstream(queued);
    }
    return operations;
  }

  public async pushChildMetadataOutbox(
    input: HostLinkFence & { operations: readonly MetadataOperationRecord[] },
    context: ChildHostIngressContext = {},
  ): Promise<MetadataOperationRecord[]> {
    this.#assertChildFence(input, context);
    const accepted: MetadataOperationRecord[] = [];
    const awaitingSession = new Set<string>();
    for (const operationInput of input.operations) {
      const operation = metadataOperationRecordSchema.parse(operationInput);
      if (operation.status !== "queued") {
        throw new HostCoreError("FENCED", "a child may only push queued metadata upstream");
      }
      const session = this.catalog.getSession(operation.sessionId);
      if (!session) {
        // Control-feed propagation and this reverse metadata RPC use separate
        // streams. A freshly-created descendant session can therefore submit
        // its lifecycle metadata before the matching session.upsert reaches
        // this host. Acknowledge it as still queued without recording it; the
        // child keeps the operation in its durable outbox and retries after
        // the session route has converged.
        accepted.push(operation);
        awaitingSession.add(operation.operationId);
        continue;
      }
      const route = this.catalog.routeForWorker(session.workerId);
      if (!route || route.immediateChildHostId !== input.hostId) {
        throw new HostCoreError(
          "FENCED",
          "child cannot push metadata for a session outside its subtree",
        );
      }
      accepted.push(
        session.metadataAuthority.hostId === this.catalog.localHost().hostId
          ? this.catalog.applyMetadataOperationAtAuthority(operation)
          : this.catalog.recordQueuedMetadataOperation(operation),
      );
    }

    const queued = accepted.filter(
      (operation) =>
        operation.status === "queued" && !awaitingSession.has(operation.operationId),
    );
    const forwarded = new Map<string, MetadataOperationRecord>();
    if (queued.length > 0 && this.#metadataUpstream) {
      for (const operation of await this.#forwardMetadataUpstream(queued)) {
        forwarded.set(operation.operationId, operation);
      }
    }
    const results = accepted.map(
      (operation) => forwarded.get(operation.operationId) ?? operation,
    );
    for (const operation of results) {
      if (operation.status !== "queued") this.#queueTerminalDownstream(operation);
    }
    return results;
  }

  public listInteractions(
    filter: {
      sessionId?: SessionId | undefined;
      pendingOnly?: boolean | undefined;
    } = {},
  ) {
    return this.catalog.listInteractions(filter);
  }

  public async resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord> {
    const interaction = this.catalog.getInteraction(input.interactionId);
    if (!interaction) throw new HostCoreError("NOT_FOUND", "interaction is not registered");
    if (interaction.sessionId !== input.sessionId || interaction.harness !== input.harness) {
      throw new HostCoreError("FENCED", "interaction binding does not match");
    }
    if (interaction.state === "resolved") {
      if (
        interaction.resolution !== undefined &&
        canonicalJson(interaction.resolution) === canonicalJson(input.response)
      ) {
        return interaction;
      }
      throw new HostCoreError("CONFLICT", "interaction was already resolved with another response");
    }
    if (interaction.state !== "pending") {
      throw new HostCoreError("FENCED", "interaction is no longer pending");
    }
    const session = this.catalog.getSession(input.sessionId);
    if (!session || session.runtimeEpoch !== interaction.runtimeEpoch) {
      throw new HostCoreError("FENCED", "interaction runtime is no longer active");
    }
    const route = this.#workerRoute(session.workerId);
    const resolved = route
      ? await this.#childConnection(route).resolveInteraction(input)
      : await this.#connection(session.workerId).resolveInteraction(input);
    return this.catalog.updateInteraction(resolved);
  }

  public publishInteraction(
    interaction: InteractionRecord,
    context: HostIngressContext = {},
  ): InteractionRecord {
    const session = this.catalog.getSession(interaction.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "interaction session is not registered");
    this.#assertIngressIdentity(session.workerId, context);
    return this.catalog.publishInteraction(interaction);
  }

  public publishWorkerEvent(
    itemInput: WorkerEventItem,
    context: HostIngressContext = {},
  ): { accepted: boolean } {
    try {
      // Parsing the deliberately smaller worker union strips/rejects any
      // attempted host feed envelope before the change reaches the catalog.
      const item = workerEventItemSchema.parse(itemInput);
      if (item.kind === "heartbeat") return { accepted: true };
      if (item.kind === "native" || item.kind === "nativeGap") {
        const session = this.catalog.getSession(item.sessionId);
        if (!session) return { accepted: false };
        this.#assertIngressIdentity(session.workerId, context);
        if (
          item.kind === "native" &&
          (session.harness !== item.harness || session.runtimeEpoch !== item.runtimeEpoch)
        ) {
          return { accepted: false };
        }
        this.events.publish(item);
        return { accepted: true };
      }
      if (item.kind === "control") {
        const change = item.change;
        if (change.type === "session.upsert") {
          this.#assertIngressIdentity(change.session.workerId, context);
          const current = this.catalog.getSession(change.session.sessionId);
          if (!current) return { accepted: false };
          this.catalog.mergeWorkerSession({
            ...change.session,
            metadataAuthority: current.metadataAuthority,
          });
          return { accepted: true };
        }
        if (change.type === "interaction.changed") {
          this.publishInteraction(change.interaction, context);
          return { accepted: true };
        }
      }
      return { accepted: false };
    } catch (error) {
      if (
        error instanceof HostCoreError &&
        (error.code === "FENCED" || error.code === "NOT_FOUND")
      ) {
        return { accepted: false };
      }
      throw error;
    }
  }

  public getCommand(commandId: string): CommandRecord | null {
    return this.catalog.getCommand(commandId);
  }

  public async recoverCommand(commandId: CommandId): Promise<CommandRecord | null> {
    const current = this.catalog.getCommand(commandId);
    if (!current || terminalStates.has(current.state) && current.state !== "outcomeUnknown") {
      return current;
    }
    const observed = await this.#remoteCommand(current.workerId, commandId).catch(() => null);
    return observed ? this.catalog.updateCommand(observed) : current;
  }

  async #dispatch(
    input: DispatchInput,
    invoke: () => Promise<CommandRecord>,
    afterSuccess?: (record: CommandRecord) => Promise<void>,
  ): Promise<CommandRecord> {
    const request = jsonValueSchema.parse(input);
    const candidate = commandRecordSchema.parse({
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      sessionId: input.sessionId,
      workerId: input.workerId,
      state: "received",
      request,
      createdAt: this.#now().toISOString(),
      updatedAt: this.#now().toISOString(),
    });
    const accepted = "bindingRevision" in input
      ? this.catalog.acceptCommand(candidate)
      : this.catalog.acceptCommand(candidate, input);
    if (accepted.state === "outcomeUnknown") {
      const observed = await this.#remoteCommand(input.workerId, input.commandId).catch(
        () => null,
      );
      if (observed) {
        return this.#afterSuccessfulDispatch(
          this.catalog.updateCommand(observed),
          afterSuccess,
        );
      }
      return accepted;
    }
    if (terminalStates.has(accepted.state)) {
      return this.#afterSuccessfulDispatch(accepted, afterSuccess);
    }

    const running = this.#dispatches.get(input.commandId);
    if (running) return running;
    if (accepted.state === "started") {
      const observed = await this.#remoteCommand(input.workerId, input.commandId);
      if (observed) {
        return this.#afterSuccessfulDispatch(
          this.catalog.updateCommand(observed),
          afterSuccess,
        );
      }
      return accepted;
    }

    const dispatch = (async (): Promise<CommandRecord> => {
      this.catalog.transitionCommand(input.commandId, "started");
      let result: CommandRecord;
      try {
        result = await invoke();
      } catch (error) {
        return this.catalog.transitionCommand(input.commandId, "outcomeUnknown", {
          error: error instanceof Error ? error.message : "worker dispatch outcome is unknown",
        });
      }
      const stored = this.catalog.updateCommand(result);
      return this.#afterSuccessfulDispatch(stored, afterSuccess);
    })().finally(() => this.#dispatches.delete(input.commandId));
    this.#dispatches.set(input.commandId, dispatch);
    return dispatch;
  }

  async #reconcileAfterLifecycle(
    input: SpawnCommand | ResumeCommand,
    record: CommandRecord,
  ): Promise<void> {
    const route = this.#workerRoute(input.workerId);
    if (route) {
      // The child already owns the logical/native binding. Refreshing through
      // it and then replacing our projection preserves that exact session ID.
      await this.refresh(input.workerId);
      return;
    }
    const snapshot = await this.#connection(input.workerId).refreshInventory();
    const vendorSessionId =
      this.#vendorSessionId(record.result) ??
      ("vendorSessionId" in input.request ? input.request.vendorSessionId : undefined);
    const item = snapshot.sessions.find(
      (candidate) =>
        candidate.harness === input.request.harness &&
        candidate.vendorSessionId === vendorSessionId,
    );
    const preferredSessionIds = new Map<string, SessionId>();
    if (item) preferredSessionIds.set(nativeInventoryKey(input.workerId, item), input.sessionId);
    this.#reconcileInventory(snapshot, { preferredSessionIds });
  }

  async #afterSuccessfulDispatch(
    record: CommandRecord,
    afterSuccess?: (record: CommandRecord) => Promise<void>,
  ): Promise<CommandRecord> {
    if (record.state === "succeeded" && afterSuccess) {
      // The worker side effect is already final. Binding and initial metadata
      // are durable repair work and must never make callers replay the command.
      await afterSuccess(record).catch(() => undefined);
    }
    return record;
  }

  #reconcileInventory(
    snapshot: InventorySnapshot,
    options: ReconcileOptions = {},
  ): SessionRecord[] {
    this.catalog.reconcileInventory(snapshot, options);
    this.catalog.applyPendingLifecycleMetadata(snapshot.workerId);
    // Metadata application may have replaced records returned by reconciliation.
    return this.catalog.listSessions({ workerId: snapshot.workerId });
  }

  #vendorSessionId(result: JsonValue | undefined): string | undefined {
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const value = result.vendorSessionId;
    return typeof value === "string" ? value : undefined;
  }

  #worker(workerId: WorkerId): WorkerDescriptor {
    const worker = this.catalog.getWorker(workerId);
    if (!worker) throw new HostCoreError("NOT_FOUND", `worker ${workerId} is not registered`);
    return worker;
  }

  #connection(workerId: WorkerId): WorkerConnection {
    const descriptor = this.#worker(workerId);
    const connection = this.#connections.get(workerId);
    if (
      !connection ||
      connection.workerBootId !== descriptor.workerBootId ||
      descriptor.presence !== "online"
    ) {
      throw new HostCoreError("UNAVAILABLE", `worker ${workerId} is not connected`);
    }
    return connection;
  }

  #workerRoute(workerId: WorkerId): AggregateRoute | null {
    const worker = this.#worker(workerId);
    const route = this.catalog.routeForWorker(workerId);
    if (route) {
      if (route.ownerHostId !== worker.ownerHostId) {
        throw new HostCoreError("FENCED", "worker route disagrees with its owning host");
      }
      return route;
    }
    if (worker.ownerHostId !== this.catalog.localHost().hostId) {
      throw new HostCoreError("FENCED", "remote worker has no active immediate-child route");
    }
    return null;
  }

  #childConnection(route: AggregateRoute): ChildHostConnection {
    const attachment = this.catalog.getAttachment(route.immediateChildHostId);
    const child = this.catalog.getHost(route.immediateChildHostId);
    const connection = this.#childConnections.get(route.immediateChildHostId);
    if (
      !attachment ||
      attachment.attachmentId !== route.attachmentId ||
      attachment.lineageId !== route.lineageId
    ) {
      throw new HostCoreError("FENCED", "worker route has a stale child attachment");
    }
    if (
      !child ||
      !connection ||
      child.hostBootId !== connection.hostBootId ||
      child.presence !== "online"
    ) {
      throw new HostCoreError(
        "UNAVAILABLE",
        `child host ${route.immediateChildHostId} is not connected`,
      );
    }
    return connection;
  }

  async #remoteCommand(workerId: WorkerId, commandId: CommandId): Promise<CommandRecord | null> {
    const route = this.#workerRoute(workerId);
    const target = route ? this.#childConnection(route) : this.#connection(workerId);
    return target.getCommand ? target.getCommand(commandId) : null;
  }

  #streamCursor(cursor: StreamCursor | number): StreamCursor {
    if (typeof cursor !== "number") return cursor;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new RangeError("control cursor must be a non-negative integer");
    }
    return { ...this.catalog.feedCheckpoint(), controlCursor: cursor, native: {} };
  }

  #installChildConnection(connection: ChildHostConnection): void {
    const previous = this.#childPumps.get(connection.hostId);
    previous?.abort.abort();
    this.#childPumps.delete(connection.hostId);
    this.#childConnections.set(connection.hostId, connection);
    this.#onChildHostConnectionAttached?.(connection);
  }

  async #replaceChildPumpWithSnapshot(
    connection: ChildHostConnection,
    attachment: HostAttachment,
  ): Promise<void> {
    const hostId = connection.hostId;
    const current = this.#childPumpReplacements.get(hostId);
    if (
      current?.connection === connection &&
      current.attachmentId === attachment.attachmentId
    ) {
      return current.done;
    }
    const previous = current?.done ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(() =>
      this.#replaceChildPumpWithSnapshotNow(connection, attachment),
    );
    const replacement: ChildPumpReplacement = {
      connection,
      attachmentId: attachment.attachmentId,
      done: running,
    };
    this.#childPumpReplacements.set(hostId, replacement);
    try {
      await running;
    } finally {
      if (this.#childPumpReplacements.get(hostId) === replacement) {
        this.#childPumpReplacements.delete(hostId);
      }
    }
  }

  async #replaceChildPumpWithSnapshotNow(
    connection: ChildHostConnection,
    attachment: HostAttachment,
  ): Promise<void> {
    if (
      this.#closed ||
      this.#childConnections.get(connection.hostId) !== connection ||
      this.catalog.getAttachment(connection.hostId)?.attachmentId !== attachment.attachmentId
    ) {
      return;
    }
    const previous = this.#childPumps.get(connection.hostId);
    previous?.abort.abort();
    this.#childPumps.delete(connection.hostId);
    // Do not overlap aggregate iterators for one child. Concurrent lifecycle
    // reconciliation joins the same replacement above; replacement across a
    // connection/attachment epoch is serialized here. Previously every caller
    // could delete the same old pump and then install an untracked replacement,
    // leaking long-lived p2prpc streams.
    // The transport bridge also defers a pre-dispatch unsubscribe, so waiting
    // here is safe even while the replacement stream is still opening.
    await previous?.done.catch(() => undefined);
    const checkpoint = await this.#synchronizeChild(connection, attachment);
    if (
      this.#closed ||
      this.#childConnections.get(connection.hostId) !== connection ||
      this.catalog.getAttachment(connection.hostId)?.attachmentId !== attachment.attachmentId
    ) {
      return;
    }
    this.#startChildPump(connection, attachment, checkpoint);
    await this.#flushDownstreamMetadata(connection.hostId);
  }

  async #synchronizeChild(
    connection: ChildHostConnection,
    attachment: HostAttachment,
  ): Promise<FeedCheckpoint> {
    const pages: HostSubtreeSnapshotPage[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    let checkpoint: FeedCheckpoint | undefined;
    let capturedAt: string | undefined;
    for (;;) {
      const page = hostSubtreeSnapshotPageSchema.parse(
        await connection.readSubtreeSnapshot({
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
          ...(pageToken === undefined ? {} : { pageToken }),
          limit: 500,
        }),
      );
      if (
        page.rootHostId !== connection.hostId ||
        page.attachmentId !== attachment.attachmentId ||
        page.lineageId !== attachment.lineageId
      ) {
        throw new HostCoreError("FENCED", "child snapshot has another root or attachment");
      }
      if (
        checkpoint &&
        (checkpoint.feedId !== page.checkpoint.feedId ||
          checkpoint.controlCursor !== page.checkpoint.controlCursor)
      ) {
        throw new HostCoreError("CONFLICT", "child snapshot checkpoint changed during traversal");
      }
      if (capturedAt !== undefined && capturedAt !== page.capturedAt) {
        throw new HostCoreError("CONFLICT", "child snapshot changed during traversal");
      }
      checkpoint ??= page.checkpoint;
      capturedAt ??= page.capturedAt;
      pages.push(page);
      if (page.nextPageToken === null) break;
      if (seenTokens.has(page.nextPageToken)) {
        throw new HostCoreError("CONFLICT", "child snapshot returned a pagination cycle");
      }
      seenTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
    if (!checkpoint) throw new HostCoreError("CONFLICT", "child snapshot was empty");
    this.#validateChildSnapshot(connection, pages, checkpoint);

    await this.#serializeChildImport(connection.hostId, async () => {
      for (const page of pages) {
        this.catalog.importChildSnapshotPage(
          connection.hostId,
          attachment.attachmentId,
          page,
        );
      }
    });
    await this.#processQueuedMetadataFromChild(connection.hostId);
    return checkpoint;
  }

  #validateChildSnapshot(
    connection: ChildHostConnection,
    pages: readonly HostSubtreeSnapshotPage[],
    checkpoint: FeedCheckpoint,
  ): void {
    const hosts = pages.flatMap((page) => page.hosts);
    const workers = pages.flatMap((page) => page.workers);
    const sessions = pages.flatMap((page) => page.sessions);
    const interactions = pages.flatMap((page) => page.interactions);
    const operations = pages.flatMap((page) => page.metadataOperations);
    const root = hosts.find((host) => host.hostId === connection.hostId);
    if (!root || root.hostBootId !== connection.hostBootId || root.feedId !== checkpoint.feedId) {
      throw new HostCoreError("FENCED", "child snapshot root identity does not match its link");
    }
    this.#assertUnique(hosts.map((host) => host.hostId), "host");
    this.#assertUnique(workers.map((worker) => worker.workerId), "worker");
    this.#assertUnique(sessions.map((session) => session.sessionId), "session");
    this.#assertUnique(
      interactions.map((interaction) => interaction.interactionId),
      "interaction",
    );
    this.#assertUnique(
      operations.map((operation) => operation.operationId),
      "metadata operation",
    );
    const workerIds = new Set(workers.map((worker) => worker.workerId));
    for (const session of sessions) {
      const existingRoute = this.catalog.routeForWorker(session.workerId);
      if (
        !workerIds.has(session.workerId) &&
        existingRoute?.immediateChildHostId !== connection.hostId
      ) {
        throw new HostCoreError("FENCED", "child snapshot session has no worker in its subtree");
      }
    }
    const sessionIds = new Set(sessions.map((session) => session.sessionId));
    for (const interaction of interactions) {
      const existing = this.catalog.getSession(interaction.sessionId);
      const existingRoute = existing ? this.catalog.routeForWorker(existing.workerId) : null;
      if (
        !sessionIds.has(interaction.sessionId) &&
        existingRoute?.immediateChildHostId !== connection.hostId
      ) {
        throw new HostCoreError(
          "FENCED",
          "child snapshot interaction targets a session outside its subtree",
        );
      }
    }
    for (const operation of operations) {
      const existing = this.catalog.getSession(operation.sessionId);
      const existingRoute = existing ? this.catalog.routeForWorker(existing.workerId) : null;
      if (
        !sessionIds.has(operation.sessionId) &&
        existingRoute?.immediateChildHostId !== connection.hostId
      ) {
        throw new HostCoreError(
          "FENCED",
          "child snapshot metadata operation targets a session outside its subtree",
        );
      }
    }
  }

  #assertUnique(values: readonly string[], entity: string): void {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) {
        throw new HostCoreError("CONFLICT", `child snapshot contains duplicate ${entity} ${value}`);
      }
      seen.add(value);
    }
  }

  #startChildPump(
    connection: ChildHostConnection,
    attachment: HostAttachment,
    checkpoint: FeedCheckpoint,
  ): void {
    const abort = new AbortController();
    const pump: ChildPump = {
      connection,
      attachmentId: attachment.attachmentId,
      abort,
      done: Promise.resolve(),
    };
    pump.done = this.#runChildPump(connection, attachment, checkpoint, abort.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.#childPumps.get(connection.hostId) !== pump) return;
        this.#childPumps.delete(connection.hostId);
        if (
          !abort.signal.aborted &&
          !this.#closed &&
          this.#childConnections.get(connection.hostId) === connection
        ) {
          // A subscription may end while its authenticated peer remains
          // connected. Retain that reverse channel so the next child heartbeat
          // can establish a fresh snapshot barrier and restart the pump.
          this.catalog.markChildDisconnected(connection.hostId, connection.hostBootId);
        }
      });
    this.#childPumps.set(connection.hostId, pump);
  }

  async #runChildPump(
    connection: ChildHostConnection,
    attachment: HostAttachment,
    initialCheckpoint: FeedCheckpoint,
    signal: AbortSignal,
  ): Promise<void> {
    let checkpoint = initialCheckpoint;
    while (!signal.aborted) {
      let reset = false;
      const cursor: StreamCursor = { ...checkpoint, native: {} };
      for await (const item of connection.subscribeAggregate(cursor, signal)) {
        if (signal.aborted) return;
        if (item.kind === "streamReset") {
          reset = true;
          break;
        }
        if (item.kind === "heartbeat") {
          if (item.feedId !== checkpoint.feedId) {
            reset = true;
            break;
          }
          const childWasOnline =
            this.catalog.getHost(connection.hostId)?.presence === "online";
          this.catalog.heartbeatChild(
            connection.hostId,
            connection.hostBootId,
            attachment.attachmentId,
            attachment.lineageId,
          );
          if (!childWasOnline) {
            // A watchdog may have degraded the whole path. A heartbeat proves
            // only the immediate child; refresh its aggregate projection before
            // restoring any descendant reachability.
            reset = true;
            break;
          }
          continue;
        }
        if (item.kind === "control") {
          if (
            item.feedId !== checkpoint.feedId ||
            item.cursor !== checkpoint.controlCursor + 1
          ) {
            // A control cursor is meaningful only inside its feed. Missing or
            // replaced feed state is repaired from a fresh immutable barrier,
            // never by importing a discontinuous event or dropping topology.
            reset = true;
            break;
          }
          this.#validateChildControl(connection.hostId, item);
          const imported = await this.#serializeChildImport(connection.hostId, async () =>
            this.catalog.importChildControl(
              connection.hostId,
              attachment.attachmentId,
              item,
            ),
          );
          checkpoint = imported.checkpoint;
          if (item.change.type === "session.upsert") {
            // Importing the binding can synchronously apply deferred lifecycle
            // metadata and enqueue its terminal receipt in the catalog.
            await this.#flushDownstreamMetadata(connection.hostId);
          }
          if (
            item.change.type === "metadata.operation" &&
            item.change.operation.status === "queued"
          ) {
            const canonical = this.catalog.getMetadataOperation(
              item.change.operation.operationId,
            );
            if (canonical?.status === "queued") {
              await this.#processQueuedMetadataOperation(canonical);
            }
          }
          continue;
        }
        if (this.#childOwnsSession(connection.hostId, item.sessionId)) {
          if (item.kind === "native") {
            const session = this.catalog.getSession(item.sessionId);
            if (
              !session ||
              session.harness !== item.harness ||
              session.runtimeEpoch !== item.runtimeEpoch
            ) {
              continue;
            }
          }
          this.events.publish(item);
        }
      }
      if (signal.aborted) return;
      if (!reset) return;
      checkpoint = await this.#synchronizeChild(connection, attachment);
    }
  }

  #validateChildControl(childHostId: HostId, item: FeedControlItem): void {
    if (item.change.type !== "metadata.operation") return;
    const session = this.catalog.getSession(item.change.operation.sessionId);
    if (!session || !this.#childOwnsSession(childHostId, session.sessionId)) {
      throw new HostCoreError(
        "FENCED",
        "child metadata operation targets a session outside its subtree",
      );
    }
  }

  #childOwnsSession(childHostId: HostId, sessionId: SessionId): boolean {
    const session = this.catalog.getSession(sessionId);
    if (!session) return false;
    return this.catalog.routeForWorker(session.workerId)?.immediateChildHostId === childHostId;
  }

  async #serializeChildImport<T>(hostId: HostId, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#childImportTails.get(hostId) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const tail = running.then(
      () => undefined,
      () => undefined,
    );
    this.#childImportTails.set(hostId, tail);
    try {
      return await running;
    } finally {
      if (this.#childImportTails.get(hostId) === tail) {
        this.#childImportTails.delete(hostId);
      }
    }
  }

  async #processQueuedMetadataFromChild(childHostId: HostId): Promise<void> {
    const queued = this.catalog.listMetadataOperations({ statuses: ["queued"], limit: 10_000 });
    for (const operation of queued) {
      const session = this.catalog.getSession(operation.sessionId);
      if (
        session &&
        this.catalog.routeForWorker(session.workerId)?.immediateChildHostId === childHostId
      ) {
        await this.#processQueuedMetadataOperation(operation);
      }
    }
  }

  async #processQueuedMetadataOperation(
    operationInput: MetadataOperationRecord,
  ): Promise<MetadataOperationRecord> {
    const operation = metadataOperationRecordSchema.parse(operationInput);
    const session = this.catalog.getSession(operation.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "metadata session is not registered");
    if (session.metadataAuthority.hostId === this.catalog.localHost().hostId) {
      const settled = this.catalog.applyMetadataOperationAtAuthority(operation);
      this.#queueTerminalDownstream(settled);
      return settled;
    }
    this.catalog.recordQueuedMetadataOperation(operation);
    const [result] = await this.#flushMetadataUpstream([operation]);
    return result ?? operation;
  }

  async #flushMetadataUpstream(
    operations?: readonly MetadataOperationRecord[],
  ): Promise<MetadataOperationRecord[]> {
    const queued = operations ?? this.catalog.listMetadataOperations({
      statuses: ["queued"],
      limit: 1_000,
    });
    if (queued.length === 0 || !this.#metadataUpstream) return [...queued];
    try {
      return await this.#forwardMetadataUpstream(queued);
    } catch {
      return [...queued];
    }
  }

  async #forwardMetadataUpstream(
    operations: readonly MetadataOperationRecord[],
  ): Promise<MetadataOperationRecord[]> {
    if (!this.#metadataUpstream) return [...operations];
    const requested = new Map(operations.map((operation) => [operation.operationId, operation]));
    const responses = await this.#metadataUpstream.pushMetadataOutbox(operations);
    const settled = new Map<string, MetadataOperationRecord>();
    for (const responseInput of responses) {
      const response = metadataOperationRecordSchema.parse(responseInput);
      const original = requested.get(response.operationId);
      if (!original || !this.#sameJson(original.patch, response.patch)) {
        throw new HostCoreError("FENCED", "metadata authority returned an unrequested operation");
      }
      const stored = response.status === "queued"
        ? this.catalog.recordQueuedMetadataOperation(response)
        : this.catalog.settleMetadataOperation(response, {
            acceptAuthorityEpochFromParent: true,
          });
      settled.set(stored.operationId, stored);
      if (stored.status !== "queued") this.#queueTerminalDownstream(stored);
    }
    return operations.map(
      (operation) => settled.get(operation.operationId) ??
        this.catalog.getMetadataOperation(operation.operationId) ?? operation,
    );
  }

  #queueTerminalDownstream(operation: MetadataOperationRecord): void {
    if (operation.status === "queued") return;
    const session = this.catalog.getSession(operation.sessionId);
    if (!session) return;
    const route = this.catalog.routeForWorker(session.workerId);
    if (!route) {
      const worker = this.catalog.getWorker(session.workerId);
      if (
        worker?.ownerHostId === this.catalog.localHost().hostId &&
        this.catalog.enqueueWorkerMetadataReplication(session.workerId, operation)
      ) {
        void this.#flushWorkerMetadata(session.workerId);
      }
      return;
    }
    try {
      this.catalog.enqueueMetadataReplication(route.immediateChildHostId, operation);
    } catch {
      // The authority receipt is already committed. Never report the metadata
      // write as failed after that point; catalog startup repairs a missing
      // downstream row from the terminal ledger.
      return;
    }
    void this.#flushDownstreamMetadata(route.immediateChildHostId);
  }

  async #flushDownstreamMetadata(childHostId: HostId): Promise<void> {
    const connection = this.#childConnections.get(childHostId);
    if (!connection?.applyMetadata) return;
    for (const operation of this.catalog.pendingMetadataReplication(childHostId)) {
      let result: MetadataOperationRecord;
      try {
        result = metadataOperationRecordSchema.parse(
          await connection.applyMetadata(operation),
        );
      } catch {
        return;
      }
      if (
        result.operationId !== operation.operationId ||
        !this.#sameJson(result.patch, operation.patch) ||
        result.status === "queued"
      ) {
        return;
      }
      this.catalog.markMetadataReplicationDelivered(childHostId, operation.operationId);
    }
  }

  async #flushWorkerMetadata(workerId: WorkerId): Promise<void> {
    const connection = this.#connections.get(workerId);
    if (!connection?.applyMetadata) return;
    for (const operation of this.catalog.pendingWorkerMetadataReplication(workerId)) {
      let result: MetadataOperationRecord;
      try {
        result = metadataOperationRecordSchema.parse(
          await connection.applyMetadata(operation),
        );
      } catch {
        return;
      }
      if (
        result.operationId !== operation.operationId ||
        !this.#sameJson(result, operation) ||
        result.status === "queued"
      ) {
        return;
      }
      this.catalog.markWorkerMetadataReplicationDelivered(workerId, operation.operationId);
    }
  }

  #pruneSnapshotTraversals(): void {
    const now = Date.now();
    for (const [token, traversal] of this.#snapshotTraversals) {
      if (traversal.expiresAt <= now) this.#snapshotTraversals.delete(token);
    }
  }

  #snapshotHostsInTopologyOrder(): HostDescriptor[] {
    const hosts = this.catalog.listHosts();
    const localHostId = this.catalog.localHost().hostId;
    const local = hosts.find((host) => host.hostId === localHostId);
    if (!local) throw new HostCoreError("NOT_FOUND", "local host is missing from its catalog");

    const children = new Map<HostId, HostDescriptor[]>();
    for (const host of hosts) {
      if (host.hostId === localHostId || host.parentHostId === null) continue;
      const siblings = children.get(host.parentHostId) ?? [];
      siblings.push(host);
      children.set(host.parentHostId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((left, right) => left.hostId.localeCompare(right.hostId));
    }

    const ordered: HostDescriptor[] = [];
    const visited = new Set<HostId>();
    const queue = [local];
    for (let index = 0; index < queue.length; index += 1) {
      const host = queue[index]!;
      if (visited.has(host.hostId)) {
        throw new HostCoreError("CONFLICT", "catalog host topology contains a cycle");
      }
      visited.add(host.hostId);
      ordered.push(host);
      queue.push(...(children.get(host.hostId) ?? []));
    }
    if (visited.size !== hosts.length) {
      throw new HostCoreError(
        "CONFLICT",
        "catalog contains a host outside the local subtree",
      );
    }
    return ordered;
  }

  #sameJson(left: unknown, right: unknown): boolean {
    return (
      canonicalJson(jsonValueSchema.parse(left)) ===
      canonicalJson(jsonValueSchema.parse(right))
    );
  }

  #assertChildIngressIdentity(hostId: HostId, context: ChildHostIngressContext): void {
    if (context.authenticatedHostId && context.authenticatedHostId !== hostId) {
      throw new HostCoreError("FENCED", "authenticated child host does not match payload");
    }
    const child = this.catalog.getHost(hostId);
    if (
      child?.endpointId !== undefined &&
      context.endpointId !== undefined &&
      child.endpointId !== context.endpointId
    ) {
      throw new HostCoreError("FENCED", "child host is pinned to another transport endpoint");
    }
    if (context.endpointId) {
      const enrollment = this.catalog.peerEnrollment(context.endpointId);
      if (
        enrollment &&
        (enrollment.role !== "childHost" || enrollment.principalId !== hostId)
      ) {
        throw new HostCoreError("FENCED", "transport endpoint is enrolled as another principal");
      }
    }
  }

  #assertChildFence(
    fence: HostLinkFence,
    context: ChildHostIngressContext,
  ): HostAttachment {
    this.#assertChildIngressIdentity(fence.hostId, context);
    const child = this.catalog.getHost(fence.hostId);
    const attachment = this.catalog.getAttachment(fence.hostId);
    if (
      !child ||
      !attachment ||
      child.hostBootId !== fence.hostBootId ||
      attachment.attachmentId !== fence.attachmentId ||
      attachment.lineageId !== fence.lineageId
    ) {
      throw new HostCoreError("FENCED", "child host link fence is stale");
    }
    return attachment;
  }

  #assertParentFence(fence: HostLinkFence, context: HostPeerContext): void {
    const local = this.catalog.localHost();
    if (
      local.parentHostId === null ||
      local.attachmentId === null ||
      fence.hostId !== local.hostId ||
      fence.hostBootId !== local.hostBootId ||
      fence.attachmentId !== local.attachmentId ||
      fence.lineageId !== local.lineageId
    ) {
      throw new HostCoreError("FENCED", "parent call has a stale host link fence");
    }
    if (
      context.authenticatedHostId !== undefined &&
      context.authenticatedHostId !== local.parentHostId
    ) {
      throw new HostCoreError("FENCED", "authenticated caller is not this host's parent");
    }
    if (context.endpointId) {
      const enrollment = this.catalog.peerEnrollment(context.endpointId);
      if (
        enrollment &&
        (enrollment.role !== "parentHost" ||
          enrollment.principalId !== local.parentHostId)
      ) {
        throw new HostCoreError("FENCED", "transport endpoint is not enrolled as this parent");
      }
    }
  }

  #assertIngressIdentity(workerId: WorkerId, context: HostIngressContext): void {
    if (context.authenticatedWorkerId && context.authenticatedWorkerId !== workerId) {
      throw new HostCoreError("FENCED", "authenticated worker identity does not match payload");
    }
    if (context.endpointId) {
      const enrollment = this.catalog.peerEnrollment(context.endpointId);
      if (
        enrollment &&
        (enrollment.role !== "worker" || enrollment.principalId !== workerId)
      ) {
        throw new HostCoreError(
          "FENCED",
          "transport endpoint is enrolled as another role or worker",
        );
      }
    }
    const enrolled = this.catalog.getWorker(workerId);
    if (
      enrolled?.endpointId !== undefined &&
      context.endpointId !== undefined &&
      enrolled.endpointId !== context.endpointId
    ) {
      throw new HostCoreError(
        "FENCED",
        `worker ${workerId} is pinned to another transport endpoint`,
      );
    }
  }
}
