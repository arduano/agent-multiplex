import { randomUUID } from "node:crypto";
import {
  jsonValueSchema, nativePayloadSchema, type NativePayload,
} from "@arduano/agent-multiplex-protocol";
import type { NativePort, AdapterEvent, AdapterSession } from "./native-port.js";
import { EventQueue, diagnose, type Diagnostic } from "./events.js";
import { NativeOperationError, V7Error, errorDetails } from "./errors.js";
import { V7Store } from "./store.js";
import {
  V7_PROTOCOL_VERSION, createSessionInputSchema, executeInputSchema, resolveInputSchema,
  type CreateSessionInput, type ExecuteInput, type HistoryInput, type HostApi, type HostDescriptor,
  type HostEvent, type HostSession, type JsonValue, type NativeInteraction, type NativeStateInput,
  type RequestEnvelope, type RequestReceipt, type ResolveInput, type SessionBinding,
  type SessionEvent, type SessionWatchInput,
} from "./protocol.js";

export interface HostServiceOptions {
  store: V7Store; hostId: string; name: string; native: NativePort;
  bootId?: string; eventBufferSize?: number; subscriberBufferSize?: number; pendingEventLimit?: number;
  externalize?: (binding: SessionBinding, payload: JsonValue) => Promise<NativePayload>;
  diagnostic?: (event: Diagnostic) => void;
}
interface Attachment {
  id: string; native: AdapterSession; unsubscribe: () => void; pending: number;
  tail: Promise<void>; recoveryRequired: boolean;
  eventGap: boolean;
  interactions: Map<string, { wire: NativeInteraction; resolve: (response: JsonValue) => Promise<void> }>;
}
interface Ring { sequence: number; events: SessionEvent[] }

/** One coordinator per attached native session. No global lifecycle reducer,
 * persistent native observations, prompt queue or startup attachment job. */
export class HostService implements HostApi {
  readonly #active = new Map<string, Attachment>();
  readonly #sessionWork = new Set<string>();
  readonly #requests = new Map<string, Promise<RequestReceipt>>();
  readonly #listeners = new Set<(event: HostEvent) => void>();
  readonly #watchers = new Map<string, Set<EventQueue<SessionEvent>>>();
  readonly #rings = new Map<string, Ring>();
  readonly #descriptor: HostDescriptor;
  readonly #ringSize: number;
  readonly #subscriberSize: number;
  readonly #pendingLimit: number;
  #closed = false;
  public constructor(private readonly options: HostServiceOptions) {
    if (options.store.role !== "host" || options.store.instanceId !== options.hostId) throw new V7Error("STORE_ROLE", "Host needs its own V7 store");
    this.#descriptor = { protocolVersion: V7_PROTOCOL_VERSION, hostId: options.hostId,
      name: options.name, harness: options.native.harness, bootId: options.bootId ?? randomUUID() };
    this.#ringSize = options.eventBufferSize ?? 256;
    this.#subscriberSize = options.subscriberBufferSize ?? 512;
    this.#pendingLimit = options.pendingEventLimit ?? 256;
    for (const size of [this.#ringSize, this.#subscriberSize, this.#pendingLimit]) {
      if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("Event limits must be positive integers");
    }
  }
  public descriptor(): HostDescriptor { return { ...this.#descriptor }; }
  public list(): HostSession[] { return this.options.store.bindings().map(binding => this.view(binding)); }
  public models() { this.assertOpen(); return this.options.native.models(); }
  public receipt(requestId: string): RequestReceipt | null { return this.options.store.receipt(requestId); }
  public interactions(sessionId: string): NativeInteraction[] {
    const active = this.#active.get(sessionId); this.requireBinding(sessionId);
    return active ? [...active.interactions.values()].map(i => structuredClone(i.wire)) : [];
  }
  public subscribe(listener: (event: HostEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  public create(input: CreateSessionInput): Promise<RequestReceipt> {
    return this.mutate(input, "create", input, async dispatch => {
      const parsed = createSessionInputSchema.parse(input);
      if (parsed.options.harness !== this.options.native.harness) throw new V7Error("HARNESS", "Host serves another harness");
      if (this.options.store.binding(input.sessionId)) throw new V7Error("SESSION_EXISTS", "Session already has a native binding");
      dispatch();
      const native = await this.options.native.create(parsed.options);
      const binding: SessionBinding = { sessionId: input.sessionId, hostId: this.options.hostId,
        harness: native.harness, adapterScopeId: native.adapterScopeId, vendorSessionId: native.vendorSessionId,
        cwd: native.cwd, createdAt: this.options.store.now(), archived: false };
      this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public resume(input: RequestEnvelope): Promise<RequestReceipt> {
    return this.mutate(input, "resume", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId);
      const active = this.#active.get(input.sessionId);
      if (active && active.native.status() !== "stopped") return jsonValueSchema.parse(this.view(binding));
      if (active) { dispatch(); await active.native.stop(); this.retire(input.sessionId, active); }
      dispatch(); const native = await this.options.native.resume(binding); this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public stop(input: RequestEnvelope): Promise<RequestReceipt> {
    return this.mutate(input, "stop", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId);
      const active = this.#active.get(input.sessionId);
      if (active) { dispatch(); await active.native.stop(); this.retire(input.sessionId, active); }
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public recover(input: RequestEnvelope): Promise<RequestReceipt> {
    return this.mutate(input, "recover", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId), active = this.#active.get(input.sessionId);
      dispatch();
      if (active) { await active.native.stop(); this.retire(input.sessionId, active); }
      const native = await this.options.native.resume(binding); this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public archive(input: RequestEnvelope): Promise<RequestReceipt> {
    return this.mutate(input, "archive", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId, true);
      if (binding.archived) return jsonValueSchema.parse(this.view(binding));
      const active = this.#active.get(input.sessionId);
      if (active) { dispatch(); await active.native.stop(); this.retire(input.sessionId, active); }
      if (this.options.native.release) { dispatch(); await this.options.native.release(binding); }
      this.options.store.putBinding({ ...binding, archived: true }); this.publishSession(input.sessionId);
      return jsonValueSchema.parse(this.view({ ...binding, archived: true }));
    });
  }
  public execute(input: ExecuteInput): Promise<RequestReceipt> {
    return this.mutate(input, "execute", input, async dispatch => {
      const parsed = executeInputSchema.parse(input), active = this.requireActive(input.sessionId);
      if (parsed.command.harness !== this.options.native.harness) throw new V7Error("HARNESS", "Command targets another harness");
      if (active.recoveryRequired && ["send", "steer"].includes(parsed.command.command.type)) {
        throw new V7Error("INTERACTION_UNCERTAIN", "Recover this session before starting new native work");
      }
      dispatch(); return (await active.native.execute(parsed.command)) ?? null;
    });
  }
  public resolve(input: ResolveInput): Promise<RequestReceipt> {
    return this.mutate(input, "resolve", input, async dispatch => {
      const parsed = resolveInputSchema.parse(input), active = this.requireActive(input.sessionId);
      const interaction = active.interactions.get(parsed.interactionId);
      if (!interaction) throw new V7Error("INTERACTION_STALE", "Native interaction is no longer attached");
      dispatch(); await interaction.resolve(parsed.response);
      active.interactions.delete(parsed.interactionId);
      this.publish(input.sessionId, { kind: "interactionSettled", interactionId: parsed.interactionId, state: "resolved" });
      return null;
    });
  }
  public async history(input: HistoryInput) {
    this.assertOpen(); const active = this.requireActive(input.sessionId);
    if (input.request.harness !== this.options.native.harness) throw new V7Error("HARNESS", "History targets another harness");
    const history = await active.native.readNativeHistory(input.request);
    this.assertCurrent(input.sessionId, active);
    const payload = await this.externalize(this.requireBinding(input.sessionId), history.payload);
    this.assertCurrent(input.sessionId, active);
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
    const queue = new EventQueue<SessionEvent>(this.#subscriberSize, () => { watchers.delete(queue); input.signal?.removeEventListener("abort", abort); });
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
  private mutate(input: RequestEnvelope, operation: string, payload: unknown,
    action: (dispatch: () => void) => Promise<JsonValue>): Promise<RequestReceipt> {
    this.assertOpen();
    const admitted = this.options.store.admit(input.requestId, input.sessionId, operation, payload);
    const pending = this.#requests.get(input.requestId);
    if (!admitted.fresh) return pending ?? Promise.resolve(admitted.receipt);
    if (this.#sessionWork.has(input.sessionId)) {
      return Promise.resolve(this.options.store.transition(input.requestId, "failed", {
        error: { code: "SESSION_BUSY", message: "Another native mutation for this session is pending" },
      }));
    }
    this.#sessionWork.add(input.sessionId);
    const work = (async () => {
      let dispatched = false;
      const dispatch = () => { if (!dispatched) { dispatched = true; this.options.store.transition(input.requestId, "dispatched"); } };
      try {
        const result = await action(dispatch);
        if (!dispatched) dispatch(); // local/no-op operations still get one complete receipt.
        return this.options.store.transition(input.requestId, "succeeded", { result });
      } catch (error) {
        const state = dispatched && !(error instanceof NativeOperationError && error.certainty === "failed") ? "outcomeUnknown" : "failed";
        diagnose(this.options.diagnostic, { role: "host", operation, requestId: input.requestId,
          sessionId: input.sessionId, code: state, error });
        return this.options.store.transition(input.requestId, state, { error: errorDetails(error) });
      } finally { this.#sessionWork.delete(input.sessionId); this.#requests.delete(input.requestId); }
    })();
    this.#requests.set(input.requestId, work);
    void work.then(receipt => this.publish(input.sessionId, { kind: "receipt", receipt }), () => {});
    return work;
  }
  private install(binding: SessionBinding, native: AdapterSession): void {
    if (native.harness !== this.options.native.harness || native.adapterScopeId !== this.options.native.adapterScopeId ||
      native.vendorSessionId !== binding.vendorSessionId) throw new NativeOperationError("BINDING_CONFLICT", "Native returned a different session owner", "outcomeUnknown");
    const active: Attachment = { id: randomUUID(), native, unsubscribe: () => {}, pending: 0,
      tail: Promise.resolve(), recoveryRequired: false, eventGap: false, interactions: new Map() };
    this.options.store.putBinding(binding); this.#active.set(binding.sessionId, active);
    this.#rings.set(binding.sessionId, { sequence: 0, events: [] });
    active.unsubscribe = native.subscribe(event => this.enqueue(binding.sessionId, active, event));
    this.publishSession(binding.sessionId);
  }
  private retire(sessionId: string, active: Attachment): void {
    this.assertCurrent(sessionId, active); active.unsubscribe(); active.interactions.clear(); this.#active.delete(sessionId);
    this.#rings.set(sessionId, { sequence: 0, events: [] }); this.publishSession(sessionId);
  }
  private enqueue(sessionId: string, active: Attachment, event: AdapterEvent): void {
    if (this.#active.get(sessionId) !== active) return;
    if (active.pending >= this.#pendingLimit) { this.gap(sessionId, active, "eventOverflow", true); return; }
    active.pending += 1;
    active.tail = active.tail.then(async () => {
      if (this.#active.get(sessionId) !== active) return;
      try { await this.onNativeEvent(sessionId, active, event); }
      catch (error) { this.gap(sessionId, active, "nativeEventRejected", true);
        diagnose(this.options.diagnostic, { role: "host", sessionId, operation: "event", code: "nativeEventRejected", error }); }
    }).finally(() => { active.pending -= 1; });
  }
  private async onNativeEvent(sessionId: string, active: Attachment, event: AdapterEvent): Promise<void> {
    const binding = this.requireBinding(sessionId);
    if (event.kind === "native") {
      const payload = await this.externalize(binding, event.payload); this.assertCurrent(sessionId, active);
      this.publish(sessionId, { kind: "native", nativeType: event.nativeType, payload, ephemeral: event.ephemeral,
        ...(event.conversation === undefined ? {} : { conversation: event.conversation }) });
    } else if (event.kind === "interaction") {
      const payload = await this.externalize(binding, event.payload); this.assertCurrent(sessionId, active);
      const interactionId = event.nativeRequestId ?? randomUUID();
      const wire: NativeInteraction = { interactionId, requestType: event.requestType, payload,
        ephemeral: event.ephemeral, expiresAt: event.expiresAt ?? null,
        ...(event.nativeRequestId === undefined ? {} : { nativeRequestId: event.nativeRequestId }) };
      active.interactions.set(interactionId, { wire, resolve: response => event.resolve(response) });
      this.publish(sessionId, { kind: "interaction", interaction: wire });
    } else if (event.kind === "interactionSettled") {
      active.interactions.delete(event.nativeRequestId);
      this.publish(sessionId, { kind: "interactionSettled", interactionId: event.nativeRequestId, state: event.state });
    } else if (event.kind === "status" || event.kind === "settings") this.publishSession(sessionId);
    else if (event.kind === "lifecycle") {
      if (event.fact.type === "gap") this.gap(sessionId, active, "nativeContinuityGap", true);
      else {
        if (event.fact.type === "interactionsHydrated") {
          // Honor native evidence, without importing the V6 lifecycle reducer.
          // A native cold-resume certificate may resolve its partial baseline;
          // it cannot erase an actual lost native event on this attachment.
          active.recoveryRequired = active.eventGap || !event.fact.complete;
          this.publishSession(sessionId);
        }
        this.publish(sessionId, { kind: "lifecycle", fact: jsonValueSchema.parse(event.fact) });
      }
    }
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
    const ring = this.#rings.get(sessionId) ?? { sequence: 0, events: [] }; this.#rings.set(sessionId, ring); return ring;
  }
  private publish(sessionId: string, payload: SessionEvent extends infer E ? E extends SessionEvent
    ? Omit<E, "protocolVersion" | "sessionId" | "attachmentId" | "sequence"> : never : never): void {
    const ring = this.ring(sessionId);
    const event = { ...payload, protocolVersion: 7, sessionId, attachmentId: this.#active.get(sessionId)?.id ?? null,
      sequence: ++ring.sequence } as SessionEvent;
    ring.events.push(event); if (ring.events.length > this.#ringSize) ring.events.shift();
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
    await Promise.allSettled([...this.#requests.values()]);
    await this.options.native.close();
    for (const active of this.#active.values()) active.unsubscribe(); this.#active.clear();
    for (const watchers of this.#watchers.values()) for (const queue of watchers) queue.close();
    this.options.store.close();
  }
}
