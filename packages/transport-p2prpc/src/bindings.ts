import type {
  ImageAbortUploadResult,
  ImageBeginUploadInput,
  ImageDescriptor,
  ImageLimits,
  ImageReadInput,
  ImageReadResult,
  ImageResolvePathInput,
  ImageTarget,
  ImageUploadIdInput,
  ImageUploadState,
  ImageWriteUploadInput,
} from "@arduano/agent-multiplex-protocol";
import type {
  ChildControlNodeConnection,
  CompositeControlNodeIngressContext,
  RuntimeNodeConnection,
} from "@arduano/agent-multiplex-control-node-core";
import type {
  AccessStreamItem,
  ArchiveOperationId,
  ArchiveRecord,
  ArchiveRequest,
  AttachmentId,
  ControlNodeBootId,
  ControlNodeDescriptor,
  ControlNodeId,
  CommandRecord,
  ControlNodeLinkFence,
  ControlNodeSubtreeSnapshotPage,
  Harness,
  InventorySnapshot,
  LaunchId,
  LaunchListInput,
  LaunchListPage,
  LaunchProfileIdentity,
  LaunchRecord,
  LaunchRequest,
  LineageId,
  MetadataOperationRecord,
  NativeHistoryRequest,
  NativeHistoryResult,
  NativeModel,
  ResolveInteractionInput,
  RuntimeNodeBootId,
  RuntimeNodeId,
  SessionId,
  SessionRecord,
  SessionSearchInput,
  SessionSearchPage,
  StreamCursor,
  StopCommand,
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
  TopologyDetachmentReceipt,
} from "@arduano/agent-multiplex-protocol";
import { TERMINAL_STREAM_BUFFER_ITEMS } from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeRouter } from "@arduano/agent-multiplex-runtime-node-core";
import { P2PError, type Peer, type PeerContext } from "@arduano/p2prpc-core";
import type { AnyTRPCRouter } from "@trpc/server";

import { P2PRuntimeNodeConnection } from "./runtime-node-bridge.js";

interface ControlNodeLinkPeerRpc {
  images: {
    beginUpload: { mutate(input: ControlNodeLinkFence & { request: ImageBeginUploadInput }): Promise<ImageUploadState> };
    writeUpload: { mutate(input: ControlNodeLinkFence & { request: ImageWriteUploadInput }): Promise<ImageUploadState> };
    commitUpload: { mutate(input: ControlNodeLinkFence & { request: ImageUploadIdInput }): Promise<ImageDescriptor> };
    abortUpload: { mutate(input: ControlNodeLinkFence & { request: ImageUploadIdInput }): Promise<ImageAbortUploadResult> };
    resolvePath: { mutate(input: ControlNodeLinkFence & { request: ImageResolvePathInput }): Promise<ImageDescriptor> };
    read: { query(input: ControlNodeLinkFence & { request: ImageReadInput }): Promise<ImageReadResult> };
    limits: { query(input: ControlNodeLinkFence & { request: ImageTarget }): Promise<ImageLimits> };
  };

  controlNode: {
    describe: { query(input?: void): Promise<ControlNodeDescriptor> };
  };
  topology: {
    snapshot: {
      query(
        input: ControlNodeLinkFence & { pageToken?: string; limit?: number },
      ): Promise<ControlNodeSubtreeSnapshotPage>;
    };
    applyDetachment: {
      mutate(
        input: ControlNodeLinkFence & { receipt: TopologyDetachmentReceipt },
      ): Promise<TopologyDetachmentReceipt>;
    };
  };
  events: {
    subscribe: {
      subscribe(
        input: ControlNodeLinkFence & { cursor: StreamCursor },
        callbacks: SubscriptionCallbacks<AccessStreamItem>,
      ): SubscriptionHandle;
    };
  };
  harness: {
    models: {
      query(
        input: ControlNodeLinkFence & {
          runtimeNodeId: RuntimeNodeId;
          harness: Harness;
        },
      ): Promise<NativeModel[]>;
    };
  };
  launchProfiles: {
    models: {
      query(
        input: ControlNodeLinkFence & {
          runtimeNodeId: RuntimeNodeId;
          profile: LaunchProfileIdentity;
          harness: Harness;
        },
      ): Promise<NativeModel[]>;
    };
  };
  launches: {
    create: {
      mutate(
        input: ControlNodeLinkFence & { request: LaunchRequest },
      ): Promise<LaunchRecord>;
    };
    get: {
      query(
        input: ControlNodeLinkFence & { launchId: LaunchId },
      ): Promise<LaunchRecord | null>;
    };
    list: {
      query(
        input: ControlNodeLinkFence & { query: LaunchListInput },
      ): Promise<LaunchListPage>;
    };
  };
  sessions: {
    search: {
      query(
        input: ControlNodeLinkFence & { query: SessionSearchInput },
      ): Promise<SessionSearchPage>;
    };
    get: {
      query(
        input: ControlNodeLinkFence & { sessionId: SessionId },
      ): Promise<SessionRecord | null>;
    };
    refresh: {
      mutate(
        input: ControlNodeLinkFence & { runtimeNodeId: RuntimeNodeId },
      ): Promise<InventorySnapshot>;
    };
    resume: {
      mutate(
        input: ControlNodeLinkFence & {
          command: Parameters<ChildControlNodeConnection["resume"]>[0];
        },
      ): ReturnType<ChildControlNodeConnection["resume"]>;
    };
    stop: {
      mutate(
        input: ControlNodeLinkFence & {
          command: StopCommand;
        },
      ): Promise<CommandRecord>;
    };
    archive: {
      mutate(
        input: ControlNodeLinkFence & { request: ArchiveRequest },
      ): Promise<ArchiveRecord>;
    };
    readNativeHistory: {
      query(
        input: ControlNodeLinkFence & {
          sessionId: SessionId;
          request: NativeHistoryRequest;
        },
      ): Promise<NativeHistoryResult>;
    };
  };
  archives: {
    get: {
      query(
        input: ControlNodeLinkFence & {
          archiveOperationId: ArchiveOperationId;
        },
      ): Promise<ArchiveRecord | null>;
    };
  };
  terminals: {
    get: {
      query(input: ControlNodeLinkFence & { request: TerminalGetInput }): Promise<TerminalDescriptor | null>;
    };
    open: {
      mutate(input: ControlNodeLinkFence & { request: TerminalOpenInput }): Promise<TerminalOpenResult>;
    };
    attach: {
      subscribe(
        input: ControlNodeLinkFence & { request: TerminalAttachInput },
        callbacks: SubscriptionCallbacks<TerminalStreamItem>,
      ): SubscriptionHandle;
    };
    lease: {
      acquire: {
        mutate(input: ControlNodeLinkFence & { request: TerminalLeaseAcquireInput }): Promise<TerminalLeaseAcquireResult>;
      };
      renew: {
        mutate(input: ControlNodeLinkFence & { request: TerminalLeaseRenewInput }): Promise<TerminalLeaseRenewResult>;
      };
      release: {
        mutate(input: ControlNodeLinkFence & { request: TerminalLeaseReleaseInput }): Promise<TerminalLeaseReleaseResult>;
      };
    };
    input: {
      mutate(input: ControlNodeLinkFence & { request: TerminalInput }): Promise<TerminalInputResult>;
    };
    terminate: {
      mutate(input: ControlNodeLinkFence & { request: TerminalTerminateInput }): Promise<TerminalDescriptor>;
    };
  };
  commands: {
    execute: {
      mutate(
        input: ControlNodeLinkFence & {
          command: Parameters<ChildControlNodeConnection["execute"]>[0];
        },
      ): ReturnType<ChildControlNodeConnection["execute"]>;
    };
    get: {
      query(
        input: ControlNodeLinkFence & {
          commandId: Parameters<
            NonNullable<ChildControlNodeConnection["getCommand"]>
          >[0];
        },
      ): ReturnType<NonNullable<ChildControlNodeConnection["getCommand"]>>;
    };
  };
  interactions: {
    resolve: {
      mutate(
        input: ControlNodeLinkFence & { interaction: ResolveInteractionInput },
      ): ReturnType<ChildControlNodeConnection["resolveInteraction"]>;
    };
  };
  metadata: {
    settle: {
      mutate(
        input: ControlNodeLinkFence & { operation: MetadataOperationRecord },
      ): Promise<MetadataOperationRecord>;
    };
  };
}

interface SubscriptionCallbacks<T> {
  onData(value: T): void;
  onError(error: unknown): void;
  onComplete(): void;
  onStarted?(): void;
}

interface SubscriptionHandle {
  unsubscribe(): void;
}

export interface ChildControlNodePeerBinding {
  readonly controlNodeId: ControlNodeId;
  readonly controlNodeBootId: ControlNodeBootId;
  readonly attachmentId: AttachmentId;
  readonly lineageId: LineageId;
}

/**
 * First attachment assigns its fence after the reverse peer exists. Resolving
 * it lazily also fences every call against a later detach and reattach.
 */
export interface LazyChildControlNodePeerBinding {
  readonly controlNodeId: ControlNodeId;
  readonly controlNodeBootId: ControlNodeBootId;
  currentFence(): Pick<
    ChildControlNodePeerBinding,
    "attachmentId" | "lineageId"
  >;
}

export type ChildControlNodePeerResolver = () =>
  | Peer<AnyTRPCRouter>
  | undefined;

/** Adapt a branch's typed `link` proxy to the transport-neutral recursive port. */
export function childControlNodeConnectionFromPeer(
  peer: Peer<AnyTRPCRouter>,
  binding: ChildControlNodePeerBinding | LazyChildControlNodePeerBinding,
): ChildControlNodeConnection {
  return childControlNodeConnectionFromPeerResolver(
    peer.identity.id,
    () => peer,
    binding,
    peer.principal.id,
  );
}

/**
 * Adapt a logical child edge while resolving its current authenticated Peer
 * for every RPC and subscription attempt. An attachment outlives any one
 * p2prpc authentication epoch, but remains pinned to one endpoint key.
 */
export function childControlNodeConnectionFromPeerResolver(
  endpointId: string,
  resolvePeer: ChildControlNodePeerResolver,
  binding: ChildControlNodePeerBinding | LazyChildControlNodePeerBinding,
  principalId?: string,
): ChildControlNodeConnection {
  const rpc = (): ControlNodeLinkPeerRpc => {
    const peer = resolvePeer();
    if (!peer) {
      throw new P2PError(
        "DISCONNECTED",
        `Control-node endpoint ${endpointId} is not connected`,
      );
    }
    if (peer.identity.id !== endpointId) {
      throw new P2PError(
        "UNAUTHORIZED",
        "Resolved child control-node peer does not match its pinned endpoint",
      );
    }
    if (principalId !== undefined && peer.principal.id !== principalId) {
      throw new P2PError(
        "UNAUTHORIZED",
        "Resolved child control-node peer does not match its authenticated principal",
      );
    }
    return (peer.rpc as unknown as { link: ControlNodeLinkPeerRpc }).link;
  };
  const fence = (): ControlNodeLinkFence => {
    const current = "currentFence" in binding
      ? binding.currentFence()
      : binding;
    return {
      controlNodeId: binding.controlNodeId,
      controlNodeBootId: binding.controlNodeBootId,
      attachmentId: current.attachmentId,
      lineageId: current.lineageId,
    };
  };
  const connection: ChildControlNodeConnection = {
    controlNodeId: binding.controlNodeId,
    controlNodeBootId: binding.controlNodeBootId,
    endpointId,
    readSubtreeSnapshot: (request) =>
      rpc().topology.snapshot.query({
        ...fence(),
        ...(request.pageToken !== undefined
          ? { pageToken: request.pageToken }
          : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      }),
    subscribeAggregate: (cursor, signal) =>
      subscriptionAsAsyncIterable(
        (position, callbacks) =>
          rpc().events.subscribe.subscribe(
            { ...fence(), cursor: position },
            callbacks,
          ),
        cursor,
        signal,
      ),
    listModels: (runtimeNodeId, harness) =>
      rpc().harness.models.query({ ...fence(), runtimeNodeId, harness }),
    listLaunchProfileModels: (runtimeNodeId, profile, harness) =>
      rpc().launchProfiles.models.query({
        ...fence(),
        runtimeNodeId,
        profile,
        harness,
      }),
    refreshInventory: (runtimeNodeId) =>
      rpc().sessions.refresh.mutate({ ...fence(), runtimeNodeId }),
    createLaunch: (request) =>
      rpc().launches.create.mutate({ ...fence(), request }),
    getLaunch: (launchId) =>
      rpc().launches.get.query({ ...fence(), launchId }),
    listLaunches: (query) =>
      rpc().launches.list.query({ ...fence(), query }),
    searchSessions: (query) =>
      rpc().sessions.search.query({ ...fence(), query }),
    getSession: (sessionId) =>
      rpc().sessions.get.query({ ...fence(), sessionId }),
    resume: (command) => rpc().sessions.resume.mutate({ ...fence(), command }),
    stop: (command) => rpc().sessions.stop.mutate({ ...fence(), command }),
    archive: (request) => rpc().sessions.archive.mutate({ ...fence(), request }),
    getArchive: (archiveOperationId) =>
      rpc().archives.get.query({ ...fence(), archiveOperationId }),
    execute: (command) => rpc().commands.execute.mutate({ ...fence(), command }),
    readNativeHistory: (sessionId, request) =>
      rpc().sessions.readNativeHistory.query({ ...fence(), sessionId, request }),
    beginImageUpload: (request) => rpc().images.beginUpload.mutate({ ...fence(), request }),
    writeImageUpload: (request) => rpc().images.writeUpload.mutate({ ...fence(), request }),
    commitImageUpload: (request) => rpc().images.commitUpload.mutate({ ...fence(), request }),
    abortImageUpload: (request) => rpc().images.abortUpload.mutate({ ...fence(), request }),
    resolveImagePath: (request) => rpc().images.resolvePath.mutate({ ...fence(), request }),
    readImage: (request) => rpc().images.read.query({ ...fence(), request }),
    imageLimits: (request) => rpc().images.limits.query({ ...fence(), request }),
    getTerminal: (request) =>
      rpc().terminals.get.query({ ...fence(), request }),
    openTerminal: (request) =>
      rpc().terminals.open.mutate({ ...fence(), request }),
    attachTerminal: (request, signal) =>
      subscriptionInputAsAsyncIterable(
        (input, callbacks) => rpc().terminals.attach.subscribe(input, callbacks),
        { ...fence(), request },
        signal,
        TERMINAL_STREAM_BUFFER_ITEMS,
        (input) => ({
          ...input,
          request: {
            ...input.request,
            ...(input.request.cursor === undefined
              ? {}
              : { cursor: { ...input.request.cursor } }),
          },
        }),
      ),
    acquireTerminalLease: (request) =>
      rpc().terminals.lease.acquire.mutate({ ...fence(), request }),
    renewTerminalLease: (request) =>
      rpc().terminals.lease.renew.mutate({ ...fence(), request }),
    releaseTerminalLease: (request) =>
      rpc().terminals.lease.release.mutate({ ...fence(), request }),
    sendTerminalInput: (request) =>
      rpc().terminals.input.mutate({ ...fence(), request }),
    terminateTerminal: (request) =>
      rpc().terminals.terminate.mutate({ ...fence(), request }),
    resolveInteraction: (interaction) =>
      rpc().interactions.resolve.mutate({ ...fence(), interaction }),
    getCommand: (commandId) =>
      rpc().commands.get.query({ ...fence(), commandId }),
    applyMetadata: (operation) =>
      rpc().metadata.settle.mutate({ ...fence(), operation }),
    applyDetachment: (receipt) =>
      rpc().topology.applyDetachment.mutate({ ...fence(), receipt }),
  };
  return Object.freeze(connection);
}

function subscriptionAsAsyncIterable<T>(
  subscribe: (
    cursor: StreamCursor,
    callbacks: SubscriptionCallbacks<T>,
  ) => SubscriptionHandle,
  cursor: StreamCursor,
  signal?: AbortSignal,
  capacity = DEFAULT_SUBSCRIPTION_BUFFER_CAPACITY,
): AsyncIterable<T> {
  return subscriptionInputAsAsyncIterable(
    subscribe,
    cursor,
    signal,
    capacity,
    cloneCursor,
  );
}

function subscriptionInputAsAsyncIterable<T, TInput>(
  subscribe: (
    input: TInput,
    callbacks: SubscriptionCallbacks<T>,
  ) => SubscriptionHandle,
  input: TInput,
  signal: AbortSignal | undefined,
  capacity: number,
  cloneInput: (value: TInput) => TInput,
): AsyncIterable<T> {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("subscription buffer capacity must be a positive integer");
  }
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const values: T[] = [];
      const waiters: Array<{
        resolve(result: IteratorResult<T>): void;
        reject(error: unknown): void;
      }> = [];
      let ended = signal?.aborted ?? false;
      let failure: unknown;
      let subscription: SubscriptionHandle | undefined;
      let transportStarted = false;
      let transportEnded = false;
      const abort = (): void => finish();

      if (!ended) {
        subscription = subscribe(cloneInput(input), {
          onStarted: () => {
            transportStarted = true;
            // p2prpc announces a subscription only after its complete request
            // is dispatched. Deferring an early unsubscribe until this point
            // prevents a normal pump replacement from quarantining the peer.
            if (ended) stopTransport();
          },
          onData: (value) => {
            if (ended) return;
            const waiter = waiters.shift();
            if (waiter) waiter.resolve({ done: false, value });
            else if (values.length < capacity) values.push(value);
            else finish(new SubscriptionBufferOverflowError(capacity));
          },
          onError: (error) => {
            transportEnded = true;
            finish(error);
          },
          onComplete: () => {
            transportEnded = true;
            finish();
          },
        });
        if (ended) stopTransport();
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }

      function stopTransport(): void {
        if (!subscription || transportEnded || !transportStarted) return;
        transportEnded = true;
        subscription.unsubscribe();
      }

      function finish(error?: unknown): void {
        if (ended) return;
        ended = true;
        failure = error;
        values.splice(0);
        signal?.removeEventListener("abort", abort);
        stopTransport();
        for (const waiter of waiters.splice(0)) {
          if (failure !== undefined) waiter.reject(failure);
          else waiter.resolve({ done: true, value: undefined });
        }
      }

      return {
        next: () => {
          const value = values.shift();
          if (value !== undefined) {
            return Promise.resolve({ done: false as const, value });
          }
          if (ended) {
            return failure !== undefined
              ? Promise.reject(failure)
              : Promise.resolve({ done: true as const, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return: () => {
          finish();
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
}

const DEFAULT_SUBSCRIPTION_BUFFER_CAPACITY = 4_096;

/** Testable surface for the generic bounded subscription bridge. */
export function subscriptionAsAsyncIterableForTesting<T>(
  subscribe: (
    cursor: StreamCursor,
    callbacks: SubscriptionCallbacks<T>,
  ) => SubscriptionHandle,
  cursor: StreamCursor,
  signal?: AbortSignal,
  capacity?: number,
): AsyncIterable<T> {
  return subscriptionAsAsyncIterable(subscribe, cursor, signal, capacity);
}

export class SubscriptionBufferOverflowError extends Error {
  public constructor(public readonly capacity: number) {
    super(`p2prpc subscription exceeded its ${capacity}-item buffer`);
    this.name = "SubscriptionBufferOverflowError";
  }
}

function cloneCursor(cursor: StreamCursor): StreamCursor {
  return {
    feedId: cursor.feedId,
    controlCursor: cursor.controlCursor,
    native: Object.fromEntries(
      Object.entries(cursor.native).map(([sessionId, position]) => [
        sessionId,
        { ...position },
      ]),
    ) as StreamCursor["native"],
  };
}

/** Adapt a typed reverse runtime-node proxy to the control node's port. */
export function runtimeNodeConnectionFromPeer(
  peer: Peer<RuntimeNodeRouter>,
  runtimeNodeId: RuntimeNodeId,
  runtimeNodeBootId: RuntimeNodeBootId,
): RuntimeNodeConnection {
  return Object.freeze(
    new P2PRuntimeNodeConnection(
      runtimeNodeId,
      runtimeNodeBootId,
      peer.identity.id,
      peer,
      peer.principal.id,
    ),
  );
}

/** Create a logical runtime connection that follows authenticated peer epochs. */
export function runtimeNodeConnectionFromPeerResolver(
  endpointId: string,
  resolvePeer: () => Peer<RuntimeNodeRouter> | undefined,
  runtimeNodeId: RuntimeNodeId,
  runtimeNodeBootId: RuntimeNodeBootId,
  principalId?: string,
): RuntimeNodeConnection {
  return Object.freeze(
    new P2PRuntimeNodeConnection(
      runtimeNodeId,
      runtimeNodeBootId,
      endpointId,
      resolvePeer,
      principalId,
    ),
  );
}

export interface ControlNodeIngressContextFactoryOptions {
  /** Reverse peers are resolved for every logical binding, never retained by epoch. */
  readonly getRuntimeNodePeer: (
    endpointId: string,
  ) => Peer<RuntimeNodeRouter> | undefined;
  readonly getChildControlNodePeer?: (
    endpointId: string,
  ) => Peer<AnyTRPCRouter> | undefined;
  /** Enrollment mappings fence logical IDs to authenticated endpoint keys. */
  readonly runtimeNodeIdForEndpoint?: (
    endpointId: string,
  ) => RuntimeNodeId | undefined;
  readonly controlNodeIdForEndpoint?: (
    endpointId: string,
  ) => ControlNodeId | undefined;
  /** Resolves the currently committed attachment after attach has succeeded. */
  readonly childControlNodeFence?: (
    controlNodeId: ControlNodeId,
  ) => Pick<ChildControlNodePeerBinding, "attachmentId" | "lineageId">;
}

/** Map authenticated p2prpc context into the control-node transport ports. */
export function createControlNodeIngressContextFactory(
  options: ControlNodeIngressContextFactoryOptions,
): (context: PeerContext) => CompositeControlNodeIngressContext {
  return (context) => {
    const endpointId = context.p2p.peer.id;
    const authenticatedRuntimeNodeId =
      options.runtimeNodeIdForEndpoint?.(endpointId);
    const authenticatedControlNodeId =
      options.controlNodeIdForEndpoint?.(endpointId);
    return {
      endpointId,
      authenticatedActorId: context.p2p.auth.principal.id,
      ...(authenticatedRuntimeNodeId === undefined
        ? {}
        : { authenticatedRuntimeNodeId }),
      ...(authenticatedControlNodeId === undefined
        ? {}
        : { authenticatedControlNodeId }),
      createRuntimeNodeConnection: (runtimeNodeId, runtimeNodeBootId) => {
        const peer = options.getRuntimeNodePeer(endpointId);
        if (!peer) {
          throw new P2PError(
            "DISCONNECTED",
            `Runtime-node endpoint ${endpointId} is no longer connected`,
          );
        }
        if (peer.identity.id !== endpointId) {
          throw new P2PError(
            "UNAUTHORIZED",
            "Resolved runtime-node peer does not match its authenticated endpoint",
          );
        }
        return runtimeNodeConnectionFromPeerResolver(
          endpointId,
          () => options.getRuntimeNodePeer(endpointId),
          runtimeNodeId,
          runtimeNodeBootId,
          context.p2p.auth.principal.id,
        );
      },
      ...(options.getChildControlNodePeer && options.childControlNodeFence
        ? {
            createChildControlNodeConnection: (
              request: Parameters<
                NonNullable<
                  CompositeControlNodeIngressContext["createChildControlNodeConnection"]
                >
              >[0],
            ) => {
              const peer = options.getChildControlNodePeer!(endpointId);
              if (!peer) {
                throw new P2PError(
                  "DISCONNECTED",
                  `Control-node endpoint ${endpointId} is no longer connected`,
                );
              }
              if (peer.identity.id !== endpointId) {
                throw new P2PError(
                  "UNAUTHORIZED",
                  "Resolved child control-node peer does not match its authenticated endpoint",
                );
              }
              return childControlNodeConnectionFromPeerResolver(
                endpointId,
                () => options.getChildControlNodePeer!(endpointId),
                {
                  controlNodeId: request.controlNodeId,
                  controlNodeBootId: request.controlNodeBootId,
                  currentFence: () =>
                    options.childControlNodeFence!(request.controlNodeId),
                },
                context.p2p.auth.principal.id,
              );
            },
          }
        : {}),
    };
  };
}
