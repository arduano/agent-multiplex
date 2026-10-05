import { lifecycleActionAvailability, nativeGapDiagnosticSchema, type LifecycleFact, type LifecycleState, type NativeGapDiagnostic,
  type NativePayloadValidationFailure } from "@arduano/agent-multiplex-protocol";
import type { AdapterEvent, AdapterNativeStateReadReason, AdapterNativeStateValidationIssue, AdapterNativeStateValidationReason } from "./adapter.js";
import { nativeDiagnosticEventType, type NativeDiagnosticEventType } from "./native-event-diagnostics.js";

/** Embedding capability only; no wire, persisted-state or lifecycle version change. */
export const COPILOT_INCIDENT_TRACE_VERSION = 1 as const;

export interface CopilotIncidentStateSummary {
  readonly continuity: LifecycleState["continuity"];
  readonly rootPhase: LifecycleState["root"]["phase"];
  readonly rootOutcome: LifecycleState["root"]["outcome"];
  readonly aggregateActivity: LifecycleState["aggregateActivity"];
  readonly nativeAdmission: LifecycleState["nativeAdmission"]["state"];
  readonly interactionCompleteness: LifecycleState["interactions"]["completeness"];
  readonly childCompleteness: LifecycleState["children"]["completeness"];
  readonly pendingInteractions: number;
  readonly rootPendingInteractions: number;
  readonly unattributedInteractions: number;
  readonly runningChildren: number;
  readonly runningTasks: number;
  readonly taskObservation: LifecycleState["tasks"]["observation"]["state"];
  readonly taskRevision: number;
  readonly taskFailures: number;
  readonly taskStalled: boolean;
  readonly queueObservation: LifecycleState["queue"]["observation"]["state"];
  readonly queueRevision: number;
  readonly queueFailures: number;
  readonly queueStalled: boolean;
  readonly queuedItems: number;
  readonly unidentifiedSteering: number;
  readonly inFlightSteering: number | null;
  readonly trackedCommands: number;
  readonly unknownCommands: number;
  readonly sendAvailable: boolean;
  readonly sendReason: ReturnType<typeof lifecycleActionAvailability>["reason"];
}

export interface CopilotIncidentIngress {
  readonly ingressOrdinal: number;
  readonly elapsedMs: number;
  readonly eventKind: AdapterEvent["kind"];
  readonly nativeEventType?: NativeDiagnosticEventType;
  readonly nativeEphemeral?: boolean;
  readonly nativeEventOrdinal?: number;
  readonly factType?: LifecycleFact["type"];
}

export type CopilotIncidentDecisionReason = "optionalTelemetryOmitted" | "notWireEnvelope" | "mixedValidationFailure"
  | "notNativeEvent" | "unknownNativeEvent" | "requiredNativeEvent" | "notExplicitlyEphemeral"
  | "adapterPolicyRejected" | "adapterPolicyUnavailable" | "adapterPolicyFailed";

/** One fixed metadata record. It is diagnostic context, never lifecycle evidence. */
export interface CopilotIncidentGapContext {
  readonly diagnostic: NativeGapDiagnostic;
  readonly decisionReason: CopilotIncidentDecisionReason;
  readonly nativeEventType?: NativeDiagnosticEventType;
  readonly nativeEphemeral?: boolean;
  readonly payloadFailure?: NativePayloadValidationFailure;
  readonly wireUpperBoundBytes?: number;
  readonly wireLimitBytes?: number;
}

export type CopilotIncidentTraceDetail =
  | { readonly kind: "binding"; readonly outcome: "activated" | "retired";
      /** Persisted cause from a retired binding, copied before new evidence replaces it. */
      readonly previousBindingGap?: NativeGapDiagnostic }
  | { readonly kind: "ingress"; readonly event: CopilotIncidentIngress; readonly outcome: "received" | "retiredBinding" | "runtimeClosing" | "overflowSuppressed" }
  | { readonly kind: "transition"; readonly factType: LifecycleFact["type"]; readonly outcome: "applied" | "retiredBinding" | "fenceUnavailable";
      readonly lifecycleSequenceBefore?: number; readonly lifecycleSequenceAfter?: number;
      readonly before?: CopilotIncidentStateSummary; readonly after?: CopilotIncidentStateSummary;
      readonly diagnosticId?: string; readonly ingressOrdinal?: number; readonly nativeEventOrdinal?: number }
  | { readonly kind: "gap"; readonly diagnosticId: string; readonly code: NativeGapDiagnostic["code"];
      readonly decisionReason: CopilotIncidentDecisionReason; readonly lifecycleImpact: "preserved" | "invalidated";
      readonly diagnostic?: NativeGapDiagnostic;
      readonly nativeEventType?: NativeDiagnosticEventType; readonly nativeEphemeral?: boolean;
      readonly payloadFailure?: NativePayloadValidationFailure;
      readonly wireUpperBoundBytes?: number; readonly wireLimitBytes?: number;
      readonly ingressOrdinal?: number; readonly nativeEventOrdinal?: number; readonly state?: CopilotIncidentStateSummary }
  | { readonly kind: "observation"; readonly view: "tasks" | "pendingMessages"; readonly outcome: "started" | "accepted" | "failed" | "stalled" | "staleRevision" | "retiredBinding" | "staleGeneration" | "fenceUnavailable";
      readonly generation: number; readonly revision?: number; readonly currentRevision?: number; readonly failures: number;
      readonly deadlineAgeMs: number; readonly diagnosticId?: string;
      readonly failureReason?: AdapterNativeStateValidationReason | AdapterNativeStateReadReason | "nativeReadFailed" | "nativeBindingChanged";
      readonly validationIssues?: readonly AdapterNativeStateValidationIssue[] }
  | { readonly kind: "recovery"; readonly outcome: "scheduled" | "requested" | "manualRecoveryRequired" | "recovered" | "retiredBinding" | "fenceUnavailable" | "alreadyRecovered";
      readonly generation: number; readonly diagnosticId?: string };

export type CopilotIncidentTraceRecord = CopilotIncidentTraceDetail & {
  readonly version: typeof COPILOT_INCIDENT_TRACE_VERSION;
  readonly at: string;
  readonly elapsedMs: number;
  readonly traceSequence: number;
  readonly sessionTraceId: number;
  readonly bindingTraceId: number;
  readonly sdkAttachmentId?: number;
  readonly recent: readonly CopilotIncidentIngress[];
  readonly suppressedRecords: number;
  readonly pendingEvents?: number;
  readonly pendingEventBytes?: number;
  /** Survives recent16 rotation and later optional omissions on this binding. */
  readonly lastInvalidatingGap?: CopilotIncidentGapContext;
};
export type CopilotIncidentTraceHook = (record: CopilotIncidentTraceRecord) => void | Promise<void>;

export interface CopilotIncidentTraceBinding {
  readonly sessionTraceId: number;
  readonly bindingTraceId: number;
  readonly sdkAttachmentId?: number;
  ingressOrdinal: number;
  readonly recent: CopilotIncidentIngress[];
  lastInvalidatingGap?: CopilotIncidentGapContext;
}

/** Bounded process-local metadata. Logging never runs on the native callback stack. */
export class CopilotIncidentTracer {
  readonly #sessions = new Map<string, number>();
  readonly #queue: CopilotIncidentTraceRecord[] = [];
  readonly #startedAt = performance.now();
  #sessionOrdinal = 0;
  #bindingOrdinal = 0;
  #sequence = 0;
  #suppressed = 0;
  #scheduled = false;
  #inFlight = false;

  public constructor(private readonly hook: CopilotIncidentTraceHook) {}

  public binding(sessionId: string, sdkAttachmentId?: number): CopilotIncidentTraceBinding {
    let sessionTraceId = this.#sessions.get(sessionId);
    if (sessionTraceId === undefined) {
      sessionTraceId = ++this.#sessionOrdinal;
      this.#sessions.set(sessionId, sessionTraceId);
      // Eviction changes only an anonymous correlation alias, never domain state.
      if (this.#sessions.size > 4_096) this.#sessions.delete(this.#sessions.keys().next().value!);
    }
    return { sessionTraceId, bindingTraceId: ++this.#bindingOrdinal, ingressOrdinal: 0, recent: [],
      ...(typeof sdkAttachmentId === "number" && Number.isSafeInteger(sdkAttachmentId) && sdkAttachmentId > 0 ? { sdkAttachmentId } : {}) };
  }

  public ingress(binding: CopilotIncidentTraceBinding, event: AdapterEvent): CopilotIncidentIngress {
    const ordinal = event.diagnosticNativeEventOrdinal;
    const entry: CopilotIncidentIngress = {
      ingressOrdinal: ++binding.ingressOrdinal, elapsedMs: this.elapsed(), eventKind: event.kind,
      ...(event.kind === "native" ? { nativeEventType: nativeDiagnosticEventType("copilot", event.nativeType), nativeEphemeral: event.ephemeral === true } : {}),
      ...(event.kind === "lifecycle" ? { factType: event.fact.type } : {}),
      ...(typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0 ? { nativeEventOrdinal: ordinal } : {}),
    };
    binding.recent.push(Object.freeze(entry));
    if (binding.recent.length > 16) binding.recent.shift();
    return entry;
  }

  public record(binding: CopilotIncidentTraceBinding, detail: CopilotIncidentTraceDetail,
    pressure?: { readonly pendingEvents: number; readonly pendingEventBytes: number }, recent = binding.recent): void {
    let recordDetail = detail;
    const diagnostic = detail.kind === "gap" && detail.diagnostic ? nativeGapDiagnosticSchema.safeParse(detail.diagnostic) : undefined;
    if (detail.kind === "gap" && detail.diagnostic) {
      const { diagnostic: _original, ...withoutDiagnostic } = detail;
      recordDetail = diagnostic?.success
        ? { ...withoutDiagnostic, diagnostic: Object.freeze(diagnostic.data) } : withoutDiagnostic;
    }
    if (detail.kind === "gap" && detail.lifecycleImpact === "invalidated" && diagnostic?.success) {
      // Copy only the strict durable metadata and fixed private fields. A later
      // optional display omission cannot replace the cause of partial state.
      binding.lastInvalidatingGap = Object.freeze({ diagnostic: Object.freeze(diagnostic.data),
        decisionReason: detail.decisionReason,
        ...(detail.nativeEventType === undefined ? {} : { nativeEventType: nativeDiagnosticEventType("copilot", detail.nativeEventType) }),
        ...(detail.nativeEphemeral === undefined ? {} : { nativeEphemeral: detail.nativeEphemeral }),
        ...(detail.payloadFailure === undefined ? {} : { payloadFailure: detail.payloadFailure }),
        ...(detail.wireUpperBoundBytes === undefined ? {} : { wireUpperBoundBytes: detail.wireUpperBoundBytes }),
        ...(detail.wireLimitBytes === undefined ? {} : { wireLimitBytes: detail.wireLimitBytes }),
      });
    }
    const record: CopilotIncidentTraceRecord = Object.freeze({ ...recordDetail, ...pressure, version: COPILOT_INCIDENT_TRACE_VERSION,
      at: new Date().toISOString(), elapsedMs: this.elapsed(), traceSequence: ++this.#sequence,
      sessionTraceId: binding.sessionTraceId, bindingTraceId: binding.bindingTraceId,
      ...(binding.sdkAttachmentId === undefined ? {} : { sdkAttachmentId: binding.sdkAttachmentId }),
      ...(binding.lastInvalidatingGap === undefined ? {} : { lastInvalidatingGap: binding.lastInvalidatingGap }),
      recent: Object.freeze([...recent]), suppressedRecords: 0 });
    if (this.#queue.length >= 128) {
      // Ordinary state bursts must not erase a failure before its sink sees it.
      if (detail.kind === "ingress") { this.#suppressed += 1; return; }
      const routine = this.#queue.findIndex(item => item.kind === "ingress");
      const ordinary = routine < 0 ? this.#queue.findIndex(item => !criticalIncident(item)) : routine;
      if (ordinary < 0 && !criticalIncident(detail)) { this.#suppressed += 1; return; }
      // At the hard bound an all-critical queue retains the newest incident.
      this.#queue.splice(ordinary < 0 ? 0 : ordinary, 1);
      this.#suppressed += 1;
    }
    this.#queue.push(record);
    this.schedule();
  }

  private elapsed(): number { return Math.max(0, Math.round(performance.now() - this.#startedAt)); }
  private schedule(): void {
    if (this.#scheduled || this.#inFlight || this.#queue.length === 0) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      for (let count = 0; count < 32 && this.#queue.length > 0 && !this.#inFlight; count++) this.dispatch();
      this.schedule();
    }).unref?.();
  }
  private dispatch(): void {
    if (this.#inFlight) return;
    const next = this.#queue.shift();
    if (!next) return;
    const suppressedRecords = this.#suppressed;
    this.#suppressed = 0;
    try {
      const result = this.hook(Object.freeze({ ...next, suppressedRecords }));
      if (result && typeof result.then === "function") {
        // One pending sink call maximum. A hung sink caps memory at this queue.
        this.#inFlight = true;
        void Promise.resolve(result).then(() => this.settled(), () => { this.#suppressed += 1; this.settled(); });
      }
    } catch { this.#inFlight = false; this.#suppressed += 1; }
  }
  private settled(): void { this.#inFlight = false; this.schedule(); }
}

function criticalIncident(record: CopilotIncidentTraceDetail): boolean {
  return record.kind === "gap" || record.kind === "recovery" ||
    record.kind === "observation" && (record.outcome === "failed" || record.outcome === "stalled");
}

const routineNativeEvents: ReadonlySet<string> = new Set([
  "assistant.message_delta", "assistant.reasoning_delta", "assistant.streaming_delta", "assistant.tool_call_delta",
  "assistant.server_tool_progress", "tool.execution_progress", "tool.execution_partial_result", "hook.progress",
]);
/** All entries still enter recent16; delta traffic does not fill protected logs. */
export function copilotIncidentRoutineEvent(event: AdapterEvent): boolean {
  return event.kind === "native" && routineNativeEvents.has(event.nativeType);
}

export function copilotIncidentStateSummary(state: LifecycleState): CopilotIncidentStateSummary {
  const send = lifecycleActionAvailability(state, "send");
  return Object.freeze({ continuity: state.continuity, rootPhase: state.root.phase, rootOutcome: state.root.outcome,
    aggregateActivity: state.aggregateActivity, nativeAdmission: state.nativeAdmission.state,
    interactionCompleteness: state.interactions.completeness, childCompleteness: state.children.completeness,
    pendingInteractions: state.interactions.items.length, rootPendingInteractions: state.interactions.items.filter(item => item.owner === "root").length,
    unattributedInteractions: state.interactions.items.filter(item => item.owner === "unattributed").length,
    runningChildren: state.children.items.filter(item => item.state === "running").length,
    runningTasks: state.tasks.items.filter(item => item.status === "running").length,
    taskObservation: state.tasks.observation.state, taskRevision: state.tasks.revision,
    taskFailures: state.tasks.observation.failures, taskStalled: state.tasks.observation.stalled,
    queueObservation: state.queue.observation.state, queueRevision: state.queue.revision,
    queueFailures: state.queue.observation.failures, queueStalled: state.queue.observation.stalled,
    queuedItems: state.queue.items.length, unidentifiedSteering: state.queue.unidentifiedSteering, inFlightSteering: state.queue.inFlightSteering,
    trackedCommands: state.commands.length,
    unknownCommands: state.commands.filter(item => item.admission === "outcomeUnknown").length,
    sendAvailable: send.available, sendReason: send.reason });
}
