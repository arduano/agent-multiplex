import { randomUUID } from "node:crypto";
import { jsonValueSchema } from "@arduano/agent-multiplex-protocol";
import { EventQueue, diagnose, type Diagnostic } from "./events.js";
import { V7Error, errorDetails } from "./errors.js";
import { V7Store, requestHash, canonicalJson } from "./store.js";
import {
  hostSessionSchema, requestEnvelopeSchema, type ExecuteInput, type HistoryInput, type HostApi, type HostDescriptor,
  type HostSession, type HostView, type JsonValue, type NativeStateInput, type RenameInput,
  type RequestEnvelope, type RequestReceipt, type ResolveInput, type RootApi, type RootCreateInput,
  type RootDelta, type RootSnapshot, type RootWatchItem, type SessionMetadata,
  type SessionView, type SessionWatchInput, type UpdateMetadataInput,
} from "./protocol.js";

export interface RootServiceOptions {
  store: V7Store; rootId: string; bootId?: string; subscriberBufferSize?: number;
  diagnostic?: (event: Diagnostic) => void;
}
export interface HostAttachmentInput { descriptor: HostDescriptor; api: HostApi; sessions: HostSession[] }
interface HostConnection { token: string; descriptor: HostDescriptor; api: HostApi; sessions: Map<string, HostSession> }

/** Single fleet authority with one current route per exact Host identity.
 * Native views are memory-only. Slow/malformed sessions cannot invalidate peers. */
export class RootService implements RootApi {
  readonly #hosts = new Map<string, HostConnection>();
  readonly #knownHosts = new Map<string, HostDescriptor>();
  readonly #watchers = new Set<EventQueue<RootWatchItem>>();
  readonly #requests = new Map<string, { hash: string; operation: string; promise: Promise<RequestReceipt> }>();
  readonly #bootId: string;
  #revision = 0;
  #closed = false;
  public constructor(private readonly options: RootServiceOptions) {
    if (options.store.role !== "root" || options.store.instanceId !== options.rootId) throw new V7Error("STORE_ROLE", "Root needs its own V7 store");
    this.#bootId = options.bootId ?? randomUUID();
    if (!Number.isSafeInteger(options.subscriberBufferSize ?? 512) || (options.subscriberBufferSize ?? 512) < 1) throw new RangeError("Subscriber limit must be positive");
  }
  public attachHost(input: HostAttachmentInput): string {
    this.assertOpen();
    if (input.descriptor.protocolVersion !== 7) throw new V7Error("PROTOCOL_VERSION", "V7 Root rejects other wire generations");
    const advertised = input.api.descriptor();
    if (canonicalJson(advertised) !== canonicalJson(input.descriptor)) {
      throw new V7Error("HOST_IDENTITY", "Host port descriptor differs from authenticated attachment");
    }
    const previous = this.#knownHosts.get(input.descriptor.hostId);
    if (previous && previous.harness !== input.descriptor.harness) throw new V7Error("HOST_IDENTITY", "Host harness identity changed");
    const sessions = this.acceptSessions(input.descriptor, input.sessions);
    const token = randomUUID(), connection = { token, descriptor: structuredClone(input.descriptor), api: input.api, sessions };
    this.#hosts.set(input.descriptor.hostId, connection); this.#knownHosts.set(input.descriptor.hostId, structuredClone(input.descriptor));
    this.publish({ kind: "host", host: this.hostView(input.descriptor) });
    for (const metadata of this.options.store.registry()) if (metadata.hostId === input.descriptor.hostId) {
      this.publish({ kind: "session", session: this.sessionView(metadata) });
    }
    return token;
  }
  public updateHost(token: string, sessions: HostSession[]): boolean {
    const connection = [...this.#hosts.values()].find(host => host.token === token); if (!connection) return false;
    const next = this.acceptSessions(connection.descriptor, sessions);
    const affected = new Set([...connection.sessions.keys(), ...next.keys()]);
    const previous = connection.sessions;
    connection.sessions = next;
    for (const id of affected) {
      if (canonicalJson(previous.get(id) ?? null) === canonicalJson(next.get(id) ?? null)) continue;
      const metadata = this.options.store.metadata(id);
      if (metadata) this.publish({ kind: "session", session: this.sessionView(metadata) }); }
    return true;
  }
  public detachHost(token: string): boolean {
    const connection = [...this.#hosts.values()].find(host => host.token === token); if (!connection) return false;
    this.#hosts.delete(connection.descriptor.hostId);
    this.publish({ kind: "host", host: { ...connection.descriptor, online: false } });
    for (const metadata of this.options.store.registry()) if (metadata.hostId === connection.descriptor.hostId) {
      this.publish({ kind: "session", session: this.sessionView(metadata) }); }
    return true;
  }
  public snapshot(): RootSnapshot {
    this.assertOpen(); return { protocolVersion: 7, rootId: this.options.rootId, bootId: this.#bootId, revision: this.#revision,
      hosts: [...this.#knownHosts.values()].map(host => this.hostView(host)),
      sessions: this.options.store.registry().map(metadata => this.sessionView(metadata)) };
  }
  public watch(signal?: AbortSignal): AsyncIterable<RootWatchItem> {
    this.assertOpen(); const abort = () => queue.close();
    const queue = new EventQueue<RootWatchItem>(this.options.subscriberBufferSize ?? 512, () => {
      this.#watchers.delete(queue); signal?.removeEventListener("abort", abort);
    });
    this.#watchers.add(queue); queue.push({ kind: "snapshot", snapshot: this.snapshot() });
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) queue.close(); return queue;
  }
  public create(input: RootCreateInput): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.request(input, "create", input, async dispatch => {
      const host = this.requireHost(input.hostId);
      const prior = this.options.store.metadata(input.sessionId);
      if (prior) throw new V7Error("SESSION_EXISTS", "Logical session ID is already reserved");
      if (!input.title.trim()) throw new V7Error("TITLE", "Session title must not be blank");
      // Root rename is part of creation admission. Native rename is irrelevant.
      const metadata = { sessionId: input.sessionId, hostId: input.hostId, title: input.title,
        pinned: false, metadata: {}, createdAt: this.options.store.now(), archived: false, metadataRevision: 0 };
      await this.options.store.reserveMetadata(metadata);
      this.publish({ kind: "session", session: this.sessionView(metadata) });
      const nativeInput = { requestId: input.requestId, sessionId: input.sessionId, options: input.options,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.expectedAttachmentId === undefined ? {} : { expectedAttachmentId: input.expectedAttachmentId }) };
      await dispatch(); this.assertDispatchCurrent(host); const receipt = await host.api.create(nativeInput);
      this.assertCurrent(host); this.verifyReceipt(nativeInput, "create", receipt); await this.refreshHost(host); return this.remoteOutcome(receipt);
    });
  }
  public rename(input: RenameInput): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.request(input, "rename", input, async dispatch => {
      if (!input.title.trim()) throw new V7Error("TITLE", "Session title must not be blank");
      this.requireMetadata(input.sessionId);
      await dispatch(); const metadata = await this.options.store.patchMetadata(input.sessionId, { title: input.title }); this.publish({ kind: "session", session: this.sessionView(metadata) });
      return jsonValueSchema.parse(metadata);
    });
  }
  public updateMetadata(input: UpdateMetadataInput): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.request(input, "updateMetadata", input, async dispatch => {
      this.requireMetadata(input.sessionId);
      if (input.title !== undefined && !input.title.trim()) throw new V7Error("TITLE", "Session title must not be blank");
      await dispatch(); const metadata = await this.options.store.patchMetadata(input.sessionId, input);
      this.publish({ kind: "session", session: this.sessionView(metadata) });
      return jsonValueSchema.parse(metadata);
    });
  }
  public models(hostId: string) { return this.requireHost(hostId).api.models(); }
  public resume(input: RequestEnvelope) { input = structuredClone(input); return this.forward(input, "resume", api => api.resume(input)); }
  public stop(input: RequestEnvelope) { input = structuredClone(input); return this.forward(input, "stop", api => api.stop(input)); }
  public recover(input: RequestEnvelope) { input = structuredClone(input); return this.forward(input, "recover", api => api.recover(input)); }
  public archive(input: RequestEnvelope) { input = structuredClone(input); return this.forward(input, "archive", api => api.archive(input)); }
  public execute(input: ExecuteInput) { input = structuredClone(input); return this.forward(input, "execute", api => api.execute(input)); }
  public resolve(input: ResolveInput) { input = structuredClone(input); return this.forward(input, "resolve", api => api.resolve(input)); }
  public async history(input: HistoryInput) {
    const host = this.route(input.sessionId); const result = await host.api.history(input); this.assertCurrent(host); return result;
  }
  public async nativeState(input: NativeStateInput) {
    const host = this.route(input.sessionId); const result = await host.api.nativeState(input); this.assertCurrent(host); return result;
  }
  public async interactions(sessionId: string) {
    const host = this.route(sessionId); const result = await host.api.interactions(sessionId); this.assertCurrent(host); return result;
  }
  public watchSession(input: SessionWatchInput) {
    const host = this.route(input.sessionId); const stream = host.api.watchSession(input);
    const root = this;
    return (async function* () { for await (const event of stream) { root.assertCurrent(host); yield event; } })();
  }
  public async receipt(requestId: string): Promise<RequestReceipt | null> {
    const current = await this.options.store.receipt(requestId);
    if (!current || current.state !== "outcomeUnknown") return current;
    // Explicit original-ID reconciliation only. Never dispatch a native call.
    const metadata = this.options.store.metadata(current.sessionId), host = metadata && this.#hosts.get(metadata.hostId);
    if (!host || ["rename", "updateMetadata"].includes(current.operation)) return current;
    try {
      const remote = await host.api.receipt(requestId); this.assertCurrent(host);
      if (remote && remote.sessionId === current.sessionId && remote.operation === current.operation &&
        ["succeeded", "failed"].includes(remote.state)) {
        const request = current.request as Record<string, JsonValue>;
        const expected = current.operation === "create"
          ? { requestId: request.requestId, sessionId: request.sessionId, options: request.options,
            ...(request.context === undefined ? {} : { context: request.context }),
            ...(request.expectedAttachmentId === undefined ? {} : { expectedAttachmentId: request.expectedAttachmentId }) } : current.request;
        this.verifyReceipt(expected as RequestEnvelope, current.operation, remote);
        await this.refreshHost(host);
        if (current.operation === "archive" && remote.state === "succeeded") await this.archiveMetadata(current.sessionId);
        return await this.options.store.transition(requestId, remote.state as "succeeded" | "failed", {
          ...(remote.result === undefined ? {} : { result: remote.result }),
          ...(remote.error === undefined ? {} : { error: remote.error }),
        });
      }
    } catch (error) { diagnose(this.options.diagnostic, { role: "root", requestId, operation: "receipt", code: "reconciliationUnavailable", error }); }
    return await this.options.store.receipt(requestId) ?? current;
  }
  private forward(input: RequestEnvelope, operation: string, action: (api: HostApi) => Promise<RequestReceipt>) {
    return this.request(input, operation, input, async dispatch => {
      const host = this.route(input.sessionId); await dispatch(); this.assertDispatchCurrent(host);
      const receipt = await action(host.api); this.assertCurrent(host); this.verifyReceipt(input, operation, receipt);
      await this.refreshHost(host);
      if (operation === "archive" && receipt.state === "succeeded") await this.archiveMetadata(input.sessionId);
      return this.remoteOutcome(receipt);
    });
  }
  private async request(input: RequestEnvelope, operation: string, payload: unknown,
    action: (dispatch: () => Promise<void>) => Promise<JsonValue>): Promise<RequestReceipt> {
    this.assertOpen(); requestEnvelopeSchema.parse({ requestId: input.requestId, sessionId: input.sessionId });
    const previous = this.#requests.get(input.requestId);
    if (previous) {
      if (previous.operation !== operation || previous.hash !== requestHash(payload)) throw new V7Error("REQUEST_CONFLICT", "Request ID already names a different immutable operation");
      return previous.promise;
    }
    const work = (async () => {
      const admitted = await this.options.store.admit(input.requestId, input.sessionId, operation, payload);
      if (!admitted.fresh) return admitted.receipt;
      let dispatched = false;
      const dispatch = async () => { if (!dispatched) { await this.options.store.transition(input.requestId, "dispatched"); dispatched = true; } };
      try { const result = await action(dispatch); if (!dispatched) await dispatch();
        return await this.options.store.transition(input.requestId, "succeeded", { result }); }
      catch (error) {
        const remote = error instanceof RemoteReceiptError ? error.receipt : undefined;
        const state = remote?.state === "failed" || !dispatched ||
          (error instanceof V7Error && ["METADATA_CONFLICT", "HOST_REPLACED_BEFORE_DISPATCH"].includes(error.code)) ? "failed" : "outcomeUnknown";
        diagnose(this.options.diagnostic, { role: "root", operation, requestId: input.requestId, sessionId: input.sessionId, code: state, error });
        return await this.options.store.transition(input.requestId, state, { error: remote?.error ?? errorDetails(error) });
      }
    })().finally(() => { this.#requests.delete(input.requestId); });
    this.#requests.set(input.requestId, { operation, hash: requestHash(payload), promise: work }); return work;
  }
  private remoteOutcome(receipt: RequestReceipt): JsonValue {
    if (receipt.state !== "succeeded") throw new RemoteReceiptError(receipt); return receipt.result ?? null;
  }
  private verifyReceipt(input: RequestEnvelope, operation: string, receipt: RequestReceipt): void {
    if (receipt.requestId !== input.requestId || receipt.sessionId !== input.sessionId ||
      receipt.operation !== operation || receipt.payloadHash !== requestHash(input)) {
      throw new V7Error("RECEIPT_IDENTITY", "Native response names a different immutable request");
    }
  }
  private async archiveMetadata(sessionId: string): Promise<void> {
    const metadata = await this.options.store.patchMetadata(sessionId, { archived: true });
    this.publish({ kind: "session", session: this.sessionView(metadata) });
  }
  private async refreshHost(host: HostConnection): Promise<void> {
    // Response to a mutation is authoritative; optional refresh failure cannot
    // change it into an uncertain outcome or take the Host offline.
    try { const sessions = await host.api.list(); this.assertCurrent(host); this.updateHost(host.token, sessions); }
    catch (error) { diagnose(this.options.diagnostic, { role: "root", operation: "refresh", code: "snapshotUnavailable", error }); }
  }
  private acceptSessions(host: HostDescriptor, sessions: HostSession[]): Map<string, HostSession> {
    const result = new Map<string, HostSession>();
    for (const candidate of sessions) {
      try {
        const session = hostSessionSchema.parse(candidate), metadata = this.options.store.metadata(session.sessionId);
        if (session.hostId !== host.hostId || session.harness !== host.harness || (metadata && metadata.hostId !== host.hostId)) {
          throw new V7Error("SESSION_OWNER", "Session targets another Host");
        }
        if (result.has(session.sessionId)) throw new V7Error("SESSION_DUPLICATE", "Host snapshot contains a duplicate session");
        if (!metadata) {
          // A root restart/crash cannot lose a successfully created logical ID:
          // registry reservation precedes dispatch. Unknown Host-only bindings
          // remain diagnostic evidence, never silently adopted into the catalog.
          throw new V7Error("SESSION_UNREGISTERED", "Host binding is absent from the Root registry");
        }
        result.set(session.sessionId, session);
      } catch (error) { diagnose(this.options.diagnostic, { role: "root", operation: "snapshot", code: "sessionRejected", error }); }
    }
    return result;
  }
  private sessionView(metadata: SessionMetadata): SessionView {
    return structuredClone({ ...metadata, native: this.#hosts.get(metadata.hostId)?.sessions.get(metadata.sessionId) ?? null });
  }
  private hostView(host: HostDescriptor): HostView { return structuredClone({ ...host, online: this.#hosts.has(host.hostId) }); }
  private route(sessionId: string): HostConnection { return this.requireHost(this.requireMetadata(sessionId).hostId); }
  private requireHost(hostId: string): HostConnection {
    this.assertOpen(); const host = this.#hosts.get(hostId); if (!host) throw new V7Error("HOST_OFFLINE", "Host is not connected"); return host;
  }
  private requireMetadata(sessionId: string): SessionMetadata {
    const metadata = this.options.store.metadata(sessionId); if (!metadata) throw new V7Error("SESSION_MISSING", "Session is absent from Root registry"); return metadata;
  }
  private assertCurrent(host: HostConnection): void {
    if (this.#hosts.get(host.descriptor.hostId) !== host) throw new V7Error("STALE_HOST", "Response belongs to a retired Host connection");
  }
  private assertDispatchCurrent(host: HostConnection): void {
    if (this.#hosts.get(host.descriptor.hostId) !== host) {
      throw new V7Error("HOST_REPLACED_BEFORE_DISPATCH", "Host connection changed before this native call was dispatched");
    }
  }
  private publish(value: RootDelta extends infer E ? E extends RootDelta
    ? Omit<E, "protocolVersion" | "rootId" | "bootId" | "revision"> : never : never): void {
    const delta = { ...value, protocolVersion: 7, rootId: this.options.rootId, bootId: this.#bootId, revision: ++this.#revision } as RootDelta;
    for (const queue of this.#watchers) queue.push({ kind: "delta", delta });
  }
  private assertOpen(): void { if (this.#closed) throw new V7Error("CLOSED", "Root is closed"); }
  public async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; await Promise.allSettled([...this.#requests.values()].map(v => v.promise));
    for (const queue of this.#watchers) queue.close(); await this.options.store.close(); this.#hosts.clear();
  }
}
class RemoteReceiptError extends Error {
  public constructor(public readonly receipt: RequestReceipt) { super("Native request requires original-ID reconciliation"); }
}
