import {
  canonicalJson,
  packNativePayload,
  nativePayloadSchema,
  nativeImagePointerValue,
  type NativePayload,
  type NativeImageSlot,
  type ImageBeginUploadInput,
  type ImageWriteUploadInput,
  type ImageUploadIdInput,
  type ImageResolvePathInput,
  type ImageReadInput,
  type ImageTarget,
  canonicalProtocolRecordJson,
  emptyMetadataSnapshot,
  harnessResumeOptionsSchema,
  harnessSpawnOptionsSchema,
  harnessCommandSchema,
  inventorySnapshotSchema,
  launchMetadataOperationId,
  newInteractionId,
  newRuntimeEpoch,
  overlayMetadata,
  toJsonValue,
  type CommandEnvelope,
  type CommandId,
  type CommandRecord,
  type AuthorityRef,
  type ArchiveRecord,
  type ArchiveRequest,
  type Harness,
  type HarnessCatalogEntry,
  type HarnessSessionSettings,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type InteractionRecord,
  type InventorySnapshot,
  type JsonValue,
  type JsonObject,
  type LaunchId,
  type LaunchListInput,
  type LaunchListPage,
  type LaunchRecord,
  type LaunchRequest,
  type MetadataOperationRecord,
  type MetadataPatch,
  type MetadataSnapshot,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type ResolveInteractionInput,
  type ResumeCommand,
  type SessionId,
  type SessionRecord,
  type StopCommand,
  type RuntimeNodeBootId,
  type RuntimeNodeEventCursor,
  type RuntimeNodeEventItem,
  type RuntimeNodeId,
  type RuntimeNodeRegistration,
  type RuntimeNodeSessionRecord,
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
  type TerminalTerminateInput,
} from "@arduano/agent-multiplex-protocol";

import {
  AdapterOutcomeUnknownError,
  type AdapterEvent,
  type AdapterInteractionEvent,
  type AdapterSession,
  type AgentAdapter,
  runtimeBackendForAdapter,
  type RuntimeAgentBackend,
} from "./adapter.js";
import { RuntimeNodeEventHub } from "./event-hub.js";
import { NativePathPolicy } from "./native-path-policy.js";
import { AllowedPathPolicy } from "./path-policy.js";
import {
  DirectWorkspaceLaunchProvider,
  LaunchProviderOutcomeUnknownError,
  LaunchProviderRegistry,
  nativeResumeOptions,
  parseRuntimePreparedLaunch,
  type LaunchPreparationContext,
  type LaunchSessionContext,
  type RuntimeLaunchProvider,
  type RuntimePreparedLaunch,
} from "./launch-provider.js";
import {
  RuntimeNodeStore,
  type RuntimeArchiveJournalEntry,
  type RuntimeLaunchJournalEntry,
} from "./store.js";
import {
  TerminalBroker,
  type TerminalBinding,
  type TerminalBrokerOptions,
  type TerminalProvider,
} from "./terminal.js";
import { collectCleanupErrors, waitForAll } from "./settled-work.js";
import { RuntimeImages, RuntimeImageError, type RuntimeImageOptions } from "./images.js";

const now = (): string => new Date().toISOString();

export class RuntimeNodeProtocolError extends Error {
  public constructor(
    public readonly code:
      | "NOT_FOUND"
      | "CONFLICT"
      | "FENCED"
      | "PAYLOAD_MISMATCH"
      | "UNSUPPORTED"
      | "RESOURCE_EXHAUSTED",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeNodeProtocolError";
  }
}

export interface RuntimeNodeServiceOptions {
  store: RuntimeNodeStore;
  runtimeNodeId: RuntimeNodeId;
  runtimeNodeBootId: RuntimeNodeBootId;
  name: string;
  allowedRoots: readonly string[];
  /** Legacy adapter-only composition; each adapter becomes a default backend. */
  adapters?: readonly AgentAdapter[];
  /** Explicit native backends for multi-scope and provider-aware runtimes. */
  backends?: readonly RuntimeAgentBackend[];
  /** Trusted, statically composed launch/resource providers. */
  launchProviders?: readonly RuntimeLaunchProvider[];
  /** Expose the built-in caller-owned workspace profile (default true). */
  includeDirectWorkspaceProvider?: boolean;
  endpointId?: string;
  eventRingSize?: number;
  /** Successful resolutions retained for RPC retries and control-stream replay. */
  resolvedInteractionCacheSize?: number;
  /** Runtime-local native terminal providers; terminal bytes are never persisted. */
  terminalProviders?: readonly TerminalProvider[];
  terminalBrokerOptions?: Omit<TerminalBrokerOptions, "runtimeNodeBootId" | "providers">;
  images?: RuntimeImageOptions;
  nativeEventQueueLimit?: number;
  nativeEventQueueBytes?: number;
}

interface ActiveBinding {
  session: AdapterSession;
  unsubscribe: () => void;
  sequence: number;
  lastActivityPersistedAt: number;
  events: Promise<void>;
  pendingEvents: number;
  pendingEventBytes: number;
  eventOverflowed: boolean;
  queuedInteractions: Set<AdapterInteractionEvent>;
  deferredLifecycle: Map<string, Exclude<AdapterEvent, { kind: "native" | "interaction" }>>;
}

interface PendingInteraction {
  record: InteractionRecord;
  native: AdapterInteractionEvent;
  retired: boolean;
  resolving?: {
    response: string;
    result: Promise<InteractionRecord>;
  };
}

export class RuntimeNodeService {
  readonly #store: RuntimeNodeStore;
  readonly #runtimeNodeId: RuntimeNodeId;
  readonly #runtimeNodeBootId: RuntimeNodeBootId;
  readonly #name: string;
  readonly #endpointId: string | undefined;
  readonly #pathPolicy: AllowedPathPolicy;
  readonly #nativePathPolicy: NativePathPolicy;
  readonly #launchRegistry: LaunchProviderRegistry;
  readonly #active = new Map<SessionId, ActiveBinding>();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  readonly #resolvedInteractions = new Map<string, InteractionRecord>();
  readonly #resolvedInteractionCacheSize: number;
  readonly #sessionLocks = new Map<SessionId, Promise<unknown>>();
  readonly #launchTasks = new Set<Promise<void>>();
  readonly #archiveTasks = new Set<Promise<void>>();
  readonly #scheduledLaunches = new Set<LaunchId>();
  readonly #scheduledArchives = new Set<ArchiveRequest["archiveOperationId"]>();
  readonly #events: RuntimeNodeEventHub;
  readonly #terminals: TerminalBroker;
  readonly #images: RuntimeImages;
  readonly #localImageBackends = new Set<string>();
  readonly #nativeEventTasks = new Map<Promise<void>, SessionId>();
  readonly #nativeEventQueueLimit: number;
  readonly #nativeEventQueueBytes: number;
  #acceptingNativeEvents = true;
  #lastSnapshot: InventorySnapshot | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #admitted = new Set<Promise<unknown>>();

  public constructor(options: RuntimeNodeServiceOptions) {
    this.#store = options.store;
    this.#runtimeNodeId = options.runtimeNodeId;
    this.#runtimeNodeBootId = options.runtimeNodeBootId;
    this.#name = options.name;
    this.#endpointId = options.endpointId;
    this.#resolvedInteractionCacheSize = options.resolvedInteractionCacheSize ?? 1_024;
    if (
      !Number.isSafeInteger(this.#resolvedInteractionCacheSize) ||
      this.#resolvedInteractionCacheSize < 1
    ) {
      throw new TypeError("resolvedInteractionCacheSize must be a positive integer");
    }
    this.#pathPolicy = new AllowedPathPolicy(options.allowedRoots);
    this.#nativePathPolicy = new NativePathPolicy(this.#pathPolicy);
    const explicitBackends = [...(options.backends ?? [])];
    const explicitNativeKeys = new Set(
      explicitBackends.map(({ adapter }) =>
        `${adapter.harness}\0${adapter.adapterScopeId}`,
      ),
    );
    const legacyBackends = (options.adapters ?? [])
      .filter(
        (adapter) =>
          !explicitNativeKeys.has(`${adapter.harness}\0${adapter.adapterScopeId}`),
      )
      .map((adapter) => runtimeBackendForAdapter(adapter));
    const backends = [...explicitBackends, ...legacyBackends];
    const providers = [...(options.launchProviders ?? [])];
    if ((options.includeDirectWorkspaceProvider ?? true) && backends.length > 0) {
      providers.push(new DirectWorkspaceLaunchProvider({ backends }));
    }
    this.#launchRegistry = new LaunchProviderRegistry(providers, backends);
    for (const backend of legacyBackends) this.#localImageBackends.add(backend.backendId);
    this.#images = new RuntimeImages(this.#store, this.#runtimeNodeId, options.images);
    this.#nativeEventQueueLimit = options.nativeEventQueueLimit ?? 256;
    this.#nativeEventQueueBytes = options.nativeEventQueueBytes ?? 32 * 1_024 * 1_024;
    for (const limit of [this.#nativeEventQueueLimit, this.#nativeEventQueueBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("native event queue limits must be positive safe integers");
    }
    this.#events = new RuntimeNodeEventHub({
      ...(options.eventRingSize === undefined ? {} : { ringSize: options.eventRingSize }),
    });
    this.#terminals = new TerminalBroker({
      runtimeNodeBootId: this.#runtimeNodeBootId,
      ...(options.terminalProviders === undefined
        ? {}
        : { providers: options.terminalProviders }),
      ...options.terminalBrokerOptions,
    });
    queueMicrotask(() => this.#recoverDurableOperations());
  }

  public get runtimeNodeId(): RuntimeNodeId {
    return this.#runtimeNodeId;
  }

  /** Fence delayed reverse-RPC calls from an earlier runtime-node process epoch. */
  public assertRuntimeNodeBootId(runtimeNodeBootId: RuntimeNodeBootId): void {
    if (runtimeNodeBootId !== this.#runtimeNodeBootId) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "request targets a stale runtime-node boot ID",
      );
    }
  }

  public describe(): Promise<RuntimeNodeRegistration> {
    return this.#admit(() => this.#describe());
  }

  async #describe(): Promise<RuntimeNodeRegistration> {
    await this.#images.ready();
    const roots = await this.#pathPolicy.roots();
    const harnesses = await this.#catalog();
    const descriptor = {
      runtimeNodeId: this.#runtimeNodeId,
      runtimeNodeBootId: this.#runtimeNodeBootId,
      name: this.#name,
      allowedRoots: [...roots],
      harnesses,
      launchProfiles: this.launchProfiles(),
      protocolVersion: 5 as const,
      ...(this.#endpointId ? { endpointId: this.#endpointId } : {}),
    };
    return descriptor;
  }

  public catalog(): Promise<HarnessCatalogEntry[]> {
    return this.#admit(() => this.#catalog());
  }

  async #catalog(): Promise<HarnessCatalogEntry[]> {
    const entries = await waitForAll(
      this.#launchRegistry.backends().map(async ({ adapter }) => {
        const entry = await adapter.describe();
        if (
          entry.harness !== adapter.harness ||
          entry.adapterScopeId !== adapter.adapterScopeId
        ) {
          throw new RuntimeNodeProtocolError(
            "FENCED",
            "agent backend described a different registered harness scope",
          );
        }
        return entry;
      }),
    );
    return entries.map((entry) => {
      const backend = this.#terminals.providerBackend(entry.harness, entry.adapterScopeId);
      if (!backend || !entry.available) return entry;
      return {
        ...entry,
        capabilities: [
          ...entry.capabilities,
          {
            name: "terminal.side-channel",
            version: "v1",
            experimental: backend === "copilot-ui-server",
          },
        ],
      };
    }).sort((left, right) =>
      `${left.harness}\0${left.adapterScopeId}`.localeCompare(
        `${right.harness}\0${right.adapterScopeId}`,
      ),
    );
  }

  public models(harness: Harness): Promise<NativeModel[]> {
    return this.#admit(() => this.#models(harness));
  }

  async #models(harness: Harness): Promise<NativeModel[]> {
    const results = await waitForAll(
      this.#launchRegistry
        .backendsForHarness(harness)
        .map(async ({ adapter }) => adapter.listModels()),
    );
    if (results.length === 0) {
      throw new RuntimeNodeProtocolError("UNSUPPORTED", `${harness} is unavailable`);
    }
    return this.#modelsForHarness(harness, results.flat());
  }

  public launchProfiles() {
    return this.#launchRegistry.descriptors();
  }

  public listLaunchProfiles() {
    return this.launchProfiles();
  }

  public launchProfileModels(
    profile: LaunchRequest["profile"],
    harness: Harness,
  ): Promise<NativeModel[]> {
    return this.#admit(() => this.#launchProfileModels(profile, harness));
  }

  async #launchProfileModels(
    profile: LaunchRequest["profile"],
    harness: Harness,
  ): Promise<NativeModel[]> {
    const provider = this.#launchRegistry.provider(profile);
    if (
      !provider.descriptor.available ||
      !provider.descriptor.harnesses.includes(harness)
    ) {
      throw new RuntimeNodeProtocolError(
        "UNSUPPORTED",
        `launch profile ${profile.providerId}/${profile.profileId} is unavailable for ${harness}`,
      );
    }
    if (provider.listModels) {
      return this.#modelsForHarness(
        harness,
        await provider.listModels(harness, {
          backend: (backendId) => this.#launchRegistry.backend(backendId),
        }),
      );
    }
    return this.#models(harness);
  }

  public listLaunchProfileModels(
    profile: LaunchRequest["profile"],
    harness: Harness,
  ): Promise<NativeModel[]> {
    return this.launchProfileModels(profile, harness);
  }

  public inventorySnapshot(): InventorySnapshot {
    return this.#lastSnapshot ?? {
      runtimeNodeId: this.#runtimeNodeId,
      generation: "unscanned",
      complete: false,
      capturedAt: now(),
      sessions: [],
    };
  }

  public refreshInventory(): Promise<InventorySnapshot> {
    return this.#admit(() => this.#refreshInventory());
  }

  async #refreshInventory(): Promise<InventorySnapshot> {
    const adapterInventories = await Promise.allSettled(
      this.#launchRegistry.backends().map(async ({ adapter }) => {
        const items = await adapter.listSessions();
        if (
          items.some(
            (item) =>
              item.harness !== adapter.harness ||
              item.adapterScopeId !== adapter.adapterScopeId,
          )
        ) {
          throw new RuntimeNodeProtocolError(
            "FENCED",
            "agent backend inventory escaped its registered harness scope",
          );
        }
        return items;
      }),
    );
    const discovered = adapterInventories.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const native = (
      await waitForAll(
        discovered.map(async (item): Promise<NativeInventoryItem | null> => {
          if (item.cwd === null) return null;
          try {
            return { ...item, cwd: await this.#pathPolicy.validate(item.cwd) };
          } catch {
            // Native inventories can include sessions from elsewhere on the
            // machine or stale paths. Neither is part of this runtime node's scope.
            return null;
          }
        }),
      )
    ).filter((item): item is NativeInventoryItem => item !== null)
      .filter((item) => !this.#store.isNativeBindingArchived(item));
    for (const [sessionId, binding] of this.#active) {
      const record = this.#store.getSession(sessionId);
      if (!record) continue;
      const key = `${record.harness}\0${record.adapterScopeId}\0${record.vendorSessionId}`;
      const index = native.findIndex(
        (candidate) =>
          `${candidate.harness}\0${candidate.adapterScopeId}\0${candidate.vendorSessionId}` === key,
      );
      const discovered = index >= 0 ? native[index] : undefined;
      const harnessSettings = binding.session.settings?.();
      const activeItem: NativeInventoryItem = {
        harness: binding.session.harness,
        adapterScopeId: binding.session.adapterScopeId,
        vendorSessionId: binding.session.vendorSessionId,
        cwd: binding.session.cwd,
        availability: "active",
        runtimeStatus: binding.session.status(),
        runtimeEpoch: binding.session.runtimeEpoch,
        ...(harnessSettings !== undefined
          ? { harnessSettings }
          : discovered?.harnessSettings !== undefined
            ? { harnessSettings: discovered.harnessSettings }
            : record.harnessSettings === undefined
              ? {}
              : { harnessSettings: record.harnessSettings }),
        ...(discovered?.nativeSummary !== undefined
          ? { nativeSummary: discovered.nativeSummary }
          : record.nativeSummary === undefined
            ? {}
            : { nativeSummary: record.nativeSummary }),
        // Polling is not native activity. Preserve the adapter's timestamp
        // when discovery found this binding and fall back to the last local
        // binding update only when the native inventory omitted it entirely.
        lastActivityAt: discovered
          ? discovered.lastActivityAt
          : record.lastActivityAt ?? record.updatedAt,
      };
      if (index >= 0) native[index] = activeItem;
      else native.push(activeItem);
    }
    const sessions = native
      .filter((item, index, all) => {
        const key = nativeInventoryKey(item);
        return all.findIndex((other) => nativeInventoryKey(other) === key) === index;
      })
      .sort((left, right) => nativeInventoryKey(left).localeCompare(nativeInventoryKey(right)));
    const nextSnapshot = inventorySnapshotSchema.parse({
      runtimeNodeId: this.#runtimeNodeId,
      generation: newRuntimeEpoch(),
      // A failed harness discovery must not hide healthy harnesses or mark its
      // previously known sessions unavailable in the canonical catalog.
      complete: adapterInventories.every((result) => result.status === "fulfilled"),
      capturedAt: now(),
      sessions,
    });
    if (
      this.#lastSnapshot &&
      this.#lastSnapshot.complete === nextSnapshot.complete &&
      canonicalJson(toJsonValue(this.#lastSnapshot.sessions)) ===
        canonicalJson(toJsonValue(nextSnapshot.sessions))
    ) {
      // A generation denotes inventory content, not a polling attempt. Reuse
      // the exact snapshot so the control node's replay path can acknowledge a
      // no-op without journaling N unchanged session upserts every interval.
      return this.#lastSnapshot;
    }
    this.#lastSnapshot = nextSnapshot;
    return this.#lastSnapshot;
  }

  public applyCanonicalSessions(records: readonly SessionRecord[]): void {
    const nativeOwners = new Map(
      this.#store.listSessions().map((record) => [nativeBindingKey(record), record.sessionId]),
    );
    const batchSessionIds = new Set<SessionId>();
    const reconciled = records.map((record): {
      record: RuntimeNodeSessionRecord;
      previous: RuntimeNodeSessionRecord | undefined;
    } => {
      if (record.runtimeNodeId !== this.#runtimeNodeId) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `control node returned session ${record.sessionId} for another runtime node`,
        );
      }
      if (this.#store.isNativeBindingArchived(record)) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `control node attempted to restore archived native session ${record.vendorSessionId}`,
        );
      }
      if (batchSessionIds.has(record.sessionId)) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `control node returned logical session ${record.sessionId} more than once`,
        );
      }
      batchSessionIds.add(record.sessionId);
      const previous = this.#store.getSession(record.sessionId);
      if (previous) assertSameNativeBinding(previous, record);
      const existingOwner = nativeOwners.get(nativeBindingKey(record));
      if (existingOwner !== undefined && existingOwner !== record.sessionId) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `control node rebound native session ${record.vendorSessionId} from logical session ${existingOwner} to ${record.sessionId}`,
        );
      }
      nativeOwners.set(nativeBindingKey(record), record.sessionId);
      if (previous && previous.bindingRevision !== record.bindingRevision) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `control node changed binding revision for runtime-owned session ${record.sessionId}`,
        );
      }
      const metadata = mergeCanonicalMetadata(
        previous,
        record.metadata,
        record.metadataAuthority,
      );
      return {
        previous,
        // Native binding/liveness fields are runtime-node-owned. For an
        // existing binding, reconciliation imports only the control node's
        // canonical metadata and authority fence.
        record: previous
          ? { ...previous, metadata, metadataAuthority: record.metadataAuthority }
          : runtimeRecordFromCanonical(record),
      };
    });

    const canonical = reconciled.map(({ record }) => record);
    const pendingMetadata = new Map(
      this.#store.listMetadataOutbox().map((patch) => [patch.operationId, patch]),
    );
    const launchMetadata = canonical.flatMap((record): MetadataPatch[] => {
      const entry = this.#store.getLaunchEntryForSession(record.sessionId);
      const values = entry?.request.metadata;
      if (
        entry?.record.state !== "succeeded" ||
        values === undefined ||
        Object.keys(values).length === 0
      ) {
        return [];
      }
      if (
        record.launchProvenance?.launchId !== entry.request.launchId ||
        entry.request.runtimeNodeId !== record.runtimeNodeId ||
        entry.request.sessionId !== record.sessionId
      ) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `launch journal does not match canonical binding ${record.sessionId}`,
        );
      }
      const patch: MetadataPatch = {
        // A protocol-fixed UUIDv5 namespace makes this deterministic without
        // sharing the caller-allocated launch-ID namespace.
        operationId: launchMetadataOperationId(entry.request.launchId),
        sessionId: record.sessionId,
        expectedAuthority: record.metadataAuthority!,
        set: values,
        // Initialization must not race a later authority-side edit. If any
        // launch-owned key was already written, the metadata authority rejects
        // this stale initial document instead of overwriting canonical data.
        ifKeyRevision: Object.fromEntries(
          Object.keys(values).map((key) => [key, null]),
        ),
      };
      const existing = [
        pendingMetadata.get(patch.operationId),
        this.#store.getMetadataOperation(patch.operationId)?.patch,
      ].filter((candidate): candidate is MetadataPatch => candidate !== undefined);
      for (const candidate of existing) {
        // A settled initialization remains complete across later authority
        // epochs. Compare its launch-owned identity while deliberately not
        // rebuilding the immutable old authority fence.
        if (!sameLaunchMetadataPatch(candidate, patch)) {
          throw new RuntimeNodeProtocolError(
            "FENCED",
            `launch metadata operation ${patch.operationId} has another immutable payload`,
          );
        }
      }
      return existing.length === 0 ? [patch] : [];
    });

    // Receiving the authority fence is the first point at which the runtime
    // can form a valid proposal. Persist the canonical bindings and derived
    // launch-metadata proposals together so a crash cannot lose initialization
    // after reconciliation has otherwise succeeded.
    this.#store.putSessionsAndEnqueueMetadata(canonical, launchMetadata);
  }

  /** Durably admit a generic launch and return before provider/native work begins. */
  public createLaunch(request: LaunchRequest): LaunchRecord {
    this.#assertOpen();
    if (request.runtimeNodeId !== this.#runtimeNodeId) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "launch was addressed to another runtime node",
      );
    }
    const existing = this.#store.getLaunchEntry(request.launchId);
    if (existing) {
      this.#assertSameLaunch(existing.request, request);
      if (!isTerminalLaunch(existing.record.state)) this.#scheduleLaunch(existing.record.launchId);
      return existing.record;
    }
    const reserved = this.#store.getLaunchEntryForSession(request.sessionId);
    if (reserved || this.#store.getSession(request.sessionId) || this.#active.has(request.sessionId)) {
      throw new RuntimeNodeProtocolError(
        "CONFLICT",
        `logical session ${request.sessionId} is already reserved or bound`,
      );
    }
    const provider = this.#launchRegistry.provider(request.profile);
    if (
      !provider.descriptor.available ||
      !provider.descriptor.harnesses.includes(request.harness)
    ) {
      throw new RuntimeNodeProtocolError(
        "UNSUPPORTED",
        `launch profile ${request.profile.providerId}/${request.profile.profileId} is unavailable for ${request.harness}`,
      );
    }
    const timestamp = now();
    const record: LaunchRecord = {
      ...request,
      implementationVersion: provider.descriptor.implementationVersion,
      state: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const entry: RuntimeLaunchJournalEntry = {
      request,
      record,
      checkpoint: null,
      preparation: null,
      pendingFailure: null,
    };
    this.#store.putLaunchEntry(entry);
    this.#publishLaunch(record);
    try {
      provider.validateInput(request.input, request.harness);
    } catch (error) {
      this.#settleLaunch(entry, "failed", errorText(error));
      return this.#store.getLaunch(request.launchId)!;
    }
    this.#scheduleLaunch(request.launchId);
    return record;
  }

  public getLaunch(launchId: LaunchId): LaunchRecord | null {
    return this.#store.getLaunch(launchId) ?? null;
  }

  public listLaunches(query: LaunchListInput): LaunchListPage {
    if (query.runtimeNodeId !== undefined && query.runtimeNodeId !== this.#runtimeNodeId) {
      return { launches: [], nextCursor: null };
    }
    const cursor = query.cursor === undefined ? undefined : decodeLaunchCursor(query.cursor);
    const filtered = this.#store.listLaunchEntries()
      .map(({ record }) => record)
      .filter((record) =>
        (query.sessionId === undefined || record.sessionId === query.sessionId) &&
        (query.providerId === undefined || record.profile.providerId === query.providerId) &&
        (query.profileId === undefined || record.profile.profileId === query.profileId) &&
        (query.states === undefined || query.states.includes(record.state)) &&
        (cursor === undefined || launchOrder(record, cursor) < 0),
      )
      .sort((left, right) => launchOrder(right, left));
    const page = filtered.slice(0, query.limit);
    return {
      launches: page,
      nextCursor: filtered.length > query.limit
        ? encodeLaunchCursor(page.at(-1)!)
        : null,
    };
  }

  public resume(input: ResumeCommand): Promise<CommandRecord> {
    return this.#admit(() => this.#resume(input));
  }

  async #resume(input: ResumeCommand): Promise<CommandRecord> {
    return this.#serialize(input.sessionId, () =>
      this.#journal(input.commandId, input.payloadHash, input.sessionId, input, async () => {
        const existing = this.#boundSessionForCommand(input, "resume");
        const active = this.#active.get(input.sessionId);
        if (active) {
          throw new RuntimeNodeProtocolError(
            "CONFLICT",
            `logical session ${input.sessionId} is already active`,
          );
        }
        const plan = await this.#resumePlan(existing, "interactive");
        const request = await this.#validateResumeOptions(existing, plan.resumeOptions);
        const session = await plan.backend.adapter.resume(request);
        await this.#validateResumedHandle(existing, request, plan.backend, session);
        if (
          existing.runtimeEpoch &&
          existing.runtimeEpoch !== session.runtimeEpoch
        ) {
          this.#retireInteractions(input.sessionId, existing.runtimeEpoch);
        }
        const record = this.#recordForHandle(
          input.sessionId,
          session,
          { existing },
        );
        this.#store.putSession(record);
        this.#activate(input.sessionId, session);
        this.#publishSession(record);
        return { sessionId: input.sessionId, vendorSessionId: session.vendorSessionId };
      }),
    );
  }

  public stop(input: StopCommand): Promise<CommandRecord> {
    return this.#admit(() => this.#stop(input));
  }

  async #stop(input: StopCommand): Promise<CommandRecord> {
    return this.#serialize(input.sessionId, () =>
      this.#journal(input.commandId, input.payloadHash, input.sessionId, input, async () => {
        const record = this.#boundSessionForCommand(input, "stop");
        const active = this.#active.get(input.sessionId);
        let stopError: unknown;
        try {
          await active?.session.stop();
        } catch (error) {
          stopError = error;
        } finally {
          if (active) {
            this.#terminals.invalidateSession(
              input.sessionId,
              `structured ${record.harness} session was stopped`,
            );
            active.unsubscribe();
            this.#retireInteractions(input.sessionId, active.session.runtimeEpoch, true);
            if (this.#active.get(input.sessionId) === active) {
              this.#active.delete(input.sessionId);
            }
          }
          this.#persistStopped(record);
        }
        if (stopError !== undefined) throw stopError;
        const stopped = this.#store.getSession(record.sessionId) ?? record;
        const providerContext = this.#sessionProviderContext(stopped);
        await providerContext?.provider.stop?.(providerContext.context);
        return { sessionId: input.sessionId };
      }),
    );
  }

  public execute(input: CommandEnvelope): Promise<CommandRecord> {
    return this.#admit(() => this.#execute(input));
  }

  async #execute(input: CommandEnvelope): Promise<CommandRecord> {
    return this.#serialize(input.sessionId, async () => {
      return this.#journal(input.commandId, input.payloadHash, input.sessionId, input, async () => {
        if (input.runtimeNodeId !== this.#runtimeNodeId) {
          throw new RuntimeNodeProtocolError(
            "FENCED",
            "command was addressed to another runtime node",
          );
        }
        const record = this.#store.getSession(input.sessionId);
        if (!record) throw new RuntimeNodeProtocolError("NOT_FOUND", "session binding not found");
        if (record.bindingRevision !== input.bindingRevision) {
          throw new RuntimeNodeProtocolError(
            "FENCED",
            `binding revision ${input.bindingRevision} is stale; current is ${record.bindingRevision}`,
          );
        }
        if (record.harness !== input.request.harness) {
          throw new RuntimeNodeProtocolError("FENCED", "command harness does not match binding");
        }
        const active = this.#active.get(input.sessionId);
        if (!active) {
          throw new RuntimeNodeProtocolError("NOT_FOUND", "session is resumable but not active");
        }
        harnessCommandSchema.parse(input.request);
        this.#launchRegistry.backendForSession(record).adapter.imageCodec?.validateCommand?.(input.request);
        const reconstructed = await this.#reconstructImages(input, record);
        const request = await this.#nativePathPolicy.command(reconstructed);
        const result = await active.session.execute(request);
        this.#syncHarnessSettings(input.sessionId, active);
        return result;
      });
    });
  }

  public getCommand(commandId: CommandId): CommandRecord | null {
    return this.#store.getCommand(commandId) ?? null;
  }

  public readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult> {
    return this.#admit(() => this.#readNativeHistory(sessionId, request));
  }

  async #readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult> {
    return this.#serialize(sessionId, async () => {
      // Binding and liveness must be checked after acquiring the session lock:
      // a queued resume may have installed a live handle while history waited.
      const record = this.#store.getSession(sessionId);
      if (!record) throw new RuntimeNodeProtocolError("NOT_FOUND", "session binding not found");
      if (record.harness !== request.harness) {
        throw new RuntimeNodeProtocolError("FENCED", "history request harness does not match binding");
      }
      const active = this.#active.get(sessionId);
      if (active) {
        const result = await active.session.readNativeHistory(request);
        return { ...result, payload: await this.#externalize(record, result.payload) };
      }

      const plan = await this.#resumePlan(record, "history");
      const options = await this.#validateResumeOptions(record, plan.resumeOptions);
      const temporary = await plan.backend.adapter.resume(options);
      await this.#validateResumedHandle(record, options, plan.backend, temporary);
      try {
        const result = await temporary.readNativeHistory(request);
        return { ...result, payload: await this.#externalize(record, result.payload) };
      } finally {
        // Temporary history handles are never installed in #active, and the
        // lock stays held until stop completes so a live resume cannot race it.
        await temporary.stop();
      }
    });
  }

  /** Durably admit stopped-session cleanup and return before release begins. */
  public archive(request: ArchiveRequest): ArchiveRecord {
    this.#assertOpen();
    if (request.runtimeNodeId !== this.#runtimeNodeId) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "archive was addressed to another runtime node",
      );
    }
    const existing = this.#store.getArchiveEntry(request.archiveOperationId);
    if (existing) {
      this.#assertSameArchive(existing.request, request);
      if (!isTerminalArchive(existing.record.state)) {
        this.#scheduleArchive(existing.record.archiveOperationId);
      }
      return existing.record;
    }
    const session = this.#store.getSession(request.sessionId);
    if (!session) throw new RuntimeNodeProtocolError("NOT_FOUND", "session binding not found");
    this.#assertBindingRevision(session, request.bindingRevision);
    if (!session.metadataAuthority || !sameAuthority(session.metadataAuthority, request.expectedAuthority)) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "archive targets a stale or unknown metadata authority",
      );
    }
    if (
      this.#active.has(request.sessionId) ||
      session.availability === "active" ||
      session.runtimeStatus !== "stopped"
    ) {
      throw new RuntimeNodeProtocolError(
        "CONFLICT",
        "only a stopped session can be archived",
      );
    }
    if (this.#store.listSessionMetadataOutbox(request.sessionId).length > 0) {
      throw new RuntimeNodeProtocolError(
        "CONFLICT",
        "flush pending agent metadata before archiving the session",
      );
    }
    const pending = this.#store
      .listArchiveEntriesForSession(request.sessionId)
      .find(({ record }) => !isTerminalArchive(record.state));
    if (pending) {
      throw new RuntimeNodeProtocolError(
        "CONFLICT",
        `session already has in-flight archive operation ${pending.record.archiveOperationId}`,
      );
    }
    const timestamp = now();
    const record: ArchiveRecord = {
      ...request,
      authority: request.expectedAuthority,
      state: "accepted",
      releasedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const entry: RuntimeArchiveJournalEntry = {
      request,
      record,
      backendReleased: false,
      providerReleased: false,
    };
    this.#store.putArchiveEntry(entry);
    this.#publishArchive(record);
    this.#scheduleArchive(request.archiveOperationId);
    return record;
  }

  public getArchive(
    archiveOperationId: ArchiveRequest["archiveOperationId"],
  ): ArchiveRecord | null {
    return this.#store.getArchive(archiveOperationId) ?? null;
  }

  public beginImageUpload(input: ImageBeginUploadInput) {
    return this.#admit(() => this.#serialize(input.sessionId, async () => {
      this.#imageSession(input);
      return this.#images.begin(input);
    }));
  }
  public writeImageUpload(input: ImageWriteUploadInput) {
    return this.#admit(() => this.#serialize(input.sessionId, async () => {
      this.#imageSession(input);
      return this.#images.write(input);
    }));
  }
  public commitImageUpload(input: ImageUploadIdInput) {
    return this.#admit(() => this.#serialize(input.sessionId, async () => {
      this.#imageSession(input);
      return this.#images.commit(input);
    }));
  }
  public abortImageUpload(input: ImageUploadIdInput) {
    return this.#admit(() => this.#serialize(input.sessionId, async () => {
      this.#imageSession(input);
      return this.#images.abort(input);
    }));
  }
  public readImage(input: ImageReadInput) {
    return this.#admit(() => this.#serialize(input.sessionId, async () => {
      this.#imageSession(input);
      return this.#images.read(input);
    }));
  }
  public resolveImagePath(input: ImageResolvePathInput) {
    return this.#admit(() => this.#serialize(input.sessionId, async () => {
      const session = this.#imageSession(input);
      const backend = this.#launchRegistry.backendForSession(session);
      return this.#images.snapshot(input, input.sourceKey, input.path, session, backend, this.#localImageBackends.has(backend.backendId));
    }));
  }
  public imageLimits(input: ImageTarget) {
    return this.#admit(async () => {
      this.#imageSession(input);
      return this.#images.limits();
    });
  }

  #imageSession(input: ImageTarget): RuntimeNodeSessionRecord {
    this.assertRuntimeNodeBootId(input.runtimeNodeBootId);
    if (input.runtimeNodeId !== this.#runtimeNodeId) throw new RuntimeNodeProtocolError("FENCED", "image targets another runtime node");
    const session = this.#store.getSession(input.sessionId);
    if (!session) throw new RuntimeNodeProtocolError("NOT_FOUND", "image session binding not found");
    this.#assertBindingRevision(session, input.bindingRevision);
    if (this.#store.listArchiveEntriesForSession(input.sessionId).some(({ record }) => !isTerminalArchive(record.state))) {
      throw new RuntimeNodeProtocolError("FENCED", "image session is being archived");
    }
    return session;
  }

  #imageTarget(session: RuntimeNodeSessionRecord): ImageTarget {
    return { sessionId: session.sessionId, runtimeNodeId: this.#runtimeNodeId, bindingRevision: session.bindingRevision, runtimeNodeBootId: this.#runtimeNodeBootId };
  }

  async #externalize(session: RuntimeNodeSessionRecord, payload: JsonValue): Promise<NativePayload> {
    const backend = this.#launchRegistry.backendForSession(session);
    if (!backend.adapter.imageCodec) return packNativePayload(payload);
    const target = this.#imageTarget(session);
    const unavailable = (error: unknown): NativeImageSlot["image"] => ({
      unavailable: true,
      reason: error instanceof RuntimeImageError
        ? error.code === "RESOURCE_EXHAUSTED" ? "quotaExceeded"
          : error.code === "UNSUPPORTED" ? "unsupported"
            : error.code === "NOT_FOUND" ? "missing" : "invalid"
        : "unavailable",
    });
    const result = await backend.adapter.imageCodec.externalize(payload, {
      storeBase64: async ({ dataBase64, mediaType }) => {
        try { return await this.#images.storeBase64(target, dataBase64, mediaType); }
        catch (error) { return unavailable(error); }
      },
      snapshotPath: async ({ sourceKey, path }) => {
        try { return await this.#images.snapshot(target, sourceKey, path, session, backend, this.#localImageBackends.has(backend.backendId)); }
        catch (error) { return unavailable(error); }
      },
    });
    return nativePayloadSchema.parse(result);
  }

  async #reconstructImages(input: CommandEnvelope, session: RuntimeNodeSessionRecord): Promise<CommandEnvelope["request"]> {
    if (!input.images?.length) return input.request;
    if (input.images.length > this.#images.limits().maximumImagesPerCommand) throw new RuntimeNodeProtocolError("RESOURCE_EXHAUSTED", "command contains too many images");
    if (input.images.reduce((sum, slot) => sum + slot.image.byteLength, 0) > 50 * 1_024 * 1_024) throw new RuntimeNodeProtocolError("RESOURCE_EXHAUSTED", "command image bytes exceed the 50 MiB total bound");
    const codec = this.#launchRegistry.backendForSession(session).adapter.imageCodec;
    for (const slot of input.images) {
      if (codec?.acceptsCommandImage?.(input.request, slot) !== true) throw new RuntimeNodeProtocolError("FENCED", "command image pointer is outside the adapter image input allowlist");
    }
    const json = structuredClone(input.request) as unknown as JsonValue;
    const seen = new Set<string>();
    for (const slot of input.images) {
      if (seen.has(slot.pointer) || nativeImagePointerValue(json, slot.pointer) !== null) throw new RuntimeNodeProtocolError("FENCED", "command image must target a unique null leaf");
      seen.add(slot.pointer);
      const image = slot.image;
      const bytes = await this.#images.getBytes(this.#imageTarget(session), image);
      const value = slot.representation === "base64" ? bytes.toString("base64") : `data:${image.mediaType};base64,${bytes.toString("base64")}`;
      const segments = slot.pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (!slot.pointer || segments.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) throw new RuntimeNodeProtocolError("FENCED", "command image pointer is unsafe");
      let parent = json;
      for (const key of segments.slice(0, -1)) parent = (parent as Record<string, JsonValue>)[key]!;
      (parent as Record<string, JsonValue>)[segments.at(-1)!] = value;
    }
    return harnessCommandSchema.parse(json);
  }

  public terminalGet(input: TerminalGetInput): TerminalDescriptor | null {
    this.#assertOpen();
    this.#terminalBinding(input, false);
    return this.#terminals.get(input);
  }

  public terminalOpen(input: TerminalOpenInput): Promise<TerminalOpenResult> {
    return this.#admit(() => this.#terminals.open(this.#terminalBinding(input, true), input));
  }

  public terminalAttach(
    input: TerminalAttachInput,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalStreamItem> {
    this.#assertOpen();
    this.#terminalBinding(input, false);
    return this.#terminals.attach(input, signal);
  }

  public terminalLeaseAcquire(input: TerminalLeaseAcquireInput): TerminalLeaseAcquireResult {
    this.#assertOpen();
    this.#terminalBinding(input, false);
    return this.#terminals.acquire(input);
  }

  public terminalLeaseRenew(input: TerminalLeaseRenewInput): TerminalLeaseRenewResult {
    this.#assertOpen();
    this.#terminalBinding(input, false);
    return this.#terminals.renew(input);
  }

  public terminalLeaseRelease(input: TerminalLeaseReleaseInput): TerminalLeaseReleaseResult {
    this.#assertOpen();
    this.#terminalBinding(input, false);
    return this.#terminals.release(input);
  }

  public terminalInput(input: TerminalInput): TerminalInputResult {
    this.#assertOpen();
    this.#terminalBinding(input, false);
    return this.#terminals.input(input);
  }

  public terminalTerminate(input: TerminalTerminateInput): TerminalDescriptor {
    this.#assertOpen();
    this.#terminalBinding(input, false);
    return this.#terminals.terminate(input);
  }

  public listInteractions(sessionId?: SessionId): InteractionRecord[] {
    return [...this.#pendingInteractions.values()]
      .map(({ record }) => record)
      .filter((record) => !sessionId || record.sessionId === sessionId);
  }

  public resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord> {
    return this.#admit(() => this.#resolveInteraction(input));
  }

  async #resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord> {
    const completed = this.#resolvedInteractions.get(input.interactionId);
    if (completed) {
      this.#assertInteractionBinding(completed, input);
      if (
        completed.resolution === undefined ||
        canonicalJson(completed.resolution.json) !== canonicalJson(input.response)
      ) {
        throw new RuntimeNodeProtocolError(
          "CONFLICT",
          "interaction was already resolved with another response",
        );
      }
      return completed;
    }

    const pending = this.#pendingInteractions.get(input.interactionId);
    if (!pending) throw new RuntimeNodeProtocolError("NOT_FOUND", "pending interaction not found");
    this.#assertInteractionBinding(pending.record, input);
    const response = canonicalJson(input.response);
    if (pending.resolving) {
      if (pending.resolving.response !== response) {
        throw new RuntimeNodeProtocolError(
          "CONFLICT",
          "interaction resolution is already in progress with another response",
        );
      }
      return pending.resolving.result;
    }

    // Defer native dispatch by one microtask so the in-flight marker is visible
    // before a duplicate request can enter the adapter callback.
    const result = Promise.resolve().then(() =>
      this.#completeInteraction(input.interactionId, pending, input.response),
    );
    pending.resolving = { response, result };
    try {
      return await result;
    } finally {
      if (pending.resolving?.result === result) delete pending.resolving;
    }
  }

  async #completeInteraction(
    interactionId: string,
    pending: PendingInteraction,
    response: JsonValue,
  ): Promise<InteractionRecord> {
    const resolution = packNativePayload(response);
    await pending.native.resolve(response);
    if (
      pending.retired ||
      this.#pendingInteractions.get(interactionId) !== pending
    ) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "interaction was retired while its resolution was in flight",
      );
    }
    const resolved: InteractionRecord = {
      ...pending.record,
      state: "resolved",
      resolution,
      resolvedAt: now(),
    };
    this.#pendingInteractions.delete(interactionId);
    this.#rememberResolvedInteraction(resolved);
    this.#events.publish({
      kind: "control",
      change: { type: "interaction.changed", interaction: resolved },
    });
    return resolved;
  }

  #assertInteractionBinding(
    record: InteractionRecord,
    input: ResolveInteractionInput,
  ): void {
    if (record.sessionId !== input.sessionId || record.harness !== input.harness) {
      throw new RuntimeNodeProtocolError("FENCED", "interaction binding does not match");
    }
  }

  #rememberResolvedInteraction(record: InteractionRecord): void {
    this.#resolvedInteractions.set(record.interactionId, record);
    while (this.#resolvedInteractions.size > this.#resolvedInteractionCacheSize) {
      const oldest = this.#resolvedInteractions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#resolvedInteractions.delete(oldest);
    }
  }

  public events(cursor: RuntimeNodeEventCursor, signal?: AbortSignal) {
    const initialItems: RuntimeNodeEventItem[] = this.#store.listSessions().map(
      // Control-event cursors intentionally track only native byte/event
      // streams. Re-advertise every durable open binding before replaying
      // native rings so a control node which missed launch completion can
      // recover the reserved logical session identity after reconnect.
      (session) => ({
        kind: "control",
        change: { type: "session.upsert", session },
      }),
    );
    const interactions = [
      ...[...this.#pendingInteractions.values()].map(({ record }) => record),
      ...this.#resolvedInteractions.values(),
    ];
    initialItems.push(...interactions.map(
      (record) =>
        ({
          kind: "control",
          change: { type: "interaction.changed", interaction: record },
        }) as const,
    ));
    initialItems.push(
      ...this.#store.listLaunchEntries({ nonterminalOnly: true }).map(
        ({ record }) =>
          ({
            kind: "control",
            change: { type: "launch.changed", launch: record },
          }) as const,
      ),
      ...this.#store.listArchiveEntries({ nonterminalOnly: true }).map(
        ({ record }) =>
          ({
            kind: "control",
            change: { type: "archive.changed", archive: record },
          }) as const,
      ),
    );
    return this.#events.subscribe(cursor, signal, initialItems);
  }

  /** Canonical snapshot plus durable transferred and not-yet-flushed overlays. */
  public getMetadata(sessionId: SessionId): MetadataSnapshot {
    const record = this.#store.getSession(sessionId);
    if (!record || record.runtimeNodeId !== this.#runtimeNodeId) {
      throw new RuntimeNodeProtocolError("NOT_FOUND", "metadata session binding not found");
    }
    let visible = record.metadata;
    for (const operation of this.#store.listMetadataOperations({
      sessionId,
      status: "queued",
    })) {
      if (
        !record.metadataAuthority ||
        !sameAuthority(record.metadataAuthority, operation.authority)
      ) continue;
      visible = overlayTransferredOperation(visible, operation);
    }
    return overlayMetadata({
      canonical: visible,
      pending: this.#store
        .listSessionMetadataOutbox(sessionId)
        .filter(
          (patch) =>
            record.metadataAuthority !== undefined &&
            sameAuthority(record.metadataAuthority, patch.expectedAuthority),
        ),
    });
  }

  /** Agent/runtime-node mutation path; the control node remains canonical after flush. */
  public enqueueMetadata(patch: MetadataPatch): MetadataSnapshot {
    const record = this.#store.getSession(patch.sessionId);
    if (!record || record.runtimeNodeId !== this.#runtimeNodeId) {
      throw new RuntimeNodeProtocolError("NOT_FOUND", "metadata session binding not found");
    }
    if (!record.metadataAuthority) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "metadata authority is unknown until the control node reconciles this session",
      );
    }
    const archiving = this.#store
      .listArchiveEntriesForSession(patch.sessionId)
      .some(({ record: archive }) => !isTerminalArchive(archive.state));
    if (archiving) {
      throw new RuntimeNodeProtocolError(
        "CONFLICT",
        "cannot enqueue agent metadata while session archive is in progress",
      );
    }
    if (
      patch.expectedAuthority.realmId !== record.metadataAuthority.realmId ||
      patch.expectedAuthority.controlNodeId !==
        record.metadataAuthority.controlNodeId ||
      patch.expectedAuthority.epochId !== record.metadataAuthority.epochId
    ) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "metadata patch targets a stale or unrelated authority",
      );
    }
    this.#store.enqueueMetadata(patch);
    return this.getMetadata(patch.sessionId);
  }

  public metadataOutbox(): MetadataPatch[] {
    return this.#store.listMetadataOutbox();
  }

  public settleMetadataOutbox(records: readonly MetadataOperationRecord[]): void {
    this.#store.settleMetadataOutbox(records);
  }

  /** Apply a later terminal receipt for an operation already transferred as queued. */
  public applyMetadataSettlement(record: MetadataOperationRecord): MetadataOperationRecord {
    return this.#store.applyMetadataSettlement(record);
  }

  public getMetadataOperation(
    operationId: MetadataOperationRecord["operationId"],
  ): MetadataOperationRecord | undefined {
    return this.#store.getMetadataOperation(operationId);
  }

  public listMetadataOperations(
    filter: {
      sessionId?: SessionId;
      status?: MetadataOperationRecord["status"];
    } = {},
  ): MetadataOperationRecord[] {
    return this.#store.listMetadataOperations(filter);
  }

  /** Apply a control-node-authoritative snapshot without inventing authority locally. */
  public applyCanonicalMetadata(sessionId: SessionId, metadata: MetadataSnapshot): void {
    const record = this.#store.getSession(sessionId);
    if (!record || record.runtimeNodeId !== this.#runtimeNodeId) return;
    if (!record.metadataAuthority) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "cannot apply canonical metadata before authority is known",
      );
    }
    this.#store.putSession({
      ...record,
      metadata: mergeCanonicalMetadata(record, metadata, record.metadataAuthority),
      updatedAt: now(),
    });
  }

  public close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    // Closing fences admission synchronously. Already admitted work retains its
    // adapter/provider access until its complete operation (including cleanup)
    // settles; failures remain visible through its original result or journal.
    await Promise.allSettled([
      ...this.#admitted,
      ...this.#launchTasks,
      ...this.#archiveTasks,
    ]);
    this.#acceptingNativeEvents = false;
    await Promise.allSettled(this.#nativeEventTasks.keys());
    const errors = await collectCleanupErrors([() => this.#terminals.close()]);
    errors.push(...await collectCleanupErrors(
      [...this.#active.values()].map(({ session, unsubscribe }) => async () => {
        const sessionErrors = await collectCleanupErrors([unsubscribe]);
        sessionErrors.push(...await collectCleanupErrors([() => session.stop()]));
        if (sessionErrors.length > 0) {
          throw new AggregateError(sessionErrors, "runtime session cleanup failed");
        }
      }),
    ));
    this.#active.clear();
    this.#pendingInteractions.clear();
    this.#resolvedInteractions.clear();
    // Backend processes may depend on provider-owned resources during close.
    errors.push(...await collectCleanupErrors([() => this.#launchRegistry.closeBackends()]));
    errors.push(...await collectCleanupErrors([() => this.#launchRegistry.closeProviders()]));
    errors.push(...await collectCleanupErrors([() => this.#images.close()]));
    if (errors.length > 0) throw new AggregateError(errors, "runtime node cleanup failed");
  }

  #assertOpen(): void {
    if (this.#closed) throw new RuntimeNodeProtocolError("FENCED", "runtime node is closing");
  }

  #admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new RuntimeNodeProtocolError("FENCED", "runtime node is closing"));
    }
    // Track before calling adapter/provider code, including reentrant close(),
    // while preserving the operation's existing synchronous admission timing.
    let complete!: (value: T | PromiseLike<T>) => void;
    let fail!: (error: unknown) => void;
    const task = new Promise<T>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    this.#admitted.add(task);
    const release = () => { this.#admitted.delete(task); };
    void task.then(release, release);
    try {
      complete(operation());
    } catch (error) {
      fail(error);
    }
    return task;
  }

  #recoverDurableOperations(): void {
    if (this.#closed) return;
    for (const { record } of this.#store.listLaunchEntries({ nonterminalOnly: true })) {
      this.#scheduleLaunch(record.launchId);
    }
    for (const { record } of this.#store.listArchiveEntries({ nonterminalOnly: true })) {
      this.#scheduleArchive(record.archiveOperationId);
    }
  }

  #scheduleLaunch(launchId: LaunchId): void {
    if (this.#closed || this.#scheduledLaunches.has(launchId)) return;
    const entry = this.#store.getLaunchEntry(launchId);
    if (!entry || isTerminalLaunch(entry.record.state)) return;
    this.#scheduledLaunches.add(launchId);
    const task = this.#serialize(entry.record.sessionId, () => this.#runLaunch(launchId))
      .catch((error) => this.#settleUnexpectedLaunchError(launchId, error));
    this.#launchTasks.add(task);
    const release = () => {
      this.#launchTasks.delete(task);
      this.#scheduledLaunches.delete(launchId);
    };
    void task.then(release, release);
  }

  async #runLaunch(launchId: LaunchId): Promise<void> {
    let entry = this.#store.getLaunchEntry(launchId);
    if (!entry || isTerminalLaunch(entry.record.state)) return;
    let provider: RuntimeLaunchProvider;
    try {
      provider = this.#launchRegistry.provider(entry.request.profile);
      if (provider.descriptor.implementationVersion !== entry.record.implementationVersion) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `launch provider implementation changed from ${entry.record.implementationVersion} to ${provider.descriptor.implementationVersion}`,
        );
      }
    } catch (error) {
      this.#settleLaunch(
        entry,
        entry.record.state === "accepted" ? "failed" : "outcomeUnknown",
        errorText(error),
      );
      return;
    }

    if (entry.record.state === "accepted") {
      try {
        // Validation is part of durable execution rather than pre-admission.
        // Once a control node reserves a launch ID, every well-addressed
        // request must have a runtime journal entry that can converge to a
        // definite failure instead of leaving an authority-side reservation
        // permanently ambiguous.
        provider.validateInput(entry.request.input, entry.request.harness);
      } catch (error) {
        this.#settleLaunch(entry, "failed", errorText(error));
        return;
      }
      entry = this.#transitionLaunch(entry, "preparing", "preparing launch resources");
      await this.#prepareAndStart(entry, provider);
      return;
    }
    if (entry.record.state === "preparing") {
      let recovery;
      try {
        recovery = await provider.recoverPreparation(
          this.#launchPreparationContext(entry),
        );
      } catch (error) {
        this.#settleLaunch(entry, "outcomeUnknown", errorText(error));
        return;
      }
      entry = this.#store.getLaunchEntry(launchId) ?? entry;
      if (recovery.state === "outcomeUnknown") {
        this.#settleLaunch(entry, "outcomeUnknown", recovery.reason);
        return;
      }
      if (recovery.state === "retryPreparation") {
        await this.#prepareAndStart(entry, provider);
        return;
      }
      let prepared: RuntimePreparedLaunch;
      try {
        prepared = this.#validatePreparedLaunch(entry.request, recovery.prepared);
      } catch (error) {
        await this.#compensateLaunch(entry, provider, error);
        return;
      }
      entry = { ...entry, preparation: prepared };
      this.#store.putLaunchEntry(entry);
      await this.#startNative(entry, provider);
      return;
    }
    if (entry.record.state === "cleanupPending") {
      await this.#finishLaunchCompensation(entry, provider);
      return;
    }
    if (entry.record.state === "nativeStarting") {
      this.#settleLaunch(
        entry,
        "outcomeUnknown",
        "runtime node restarted after native launch dispatch; native outcome requires reconciliation",
      );
    }
  }

  async #prepareAndStart(
    entry: RuntimeLaunchJournalEntry,
    provider: RuntimeLaunchProvider,
  ): Promise<void> {
    let prepared: RuntimePreparedLaunch;
    try {
      prepared = this.#validatePreparedLaunch(
        entry.request,
        await provider.prepare(this.#launchPreparationContext(entry)),
      );
      entry = this.#store.getLaunchEntry(entry.record.launchId) ?? entry;
      entry = { ...entry, preparation: prepared };
      this.#store.putLaunchEntry(entry);
    } catch (error) {
      entry = this.#store.getLaunchEntry(entry.record.launchId) ?? entry;
      if (error instanceof LaunchProviderOutcomeUnknownError) {
        this.#settleLaunch(entry, "outcomeUnknown", errorText(error));
      } else {
        await this.#compensateLaunch(entry, provider, error);
      }
      return;
    }
    await this.#startNative(entry, provider);
  }

  async #startNative(
    entry: RuntimeLaunchJournalEntry,
    provider: RuntimeLaunchProvider,
  ): Promise<void> {
    if (!entry.preparation) {
      this.#settleLaunch(entry, "outcomeUnknown", "durable launch preparation is missing");
      return;
    }
    const preparation = entry.preparation;
    let options: HarnessSpawnOptions;
    try {
      options = await this.#validateSpawnOptions(preparation.spawnOptions);
    } catch (error) {
      await this.#compensateLaunch(entry, provider, error);
      return;
    }
    entry = this.#transitionLaunch(entry, "nativeStarting", "starting native session");
    const backend = this.#launchRegistry.backend(preparation.backendId);
    let session: AdapterSession;
    try {
      session = await backend.adapter.spawn(options);
    } catch (error) {
      if (error instanceof AdapterOutcomeUnknownError) {
        this.#settleLaunch(entry, "outcomeUnknown", errorText(error));
      } else {
        await this.#compensateLaunch(entry, provider, error);
      }
      return;
    }
    try {
      await this.#assertSpawnedSession(entry.request, options, backend, session);
      this.#activate(entry.request.sessionId, session);
      const installedActive = this.#active.get(entry.request.sessionId)?.session === session;
      const record = this.#recordForHandle(entry.request.sessionId, session, {
        ...(entry.request.metadata === undefined
          ? {}
          : { initialMetadataValues: entry.request.metadata }),
        launchProvenance: {
          launchId: entry.request.launchId,
          profileId: entry.request.profile.profileId,
          providerId: entry.request.profile.providerId,
          backendId: backend.backendId,
          contractVersion: entry.request.profile.contractVersion,
          requestSchemaHash: entry.request.profile.requestSchemaHash,
          implementationVersion: entry.record.implementationVersion,
        },
        installedActive,
      });
      const succeeded: RuntimeLaunchJournalEntry = {
        ...entry,
        record: {
          ...entry.record,
          state: "succeeded",
          result: {
            sessionId: record.sessionId,
            adapterScopeId: record.adapterScopeId,
            vendorSessionId: record.vendorSessionId,
            backendId: backend.backendId,
            bindingRevision: record.bindingRevision,
          },
          statusMessage: "native session bound",
          updatedAt: now(),
        },
        pendingFailure: null,
      };
      this.#store.commitLaunchSuccess(succeeded, record);
      this.#publishSession(record);
      this.#publishLaunch(succeeded.record);
    } catch (error) {
      const active = this.#active.get(entry.request.sessionId);
      active?.unsubscribe();
      if (active) this.#active.delete(entry.request.sessionId);
      this.#settleLaunch(entry, "outcomeUnknown", errorText(error));
    }
  }

  async #compensateLaunch(
    entry: RuntimeLaunchJournalEntry,
    provider: RuntimeLaunchProvider,
    cause: unknown,
  ): Promise<void> {
    const pendingFailure = errorText(cause);
    entry = {
      ...entry,
      record: {
        ...entry.record,
        state: "cleanupPending",
        result: undefined,
        error: undefined,
        statusMessage: "compensating failed launch preparation",
        updatedAt: now(),
      },
      pendingFailure,
    };
    this.#store.putLaunchEntry(entry);
    this.#publishLaunch(entry.record);
    await this.#finishLaunchCompensation(entry, provider);
  }

  async #finishLaunchCompensation(
    entry: RuntimeLaunchJournalEntry,
    provider: RuntimeLaunchProvider,
  ): Promise<void> {
    try {
      await provider.compensate(
        this.#launchPreparationContext(entry),
        entry.pendingFailure ?? "launch preparation failed",
      );
      entry = this.#store.getLaunchEntry(entry.record.launchId) ?? entry;
      this.#settleLaunch(
        { ...entry, pendingFailure: null },
        "failed",
        entry.pendingFailure ?? "launch preparation failed",
      );
    } catch (error) {
      entry = this.#store.getLaunchEntry(entry.record.launchId) ?? entry;
      if (error instanceof LaunchProviderOutcomeUnknownError) {
        this.#settleLaunch(entry, "outcomeUnknown", errorText(error));
        return;
      }
      const pending: RuntimeLaunchJournalEntry = {
        ...entry,
        record: {
          ...entry.record,
          statusMessage: `cleanup pending: ${errorText(error)}`,
          updatedAt: now(),
        },
      };
      this.#store.putLaunchEntry(pending);
      this.#publishLaunch(pending.record);
    }
  }

  #launchPreparationContext(
    entry: RuntimeLaunchJournalEntry,
  ): LaunchPreparationContext {
    return {
      request: entry.request,
      checkpoint: entry.checkpoint,
      prepared: entry.preparation,
      saveCheckpoint: (checkpoint) => {
        const latest = this.#store.getLaunchEntry(entry.record.launchId);
        if (!latest || isTerminalLaunch(latest.record.state)) {
          throw new RuntimeNodeProtocolError("FENCED", "launch is no longer mutable");
        }
        this.#store.putLaunchEntry({
          ...latest,
          checkpoint: toJsonValue(checkpoint) as JsonObject,
        });
      },
      backend: (backendId) => this.#launchRegistry.backend(backendId),
    };
  }

  #validatePreparedLaunch(
    request: LaunchRequest,
    prepared: RuntimePreparedLaunch,
  ): RuntimePreparedLaunch {
    const parsed = parseRuntimePreparedLaunch(prepared);
    const backend = this.#launchRegistry.backend(parsed.backendId);
    if (
      parsed.spawnOptions.harness !== request.harness ||
      backend.adapter.harness !== request.harness
    ) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "launch provider selected a backend or native request for another harness",
      );
    }
    return parsed;
  }

  #transitionLaunch(
    entry: RuntimeLaunchJournalEntry,
    state: "preparing" | "nativeStarting",
    statusMessage: string,
  ): RuntimeLaunchJournalEntry {
    const next: RuntimeLaunchJournalEntry = {
      ...entry,
      record: {
        ...entry.record,
        state,
        statusMessage,
        result: undefined,
        error: undefined,
        updatedAt: now(),
      },
    };
    this.#store.putLaunchEntry(next);
    this.#publishLaunch(next.record);
    return next;
  }

  #settleLaunch(
    entry: RuntimeLaunchJournalEntry,
    state: "failed" | "outcomeUnknown",
    error: string,
  ): void {
    const settled: RuntimeLaunchJournalEntry = {
      ...entry,
      record: {
        ...entry.record,
        state,
        result: undefined,
        statusMessage: undefined,
        error,
        updatedAt: now(),
      },
    };
    this.#store.putLaunchEntry(settled);
    this.#publishLaunch(settled.record);
  }

  #settleUnexpectedLaunchError(launchId: LaunchId, error: unknown): void {
    const entry = this.#store.getLaunchEntry(launchId);
    if (!entry || isTerminalLaunch(entry.record.state)) return;
    this.#settleLaunch(entry, "outcomeUnknown", errorText(error));
  }

  #scheduleArchive(archiveOperationId: ArchiveRequest["archiveOperationId"]): void {
    if (this.#closed || this.#scheduledArchives.has(archiveOperationId)) return;
    const entry = this.#store.getArchiveEntry(archiveOperationId);
    if (!entry || isTerminalArchive(entry.record.state)) return;
    this.#scheduledArchives.add(archiveOperationId);
    const task = this.#serialize(entry.record.sessionId, () =>
      this.#runArchive(archiveOperationId),
    ).catch((error) => this.#settleUnexpectedArchiveError(archiveOperationId, error));
    this.#archiveTasks.add(task);
    const release = () => {
      this.#archiveTasks.delete(task);
      this.#scheduledArchives.delete(archiveOperationId);
    };
    void task.then(release, release);
  }

  async #runArchive(
    archiveOperationId: ArchiveRequest["archiveOperationId"],
  ): Promise<void> {
    let entry = this.#store.getArchiveEntry(archiveOperationId);
    if (!entry || isTerminalArchive(entry.record.state)) return;
    const session = this.#store.getSession(entry.request.sessionId);
    if (!session) {
      this.#settleArchive(entry, "outcomeUnknown", "session disappeared before cleanup settled");
      return;
    }
    if (this.#store.listSessionMetadataOutbox(session.sessionId).length > 0) {
      this.#settleArchive(
        entry,
        "failed",
        "pending agent metadata was not flushed before cleanup began",
      );
      return;
    }
    if (
      this.#active.has(session.sessionId) ||
      session.availability === "active" ||
      session.runtimeStatus !== "stopped"
    ) {
      this.#settleArchive(entry, "failed", "session is no longer stopped");
      return;
    }
    if (entry.record.state === "accepted") {
      entry = {
        ...entry,
        record: { ...entry.record, state: "releasing", updatedAt: now() },
      };
      this.#store.putArchiveEntry(entry);
      this.#publishArchive(entry.record);
    }
    const backend = this.#launchRegistry.backendForSession(session);
    if (!entry.backendReleased) {
      try {
        if (backend.releaseSession) await backend.releaseSession(session);
        else await backend.adapter.releaseSession?.(session);
        entry = { ...entry, backendReleased: true };
        this.#store.putArchiveEntry(entry);
      } catch (error) {
        this.#settleArchive(
          entry,
          error instanceof AdapterOutcomeUnknownError ? "outcomeUnknown" : "failed",
          errorText(error),
        );
        return;
      }
    }
    if (!entry.providerReleased) {
      try {
        const providerContext = this.#sessionProviderContext(session);
        await providerContext?.provider.release(providerContext.context);
        entry = { ...entry, providerReleased: true };
        this.#store.putArchiveEntry(entry);
      } catch (error) {
        this.#settleArchive(
          entry,
          error instanceof LaunchProviderOutcomeUnknownError ? "outcomeUnknown" : "failed",
          errorText(error),
        );
        return;
      }
    }
    await Promise.allSettled([...this.#nativeEventTasks]
      .filter(([, sessionId]) => sessionId === session.sessionId)
      .map(([task]) => task));
    await this.#images.releaseSession(session.sessionId);
    const timestamp = now();
    const succeeded: RuntimeArchiveJournalEntry = {
      ...entry,
      record: {
        ...entry.record,
        state: "succeeded",
        releasedAt: timestamp,
        catalogRevision: entry.request.bindingRevision + 1,
        error: undefined,
        updatedAt: timestamp,
      },
    };
    this.#store.commitArchiveSuccess(succeeded, session);
    this.#terminals.invalidateSession(session.sessionId, "session was archived");
    this.#retireInteractions(session.sessionId, session.runtimeEpoch ?? "", true);
    this.#publishArchive(succeeded.record);
  }

  #settleArchive(
    entry: RuntimeArchiveJournalEntry,
    state: "failed" | "outcomeUnknown",
    error: string,
  ): void {
    const settled: RuntimeArchiveJournalEntry = {
      ...entry,
      record: {
        ...entry.record,
        state,
        releasedAt: null,
        catalogRevision: undefined,
        error,
        updatedAt: now(),
      },
    };
    this.#store.putArchiveEntry(settled);
    this.#publishArchive(settled.record);
  }

  #settleUnexpectedArchiveError(
    archiveOperationId: ArchiveRequest["archiveOperationId"],
    error: unknown,
  ): void {
    const entry = this.#store.getArchiveEntry(archiveOperationId);
    if (!entry || isTerminalArchive(entry.record.state)) return;
    this.#settleArchive(entry, "outcomeUnknown", errorText(error));
  }

  #sessionProviderContext(session: RuntimeNodeSessionRecord): {
    provider: RuntimeLaunchProvider;
    context: LaunchSessionContext;
  } | undefined {
    if (!session.launchProvenance) return undefined;
    const launch = this.#store.getLaunchEntry(session.launchProvenance.launchId);
    if (!launch?.preparation || launch.record.state !== "succeeded") {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `provider launch journal is unavailable for session ${session.sessionId}`,
      );
    }
    const provider = this.#launchRegistry.provider(session.launchProvenance);
    if (
      launch.preparation.backendId !== session.launchProvenance.backendId ||
      launch.record.implementationVersion !== session.launchProvenance.implementationVersion ||
      provider.descriptor.implementationVersion !==
        session.launchProvenance.implementationVersion
    ) {
      throw new RuntimeNodeProtocolError("FENCED", "session launch provenance diverged");
    }
    const context: LaunchSessionContext = {
      session,
      prepared: launch.preparation,
      checkpoint: launch.checkpoint,
      saveCheckpoint: (checkpoint) => {
        const latest = this.#store.getLaunchEntry(launch.record.launchId);
        if (!latest) throw new RuntimeNodeProtocolError("FENCED", "launch journal disappeared");
        this.#store.putLaunchEntry({
          ...latest,
          checkpoint: toJsonValue(checkpoint) as JsonObject,
        });
      },
      backend: (backendId) => this.#launchRegistry.backend(backendId),
    };
    return { provider, context };
  }

  async #resumePlan(
    session: RuntimeNodeSessionRecord,
    purpose: "interactive" | "history",
  ): Promise<{ backend: RuntimeAgentBackend; resumeOptions: HarnessResumeOptions }> {
    const defaults = nativeResumeOptions(session);
    const providerContext = this.#sessionProviderContext(session);
    if (!providerContext) {
      return {
        backend: this.#launchRegistry.backendForSession(session),
        resumeOptions: defaults,
      };
    }
    const prepared = providerContext.provider.prepareResume
      ? await providerContext.provider.prepareResume({
          ...providerContext.context,
          purpose,
          defaults,
        })
      : {
          backendId: providerContext.context.prepared.backendId,
          resumeOptions: defaults,
        };
    const backend = this.#launchRegistry.backend(prepared.backendId);
    if (backend.backendId !== session.launchProvenance?.backendId) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "provider resume selected a backend outside immutable launch provenance",
      );
    }
    return { backend, resumeOptions: harnessResumeOptionsSchema.parse(prepared.resumeOptions) };
  }

  async #validateSpawnOptions(options: HarnessSpawnOptions): Promise<HarnessSpawnOptions> {
    const cwd = await this.#pathPolicy.validate(options.cwd);
    const additionalDirectories =
      options.harness === "copilot" && options.additionalDirectories
        ? await waitForAll(
            options.additionalDirectories.map((path) => this.#pathPolicy.validate(path)),
          )
        : undefined;
    return this.#nativePathPolicy.spawn(harnessSpawnOptionsSchema.parse({
      ...options,
      cwd,
      ...(additionalDirectories ? { additionalDirectories } : {}),
    }));
  }

  async #validateResumeOptions(
    session: RuntimeNodeSessionRecord,
    options: HarnessResumeOptions,
  ): Promise<HarnessResumeOptions> {
    if (
      options.harness !== session.harness ||
      options.vendorSessionId !== session.vendorSessionId
    ) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "provider resume options do not match the immutable native binding",
      );
    }
    const backend = this.#launchRegistry.backendForSession(session);
    const cwd = await this.#attachmentCwd({
      sessionId: session.sessionId,
      adapter: backend.adapter,
      harness: session.harness,
      vendorSessionId: session.vendorSessionId,
      ...(options.cwd === undefined ? {} : { requestedCwd: options.cwd }),
    });
    const additionalDirectories =
      options.harness === "copilot" && options.additionalDirectories
        ? await waitForAll(
            options.additionalDirectories.map((path) => this.#pathPolicy.validate(path)),
          )
        : undefined;
    return this.#nativePathPolicy.resume(harnessResumeOptionsSchema.parse({
      ...options,
      cwd,
      ...(additionalDirectories ? { additionalDirectories } : {}),
    }));
  }

  #boundSessionForCommand(
    input: Pick<ResumeCommand, "sessionId" | "runtimeNodeId" | "bindingRevision">,
    operation: string,
  ): RuntimeNodeSessionRecord {
    if (input.runtimeNodeId !== this.#runtimeNodeId) {
      throw new RuntimeNodeProtocolError("FENCED", `${operation} targets another runtime node`);
    }
    const session = this.#store.getSession(input.sessionId);
    if (!session) throw new RuntimeNodeProtocolError("NOT_FOUND", "session binding not found");
    this.#assertBindingRevision(session, input.bindingRevision);
    return session;
  }

  #assertBindingRevision(session: RuntimeNodeSessionRecord, revision: number): void {
    if (session.bindingRevision !== revision) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `binding revision ${revision} is stale; current is ${session.bindingRevision}`,
      );
    }
  }

  async #assertSpawnedSession(
    request: LaunchRequest,
    options: HarnessSpawnOptions,
    backend: RuntimeAgentBackend,
    session: AdapterSession,
  ): Promise<void> {
    if (
      session.harness !== request.harness ||
      session.adapterScopeId !== backend.adapter.adapterScopeId ||
      backend.adapter.harness !== request.harness
    ) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "native backend returned a session outside its registered scope",
      );
    }
    if (session.cwd === null) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "native backend returned a launched session without a workspace",
      );
    }
    const cwd = await this.#pathPolicy.validate(session.cwd);
    if (cwd !== options.cwd) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "native backend returned a launched session in another workspace",
      );
    }
    if (this.#store.isNativeBindingArchived(session)) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `native backend reused archived session ${session.vendorSessionId}`,
      );
    }
  }

  #assertAdapterSession(
    record: RuntimeNodeSessionRecord,
    backend: RuntimeAgentBackend,
    session: AdapterSession,
  ): void {
    if (
      backend.adapter.harness !== record.harness ||
      backend.adapter.adapterScopeId !== record.adapterScopeId ||
      session.harness !== record.harness ||
      session.adapterScopeId !== record.adapterScopeId ||
      session.vendorSessionId !== record.vendorSessionId
    ) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "native backend resumed a session outside the immutable binding",
      );
    }
  }

  async #validateResumedHandle(
    record: RuntimeNodeSessionRecord,
    options: HarnessResumeOptions,
    backend: RuntimeAgentBackend,
    session: AdapterSession,
  ): Promise<void> {
    try {
      this.#assertAdapterSession(record, backend, session);
      if (session.cwd === null) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          "native backend resumed a session without a workspace",
        );
      }
      const cwd = await this.#pathPolicy.validate(session.cwd);
      if (cwd !== options.cwd) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          "native backend resumed a session in another workspace",
        );
      }
    } catch (error) {
      try {
        await session.stop();
      } catch (cleanupError) {
        throw new AdapterOutcomeUnknownError(
          `${errorText(error)}; mismatched native handle cleanup failed: ${errorText(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  #persistStopped(record: RuntimeNodeSessionRecord): RuntimeNodeSessionRecord {
    const timestamp = now();
    const stopped: RuntimeNodeSessionRecord = {
      ...record,
      availability: "resumable",
      runtimeStatus: "stopped",
      runtimeEpoch: null,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.#store.putSession(stopped);
    this.#publishSession(stopped);
    return stopped;
  }

  #assertSameLaunch(current: LaunchRequest, proposed: LaunchRequest): void {
    if (canonicalProtocolRecordJson(current) !== canonicalProtocolRecordJson(proposed)) {
      throw new RuntimeNodeProtocolError(
        "PAYLOAD_MISMATCH",
        `launch ${proposed.launchId} was already used with another payload`,
      );
    }
  }

  #assertSameArchive(current: ArchiveRequest, proposed: ArchiveRequest): void {
    if (canonicalProtocolRecordJson(current) !== canonicalProtocolRecordJson(proposed)) {
      throw new RuntimeNodeProtocolError(
        "PAYLOAD_MISMATCH",
        `archive operation ${proposed.archiveOperationId} was already used with another payload`,
      );
    }
  }

  #publishSession(session: RuntimeNodeSessionRecord): void {
    this.#events.publish({
      kind: "control",
      change: { type: "session.upsert", session },
    });
  }

  #publishLaunch(launch: LaunchRecord): void {
    this.#events.publish({
      kind: "control",
      change: { type: "launch.changed", launch },
    });
  }

  #publishArchive(archive: ArchiveRecord): void {
    this.#events.publish({
      kind: "control",
      change: { type: "archive.changed", archive },
    });
  }

  #modelsForHarness(harness: Harness, models: readonly NativeModel[]): NativeModel[] {
    if (models.some((model) => model.harness !== harness)) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `model catalog for ${harness} contained another harness`,
      );
    }
    return deduplicateModels(models);
  }

  #terminalBinding(
    target: Pick<TerminalGetInput, "sessionId" | "runtimeNodeId" | "bindingRevision">,
    requireActive: boolean,
  ): TerminalBinding {
    if (target.runtimeNodeId !== this.#runtimeNodeId) {
      throw new RuntimeNodeProtocolError("FENCED", "terminal targets another runtime node");
    }
    const record = this.#store.getSession(target.sessionId);
    if (!record) throw new RuntimeNodeProtocolError("NOT_FOUND", "session binding not found");
    if (record.bindingRevision !== target.bindingRevision) {
      throw new RuntimeNodeProtocolError("FENCED", "terminal targets a stale binding revision");
    }
    if (requireActive && !this.#active.has(target.sessionId)) {
      throw new RuntimeNodeProtocolError(
        "CONFLICT",
        "session must be resumed through the structured API before opening a terminal",
      );
    }
    if (record.cwd === null) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        "terminal session has no validated working directory",
      );
    }
    return {
      target: {
        sessionId: target.sessionId,
        runtimeNodeId: target.runtimeNodeId,
        bindingRevision: target.bindingRevision,
      },
      harness: record.harness,
      adapterScopeId: record.adapterScopeId,
      vendorSessionId: record.vendorSessionId,
      cwd: record.cwd,
    };
  }

  async #attachmentCwd(input: {
    sessionId: SessionId;
    adapter: AgentAdapter;
    harness: Harness;
    vendorSessionId: string;
    requestedCwd?: string;
  }): Promise<string> {
    const existing = this.#store.getSession(input.sessionId);
    if (
      existing &&
      (existing.runtimeNodeId !== this.#runtimeNodeId ||
        existing.harness !== input.harness ||
        existing.adapterScopeId !== input.adapter.adapterScopeId ||
        existing.vendorSessionId !== input.vendorSessionId)
    ) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `session ${input.sessionId} is already bound to a different native session`,
      );
    }

    const matchingBindings = this.#store
      .listSessions()
      .filter(
        (record) =>
          record.runtimeNodeId === this.#runtimeNodeId &&
          record.harness === input.harness &&
          record.adapterScopeId === input.adapter.adapterScopeId &&
          record.vendorSessionId === input.vendorSessionId,
      );
    const conflictingBinding = matchingBindings.find(
      (record) => record.sessionId !== input.sessionId,
    );
    if (conflictingBinding) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `native session ${input.vendorSessionId} is already bound to logical session ${conflictingBinding.sessionId}`,
      );
    }
    if (input.requestedCwd !== undefined) {
      return this.#validateAttachmentCwd(input.requestedCwd, input.vendorSessionId);
    }
    if (existing?.cwd) {
      return this.#validateAttachmentCwd(existing.cwd, input.vendorSessionId);
    }

    const bindingCwds = matchingBindings
      .filter((record) => record.cwd !== null)
      .map((record) => record.cwd as string);
    if (bindingCwds.length > 0) {
      return this.#uniqueAttachmentCwd(
        bindingCwds,
        input.vendorSessionId,
        "stored runtime-node bindings",
      );
    }

    let inventory: NativeInventoryItem[];
    try {
      inventory = await input.adapter.listSessions();
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `cannot establish a safe working directory for native session ${input.vendorSessionId}; adapter inventory failed${detail}`,
      );
    }
    const matching = inventory.filter(
      (item) =>
        item.harness === input.harness &&
        item.adapterScopeId === input.adapter.adapterScopeId &&
        item.vendorSessionId === input.vendorSessionId,
    );
    if (matching.length === 0) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `cannot establish a safe working directory for unknown native session ${input.vendorSessionId}`,
      );
    }
    if (matching.some((item) => item.cwd === null)) {
      if (matching.every((item) => item.cwd === null)) {
        throw new RuntimeNodeProtocolError(
          "FENCED",
          `native session ${input.vendorSessionId} has no working directory to validate`,
        );
      }
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `native session ${input.vendorSessionId} has ambiguous working directories in adapter inventory`,
      );
    }
    return this.#uniqueAttachmentCwd(
      matching.map((item) => item.cwd as string),
      input.vendorSessionId,
      "adapter inventory",
    );
  }

  async #uniqueAttachmentCwd(
    candidates: readonly string[],
    vendorSessionId: string,
    source: string,
  ): Promise<string> {
    const canonical = await waitForAll(
      candidates.map((cwd) => this.#validateAttachmentCwd(cwd, vendorSessionId)),
    );
    const distinct = [...new Set(canonical)];
    if (distinct.length !== 1) {
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `native session ${vendorSessionId} has ambiguous working directories in ${source}`,
      );
    }
    return distinct[0]!;
  }

  async #validateAttachmentCwd(cwd: string, vendorSessionId: string): Promise<string> {
    try {
      return await this.#pathPolicy.validate(cwd);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new RuntimeNodeProtocolError(
        "FENCED",
        `refusing to attach native session ${vendorSessionId} with an unsafe working directory${detail}`,
      );
    }
  }

  #recordForHandle(
    sessionId: SessionId,
    session: AdapterSession,
    options: {
      initialMetadataValues?: Record<string, JsonValue>;
      existing?: RuntimeNodeSessionRecord;
      launchProvenance?: NonNullable<RuntimeNodeSessionRecord["launchProvenance"]>;
      installedActive?: boolean;
    } = {},
  ): RuntimeNodeSessionRecord {
    const timestamp = now();
    const existing = options.existing;
    const installedActive = options.installedActive ?? true;
    const harnessSettings = session.settings?.();
    return {
      sessionId,
      runtimeNodeId: this.#runtimeNodeId,
      harness: session.harness,
      adapterScopeId: session.adapterScopeId,
      vendorSessionId: session.vendorSessionId,
      bindingRevision: existing?.bindingRevision ?? 1,
      runtimeEpoch: installedActive ? session.runtimeEpoch : null,
      cwd: session.cwd,
      availability: installedActive ? "active" : "resumable",
      runtimeStatus: installedActive ? session.status() : "stopped",
      ...(harnessSettings !== undefined
        ? { harnessSettings }
        : existing?.harnessSettings === undefined
          ? {}
          : { harnessSettings: existing.harnessSettings }),
      ...(existing?.nativeSummary === undefined
        ? {}
        : { nativeSummary: existing.nativeSummary }),
      launchProvenance: existing?.launchProvenance ?? options.launchProvenance ?? null,
      metadata: existing?.metadata ?? {
        ...emptyMetadataSnapshot(),
        values: options.initialMetadataValues ?? {},
      },
      ...(existing?.metadataAuthority === undefined
        ? {}
        : { metadataAuthority: existing.metadataAuthority }),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
      lastActivityAt: timestamp,
    };
  }

  #activate(sessionId: SessionId, session: AdapterSession): void {
    const existing = this.#active.get(sessionId);
    existing?.unsubscribe();
    if (existing && existing.session.runtimeEpoch !== session.runtimeEpoch) {
      this.#terminals.invalidateSession(
        sessionId,
        "structured session runtime was replaced",
      );
      this.#retireInteractions(sessionId, existing.session.runtimeEpoch);
    }
    const binding: ActiveBinding = {
      session,
      sequence: 0,
      lastActivityPersistedAt: Date.now(),
      events: Promise.resolve(),
      pendingEvents: 0,
      pendingEventBytes: 0,
      eventOverflowed: false,
      queuedInteractions: new Set(),
      deferredLifecycle: new Map(),
      unsubscribe: () => undefined,
    };
    this.#active.set(sessionId, binding);
    try {
      const unsubscribe = session.subscribe((event) =>
        this.#queueAdapterEvent(sessionId, binding, event),
      );
      binding.unsubscribe = unsubscribe;
      // A synchronously replayed terminal status may have retired the binding
      // before subscribe returned its actual disposer.
      if (this.#active.get(sessionId) !== binding) unsubscribe();
    } catch (error) {
      if (this.#active.get(sessionId) === binding) this.#active.delete(sessionId);
      throw error;
    }
  }

  #queueAdapterEvent(sessionId: SessionId, binding: ActiveBinding, event: AdapterEvent): void {
    if (!this.#acceptingNativeEvents || this.#active.get(sessionId) !== binding) return;
    const hasPayload = event.kind === "native" || event.kind === "interaction";
    if (binding.eventOverflowed) {
      if (!hasPayload) this.#deferLifecycleEvent(sessionId, binding, event);
      return;
    }
    const session = this.#store.getSession(sessionId);
    const codec = session && this.#launchRegistry.backendForSession(session).adapter.imageCodec;
    // subscribe() can replay startup events before the launch transaction installs
    // its session row. Queue payloads until that synchronous commit completes;
    // terminal statuses still need to retire a stopped binding immediately.
    if (binding.pendingEvents === 0 && (!hasPayload || (session && !codec))) {
      try { this.#onAdapterEvent(sessionId, binding, event); }
      catch { this.#events.publish({ kind: "nativeGap", sessionId, reason: "native payload validation failed", recovery: "readNativeHistory" }); }
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (binding.pendingEvents >= this.#nativeEventQueueLimit || binding.pendingEventBytes + bytes > this.#nativeEventQueueBytes) {
      binding.eventOverflowed = binding.pendingEvents > 0;
      if (!hasPayload) this.#deferLifecycleEvent(sessionId, binding, event);
      this.#events.publish({ kind: "nativeGap", sessionId, reason: "native image extraction queue overflowed", recovery: "readNativeHistory" });
      return;
    }
    binding.pendingEvents += 1;
    binding.pendingEventBytes += bytes;
    if (event.kind === "interaction") binding.queuedInteractions.add(event);
    const task = binding.events.then(async () => {
      const current = this.#store.getSession(sessionId);
      if (!current || this.#active.get(sessionId) !== binding) return;
      const payload = hasPayload ? await this.#externalize(current, event.payload) : undefined;
      this.#onAdapterEvent(sessionId, binding, event, payload);
    }).catch(() => {
      this.#events.publish({ kind: "nativeGap", sessionId, reason: "native image extraction failed", recovery: "readNativeHistory" });
    });
    binding.events = task;
    this.#nativeEventTasks.set(task, sessionId);
    void task.then(() => {
      if (event.kind === "interaction") binding.queuedInteractions.delete(event);
      binding.pendingEvents -= 1;
      binding.pendingEventBytes -= bytes;
      if (binding.pendingEvents === 0) {
        const deferred = [...binding.deferredLifecycle.values()];
        binding.deferredLifecycle.clear();
        // Payload admission resumes only after all earlier lifecycle updates
        // have drained. A stopped binding then rejects every later callback.
        for (const update of deferred) {
          try { this.#onAdapterEvent(sessionId, binding, update); }
          catch { this.#events.publish({ kind: "nativeGap", sessionId, reason: "native lifecycle validation failed", recovery: "readNativeHistory" }); }
        }
        binding.eventOverflowed = false;
      }
      this.#nativeEventTasks.delete(task);
    });
  }

  #deferLifecycleEvent(
    sessionId: SessionId,
    binding: ActiveBinding,
    event: Exclude<AdapterEvent, { kind: "native" | "interaction" }>,
  ): void {
    let key: string = event.kind;
    if (event.kind === "interactionSettled") {
      // Never allocate entries for arbitrary request IDs. This buffer has at
      // most two snapshots plus one settlement per already admitted interaction
      // (including those still waiting for bounded payload extraction).
      const known = [...binding.queuedInteractions].some((queued) => queued.nativeRequestId === event.nativeRequestId) ||
        [...this.#pendingInteractions.values()].some(({ record }) => record.sessionId === sessionId &&
          record.runtimeEpoch === binding.session.runtimeEpoch && record.nativeRequestId === event.nativeRequestId);
      if (!known) return;
      key = `interaction:${event.nativeRequestId}`;
    } else if (event.kind === "status") {
      const previous = binding.deferredLifecycle.get(key);
      if (previous?.kind === "status" && previous.status === "stopped") return;
    }
    // Replacing a snapshot moves it to its latest arrival position, preserving
    // the relative order of the retained lifecycle updates after payload drain.
    binding.deferredLifecycle.delete(key);
    binding.deferredLifecycle.set(key, event);
  }

  #onAdapterEvent(sessionId: SessionId, binding: ActiveBinding, event: AdapterEvent, payload?: NativePayload): void {
    // Unsubscription cannot recall a callback that was already queued by an
    // adapter. Fence every callback by the installed binding so a retired
    // native runtime cannot overwrite or interleave with its replacement.
    if (this.#active.get(sessionId) !== binding) return;
    if (event.kind === "native") {
      const timestamp = Date.now();
      if (timestamp - binding.lastActivityPersistedAt >= 1_000) {
        const record = this.#store.getSession(sessionId);
        if (record) {
          const activityAt = new Date(timestamp).toISOString();
          this.#store.putSession({
            ...record,
            updatedAt: activityAt,
            lastActivityAt: activityAt,
          });
        }
        binding.lastActivityPersistedAt = timestamp;
      }
      this.#events.publish({
        kind: "native",
        sessionId,
        harness: binding.session.harness,
        runtimeEpoch: binding.session.runtimeEpoch,
        sequence: binding.sequence++,
        nativeType: event.nativeType,
        payload: payload ?? packNativePayload(event.payload),
        ephemeral: event.ephemeral,
      });
      return;
    }
    if (event.kind === "status") {
      const record = this.#store.getSession(sessionId);
      if (record) {
        const timestamp = now();
        const updated: RuntimeNodeSessionRecord = event.status === "stopped"
          ? {
              ...record,
              availability: "resumable",
              runtimeStatus: "stopped",
              runtimeEpoch: null,
              updatedAt: timestamp,
              lastSeenAt: timestamp,
            }
          : {
              ...record,
              runtimeStatus: event.status,
              updatedAt: timestamp,
              lastActivityAt: timestamp,
            };
        this.#store.putSession(updated);
        this.#publishSession(updated);
      }
      if (event.status === "stopped" && this.#active.get(sessionId) === binding) {
        this.#terminals.invalidateSession(
          sessionId,
          `structured ${binding.session.harness} session stopped`,
        );
        binding.unsubscribe();
        this.#active.delete(sessionId);
        this.#retireInteractions(sessionId, binding.session.runtimeEpoch, true);
      }
      return;
    }
    if (event.kind === "settings") {
      this.#persistHarnessSettings(sessionId, event.settings);
      return;
    }
    if (event.kind === "interactionSettled") {
      for (const [interactionId, pending] of this.#pendingInteractions) {
        if (
          pending.record.sessionId !== sessionId ||
          pending.record.runtimeEpoch !== binding.session.runtimeEpoch ||
          pending.record.nativeRequestId !== event.nativeRequestId
        ) {
          continue;
        }
        pending.retired = true;
        this.#pendingInteractions.delete(interactionId);
        const settled: InteractionRecord = {
          ...pending.record,
          state: event.state,
        };
        this.#rememberResolvedInteraction(settled);
        this.#events.publish({
          kind: "control",
          change: { type: "interaction.changed", interaction: settled },
        });
      }
      return;
    }
    const interactionId = newInteractionId();
    const record: InteractionRecord = {
      interactionId,
      sessionId,
      harness: binding.session.harness,
      runtimeEpoch: binding.session.runtimeEpoch,
      ...(event.nativeRequestId ? { nativeRequestId: event.nativeRequestId } : {}),
      requestType: event.requestType,
      payload: payload ?? packNativePayload(event.payload),
      ephemeral: event.ephemeral,
      state: "pending",
      createdAt: now(),
      expiresAt: event.expiresAt ?? null,
      resolvedAt: null,
    };
    this.#pendingInteractions.set(interactionId, {
      record,
      native: event,
      retired: false,
    });
    this.#events.publish({
      kind: "control",
      change: { type: "interaction.changed", interaction: record },
    });
  }

  #syncHarnessSettings(sessionId: SessionId, binding: ActiveBinding): void {
    const settings = binding.session.settings?.();
    if (settings !== undefined) this.#persistHarnessSettings(sessionId, settings);
  }

  #persistHarnessSettings(
    sessionId: SessionId,
    settings: HarnessSessionSettings,
  ): void {
    const record = this.#store.getSession(sessionId);
    if (!record) return;
    if (
      record.harnessSettings !== undefined &&
      canonicalJson(toJsonValue(record.harnessSettings)) ===
        canonicalJson(toJsonValue(settings))
    ) {
      return;
    }
    const updated = { ...record, harnessSettings: settings, updatedAt: now() };
    this.#store.putSession(updated);
    this.#events.publish({
      kind: "control",
      change: { type: "session.upsert", session: updated },
    });
  }

  #retireInteractions(
    sessionId: SessionId,
    runtimeEpoch: string,
    replayStale = false,
  ): void {
    for (const [interactionId, pending] of this.#pendingInteractions) {
      if (
        pending.record.sessionId === sessionId &&
        pending.record.runtimeEpoch === runtimeEpoch
      ) {
        pending.retired = true;
        this.#pendingInteractions.delete(interactionId);
        if (replayStale) {
          const stale: InteractionRecord = { ...pending.record, state: "stale" };
          this.#rememberResolvedInteraction(stale);
          this.#events.publish({
            kind: "control",
            change: { type: "interaction.changed", interaction: stale },
          });
        }
      }
    }
    if (replayStale) return;
    for (const [interactionId, resolved] of this.#resolvedInteractions) {
      if (resolved.sessionId === sessionId && resolved.runtimeEpoch === runtimeEpoch) {
        this.#resolvedInteractions.delete(interactionId);
      }
    }
  }

  async #journal(
    commandId: CommandId,
    payloadHash: string,
    sessionId: SessionId | null,
    request: unknown,
    execute: () => Promise<unknown>,
  ): Promise<CommandRecord> {
    const encodedRequest = toJsonValue(JSON.parse(JSON.stringify(request)));
    const existing = this.#store.getCommand(commandId);
    if (existing) {
      if (
        existing.payloadHash !== payloadHash ||
        existing.sessionId !== sessionId ||
        existing.runtimeNodeId !== this.#runtimeNodeId ||
        canonicalJson(existing.request) !== canonicalJson(encodedRequest)
      ) {
        throw new RuntimeNodeProtocolError(
          "PAYLOAD_MISMATCH",
          `command ${commandId} was already used with another payload`,
        );
      }
      return existing;
    }
    const timestamp = now();
    let record: CommandRecord = {
      commandId,
      payloadHash,
      sessionId,
      runtimeNodeId: this.#runtimeNodeId,
      // The first durable record is already in-flight. There is no crash gap
      // where an inert `received` command can be returned forever on retry.
      state: "started",
      request: encodedRequest,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#store.putCommand(record);
    try {
      const result = await execute();
      let packedResult: NativePayload | undefined;
      if (result !== undefined) {
        try {
          const json = toJsonValue(JSON.parse(JSON.stringify(result)));
          const session = sessionId ? this.#store.getSession(sessionId) : undefined;
          packedResult = session ? await this.#externalize(session, json) : packNativePayload(json);
        } catch (error) {
          throw new AdapterOutcomeUnknownError("native command completed but its bounded result could not be recorded", { cause: error });
        }
      }
      record = {
        ...record,
        state: "succeeded",
        ...(packedResult === undefined
          ? {}
          : { result: packedResult }),
        updatedAt: now(),
      };
    } catch (error) {
      record = {
        ...record,
        state:
          error instanceof AdapterOutcomeUnknownError ||
          error instanceof LaunchProviderOutcomeUnknownError
            ? "outcomeUnknown"
            : "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      };
    }
    this.#store.putCommand(record);
    return record;
  }

  #serialize<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.#sessionLocks.set(sessionId, next);
    const release = () => {
      if (this.#sessionLocks.get(sessionId) === next) this.#sessionLocks.delete(sessionId);
    };
    // A detached `next.finally(release)` mirrors a rejection into a new,
    // unobserved promise. Two explicit handlers make cleanup rejection-safe.
    void next.then(release, release);
    return next;
  }
}

/** Compose the control-node view without regressing newer canonical fields. */
function overlayTransferredOperation(
  canonical: MetadataSnapshot,
  operation: MetadataOperationRecord,
): MetadataSnapshot {
  const operationView = operation.optimistic ?? operation.canonical;
  const values = { ...canonical.values };
  const touched = [
    ...Object.keys(operation.patch.set ?? {}),
    ...(operation.patch.remove ?? []),
  ];
  for (const key of touched) {
    const value = operationView.values[key];
    if (value === undefined) delete values[key];
    else values[key] = value;
  }
  return { ...canonical, values };
}

function mergeCanonicalMetadata(
  previous: RuntimeNodeSessionRecord | undefined,
  incoming: MetadataSnapshot,
  incomingAuthority: AuthorityRef,
): MetadataSnapshot {
  if (
    !previous?.metadataAuthority ||
    !sameAuthority(previous.metadataAuthority, incomingAuthority)
  ) {
    // A deliberate topology transition establishes a new revision domain.
    // Revisions from different authority epochs are not comparable.
    return incoming;
  }
  if (incoming.revision < previous.metadata.revision) return previous.metadata;
  if (
    incoming.revision === previous.metadata.revision &&
    canonicalJson(toJsonValue(incoming)) !== canonicalJson(toJsonValue(previous.metadata))
  ) {
    throw new RuntimeNodeProtocolError(
      "FENCED",
      `control node returned divergent metadata at revision ${incoming.revision}`,
    );
  }
  return incoming;
}

function sameAuthority(left: AuthorityRef, right: AuthorityRef): boolean {
  return left.realmId === right.realmId &&
    left.controlNodeId === right.controlNodeId &&
    left.epochId === right.epochId;
}

function sameLaunchMetadataPatch(left: MetadataPatch, right: MetadataPatch): boolean {
  return left.operationId === right.operationId &&
    left.sessionId === right.sessionId &&
    canonicalJson(toJsonValue({
      ...(left.set === undefined ? {} : { set: left.set }),
      ...(left.remove === undefined ? {} : { remove: left.remove }),
      ...(left.ifKeyRevision === undefined ? {} : { ifKeyRevision: left.ifKeyRevision }),
    })) === canonicalJson(toJsonValue({
      ...(right.set === undefined ? {} : { set: right.set }),
      ...(right.remove === undefined ? {} : { remove: right.remove }),
      ...(right.ifKeyRevision === undefined ? {} : { ifKeyRevision: right.ifKeyRevision }),
    }));
}

function nativeBindingKey(
  record: Pick<
    RuntimeNodeSessionRecord,
    "runtimeNodeId" | "harness" | "adapterScopeId" | "vendorSessionId"
  >,
): string {
  return [
    record.runtimeNodeId,
    record.harness,
    record.adapterScopeId,
    record.vendorSessionId,
  ].join("\0");
}

function nativeInventoryKey(
  record: Pick<
    NativeInventoryItem,
    "harness" | "adapterScopeId" | "vendorSessionId"
  >,
): string {
  return [record.harness, record.adapterScopeId, record.vendorSessionId].join("\0");
}

function sameNativeBinding(
  left: RuntimeNodeSessionRecord,
  right: SessionRecord,
): boolean {
  return nativeBindingKey(left) === nativeBindingKey(right);
}

function runtimeRecordFromCanonical(record: SessionRecord): RuntimeNodeSessionRecord {
  const { catalogState: _state, catalogRevision: _revision, archivedAt: _archivedAt, ...runtime } =
    record;
  return runtime;
}

function assertSameNativeBinding(
  local: RuntimeNodeSessionRecord,
  canonical: SessionRecord,
): void {
  if (sameNativeBinding(local, canonical)) return;
  throw new RuntimeNodeProtocolError(
    "FENCED",
    `control node changed the runtime-owned native binding for session ${local.sessionId}`,
  );
}

function isTerminalLaunch(state: LaunchRecord["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "outcomeUnknown";
}

function isTerminalArchive(state: ArchiveRecord["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "outcomeUnknown";
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "unknown runtime error").slice(0, 16_384);
}

function deduplicateModels(models: readonly NativeModel[]): NativeModel[] {
  const unique = new Map<string, NativeModel>();
  for (const model of models) unique.set(`${model.harness}\0${model.id}`, model);
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

interface LaunchCursor {
  readonly updatedAt: string;
  readonly launchId: string;
}

function encodeLaunchCursor(record: Pick<LaunchRecord, "updatedAt" | "launchId">): string {
  return Buffer.from(JSON.stringify({
    updatedAt: record.updatedAt,
    launchId: record.launchId,
  })).toString("base64url");
}

function decodeLaunchCursor(cursor: string): LaunchCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      typeof (value as Record<string, unknown>).updatedAt !== "string" ||
      typeof (value as Record<string, unknown>).launchId !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return value as LaunchCursor;
  } catch (error) {
    throw new RuntimeNodeProtocolError(
      "FENCED",
      `invalid launch cursor: ${errorText(error)}`,
    );
  }
}

function launchOrder(
  left: { readonly updatedAt: string; readonly launchId: string },
  right: { readonly updatedAt: string; readonly launchId: string },
): number {
  return left.updatedAt.localeCompare(right.updatedAt) ||
    left.launchId.localeCompare(right.launchId);
}
