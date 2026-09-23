import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import { commandIdSchema, runtimeEpochSchema, runtimeNodeBootIdSchema, runtimeNodeIdSchema, sessionIdSchema } from "./ids.js";

/** Independent contract version: transport/source epochs are not native generations. */
export const LIFECYCLE_VERSION = 2 as const;
const opaqueId = z.string().min(1).max(4_096);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const diagnosticId = z.uuid();
const observationHealthSchema = z.object({
  state: z.enum(["pending", "retrying", "observed"]),
  failures: counter,
  diagnosticId: diagnosticId.optional(),
  stalled: z.boolean(),
}).strict();
export const lifecycleFenceSchema = z.object({
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  runtimeNodeBootId: runtimeNodeBootIdSchema,
  bindingRevision: z.number().int().positive(),
  runtimeEpoch: runtimeEpochSchema,
}).strict();
export type LifecycleFence = z.infer<typeof lifecycleFenceSchema>;

const taskSchema = z.object({ id: opaqueId, kind: z.enum(["agent", "shell", "client"]), status: z.enum(["running", "idle", "completed", "failed", "cancelled", "orphaned"]) }).strict();
const queueItemSchema = z.object({ id: opaqueId, messageId: opaqueId.optional(), kind: z.enum(["queued", "steering"]) }).strict();
const childIdentitySchema = z.string().min(6).max(4_096).regex(/^(agent|tool):.+$/, "child identity must carry its namespace");
const childSchema = z.object({ id: childIdentitySchema, state: z.enum(["running", "settled", "completed", "failed", "unknown"]) }).strict();
const lifecycleOwnerSchema = z.union([
  z.literal("root"),
  z.string().min(6).max(4_096).regex(/^(agent|tool):.+$/, "child owner must carry its identity namespace"),
]);
const interactionSchema = z.object({ id: opaqueId, owner: lifecycleOwnerSchema, kind: z.enum(["permission", "userInput", "elicitation", "exitPlan", "other"]) }).strict();
const commandSchema = z.object({
  commandId: commandIdSchema, payloadHash: z.string().min(1).max(256),
  kind: z.enum(["send", "steer", "compact", "other"]),
  admission: z.enum(["prepared", "dispatched", "accepted", "failed", "outcomeUnknown"]),
  messageId: opaqueId.optional(),
  displayed: z.boolean(), consumed: z.boolean(), settled: z.boolean(),
}).strict();
export type LifecycleCommand = z.infer<typeof commandSchema>;

/** Payload-free runtime observation. None of these fields grant catalog authority. */
export const lifecycleStateSchema = z.object({
  version: z.literal(LIFECYCLE_VERSION), fence: lifecycleFenceSchema,
  nextSequence: counter, continuity: z.enum(["continuous", "gap"]),
  aggregateActivity: z.enum(["unknown", "active", "inactive"]),
  nativeAdmission: z.object({ state: z.enum(["open", "degraded"]), diagnosticId: diagnosticId.optional() }).strict(),
  root: z.object({ phase: z.enum(["unknown", "paused", "idle", "working"]), cycle: opaqueId.nullable(), outcome: z.enum(["none", "finished", "interrupted", "failed"]) }).strict(),
  tasks: z.object({ revision: counter, observation: observationHealthSchema, items: z.array(taskSchema).max(1_000) }).strict(),
  children: z.object({ completeness: z.enum(["complete", "partial"]), items: z.array(childSchema).max(256) }).strict(),
  queue: z.object({
    revision: counter,
    observation: observationHealthSchema,
    items: z.array(queueItemSchema).max(1_000),
    unidentifiedSteering: counter,
    inFlightSteering: counter.nullable(),
  }).strict(),
  interactions: z.object({ completeness: z.enum(["complete", "partial"]), items: z.array(interactionSchema).max(256) }).strict(),
  commands: z.array(commandSchema).max(256),
  displayedMessageIds: z.array(opaqueId).max(512),
  consumedMessageIds: z.array(opaqueId).max(512),
  compaction: z.enum(["unknown", "running", "observedComplete"]),
}).strict();
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;

export const lifecycleFactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rootStarted"), cycleId: opaqueId }).strict(),
  z.object({ type: z.literal("rootModelIdle") }).strict(),
  z.object({ type: z.literal("rootIdle"), aborted: z.boolean() }).strict(),
  z.object({ type: z.literal("rootFailed") }).strict(),
  z.object({ type: z.literal("sessionActivityObserved"), active: z.boolean() }).strict(),
  z.object({ type: z.literal("nativeObservationDegraded"), diagnosticId }).strict(),
  z.object({ type: z.literal("nativeObservationRecovered") }).strict(),
  z.object({ type: z.literal("child"), id: childIdentitySchema, state: z.enum(["running", "completed", "failed"]) }).strict(),
  z.object({ type: z.literal("childrenHydrated"), items: z.array(childSchema).max(256), complete: z.boolean() }).strict(),
  z.object({ type: z.literal("tasksInvalidated") }).strict(),
  z.object({ type: z.literal("tasksObserved"), revision: counter, items: z.array(taskSchema).max(1_000) }).strict(),
  z.object({ type: z.literal("queueInvalidated") }).strict(),
  z.object({
    type: z.literal("queueObserved"),
    revision: counter,
    items: z.array(queueItemSchema).max(1_000),
    unidentifiedSteering: counter,
    inFlightSteering: counter.nullable(),
  }).strict(),
  z.object({
    type: z.literal("observationFailed"),
    view: z.enum(["tasks", "queue"]),
    revision: counter,
    failures: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    diagnosticId,
    stalled: z.boolean(),
  }).strict(),
  z.object({ type: z.literal("interactionOpened"), interaction: interactionSchema }).strict(),
  z.object({ type: z.literal("interactionClosed"), id: opaqueId }).strict(),
  z.object({ type: z.literal("interactionsHydrated"), items: z.array(interactionSchema).max(256), complete: z.boolean() }).strict(),
  z.object({ type: z.literal("commandPrepared"), commandId: commandIdSchema, payloadHash: z.string().min(1).max(256), kind: commandSchema.shape.kind }).strict(),
  z.object({ type: z.literal("commandReceipt"), commandId: commandIdSchema, payloadHash: z.string().min(1).max(256), admission: commandSchema.shape.admission.exclude(["prepared"]), messageId: opaqueId.optional() }).strict(),
  z.object({ type: z.literal("messageDisplayed"), messageId: opaqueId, owner: lifecycleOwnerSchema }).strict(),
  z.object({ type: z.literal("messageConsumed"), messageId: opaqueId, owner: lifecycleOwnerSchema }).strict(),
  z.object({ type: z.literal("commandSettled"), commandId: commandIdSchema, payloadHash: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("compaction"), phase: z.enum(["running", "observedComplete"]) }).strict(),
  z.object({ type: z.literal("gap") }).strict(),
]);
export type LifecycleFact = z.infer<typeof lifecycleFactSchema>;
export const lifecycleEvidenceSchema = z.object({ version: z.literal(LIFECYCLE_VERSION), fence: lifecycleFenceSchema, sequence: counter, fact: lifecycleFactSchema }).strict();
export type LifecycleEvidence = z.infer<typeof lifecycleEvidenceSchema>;

export function initialLifecycle(fence: LifecycleFence): LifecycleState {
  return { version: LIFECYCLE_VERSION, fence, nextSequence: 0, continuity: "continuous",
    aggregateActivity: "unknown", nativeAdmission: { state: "open" },
    root: { phase: "unknown", cycle: null, outcome: "none" },
    tasks: { revision: 0, observation: pendingObservation(), items: [] }, children: { completeness: "partial", items: [] },
    queue: { revision: 0, observation: pendingObservation(), items: [], unidentifiedSteering: 0, inFlightSteering: null },
    interactions: { completeness: "partial", items: [] }, commands: [],
    displayedMessageIds: [], consumedMessageIds: [], compaction: "unknown" };
}
export function sameLifecycleFence(a: LifecycleFence, b: LifecycleFence): boolean {
  return a.sessionId === b.sessionId && a.runtimeNodeId === b.runtimeNodeId && a.runtimeNodeBootId === b.runtimeNodeBootId && a.bindingRevision === b.bindingRevision && a.runtimeEpoch === b.runtimeEpoch;
}
function invalidate(s: LifecycleState): LifecycleState {
  return { ...s, continuity: "gap", aggregateActivity: "unknown", root: { ...s.root, phase: "unknown", cycle: null, outcome: "none" },
    tasks: { ...s.tasks, revision: s.tasks.revision + 1, observation: pendingObservation() },
    queue: { ...s.queue, revision: s.queue.revision + 1, observation: pendingObservation() },
    children: { completeness: "partial", items: s.children.items.map((c) => ({ ...c, state: "unknown" })) },
    // A close may be among the lost facts. Retaining an item would turn stale
    // positive evidence into a false blocking request after recovery.
    interactions: { completeness: "partial", items: [] }, compaction: "unknown" };
}

function startRootCycle(s: LifecycleState, cycleId: string): LifecycleState {
  return { ...s, continuity: "continuous", aggregateActivity: "active", root: { phase: "working", cycle: cycleId, outcome: "none" } };
}

/** Pure single-writer reducer. A gap requires a replacement snapshot, never an idle guess. */
export function reduceLifecycle(state: LifecycleState, evidence: LifecycleEvidence): LifecycleState {
  if (evidence.version !== LIFECYCLE_VERSION || !sameLifecycleFence(state.fence, evidence.fence) || evidence.sequence < state.nextSequence) return state;
  if (evidence.sequence !== state.nextSequence) {
    const gapped = { ...invalidate(state), nextSequence: evidence.sequence + 1 };
    // A uniquely identified start is a safe foreground recovery boundary. It
    // certifies only the new root cycle; invalidated dimensions remain unknown.
    return evidence.fact.type === "rootStarted" ? startRootCycle(gapped, evidence.fact.cycleId) : gapped;
  }
  let s: LifecycleState = { ...state, nextSequence: evidence.sequence + 1 };
  const f = evidence.fact;
  switch (f.type) {
    case "gap": return invalidate(s);
    case "rootStarted": return startRootCycle(s, f.cycleId);
    // Model-loop idle is weaker than whole-session idle. Keep it distinct so a
    // complete task/queue snapshot cannot accidentally project Ready while an
    // attached shell or background agent may still be winding down.
    case "rootModelIdle": return { ...s, root: { ...s.root, phase: "paused" } };
    case "sessionActivityObserved":
      // The SDK bit includes turns OR tasks. It cannot identify a root cycle.
      // Inactivity can pause a known root but cannot settle its outcome.
      return { ...s, aggregateActivity: f.active ? "active" : "inactive",
        root: !f.active && s.root.phase === "working" ? { ...s.root, phase: "paused" } : s.root };
    case "nativeObservationDegraded":
      return { ...s, nativeAdmission: { state: "degraded", diagnosticId: f.diagnosticId } };
    case "nativeObservationRecovered":
      return s.tasks.observation.state === "observed" && s.queue.observation.state === "observed"
        ? { ...s, nativeAdmission: { state: "open" } } : s;
    case "rootFailed": return { ...s, root: { ...s.root, phase: "idle", outcome: "failed" } };
    case "rootIdle": return { ...s, continuity: "continuous", aggregateActivity: "inactive",
      root: { ...s.root, phase: "idle", outcome: s.root.outcome !== "none" ? s.root.outcome
        : f.aborted ? "interrupted" : s.root.cycle === null ? "none" : "finished" },
      // The SDK defines root session.idle as having no background agents or
      // attached shell commands in flight. It proves quiescence, not a missing
      // child's success outcome.
      children: { completeness: "complete", items: s.children.items.map((c) => c.state === "running" || c.state === "unknown" ? { ...c, state: "settled" } : c) } };
    case "child": {
      const children = s.children.items.filter((c) => c.id !== f.id);
      if (children.length >= 256) return invalidate(s);
      return { ...s, children: { ...s.children, items: [...children, { id: f.id, state: f.state }] } };
    }
    case "childrenHydrated": {
      if (f.complete) return { ...s, children: { completeness: "complete", items: f.items } };
      const hydrated = new Map(f.items.map((child) => [child.id, child]));
      for (const child of s.children.items) hydrated.set(child.id, child);
      return { ...s, children: { completeness: "partial", items: [...hydrated.values()] } };
    }
    case "tasksInvalidated": return { ...s, tasks: { ...s.tasks, revision: s.tasks.revision + 1, observation: pendingObservation() } };
    case "tasksObserved": return f.revision !== s.tasks.revision ? s : { ...s, tasks: { ...s.tasks, observation: observedObservation(), items: f.items } };
    case "queueInvalidated": return { ...s, queue: { ...s.queue, revision: s.queue.revision + 1, observation: pendingObservation() } };
    case "queueObserved": return f.revision !== s.queue.revision ? s : { ...s, queue: {
      ...s.queue,
      observation: observedObservation(),
      items: f.items,
      unidentifiedSteering: f.unidentifiedSteering,
      inFlightSteering: f.inFlightSteering,
    } };
    case "observationFailed": {
      const dimension = f.view === "tasks" ? s.tasks : s.queue;
      // A failure belongs to one exact invalidation revision. It cannot regress
      // a successful observation or a newer generation.
      if (dimension.revision !== f.revision || dimension.observation.state === "observed") return s;
      const observation = {
        state: "retrying" as const,
        failures: Math.max(dimension.observation.failures, f.failures),
        diagnosticId: f.diagnosticId,
        stalled: dimension.observation.stalled || f.stalled,
      };
      return f.view === "tasks"
        ? { ...s, tasks: { ...s.tasks, observation } }
        : { ...s, queue: { ...s.queue, observation } };
    }
    case "interactionOpened": {
      const items = s.interactions.items.filter((i) => i.id !== f.interaction.id);
      if (items.length >= 256) return invalidate(s);
      return { ...s, interactions: { ...s.interactions, items: [...items, f.interaction] } };
    }
    case "interactionClosed": return { ...s, interactions: { ...s.interactions, items: s.interactions.items.filter((i) => i.id !== f.id) } };
    case "interactionsHydrated": {
      if (f.complete) return { ...s, interactions: { completeness: "complete", items: f.items } };
      // A reconnect snapshot is explicitly incomplete. Preserve callbacks that
      // opened while the snapshot was in flight; an empty partial observation
      // can never prove their absence.
      const hydrated = new Map(f.items.map((interaction) => [interaction.id, interaction]));
      for (const interaction of s.interactions.items) hydrated.set(interaction.id, interaction);
      return { ...s, interactions: { completeness: "partial", items: [...hydrated.values()] } };
    }
    case "commandPrepared": {
      const old = s.commands.find((c) => c.commandId === f.commandId);
      if (old) {
        if (old.payloadHash !== f.payloadHash || old.kind !== f.kind) throw new Error("lifecycle command identity conflict");
        return s;
      }
      // Durable command_journal remains the unbounded original-ID receipt
      // source. This is only a bounded recent-correlation view: eviction loses
      // optional later refinement but never changes the durable receipt or
      // manufactures delivery certainty.
      let commands = s.commands;
      if (commands.length === 256) {
        const evict = commands.findIndex((command) =>
          command.settled ||
          command.displayed ||
          command.consumed ||
          command.admission === "failed" ||
          (command.admission === "accepted" && command.kind !== "send" && command.kind !== "steer"));
        commands = commands.filter((_, index) => index !== (evict === -1 ? 0 : evict));
      }
      return { ...s, commands: [...commands, { commandId: f.commandId, payloadHash: f.payloadHash, kind: f.kind, admission: "prepared", displayed: false, consumed: false, settled: false }] };
    }
    case "commandReceipt": {
      const old = s.commands.find((c) => c.commandId === f.commandId);
      if (!old) return s;
      if (old.payloadHash !== f.payloadHash || (old.messageId !== undefined && f.messageId !== undefined && old.messageId !== f.messageId)) throw new Error("lifecycle command identity conflict");
      if (old.admission === "accepted" || old.admission === "failed") {
        if ((f.admission === "accepted" || f.admission === "failed") && old.admission !== f.admission) throw new Error("lifecycle terminal receipt conflict");
        return s;
      }
      if (old.admission === "outcomeUnknown" && f.admission === "dispatched") return s;
      const messageId = f.messageId ?? old.messageId;
      return { ...s, commands: s.commands.map((c) => c !== old ? c : { ...c, admission: f.admission,
        ...(messageId === undefined ? {} : { messageId }),
        displayed: c.displayed || (messageId !== undefined && s.displayedMessageIds.includes(messageId)),
        consumed: c.consumed || (messageId !== undefined && s.consumedMessageIds.includes(messageId)),
      }) };
    }
    case "messageDisplayed": {
      if (f.owner !== "root") return s;
      const messageId = f.messageId;
      return { ...s, displayedMessageIds: [...s.displayedMessageIds.filter((id) => id !== messageId).slice(-511), messageId],
        commands: s.commands.map((c) => c.messageId === messageId ? { ...c, displayed: true } : c) };
    }
    case "messageConsumed": return f.owner !== "root" ? s : {
      ...s,
      consumedMessageIds: [...s.consumedMessageIds.filter((id) => id !== f.messageId).slice(-511), f.messageId],
      commands: s.commands.map((c) => c.messageId === f.messageId ? { ...c, consumed: true } : c),
    };
    case "commandSettled": {
      const old = s.commands.find((command) => command.commandId === f.commandId);
      if (!old) return s;
      if (old.payloadHash !== f.payloadHash) throw new Error("lifecycle command identity conflict");
      return { ...s, commands: s.commands.map((command) => command === old ? { ...command, settled: true } : command) };
    }
    case "compaction": return { ...s, compaction: f.phase };
  }
}

/** Install only a snapshot from the explicitly selected generation and binding. */
export function reconcileLifecycle(current: LifecycleState, snapshot: LifecycleState, sourceGeneration: number, expectedGeneration: number): LifecycleState {
  if (sourceGeneration !== expectedGeneration || !sameLifecycleFence(current.fence, snapshot.fence) || snapshot.nextSequence < current.nextSequence) return current;
  return lifecycleStateSchema.parse(snapshot);
}
export type LifecycleLabel = "Offline" | "Unknown" | "Waiting for input" | "Failed" | "Interrupted" | "Working" | "Waiting for child/task" | "Queued" | "Finished" | "Ready";
export function projectLifecycle(s: LifecycleState, online = true): LifecycleLabel {
  if (!online) return "Offline";
  if (s.continuity === "gap") return "Unknown";
  if (s.interactions.items.some((i) => i.owner === "root")) return "Waiting for input";
  if (s.root.outcome === "failed") return "Failed";
  if (s.root.outcome === "interrupted") return "Interrupted";
  if (s.root.phase === "working") return "Working";
  if (s.tasks.observation.state === "observed" && s.tasks.items.some((t) => t.status === "running") || s.children.items.some((c) => c.state === "running")) return "Waiting for child/task";
  if (s.queue.observation.state === "observed" && (s.queue.items.length > 0 || s.queue.unidentifiedSteering > 0 || (s.queue.inFlightSteering ?? 0) > 0)) return "Queued";
  if (s.aggregateActivity === "active") return "Unknown";
  if (s.root.phase === "unknown" || s.root.phase === "paused" || s.tasks.observation.state !== "observed" || s.queue.observation.state !== "observed" || s.queue.inFlightSteering === null || s.interactions.completeness === "partial" || s.children.completeness === "partial" || s.children.items.some((c) => c.state === "unknown")) return "Unknown";
  return s.root.outcome === "finished" ? "Finished" : "Ready";
}
export function projectDelivery(command: LifecycleCommand, state: LifecycleState): "Prepared" | "Dispatched" | "Accepted" | "Queued" | "Displayed" | "Consumed" | "Settled" | "Failed" | "Unknown" {
  if (command.settled) return "Settled";
  if (command.consumed) return "Consumed";
  if (command.displayed) return "Displayed";
  if (command.messageId !== undefined && state.queue.observation.state === "observed" && state.queue.items.some((i) => i.messageId === command.messageId)) return "Queued";
  return ({ prepared: "Prepared", dispatched: "Dispatched", accepted: "Accepted", failed: "Failed", outcomeUnknown: "Unknown" } as const)[command.admission];
}

export const lifecycleStatusSchema = z.enum([
  "ready", "working", "waitingForInput", "waitingForBackground",
  "interrupted", "failed", "finished", "unknown", "offline",
]);
export type LifecycleStatus = z.infer<typeof lifecycleStatusSchema>;

const lifecycleIssueSchema = z.object({
  scope: z.enum(["lifecycle", "tasks", "queue"]),
  code: z.enum(["continuityGap", "observationPending", "observationRetrying", "observationStalled", "nativeReadStalled", "incompleteNativeState", "hostUnavailable"]),
  diagnosticId: diagnosticId.optional(),
}).strict();
export type LifecycleIssue = z.infer<typeof lifecycleIssueSchema>;

export const lifecycleHealthSchema = z.object({
  state: z.enum(["healthy", "recovering", "degraded", "offline"]),
  issues: z.array(lifecycleIssueSchema).max(8),
}).strict();
export type LifecycleHealth = z.infer<typeof lifecycleHealthSchema>;

export const lifecycleActionReasonSchema = z.enum([
  "available", "hostOffline", "nativeObservationDegraded", "waitingForInput", "notWorking", "noPendingInteraction",
]);
export const lifecycleActionAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: lifecycleActionReasonSchema,
}).strict().refine((value) => value.available === (value.reason === "available"), {
  message: "available lifecycle actions must use the available reason",
});
export type LifecycleActionAvailability = z.infer<typeof lifecycleActionAvailabilitySchema>;

export const sessionLifecycleViewSchema = z.object({
  version: z.literal(LIFECYCLE_VERSION),
  /** Equality/refresh token only. Consumers must never parse this identifier. */
  observationId: z.uuid(),
  status: lifecycleStatusSchema,
  health: lifecycleHealthSchema,
  actions: z.object({
    send: lifecycleActionAvailabilitySchema,
    steer: lifecycleActionAvailabilitySchema,
    interrupt: lifecycleActionAvailabilitySchema,
    changeSettings: lifecycleActionAvailabilitySchema,
    resolveInteraction: lifecycleActionAvailabilitySchema,
    stop: lifecycleActionAvailabilitySchema,
  }).strict(),
}).strict();
export type SessionLifecycleView = z.infer<typeof sessionLifecycleViewSchema>;

/** Runtime-to-control fence. This shape never appears in a public session record. */
export const runtimeLifecycleProjectionSchema = z.object({
  version: z.literal(LIFECYCLE_VERSION),
  fence: lifecycleFenceSchema,
  nextSequence: counter,
  view: sessionLifecycleViewSchema,
}).strict();
export type RuntimeLifecycleProjection = z.infer<typeof runtimeLifecycleProjectionSchema>;

const observationNamespace = "bfb0cd00-6374-4c04-b7bf-f62f8fcedf79";

/** Binding-level admission must agree with the published action view. */
export function lifecycleNativeObservationDegraded(state: LifecycleState): boolean {
  return state.nativeAdmission.state === "degraded" ||
    state.tasks.observation.stalled || state.queue.observation.stalled;
}

export function lifecycleProjection(state: LifecycleState): RuntimeLifecycleProjection {
  const label = projectLifecycle(state);
  const stalled = lifecycleNativeObservationDegraded(state);
  const issues: LifecycleIssue[] = [];
  if (state.nativeAdmission.state === "degraded") issues.push({ scope: "lifecycle", code: "nativeReadStalled",
    ...(state.nativeAdmission.diagnosticId === undefined ? {} : { diagnosticId: state.nativeAdmission.diagnosticId }) });
  if (state.continuity === "gap") issues.push({ scope: "lifecycle", code: "continuityGap" });
  for (const [scope, observation] of [["tasks", state.tasks.observation], ["queue", state.queue.observation]] as const) {
    if (observation.state === "pending") issues.push({ scope, code: "observationPending" });
    if (observation.state === "retrying") issues.push({
      scope,
      code: observation.stalled ? "observationStalled" : "observationRetrying",
      ...(observation.diagnosticId === undefined ? {} : { diagnosticId: observation.diagnosticId }),
    });
  }
  if (state.interactions.completeness === "partial" || state.children.completeness === "partial") {
    issues.push({ scope: "lifecycle", code: "incompleteNativeState" });
  }
  const health: LifecycleHealth = {
    state: stalled ? "degraded" : issues.length > 0 ? "recovering" : "healthy",
    issues,
  };
  const rootWaiting = state.interactions.items.some((item) => item.owner === "root");
  const available = (): LifecycleActionAvailability => ({ available: true, reason: "available" });
  const unavailable = (reason: Exclude<z.infer<typeof lifecycleActionReasonSchema>, "available">): LifecycleActionAvailability => ({ available: false, reason });
  const mutable = stalled ? unavailable("nativeObservationDegraded") : rootWaiting ? unavailable("waitingForInput") : available();
  const view: SessionLifecycleView = {
    version: LIFECYCLE_VERSION,
    observationId: uuidv5(`${state.fence.sessionId}:${state.fence.runtimeNodeId}:${state.fence.runtimeNodeBootId}:${state.fence.bindingRevision}:${state.fence.runtimeEpoch}:${state.nextSequence}`, observationNamespace),
    status: label === "Waiting for input" ? "waitingForInput"
      : label === "Waiting for child/task" ? "waitingForBackground"
        : label === "Failed" ? "failed"
          : label === "Interrupted" ? "interrupted"
            : label === "Finished" ? "finished"
              : label === "Ready" ? "ready"
                : label === "Working" || label === "Queued" ? "working" : "unknown",
    health,
    actions: {
      send: mutable,
      steer: stalled ? unavailable("nativeObservationDegraded")
        : rootWaiting ? unavailable("waitingForInput")
          : state.root.phase === "working" ? available() : unavailable("notWorking"),
      interrupt: stalled ? unavailable("nativeObservationDegraded")
        : state.root.phase === "working" ? available() : unavailable("notWorking"),
      changeSettings: mutable,
      resolveInteraction: stalled ? unavailable("nativeObservationDegraded")
        : rootWaiting ? available() : unavailable("noPendingInteraction"),
      stop: available(),
    },
  };
  return { version: LIFECYCLE_VERSION, fence: state.fence, nextSequence: state.nextSequence, view };
}

/** Host-owned reachability overlay. It preserves no internal binding identity. */
export function offlineLifecycleView(current: SessionLifecycleView): SessionLifecycleView {
  const unavailable: LifecycleActionAvailability = { available: false, reason: "hostOffline" };
  return sessionLifecycleViewSchema.parse({
    version: LIFECYCLE_VERSION,
    observationId: uuidv5(`${current.observationId}:offline`, observationNamespace),
    status: "offline",
    health: { state: "offline", issues: [{ scope: "lifecycle", code: "hostUnavailable" }] },
    actions: {
      send: unavailable,
      steer: unavailable,
      interrupt: unavailable,
      changeSettings: unavailable,
      resolveInteraction: unavailable,
      stop: unavailable,
    },
  });
}

function pendingObservation(): z.infer<typeof observationHealthSchema> {
  return { state: "pending", failures: 0, stalled: false };
}

function observedObservation(): z.infer<typeof observationHealthSchema> {
  return { state: "observed", failures: 0, stalled: false };
}
