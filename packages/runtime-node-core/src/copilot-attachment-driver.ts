import { newOperationId } from "@arduano/agent-multiplex-protocol";
import {
  ADAPTER_NATIVE_STATE_READ_REASONS,
  ADAPTER_NATIVE_STATE_VALIDATION_REASONS,
  AdapterNativeStateReadError,
  AdapterNativeStateValidationError,
} from "./adapter.js";
import type { CopilotIncidentTraceDetail } from "./copilot-incident-trace.js";

export type CopilotSnapshotView = "tasks" | "pendingMessages" | "agents" | "activity";
export type CopilotRefreshView = "tasks" | "pendingMessages";
type ObservationTrace = Extract<CopilotIncidentTraceDetail, { kind: "observation" }>;
type FailureReason = NonNullable<ObservationTrace["failureReason"]>;

/** Process-local evidence. Neither tickets nor result stamps cross a wire. */
export interface CopilotSnapshotTicket {
  readonly view: CopilotSnapshotView;
  readonly version: number;
}

/** Runtime owns the durable reducer; the attachment owns observation validity
 * and scheduling. A durable revision is used only for journaling/diagnostics. */
export interface CopilotObservationPort {
  active(): boolean;
  revision(view: CopilotRefreshView): number | undefined;
  read(view: CopilotRefreshView): Promise<object>;
  trace(detail: ObservationTrace): void;
  failed(input: { view: CopilotRefreshView; revision: number; failures: number; diagnosticId: string; stalled: boolean }): void;
  recovered(generation: number): void;
}

interface RefreshLane {
  pending: boolean;
  failures: number;
  requestedAt: number | undefined;
  dueAt: number;
  deadline: ReturnType<typeof setTimeout> | undefined;
  attempted: { version: number; revision: number } | undefined;
  lastFailure: { version: number; reason: FailureReason } | undefined;
}

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 30_000;
const NO_SUCCESS_MS = 45_000;
const REPAIR_REFRESH_MS = 60_000;

/** One exact SDK attachment: ordered ingress, native view validity, and a single
 * refresh owner. Native request slots remain owned by the adapter read lanes;
 * retiring this driver never cancels or replays a native request. */
export class CopilotAttachmentDriver {
  readonly #noSuccessMs: number;
  public constructor(options: { readTimeoutMs?: number } = {}) {
    const readTimeoutMs = options.readTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs <= 0 || readTimeoutMs > 600_000) {
      throw new Error("Invalid Copilot observation read budget");
    }
    // Both views share one refresh owner. Permit two full read observations
    // and one retry within the no-success window; periodic requests never
    // renew it. Standard 15s reads retain the existing 45s watchdog.
    this.#noSuccessMs = Math.max(NO_SUCCESS_MS, 3 * readTimeoutMs);
  }
  readonly #versions: Record<CopilotSnapshotView, number> = { tasks: 0, pendingMessages: 0, agents: 0, activity: 0 };
  readonly #tickets = new WeakSet<CopilotSnapshotTicket>();
  readonly #snapshots = new WeakMap<object, CopilotSnapshotTicket>();
  readonly #failures = new WeakMap<object, CopilotSnapshotTicket>();
  readonly #ingress: Array<() => void> = [];
  readonly #lanes: Record<CopilotRefreshView, RefreshLane> = {
    tasks: { pending: false, failures: 0, requestedAt: undefined, dueAt: 0, deadline: undefined, attempted: undefined, lastFailure: undefined },
    pendingMessages: { pending: false, failures: 0, requestedAt: undefined, dueAt: 0, deadline: undefined, attempted: undefined, lastFailure: undefined },
  };
  #retired = false;
  #dispatching = false;
  #nativeOrdinal = 0;
  #currentOrdinal: number | undefined;
  #port: CopilotObservationPort | undefined;
  #runtimeOwner: object | undefined;
  #running = false;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refresh: ReturnType<typeof setInterval> | undefined;

  public get generation(): number { return this.#generation; }
  public get currentNativeEventOrdinal(): number | undefined { return this.#currentOrdinal; }
  public version(view: CopilotSnapshotView): number { return this.#versions[view]; }

  /** Reserve the exact attachment before Runtime commits an active binding.
   * Concurrent returned handles cannot both pass a read-only readiness check. */
  public claimRuntime(owner: object): void {
    this.#assertLive();
    if (this.#port || this.claimedByAnother(owner)) throw new Error("Copilot attachment already has an observation owner");
    this.#runtimeOwner = owner;
  }

  public claimedByAnother(owner: object): boolean {
    return this.#runtimeOwner !== undefined && this.#runtimeOwner !== owner;
  }

  /** Reentrant SDK callbacks wait until the preceding envelope and all of its
   * lifecycle facts have been emitted. No nested event can split that unit. */
  public ingress(dispatch: () => void): void {
    if (this.#retired) return;
    this.#ingress.push(dispatch);
    if (this.#dispatching) return;
    this.#dispatching = true;
    let failed = false;
    let failure: unknown;
    try {
      for (let index = 0; index < this.#ingress.length && !this.#retired; index += 1) {
        this.#currentOrdinal = ++this.#nativeOrdinal;
        try { this.#ingress[index]!(); }
        catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    } finally {
      this.#currentOrdinal = undefined;
      this.#dispatching = false;
      this.#ingress.length = 0;
    }
    if (failed) throw failure;
  }

  public invalidate(view: CopilotSnapshotView): void {
    if (!this.#retired) this.#versions[view] += 1;
  }

  /** Runtime overflow/admission gaps invalidate native reads too, even when the
   * original SDK callback never reached the durable reducer. */
  public gap(): void {
    for (const view of Object.keys(this.#versions) as CopilotSnapshotView[]) this.invalidate(view);
  }

  public capture(view: CopilotSnapshotView): CopilotSnapshotTicket {
    this.#assertLive();
    const ticket = Object.freeze({ view, version: this.#versions[view] });
    this.#tickets.add(ticket);
    return ticket;
  }

  public certify<T extends object>(ticket: CopilotSnapshotTicket, result: T): T {
    this.#assertTicket(ticket);
    this.#snapshots.set(result, ticket);
    return result;
  }

  /** Checked after Runtime drains ingress and before it projects native facts. */
  public accept(view: CopilotSnapshotView, result: object): CopilotSnapshotTicket {
    const ticket = this.#snapshots.get(result);
    if (!ticket || ticket.view !== view) throw new AdapterNativeStateReadError("snapshotInvalidated", "Native observation lacks exact attachment evidence");
    this.#assertTicket(ticket);
    return ticket;
  }

  /** Retain the exact post-refresh failure revision privately. This keeps a
   * genuine malformed current snapshot distinct from a stale read failure. */
  public rethrow(ticket: CopilotSnapshotTicket, error: unknown): never {
    if (this.#tickets.has(ticket) && typeof error === "object" && error !== null) {
      this.#failures.set(error, ticket);
    }
    throw error;
  }

  public observe(port: CopilotObservationPort, owner: object = port): void {
    this.#assertLive();
    if (this.#port || this.claimedByAnother(owner)) throw new Error("Copilot attachment already has a Runtime observer");
    this.#runtimeOwner = owner;
    this.#port = port;
    this.#refresh = setInterval(() => { this.request("tasks"); this.request("pendingMessages"); }, REPAIR_REFRESH_MS);
    this.#refresh.unref?.();
  }

  public request(view: CopilotRefreshView): void {
    const port = this.#port;
    if (this.#retired || !port) return;
    const lane = this.#lanes[view];
    const timestamp = Date.now();
    lane.pending = true;
    // A no-success deadline spans retries, invalidations and occupied native
    // lanes. Periodic refresh must never move this watchdog forward.
    if (lane.requestedAt === undefined) {
      lane.failures = 0;
      lane.lastFailure = undefined;
      lane.requestedAt = timestamp;
      lane.dueAt = timestamp;
      lane.deadline = setTimeout(() => {
        lane.deadline = undefined;
        if (this.#retired || this.#port !== port || lane.requestedAt !== timestamp || !port.active()) return;
        const currentRevision = port.revision(view);
        if (currentRevision === undefined) return;
        const revision = lane.attempted?.revision ?? currentRevision;
        const diagnosticId = newOperationId();
        port.trace({ kind: "observation", view, outcome: "stalled", generation: this.#generation, revision, currentRevision,
          failures: Math.max(1, lane.failures + 1), deadlineAgeMs: Math.max(0, Date.now() - timestamp), diagnosticId,
          ...(lane.attempted?.version === this.version(view) && lane.lastFailure?.version === this.version(view)
            ? { failureReason: lane.lastFailure.reason } : {}) });
        port.failed({ view, revision, failures: Math.max(1, lane.failures + 1), diagnosticId, stalled: true });
      }, this.#noSuccessMs);
      lane.deadline.unref?.();
    }
    this.#pump();
  }

  public retire(): boolean {
    if (this.#retired) return false;
    this.#retired = true;
    this.#generation += 1;
    this.#ingress.length = 0;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#refresh) clearInterval(this.#refresh);
    this.#timer = undefined;
    this.#refresh = undefined;
    for (const lane of Object.values(this.#lanes)) {
      lane.pending = false;
      if (lane.deadline) clearTimeout(lane.deadline);
      lane.deadline = undefined;
    }
    return true;
  }

  #assertLive(): void {
    if (this.#retired) throw new AdapterNativeStateReadError("nativeOwnerRetired", "Copilot attachment observation owner was retired");
  }

  #assertTicket(ticket: CopilotSnapshotTicket): void {
    this.#assertLive();
    if (!this.#tickets.has(ticket) || ticket.version !== this.version(ticket.view)) {
      throw new AdapterNativeStateReadError("snapshotInvalidated", "Copilot native snapshot was invalidated during observation");
    }
  }

  #pump(): void {
    const port = this.#port;
    if (this.#retired || !port || this.#running || !port.active()) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const selected = (Object.entries(this.#lanes) as Array<[CopilotRefreshView, RefreshLane]>)
      .filter(([, lane]) => lane.pending)
      .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0].localeCompare(right[0]))[0];
    if (!selected) return;
    const [view, lane] = selected;
    const delay = Math.max(0, lane.dueAt - Date.now());
    if (delay > 0) {
      this.#timer = setTimeout(() => { this.#timer = undefined; this.#pump(); }, delay);
      this.#timer.unref?.();
      return;
    }
    const revision = port.revision(view);
    if (revision === undefined) return;
    lane.pending = false;
    this.#running = true;
    const generation = ++this.#generation;
    const version = this.version(view);
    lane.attempted = { version, revision };
    port.trace({ kind: "observation", view, outcome: "started", generation, revision,
      failures: lane.failures, deadlineAgeMs: Math.max(0, Date.now() - lane.requestedAt!) });
    // No mutation lock and no cancellation/replay of an admitted SDK read.
    // The adapter still owns its retained/coalesced native transport lane.
    void Promise.resolve().then(() => {
      this.#assertLive();
      return port.read(view);
    }).then(
      result => this.#settle(port, view, version, revision, generation, { result }),
      error => this.#settle(port, view, version, revision, generation, { error }),
    );
  }

  #settle(port: CopilotObservationPort, view: CopilotRefreshView, version: number, revision: number,
    generation: number, outcome: { result: object } | { error: unknown }): void {
    const lane = this.#lanes[view];
    const deadlineAgeMs = lane.requestedAt === undefined ? 0 : Math.max(0, Date.now() - lane.requestedAt);
    if (this.#retired || this.#port !== port || this.#generation !== generation) {
      port.trace({ kind: "observation", view, outcome: this.#retired ? "retiredBinding" : "staleGeneration",
        generation, revision, failures: lane.failures, deadlineAgeMs });
      return;
    }
    const currentRevision = port.revision(view);
    if (!port.active() || currentRevision === undefined) {
      this.#running = false;
      port.trace({ kind: "observation", view, outcome: "fenceUnavailable", generation, revision, failures: lane.failures, deadlineAgeMs });
      return;
    }
    if ("result" in outcome) {
      try { version = this.accept(view, outcome.result).version; }
      catch (error) { outcome = { error }; }
    } else if (typeof outcome.error === "object" && outcome.error !== null) {
      const ticket = this.#failures.get(outcome.error);
      if (ticket?.view === view) version = ticket.version;
    }
    const stale = this.version(view) !== version;
    const failed = "error" in outcome;
    const error = "error" in outcome ? outcome.error : undefined;
    const failureReason = error instanceof AdapterNativeStateValidationError && ADAPTER_NATIVE_STATE_VALIDATION_REASONS.includes(error.reason)
      ? error.reason : error instanceof AdapterNativeStateReadError && ADAPTER_NATIVE_STATE_READ_REASONS.includes(error.reason)
        ? error.reason : "nativeReadFailed";
    const trace: ObservationTrace = { kind: "observation", view, outcome: stale ? "staleRevision" : failed ? "failed" : "accepted",
      generation, revision: stale ? revision : currentRevision, currentRevision,
      failures: lane.failures + (failed ? 1 : 0), deadlineAgeMs,
      ...(failed && !stale ? { failureReason,
        ...(error instanceof AdapterNativeStateValidationError && error.issues.length > 0 ? { validationIssues: error.issues } : {}) } : {}) };
    let reportFailure: Parameters<CopilotObservationPort["failed"]>[0] | undefined;
    let reportRecovery = false;
    if (stale) {
      lane.pending = true;
      lane.attempted = undefined;
      lane.dueAt = Date.now();
    } else if (failed) {
      lane.failures += 1;
      lane.lastFailure = { version, reason: failureReason };
      lane.attempted = { version, revision: currentRevision };
      const diagnosticId = newOperationId();
      reportFailure = { view, revision: currentRevision, failures: lane.failures, diagnosticId,
        stalled: deadlineAgeMs >= this.#noSuccessMs };
      lane.pending = true;
      lane.dueAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(30, lane.failures - 1));
    } else {
      if (lane.deadline) clearTimeout(lane.deadline);
      lane.deadline = undefined;
      lane.attempted = undefined;
      lane.lastFailure = undefined;
      lane.failures = 0;
      lane.requestedAt = undefined;
      lane.dueAt = 0;
      reportRecovery = true;
      // Exact current evidence covers invalidations emitted by tasks.refresh
      // before its capture. Those requests do not need a duplicate read.
      lane.pending = false;
    }
    // Finish the local transition before calling Runtime hooks. A hook may
    // synchronously admit newer SDK ingress; it must retain its request rather
    // than start a competing observation or get cleared by this settlement.
    port.trace(trace);
    if (!this.#retired && port.active()) {
      if (reportFailure) port.failed(reportFailure);
      else if (reportRecovery) port.recovered(generation);
    }
    this.#running = false;
    this.#pump();
  }
}
