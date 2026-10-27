import { SessionError, sameRun, scopeKey, supportsNativeOpening, type Catalog, type NativeEvent, type NativePort, type NativeRun, type NativeStart, type NativeOpening, type OpeningCapsule, type OpeningStopProof, type RunRef, type SessionScope, type StopProof } from "../../v8-session/src/contracts/types.js";
import { openingCapsule, openingProof, sameOpening } from "../../v8-session/src/native/opening.js";
import { canonical, copy, scope as validateScope } from "../../v8-session/src/contracts/validation.js";
import { validateCatalog, validateInteractions, validateOutcome, validateRun } from "../../v8-session/src/native/validation.js";
import type { OwnedAttachment, RuntimeEvent, RuntimeHalt, RuntimeIdentity, RuntimeOwnershipPort, RuntimeSnapshot } from "./contracts.js";
import { halt, identity, observation, requireThat, sameIdentity } from "./validation.js";

/** One root's non-durable ownership seam. SessionHost alone owns lifecycle and
 * original receipts. No timers, PID signals, autonomous recovery or effect retry. */
export class RuntimeSupervisor implements NativePort {
  readonly kind; readonly placement; readonly capabilities;
  readonly protocol;
  readonly #scope: SessionScope; readonly #ownership: RuntimeOwnershipPort;
  #current: { identity: RuntimeIdentity; emit: (event: NativeEvent) => void; invoke: NativeRun["invoke"]; stopTree: () => Promise<RuntimeHalt>; stop?: Promise<StopProof> } | undefined;
  #snapshot: RuntimeSnapshot; #opening: number | null = null; #uncertainOpen = false; #inspection: object | undefined;
  #halt: StopProof | undefined;
  #quarantined: OwnedAttachment | undefined;
  #pendingOpening: NativeOpening | undefined; #openingHalt: OpeningStopProof | undefined;
  constructor(options: Readonly<{ scope: SessionScope; ownership: RuntimeOwnershipPort }>) {
    validateScope(options.scope); this.#scope = copy(options.scope); this.#ownership = options.ownership;
    this.kind = options.ownership.kind; this.protocol = options.ownership.protocol; this.placement = options.ownership.placement; this.capabilities = copy(options.ownership.capabilities);
    requireThat(typeof this.kind === "string" && this.kind.length > 0 && this.protocol && ["shared", "dedicated"].includes(this.placement));
    canonical(this.capabilities, 8192);
    this.#snapshot = { scope: this.#scope, identity: null, observation: { controller: "unknown", transport: "unknown", leader: "unknown" } };
  }
  snapshot(): RuntimeSnapshot { return copy(this.#snapshot); }
  get parentCustody() { return this.#ownership.parentCustody; }
  async catalog(): Promise<Catalog> { return validateCatalog(copy(await this.#ownership.catalog())); }
  #scopeMatches(run: RunRef): void { requireThat(scopeKey(run.scope) === scopeKey(this.#scope)); }
  #inspectionFence(run: RunRef): void {
    const known = this.#snapshot.identity?.run;
    requireThat(!known || run.generation >= known.generation && run.nativeSession === known.nativeSession);
    if (this.#current) requireThat(sameRun(this.#current.identity.run, run), "Inspection cannot replace an existing run generation");
  }
  async start(input: NativeStart, emit: (event: NativeEvent) => void, onOwned?: (run: NativeRun) => Promise<void>, onOpening?: (owner: NativeOpening) => Promise<void>): Promise<NativeRun> {
    const fixed = copy(input); canonical(fixed, 16384); validateScope(fixed.scope);
    requireThat(Object.keys(fixed).every(key => ["scope", "generation", "placement", "operationId", "nativeSession", "selection", "policy"].includes(key)), "Unsupported opening field");
    requireThat(scopeKey(fixed.scope) === scopeKey(this.#scope) && fixed.placement === this.placement);
    const known = this.#snapshot.identity?.run;
    requireThat(Number.isSafeInteger(fixed.generation) && fixed.generation > Math.max(known?.generation ?? 0, this.#openingHalt?.opening.generation ?? 0));
    requireThat(fixed.nativeSession === null || typeof fixed.nativeSession === "string" && fixed.nativeSession.length > 0);
    this.protocol.policy(fixed.policy); if (fixed.selection) this.protocol.selection(fixed.selection);
    if (!supportsNativeOpening(this.capabilities, fixed.nativeSession)) throw new SessionError("UNSUPPORTED", "Native lifetime capabilities are not qualified");
    if (this.#opening || this.#uncertainOpen || this.#current && !this.#halt) throw new SessionError("BUSY", "Existing or uncertain ownership must settle before opening");
    if (known) requireThat(fixed.nativeSession === known.nativeSession, "Resume must retain the exact native session");
    this.#inspection = undefined; this.#opening = fixed.generation;
    const pending: RuntimeEvent[] = []; let pendingBytes = 0; let bound: RuntimeIdentity | undefined; let overflow = false;
    const receive = (event: RuntimeEvent): void => {
      if (bound) { this.#event(event, bound); return; }
      try {
        const captured = copy(event), size = canonical(captured, 32768).length;
        if (pending.length >= 64 || pendingBytes + size > 65536) { overflow = true; return; }
        pending.push(captured); pendingBytes += size;
      } catch { overflow = true; }
    };
    try {
      const adopt = async (attachment: OwnedAttachment): Promise<NativeRun> => {
        const expected = { scope: fixed.scope, generation: fixed.generation, nativeSession: fixed.nativeSession ?? attachment.native.run.nativeSession };
        if (this.#snapshot.identity && this.#snapshot.identity.run.generation > fixed.generation) throw new SessionError("FENCED", "Native open completed after its lifetime was replaced");
        requireThat(!this.#halt || !sameRun(this.#halt.run, expected), "Native open settled after exact halt");
        requireThat(this.#openingHalt?.opening.generation !== fixed.generation, "Native identity arrived after opening halt");
        this.#quarantined = attachment;
        if (bound) requireThat(sameIdentity(bound, identity(attachment.identity, this.placement, expected)));
        const installed = this.#install(attachment, expected, emit); this.#quarantined = undefined;
        const first = !bound; bound = this.#current!.identity;
        if (overflow) { this.#snapshot = { ...this.#snapshot, issue: "invalidEvidence" }; throw new SessionError("FENCED", "Initial runtime evidence exceeded its bound"); }
        for (const event of pending.splice(0)) this.#event(event, bound);
        if (first) await onOwned?.(installed);
        return installed;
      };
      const attachment = await this.#ownership.open(fixed, receive, async owned => { await adopt(owned); }, async opening => {
        const capsule = openingCapsule({ opening: opening.opening, identity: opening.identity });
        requireThat(capsule.opening.generation === fixed.generation && capsule.opening.operationId === fixed.operationId && scopeKey(capsule.opening.scope) === scopeKey(fixed.scope) && capsule.identity.placement === this.placement);
        await onOpening?.(this.#retainOpening(opening, capsule));
      });
      const installed = await adopt(attachment);
      return installed;
    } catch (error) {
      // The actual request may have opened work. Quarantine the lane; never
      // disconnect an unexpected handle or launch a replacement automatically.
      if (this.#openingHalt?.opening.generation !== fixed.generation && (this.#snapshot.identity?.run.generation ?? fixed.generation) <= fixed.generation && (!this.#halt || this.#quarantined)) { this.#uncertainOpen = true; this.#snapshot = { ...this.#snapshot, issue: "ownershipUnconfirmed" }; }
      throw error;
    } finally { if (this.#opening === fixed.generation) this.#opening = null; }
  }
  #retainOpening(owner: NativeOpening, expected: OpeningCapsule): NativeOpening {
    const capsule = openingCapsule({ opening: owner.opening, identity: owner.identity });
    requireThat(sameOpening(expected, capsule) && scopeKey(capsule.opening.scope) === scopeKey(this.#scope) && capsule.identity.placement === this.placement && typeof owner.stop === "function");
    requireThat(!this.#pendingOpening || capsule.opening.generation >= this.#pendingOpening.opening.generation);
    let stopped: Promise<OpeningStopProof> | undefined;
    const held: NativeOpening = { ...capsule, stop: () => stopped ??= Promise.resolve().then(() => owner.stop()).then(value => this.#acceptOpeningHalt(capsule, value)) };
    this.#pendingOpening = held; return held;
  }
  #acceptOpeningHalt(capsule: OpeningCapsule, value: OpeningStopProof): OpeningStopProof {
    const checked = openingProof(capsule, value);
    requireThat(this.#pendingOpening && sameOpening(this.#pendingOpening, capsule));
    const current = this.#current;
    if (current?.identity.run.generation === capsule.opening.generation) {
      requireThat(current.identity.run.generation === capsule.opening.generation && canonical({ attachment: current.identity.attachment, process: current.identity.process, containment: current.identity.containment, placement: current.identity.placement }) === canonical(capsule.identity));
      this.#halt = { run: current.identity.run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true };
    } else if (current) requireThat(current.identity.run.generation < capsule.opening.generation && this.#halt && sameRun(this.#halt.run, current.identity.run));
    this.#openingHalt = checked; this.#opening = null; this.#uncertainOpen = false; this.#inspection = undefined; this.#quarantined = undefined;
    this.#snapshot = { ...this.#snapshot, observation: { controller: "lost", transport: "lost", leader: "unknown" } };
    return copy(checked);
  }
  async inspectOpening(input: OpeningCapsule): Promise<NativeOpening | OpeningStopProof | null> {
    const capsule = openingCapsule(input); requireThat(scopeKey(capsule.opening.scope) === scopeKey(this.#scope) && capsule.identity.placement === this.placement);
    requireThat(!this.#snapshot.identity || this.#snapshot.identity.run.generation <= capsule.opening.generation);
    requireThat(!this.#opening || this.#opening <= capsule.opening.generation);
    if (this.#openingHalt && sameOpening(capsule, this.#openingHalt)) return copy(this.#openingHalt);
    const found = await this.#ownership.inspectOpening?.(capsule);
    requireThat(!this.#snapshot.identity || this.#snapshot.identity.run.generation <= capsule.opening.generation);
    requireThat(!this.#opening || this.#opening <= capsule.opening.generation);
    if (this.#openingHalt && sameOpening(capsule, this.#openingHalt)) return copy(this.#openingHalt);
    if (!found) return null;
    if ("state" in found) {
      openingProof(capsule, found);
      if (!this.#pendingOpening) this.#pendingOpening = { ...capsule, stop: async () => found };
      return this.#acceptOpeningHalt(capsule, found);
    }
    return this.#retainOpening(found, capsule);
  }
  async inspect(runValue: RunRef, emit: (event: NativeEvent) => void): Promise<NativeRun | StopProof | null> {
    const run = validateRun(copy(runValue)); this.#scopeMatches(run);
    if (this.#opening) throw new SessionError("BUSY", "An explicit native open is still owned");
    this.#inspectionFence(run);
    if (this.#halt && sameRun(this.#halt.run, run)) return copy(this.#halt);
    // Observer handover is synchronous. A continuing native stream belongs to
    // the newest same-run Host while read-only baseline inspection is pending.
    const current = this.#current;
    if (current && sameRun(current.identity.run, run)) {
      current.emit = emit;
      if (this.#snapshot.observation.controller !== "connected" || this.#snapshot.observation.transport !== "connected") emit({ type: "controlLost", run });
    }
    const captured = this.#snapshot;
    // This method never calls open, stopTree, invoke or any native resume.
    const receive = (event: RuntimeEvent): void => {
      const current = this.#current; if (current && sameRun(current.identity.run, run)) this.#event(event, current.identity);
    };
    const ticket = {}; this.#inspection = ticket;
    try {
      const found = await this.#ownership.inspect(run, receive);
      // Recheck after awaiting. Even same-run reads cannot roll back a newer
      // baseline or replace its current Host sink when completed out of order.
      this.#inspectionFence(run);
      if (this.#halt && sameRun(this.#halt.run, run)) return copy(this.#halt);
      // Exact positive halt evidence outranks read-acquisition order. The token
      // orders only baselines/sinks; it is not a native version or event cursor.
      if (found && "proof" in found) return this.#acceptHalt(found, run, this.#current?.identity);
      requireThat(this.#inspection === ticket, "Inspection was superseded");
      if (!found) { this.#snapshot = { ...this.#snapshot, issue: "ownershipUnconfirmed" }; return null; }
      const installed = this.#install(found, run, emit, this.#snapshot !== captured); if (!this.#quarantined) this.#uncertainOpen = false; return installed;
    } finally {
      if (this.#inspection === ticket) this.#inspection = undefined;
    }
  }
  #install(value: OwnedAttachment, expected: RunRef, emit: (event: NativeEvent) => void, preserveObservation = false): NativeRun {
    this.#scopeMatches(expected);
    const known = this.#snapshot.identity?.run;
    requireThat(!known || expected.generation >= known.generation);
    if (this.#current && !sameRun(this.#current.identity.run, expected)) requireThat(this.#halt && expected.generation > this.#current.identity.run.generation);
    const owner = identity(value.identity, this.placement, expected), run = validateRun(copy(value.native.run)); requireThat(sameRun(run, expected));
    if (this.#pendingOpening?.opening.generation === expected.generation) requireThat(canonical({ attachment: owner.attachment, process: owner.process, containment: owner.containment, placement: owner.placement }) === canonical(this.#pendingOpening.identity));
    const selection = this.protocol.selection(copy(value.native.selection)), interactions = validateInteractions(copy(value.native.interactions));
    requireThat(value.native.initializationComplete === undefined || typeof value.native.initializationComplete === "boolean");
    requireThat(typeof value.native.interactionsComplete === "boolean" && typeof value.native.invoke === "function" && typeof value.stopTree === "function");
    const observed = observation(value.observation), invoke = value.native.invoke.bind(value.native), stopTree = value.stopTree.bind(value);
    const prior = this.#current && sameRun(this.#current.identity.run, run) ? this.#current : undefined;
    if (prior) requireThat(sameIdentity(prior.identity, owner));
    const handle: NativeRun = Object.freeze({ run, selection, ...(value.native.initializationComplete === undefined ? {} : { initializationComplete: value.native.initializationComplete }), interactionsComplete: value.native.interactionsComplete, interactions,
      invoke: async input => {
        const current = this.#current; requireThat(current && sameIdentity(current.identity, owner) && !this.#halt && !current.stop);
        const command = this.protocol.nativeCommand(input);
        if (this.#snapshot.observation.controller !== "connected" || this.#snapshot.observation.transport !== "connected") return { status: "refused", detail: { reason: "nativeControlUnavailable" } };
        return validateOutcome(copy(await current.invoke(command)));
      },
      stop: () => {
        const current = this.#current; requireThat(current && sameIdentity(current.identity, owner));
        if (this.#halt) return Promise.resolve(copy(this.#halt));
        if (!current.stop) current.stop = Promise.resolve().then(current.stopTree).then(found => this.#acceptHalt(found, run, owner));
        // A caller deadline never retires this actual original stop request.
        return current.stop;
      } });
    // Refresh the read baseline while retaining the exact actual Stop promise.
    if (prior) { prior.emit = emit; prior.invoke = invoke; prior.stopTree = stopTree; }
    else this.#current = { identity: owner, emit, invoke, stopTree };
    this.#halt = undefined;
    this.#snapshot = preserveObservation ? { ...this.#snapshot, identity: owner } : { scope: this.#scope, identity: owner, observation: observed };
    if (this.#snapshot.observation.controller !== "connected" || this.#snapshot.observation.transport !== "connected") emit({ type: "controlLost", run });
    return handle;
  }
  #acceptHalt(value: RuntimeHalt, run: RunRef, owner?: RuntimeIdentity): StopProof {
    const checked = halt(value, this.placement, run, owner); this.#scopeMatches(run);
    if (this.#current) {
      requireThat(sameIdentity(this.#current.identity, checked.identity));
    }
    this.#halt = checked.proof;
    if (this.#opening === run.generation) this.#opening = null;
    this.#inspection = undefined;
    if (!this.#quarantined) this.#uncertainOpen = false;
    this.#snapshot = { scope: this.#scope, identity: checked.identity, observation: { controller: "lost", transport: "lost", leader: "unknown" } };
    return copy(checked.proof);
  }
  #event(value: RuntimeEvent, owner: RuntimeIdentity): void {
    try {
      const event = copy(value); canonical(event, 32768);
      const current = this.#current; if (!current || !sameIdentity(current.identity, owner)) return;
      if (event.type === "halt") {
        const proof = this.#acceptHalt(event.halt, owner.run, owner); current.emit({ type: "stopped", run: owner.run, proof }); return;
      }
      const exact = identity(event.identity, this.placement, owner.run); requireThat(sameIdentity(exact, owner));
      if (this.#halt) return;
      if (event.type === "observation") {
        const observed = observation(event.observation); this.#snapshot = { scope: this.#scope, identity: owner, observation: observed };
        if (observed.controller !== "connected" || observed.transport !== "connected") current.emit({ type: "controlLost", run: owner.run });
        return;
      }
      requireThat(event.type === "native");
      const native = this.protocol.event(event.event); requireThat(native.type !== "stopped" && sameRun(native.run, owner.run)); current.emit(native);
    } catch { this.#snapshot = { ...this.#snapshot, issue: "invalidEvidence" }; }
  }
}
