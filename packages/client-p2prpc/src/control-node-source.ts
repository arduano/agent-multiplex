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
import {
  accessSnapshotSchema,
  accessStreamItemSchema,
  TERMINAL_STREAM_BUFFER_ITEMS,
  type AccessStreamItem,
  type ArchiveOperationId,
  type ArchiveRequest,
  type CommandEnvelope,
  type CommandId,
  type Harness,
  type LaunchId,
  type LaunchListInput,
  type LaunchProfileIdentity,
  type LaunchProviderId,
  type LaunchRequest,
  type NativeHistoryRequest,
  type MetadataPatch,
  type ResolveInteractionInput,
  type ResumeCommand,
  type RuntimeNodeId,
  type SessionId,
  type SessionSearchInput,
  type StopCommand,
  type StreamCursor,
  terminalStreamItemSchema,
  type TerminalAttachInput,
  type TerminalGetInput,
  type TerminalInput,
  type TerminalLeaseAcquireInput,
  type TerminalLeaseReleaseInput,
  type TerminalLeaseRenewInput,
  type TerminalOpenInput,
  type TerminalStreamItem,
  type TerminalTerminateInput,
  type TopologyDetachInput,
  type TopologyForceDetachInput,
  type AuthorityPromoteInput,
} from "@arduano/agent-multiplex-protocol";
import type {
  ControlNodeSourceClient,
  GatewaySourceSnapshot,
} from "@arduano/agent-multiplex-gateway-core";
import { GatewayRoutingError } from "@arduano/agent-multiplex-gateway-core";
import { readValidatedTRPCClientErrorCode } from "@arduano/agent-multiplex-control-node-core";

import type {
  ConnectedControlNodeSource,
  P2PControlNodeSourceHandle,
} from "./p2p.js";

/** Adapts one pinned p2prpc control-node peer to the gateway-core source port. */
export class P2PControlNodeSourceClient implements ControlNodeSourceClient {
  public constructor(
    private readonly handle: P2PControlNodeSourceHandle,
    private readonly onRenewedTicket?: (ticket: string) => void,
  ) {}

  public reconnect(): Promise<ConnectedControlNodeSource> {
    return this.handle.reconnect();
  }

  public async loadSnapshot(): Promise<GatewaySourceSnapshot> {
    const access = await this.#access();
    const snapshot = accessSnapshotSchema.nullable().parse(
      await access.sources.snapshot.query(),
    );
    if (snapshot === null) {
      throw new Error("configured p2prpc source is an access gateway, not a control node");
    }
    return {
      manifest: snapshot.source.manifest,
      parentByControlNodeId: snapshot.source.parentByControlNodeId,
      controlNodes: snapshot.controlNodes,
      runtimeNodes: snapshot.runtimeNodes,
      sessions: snapshot.sessions,
      interactions: snapshot.interactions,
      metadataOperations: snapshot.metadataOperations,
    };
  }

  public async *watch(
    cursor: StreamCursor,
    signal?: AbortSignal,
  ): AsyncIterable<AccessStreamItem> {
    const access = await this.#access();
    const queue = new SubscriptionQueue<AccessStreamItem>(4_096);
    const subscription = access.sessions.watch.subscribe(
      { sessions: "all", cursor, includeNative: true },
      {
        onData: (value) => {
          try {
            queue.push(accessStreamItemSchema.parse(value));
          } catch (cause) {
            queue.fail(cause);
          }
        },
        onError: (cause) => queue.fail(cause),
        onComplete: () => queue.fail(new Error("control-node source stream ended")),
      },
    );
    const stop = (): void => {
      subscription.unsubscribe();
      queue.close();
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const item of queue) yield item;
    } finally {
      signal?.removeEventListener("abort", stop);
      stop();
    }
  }

  public async listHarnessCatalog(runtimeNodeId?: RuntimeNodeId) {
    return this.#query(async () =>
      (await this.#access()).harness.catalog.query(
        runtimeNodeId === undefined ? undefined : { runtimeNodeId },
      ));
  }

  public async listModels(runtimeNodeId: RuntimeNodeId, harness: Harness) {
    return this.#query(async () =>
      (await this.#access()).harness.models.query({
        runtimeNodeId,
        harness,
      }));
  }

  public async listLaunchProfiles(filter?: {
    readonly runtimeNodeId?: RuntimeNodeId;
    readonly providerId?: LaunchProviderId;
    readonly harness?: Harness;
  }) {
    return this.#query(async () =>
      (await this.#access()).launchProfiles.list.query(filter));
  }

  public async listLaunchModels(
    runtimeNodeId: RuntimeNodeId,
    profile: LaunchProfileIdentity,
    harness: Harness,
  ) {
    return this.#query(async () =>
      (await this.#access()).launchProfiles.models.query({
        runtimeNodeId,
        profile,
        harness,
      }));
  }

  public async createLaunch(request: LaunchRequest) {
    return this.#mutation(async () =>
      (await this.#access()).launches.create.mutate(request));
  }

  public async getLaunch(launchId: LaunchId) {
    return this.#query(async () =>
      (await this.#access()).launches.get.query(launchId));
  }

  public async listLaunches(query: LaunchListInput) {
    return this.#query(async () =>
      (await this.#access()).launches.list.query(query));
  }

  public async searchSessions(query: SessionSearchInput) {
    return this.#query(async () =>
      (await this.#access()).sessions.search.query(query));
  }

  public async getSession(sessionId: SessionId) {
    return this.#query(async () =>
      (await this.#access()).sessions.get.query(sessionId));
  }

  public async refresh(runtimeNodeId: RuntimeNodeId) {
    return this.#mutation(async () =>
      (await this.#access()).sessions.refresh.mutate({ runtimeNodeId }));
  }

  public async resume(command: ResumeCommand) {
    return this.#mutation(async () =>
      (await this.#access()).sessions.resume.mutate(command));
  }

  public async stop(command: StopCommand) {
    return this.#mutation(async () =>
      (await this.#access()).sessions.stop.mutate(command));
  }

  public async archive(request: ArchiveRequest) {
    return this.#mutation(async () =>
      (await this.#access()).sessions.archive.mutate(request));
  }

  public async getArchive(archiveOperationId: ArchiveOperationId) {
    return this.#query(async () =>
      (await this.#access()).archives.get.query(archiveOperationId));
  }

  public async execute(command: CommandEnvelope) {
    return this.#mutation(async () =>
      (await this.#access()).sessions.execute.mutate(command));
  }

  public async readNativeHistory(
    sessionId: SessionId,
    request: NativeHistoryRequest,
  ) {
    return this.#query(async () =>
      (await this.#access()).sessions.readNativeHistory.query({
        sessionId,
        request,
      }));
  }

  public async beginImageUpload(input: ImageBeginUploadInput): Promise<ImageUploadState> {
    return this.#mutation(async () => (await this.#access()).images.beginUpload.mutate(input));
  }

  public async writeImageUpload(input: ImageWriteUploadInput): Promise<ImageUploadState> {
    return this.#mutation(async () => (await this.#access()).images.writeUpload.mutate(input));
  }

  public async commitImageUpload(input: ImageUploadIdInput): Promise<ImageDescriptor> {
    return this.#mutation(async () => (await this.#access()).images.commitUpload.mutate(input));
  }

  public async abortImageUpload(input: ImageUploadIdInput): Promise<ImageAbortUploadResult> {
    return this.#mutation(async () => (await this.#access()).images.abortUpload.mutate(input));
  }

  public async resolveImagePath(input: ImageResolvePathInput): Promise<ImageDescriptor> {
    return this.#mutation(async () => (await this.#access()).images.resolvePath.mutate(input));
  }

  public async readImage(input: ImageReadInput): Promise<ImageReadResult> {
    return this.#query(async () => (await this.#access()).images.read.query(input));
  }

  public async imageLimits(input: ImageTarget): Promise<ImageLimits> {
    return this.#query(async () => (await this.#access()).images.limits.query(input));
  }

  public async getTerminal(input: TerminalGetInput) {
    return this.#query(async () =>
      (await this.#access()).terminals.get.query(input));
  }

  public async openTerminal(input: TerminalOpenInput) {
    return this.#mutation(async () =>
      (await this.#access()).terminals.open.mutate(input));
  }

  public async *attachTerminal(
    input: TerminalAttachInput,
    signal?: AbortSignal,
  ) {
    const access = await this.#access();
    const queue = new SubscriptionQueue<TerminalStreamItem>(TERMINAL_STREAM_BUFFER_ITEMS);
    const subscription = access.terminals.attach.subscribe(input, {
      onData: (value) => {
        try {
          queue.push(terminalStreamItemSchema.parse(value));
        } catch (cause) {
          queue.fail(cause);
        }
      },
      onError: (cause) => queue.fail(classifyQueryFailure(cause)),
      onComplete: () => queue.close(),
    });
    const stop = (): void => {
      subscription.unsubscribe();
      queue.close();
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const item of queue) yield item;
    } finally {
      signal?.removeEventListener("abort", stop);
      stop();
    }
  }

  public async acquireTerminalLease(input: TerminalLeaseAcquireInput) {
    return this.#mutation(async () =>
      (await this.#access()).terminals.lease.acquire.mutate(input));
  }

  public async renewTerminalLease(input: TerminalLeaseRenewInput) {
    return this.#mutation(async () =>
      (await this.#access()).terminals.lease.renew.mutate(input));
  }

  public async releaseTerminalLease(input: TerminalLeaseReleaseInput) {
    return this.#mutation(async () =>
      (await this.#access()).terminals.lease.release.mutate(input));
  }

  public async sendTerminalInput(input: TerminalInput) {
    return this.#mutation(async () =>
      (await this.#access()).terminals.input.mutate(input));
  }

  public async terminateTerminal(input: TerminalTerminateInput) {
    return this.#mutation(async () =>
      (await this.#access()).terminals.terminate.mutate(input));
  }

  public async patchMetadata(patch: MetadataPatch) {
    return this.#mutation(async () =>
      (await this.#access()).metadata.patch.mutate(patch));
  }

  public async resolveInteraction(input: ResolveInteractionInput) {
    return this.#mutation(async () =>
      (await this.#access()).interactions.resolve.mutate(input));
  }

  public async getCommand(commandId: CommandId) {
    return this.#query(async () =>
      (await this.#access()).commands.get.query(commandId));
  }

  public async detach(input: TopologyDetachInput) {
    return this.#mutation(async () =>
      (await this.#access()).topology.detach.mutate(input));
  }

  public async forceDetach(input: TopologyForceDetachInput) {
    return this.#mutation(async () =>
      (await this.#access()).topology.forceDetach.mutate(input));
  }

  public async promote(input: AuthorityPromoteInput) {
    return this.#mutation(async () =>
      (await this.#access()).authority.promote.mutate(input));
  }

  async #mutation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      throw classifyMutationFailure(cause);
    }
  }

  async #query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      throw classifyQueryFailure(cause);
    }
  }

  async #access(): Promise<ConnectedControlNodeSource["access"]> {
    const connected = await this.handle.connect();
    // Persist the locator that actually established this pinned connection.
    // This also clears an expired persisted renewal after bootstrap fallback
    // when the enrollment response does not include another renewal.
    if (connected.target.locator.kind === "ticket") {
      this.onRenewedTicket?.(connected.target.locator.ticket);
    }
    return connected.access;
  }
}

/**
 * Preserve the dispatch guarantee made by p2prpc. Its OUTCOME_UNKNOWN error
 * means request bytes may have reached the peer; every other transport error
 * occurred before dispatch. A tRPC error shape is a definitive remote reply.
 */
export function classifyMutationFailure(cause: unknown): unknown {
  if (cause instanceof GatewayRoutingError) return cause;
  const classified = classifyKnownSourceFailure(cause);
  if (classified !== undefined) return classified;
  // Unknown source implementations cannot prove whether dispatch happened.
  return cause;
}

/** Classify an idempotent source request without exposing upstream text/data. */
function classifyQueryFailure(cause: unknown): GatewayRoutingError {
  if (cause instanceof GatewayRoutingError) return cause;
  return classifyKnownSourceFailure(cause) ?? new GatewayRoutingError(
    "INTERNAL",
    "control-node source request failed",
    undefined,
    { cause },
  );
}

type RemoteTrpcCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "SERVICE_UNAVAILABLE"
  | "TOO_MANY_REQUESTS"
  | "TIMEOUT"
  | "GATEWAY_TIMEOUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "METHOD_NOT_SUPPORTED"
  | "NOT_IMPLEMENTED"
  | "BAD_GATEWAY"
  | "INTERNAL_SERVER_ERROR";

type TransportCode =
  | "UNAUTHORIZED"
  | "INCOMPATIBLE_PROTOCOL"
  | "REJECTED"
  | "CANCELLED"
  | "TIMEOUT"
  | "DISCONNECTED"
  | "INVALID_FRAME"
  | "RESOURCE_LIMIT"
  | "INTEGRITY_FAILED"
  | "OUTCOME_UNKNOWN"
  | "NOT_FOUND"
  | "INTERNAL";

function classifyKnownSourceFailure(cause: unknown): GatewayRoutingError | undefined {
  const visited = new Set<unknown>();
  let current = cause;
  let remoteCode: RemoteTrpcCode | undefined;
  let sawRemoteEnvelope = false;
  let transportCode: TransportCode | undefined;
  let unavailableTransport = false;
  let outcomeUnknown = false;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    try {
      const validatedRemoteCode = readValidatedTRPCClientErrorCode(current);
      if (validatedRemoteCode !== undefined) {
        sawRemoteEnvelope = true;
        const code = remoteTrpcCode(validatedRemoteCode);
        if (code === "BAD_GATEWAY") outcomeUnknown = true;
        remoteCode ??= code;
      }
      const code = transportErrorCode(Reflect.get(current, "code"));
      if (code === "OUTCOME_UNKNOWN") outcomeUnknown = true;
      else if (
        code === "CANCELLED" || code === "TIMEOUT" ||
        code === "DISCONNECTED" || code === "INVALID_FRAME" ||
        code === "RESOURCE_LIMIT" || code === "INTEGRITY_FAILED"
      ) unavailableTransport = true;
      else transportCode ??= code;
      current = Reflect.get(current, "cause");
    } catch {
      break;
    }
  }

  // An ambiguous dispatch can contain a nested disconnect describing why its
  // response was lost. Never downgrade that stronger guarantee to retryable.
  if (outcomeUnknown) return sourceRoutingError("OUTCOME_UNKNOWN", cause);
  if (remoteCode !== undefined) return remoteRoutingError(remoteCode, cause);
  if (unavailableTransport) return sourceRoutingError("UNAVAILABLE", cause);
  if (transportCode !== undefined) {
    const code = transportCode === "UNAUTHORIZED" || transportCode === "REJECTED"
      ? "UNAUTHORIZED"
      : transportCode === "NOT_FOUND"
        ? "NOT_FOUND"
        : transportCode === "INCOMPATIBLE_PROTOCOL"
          ? "UNSUPPORTED"
          : "INTERNAL";
    return sourceRoutingError(code, cause);
  }
  return sawRemoteEnvelope ? sourceRoutingError("INTERNAL", cause) : undefined;
}

function remoteTrpcCode(code: string): RemoteTrpcCode | undefined {
  switch (code) {
    case "NOT_FOUND":
    case "CONFLICT":
    case "PRECONDITION_FAILED":
    case "SERVICE_UNAVAILABLE":
    case "TOO_MANY_REQUESTS":
    case "TIMEOUT":
    case "GATEWAY_TIMEOUT":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "METHOD_NOT_SUPPORTED":
    case "NOT_IMPLEMENTED":
    case "BAD_GATEWAY":
    case "INTERNAL_SERVER_ERROR":
      return code;
    default:
      return undefined;
  }
}

function transportErrorCode(code: unknown): TransportCode | undefined {
  switch (code) {
    case "UNAUTHORIZED":
    case "INCOMPATIBLE_PROTOCOL":
    case "REJECTED":
    case "CANCELLED":
    case "TIMEOUT":
    case "DISCONNECTED":
    case "INVALID_FRAME":
    case "RESOURCE_LIMIT":
    case "INTEGRITY_FAILED":
    case "OUTCOME_UNKNOWN":
    case "NOT_FOUND":
    case "INTERNAL":
      return code;
    default:
      return undefined;
  }
}

function remoteRoutingError(code: RemoteTrpcCode, cause: unknown): GatewayRoutingError {
  const routingCode = code === "NOT_FOUND"
    ? "NOT_FOUND"
    : code === "CONFLICT" || code === "PRECONDITION_FAILED"
      ? "CONFLICT"
      : code === "SERVICE_UNAVAILABLE" || code === "TOO_MANY_REQUESTS" ||
          code === "TIMEOUT" || code === "GATEWAY_TIMEOUT"
        ? "UNAVAILABLE"
        : code === "UNAUTHORIZED" || code === "FORBIDDEN"
          ? "UNAUTHORIZED"
          : code === "METHOD_NOT_SUPPORTED" || code === "NOT_IMPLEMENTED"
            ? "UNSUPPORTED"
            : code === "BAD_GATEWAY"
              ? "OUTCOME_UNKNOWN"
              : "INTERNAL";
  return sourceRoutingError(routingCode, cause);
}

function sourceRoutingError(
  code: GatewayRoutingError["code"],
  cause: unknown,
): GatewayRoutingError {
  const message = code === "NOT_FOUND"
    ? "control-node source did not find the requested resource"
    : code === "CONFLICT"
      ? "control-node source rejected conflicting state"
      : code === "UNAVAILABLE"
        ? "control-node source is unavailable"
        : code === "OUTCOME_UNKNOWN"
          ? "control-node source request outcome is unknown"
          : code === "UNAUTHORIZED"
            ? "control-node source rejected its authenticated gateway"
            : code === "UNSUPPORTED"
              ? "control-node source does not support the request"
              : "control-node source request failed";
  return new GatewayRoutingError(code, message, undefined, { cause });
}

class SubscriptionQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(reason: unknown): void;
  }> = [];
  #closed = false;
  #failure: unknown;

  public constructor(private readonly capacity: number) {}

  public push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (this.#values.length < this.capacity) this.#values.push(value);
    else this.fail(new Error(`control-node source exceeded its ${this.capacity}-item buffer`));
  }

  public fail(cause: unknown): void {
    if (this.#closed) return;
    this.#failure = cause;
    this.#closed = true;
    this.#values.splice(0);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(cause);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values.splice(0);
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#failure !== undefined) return Promise.reject(this.#failure);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
