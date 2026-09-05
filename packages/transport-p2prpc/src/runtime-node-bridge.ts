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
import { P2PError, type Peer } from "@arduano/p2prpc-core";
import type { RuntimeNodeConnection } from "@arduano/agent-multiplex-control-node-core";
import { TERMINAL_STREAM_BUFFER_ITEMS } from "@arduano/agent-multiplex-protocol";
import type {
  ArchiveOperationId,
  ArchiveRecord,
  ArchiveRequest,
  CommandEnvelope,
  CommandId,
  CommandRecord,
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
  NativeHistoryRequest,
  NativeHistoryResult,
  NativeModel,
  MetadataOperationRecord,
  ResolveInteractionInput,
  ResumeCommand,
  SessionId,
  RuntimeNodeEventCursor,
  RuntimeNodeEventItem,
  RuntimeNodeBootId,
  RuntimeNodeId,
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
} from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeRouter } from "@arduano/agent-multiplex-runtime-node-core";

export type RuntimeNodePeerResolver = () =>
  | Peer<RuntimeNodeRouter>
  | undefined;

interface RuntimeNodeTerminalPeerRpc {
  terminals: {
    get: { query(input: { runtimeNodeBootId: RuntimeNodeBootId; request: TerminalGetInput }): Promise<TerminalDescriptor | null> };
    open: { mutate(input: { runtimeNodeBootId: RuntimeNodeBootId; request: TerminalOpenInput }): Promise<TerminalOpenResult> };
    attach: TerminalSubscriptionProcedure;
    lease: {
      acquire: { mutate(input: { runtimeNodeBootId: RuntimeNodeBootId; request: TerminalLeaseAcquireInput }): Promise<TerminalLeaseAcquireResult> };
      renew: { mutate(input: { runtimeNodeBootId: RuntimeNodeBootId; request: TerminalLeaseRenewInput }): Promise<TerminalLeaseRenewResult> };
      release: { mutate(input: { runtimeNodeBootId: RuntimeNodeBootId; request: TerminalLeaseReleaseInput }): Promise<TerminalLeaseReleaseResult> };
    };
    input: { mutate(input: { runtimeNodeBootId: RuntimeNodeBootId; request: TerminalInput }): Promise<TerminalInputResult> };
    terminate: { mutate(input: { runtimeNodeBootId: RuntimeNodeBootId; request: TerminalTerminateInput }): Promise<TerminalDescriptor> };
  };
}

/** Adapts a symmetric p2prpc peer into the control node's transport-neutral channel. */
export class P2PRuntimeNodeConnection implements RuntimeNodeConnection {
  readonly #resolvePeer: RuntimeNodePeerResolver;

  public constructor(
    public readonly runtimeNodeId: RuntimeNodeId,
    public readonly runtimeNodeBootId: RuntimeNodeBootId,
    public readonly endpointId: string,
    peer: Peer<RuntimeNodeRouter> | RuntimeNodePeerResolver,
    public readonly principalId?: string,
  ) {
    this.#resolvePeer = typeof peer === "function" ? peer : () => peer;
  }

  /**
   * Resolve the authenticated reverse peer at dispatch time. p2prpc replaces
   * its Peer object when an authenticated session is renewed, so retaining the
   * object received during registration would permanently bind this logical
   * runtime connection to an expired transport epoch.
   */
  public get peer(): Peer<RuntimeNodeRouter> {
    const peer = this.#resolvePeer();
    if (!peer) {
      throw new P2PError(
        "DISCONNECTED",
        `Runtime-node endpoint ${this.endpointId} is not connected`,
      );
    }
    if (peer.identity.id !== this.endpointId) {
      throw new P2PError(
        "UNAUTHORIZED",
        "Resolved runtime-node peer does not match its pinned endpoint",
      );
    }
    if (this.principalId !== undefined && peer.principal.id !== this.principalId) {
      throw new P2PError(
        "UNAUTHORIZED",
        "Resolved runtime-node peer does not match its authenticated principal",
      );
    }
    return peer;
  }

  private get terminalRpc(): RuntimeNodeTerminalPeerRpc["terminals"] {
    return (this.peer.rpc as unknown as RuntimeNodeTerminalPeerRpc).terminals;
  }

  public refreshInventory(): Promise<InventorySnapshot> {
    return this.peer.rpc.inventory.refresh.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
    });
  }

  public listModels(harness: Harness): Promise<NativeModel[]> {
    return this.peer.rpc.harness.models.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      harness,
    });
  }

  public listLaunchProfiles(): Promise<LaunchProfileDescriptor[]> {
    return this.peer.rpc.launchProfiles.list.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
    });
  }

  public listLaunchProfileModels(
    profile: LaunchProfileIdentity,
    harness: Harness,
  ): Promise<NativeModel[]> {
    return this.peer.rpc.launchProfiles.models.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      profile,
      harness,
    });
  }

  public createLaunch(request: LaunchRequest): Promise<LaunchRecord> {
    return this.peer.rpc.launches.create.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request,
    });
  }

  public getLaunch(launchId: LaunchId): Promise<LaunchRecord | null> {
    return this.peer.rpc.launches.get.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      launchId,
    });
  }

  public listLaunches(query: LaunchListInput): Promise<LaunchListPage> {
    return this.peer.rpc.launches.list.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      query,
    });
  }

  public resume(command: ResumeCommand): Promise<CommandRecord> {
    return this.peer.rpc.sessions.resume.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      command,
    });
  }

  public stop(command: StopCommand): Promise<CommandRecord> {
    return this.peer.rpc.sessions.stop.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      command,
    });
  }

  public archive(request: ArchiveRequest): Promise<ArchiveRecord> {
    return this.peer.rpc.sessions.archive.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request,
    });
  }

  public getArchive(
    archiveOperationId: ArchiveOperationId,
  ): Promise<ArchiveRecord | null> {
    return this.peer.rpc.archives.get.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      archiveOperationId,
    });
  }

  public execute(command: CommandEnvelope): Promise<CommandRecord> {
    return this.peer.rpc.commands.execute.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      command,
    });
  }

  public readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult> {
    return this.peer.rpc.sessions.readNativeHistory.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      sessionId,
      request,
    });
  }

  public beginImageUpload(input: ImageBeginUploadInput): Promise<ImageUploadState> {
    return this.peer.rpc.images.beginUpload.mutate(input);
  }

  public writeImageUpload(input: ImageWriteUploadInput): Promise<ImageUploadState> {
    return this.peer.rpc.images.writeUpload.mutate(input);
  }

  public commitImageUpload(input: ImageUploadIdInput): Promise<ImageDescriptor> {
    return this.peer.rpc.images.commitUpload.mutate(input);
  }

  public abortImageUpload(input: ImageUploadIdInput): Promise<ImageAbortUploadResult> {
    return this.peer.rpc.images.abortUpload.mutate(input);
  }

  public resolveImagePath(input: ImageResolvePathInput): Promise<ImageDescriptor> {
    return this.peer.rpc.images.resolvePath.mutate(input);
  }

  public readImage(input: ImageReadInput): Promise<ImageReadResult> {
    return this.peer.rpc.images.read.query(input);
  }

  public imageLimits(input: ImageTarget): Promise<ImageLimits> {
    return this.peer.rpc.images.limits.query(input);
  }

  public getTerminal(input: TerminalGetInput): Promise<TerminalDescriptor | null> {
    return this.terminalRpc.get.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request: input,
    });
  }

  public openTerminal(input: TerminalOpenInput): Promise<TerminalOpenResult> {
    return this.terminalRpc.open.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request: input,
    });
  }

  public attachTerminal(
    input: TerminalAttachInput,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalStreamItem> {
    return terminalSubscriptionAsAsyncIterable(
      () => this.terminalRpc.attach,
      this.runtimeNodeBootId,
      input,
      signal,
    );
  }

  public acquireTerminalLease(
    input: TerminalLeaseAcquireInput,
  ): Promise<TerminalLeaseAcquireResult> {
    return this.terminalRpc.lease.acquire.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request: input,
    });
  }

  public renewTerminalLease(
    input: TerminalLeaseRenewInput,
  ): Promise<TerminalLeaseRenewResult> {
    return this.terminalRpc.lease.renew.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request: input,
    });
  }

  public releaseTerminalLease(
    input: TerminalLeaseReleaseInput,
  ): Promise<TerminalLeaseReleaseResult> {
    return this.terminalRpc.lease.release.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request: input,
    });
  }

  public sendTerminalInput(input: TerminalInput): Promise<TerminalInputResult> {
    return this.terminalRpc.input.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request: input,
    });
  }

  public terminateTerminal(input: TerminalTerminateInput): Promise<TerminalDescriptor> {
    return this.terminalRpc.terminate.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      request: input,
    });
  }

  public resolveInteraction(input: ResolveInteractionInput): Promise<InteractionRecord> {
    return this.peer.rpc.interactions.resolve.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      interaction: input,
    });
  }

  public applyMetadata(operation: MetadataOperationRecord): Promise<MetadataOperationRecord> {
    return this.peer.rpc.metadata.settle.mutate({
      runtimeNodeBootId: this.runtimeNodeBootId,
      operation,
    });
  }

  public getCommand(commandId: CommandId): Promise<CommandRecord | null> {
    return this.peer.rpc.commands.get.query({
      runtimeNodeBootId: this.runtimeNodeBootId,
      commandId,
    });
  }
}

interface TerminalSubscriptionCallbacks {
  onData(value: TerminalStreamItem): void;
  onError(error: unknown): void;
  onComplete(): void;
  onStarted?(): void;
}

interface TerminalSubscriptionProcedure {
  subscribe(
    input: {
      runtimeNodeBootId: RuntimeNodeBootId;
      request: TerminalAttachInput;
    },
    callbacks: TerminalSubscriptionCallbacks,
  ): { unsubscribe(): void };
}

/** Bounded, abort-aware bridge for the runtime's ephemeral terminal stream. */
function terminalSubscriptionAsAsyncIterable(
  resolveProcedure: () => TerminalSubscriptionProcedure,
  runtimeNodeBootId: RuntimeNodeBootId,
  request: TerminalAttachInput,
  signal?: AbortSignal,
): AsyncIterable<TerminalStreamItem> {
  const capacity = TERMINAL_STREAM_BUFFER_ITEMS;
  return {
    [Symbol.asyncIterator](): AsyncIterator<TerminalStreamItem> {
      const values: TerminalStreamItem[] = [];
      const waiters: Array<{
        resolve(result: IteratorResult<TerminalStreamItem>): void;
        reject(error: unknown): void;
      }> = [];
      let ended = signal?.aborted ?? false;
      let failure: unknown;
      let started = false;
      let transportEnded = false;
      let handle: { unsubscribe(): void } | undefined;
      const stopTransport = (): void => {
        if (!handle || !started || transportEnded) return;
        transportEnded = true;
        handle.unsubscribe();
      };
      const finish = (error?: unknown): void => {
        if (ended) return;
        ended = true;
        failure = error;
        values.splice(0);
        signal?.removeEventListener("abort", abort);
        stopTransport();
        for (const waiter of waiters.splice(0)) {
          if (error === undefined) waiter.resolve({ done: true, value: undefined });
          else waiter.reject(error);
        }
      };
      const abort = (): void => finish();
      if (!ended) {
        try {
          handle = resolveProcedure().subscribe(
            {
              runtimeNodeBootId,
              request: {
                ...request,
                ...(request.cursor === undefined
                  ? {}
                  : { cursor: { ...request.cursor } }),
              },
            },
            {
              onStarted: () => {
                started = true;
                if (ended) stopTransport();
              },
              onData: (value) => {
                if (ended) return;
                const waiter = waiters.shift();
                if (waiter) waiter.resolve({ done: false, value });
                else if (values.length < capacity) values.push(value);
                else finish(new Error(`terminal subscription exceeded its ${capacity}-item buffer`));
              },
              onError: (error) => {
                transportEnded = true;
                finish(error);
              },
              onComplete: () => {
                transportEnded = true;
                finish();
              },
            },
          );
          if (ended) stopTransport();
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        } catch (error) {
          finish(error);
        }
      }
      return {
        next: () => {
          const value = values.shift();
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (failure !== undefined) return Promise.reject(failure);
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        return: () => {
          finish();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

export interface RuntimeNodeEventPumpOptions {
  connection: P2PRuntimeNodeConnection;
  /** Return false when the receiver has not committed the item yet. */
  onItem(item: RuntimeNodeEventItem): Promise<boolean | void> | boolean | void;
  onError?(error: unknown): void;
  initialCursor?: RuntimeNodeEventCursor;
  retryDelayMs?: (attempt: number) => number;
  /** Reconnects without committing a cursor when ingestion falls behind. */
  maxPendingItems?: number;
}

export class RuntimeNodeEventPumpBufferOverflowError extends Error {
  public constructor(public readonly capacity: number) {
    super(`Runtime node event ingestion exceeded its ${capacity}-item buffer`);
    this.name = "RuntimeNodeEventPumpBufferOverflowError";
  }
}

interface ManagedRuntimeNodeSubscription {
  handle?: { unsubscribe(): void };
  started: boolean;
  ended: boolean;
  stopRequested: boolean;
}

/** Recreates a runtime-node subscription after p2prpc session replacement. */
export class RuntimeNodeEventPump {
  readonly #connection: P2PRuntimeNodeConnection;
  readonly #onItem: (item: RuntimeNodeEventItem) => Promise<boolean | void> | boolean | void;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #retryDelayMs: (attempt: number) => number;
  readonly #maxPendingItems: number;
  readonly #cursor: RuntimeNodeEventCursor;
  readonly #queue: Array<{
    readonly generation: number;
    readonly item: RuntimeNodeEventItem;
  }> = [];
  #subscription: ManagedRuntimeNodeSubscription | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #attempt = 0;
  #pendingItems = 0;
  #generation = 0;
  #draining = false;
  #retryPending = false;

  public constructor(options: RuntimeNodeEventPumpOptions) {
    this.#connection = options.connection;
    this.#onItem = options.onItem;
    this.#onError = options.onError;
    this.#retryDelayMs =
      options.retryDelayMs ?? ((attempt) => Math.min(30_000, 250 * 2 ** attempt));
    this.#maxPendingItems = options.maxPendingItems ?? 4_096;
    if (!Number.isSafeInteger(this.#maxPendingItems) || this.#maxPendingItems < 1) {
      throw new TypeError("maxPendingItems must be a positive integer");
    }
    this.#cursor = options.initialCursor
      ? {
          native: { ...options.initialCursor.native },
        }
      : { native: {} };
  }

  public start(): void {
    if (this.#stopped || this.#subscription) return;
    this.#subscribe();
  }

  /** Last event position committed by onItem, safe to seed a replacement pump. */
  public get cursor(): RuntimeNodeEventCursor {
    return this.#cursorSnapshot();
  }

  public stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    this.#stopSubscription();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#retryPending = false;
    this.#pendingItems -= this.#queue.length;
    this.#queue.splice(0);
  }

  #subscribe(): void {
    if (this.#stopped) return;
    const generation = ++this.#generation;
    const cursor = this.#cursorSnapshot();
    const managed: ManagedRuntimeNodeSubscription = {
      started: false,
      ended: false,
      stopRequested: false,
    };
    this.#subscription = managed;
    try {
      managed.handle = this.#connection.peer.rpc.events.subscribe.subscribe({
        runtimeNodeBootId: this.#connection.runtimeNodeBootId,
        cursor,
      }, {
        onStarted: () => {
          managed.started = true;
          this.#finishDeferredStop(managed);
        },
        onData: (item: RuntimeNodeEventItem) => {
          this.#enqueue(generation, item);
        },
        onError: (error: unknown) => {
          managed.ended = true;
          this.#ended(generation, error);
        },
        onComplete: () => {
          managed.ended = true;
          this.#ended(generation);
        },
      });
      this.#finishDeferredStop(managed);
    } catch (error) {
      managed.ended = true;
      this.#ended(generation, error);
    }
  }

  #enqueue(generation: number, item: RuntimeNodeEventItem): void {
    if (this.#stopped || generation !== this.#generation) return;
    if (this.#pendingItems >= this.#maxPendingItems) {
      const error = new RuntimeNodeEventPumpBufferOverflowError(this.#maxPendingItems);
      this.#ended(generation, error);
      return;
    }
    this.#pendingItems += 1;
    this.#queue.push({ generation, item });
    this.#drain();
  }

  /**
   * Drain synchronous receivers synchronously. The control-node catalog path
   * is deliberately synchronous, and reconnect may begin with every durable
   * binding before native replay. Deferring each such item through a Promise
   * microtask would make a healthy 4,097-session runtime overflow the bounded
   * ingress mailbox even though the receiver was keeping up.
   *
   * A genuinely asynchronous receiver still uses the bounded queue and keeps
   * the original fail-and-retry behavior. This is not an unbounded transport
   * buffer or a relaxation of backpressure.
   */
  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    while (true) {
      const next = this.#queue.shift();
      if (next === undefined) {
        this.#draining = false;
        if (this.#retryPending && this.#pendingItems === 0) {
          this.#retryPending = false;
          this.#schedule();
        }
        return;
      }
      if (this.#stopped || next.generation !== this.#generation) {
        this.#pendingItems -= 1;
        continue;
      }
      if (this.#alreadyObserved(next.item)) {
        this.#pendingItems -= 1;
        continue;
      }

      let accepted: boolean | void | Promise<boolean | void>;
      try {
        accepted = this.#onItem(next.item);
      } catch (error) {
        this.#pendingItems -= 1;
        this.#ended(next.generation, error);
        continue;
      }
      if (isPromiseLike(accepted)) {
        void Promise.resolve(accepted)
          .then((value) => this.#accept(next, value))
          .catch((error: unknown) => this.#ended(next.generation, error))
          .finally(() => {
            this.#pendingItems -= 1;
            this.#draining = false;
            this.#drain();
          });
        return;
      }
      this.#accept(next, accepted);
      this.#pendingItems -= 1;
    }
  }

  #accept(
    pending: { readonly generation: number; readonly item: RuntimeNodeEventItem },
    accepted: boolean | void,
  ): void {
    if (this.#stopped || pending.generation !== this.#generation) return;
    if (accepted === false) {
      this.#ended(pending.generation);
      return;
    }
    this.#observe(pending.item);
    this.#attempt = 0;
  }

  #ended(generation: number, error?: unknown): void {
    if (this.#stopped || generation !== this.#generation) return;
    this.#generation += 1;
    this.#stopSubscription();
    if (error !== undefined && this.#onError) {
      try {
        this.#onError(error);
      } catch {
        // Diagnostics hooks are outside the ingestion contract. A logging
        // failure must not permanently disable the reconnecting event pump.
      }
    }
    this.#retryPending = true;
    if (!this.#draining) this.#drain();
  }

  #stopSubscription(): void {
    const managed = this.#subscription;
    this.#subscription = undefined;
    if (!managed) return;
    managed.stopRequested = true;
    this.#finishDeferredStop(managed);
  }

  #finishDeferredStop(managed: ManagedRuntimeNodeSubscription): void {
    if (
      !managed.stopRequested ||
      !managed.started ||
      managed.ended ||
      !managed.handle
    ) return;
    managed.ended = true;
    managed.handle.unsubscribe();
  }

  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    const delay = this.#retryDelayMs(this.#attempt++);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#subscribe();
    }, delay);
    this.#timer.unref();
  }

  #observe(item: RuntimeNodeEventItem): void {
    if (item.kind === "native") {
      this.#cursor.native[item.sessionId] = {
        runtimeEpoch: item.runtimeEpoch,
        sequence: item.sequence,
      };
    }
  }

  #alreadyObserved(item: RuntimeNodeEventItem): boolean {
    if (item.kind !== "native") return false;
    const position = this.#cursor.native[item.sessionId];
    return position?.runtimeEpoch === item.runtimeEpoch && position.sequence >= item.sequence;
  }

  #cursorSnapshot(): RuntimeNodeEventCursor {
    return {
      native: Object.fromEntries(
        Object.entries(this.#cursor.native).map(([sessionId, position]) => [
          sessionId,
          { ...position },
        ]),
      ) as RuntimeNodeEventCursor["native"],
    };
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}
