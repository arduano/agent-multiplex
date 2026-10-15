import { randomUUID } from "node:crypto";
import {
  jsonValueSchema, jsonWireByteUpperBound, nativePayloadSchema, harnessCommandSchema, capabilitySchema, type NativePayload,
} from "@arduano/agent-multiplex-protocol";
import type { NativePort, AdapterEvent, AdapterSession } from "./native-port.js";
import { EventQueue, diagnose, type Diagnostic } from "./events.js";
import { NativeOperationError, V7Error, errorDetails } from "./errors.js";
import { V7Store, requestHash } from "./store.js";
import { AdapterOperationPendingError, AdapterInputNotSubmittedError } from "@arduano/agent-multiplex-runtime-node-core";
import { observeWithin, positiveBound } from "./observation.js";
import {
  V7_PROTOCOL_VERSION, createSessionInputSchema, executeInputSchema, resolveInputSchema, requestEnvelopeSchema,
  type CreateSessionInput, type ExecuteInput, type HistoryInput, type HostApi, type HostDescriptor,
  type HostEvent, type HostSession, type JsonValue, type NativeInteraction, type NativeStateInput,
  type RequestEnvelope, type RequestReceipt, type ResolveInput, type SessionBinding,
  type SessionEvent, type SessionWatchInput,
} from "./protocol.js";

export interface HostServiceOptions {
  store: V7Store; hostId: string; name: string; native: NativePort;
  capabilities?: HostDescriptor["capabilities"];
  bootId?: string; eventBufferSize?: number; subscriberBufferSize?: number; pendingEventLimit?: number;
  eventBufferBytes?: number; pendingEventBytes?: number;
  pendingInteractionLimit?: number; pendingInteractionBytes?: number;
  nativeAckTimeoutMs?: number;
  closeTimeoutMs?: number;
  externalize?: (binding: SessionBinding, payload: JsonValue) => Promise<NativePayload>;
  prepareCommand?: (input: ExecuteInput) => Promise<ExecuteInput["command"]>;
  diagnostic?: (event: Diagnostic) => void;
}
interface Attachment {
  id: string; native: AdapterSession; unsubscribe: () => void; pending: number;
  pendingBytes: number;
  criticalPending: number; criticalBytes: number; criticalTail: Promise<void>;
  tail: Promise<void>; recoveryRequired: boolean;
  eventGap: boolean;
  pendingMutationGuard: boolean; interactionsComplete: boolean;
  presentationGap: boolean;
  interactions: Map<string, { wire: NativeInteraction; resolve: (response: JsonValue) => Promise<void> }>;
}
interface Ring { sequence: number; events: SessionEvent[]; bytes: number }
interface MutationOwner { requestId: string; attachmentId: string | null; expired: boolean; dispatched: boolean; nativeSteps: number }
interface MutationDispatch {
  (): Promise<void>;
  retire(active: Attachment): void;
}

/** One coordinator per attached native session. No global lifecycle reducer,
 * persistent native observations, prompt queue or startup attachment job. */
export class HostService implements HostApi {
  readonly #active = new Map<string, Attachment>();
  readonly #sessionWork = new Map<string, MutationOwner>();
  readonly #urgentWork = new Set<string>();
  readonly #ownedWork = new Set<Promise<RequestReceipt>>();
  readonly #settlements = new Map<string, Promise<RequestReceipt>>();
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
  readonly #criticalLimit: number; readonly #criticalBytes: number;
  readonly #ackTimeout: number;
  readonly #closeTimeout: number;
  #closing: Promise<void> | undefined;
  #closed = false;
  public constructor(private readonly options: HostServiceOptions) {
    if (options.store.role !== "host" || options.store.instanceId !== options.hostId) throw new V7Error("STORE_ROLE", "Host needs its own V7 store");
    this.#descriptor = { protocolVersion: V7_PROTOCOL_VERSION, hostId: options.hostId,
      name: options.name, harness: options.native.harness, bootId: options.bootId ?? randomUUID(),
      ...((options.capabilities?.length || options.native.inputCapabilities?.length) ? { capabilities:
        [...(options.capabilities ?? []), ...(options.native.inputCapabilities ?? [])].map(value => capabilitySchema.parse(value)) } : {}) };
    this.#ackTimeout = positiveBound(options.nativeAckTimeoutMs ?? 15_000, "Native acknowledgement timeout");
    this.#closeTimeout = positiveBound(options.closeTimeoutMs ?? 5_000, "Native cleanup observation timeout");
    this.#ringSize = options.eventBufferSize ?? 256;
    this.#subscriberSize = options.subscriberBufferSize ?? 512;
    this.#pendingLimit = options.pendingEventLimit ?? 256;
    this.#ringBytes = options.eventBufferBytes ?? 8 * 1024 * 1024;
    this.#pendingBytes = options.pendingEventBytes ?? 32 * 1024 * 1024;
    this.#criticalLimit = options.pendingInteractionLimit ?? 32;
    this.#criticalBytes = options.pendingInteractionBytes ?? 8 * 1024 * 1024;
    for (const size of [this.#ringSize, this.#subscriberSize, this.#pendingLimit, this.#ringBytes, this.#pendingBytes, this.#criticalLimit, this.#criticalBytes]) {
      if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("Event limits must be positive integers");
    }
  }
  public descriptor(): HostDescriptor { return structuredClone(this.#descriptor); }
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
      if (active) { await dispatch(); await active.native.stop(); dispatch.retire(active); }
      await dispatch(); const native = await this.options.native.resume(binding); await this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    });
  }
  public stop(input: RequestEnvelope): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "stop", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId);
      const active = this.#active.get(input.sessionId);
      if (active) { await dispatch(); await active.native.stop(); dispatch.retire(active); }
      return jsonValueSchema.parse(this.view(binding));
    }, this.retirementLane(input));
  }
  public recover(input: RequestEnvelope): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "recover", input, async dispatch => {
      const binding = this.requireBinding(input.sessionId), active = this.#active.get(input.sessionId);
      if (active) { await dispatch(); await active.native.stop(); dispatch.retire(active); }
      await dispatch(); const native = await this.options.native.resume(binding); await this.install(binding, native);
      return jsonValueSchema.parse(this.view(binding));
    }, this.retirementLane(input));
  }
  public archive(input: RequestEnvelope): Promise<RequestReceipt> {
    input = structuredClone(input);
    return this.mutate(input, "archive", input, async dispatch => {
      const binding = this.options.store.binding(input.sessionId);
      if (!binding) {
        // A definitely rejected creation may have a Root-owned title but no
        // native binding. An unknown native creation is not proof of absence.
        const attempts = await this.options.store.receipts(input.sessionId, "create");
        if (attempts.some(attempt => attempt.state !== "failed")) throw new NativeOperationError("CREATION_UNCERTAIN", "Inspect the original creation before archiving its reservation", "failed");
        return null;
      }
      if (binding.archived) return jsonValueSchema.parse(this.view(binding));
      const active = this.#active.get(input.sessionId);
      if (active) { await dispatch(); await active.native.stop(); dispatch.retire(active); }
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
      const native = command.harness === "codex" ? active.native.execute(command, { requestId: input.requestId }) : active.native.execute(command);
      return (await this.nativeSettlement(native)) ?? null;
    }, this.interruptLane(input));
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
      await this.nativeSettlement(interaction.resolve(parsed.response));
      // The callback's native acknowledgement still settles its own receipt,
      // but a retirement must not project it into a replacement attachment.
      if (this.#active.get(input.sessionId) === active && active.interactions.get(parsed.interactionId) === interaction) {
        active.interactions.delete(parsed.interactionId);
        this.publish(input.sessionId, { kind: "interactionSettled", interactionId: parsed.interactionId, state: "resolved" });
      }
      return null;
    }, input.expectedAttachmentId !== undefined && input.expectedAttachmentId !== null ? "urgent" : "normal");
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
    const binding = this.requireBinding(input.sessionId);
    if (result.harness !== binding.harness || result.vendorSessionId !== binding.vendorSessionId) throw new V7Error("STATE_OWNER", "State response belongs to another native session");
    const payload = await this.externalize(binding, result.payload);
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
  private interruptLane(input: ExecuteInput): "normal" | "urgent" {
    return input.command.harness === "codex" && input.command.command.type === "interrupt" &&
      typeof input.command.command.turnId === "string" && input.command.command.turnId.trim().length > 0 &&
      input.command.command.turnId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(input.command.command.turnId) &&
      input.expectedAttachmentId !== undefined && input.expectedAttachmentId !== null ? "urgent" : "normal";
  }
  private retirementLane(input: RequestEnvelope): "normal" | "urgent" {
    const owner = this.#sessionWork.get(input.sessionId);
    return owner?.expired && input.expectedAttachmentId !== undefined && input.expectedAttachmentId !== null ? "urgent" : "normal";
  }
  private async nativeSettlement<T>(value: Promise<T>): Promise<T> {
    try { return await value; }
    catch (error) {
      if (error instanceof AdapterOperationPendingError) return await this.nativeSettlement(error.settlement) as T;
      if (error instanceof AdapterInputNotSubmittedError)
        throw new NativeOperationError(`INPUT_NOT_SUBMITTED_${error.reason}`, "Native input was not submitted", "failed", { cause: error });
      throw error;
    }
  }
  private settle(requestId: string, state: "succeeded" | "failed" | "outcomeUnknown",
    outcome: { result?: JsonValue; error?: { code: string; message: string } }): Promise<RequestReceipt> {
    const previous = this.#settlements.get(requestId);
    const work = (async () => {
      if (previous) await previous.catch(() => {});
      const current = await this.options.store.receipt(requestId);
      if (!current) throw new V7Error("REQUEST_MISSING", "Original request is not admitted");
      if (["succeeded", "failed"].includes(current.state)) return current;
      if (state === "outcomeUnknown" && current.state === state) return current;
      const receipt = await this.options.store.transition(requestId, state, outcome);
      this.publish(current.sessionId, { kind: "receipt", receipt });
      diagnose(this.options.diagnostic, { role: "host", operation: current.operation, requestId, sessionId: current.sessionId,
        code: `receipt${state}`, phase: "terminal", hostBootId: this.#descriptor.bootId });
      return receipt;
    })().finally(() => { if (this.#settlements.get(requestId) === work) this.#settlements.delete(requestId); });
    this.#settlements.set(requestId, work); return work;
  }
  private async mutate(input: RequestEnvelope, operation: string, payload: unknown,
    action: (dispatch: MutationDispatch) => Promise<JsonValue>, lane: "normal" | "urgent" = "normal"): Promise<RequestReceipt> {
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
      if (this.#urgentWork.has(input.sessionId) || (lane === "normal" && this.#sessionWork.has(input.sessionId))) return this.settle(input.requestId, "failed", {
        error: { code: "SESSION_BUSY", message: "Another native mutation for this session is pending" },
      });
      const owner: MutationOwner = { requestId: input.requestId, attachmentId: this.#active.get(input.sessionId)?.id ?? null,
        expired: false, dispatched: false, nativeSteps: 0 };
      if (lane === "urgent") this.#urgentWork.add(input.sessionId); else this.#sessionWork.set(input.sessionId, owner);
      const started = performance.now();
      let expectedAttachmentId = input.expectedAttachmentId;
      const checkAttachment = () => {
        const current = this.#active.get(input.sessionId)?.id ?? null;
        if ((expectedAttachmentId !== undefined && expectedAttachmentId !== current) || owner.attachmentId !== current) {
          throw new NativeOperationError("STALE_ATTACHMENT", "Request targets a retired native attachment", owner.dispatched ? "outcomeUnknown" : "failed");
        }
      };
      const checkDispatch = () => {
        if (this.#closed) throw new NativeOperationError("CLOSED", "Host closed before this native call was dispatched", owner.dispatched ? "outcomeUnknown" : "failed");
        if (owner.expired) throw new NativeOperationError(owner.dispatched ? "ACK_TIMEOUT_AFTER_EFFECT" : "ACK_TIMEOUT_BEFORE_DISPATCH",
          "Observation expired before another native call could be dispatched", owner.dispatched ? "outcomeUnknown" : "failed");
        checkAttachment();
      };
      const dispatch: MutationDispatch = Object.assign(async () => {
        checkDispatch();
        if (!owner.dispatched) {
          await this.options.store.transition(input.requestId, "dispatched");
          // Durability completion is not native dispatch. A deadline may have
          // elapsed during that await; fence before allowing an actual effect.
          checkDispatch(); owner.dispatched = true;
          diagnose(this.options.diagnostic, { role: "host", operation, requestId: input.requestId, sessionId: input.sessionId,
            code: "nativeDispatch", phase: "dispatch", hostBootId: this.#descriptor.bootId });
        }
        checkDispatch();
        owner.nativeSteps += 1;
      }, { retire: (active: Attachment) => {
        // Only this operation's successful Stop may advance its continuation
        // fence to the intentionally detached state. Public identity is intact.
        checkAttachment(); this.retire(input.sessionId, active);
        owner.attachmentId = null;
        if (expectedAttachmentId !== undefined) expectedAttachmentId = null;
      } });
      const completion = (async () => {
        try {
          checkAttachment(); const result = await action(dispatch);
          if (!owner.dispatched) await dispatch();
          diagnose(this.options.diagnostic, { role: "host", operation, requestId: input.requestId, sessionId: input.sessionId,
            code: "nativeAcknowledged", phase: "nativeAck", durationMs: Math.round(performance.now() - started), hostBootId: this.#descriptor.bootId });
          return await this.settle(input.requestId, "succeeded", { result });
        } catch (error) {
          const definitelyNotSubmitted = error instanceof NativeOperationError && error.certainty === "failed" && owner.nativeSteps <= 1;
          const state = owner.dispatched && !definitelyNotSubmitted ? "outcomeUnknown" : "failed";
          diagnose(this.options.diagnostic, { role: "host", operation, requestId: input.requestId, sessionId: input.sessionId, code: state, error });
          return await this.settle(input.requestId, state, { error: errorDetails(error) });
        } finally {
          if (lane === "urgent") this.#urgentWork.delete(input.sessionId);
          else if (this.#sessionWork.get(input.sessionId) === owner) {
            this.#sessionWork.delete(input.sessionId);
            const current = this.#active.get(input.sessionId);
            if (current?.pendingMutationGuard) {
              current.pendingMutationGuard = false;
              current.recoveryRequired = current.eventGap || !current.interactionsComplete;
              this.publishSession(input.sessionId);
            }
          }
          diagnose(this.options.diagnostic, { role: "host", operation, requestId: input.requestId, sessionId: input.sessionId,
            code: "nativeOwnershipSettled", phase: "terminal", durationMs: Math.round(performance.now() - started), hostBootId: this.#descriptor.bootId });
        }
      })();
      this.#ownedWork.add(completion);
      void completion.finally(() => this.#ownedWork.delete(completion)).catch(() => {});
      try {
        return await observeWithin(completion, this.#ackTimeout, () => {
          owner.expired = true;
          return new V7Error("ACK_TIMEOUT", "Native acknowledgement remains pending; original work was not replayed");
        });
      } catch (error) {
        diagnose(this.options.diagnostic, { role: "host", operation, requestId: input.requestId, sessionId: input.sessionId,
          code: "nativeAckDeadline", phase: "ackDeadline", durationMs: Math.round(performance.now() - started), hostBootId: this.#descriptor.bootId });
        return this.settle(input.requestId, owner.dispatched ? "outcomeUnknown" : "failed", { error: errorDetails(error) });
      }
    })().finally(() => { this.#requests.delete(input.requestId); });
    this.#requests.set(input.requestId, { operation, hash: requestHash(payload), promise: work });
    return work;
  }
  private async install(binding: SessionBinding, native: AdapterSession): Promise<void> {
    if (native.harness !== this.options.native.harness || native.adapterScopeId !== this.options.native.adapterScopeId ||
      native.vendorSessionId !== binding.vendorSessionId) throw new NativeOperationError("BINDING_CONFLICT", "Native returned a different session owner", "outcomeUnknown");
    const active: Attachment = { id: randomUUID(), native, unsubscribe: () => {}, pending: 0,
      pendingBytes: 0,
      criticalPending: 0, criticalBytes: 0, criticalTail: Promise.resolve(),
      tail: Promise.resolve(), recoveryRequired: native.harness === "codex" || Boolean(this.#sessionWork.get(binding.sessionId)?.expired), eventGap: false,
      pendingMutationGuard: Boolean(this.#sessionWork.get(binding.sessionId)?.expired), interactionsComplete: native.harness !== "codex", presentationGap: false, interactions: new Map() };
    try {
      this.assertOpen(); await this.options.store.putBinding(binding); this.assertOpen();
      this.#active.set(binding.sessionId, active);
      this.#rings.set(binding.sessionId, { sequence: 0, events: [], bytes: 0 });
      active.unsubscribe = native.subscribe(event => this.enqueue(binding.sessionId, active, event));
      this.publishSession(binding.sessionId);
    } catch (error) {
      // The returned handle belongs to this installation until it is attached.
      // Failed persistence/subscription must not leave a hidden native owner.
      if (this.#active.get(binding.sessionId) === active) {
        this.#active.delete(binding.sessionId); active.interactions.clear();
        this.#rings.set(binding.sessionId, { sequence: 0, events: [], bytes: 0 });
      }
      try { active.unsubscribe(); } catch (cleanupError) {
        diagnose(this.options.diagnostic, { role: "host", sessionId: binding.sessionId,
          operation: "install", code: "unsubscribeFailed", error: cleanupError });
      }
      try { await native.stop(); } catch (cleanupError) {
        diagnose(this.options.diagnostic, { role: "host", sessionId: binding.sessionId,
          operation: "install", code: "nativeCleanupFailed", error: cleanupError });
      }
      // Stop only releases the local controller; the native creation itself may
      // have succeeded. Preserve its original uncertain receipt and history.
      try { this.publishSession(binding.sessionId); } catch (cleanupError) {
        diagnose(this.options.diagnostic, { role: "host", sessionId: binding.sessionId,
          operation: "install", code: "cleanupObservationFailed", error: cleanupError });
      }
      throw error;
    }
  }
  private retire(sessionId: string, active: Attachment): void {
    this.assertCurrent(sessionId, active); active.unsubscribe(); active.interactions.clear(); this.#active.delete(sessionId);
    this.#rings.set(sessionId, { sequence: 0, events: [], bytes: 0 }); this.publishSession(sessionId);
  }
  private enqueue(sessionId: string, active: Attachment, event: AdapterEvent): void {
    if (this.#active.get(sessionId) !== active) return;
    const presentationOnly = event.kind === "native" && event.continuity === "presentation";
    let bytes: number;
    try { bytes = event.kind === "native" || event.kind === "interaction" ? jsonWireByteUpperBound(event.payload) : 512; }
    catch (error) { this.gap(sessionId, active, "nativeEventRejected", !presentationOnly);
      diagnose(this.options.diagnostic, { role: "host", sessionId, operation: "event", code: "nativeEventRejected", error }); return; }
    // Safety facts are observed at ingress. A blocked image transfer cannot
    // defer known interaction uncertainty behind presentation-only work.
    if (event.kind === "lifecycle") {
      if (event.fact.type === "gap") { this.gap(sessionId, active, "nativeContinuityGap", true); return; }
      if (event.fact.type === "interactionsHydrated") {
        active.interactionsComplete = event.fact.complete;
        active.recoveryRequired = active.eventGap || active.pendingMutationGuard || !event.fact.complete; this.publishSession(sessionId);
      }
    } else if (event.kind === "status" || event.kind === "settings") { this.publishSession(sessionId); return; }
    const critical = event.kind !== "native";
    if (critical ? active.criticalPending >= this.#criticalLimit || active.criticalBytes + bytes > this.#criticalBytes
      : active.pending >= this.#pendingLimit || active.pendingBytes + bytes > this.#pendingBytes) {
      this.gap(sessionId, active, "eventOverflow", !presentationOnly); return;
    }
    if (critical) { active.criticalPending += 1; active.criticalBytes += bytes; }
    else { active.pending += 1; active.pendingBytes += bytes; }
    const work = (critical ? active.criticalTail : active.tail).then(async () => {
      if (this.#active.get(sessionId) !== active) return;
      try { await this.onNativeEvent(sessionId, active, event); }
      catch (error) { this.gap(sessionId, active, "nativeEventRejected", !presentationOnly);
        diagnose(this.options.diagnostic, { role: "host", sessionId, operation: "event", code: "nativeEventRejected", error }); }
    }).finally(() => {
      if (critical) { active.criticalPending -= 1; active.criticalBytes -= bytes; }
      else { active.pending -= 1; active.pendingBytes -= bytes; }
    });
    if (critical) active.criticalTail = work; else active.tail = work;
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
    if (!uncertain && active.presentationGap) return;
    if (uncertain) { active.eventGap = true; active.recoveryRequired = true; }
    else active.presentationGap = true;
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
  public close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    // The cleanup owner survives a caller deadline. Do not close the durable
    // writer while a retired caller's native effect may still settle into it.
    const owner = (async () => {
      const failures: unknown[] = [];
      for (const active of this.#active.values()) {
        try { active.unsubscribe(); } catch (error) { failures.push(error); }
      }
      for (const watchers of this.#watchers.values()) for (const queue of watchers) queue.close();
      try { await this.options.native.close(); }
      catch (error) {
        failures.push(error);
        if (this.#ownedWork.size || this.#requests.size)
          throw new NativeOperationError("CLEANUP_UNPROVED", "Native cleanup failed while original receipt ownership remains; its writer is retained", "outcomeUnknown", { cause: error });
      }
      await Promise.allSettled([...this.#requests.values()].map(v => v.promise));
      await Promise.allSettled([...this.#ownedWork]);
      this.#active.clear();
      try { await this.options.store.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "V7 Host cleanup failed");
    })();
    void owner.catch(() => {});
    this.#closing = observeWithin(owner, this.#closeTimeout,
      () => new NativeOperationError("CLEANUP_PENDING", "Exact native cleanup remains pending; its writer is retained", "outcomeUnknown"));
    return this.#closing;
  }
}
