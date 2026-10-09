import { randomUUID } from "node:crypto";
import {
  jsonValueSchema, jsonWireByteUpperBound, nativePayloadSchema, harnessCommandSchema, type NativePayload,
} from "@arduano/agent-multiplex-protocol";
import type { NativePort, AdapterEvent, AdapterSession } from "./native-port.js";
import { EventQueue, diagnose, type Diagnostic } from "./events.js";
import { NativeOperationError, V7Error, errorDetails } from "./errors.js";
import { V7Store, requestHash } from "./store.js";
import {
  V7_PROTOCOL_VERSION, createSessionInputSchema, executeInputSchema, resolveInputSchema, requestEnvelopeSchema,
  type CreateSessionInput, type ExecuteInput, type HistoryInput, type HostApi, type HostDescriptor,
  type HostEvent, type HostSession, type JsonValue, type NativeInteraction, type NativeStateInput,
  type RequestEnvelope, type RequestReceipt, type ResolveInput, type SessionBinding,
  type SessionEvent, type SessionWatchInput,
} from "./protocol.js";

export interface HostServiceOptions {
  store: V7Store; hostId: string; name: string; native: NativePort;
  bootId?: string; eventBufferSize?: number; subscriberBufferSize?: number; pendingEventLimit?: number;
  eventBufferBytes?: number; pendingEventBytes?: number;
  externalize?: (binding: SessionBinding, payload: JsonValue) => Promise<NativePayload>;
  prepareCommand?: (input: ExecuteInput) => Promise<ExecuteInput["command"]>;
  diagnostic?: (event: Diagnostic) => void;
}
interface Attachment {
  id: string; native: AdapterSession; unsubscribe: () => void; pending: number;
  pendingBytes: number;
  tail: Promise<void>; recoveryRequired: boolean;
  eventGap: boolean;
  interactions: Map<string, { wire: NativeInteraction; resolve: (response: JsonValue) => Promise<void> }>;
}
interface Ring { sequence: number; events: SessionEvent[]; bytes: number }

/** One coordinator per attached native session. No global lifecycle reducer,
 * persistent native observations, prompt queue or startup attachment job. */
export class HostService implements HostApi {
  readonly #active = new Map<string, Attachment>();
  readonly #sessionWork = new Set<string>();
  readonly #requests = new Map<string, { hash: string; operation: string; promise: Promise<RequestReceipt> }>();
  readonly #listeners = new Set<(event: HostEvent) => void>();
  readonly #watchers = new Map<string, Set<EventQueue<SessionEvent>>>();
  readonly #rings = new Map<string, Ring>();
  readonly #descriptor: HostDescriptor;
  readonly #ringSize: number;
  readonly #subscriberSize: number;
  readonly #pendingLimit: number;
  readonly #ringBytes: number;
  readonly #pendingBytes: number;
  #closed = false;
  public constructor(private readonly options: HostServiceOptions) {
    if (options.store.role !== "host" || options.store.instanceId !== options.hostId) throw new V7Error("STORE_ROLE", "Host needs its own V7 store");
    this.#descriptor = { protocolVersion: V7_PROTOCOL_VERSION, hostId: options.hostId,
      name: options.name, harness: options.native.harness, bootId: options.bootId ?? randomUUID() };
    this.#ringSize = options.eventBufferSize ?? 256;
    this.#subscriberSize = options.subscriberBufferSize ?? 512;
    this.#pendingLimit = options.pendingEventLimit ?? 256;
    this.#ringBytes = options.eventBufferBytes ?? 8 * 1024 * 1024;
    this.#pendingBytes = options.pendingEventBytes ?? 32 * 1024 * 1024;
    for (const size of [this.#ringSize, this.#subscriberSize, this.#pendingLimit, this.#ringBytes, this.#pendingBytes]) {
      if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("Event limits must be positive integers");
    }
  }
  public descriptor(): HostDescriptor { return { ...this.#descriptor }; }
  public list(): HostSession[] { return this.options.store.bindings().map(binding => this.view(binding)); }
  public models() { this.assertOpen(); return this.options.native.models(); }
  public receipt(requestId: string): Promise<RequestReceipt | null> { return this.options.store.receipt(requestId); }
  public interactions(sessionId: string): NativeInteraction[] {
    const active = this.#active.get(sessionId); this.requireBinding(sessionId);
    return active ? [...active.interactions.values()].map(i => structuredClone(i.wire)) : [];
  }
  public subscribe(listener: (event: HostEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  public create(input: CreateSessionInput): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "create", input, async dispatch => {
      const parsed = createSessionInputSchema.parse(input);
      if (parsed.options.harness !== this.options.native.harness) throw new V7Error("HARNESS", "Host serves another harness");
      if (this.options.store.binding(input.sessionId)) throw new V7Error("SESSION_EXISTS", "Session already has a native binding");
      await dispatch();
      const native = await this.options.native.create(parsed.options);
      const binding: SessionBinding = { sessionId: input.sessionId, hostId: this.options.hostId,
        harness: native.harness, adapterScopeId: native.adapterScopeId, vendorSessionId: native.vendorSessionId,
        cwd: native.cwd, createdAt: this.options.store.now(), archived: false };
      await this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public resume(input: RequestEnvelope): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "resume", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId);
      const active = this.#active.get(input.sessionId);
      if (active && active.native.status() !== "stopped") return jsonValueSchema.parse(this.view(binding));
      if (active) { await dispatch(); await active.native.stop(); this.retire(input.sessionId, active); }
      await dispatch(); const native = await this.options.native.resume(binding); await this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public stop(input: RequestEnvelope): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "stop", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId);
      const active = this.#active.get(input.sessionId);
      if (active) { await dispatch(); await active.native.stop(); this.retire(input.sessionId, active); }
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public recover(input: RequestEnvelope): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "recover", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId), active = this.#active.get(input.sessionId);
      await dispatch();
      if (active) { await active.native.stop(); this.retire(input.sessionId, active); }
      const native = await this.options.native.resume(binding); await this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public archive(input: RequestEnvelope): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "archive", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId, true);
      if (binding.archived) return jsonValueSchema.parse(this.view(binding));
      const active = this.#active.get(input.sessionId);
      if (active) { await dispatch(); await active.native.stop(); this.retire(input.sessionId, active); }
      if (this.options.native.release) { await dispatch(); await this.options.native.release(binding); }
      await this.options.store.putBinding({ ...binding, archived: true }); this.publishSession(input.sessionId);
      return jsonValueSchema.parse(this.view({ ...binding, archived: true }));
    });
  }
  public execute(input: ExecuteInput): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "execute", input, async dispatch => {
      const parsed = executeInputSchema.parse(input), active = this.requireActive(input.sessionId);
      if (parsed.command.harness !== this.options.native.harness) throw new V7Error("HARNESS", "Command targets another harness");
      if (active.recoveryRequired && ["send", "steer"].includes(parsed.command.command.type)) {
        throw new V7Error("INTERACTION_UNCERTAIN", "Recover this session before starting new native work");
      }
      if (parsed.images?.length && !this.options.prepareCommand) throw new V7Error("UNSUPPORTED", "Host cannot prepare image-bearing native commands");
      const command = this.options.prepareCommand ? harnessCommandSchema.parse(await this.options.prepareCommand(parsed)) : parsed.command;
      this.assertCurrent(input.sessionId, active);
      await dispatch(); this.assertCurrent(input.sessionId, active);
      if (active.recoveryRequired && ["send", "steer"].includes(command.command.type)) {
        throw new NativeOperationError("INTERACTION_UNCERTAIN", "Recover this session before starting new native work", "failed");
      }
      return (await active.native.execute(command)) ?? null;
    });
  }
  public resolve(input: ResolveInput): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "resolve", input, async dispatch => {
      const parsed = resolveInputSchema.parse(input), active = this.requireActive(input.sessionId);
      const interaction = active.interactions.get(parsed.interactionId);
      if (!interaction) throw new V7Error("INTERACTION_STALE", "Native interaction is no longer attached");
      await dispatch(); this.assertCurrent(input.sessionId, active);
      if (active.interactions.get(parsed.interactionId) !== interaction) {
        throw new NativeOperationError("INTERACTION_STALE", "Native interaction settled before this reply was dispatched", "failed");
      }
      await interaction.resolve(parsed.response);
      active.interactions.delete(parsed.interactionId);
      this.publish(input.sessionId, { kind: "interactionSettled", interactionId: parsed.interactionId, state: "resolved" });
      return null;
    });
  }
  public async history(input: HistoryInput) {
    this.assertOpen(); const binding = this.requireBinding(input.sessionId, true), active = this.#active.get(input.sessionId);
    if (input.request.harness !== this.options.native.harness) throw new V7Error("HARNESS", "History targets another harness");
    if (!active && !this.options.native.history) throw new V7Error("UNSUPPORTED", "Native owner does not offer detached history reads");
    const history = active ? await active.native.readNativeHistory(input.request) : await this.options.native.history!(binding, input.request);
    if (history.harness !== binding.harness || history.vendorSessionId !== binding.vendorSessionId) {
      throw new V7Error("HISTORY_OWNER", "History response belongs to another native session");
    }
    const current = () => {
      if (this.options.store.binding(input.sessionId)?.archived !== binding.archived || this.#active.get(input.sessionId) !== active) {
        throw new V7Error("STALE_ATTACHMENT", "Response belongs to a retired attachment or binding");
      }
    };
    current(); const payload = await this.externalize(binding, history.payload); current();
    return { harness: history.harness, vendorSessionId: history.vendorSessionId, payload,
      ...(history.conversation === undefined ? {} : { conversation: history.conversation }),
      ...(history.complete === undefined ? {} : { complete: history.complete }),
      ...(history.nextCursor === undefined ? {} : { nextCursor: history.nextCursor }),
      ...(history.sortDirection === undefined ? {} : { sortDirection: history.sortDirection }),
      ...(history.unavailableItem === undefined ? {} : { unavailableItem: history.unavailableItem }) };
  }
  public async nativeState(input: NativeStateInput) {
    this.assertOpen(); const active = this.requireActive(input.sessionId);
    if (input.request.harness !== this.options.native.harness) throw new V7Error("HARNESS", "State targets another harness");
    if (!active.native.readNativeState) throw new V7Error("UNSUPPORTED", "Native owner does not offer this state view");
    const result = await active.native.readNativeState(input.request);
    this.assertCurrent(input.sessionId, active);
    const payload = await this.externalize(this.requireBinding(input.sessionId), result.payload);
    this.assertCurrent(input.sessionId, active);
    return { harness: result.harness, vendorSessionId: result.vendorSessionId, payload };
  }

  public watchSession(input: SessionWatchInput): AsyncIterable<SessionEvent> {
    this.assertOpen(); this.requireBinding(input.sessionId, true);
    const watchers = this.#watchers.get(input.sessionId) ?? new Set<EventQueue<SessionEvent>>();
    this.#watchers.set(input.sessionId, watchers);
    const abort = () => queue.close();
    const queue = new EventQueue<SessionEvent>(this.#subscriberSize, () => { watchers.delete(queue); input.signal?.removeEventListener("abort", abort); },
      this.#ringBytes, jsonWireByteUpperBound);
    watchers.add(queue);
    const ring = this.ring(input.sessionId), active = this.#active.get(input.sessionId);
    if (input.afterSequence !== undefined) {
      const floor = ring.events[0]?.sequence ?? ring.sequence;
      if (input.attachmentId !== (active?.id ?? null) || input.afterSequence < floor - 1 || input.afterSequence > ring.sequence) {
        queue.push({ protocolVersion: 7, sessionId: input.sessionId, attachmentId: active?.id ?? null,
          sequence: ring.sequence, kind: "gap", reason: "replayUnavailable", recoveryRequired: false });
      } else for (const event of ring.events) if (event.sequence > input.afterSequence) queue.push(event);
    } else queue.push({ protocolVersion: 7, sessionId: input.sessionId, attachmentId: active?.id ?? null,
      sequence: ring.sequence, kind: "session", session: this.view(this.requireBinding(input.sessionId, true)) });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) queue.close();
    return queue;
  }
  private async mutate(input: RequestEnvelope, operation: string, payload: unknown,
    action: (dispatch: () => Promise<void>) => Promise<JsonValue>): Promise<RequestReceipt> {
    this.assertOpen();
    requestEnvelopeSchema.parse({ requestId: input.requestId, sessionId: input.sessionId });
    const previous = this.#requests.get(input.requestId);
    if (previous) {
      if (previous.operation !== operation || previous.hash !== requestHash(payload)) throw new V7Error("REQUEST_CONFLICT", "Request ID already names a different immutable operation");
      return previous.promise;
    }
    const work = (async () => {
      const admitted = await this.options.store.admit(input.requestId, input.sessionId, operation, payload);
      if (!admitted.fresh) return admitted.receipt;
      if (this.#sessionWork.has(input.sessionId)) return this.options.store.transition(input.requestId, "failed", {
        error: { code: "SESSION_BUSY", message: "Another native mutation for this session is pending" },
      });
      this.#sessionWork.add(input.sessionId);
      let dispatched = false;
      const checkAttachment = () => {
        if (input.expectedAttachmentId !== undefined && input.expectedAttachmentId !== (this.#active.get(input.sessionId)?.id ?? null)) {
          throw new NativeOperationError("STALE_ATTACHMENT", "Request targets a retired native attachment", "failed");
        }
      };
      const dispatch = async () => { if (!dispatched) {
        checkAttachment(); await this.options.store.transition(input.requestId, "dispatched"); dispatched = true; checkAttachment();
      } };
      try {
        checkAttachment();
        const result = await action(dispatch);
        if (!dispatched) await dispatch(); // local/no-op operations still get one complete receipt.
        return await this.options.store.transition(input.requestId, "succeeded", { result });
      } catch (error) {
        const state = dispatched && !(error instanceof NativeOperationError && error.certainty === "failed") ? "outcomeUnknown" : "failed";
        diagnose(this.options.diagnostic, { role: "host", operation, requestId: input.requestId,
          sessionId: input.sessionId, code: state, error });
        return await this.options.store.transition(input.requestId, state, { error: errorDetails(error) });
      } finally { this.#sessionWork.delete(input.sessionId); }
    })().finally(() => { this.#requests.delete(input.requestId); });
    this.#requests.set(input.requestId, { operation, hash: requestHash(payload), promise: work });
    void work.then(receipt => this.publish(input.sessionId, { kind: "receipt", receipt }), () => {});
    return work;
  }
  private async install(binding: SessionBinding, native: AdapterSession): Promise<void> {
    if (native.harness !== this.options.native.harness || native.adapterScopeId !== this.options.native.adapterScopeId ||
      native.vendorSessionId !== binding.vendorSessionId) throw new NativeOperationError("BINDING_CONFLICT", "Native returned a different session owner", "outcomeUnknown");
    const active: Attachment = { id: randomUUID(), native, unsubscribe: () => {}, pending: 0,
      pendingBytes: 0,
      tail: Promise.resolve(), recoveryRequired: false, eventGap: false, interactions: new Map() };
    await this.options.store.putBinding(binding); this.#active.set(binding.sessionId, active);
    this.#rings.set(binding.sessionId, { sequence: 0, events: [], bytes: 0 });
    active.unsubscribe = native.subscribe(event => this.enqueue(binding.sessionId, active, event));
    this.publishSession(binding.sessionId);
  }
  private retire(sessionId: string, active: Attachment): void {
    this.assertCurrent(sessionId, active); active.unsubscribe(); active.interactions.clear(); this.#active.delete(sessionId);
    this.#rings.set(sessionId, { sequence: 0, events: [], bytes: 0 }); this.publishSession(sessionId);
  }
  private enqueue(sessionId: string, active: Attachment, event: AdapterEvent): void {
    if (this.#active.get(sessionId) !== active) return;
    let bytes: number;
    try { bytes = event.kind === "native" || event.kind === "interaction" ? jsonWireByteUpperBound(event.payload) : 512; }
    catch (error) { this.gap(sessionId, active, "nativeEventRejected", true);
      diagnose(this.options.diagnostic, { role: "host", sessionId, operation: "event", code: "nativeEventRejected", error }); return; }
    // Safety facts are observed at ingress. A blocked image transfer cannot
    // defer known interaction uncertainty behind presentation-only work.
    if (event.kind === "lifecycle") {
      if (event.fact.type === "gap") { this.gap(sessionId, active, "nativeContinuityGap", true); return; }
      if (event.fact.type === "interactionsHydrated") {
        active.recoveryRequired = active.eventGap || !event.fact.complete; this.publishSession(sessionId);
      }
    } else if (event.kind === "status" || event.kind === "settings") { this.publishSession(sessionId); return; }
    if (active.pending >= this.#pendingLimit || active.pendingBytes + bytes > this.#pendingBytes) {
      this.gap(sessionId, active, "eventOverflow", true); return;
    }
    active.pending += 1; active.pendingBytes += bytes;
    active.tail = active.tail.then(async () => {
      if (this.#active.get(sessionId) !== active) return;
      try { await this.onNativeEvent(sessionId, active, event); }
      catch (error) { this.gap(sessionId, active, "nativeEventRejected", true);
        diagnose(this.options.diagnostic, { role: "host", sessionId, operation: "event", code: "nativeEventRejected", error }); }
    }).finally(() => { active.pending -= 1; active.pendingBytes -= bytes; });
  }
  private async onNativeEvent(sessionId: string, active: Attachment, event: AdapterEvent): Promise<void> {
    const binding = this.requireBinding(sessionId);
    if (event.kind === "native") {
      const payload = await this.externalize(binding, event.payload); this.assertCurrent(sessionId, active);
      this.publish(sessionId, { kind: "native", nativeType: event.nativeType, payload, ephemeral: event.ephemeral,
        ...(event.conversation === undefined ? {} : { conversation: event.conversation }) });
    } else if (event.kind === "interaction") {
      const payload = await this.externalize(binding, event.payload); this.assertCurrent(sessionId, active);
      // Native numeric request IDs can restart at 1. A local callback capability
      // is unique to this attachment, so stale browser replies cannot hit a new ask.
      const interactionId = randomUUID();
      const wire: NativeInteraction = { interactionId, requestType: event.requestType, payload,
        ephemeral: event.ephemeral, expiresAt: event.expiresAt ?? null,
        ...(event.nativeRequestId === undefined ? {} : { nativeRequestId: event.nativeRequestId }) };
      active.interactions.set(interactionId, { wire, resolve: response => event.resolve(response) });
      this.publish(sessionId, { kind: "interaction", interaction: wire });
    } else if (event.kind === "interactionSettled") {
      for (const [interactionId, interaction] of active.interactions) {
        if (interaction.wire.nativeRequestId !== event.nativeRequestId) continue;
        active.interactions.delete(interactionId);
        this.publish(sessionId, { kind: "interactionSettled", interactionId, state: event.state });
      }
    } else if (event.kind === "lifecycle") this.publish(sessionId, { kind: "lifecycle", fact: jsonValueSchema.parse(event.fact) });
  }
  private gap(sessionId: string, active: Attachment, reason: string, uncertain: boolean): void {
    if (this.#active.get(sessionId) !== active) return;
    if (uncertain && active.eventGap) return; // One attachment warning; no overflow/log storm.
    if (uncertain) { active.eventGap = true; active.recoveryRequired = true; }
    this.publish(sessionId, { kind: "gap", reason, recoveryRequired: active.recoveryRequired });
    this.publishSession(sessionId);
  }
  private view(binding: SessionBinding): HostSession {
    const active = this.#active.get(binding.sessionId);
    let status: HostSession["status"] = "stopped", settings: HostSession["settings"];
    try { status = active?.native.status() ?? "stopped"; settings = active?.native.settings?.(); }
    catch (error) { status = "error"; diagnose(this.options.diagnostic, {
      role: "host", sessionId: binding.sessionId, operation: "observation", code: "sessionObservationFailed", error }); }
    return { ...binding, attachmentId: active?.id ?? null, status,
      recoveryRequired: active?.recoveryRequired ?? false,
      ...(settings === undefined ? {} : { settings }) };
  }
  private externalize(binding: SessionBinding, value: JsonValue): Promise<NativePayload> {
    return this.options.externalize ? this.options.externalize(binding, value).then(p => nativePayloadSchema.parse(p))
      : Promise.resolve(nativePayloadSchema.parse({ encoding: "native-json-images-v1", json: value, images: [] }));
  }
  private publishSession(sessionId: string): void {
    const binding = this.options.store.binding(sessionId); if (!binding) return;
    const session = this.view(binding); this.emit({ kind: "session", session }); this.publish(sessionId, { kind: "session", session });
  }
  private ring(sessionId: string): Ring {
    const ring = this.#rings.get(sessionId) ?? { sequence: 0, events: [], bytes: 0 }; this.#rings.set(sessionId, ring); return ring;
  }
  private publish(sessionId: string, payload: SessionEvent extends infer E ? E extends SessionEvent
    ? Omit<E, "protocolVersion" | "sessionId" | "attachmentId" | "sequence"> : never : never): void {
    const ring = this.ring(sessionId);
    const event = { ...payload, protocolVersion: 7, sessionId, attachmentId: this.#active.get(sessionId)?.id ?? null,
      sequence: ++ring.sequence } as SessionEvent;
    ring.events.push(event); ring.bytes += jsonWireByteUpperBound(event);
    while (ring.events.length > this.#ringSize || ring.bytes > this.#ringBytes) {
      const retired = ring.events.shift(); if (retired) ring.bytes -= jsonWireByteUpperBound(retired); else break;
    }
    for (const queue of this.#watchers.get(sessionId) ?? []) queue.push(event);
    this.emit({ kind: "event", event });
  }
  private emit(event: HostEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event); } catch (error) { diagnose(this.options.diagnostic, { role: "host", operation: "observer", code: "observerFailure", error }); }
    }
  }
  private requireBinding(sessionId: string, archived = false): SessionBinding {
    const binding = this.options.store.binding(sessionId);
    if (!binding) throw new V7Error("SESSION_MISSING", "Session is not bound to this Host");
    if (binding.archived && !archived) throw new V7Error("SESSION_ARCHIVED", "Session is archived");
    return binding;
  }
  private requireActive(sessionId: string): Attachment {
    this.requireBinding(sessionId); const active = this.#active.get(sessionId);
    if (!active) throw new V7Error("SESSION_STOPPED", "Resume this session explicitly before using native APIs"); return active;
  }
  private assertCurrent(sessionId: string, active: Attachment): void {
    if (this.#active.get(sessionId) !== active) throw new V7Error("STALE_ATTACHMENT", "Response belongs to a retired attachment");
  }
  private assertOpen(): void { if (this.#closed) throw new V7Error("CLOSED", "Host is closed"); }
  public async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true;
    await Promise.allSettled([...this.#requests.values()].map(v => v.promise));
    await this.options.native.close();
    for (const active of this.#active.values()) active.unsubscribe(); this.#active.clear();
    for (const watchers of this.#watchers.values()) for (const queue of watchers) queue.close();
    await this.options.store.close();
  }
}
