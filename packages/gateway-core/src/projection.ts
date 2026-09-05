import {
  assertImageResponseTarget,
  imageContract,
  type ImageAbortUploadResult,
  type ImageBeginUploadInput,
  type ImageDescriptor,
  type ImageLimits,
  type ImagePort,
  type ImageReadInput,
  type ImageReadResult,
  type ImageResolvePathInput,
  type ImageTarget,
  type ImageUploadIdInput,
  type ImageUploadState,
  type ImageWriteUploadInput,
} from "@arduano/agent-multiplex-protocol";
import { isDeepStrictEqual } from "node:util";

import {
  accessSnapshotSchema,
  accessStreamItemSchema,
  archiveRecordSchema,
  canonicalJson,
  canonicalProtocolRecordJson,
  newFeedId,
  sourceManifestSchema,
  sourceCoverageSnapshotSchema,
  toJsonValue,
  type AccessAttachInput,
  type AccessStreamItem,
  type ArchiveOperationId,
  type ArchiveRecord,
  type ArchiveRequest,
  type AuthorityRef,
  type CommandEnvelope,
  type CommandId,
  type CommandRecord,
  type ControlNodeDescriptor,
  type ControlNodeId,
  type FeedId,
  type Harness,
  type HarnessCatalogEntry,
  type InteractionRecord,
  type InventorySnapshot,
  type MetadataOperationRecord,
  type MetadataPatch,
  type OperationId,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeModel,
  launchListPageSchema,
  launchRecordSchema,
  sessionSearchPageSchema,
  type LaunchId,
  type LaunchListInput,
  type LaunchListPage,
  type LaunchProfileDescriptor,
  type LaunchProfileIdentity,
  type LaunchProviderId,
  type LaunchRecord,
  type LaunchRequest,
  type ResolveInteractionInput,
  type ResumeCommand,
  type RuntimeNodeDescriptor,
  type RuntimeNodeId,
  type SessionId,
  type SessionRecord,
  type SessionSearchInput,
  type SessionSearchPage,
  type SourceDiagnostic,
  type SourceId,
  type SourceManifest,
  type StopCommand,
  type StreamCursor,
  type TopologyDetachInput,
  type TopologyDetachmentReceipt,
  type TopologyForceDetachInput,
  terminalDescriptorSchema,
  terminalOpenResultSchema,
  terminalStreamItemSchema,
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
  type AuthorityPromoteInput,
  type AuthorityPromotionReceipt,
} from "@arduano/agent-multiplex-protocol";

export interface GatewaySourceSnapshot {
  readonly manifest: SourceManifest;
  readonly parentByControlNodeId: Readonly<Record<string, ControlNodeId | null>>;
  readonly controlNodes: readonly ControlNodeDescriptor[];
  readonly runtimeNodes: readonly RuntimeNodeDescriptor[];
  readonly sessions: readonly SessionRecord[];
  readonly interactions: readonly InteractionRecord[];
  readonly metadataOperations: readonly MetadataOperationRecord[];
}

export interface LaunchProfileQuery {
  readonly runtimeNodeId?: RuntimeNodeId;
  readonly providerId?: LaunchProviderId;
  readonly harness?: Harness;
}

/**
 * Transport-neutral control-node source. A p2prpc client, an in-process node,
 * or a test source can implement the same boundary. The gateway never accepts
 * a peer that identifies itself as another gateway.
 */
export interface ControlNodeSourceClient extends ImagePort {
  loadSnapshot(): Promise<GatewaySourceSnapshot>;
  watch(
    cursor: StreamCursor,
    signal?: AbortSignal,
  ): AsyncIterable<AccessStreamItem>;

  listHarnessCatalog?(runtimeNodeId?: RuntimeNodeId): Promise<HarnessCatalogEntry[]>;
  listModels(runtimeNodeId: RuntimeNodeId, harness: Harness): Promise<NativeModel[]>;
  listLaunchProfiles(query?: LaunchProfileQuery): Promise<LaunchProfileDescriptor[]>;
  listLaunchModels(
    runtimeNodeId: RuntimeNodeId,
    profile: LaunchProfileIdentity,
    harness: Harness,
  ): Promise<NativeModel[]>;
  createLaunch(request: LaunchRequest): Promise<LaunchRecord>;
  getLaunch(launchId: LaunchId): Promise<LaunchRecord | null>;
  listLaunches(query: LaunchListInput): Promise<LaunchListPage>;
  searchSessions(query: SessionSearchInput): Promise<SessionSearchPage>;
  getSession(sessionId: SessionId): Promise<SessionRecord | null>;
  refresh(runtimeNodeId: RuntimeNodeId): Promise<InventorySnapshot>;
  resume(command: ResumeCommand): Promise<CommandRecord>;
  stop(command: StopCommand): Promise<CommandRecord>;
  archive(request: ArchiveRequest): Promise<ArchiveRecord>;
  getArchive(archiveOperationId: ArchiveOperationId): Promise<ArchiveRecord | null>;
  execute(command: CommandEnvelope): Promise<CommandRecord>;
  readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult>;
  getTerminal?(input: TerminalGetInput): Promise<TerminalDescriptor | null>;
  openTerminal?(input: TerminalOpenInput): Promise<TerminalOpenResult>;
  attachTerminal?(input: TerminalAttachInput, signal?: AbortSignal): AsyncIterable<TerminalStreamItem>;
  acquireTerminalLease?(input: TerminalLeaseAcquireInput): Promise<TerminalLeaseAcquireResult>;
  renewTerminalLease?(input: TerminalLeaseRenewInput): Promise<TerminalLeaseRenewResult>;
  releaseTerminalLease?(input: TerminalLeaseReleaseInput): Promise<TerminalLeaseReleaseResult>;
  sendTerminalInput?(input: TerminalInput): Promise<TerminalInputResult>;
  terminateTerminal?(input: TerminalTerminateInput): Promise<TerminalDescriptor>;
  patchMetadata(patch: MetadataPatch): Promise<MetadataOperationRecord>;
  resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord>;
  getCommand(commandId: CommandId): Promise<CommandRecord | null>;
  detach(input: TopologyDetachInput): Promise<TopologyDetachmentReceipt>;
  forceDetach(input: TopologyForceDetachInput): Promise<TopologyDetachmentReceipt>;
  promote(input: AuthorityPromoteInput): Promise<AuthorityPromotionReceipt>;
}

export interface GatewaySourceDefinition {
  readonly sourceId: SourceId;
  readonly displayName: string;
  readonly endpointId: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly client: ControlNodeSourceClient;
}

type TerminalSourceClient = Required<Pick<
  ControlNodeSourceClient,
  | "getTerminal"
  | "openTerminal"
  | "attachTerminal"
  | "acquireTerminalLease"
  | "renewTerminalLease"
  | "releaseTerminalLease"
  | "sendTerminalInput"
  | "terminateTerminal"
>>;

interface SourceState {
  readonly definition: GatewaySourceDefinition;
  snapshot: GatewaySourceSnapshot | null;
  state: SourceDiagnostic["state"];
  selectedBySourceId: SourceId | undefined;
  reason: string | undefined;
  lastError: string | undefined;
  updatedAt: string;
  generation: number;
}

interface GatewaySubscriber {
  readonly queue: AsyncQueue<AccessStreamItem>;
  readonly sessions: ReadonlySet<SessionId> | null;
  readonly includeNative: boolean;
}

interface TerminalRouteFence {
  readonly sourceId: SourceId;
  readonly sourceControlNodeBootId: string;
  readonly sourceFeedId: FeedId;
  readonly runtimeNodeBootId: string;
  readonly sessionId: SessionId;
  readonly runtimeNodeId: RuntimeNodeId;
  readonly bindingRevision: number;
}

interface TerminalRouteSubscription {
  readonly fence: TerminalRouteFence;
  readonly controller: AbortController;
}

type PageCursorKind = "launches" | "sessions";

interface PageCursorState {
  readonly kind: PageCursorKind;
  readonly feedId: FeedId;
  readonly sourceIds: readonly SourceId[];
  readonly sourceIndex: number;
  readonly sourceCursor: string | undefined;
  readonly filterKey: string;
}

export type GatewayRoutingErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "OUTCOME_UNKNOWN"
  | "UNAUTHORIZED"
  | "UNSUPPORTED"
  | "INTERNAL";

export class GatewayRoutingError extends Error {
  public constructor(
    public readonly code: GatewayRoutingErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayRoutingError";
  }
}

class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  #closed = false;
  #failure: unknown;

  public constructor(
    private readonly capacity: number,
    private readonly onClose: () => void,
  ) {}

  public get closed(): boolean {
    return this.#closed;
  }

  public push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (this.#values.length < this.capacity) this.#values.push(value);
    else this.close(new GatewaySubscriberOverflowError(this.capacity));
  }

  public close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    this.#values.splice(0);
    for (const waiter of this.#waiters.splice(0)) {
      if (error !== undefined) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
    this.onClose();
  }

  public next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

export class GatewaySubscriberOverflowError extends Error {
  public constructor(public readonly capacity: number) {
    super(
      `access-gateway subscriber exceeded its ${capacity}-item buffer; reconnect from the last committed cursor`,
    );
    this.name = "GatewaySubscriberOverflowError";
  }
}

/**
 * Zero-authority, multi-source read projection and command router. Snapshots
 * stay warm even while suppressed, so failover is a selection change rather
 * than a cold reconnect. No domain record is ever authored here.
 */
export class AccessGatewayProjection {
  readonly #sources = new Map<SourceId, SourceState>();
  readonly #selected = new Set<SourceId>();
  readonly #controlNodeOwners = new Map<ControlNodeId, SourceId>();
  readonly #runtimeNodeOwners = new Map<RuntimeNodeId, SourceId>();
  readonly #sessionOwners = new Map<SessionId, SourceId>();
  readonly #interactionOwners = new Map<string, SourceId>();
  readonly #commandOwners = new Map<CommandId, SourceId>();
  readonly #launchOwners = new Map<LaunchId, SourceId>();
  readonly #archiveOwners = new Map<ArchiveOperationId, SourceId>();
  readonly #sessionLookupHints = new Map<SessionId, SourceId>();
  readonly #sessionLookupRecords = new Map<SessionId, SessionRecord>();
  readonly #pageCursors = new Map<string, PageCursorState>();
  readonly #terminalRouteSubscriptions = new Set<TerminalRouteSubscription>();
  readonly #subscribers = new Set<GatewaySubscriber>();
  readonly #sourceSubscribers = new Set<AsyncQueue<SourceDiagnostic>>();
  readonly #nativeSeen = new Map<SessionId, { runtimeEpoch: string; sequence: number }>();
  readonly #nativeJournal: Array<Extract<AccessStreamItem, { kind: "native" }>> = [];
  readonly #journal: Array<Extract<AccessStreamItem, { kind: "control" }>> = [];
  #feedId = newFeedId();
  #controlCursor = 0;

  static readonly maximumJournalItems = 4_096;
  static readonly maximumNativeJournalItems = 4_096;
  static readonly maximumSubscriberItems = 8_192;
  static readonly maximumCommandOwnerHints = 4_096;
  static readonly maximumOperationOwnerHints = 4_096;
  static readonly maximumPageCursors = 4_096;

  public constructor(
    definitions: readonly GatewaySourceDefinition[],
    private readonly now: () => Date = () => new Date(),
    private readonly nativeJournalCapacity = AccessGatewayProjection.maximumNativeJournalItems,
  ) {
    if (!Number.isSafeInteger(nativeJournalCapacity) || nativeJournalCapacity < 1) {
      throw new RangeError("gateway native journal capacity must be a positive integer");
    }
    for (const definition of definitions) {
      if (this.#sources.has(definition.sourceId)) {
        throw new TypeError(`duplicate gateway source ID ${definition.sourceId}`);
      }
      if (!definition.displayName || !definition.endpointId) {
        throw new TypeError("gateway sources require a display name and pinned endpoint ID");
      }
      this.#sources.set(definition.sourceId, {
        definition: Object.freeze({ ...definition }),
        snapshot: null,
        state: definition.enabled === false ? "disabled" : "connecting",
        selectedBySourceId: undefined,
        reason: undefined,
        lastError: undefined,
        updatedAt: this.#timestamp(),
        generation: 0,
      });
    }
  }

  public feedId(): FeedId {
    return this.#feedId;
  }

  public diagnostics(): SourceDiagnostic[] {
    return [...this.#sources.values()]
      .map((source) => ({
        sourceId: source.definition.sourceId,
        displayName: source.definition.displayName,
        endpointId: source.definition.endpointId,
        state: source.state,
        manifest: source.snapshot?.manifest ?? null,
        ...(source.selectedBySourceId === undefined
          ? {}
          : { selectedBySourceId: source.selectedBySourceId }),
        ...(source.reason === undefined ? {} : { reason: source.reason }),
        ...(source.lastError === undefined ? {} : { lastError: source.lastError }),
        updatedAt: source.updatedAt,
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  }

  /** Load or replace one complete, internally consistent source projection. */
  public async refreshSource(sourceId: SourceId): Promise<void> {
    const source = this.#source(sourceId);
    if (source.definition.enabled === false) return;
    const previousSelection = this.#selectionSignature();
    const failoverReference = this.#selected.has(sourceId)
      ? source.snapshot
      : null;
    source.state = "synchronizing";
    source.updatedAt = this.#timestamp();
    try {
      const snapshot = await source.definition.client.loadSnapshot();
      const manifest = sourceManifestSchema.parse(snapshot.manifest);
      this.#validateSnapshot({ ...snapshot, manifest }, source);
      source.snapshot = Object.freeze({ ...snapshot, manifest });
      source.generation += 1;
      source.lastError = undefined;
      source.reason = undefined;
      this.#reselect(previousSelection);
    } catch (cause) {
      source.state = "unavailable";
      source.selectedBySourceId = undefined;
      source.lastError = cause instanceof Error ? cause.message : String(cause);
      source.updatedAt = this.#timestamp();
      this.#reselect(previousSelection, failoverReference);
      throw cause;
    }
  }

  /**
   * Keep one source warm until cancelled. A failed stream is never interpreted
   * as detach or promotion; it only changes source availability and reconnects.
   */
  public async synchronizeSource(
    sourceId: SourceId,
    signal: AbortSignal,
    options: { minimumBackoffMs?: number; maximumBackoffMs?: number } = {},
  ): Promise<void> {
    const minimumBackoffMs = options.minimumBackoffMs ?? 250;
    const maximumBackoffMs = options.maximumBackoffMs ?? 10_000;
    if (
      !Number.isSafeInteger(minimumBackoffMs) || minimumBackoffMs < 1 ||
      !Number.isSafeInteger(maximumBackoffMs) || maximumBackoffMs < minimumBackoffMs
    ) throw new RangeError("invalid source reconnect backoff");
    let delayMs = minimumBackoffMs;
    while (!signal.aborted) {
      try {
        await this.refreshSource(sourceId);
        delayMs = minimumBackoffMs;
        const source = this.#source(sourceId);
        const snapshot = source.snapshot!;
        const generation = source.generation;
        const cursor: StreamCursor = {
          feedId: snapshot.manifest.feedId,
          controlCursor: snapshot.manifest.controlCursor,
          native: {},
        };
        for await (const item of source.definition.client.watch(cursor, signal)) {
          if (signal.aborted || source.generation !== generation) break;
          if (item.kind === "streamReset") {
            await this.refreshSource(sourceId);
            break;
          }
          this.ingest(sourceId, item);
          if (item.kind === "control" && requiresSourceSnapshot(item)) {
            await this.refreshSource(sourceId);
            break;
          }
        }
        if (signal.aborted) return;
        this.markUnavailable(sourceId, new Error("source stream completed"));
      } catch (cause) {
        if (signal.aborted) return;
        this.markUnavailable(sourceId, cause);
      }
      await abortableDelay(delayMs, signal);
      delayMs = Math.min(maximumBackoffMs, delayMs * 2);
    }
  }

  public async refreshAll(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      [...this.#sources.values()]
        .filter((source) => source.definition.enabled !== false)
        .map((source) => this.refreshSource(source.definition.sourceId)),
    );
  }

  /** A transport disconnect changes availability only; it never changes authority. */
  public markUnavailable(sourceId: SourceId, cause?: unknown): void {
    const source = this.#source(sourceId);
    if (source.state === "unavailable") {
      source.lastError = cause === undefined
        ? source.lastError ?? "source disconnected"
        : cause instanceof Error ? cause.message : String(cause);
      source.updatedAt = this.#timestamp();
      this.#broadcastDiagnostics();
      return;
    }
    const failoverReference = this.#selected.has(sourceId)
      ? source.snapshot
      : null;
    source.state = "unavailable";
    source.selectedBySourceId = undefined;
    source.lastError = cause === undefined
      ? "source disconnected"
      : cause instanceof Error ? cause.message : String(cause);
    source.updatedAt = this.#timestamp();
    this.#reselect(undefined, failoverReference);
  }

  public detach(input: TopologyDetachInput): Promise<TopologyDetachmentReceipt> {
    const owner = this.#ownerForControlNode(input.childControlNodeId);
    this.#assertAuthority(owner, input.expectedAuthority);
    return this.#mutate(owner, `detach control node ${input.childControlNodeId}`, () => owner.definition.client.detach(input));
  }

  public forceDetach(input: TopologyForceDetachInput): Promise<TopologyDetachmentReceipt> {
    const owner = this.#ownerForControlNode(input.controlNodeId);
    this.#assertAuthority(owner, input.expectedAuthority);
    return this.#mutate(owner, "forced topology detach", () => owner.definition.client.forceDetach(input));
  }

  public promote(input: AuthorityPromoteInput): Promise<AuthorityPromotionReceipt> {
    const owner = this.#ownerForControlNode(input.controlNodeId);
    this.#assertAuthority(owner, input.expectedAuthority);
    return this.#mutate(owner, "authority promotion", () => owner.definition.client.promote(input));
  }

  public listControlNodes(): ControlNodeDescriptor[] {
    return this.#union("controlNodes", (record) => record.controlNodeId);
  }

  public getControlNode(id: ControlNodeId): ControlNodeDescriptor | null {
    return this.#recordForOwner(this.#controlNodeOwners.get(id), "controlNodes", (x) => x.controlNodeId === id);
  }

  public listRuntimeNodes(): RuntimeNodeDescriptor[] {
    return this.#union("runtimeNodes", (record) => record.runtimeNodeId);
  }

  public listSessions(): SessionRecord[] {
    return this.#union("sessions", (record) => record.sessionId);
  }

  public async getSession(id: SessionId): Promise<SessionRecord | null> {
    const snapshotOwner = this.#sessionOwners.get(id);
    const local = this.#recordForOwner(
      snapshotOwner,
      "sessions",
      (record) => record.sessionId === id,
    );
    if (local !== null) return local;
    const record = await this.#lookupOperation(
      id,
      this.#sessionLookupHints,
      (client) => client.getSession(id),
      "session",
    );
    if (record !== null) {
      const owner = this.#sessionLookupHints.get(id);
      if (owner !== undefined) this.#assertSessionSearchOwner(owner, record);
      this.#rememberOwner(this.#sessionLookupRecords, id, record);
    }
    return record;
  }

  public listInteractions(): InteractionRecord[] {
    return this.#union("interactions", (record) => record.interactionId);
  }

  public listMetadataOperations(): MetadataOperationRecord[] {
    return this.#union("metadataOperations", (record) => record.operationId);
  }

  public getMetadataOperation(id: OperationId): MetadataOperationRecord | null {
    const records = this.listMetadataOperations();
    return records.find((record) => record.operationId === id) ?? null;
  }

  public async listHarnessCatalog(
    runtimeNodeId?: RuntimeNodeId,
  ): Promise<HarnessCatalogEntry[]> {
    if (runtimeNodeId !== undefined) {
      const owner = this.#ownerForRuntime(runtimeNodeId);
      if (owner.definition.client.listHarnessCatalog) {
        return owner.definition.client.listHarnessCatalog(runtimeNodeId);
      }
      return this.#runtimeNodeRecord(runtimeNodeId).harnesses;
    }
    const catalogs = await Promise.all(
      [...this.#selected].map(async (sourceId) => {
        const source = this.#source(sourceId);
        if (source.definition.client.listHarnessCatalog) {
          return source.definition.client.listHarnessCatalog();
        }
        return source.snapshot!.runtimeNodes.flatMap((node) => node.harnesses);
      }),
    );
    const byIdentity = new Map<string, HarnessCatalogEntry>();
    for (const entry of catalogs.flat()) {
      byIdentity.set(`${entry.harness}\0${entry.adapterScopeId}`, entry);
    }
    return [...byIdentity.values()].sort((left, right) =>
      `${left.harness}\0${left.adapterScopeId}`.localeCompare(
        `${right.harness}\0${right.adapterScopeId}`,
      ),
    );
  }

  public listModels(runtimeNodeId: RuntimeNodeId, harness: Harness): Promise<NativeModel[]> {
    return this.#ownerForRuntime(runtimeNodeId).definition.client.listModels(runtimeNodeId, harness);
  }

  public async listLaunchProfiles(
    query: LaunchProfileQuery = {},
  ): Promise<LaunchProfileDescriptor[]> {
    if (query.runtimeNodeId !== undefined) {
      const owner = this.#ownerForRuntime(query.runtimeNodeId);
      return owner.definition.client.listLaunchProfiles(query);
    }
    const catalogs = await Promise.all(
      this.#selectedSourceIds().map((sourceId) =>
        this.#source(sourceId).definition.client.listLaunchProfiles(query)),
    );
    const byIdentity = new Map<string, LaunchProfileDescriptor>();
    for (const descriptor of catalogs.flat()) {
      const key = launchProfileKey(descriptor);
      const existing = byIdentity.get(key);
      if (existing !== undefined && !sameProtocolRecord(existing, descriptor)) {
        throw new GatewayRoutingError(
          "CONFLICT",
          `selected sources advertise conflicting launch profile ${descriptor.providerId}/${descriptor.profileId}`,
        );
      }
      byIdentity.set(key, descriptor);
    }
    return [...byIdentity.values()].sort((left, right) =>
      launchProfileKey(left).localeCompare(launchProfileKey(right)));
  }

  public listLaunchModels(
    runtimeNodeId: RuntimeNodeId,
    profile: LaunchProfileIdentity,
    harness: Harness,
  ): Promise<NativeModel[]> {
    return this.#ownerForRuntime(runtimeNodeId).definition.client
      .listLaunchModels(runtimeNodeId, profile, harness);
  }

  public refresh(runtimeNodeId: RuntimeNodeId): Promise<InventorySnapshot> {
    return this.#mutate(
      this.#ownerForRuntime(runtimeNodeId),
      `refresh runtime node ${runtimeNodeId}`,
      () => this.#ownerForRuntime(runtimeNodeId).definition.client.refresh(runtimeNodeId),
    );
  }

  public async createLaunch(request: LaunchRequest): Promise<LaunchRecord> {
    const owner = this.#ownerForRuntime(request.runtimeNodeId);
    this.#assertAdvertisedLaunchProfile(request);
    this.#rememberOwner(
      this.#launchOwners,
      request.launchId,
      owner.definition.sourceId,
    );
    const record = launchRecordSchema.parse(await this.#mutate(
      owner,
      `launch ${request.launchId}`,
      () => owner.definition.client.createLaunch(request),
    ));
    if (!sameLaunchRequest(record, request)) {
      throw new GatewayRoutingError(
        "CONFLICT",
        `source returned a launch record for another request`,
      );
    }
    this.#assertLaunchSource(owner.definition.sourceId, record);
    return record;
  }

  public async getLaunch(launchId: LaunchId): Promise<LaunchRecord | null> {
    const record = await this.#lookupOperation(
      launchId,
      this.#launchOwners,
      (client) => client.getLaunch(launchId),
      "launch",
    );
    const owner = this.#launchOwners.get(launchId);
    if (record !== null && owner !== undefined) this.#assertLaunchSource(owner, record);
    return record;
  }

  public async listLaunches(query: LaunchListInput): Promise<LaunchListPage> {
    const sources = query.runtimeNodeId === undefined
      ? this.#selectedSourceIds()
      : [this.#ownerForRuntime(query.runtimeNodeId).definition.sourceId];
    const filterKey = paginationFilterKey(query);
    const sourceQuery: LaunchListInput = { ...query };
    delete sourceQuery.cursor;
    const state = this.#readPageCursor("launches", query.cursor, sources, filterKey);
    for (let sourceIndex = state.sourceIndex; sourceIndex < sources.length; sourceIndex += 1) {
      const sourceId = sources[sourceIndex]!;
      const sourceCursor = sourceIndex === state.sourceIndex
        ? state.sourceCursor
        : undefined;
      const page = launchListPageSchema.parse(
        await this.#source(sourceId).definition.client.listLaunches({
          ...sourceQuery,
          ...(sourceCursor === undefined ? {} : { cursor: sourceCursor }),
        }),
      );
      for (const launch of page.launches) {
        this.#assertLaunchSource(sourceId, launch);
        this.#rememberOwner(this.#launchOwners, launch.launchId, sourceId);
      }
      const next = page.nextCursor !== null
        ? this.#newPageCursor({
            kind: "launches",
            feedId: this.#feedId,
            sourceIds: sources,
            sourceIndex,
            sourceCursor: page.nextCursor,
            filterKey,
          })
        : sourceIndex + 1 < sources.length
          ? this.#newPageCursor({
              kind: "launches",
              feedId: this.#feedId,
              sourceIds: sources,
              sourceIndex: sourceIndex + 1,
              sourceCursor: undefined,
              filterKey,
            })
          : null;
      if (page.launches.length > 0 || page.nextCursor !== null) {
        return { launches: page.launches, nextCursor: next };
      }
    }
    return { launches: [], nextCursor: null };
  }

  public async searchSessions(query: SessionSearchInput): Promise<SessionSearchPage> {
    const sources = this.#sessionSearchSourceIds(query);
    const filterKey = paginationFilterKey(query);
    const sourceQuery: SessionSearchInput = { ...query };
    delete sourceQuery.cursor;
    const state = this.#readPageCursor("sessions", query.cursor, sources, filterKey);
    for (let sourceIndex = state.sourceIndex; sourceIndex < sources.length; sourceIndex += 1) {
      const sourceId = sources[sourceIndex]!;
      const sourceCursor = sourceIndex === state.sourceIndex
        ? state.sourceCursor
        : undefined;
      const scopedQuery = sourceQuery.runtimeNodeIds === undefined
        ? sourceQuery
        : {
            ...sourceQuery,
            runtimeNodeIds: sourceQuery.runtimeNodeIds.filter(
              (runtimeNodeId) => this.#runtimeNodeOwners.get(runtimeNodeId) === sourceId,
            ),
          };
      const page = sessionSearchPageSchema.parse(
        await this.#source(sourceId).definition.client.searchSessions({
          ...scopedQuery,
          ...(sourceCursor === undefined ? {} : { cursor: sourceCursor }),
        }),
      );
      for (const session of page.sessions) {
        this.#assertSessionSearchOwner(sourceId, session);
        this.#rememberOwner(this.#sessionLookupHints, session.sessionId, sourceId);
      }
      const next = page.nextCursor !== null
        ? this.#newPageCursor({
            kind: "sessions",
            feedId: this.#feedId,
            sourceIds: sources,
            sourceIndex,
            sourceCursor: page.nextCursor,
            filterKey,
          })
        : sourceIndex + 1 < sources.length
          ? this.#newPageCursor({
              kind: "sessions",
              feedId: this.#feedId,
              sourceIds: sources,
              sourceIndex: sourceIndex + 1,
              sourceCursor: undefined,
              filterKey,
            })
          : null;
      if (page.sessions.length > 0 || page.nextCursor !== null) {
        return { sessions: page.sessions, nextCursor: next };
      }
    }
    return { sessions: [], nextCursor: null };
  }

  public resume(command: ResumeCommand): Promise<CommandRecord> {
    const owner = this.#ownerForSessionBinding(command);
    this.#rememberCommandOwner(command.commandId, owner.definition.sourceId);
    return this.#mutate(owner, `resume command ${command.commandId}`, () => owner.definition.client.resume(command));
  }

  public stop(command: StopCommand): Promise<CommandRecord> {
    const owner = this.#ownerForSessionBinding(command);
    this.#rememberCommandOwner(command.commandId, owner.definition.sourceId);
    return this.#mutate(owner, `stop command ${command.commandId}`, () =>
      owner.definition.client.stop(command));
  }

  public async archive(request: ArchiveRequest): Promise<ArchiveRecord> {
    const owner = this.#ownerForSessionBinding(request);
    this.#assertAuthority(owner, request.expectedAuthority);
    this.#rememberOwner(
      this.#archiveOwners,
      request.archiveOperationId,
      owner.definition.sourceId,
    );
    const record = archiveRecordSchema.parse(await this.#mutate(
      owner,
      `archive operation ${request.archiveOperationId}`,
      () => owner.definition.client.archive(request),
    ));
    if (!sameArchiveRequest(record, request)) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "source returned an archive record for another request",
      );
    }
    this.#assertArchiveSource(owner.definition.sourceId, record);
    return record;
  }

  public async getArchive(
    archiveOperationId: ArchiveOperationId,
  ): Promise<ArchiveRecord | null> {
    const record = await this.#lookupOperation(
      archiveOperationId,
      this.#archiveOwners,
      (client) => client.getArchive(archiveOperationId),
      "archive operation",
    );
    const owner = this.#archiveOwners.get(archiveOperationId);
    if (record !== null && owner !== undefined) this.#assertArchiveSource(owner, record);
    return record;
  }

  public execute(command: CommandEnvelope): Promise<CommandRecord> {
    const owner = this.#ownerForSession(command.sessionId);
    if (owner.definition.sourceId !== this.#ownerForRuntime(command.runtimeNodeId).definition.sourceId) {
      throw new GatewayRoutingError("CONFLICT", "session and runtime-node ownership disagree");
    }
    this.#rememberCommandOwner(command.commandId, owner.definition.sourceId);
    return this.#mutate(owner, `agent command ${command.commandId}`, () => owner.definition.client.execute(command));
  }

  public readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult> {
    return this.#ownerForSession(sessionId).definition.client.readNativeHistory(sessionId, request);
  }

  public beginImageUpload(input: ImageBeginUploadInput): Promise<ImageUploadState> {
    const request = imageContract.beginUpload.input.parse(input);
    return this.#routeImage(request, (owner) => owner.beginImageUpload(request), "beginUpload")
      .then((result) => imageContract.beginUpload.output.parse(result));
  }

  public writeImageUpload(input: ImageWriteUploadInput): Promise<ImageUploadState> {
    const request = imageContract.writeUpload.input.parse(input);
    return this.#routeImage(request, (owner) => owner.writeImageUpload(request), "writeUpload")
      .then((result) => imageContract.writeUpload.output.parse(result));
  }

  public commitImageUpload(input: ImageUploadIdInput): Promise<ImageDescriptor> {
    const request = imageContract.commitUpload.input.parse(input);
    return this.#routeImage(request, (owner) => owner.commitImageUpload(request), "commitUpload")
      .then((result) => imageContract.commitUpload.output.parse(result));
  }

  public abortImageUpload(input: ImageUploadIdInput): Promise<ImageAbortUploadResult> {
    const request = imageContract.abortUpload.input.parse(input);
    return this.#routeImage(request, (owner) => owner.abortImageUpload(request), "abortUpload")
      .then((result) => imageContract.abortUpload.output.parse(result));
  }

  public resolveImagePath(input: ImageResolvePathInput): Promise<ImageDescriptor> {
    const request = imageContract.resolvePath.input.parse(input);
    return this.#routeImage(request, (owner) => owner.resolveImagePath(request), "resolvePath")
      .then((result) => imageContract.resolvePath.output.parse(result));
  }

  public readImage(input: ImageReadInput): Promise<ImageReadResult> {
    const request = imageContract.read.input.parse(input);
    return this.#routeImage(request, (owner) => owner.readImage(request))
      .then((result) => imageContract.read.output.parse(result));
  }

  public imageLimits(input: ImageTarget): Promise<ImageLimits> {
    const request = imageContract.limits.input.parse(input);
    return this.#routeImage(request, (owner) => owner.imageLimits(request))
      .then((result) => imageContract.limits.output.parse(result));
  }

  async #routeImage<T>(
    input: ImageTarget,
    operation: (owner: ImagePort) => Promise<T>,
    mutation?: string,
  ): Promise<T> {
    const owner = this.#ownerForSessionBinding(input);
    const feedId = this.#feedId;
    const sourceBootId = owner.snapshot!.manifest.sourceControlNodeBootId;
    const sourceFeedId = owner.snapshot!.manifest.feedId;
    const assertCurrent = () => {
      const snapshot = owner.snapshot;
      const session = snapshot?.sessions.find((candidate) => candidate.sessionId === input.sessionId);
      const runtime = snapshot?.runtimeNodes.find((candidate) => candidate.runtimeNodeId === input.runtimeNodeId);
      if (this.#feedId !== feedId || this.#ownerForSessionBinding(input) !== owner ||
        snapshot?.manifest.sourceControlNodeBootId !== sourceBootId || snapshot.manifest.feedId !== sourceFeedId ||
        session?.catalogState !== "open" || runtime?.runtimeNodeBootId !== input.runtimeNodeBootId) {
        throw new GatewayRoutingError("CONFLICT", "image source or runtime binding changed during the request");
      }
    };
    assertCurrent();
    const dispatch = () => operation(owner.definition.client);
    const result = mutation === undefined
      ? await dispatch()
      : await this.#mutate(owner, `image ${mutation}`, dispatch);
    try { assertImageResponseTarget(input, result); }
    catch (cause) { throw new GatewayRoutingError("CONFLICT", "image response escaped the requested target", undefined, { cause }); }
    assertCurrent();
    return result;
  }

  public async getTerminal(input: TerminalGetInput): Promise<TerminalDescriptor | null> {
    const route = this.#terminalRoute(input);
    const result = terminalDescriptorSchema.nullable().parse(
      await route.client.getTerminal(input),
    );
    this.#assertTerminalRouteFence(route.fence);
    if (result !== null) this.#assertTerminalDescriptor(route.fence, result);
    return result;
  }

  public async openTerminal(input: TerminalOpenInput): Promise<TerminalOpenResult> {
    const route = this.#terminalRoute(input, true);
    const result = terminalOpenResultSchema.parse(await this.#mutate(
      route.source,
      `open terminal for session ${input.sessionId}`,
      () => route.client.openTerminal(input),
    ));
    this.#assertTerminalRouteFence(route.fence);
    this.#assertTerminalDescriptor(route.fence, result.terminal);
    return result;
  }

  public attachTerminal(
    input: TerminalAttachInput,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalStreamItem> {
    const route = this.#terminalRoute(input);
    return this.#guardTerminalSourceStream(route, input, signal);
  }

  public acquireTerminalLease(
    input: TerminalLeaseAcquireInput,
  ): Promise<TerminalLeaseAcquireResult> {
    return this.#terminalMutation(input, "acquire terminal lease", (client) =>
      client.acquireTerminalLease(input));
  }

  public renewTerminalLease(
    input: TerminalLeaseRenewInput,
  ): Promise<TerminalLeaseRenewResult> {
    return this.#terminalMutation(input, "renew terminal lease", (client) =>
      client.renewTerminalLease(input));
  }

  public releaseTerminalLease(
    input: TerminalLeaseReleaseInput,
  ): Promise<TerminalLeaseReleaseResult> {
    return this.#terminalMutation(input, "release terminal lease", (client) =>
      client.releaseTerminalLease(input));
  }

  public sendTerminalInput(input: TerminalInput): Promise<TerminalInputResult> {
    return this.#terminalMutation(input, "send terminal input", (client) =>
      client.sendTerminalInput(input));
  }

  public async terminateTerminal(input: TerminalTerminateInput): Promise<TerminalDescriptor> {
    const route = this.#terminalRoute(input);
    const descriptor = terminalDescriptorSchema.parse(await this.#mutate(
      route.source,
      "terminate terminal",
      () => route.client.terminateTerminal(input),
    ));
    this.#assertTerminalRouteFence(route.fence);
    this.#assertTerminalDescriptor(route.fence, descriptor, {
      terminalId: input.terminalId,
    });
    return descriptor;
  }

  public patchMetadata(patch: MetadataPatch): Promise<MetadataOperationRecord> {
    const owner = this.#ownerForSession(patch.sessionId);
    this.#assertAuthority(owner, patch.expectedAuthority);
    return this.#mutate(owner, `metadata operation ${patch.operationId}`, () => owner.definition.client.patchMetadata(patch));
  }

  public resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord> {
    const sourceId = this.#interactionOwners.get(input.interactionId);
    const owner = sourceId === undefined ? this.#ownerForSession(input.sessionId) : this.#source(sourceId);
    return this.#mutate(owner, `interaction ${input.interactionId}`, () => owner.definition.client.resolveInteraction(input));
  }

  /** Recovery is read-only. It may fan out, but conflicting duplicate records fail closed. */
  public async getCommand(commandId: CommandId): Promise<CommandRecord | null> {
    const known = this.#commandOwners.get(commandId);
    if (known !== undefined) return this.#source(known).definition.client.getCommand(commandId);
    const settled = await Promise.allSettled(
      [...this.#selected].map((sourceId) => this.#source(sourceId).definition.client.getCommand(commandId)),
    );
    const records = settled.flatMap((result) =>
      result.status === "fulfilled" && result.value !== null ? [result.value] : [],
    );
    if (records.length === 0) return null;
    const canonical = JSON.stringify(records[0]);
    if (records.some((record) => JSON.stringify(record) !== canonical)) {
      throw new GatewayRoutingError("CONFLICT", `sources returned conflicting command ${commandId}`);
    }
    return records[0] ?? null;
  }

  /** Accept a source event only while that exact source owns its projection. */
  public ingest(sourceId: SourceId, input: AccessStreamItem): boolean {
    const source = this.#source(sourceId);
    if (source.snapshot === null) {
      throw new GatewayRoutingError("UNAVAILABLE", `source ${sourceId} has no synchronized snapshot`);
    }
    const item = accessStreamItemSchema.parse(input);
    const previousControlCursor = source.snapshot.manifest.controlCursor;
    this.#validateSourceItem(source, item);
    if (item.kind === "control") this.#applySourceControl(source, item);
    if (item.kind === "heartbeat") {
      if (item.controlCursor > source.snapshot.manifest.controlCursor) {
        throw new GatewayRoutingError("CONFLICT", `source ${sourceId} heartbeat skipped control events`);
      }
      if (!this.#selected.has(sourceId)) return false;
      this.#broadcast(this.#heartbeat());
      return true;
    }
    if (item.kind === "streamReset") return false;
    if (item.kind === "control" && item.cursor <= previousControlCursor) return false;
    if (!this.#selected.has(sourceId)) return false;
    if (item.kind === "native" || item.kind === "nativeGap") {
      if (this.#sessionOwners.get(item.sessionId) !== sourceId) return false;
    }
    if (item.kind === "native") {
      const previous = this.#nativeSeen.get(item.sessionId);
      if (
        previous?.runtimeEpoch === item.runtimeEpoch &&
        item.sequence <= previous.sequence
      ) return false;
      if (previous !== undefined && previous.runtimeEpoch !== item.runtimeEpoch) {
        this.#removeNativeSession(item.sessionId);
      }
      this.#nativeSeen.set(item.sessionId, {
        runtimeEpoch: item.runtimeEpoch,
        sequence: item.sequence,
      });
      this.#nativeJournal.push(item);
      if (this.#nativeJournal.length > this.nativeJournalCapacity) {
        this.#nativeJournal.splice(
          0,
          this.#nativeJournal.length - this.nativeJournalCapacity,
        );
      }
      this.#broadcast(item);
      return true;
    }
    if (item.kind === "nativeGap") {
      this.#broadcast(item);
      return true;
    }
    if (item.kind === "control") {
      this.#controlCursor += 1;
      const projected = {
        ...item,
        feedId: this.#feedId,
        cursor: this.#controlCursor,
      } satisfies Extract<AccessStreamItem, { kind: "control" }>;
      this.#journal.push(projected);
      while (this.#journal.length > AccessGatewayProjection.maximumJournalItems) {
        this.#journal.shift();
      }
      this.#broadcast(projected);
      return true;
    }
    return false;
  }

  public watch(signal?: AbortSignal): AsyncIterable<AccessStreamItem>;
  public watch(
    cursor?: StreamCursor,
    signal?: AbortSignal,
  ): AsyncIterable<AccessStreamItem>;
  public watch(
    cursorOrSignal?: StreamCursor | AbortSignal,
    maybeSignal?: AbortSignal,
  ): AsyncIterable<AccessStreamItem> {
    const cursor = isAbortSignal(cursorOrSignal) ? undefined : cursorOrSignal;
    const signal = isAbortSignal(cursorOrSignal) ? cursorOrSignal : maybeSignal;
    return this.#subscribe(cursor, signal, null, true);
  }

  /** Session-aware access subscription; native filtering happens before buffering. */
  public attach(
    input: AccessAttachInput,
    signal?: AbortSignal,
  ): AsyncIterable<AccessStreamItem> {
    const sessions = input.sessions === "all" ? null : new Set(input.sessions);
    return this.#subscribe(input.cursor, signal, sessions, input.includeNative);
  }

  /** Control-only projection subscription used by the gateway's list/watch APIs. */
  public watchControl(
    cursor?: StreamCursor,
    signal?: AbortSignal,
  ): AsyncIterable<AccessStreamItem> {
    return this.#subscribe(cursor, signal, null, false);
  }

  #subscribe(
    cursor: StreamCursor | undefined,
    signal: AbortSignal | undefined,
    sessions: ReadonlySet<SessionId> | null,
    includeNative: boolean,
  ): AsyncIterable<AccessStreamItem> {
    let removeAbortListener = (): void => {};
    let subscriber: GatewaySubscriber;
    const queue = new AsyncQueue<AccessStreamItem>(
      AccessGatewayProjection.maximumSubscriberItems,
      () => {
        this.#subscribers.delete(subscriber);
        removeAbortListener();
      },
    );
    subscriber = { queue, sessions, includeNative };
    this.#subscribers.add(subscriber);
    const close = (): void => {
      queue.close();
    };
    removeAbortListener = (): void => signal?.removeEventListener("abort", close);
    if (signal?.aborted || queue.closed) close();
    else signal?.addEventListener("abort", close, { once: true });
    const initial: AccessStreamItem[] = [];
    if (!queue.closed) {
      if (cursor === undefined) {
        initial.push(this.#heartbeat());
      } else if (cursor.feedId !== this.#feedId) {
        initial.push(this.#reset(cursor.feedId, "feedChanged"));
      } else {
        const minimumRetained = this.#journal[0]?.cursor ?? this.#controlCursor + 1;
        if (
          cursor.controlCursor > this.#controlCursor ||
          cursor.controlCursor < minimumRetained - 1
        ) {
          initial.push(this.#reset(cursor.feedId, "cursorExpired"));
        } else {
          for (const item of this.#journal) {
            if (item.cursor > cursor.controlCursor) initial.push(item);
          }
          if (includeNative) {
            initial.push(...this.#nativeReplay(cursor, sessions));
          }
          initial.push(this.#heartbeat());
        }
      }
    }
    let initialIndex = 0;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AccessStreamItem> {
        return {
          next: () => {
            // A live overflow or abort wins over replay. Otherwise replay does
            // not consume mailbox capacity; live items can accumulate behind
            // its immutable barrier while the consumer catches up.
            if (queue.closed) return queue.next();
            const value = initial[initialIndex];
            if (value !== undefined) {
              initialIndex += 1;
              return Promise.resolve({ value, done: false });
            }
            return queue.next();
          },
          return: async () => {
            close();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  public watchSources(signal?: AbortSignal): AsyncIterable<SourceDiagnostic> {
    let removeAbortListener = (): void => {};
    const queue = new AsyncQueue<SourceDiagnostic>(
      AccessGatewayProjection.maximumSubscriberItems,
      () => {
        this.#sourceSubscribers.delete(queue);
        removeAbortListener();
      },
    );
    this.#sourceSubscribers.add(queue);
    const close = (): void => {
      queue.close();
    };
    removeAbortListener = (): void => signal?.removeEventListener("abort", close);
    if (signal?.aborted || queue.closed) close();
    else signal?.addEventListener("abort", close, { once: true });
    if (!queue.closed) {
      for (const diagnostic of this.diagnostics()) queue.push(diagnostic);
    }
    return {
      [Symbol.asyncIterator](): AsyncIterator<SourceDiagnostic> {
        return {
          next: () => queue.next(),
          return: async () => {
            close();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  #reselect(
    previous = this.#selectionSignature(),
    failoverReference: GatewaySourceSnapshot | null = null,
  ): void {
    this.#selected.clear();
    for (const source of this.#sources.values()) {
      source.selectedBySourceId = undefined;
      if (source.definition.enabled === false) source.state = "disabled";
      else if (source.snapshot !== null && source.state !== "unavailable") source.state = "synchronizing";
    }
    const candidates = [...this.#sources.values()].filter(
      (source) => source.snapshot !== null && source.state !== "unavailable" && source.state !== "disabled",
    );

    // Conflicting authority claims or ambiguous partial overlaps fail closed.
    const byRealm = new Map<string, SourceState[]>();
    for (const source of candidates) {
      const realm = source.snapshot!.manifest.authority.realmId;
      const group = byRealm.get(realm) ?? [];
      group.push(source);
      byRealm.set(realm, group);
    }
    const conflicted = new Set<SourceState>();
    for (const group of byRealm.values()) {
      const fences = new Set(group.map((source) => authorityKey(source.snapshot!.manifest.authority)));
      if (fences.size > 1) {
        for (const source of group) this.#conflict(source, "authority epoch conflict within one realm", conflicted);
        continue;
      }
      for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
          const left = group[leftIndex]!;
          const right = group[rightIndex]!;
          const relation = coverageRelation(left.snapshot!.manifest, right.snapshot!.manifest);
          if (relation === "partial") {
            this.#conflict(left, "partially overlapping source coverage", conflicted);
            this.#conflict(right, "partially overlapping source coverage", conflicted);
          } else if (relation !== "disjoint") {
            const recordConflict = overlappingRecordConflict(
              left.snapshot!,
              right.snapshot!,
            );
            if (recordConflict !== undefined) {
              this.#conflict(left, recordConflict, conflicted);
              this.#conflict(right, recordConflict, conflicted);
            }
          }
        }
      }
    }
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const left = candidates[leftIndex]!;
        const right = candidates[rightIndex]!;
        const leftManifest = left.snapshot!.manifest;
        const rightManifest = right.snapshot!.manifest;
        const relation = coverageRelation(leftManifest, rightManifest);
        if (relation === "disjoint") {
          const identityConflict = sharedDomainIdentityConflict(
            left.snapshot!,
            right.snapshot!,
          );
          if (identityConflict !== undefined) {
            this.#conflict(left, identityConflict, conflicted);
            this.#conflict(right, identityConflict, conflicted);
          }
          continue;
        }
        if (leftManifest.authority.realmId !== rightManifest.authority.realmId) {
          this.#conflict(left, "overlapping control-node identities claim different realms", conflicted);
          this.#conflict(right, "overlapping control-node identities claim different realms", conflicted);
        }
      }
    }
    if (failoverReference !== null) {
      for (const candidate of candidates) {
        if (conflicted.has(candidate)) continue;
        const candidateManifest = candidate.snapshot!.manifest;
        const relation = coverageRelation(
          failoverReference.manifest,
          candidateManifest,
        );
        if (
          relation === "disjoint" ||
          !sameFence(failoverReference.manifest.authority, candidateManifest.authority)
        ) continue;
        const recordConflict = relation === "partial"
          ? "failover source partially overlaps the unavailable selected projection"
          : overlappingRecordConflict(failoverReference, candidate.snapshot!);
        if (recordConflict !== undefined) {
          this.#conflict(
            candidate,
            `unsafe warm failover: ${recordConflict}`,
            conflicted,
          );
        }
      }
    }

    const eligible = candidates.filter((source) => !conflicted.has(source)).sort(compareSources);
    for (const candidate of eligible) {
      const suppressor = eligible.find((other) =>
        other !== candidate &&
        this.#selected.has(other.definition.sourceId) &&
        sameFence(other.snapshot!.manifest.authority, candidate.snapshot!.manifest.authority) &&
        isSuperset(other.snapshot!.manifest.coveredControlNodeIds, candidate.snapshot!.manifest.coveredControlNodeIds),
      );
      if (suppressor) {
        candidate.state = "suppressed";
        candidate.selectedBySourceId = suppressor.definition.sourceId;
        candidate.reason = "covered by a selected ancestor projection";
      } else {
        candidate.state = "selected";
        candidate.reason = undefined;
        this.#selected.add(candidate.definition.sourceId);
      }
      candidate.updatedAt = this.#timestamp();
    }
    this.#rebuildOwners();
    const current = this.#selectionSignature();
    if (current !== previous) this.#rotateFeed();
    this.#broadcastDiagnostics();
  }

  #rebuildOwners(): void {
    this.#controlNodeOwners.clear();
    this.#runtimeNodeOwners.clear();
    this.#sessionOwners.clear();
    this.#interactionOwners.clear();
    for (const sourceId of this.#selected) {
      const snapshot = this.#source(sourceId).snapshot!;
      for (const id of snapshot.manifest.coveredControlNodeIds) this.#claim(this.#controlNodeOwners, id, sourceId, "control node");
      for (const runtime of snapshot.runtimeNodes) {
        if (this.#controlNodeOwners.get(runtime.ownerControlNodeId) !== sourceId) {
          throw new GatewayRoutingError("CONFLICT", `runtime node ${runtime.runtimeNodeId} is outside source coverage`);
        }
        this.#claim(this.#runtimeNodeOwners, runtime.runtimeNodeId, sourceId, "runtime node");
      }
      for (const session of snapshot.sessions) {
        if (this.#runtimeNodeOwners.get(session.runtimeNodeId) !== sourceId) {
          throw new GatewayRoutingError("CONFLICT", `session ${session.sessionId} has no selected runtime owner`);
        }
        this.#claim(this.#sessionOwners, session.sessionId, sourceId, "session");
      }
      for (const interaction of snapshot.interactions) {
        if (this.#sessionOwners.get(interaction.sessionId) !== sourceId) {
          throw new GatewayRoutingError("CONFLICT", `interaction ${interaction.interactionId} has no selected session owner`);
        }
        this.#claim(this.#interactionOwners, interaction.interactionId, sourceId, "interaction");
      }
    }
    for (const sessionId of [...this.#nativeSeen.keys()]) {
      if (this.#sessionOwners.has(sessionId)) continue;
      this.#nativeSeen.delete(sessionId);
      this.#removeNativeSession(sessionId);
    }
    this.#fenceTerminalRouteSubscriptions();
  }

  #rotateFeed(): void {
    const previousFeedId = this.#feedId;
    this.#feedId = newFeedId();
    this.#controlCursor = 0;
    // Command ownership is only a routing hint for the currently selected
    // projection. An ancestor and a warm descendant can both recover the same
    // durable command, but their gateway-local source IDs are not stable across
    // failover. Never let a pre-rotation hint pin recovery to an unavailable or
    // newly suppressed source.
    this.#commandOwners.clear();
    this.#launchOwners.clear();
    this.#archiveOwners.clear();
    this.#sessionLookupHints.clear();
    this.#sessionLookupRecords.clear();
    this.#pageCursors.clear();
    this.#nativeSeen.clear();
    this.#nativeJournal.splice(0);
    this.#journal.splice(0);
    this.#broadcast({
      kind: "streamReset",
      previousFeedId,
      feedId: this.#feedId,
      controlCursor: 0,
      authorityRefs: this.#authorityRefs(),
      reason: "sourceSelectionChanged",
      recovery: "snapshot",
    });
  }

  #validateSnapshot(snapshot: GatewaySourceSnapshot, source: SourceState): void {
    accessSnapshotSchema.parse({
      source: {
        manifest: snapshot.manifest,
        parentByControlNodeId: snapshot.parentByControlNodeId,
      },
      capturedAt: snapshot.manifest.generatedAt,
      controlNodes: snapshot.controlNodes,
      runtimeNodes: snapshot.runtimeNodes,
      sessions: snapshot.sessions,
      interactions: snapshot.interactions,
      metadataOperations: snapshot.metadataOperations,
    });
    sourceCoverageSnapshotSchema.parse({
      manifest: snapshot.manifest,
      parentByControlNodeId: snapshot.parentByControlNodeId,
    });
    if (snapshot.manifest.sourceControlNodeBootId.length === 0) {
      throw new TypeError("source manifest is missing its boot fence");
    }
    if (snapshot.manifest.sourceControlNodeId === undefined) {
      throw new TypeError("only control nodes can be gateway sources");
    }
    const covered = new Set(snapshot.manifest.coveredControlNodeIds);
    const actual = new Set(snapshot.controlNodes.map((record) => record.controlNodeId));
    if (actual.size !== covered.size || [...covered].some((id) => !actual.has(id))) {
      throw new GatewayRoutingError("CONFLICT", `source ${source.definition.sourceId} snapshot does not match exact advertised coverage`);
    }
    const duplicate = <T>(records: readonly T[], key: (record: T) => string): boolean => {
      const values = records.map(key);
      return new Set(values).size !== values.length;
    };
    if (
      duplicate(snapshot.controlNodes, (record) => record.controlNodeId) ||
      duplicate(snapshot.runtimeNodes, (record) => record.runtimeNodeId) ||
      duplicate(snapshot.sessions, (record) => record.sessionId) ||
      duplicate(snapshot.interactions, (record) => record.interactionId) ||
      duplicate(snapshot.metadataOperations, (record) => record.operationId)
    ) throw new GatewayRoutingError("CONFLICT", `source ${source.definition.sourceId} snapshot contains duplicate identities`);
  }

  #validateSourceItem(source: SourceState, item: AccessStreamItem): void {
    const manifest = source.snapshot!.manifest;
    if (
      (item.kind === "control" || item.kind === "heartbeat") &&
      item.feedId !== manifest.feedId
    ) {
      throw new GatewayRoutingError("CONFLICT", `source ${source.definition.sourceId} changed feed without a reset`);
    }
    if (item.kind === "control") {
      if (!sameFence(item.provenance.authority, manifest.authority)) {
        throw new GatewayRoutingError("CONFLICT", `source ${source.definition.sourceId} emitted a stale authority fence`);
      }
      if (!manifest.coveredControlNodeIds.includes(item.provenance.originControlNodeId)) {
        throw new GatewayRoutingError("CONFLICT", `source event origin is outside advertised coverage`);
      }
      const previous = manifest.controlCursor;
      if (item.cursor > previous + 1) {
        throw new GatewayRoutingError("CONFLICT", `source control cursor jumped from ${previous} to ${item.cursor}`);
      }
    } else if (item.kind === "native" || item.kind === "nativeGap") {
      if (!sameFence(item.provenance.authority, manifest.authority)) {
        throw new GatewayRoutingError("CONFLICT", `source native event carries a stale authority fence`);
      }
      if (!manifest.coveredControlNodeIds.includes(item.provenance.originControlNodeId)) {
        throw new GatewayRoutingError("CONFLICT", `native event origin is outside advertised coverage`);
      }
    } else if (item.kind === "heartbeat") {
      if (!item.authorityRefs.some((authority) => sameFence(authority, manifest.authority))) {
        throw new GatewayRoutingError("CONFLICT", `source heartbeat omitted its advertised authority fence`);
      }
    }
  }

  #applySourceControl(
    source: SourceState,
    item: Extract<AccessStreamItem, { kind: "control" }>,
  ): void {
    const snapshot = source.snapshot!;
    if (item.cursor <= snapshot.manifest.controlCursor) return;
    let controlNodes = snapshot.controlNodes;
    let runtimeNodes = snapshot.runtimeNodes;
    let sessions = snapshot.sessions;
    let interactions = snapshot.interactions;
    let metadataOperations = snapshot.metadataOperations;
    const change = item.change;
    switch (change.type) {
      case "controlNode.upsert":
        controlNodes = upsert(controlNodes, change.controlNode, (record) => record.controlNodeId);
        break;
      case "controlNode.presence":
        controlNodes = controlNodes.map((record) => record.controlNodeId === change.controlNodeId
          ? { ...record, presence: change.presence }
          : record);
        break;
      case "runtimeNode.upsert":
        runtimeNodes = upsert(runtimeNodes, change.runtimeNode, (record) => record.runtimeNodeId);
        break;
      case "runtimeNode.presence":
        runtimeNodes = runtimeNodes.map((record) => record.runtimeNodeId === change.runtimeNodeId
          ? { ...record, presence: change.presence }
          : record);
        break;
      case "session.upsert":
        sessions = upsert(sessions, change.session, (record) => record.sessionId);
        if (this.#selected.has(source.definition.sourceId)) {
          this.#rememberOwner(
            this.#sessionLookupRecords,
            change.session.sessionId,
            change.session,
          );
          this.#rememberOwner(
            this.#sessionLookupHints,
            change.session.sessionId,
            source.definition.sourceId,
          );
        }
        break;
      case "launch.changed":
        if (this.#selected.has(source.definition.sourceId)) {
          this.#rememberOwner(
            this.#launchOwners,
            change.launch.launchId,
            source.definition.sourceId,
          );
        }
        break;
      case "archive.changed":
        if (this.#selected.has(source.definition.sourceId)) {
          this.#rememberOwner(
            this.#archiveOwners,
            change.archive.archiveOperationId,
            source.definition.sourceId,
          );
        }
        break;
      case "session.unavailable":
        sessions = sessions.map((record) => record.sessionId === change.sessionId
          ? { ...record, availability: "unavailable" as const }
          : record);
        break;
      case "metadata.changed":
        sessions = sessions.map((record) => record.sessionId === change.sessionId
          ? { ...record, metadata: change.metadata }
          : record);
        break;
      case "metadata.operation":
        metadataOperations = upsert(metadataOperations, change.operation, (record) => record.operationId);
        break;
      case "interaction.changed":
        interactions = upsert(interactions, change.interaction, (record) => record.interactionId);
        break;
      default:
        break;
    }
    source.snapshot = Object.freeze({
      ...snapshot,
      manifest: { ...snapshot.manifest, controlCursor: item.cursor, generatedAt: this.#timestamp() },
      controlNodes,
      runtimeNodes,
      sessions,
      interactions,
      metadataOperations,
    });
    if (this.#selected.has(source.definition.sourceId)) this.#rebuildOwners();
  }

  #conflict(source: SourceState, reason: string, set: Set<SourceState>): void {
    set.add(source);
    source.state = "conflict";
    source.reason = reason;
    source.selectedBySourceId = undefined;
    source.updatedAt = this.#timestamp();
  }

  #claim<TKey>(map: Map<TKey, SourceId>, key: TKey, sourceId: SourceId, kind: string): void {
    const existing = map.get(key);
    if (existing !== undefined && existing !== sourceId) {
      throw new GatewayRoutingError("CONFLICT", `${kind} ${String(key)} is claimed by multiple selected sources`);
    }
    map.set(key, sourceId);
  }

  #rememberCommandOwner(commandId: CommandId, sourceId: SourceId): void {
    // This is a recovery optimization, never authoritative state. Keep recent
    // dispatches hot while bounding a long-lived gateway's process memory; an
    // evicted identity safely falls back to read-only selected-source lookup.
    this.#commandOwners.delete(commandId);
    this.#commandOwners.set(commandId, sourceId);
    while (
      this.#commandOwners.size > AccessGatewayProjection.maximumCommandOwnerHints
    ) {
      const oldest = this.#commandOwners.keys().next().value;
      if (oldest === undefined) break;
      this.#commandOwners.delete(oldest);
    }
  }

  #rememberOwner<TKey, TValue>(
    map: Map<TKey, TValue>,
    key: TKey,
    value: TValue,
  ): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > AccessGatewayProjection.maximumOperationOwnerHints) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  #selectedSourceIds(): SourceId[] {
    return [...this.#selected].sort((left, right) => left.localeCompare(right));
  }

  #sessionSearchSourceIds(query: SessionSearchInput): SourceId[] {
    if (query.runtimeNodeIds === undefined) return this.#selectedSourceIds();
    const requested = new Set(
      query.runtimeNodeIds.map(
        (runtimeNodeId) => this.#ownerForRuntime(runtimeNodeId).definition.sourceId,
      ),
    );
    return this.#selectedSourceIds().filter((sourceId) => requested.has(sourceId));
  }

  #readPageCursor(
    kind: PageCursorKind,
    cursor: string | undefined,
    sourceIds: readonly SourceId[],
    filterKey: string,
  ): PageCursorState {
    if (cursor === undefined) {
      return {
        kind,
        feedId: this.#feedId,
        sourceIds,
        sourceIndex: 0,
        sourceCursor: undefined,
        filterKey,
      };
    }
    const state = this.#pageCursors.get(cursor);
    if (
      state === undefined ||
      state.kind !== kind ||
      state.feedId !== this.#feedId ||
      state.filterKey !== filterKey ||
      !isDeepStrictEqual(state.sourceIds, sourceIds)
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        `${kind} pagination cursor expired or does not match the current query`,
      );
    }
    // Refresh its bounded LRU position without changing cursor semantics.
    this.#pageCursors.delete(cursor);
    this.#pageCursors.set(cursor, state);
    return state;
  }

  #newPageCursor(state: PageCursorState): string {
    const cursor = newFeedId();
    this.#pageCursors.set(cursor, Object.freeze({
      ...state,
      sourceIds: Object.freeze([...state.sourceIds]),
    }));
    while (this.#pageCursors.size > AccessGatewayProjection.maximumPageCursors) {
      const oldest = this.#pageCursors.keys().next().value;
      if (oldest === undefined) break;
      this.#pageCursors.delete(oldest);
    }
    return cursor;
  }

  async #lookupOperation<TKey, TValue>(
    id: TKey,
    owners: Map<TKey, SourceId>,
    lookup: (client: ControlNodeSourceClient) => Promise<TValue | null>,
    kind: string,
  ): Promise<TValue | null> {
    const known = owners.get(id);
    if (known !== undefined && this.#selected.has(known)) {
      return lookup(this.#source(known).definition.client);
    }
    const sourceIds = this.#selectedSourceIds();
    const settled = await Promise.allSettled(
      sourceIds.map((sourceId) => lookup(this.#source(sourceId).definition.client)),
    );
    const found = settled.flatMap((result, index) =>
      result.status === "fulfilled" && result.value !== null
        ? [{ record: result.value, sourceId: sourceIds[index]! }]
        : [],
    );
    if (found.length === 0) {
      const failed = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed !== undefined) throw failed.reason;
      return null;
    }
    if (found.some(({ record }) => !sameProtocolRecord(record, found[0]!.record))) {
      throw new GatewayRoutingError(
        "CONFLICT",
        `selected sources returned conflicting ${kind} ${String(id)}`,
      );
    }
    const match = found[0]!;
    this.#rememberOwner(owners, id, match.sourceId);
    return match.record;
  }

  #assertAdvertisedLaunchProfile(request: LaunchRequest): void {
    const runtime = this.#runtimeNodeRecord(request.runtimeNodeId);
    const sameName = runtime.launchProfiles.find((profile) =>
      profile.providerId === request.profile.providerId &&
      profile.profileId === request.profile.profileId &&
      profile.contractVersion === request.profile.contractVersion);
    if (sameName === undefined) {
      throw new GatewayRoutingError(
        "UNSUPPORTED",
        `runtime node ${request.runtimeNodeId} does not advertise launch profile ${request.profile.providerId}/${request.profile.profileId}`,
      );
    }
    if (sameName.requestSchemaHash !== request.profile.requestSchemaHash) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "launch profile compatibility fence changed",
      );
    }
    if (!sameName.harnesses.includes(request.harness)) {
      throw new GatewayRoutingError(
        "UNSUPPORTED",
        `launch profile does not support ${request.harness}`,
      );
    }
    if (!sameName.available) {
      throw new GatewayRoutingError(
        "UNAVAILABLE",
        sameName.unavailableReason ?? "launch profile is unavailable",
      );
    }
  }

  #assertSessionSearchOwner(sourceId: SourceId, session: SessionRecord): void {
    const runtimeOwner = this.#runtimeNodeOwners.get(session.runtimeNodeId);
    const authority = this.#source(sourceId).snapshot!.manifest.authority;
    if (
      runtimeOwner !== sourceId ||
      !sameFence(session.metadataAuthority, authority)
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        `source ${sourceId} returned session ${session.sessionId} outside its selected runtime coverage`,
      );
    }
  }

  #assertLaunchSource(sourceId: SourceId, launch: LaunchRecord): void {
    if (this.#runtimeNodeOwners.get(launch.runtimeNodeId) !== sourceId) {
      throw new GatewayRoutingError(
        "CONFLICT",
        `source ${sourceId} returned launch ${launch.launchId} outside its selected runtime coverage`,
      );
    }
  }

  #assertArchiveSource(sourceId: SourceId, archive: ArchiveRecord): void {
    const source = this.#source(sourceId);
    if (
      this.#runtimeNodeOwners.get(archive.runtimeNodeId) !== sourceId ||
      !sameFence(archive.authority, source.snapshot!.manifest.authority)
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        `source ${sourceId} returned archive operation ${archive.archiveOperationId} outside its authority coverage`,
      );
    }
  }

  #ownerForSessionBinding(input: {
    readonly sessionId: SessionId;
    readonly runtimeNodeId: RuntimeNodeId;
    readonly bindingRevision: number;
  }): SourceState {
    const owner = this.#ownerForSession(input.sessionId);
    const runtimeOwner = this.#ownerForRuntime(input.runtimeNodeId);
    if (owner !== runtimeOwner) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "session and runtime-node ownership disagree",
      );
    }
    const session = owner.snapshot!.sessions.find(
      (candidate) => candidate.sessionId === input.sessionId,
    ) ?? this.#sessionLookupRecords.get(input.sessionId);
    if (
      session === undefined ||
      session.runtimeNodeId !== input.runtimeNodeId ||
      session.bindingRevision !== input.bindingRevision
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "session request carries a stale binding fence",
      );
    }
    return owner;
  }

  #source(id: SourceId): SourceState {
    const source = this.#sources.get(id);
    if (!source) throw new GatewayRoutingError("NOT_FOUND", `unknown source ${id}`);
    return source;
  }

  #terminalRoute(
    target: TerminalTarget,
    requireActive = false,
  ): {
    source: SourceState;
    client: TerminalSourceClient;
    fence: TerminalRouteFence;
  } {
    const source = this.#ownerForSession(target.sessionId);
    const runtimeOwner = this.#ownerForRuntime(target.runtimeNodeId);
    if (runtimeOwner !== source) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "terminal session and runtime-node ownership disagree",
      );
    }
    const session = source.snapshot!.sessions.find(
      (candidate) => candidate.sessionId === target.sessionId,
    );
    if (
      !session ||
      session.runtimeNodeId !== target.runtimeNodeId ||
      session.bindingRevision !== target.bindingRevision
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "terminal request carries a stale session binding",
      );
    }
    if (requireActive && session.availability !== "active") {
      throw new GatewayRoutingError(
        "CONFLICT",
        "terminal opening requires an active structured session; resume it first",
      );
    }
    const client = this.#terminalClient(source.definition.client);
    return {
      source,
      client,
      fence: this.#captureTerminalRouteFence(target),
    };
  }

  #terminalClient(client: ControlNodeSourceClient): TerminalSourceClient {
    const methods: readonly (keyof TerminalSourceClient)[] = [
      "getTerminal",
      "openTerminal",
      "attachTerminal",
      "acquireTerminalLease",
      "renewTerminalLease",
      "releaseTerminalLease",
      "sendTerminalInput",
      "terminateTerminal",
    ];
    if (methods.some((method) => typeof client[method] !== "function")) {
      throw new GatewayRoutingError(
        "UNSUPPORTED",
        "selected source does not support terminal.side-channel.v1",
      );
    }
    return client as TerminalSourceClient;
  }

  #captureTerminalRouteFence(target: TerminalTarget): TerminalRouteFence {
    const source = this.#ownerForSession(target.sessionId);
    const session = source.snapshot!.sessions.find(
      (candidate) => candidate.sessionId === target.sessionId,
    );
    const runtime = source.snapshot!.runtimeNodes.find(
      (candidate) => candidate.runtimeNodeId === target.runtimeNodeId,
    );
    if (
      !session || !runtime ||
      session.runtimeNodeId !== target.runtimeNodeId ||
      session.bindingRevision !== target.bindingRevision
    ) {
      throw new GatewayRoutingError("CONFLICT", "terminal route fence is stale");
    }
    const manifest = source.snapshot!.manifest;
    return {
      sourceId: source.definition.sourceId,
      sourceControlNodeBootId: manifest.sourceControlNodeBootId,
      sourceFeedId: manifest.feedId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      sessionId: target.sessionId,
      runtimeNodeId: target.runtimeNodeId,
      bindingRevision: target.bindingRevision,
    };
  }

  #assertTerminalRouteFence(fence: TerminalRouteFence): void {
    if (this.#sessionOwners.get(fence.sessionId) !== fence.sourceId) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "terminal source selection changed while the request was in flight",
      );
    }
    const source = this.#source(fence.sourceId);
    const snapshot = source.snapshot;
    const session = snapshot?.sessions.find(
      (candidate) => candidate.sessionId === fence.sessionId,
    );
    const runtime = snapshot?.runtimeNodes.find(
      (candidate) => candidate.runtimeNodeId === fence.runtimeNodeId,
    );
    if (
      !this.#selected.has(fence.sourceId) || !snapshot ||
      snapshot.manifest.sourceControlNodeBootId !== fence.sourceControlNodeBootId ||
      snapshot.manifest.feedId !== fence.sourceFeedId ||
      runtime?.runtimeNodeBootId !== fence.runtimeNodeBootId ||
      session?.runtimeNodeId !== fence.runtimeNodeId ||
      session.bindingRevision !== fence.bindingRevision
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "terminal route changed while the request was in flight",
      );
    }
  }

  #assertTerminalDescriptor(
    fence: TerminalRouteFence,
    descriptor: TerminalDescriptor,
    streamFence?: {
      terminalId: TerminalDescriptor["terminalId"];
      sequence?: number;
    },
  ): void {
    if (
      descriptor.sessionId !== fence.sessionId ||
      descriptor.runtimeNodeId !== fence.runtimeNodeId ||
      descriptor.bindingRevision !== fence.bindingRevision ||
      descriptor.runtimeNodeBootId !== fence.runtimeNodeBootId
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "terminal source returned a descriptor for another session binding",
      );
    }
    if (
      streamFence !== undefined &&
      (
        descriptor.terminalId !== streamFence.terminalId ||
        (streamFence.sequence !== undefined &&
          descriptor.sequence !== streamFence.sequence)
      )
    ) {
      throw new GatewayRoutingError(
        "CONFLICT",
        "terminal source returned a descriptor outside its stream fence",
      );
    }
  }

  async #terminalMutation<T>(
    target: TerminalTarget,
    description: string,
    operation: (client: TerminalSourceClient) => Promise<T>,
  ): Promise<T> {
    const route = this.#terminalRoute(target);
    const result = await this.#mutate(
      route.source,
      description,
      () => operation(route.client),
    );
    this.#assertTerminalRouteFence(route.fence);
    return result;
  }

  async *#guardTerminalSourceStream(
    route: {
      source: SourceState;
      client: TerminalSourceClient;
      fence: TerminalRouteFence;
    },
    input: TerminalAttachInput,
    signal?: AbortSignal,
  ): AsyncGenerator<TerminalStreamItem> {
    if (signal?.aborted) return;
    const controller = new AbortController();
    const subscription: TerminalRouteSubscription = {
      fence: route.fence,
      controller,
    };
    let replay: { highWater: number; lastSequence: number } | undefined;
    let sawItem = false;
    const abort = (): void => controller.abort();
    this.#terminalRouteSubscriptions.add(subscription);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const value of route.client.attachTerminal(input, controller.signal)) {
        if (controller.signal.aborted) break;
        this.#assertTerminalRouteFence(route.fence);
        const item = terminalStreamItemSchema.parse(value);
        if (item.cursor.terminalId !== input.terminalId) {
          throw new GatewayRoutingError(
            "CONFLICT",
            "terminal source stream returned another terminal identity",
          );
        }
        if (
          item.kind === "reset" ||
          item.kind === "replayStart" ||
          item.kind === "replayEnd" ||
          item.kind === "changed"
        ) {
          this.#assertTerminalDescriptor(route.fence, item.terminal, {
            terminalId: input.terminalId,
            ...(item.kind === "replayStart"
              ? {}
              : { sequence: item.cursor.sequence }),
          });
        }
        if (item.kind === "replayStart") {
          if (input.cursor !== undefined || replay !== undefined || sawItem) {
            throw new GatewayRoutingError(
              "CONFLICT",
              "terminal source returned an unexpected replay start",
            );
          }
          replay = { highWater: item.terminal.sequence, lastSequence: 0 };
        } else if (replay !== undefined) {
          if (item.kind === "replayEnd") {
            if (
              item.cursor.sequence !== replay.highWater ||
              item.cursor.sequence < replay.lastSequence
            ) {
              throw new GatewayRoutingError(
                "CONFLICT",
                "terminal source replay ended outside its advertised high-water fence",
              );
            }
            replay = undefined;
          } else if (
            (item.kind !== "output" && item.kind !== "resize") ||
            item.cursor.sequence <= replay.lastSequence ||
            item.cursor.sequence > replay.highWater
          ) {
            throw new GatewayRoutingError(
              "CONFLICT",
              "terminal source returned a malformed replay timeline",
            );
          } else {
            replay.lastSequence = item.cursor.sequence;
          }
        } else if (item.kind === "replayEnd") {
          throw new GatewayRoutingError(
            "CONFLICT",
            "terminal source returned a replay end without a start",
          );
        }
        sawItem = true;
        yield item;
      }
      if (controller.signal.aborted && !signal?.aborted) {
        this.#assertTerminalRouteFence(route.fence);
      }
    } finally {
      this.#terminalRouteSubscriptions.delete(subscription);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  #fenceTerminalRouteSubscriptions(): void {
    for (const subscription of this.#terminalRouteSubscriptions) {
      try {
        this.#assertTerminalRouteFence(subscription.fence);
      } catch {
        subscription.controller.abort();
      }
    }
  }

  #runtimeNodeRecord(id: RuntimeNodeId): RuntimeNodeDescriptor {
    const owner = this.#ownerForRuntime(id);
    const record = owner.snapshot!.runtimeNodes.find(
      (candidate) => candidate.runtimeNodeId === id,
    );
    if (!record) {
      throw new GatewayRoutingError("UNAVAILABLE", `runtime node ${id} is missing from its selected source`);
    }
    return record;
  }

  #ownerForRuntime(id: RuntimeNodeId): SourceState {
    const sourceId = this.#runtimeNodeOwners.get(id);
    if (!sourceId) throw new GatewayRoutingError("UNAVAILABLE", `runtime node ${id} has no selected source`);
    return this.#source(sourceId);
  }

  #ownerForControlNode(id: ControlNodeId): SourceState {
    const sourceId = this.#controlNodeOwners.get(id);
    if (!sourceId) throw new GatewayRoutingError("UNAVAILABLE", `control node ${id} has no selected source`);
    return this.#source(sourceId);
  }

  #ownerForSession(id: SessionId): SourceState {
    const sourceId = this.#sessionOwners.get(id) ?? this.#sessionLookupHints.get(id);
    if (!sourceId) throw new GatewayRoutingError("UNAVAILABLE", `session ${id} has no selected source`);
    if (!this.#selected.has(sourceId)) {
      throw new GatewayRoutingError("UNAVAILABLE", `session ${id} has no selected source`);
    }
    return this.#source(sourceId);
  }

  #assertAuthority(source: SourceState, expected: AuthorityRef): void {
    const actual = source.snapshot!.manifest.authority;
    if (!sameFence(actual, expected)) {
      throw new GatewayRoutingError("CONFLICT", "metadata proposal carries a stale authority fence", {
        expectedAuthority: expected,
        selectedAuthority: actual,
      });
    }
  }

  async #mutate<T>(source: SourceState, description: string, dispatch: () => Promise<T>): Promise<T> {
    if (!this.#selected.has(source.definition.sourceId)) {
      throw new GatewayRoutingError("UNAVAILABLE", `${description} has no selected source`);
    }
    try {
      return await dispatch();
    } catch (cause) {
      // Source adapters use GatewayRoutingError for a definitive remote
      // rejection or a transport guarantee that dispatch never happened.
      // Only an unclassified failure is conservatively ambiguous.
      if (cause instanceof GatewayRoutingError) throw cause;
      throw new GatewayRoutingError(
        "OUTCOME_UNKNOWN",
        `${description} was dispatched once; its outcome is unknown and it was not retried`,
        { sourceId: source.definition.sourceId },
        { cause },
      );
    }
  }

  #union<K extends keyof GatewaySourceSnapshot, T extends GatewaySourceSnapshot[K] extends readonly (infer U)[] ? U : never>(
    key: K,
    id: (record: T) => string,
  ): T[] {
    const byId = new Map<string, T>();
    for (const sourceId of this.#selected) {
      const records = this.#source(sourceId).snapshot![key] as readonly T[];
      for (const record of records) byId.set(id(record), record);
    }
    return [...byId.values()].sort((left, right) => id(left).localeCompare(id(right)));
  }

  #recordForOwner<K extends keyof GatewaySourceSnapshot, T extends GatewaySourceSnapshot[K] extends readonly (infer U)[] ? U : never>(
    sourceId: SourceId | undefined,
    key: K,
    predicate: (record: T) => boolean,
  ): T | null {
    if (!sourceId) return null;
    const records = this.#source(sourceId).snapshot![key] as readonly T[];
    return records.find(predicate) ?? null;
  }

  #nativeReplay(
    cursor: StreamCursor,
    sessions: ReadonlySet<SessionId> | null,
  ): AccessStreamItem[] {
    const retainedBySession = new Map<
      SessionId,
      Array<Extract<AccessStreamItem, { kind: "native" }>>
    >();
    for (const event of this.#nativeJournal) {
      if (sessions !== null && !sessions.has(event.sessionId)) continue;
      const retained = retainedBySession.get(event.sessionId) ?? [];
      retained.push(event);
      retainedBySession.set(event.sessionId, retained);
    }

    const gapped = new Set<SessionId>();
    const gaps: AccessStreamItem[] = [];
    for (const [sessionId, latest] of this.#nativeSeen) {
      if (sessions !== null && !sessions.has(sessionId)) continue;
      const wanted = cursor.native[sessionId];
      const wantedSequence = wanted?.runtimeEpoch === latest.runtimeEpoch
        ? wanted.sequence
        : -1;
      const retained = (retainedBySession.get(sessionId) ?? []).filter(
        (event) => event.runtimeEpoch === latest.runtimeEpoch,
      );
      const first = retained[0];
      const requestedAhead = wantedSequence > latest.sequence;
      const missingTail =
        wantedSequence < latest.sequence &&
        (first === undefined || wantedSequence + 1 < first.sequence);
      if (!requestedAhead && !missingTail) continue;

      const provenance = first?.provenance ?? this.#nativeProvenance(sessionId);
      if (provenance === undefined) continue;
      gapped.add(sessionId);
      gaps.push({
        kind: "nativeGap",
        sessionId,
        reason: requestedAhead
          ? `gateway native journal ends at sequence ${latest.sequence}, behind requested sequence ${wantedSequence}`
          : first === undefined
            ? "gateway native journal no longer retains this session"
            : `gateway native journal begins at sequence ${first.sequence}`,
        recovery: "readNativeHistory",
        provenance,
      });
    }

    const replay = this.#nativeJournal.filter((event) => {
      if (gapped.has(event.sessionId)) return false;
      if (sessions !== null && !sessions.has(event.sessionId)) return false;
      const latest = this.#nativeSeen.get(event.sessionId);
      if (latest?.runtimeEpoch !== event.runtimeEpoch) return false;
      const wanted = cursor.native[event.sessionId];
      const wantedSequence = wanted?.runtimeEpoch === event.runtimeEpoch
        ? wanted.sequence
        : -1;
      return event.sequence > wantedSequence;
    });
    return [...gaps, ...replay];
  }

  #nativeProvenance(
    sessionId: SessionId,
  ): Extract<AccessStreamItem, { kind: "native" }>["provenance"] | undefined {
    const sourceId = this.#sessionOwners.get(sessionId);
    if (sourceId === undefined) return undefined;
    const manifest = this.#source(sourceId).snapshot?.manifest;
    if (manifest === undefined) return undefined;
    return {
      originControlNodeId: manifest.sourceControlNodeId,
      authority: manifest.authority,
    };
  }

  #removeNativeSession(sessionId: SessionId): void {
    for (let index = this.#nativeJournal.length - 1; index >= 0; index -= 1) {
      if (this.#nativeJournal[index]?.sessionId === sessionId) {
        this.#nativeJournal.splice(index, 1);
      }
    }
  }

  #broadcast(item: AccessStreamItem): void {
    for (const subscriber of this.#subscribers) {
      if (
        (item.kind === "native" || item.kind === "nativeGap") &&
        (!subscriber.includeNative ||
          (subscriber.sessions !== null && !subscriber.sessions.has(item.sessionId)))
      ) continue;
      subscriber.queue.push(item);
    }
  }

  #broadcastDiagnostics(): void {
    for (const diagnostic of this.diagnostics()) {
      for (const subscriber of this.#sourceSubscribers) subscriber.push(diagnostic);
    }
  }

  #authorityRefs(): AuthorityRef[] {
    return [...this.#selected]
      .map((sourceId) => this.#source(sourceId).snapshot!.manifest.authority)
      .filter(
        (value, index, all) =>
          all.findIndex((other) => sameFence(value, other)) === index,
      )
      .sort((left, right) => authorityKey(left).localeCompare(authorityKey(right)));
  }

  #heartbeat(): AccessStreamItem {
    return {
      kind: "heartbeat",
      feedId: this.#feedId,
      controlCursor: this.#controlCursor,
      authorityRefs: this.#authorityRefs(),
    };
  }

  #reset(
    previousFeedId: FeedId,
    reason: "feedChanged" | "cursorExpired",
  ): AccessStreamItem {
    return {
      kind: "streamReset",
      previousFeedId,
      feedId: this.#feedId,
      controlCursor: this.#controlCursor,
      authorityRefs: this.#authorityRefs(),
      reason,
      recovery: "snapshot",
    };
  }

  #selectionSignature(): string {
    return [...this.#selected]
      .sort()
      .map((sourceId) => {
        const manifest = this.#source(sourceId).snapshot!.manifest;
        return [
          sourceId,
          manifest.sourceControlNodeBootId,
          authorityKey(manifest.authority),
          manifest.feedId,
          ...[...manifest.coveredControlNodeIds].sort(),
        ].join("\0");
      })
      .join("\u0001");
  }

  #timestamp(): string {
    return this.now().toISOString();
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "aborted") === "boolean" &&
    typeof Reflect.get(value, "addEventListener") === "function"
  );
}

function compareSources(left: SourceState, right: SourceState): number {
  const coverage = right.snapshot!.manifest.coveredControlNodeIds.length - left.snapshot!.manifest.coveredControlNodeIds.length;
  if (coverage !== 0) return coverage;
  const priority = (right.definition.priority ?? 0) - (left.definition.priority ?? 0);
  if (priority !== 0) return priority;
  const controlNode = left.snapshot!.manifest.sourceControlNodeId.localeCompare(right.snapshot!.manifest.sourceControlNodeId);
  return controlNode || left.definition.sourceId.localeCompare(right.definition.sourceId);
}

function coverageRelation(left: SourceManifest, right: SourceManifest): "disjoint" | "equal" | "leftSuperset" | "rightSuperset" | "partial" {
  const leftSet = new Set(left.coveredControlNodeIds);
  const rightSet = new Set(right.coveredControlNodeIds);
  const overlap = [...leftSet].some((id) => rightSet.has(id));
  if (!overlap) return "disjoint";
  const leftContains = [...rightSet].every((id) => leftSet.has(id));
  const rightContains = [...leftSet].every((id) => rightSet.has(id));
  if (leftContains && rightContains) return "equal";
  if (leftContains) return "leftSuperset";
  if (rightContains) return "rightSuperset";
  return "partial";
}

function isSuperset(left: readonly ControlNodeId[], right: readonly ControlNodeId[]): boolean {
  const set = new Set(left);
  return right.every((id) => set.has(id));
}

/**
 * Compare only invariants that replication lag cannot legitimately change.
 * Presence, runtime generations, liveness, and unequal metadata revisions are
 * intentionally excluded: a useful warm source is eventually consistent, not
 * a lock-step replica. Equal canonical revisions and durable identities may
 * never disagree, however, so those forks fail closed before source selection.
 */
function overlappingRecordConflict(
  left: GatewaySourceSnapshot,
  right: GatewaySourceSnapshot,
): string | undefined {
  const leftControls = indexBy(left.controlNodes, (record) => record.controlNodeId);
  const rightControls = indexBy(right.controlNodes, (record) => record.controlNodeId);
  for (const [id, leftRecord] of leftControls) {
    const rightRecord = rightControls.get(id);
    if (rightRecord && !sameProtocolRecord(leftRecord.dataRole, rightRecord.dataRole)) {
      return `overlapping control node ${id} has conflicting durable topology`;
    }
  }

  const leftRuntimes = indexBy(left.runtimeNodes, (record) => record.runtimeNodeId);
  const rightRuntimes = indexBy(right.runtimeNodes, (record) => record.runtimeNodeId);
  for (const [id, leftRecord] of leftRuntimes) {
    const rightRecord = rightRuntimes.get(id);
    if (
      rightRecord !== undefined &&
      leftRecord.ownerControlNodeId !== rightRecord.ownerControlNodeId
    ) {
      return `overlapping runtime node ${id} has conflicting ownership`;
    }
  }

  const leftSessions = indexBy(left.sessions, (record) => record.sessionId);
  const rightSessions = indexBy(right.sessions, (record) => record.sessionId);
  for (const [id, leftRecord] of leftSessions) {
    const rightRecord = rightSessions.get(id);
    if (rightRecord === undefined) continue;
    if (!sameProtocolRecord(
      sessionBindingIdentity(leftRecord),
      sessionBindingIdentity(rightRecord),
    )) {
      return `overlapping session ${id} has conflicting native binding`;
    }
    if (
      leftRecord.metadata.revision === rightRecord.metadata.revision &&
      !sameProtocolRecord(leftRecord.metadata, rightRecord.metadata)
    ) {
      return `overlapping session ${id} has divergent metadata at revision ${leftRecord.metadata.revision}`;
    }
  }

  const leftBindings = indexBy(left.sessions, nativeBindingIdentity);
  const rightBindings = indexBy(right.sessions, nativeBindingIdentity);
  for (const [binding, leftRecord] of leftBindings) {
    const rightRecord = rightBindings.get(binding);
    if (rightRecord && leftRecord.sessionId !== rightRecord.sessionId) {
      return `overlapping native binding is assigned to conflicting logical sessions ${leftRecord.sessionId} and ${rightRecord.sessionId}`;
    }
  }

  const leftInteractions = indexBy(
    left.interactions,
    (record) => record.interactionId,
  );
  const rightInteractions = indexBy(
    right.interactions,
    (record) => record.interactionId,
  );
  for (const [id, leftRecord] of leftInteractions) {
    const rightRecord = rightInteractions.get(id);
    if (rightRecord === undefined) continue;
    if (!sameProtocolRecord(
      interactionIdentity(leftRecord),
      interactionIdentity(rightRecord),
    )) {
      return `overlapping interaction ${id} has conflicting immutable data`;
    }
    if (
      leftRecord.state !== "pending" &&
      rightRecord.state !== "pending" &&
      !sameProtocolRecord(
        interactionTerminalResult(leftRecord),
        interactionTerminalResult(rightRecord),
      )
    ) {
      return `overlapping interaction ${id} has conflicting terminal results`;
    }
  }

  const leftOperations = indexBy(
    left.metadataOperations,
    (record) => record.operationId,
  );
  const rightOperations = indexBy(
    right.metadataOperations,
    (record) => record.operationId,
  );
  for (const [id, leftRecord] of leftOperations) {
    const rightRecord = rightOperations.get(id);
    if (rightRecord === undefined) continue;
    if (!sameProtocolRecord(
      metadataOperationIdentity(leftRecord),
      metadataOperationIdentity(rightRecord),
    )) {
      return `overlapping metadata operation ${id} has conflicting immutable data`;
    }
    if (
      leftRecord.canonical.revision === rightRecord.canonical.revision &&
      !sameProtocolRecord(leftRecord.canonical, rightRecord.canonical)
    ) {
      return `overlapping metadata operation ${id} has divergent canonical revision ${leftRecord.canonical.revision}`;
    }
    if (
      leftRecord.status !== "queued" &&
      rightRecord.status !== "queued" &&
      !sameProtocolRecord(leftRecord, rightRecord)
    ) {
      return `overlapping metadata operation ${id} has conflicting terminal results`;
    }
  }
  return undefined;
}

function sharedDomainIdentityConflict(
  left: GatewaySourceSnapshot,
  right: GatewaySourceSnapshot,
): string | undefined {
  const duplicate = (
    leftIds: readonly string[],
    rightIds: readonly string[],
  ): string | undefined => {
    const ids = new Set(leftIds);
    return rightIds.find((id) => ids.has(id));
  };
  const checks: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ["runtime node", left.runtimeNodes.map((record) => record.runtimeNodeId), right.runtimeNodes.map((record) => record.runtimeNodeId)],
    ["session", left.sessions.map((record) => record.sessionId), right.sessions.map((record) => record.sessionId)],
    ["interaction", left.interactions.map((record) => record.interactionId), right.interactions.map((record) => record.interactionId)],
    ["metadata operation", left.metadataOperations.map((record) => record.operationId), right.metadataOperations.map((record) => record.operationId)],
  ];
  for (const [kind, leftIds, rightIds] of checks) {
    const id = duplicate(leftIds, rightIds);
    if (id !== undefined) {
      return `${kind} ${id} is duplicated across disjoint control subtrees`;
    }
  }
  return undefined;
}

function indexBy<T>(records: readonly T[], identity: (record: T) => string): Map<string, T> {
  return new Map(records.map((record) => [identity(record), record]));
}

function sessionBindingIdentity(record: SessionRecord): readonly unknown[] {
  return [
    record.runtimeNodeId,
    record.harness,
    record.adapterScopeId,
    record.vendorSessionId,
    record.bindingRevision,
    record.createdAt,
  ];
}

function nativeBindingIdentity(record: SessionRecord): string {
  return [
    record.runtimeNodeId,
    record.harness,
    record.adapterScopeId,
    record.vendorSessionId,
  ].join("\0");
}

function interactionIdentity(record: InteractionRecord): readonly unknown[] {
  return [
    record.sessionId,
    record.harness,
    record.runtimeEpoch,
    record.nativeRequestId ?? null,
    record.requestType,
    record.payload,
    record.ephemeral,
    record.createdAt,
  ];
}

function interactionTerminalResult(record: InteractionRecord): readonly unknown[] {
  return [
    record.state,
    record.resolution ?? null,
    record.expiresAt,
    record.resolvedAt,
  ];
}

function metadataOperationIdentity(record: MetadataOperationRecord): readonly unknown[] {
  return [
    record.sessionId,
    record.patch,
    record.originControlNodeId,
    record.authority,
  ];
}

function sameFence(left: AuthorityRef, right: AuthorityRef): boolean {
  return left.realmId === right.realmId && left.controlNodeId === right.controlNodeId && left.epochId === right.epochId;
}

function authorityKey(authority: AuthorityRef): string {
  return `${authority.realmId}\0${authority.controlNodeId}\0${authority.epochId}`;
}

function launchProfileKey(profile: LaunchProfileIdentity): string {
  return [
    profile.providerId,
    profile.profileId,
    profile.contractVersion,
    profile.requestSchemaHash,
  ].join("\0");
}

function paginationFilterKey(
  query: LaunchListInput | SessionSearchInput,
): string {
  const filter = { ...query } as Record<string, unknown>;
  delete filter.cursor;
  delete filter.limit;
  return canonicalJson(
    toJsonValue(JSON.parse(JSON.stringify(filter)) as unknown),
  );
}

function sameLaunchRequest(record: LaunchRecord, request: LaunchRequest): boolean {
  return sameProtocolRecord(
    {
      launchId: record.launchId,
      payloadHash: record.payloadHash,
      sessionId: record.sessionId,
      runtimeNodeId: record.runtimeNodeId,
      profile: record.profile,
      harness: record.harness,
      input: record.input,
      ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    },
    request,
  );
}

function sameArchiveRequest(
  record: ArchiveRecord,
  request: ArchiveRequest,
): boolean {
  return sameProtocolRecord(
    {
      archiveOperationId: record.archiveOperationId,
      payloadHash: record.payloadHash,
      sessionId: record.sessionId,
      runtimeNodeId: record.runtimeNodeId,
      bindingRevision: record.bindingRevision,
      expectedAuthority: record.expectedAuthority,
    },
    request,
  );
}

function sameProtocolRecord(left: unknown, right: unknown): boolean {
  return canonicalProtocolRecordJson(left) === canonicalProtocolRecordJson(right);
}

function upsert<T>(records: readonly T[], value: T, identity: (record: T) => string): readonly T[] {
  const key = identity(value);
  const index = records.findIndex((record) => identity(record) === key);
  if (index < 0) return [...records, value];
  const result = [...records];
  result[index] = value;
  return result;
}

function requiresSourceSnapshot(
  item: Extract<AccessStreamItem, { kind: "control" }>,
): boolean {
  return item.change.type === "controlNode.attached" ||
    item.change.type === "controlNode.detached" ||
    item.change.type === "authority.promoted";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
