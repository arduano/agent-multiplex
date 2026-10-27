import type { NativeProtocol } from "../../v8-session/src/contracts/native-protocol.js";
import { SessionError, sameRun, supportsNativeOpening, type NativeRead, type NativeReadResult, type Catalog, type ControlCommand, type Harness, type NativeEvent, type NativeRun, type NativeStart, type NativeOpening, type OpeningCapsule, type OpeningStopProof, type RunRef, type Selection } from "../../v8-session/src/contracts/types.js";
import { openingCapsule, openingProof, sameOpening } from "../../v8-session/src/native/opening.js";
import { copy, canonical } from "../../v8-session/src/contracts/validation.js";
import { InteractionOwner } from "../../v8-interactions/src/owner.js";
import type { NativeMcpReadPort } from "../../v8-mcp/src/contracts.js";
import type { OwnedAttachment, RuntimeEvent, RuntimeHalt } from "../../v8-runtime/src/contracts.js";
import { halt, identity, requireThat } from "../../v8-runtime/src/validation.js";
import type { ControllerBinding, HostController, HostHistoryFacet, NativeCapture, TrustedContainment } from "./contracts.js";

/** Shared custody only. Native requests/configuration remain concrete subclasses. */
export abstract class Controller implements HostController {
  abstract readonly historyFacet: HostHistoryFacet;
  abstract readonly protocol: NativeProtocol;
  readonly placement; readonly capabilities;
  readonly #containment: TrustedContainment; readonly #catalog: () => Promise<Catalog>;
  #held: { binding: ControllerBinding; owned: OwnedAttachment; interactions: InteractionOwner; mcp: NativeMcpReadPort; stop?: Promise<RuntimeHalt> } | undefined;
  #emit: ((event: RuntimeEvent) => void) | undefined; #capture: ((capture: NativeCapture) => void) | undefined;
  #buffer: (() => void)[] = []; #bytes = 0; #lost = false; #halted = false; #opening: number | null = null; #uncertain = false;
  #openingOwner: NativeOpening | undefined; #retiredOpening = 0;
  #activityRevision = 0; #captureLost = false;
  readonly cleanups: (() => void)[] = [];
  constructor(readonly kind: Harness, containment: TrustedContainment, catalog: () => Promise<Catalog>, commands: readonly ControlCommand["type"][], reads: readonly NativeRead["type"][] = []) {
    this.#containment = containment; this.#catalog = catalog; this.placement = containment.placement;
    this.capabilities = copy({ ...containment.capabilities, commands, reads });
    if (containment.onHalt) this.cleanups.push(containment.onHalt(value => {
      const held = this.#held; if (!held) return;
      if (!sameRun(value.identity.run, held.binding.run)) return;
      try { const proof = halt(value, this.placement, held.binding.run, held.binding.identity); held.interactions.halted(proof.proof); this.retireTransient(); this.#halted = true; this.#uncertain = false; if (this.#opening === held.binding.run.generation) this.#opening = null; this.#buffer = []; this.#bytes = 0; this.#emit?.({ type: "halt", halt: proof }); } catch { held.interactions.gap(); }
    }));
  }
  current(): ControllerBinding | null { return this.#held ? copy(this.#held.binding) : null; }
  interactions(run: RunRef): InteractionOwner { return this.held(run).interactions; }
  nativeMcp(run: RunRef): NativeMcpReadPort { return this.held(run).mcp; }
  protected held(run?: RunRef) { requireThat(this.#held && (!run || sameRun(this.#held.binding.run, run))); return this.#held; }
  /** Recheck custody at the actual effect boundary after asynchronous encoding. */
  protected assertActive(run: RunRef): void {
    const held = this.held(run);
    requireThat(!this.#halted && !this.#uncertain && !held.stop && held.owned.native.initializationComplete !== false && held.owned.observation.controller === "connected" && held.owned.observation.transport === "connected", "Native control owner is no longer active");
  }
  protected bindingReady(): boolean { return !!this.#held; }
  protected native(event: NativeEvent): void {
    const held = this.#held; if (!held || !sameRun(held.binding.run, event.run) || event.type === "stopped") return;
    if (event.type === "activity" || event.type === "controlLost") this.#activityRevision++;
    if (event.type === "selection") { held.binding = copy({ ...held.binding, selection: event.selection }); held.owned = { ...held.owned, native: { ...held.owned.native, selection: event.selection } }; }
    this.#emit?.({ type: "native", identity: held.binding.identity, event });
  }
  protected capture(value: unknown): void {
    const held = this.#held; if (!held) return;
    try { this.#capture?.({ kind: this.kind, run: held.binding.run, value }); }
    catch { this.observationLost(); }
  }
  /** An explicit effect or native change invalidates evidence without rereading. */
  protected mcpChanged(run: RunRef): void { const held = this.#held; if (held && !this.#halted && sameRun(held.binding.run, run)) this.#capture?.({ kind: "mcpChanged", run }); }
  /** Reverse capabilities have their own strict bounded staging. Dropping one
   * loses confirmation continuity even if later transcript events look healthy. */
  protected stage(value: unknown, apply: (frozen: unknown) => void): void {
    this.#stage(value, apply, () => this.gap());
  }
  /** Live notifications are consumed synchronously at their native transport's
   * bound. Only startup buffering has the smaller staging bound. */
  protected stageObservation(value: unknown, apply: (frozen: unknown) => void): void {
    if (this.#held && (!this.#opening || this.#held.binding.run.generation === this.#opening)) {
      try { apply(copy(value)); } catch { this.observationLost(); }
    } else this.#stage(value, apply, () => this.observationLost());
  }
  #stage(value: unknown, apply: (frozen: unknown) => void, lost: () => void): void {
    try {
      const fixed = copy(value), bytes = canonical(fixed, 65536).length;
      if (this.#held && (!this.#opening || this.#held.binding.run.generation === this.#opening)) { apply(fixed); return; }
      if (this.#buffer.length >= 64 || this.#bytes + bytes > 65536) { lost(); return; }
      this.#buffer.push(() => apply(fixed)); this.#bytes += bytes;
    } catch { lost(); }
  }
  /** Large closed media is never queued before a positive live binding. Only
   * its small control projection is copied; raw capture stays synchronous. */
  protected stageMedia(value: unknown, projection: unknown, apply: (frozen: unknown) => void): void {
    try {
      const held = this.#held;
      requireThat(held && !this.#halted && !held.stop && (!this.#opening || held.binding.run.generation === this.#opening));
      canonical(projection, 65536); const fixed = copy(projection); apply(fixed);
      requireThat(this.#held === held && !this.#halted && !held.stop); this.capture(value);
    } catch { this.observationLost(); }
  }
  /** One pending pre-binding loss fact belongs to history/progress, never the
   * reverse-capability baseline. A later native fact may prove activity again. */
  protected observationLost(): void {
    const held = this.#held;
    if (!held || this.#opening && held.binding.run.generation !== this.#opening) { this.#captureLost = true; return; }
    this.native({ type: "activity", run: held.binding.run, activity: "unknown" }); this.observationGap();
    try { this.#capture?.({ kind: "historyGap", run: held.binding.run }); } catch { /* Capture failure cannot retire reverse capabilities. */ }
  }
  protected gap(): void { this.#lost = true; this.#held?.interactions.gap(); this.observationLost(); }
  /** Native-specific root progress may lose continuity with the same captured
   * event. Reuse this existing loss boundary; never infer a native outcome. */
  protected observationGap(): void {}
  /** Concrete private transient capabilities end at native retirement/Stop. */
  protected retireTransient(): void {}
  /** Observation loss never supplies native halt or licenses another opening. */
  protected controllerLost(): void {
    this.gap(); const held = this.#held; if (!held || this.#halted) return;
    this.#activityRevision++;
    const observation = { ...held.owned.observation, controller: "lost" as const, transport: "lost" as const };
    held.owned = { ...held.owned, observation };
    this.#emit?.({ type: "observation", identity: held.binding.identity, observation });
  }
  observe(listener: (capture: NativeCapture) => void): () => void {
    if (this.#capture) throw new SessionError("BUSY", "One Host capture owner only"); this.#capture = listener;
    if (this.#held) listener({ kind: "binding", binding: copy(this.#held.binding) });
    return () => { if (this.#capture === listener) this.#capture = undefined; };
  }
  async read(run: RunRef, request: NativeRead): Promise<NativeReadResult> {
    this.assertActive(run); const result = await this.readNative(run, request); this.assertActive(run); return result;
  }
  protected async readNative(_run: RunRef, _request: NativeRead): Promise<NativeReadResult> { throw new SessionError("UNSUPPORTED"); }
  async catalog(): Promise<Catalog> { return this.#catalog(); }
  abstract openNative(input: NativeStart): Promise<Readonly<{ run: RunRef; selection: Selection; invoke: NativeRun["invoke"]; mcp: NativeMcpReadPort; initialize?: (active: () => void) => Promise<Selection> }>>;
  get parentCustody() { return this.#containment.parentCustody; }
  async open(input: NativeStart, emit: (event: RuntimeEvent) => void, onOwned?: (attachment: OwnedAttachment) => Promise<void>, onOpening?: (owner: NativeOpening) => Promise<void>): Promise<OwnedAttachment> {
    requireThat(!this.#opening && !this.#uncertain && (!this.#held || this.#halted));
    requireThat(supportsNativeOpening(this.capabilities, input.nativeSession));
    this.#opening = input.generation; this.#emit = emit; this.#lost = false; this.#captureLost = false;
    try {
      if (this.#containment.prepareOpening) {
        const opening = await this.#containment.prepareOpening(input), capsule = openingCapsule({ opening: opening.opening, identity: opening.identity });
        requireThat(capsule.opening.generation === input.generation && capsule.opening.operationId === input.operationId && canonical(capsule.opening.scope) === canonical(input.scope) && capsule.identity.placement === this.placement);
        await onOpening?.(this.#openingHandle(opening, capsule));
        requireThat(this.#retiredOpening < input.generation, "Opening was retired before native launch");
      }
      const value = await this.openNative(input), owner = identity(this.#containment.identity(value.run), this.placement, value.run);
      requireThat(this.#retiredOpening < input.generation, "Native identity arrived after opening halt");
      if (this.#openingOwner?.opening.generation === input.generation) requireThat(canonical({ attachment: owner.attachment, process: owner.process, containment: owner.containment, placement: owner.placement }) === canonical(this.#openingOwner.identity));
      const interactions = new InteractionOwner({ run: value.run, kind: this.kind, epoch: value.run.generation });
      const binding: ControllerBinding = copy({ run: value.run, identity: owner, selection: this.protocol.selection(value.selection), fresh: input.nativeSession === null });
      let held: { binding: ControllerBinding; owned: OwnedAttachment; interactions: InteractionOwner; mcp: NativeMcpReadPort; stop?: Promise<RuntimeHalt> };
      const stopTree = (): Promise<RuntimeHalt> => held.stop ??= Promise.resolve().then(() => { this.retireTransient(); return this.#containment.stopTree(owner); }).then(result => {
        const checked = halt(result, this.placement, value.run, owner); interactions.halted(checked.proof);
        if (this.#held === held) { this.#halted = true; this.#uncertain = false; if (this.#opening === value.run.generation) this.#opening = null; this.#buffer = []; this.#bytes = 0; }
        return checked;
      });
      const native = interactions.wrap({ run: { run: value.run, selection: binding.selection, interactionsComplete: false, interactions: [], invoke: value.invoke, stop: async () => (await stopTree()).proof }, emit: event => this.native(event) });
      const owned: OwnedAttachment = { identity: owner, native: { ...native, initializationComplete: false }, observation: { controller: "connected", transport: "connected", leader: "unknown" }, stopTree };
      held = { binding, owned, interactions, mcp: value.mcp }; this.#held = held; this.#halted = false;
      this.#capture?.({ kind: "binding", binding });
      if (this.#captureLost) { this.#captureLost = false; this.observationLost(); }
      for (const queued of this.#buffer.splice(0)) queued(); this.#bytes = 0;
      await onOwned?.(held.owned);
      const active = (): void => requireThat(this.#held === held && !this.#halted && !this.#uncertain, "Native initialization was retired by exact halt");
      active(); if (value.initialize) { const selection = await value.initialize(active); active(); this.native({ type: "selection", run: value.run, selection: this.protocol.selection(selection) }); }
      const activityRevision = this.#activityRevision;
      const certificate = copy(await this.#containment.observeOpening(input, value.run));
      active();
      requireThat(sameRun(certificate.run, value.run) && (input.nativeSession === null ? certificate.kind === "created" && certificate.noAutomaticContinuation === true : certificate.kind === "reopened"));
      requireThat(certificate.activity === undefined || ["idle", "working", "waiting", "unknown"].includes(certificate.activity));
      // Native metadata is a useful initial fact when cold Resume emits no idle
      // callback. An event received during that read is newer and must win.
      if (certificate.activity !== undefined && activityRevision === this.#activityRevision)
        this.native({ type: "activity", run: value.run, activity: certificate.activity });
      if (!this.#lost && certificate.callbacksComplete && certificate.continuous) interactions.certifyBaseline({ run: value.run, complete: true, continuous: true });
      else interactions.gap();
      held.owned = { ...held.owned, native: { ...held.owned.native, initializationComplete: true } };
      const view = interactions.current();
      // wrap's immutable initial baseline predates certificate/ingress; keep its
      // one response invoke owner while returning the certified current summary.
      return { ...held.owned, native: { ...held.owned.native, interactionsComplete: view.baseline === "complete", interactions: view.items.filter(item => item.state === "pending").map(({ prompt }) => ({ id: prompt.id, owner: prompt.owner.nativeAgent, kind: prompt.type.endsWith("question") ? "userInput" : prompt.type.endsWith("elicitation") ? "elicitation" : prompt.type.endsWith("plan") ? "exitPlan" : prompt.type.endsWith("permission") ? "permission" : "approval", choices: interactionChoices(prompt) })) } };
    } catch {
      if (this.#retiredOpening < input.generation && (!this.#held || this.#held.binding.run.generation === input.generation)) { if (!this.#halted || !this.#held) this.#uncertain = true; this.gap(); }
      throw new SessionError("IO", "Original native open remains owned or uncertain; do not replay");
    } finally { if (this.#opening === input.generation) this.#opening = null; }
  }
  #openingHandle(owner: NativeOpening, expected: OpeningCapsule): NativeOpening {
    const capsule = openingCapsule({ opening: owner.opening, identity: owner.identity }); requireThat(sameOpening(capsule, expected) && typeof owner.stop === "function");
    if (this.#openingOwner && sameOpening(this.#openingOwner, capsule)) return this.#openingOwner;
    let stopped: Promise<OpeningStopProof> | undefined;
    const held: NativeOpening = { ...capsule, stop: () => stopped ??= Promise.resolve().then(() => owner.stop()).then(value => {
      const proof = openingProof(capsule, value); this.#retiredOpening = Math.max(this.#retiredOpening, capsule.opening.generation);
      if (this.#openingOwner === held) {
        this.#halted = true; this.#uncertain = false; if (this.#opening === capsule.opening.generation) this.#opening = null; this.#buffer = []; this.#bytes = 0;
        const run = this.#held?.binding.run; if (run?.generation === capsule.opening.generation) this.#held!.interactions.halted({ run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true });
      }
      return proof;
    }) };
    this.#openingOwner = held; return held;
  }
  async inspectOpening(input: OpeningCapsule): Promise<NativeOpening | OpeningStopProof | null> {
    const capsule = openingCapsule(input), found = await this.#containment.inspectOpening?.(capsule);
    if (!found) return null;
    if ("state" in found) { const proof = openingProof(capsule, found); this.#retiredOpening = Math.max(this.#retiredOpening, capsule.opening.generation); this.#halted = true; this.#uncertain = false; return proof; }
    return this.#openingHandle(found, capsule);
  }
  async inspect(run: RunRef, emit: (event: RuntimeEvent) => void): Promise<OwnedAttachment | RuntimeHalt | null> {
    const evidence = await this.#containment.inspect(run);
    if (evidence === null) return null;
    if (evidence !== "owned") {
      const checked = halt(evidence, this.placement, run, this.#held?.binding.identity);
      if (this.#held && sameRun(this.#held.binding.run, run)) { this.#held.interactions.halted(checked.proof); this.retireTransient(); }
      this.#halted = true; if (this.#held) this.#uncertain = false; this.#buffer = []; this.#bytes = 0; return checked;
    }
    if (!this.#held || !sameRun(this.#held.binding.run, run)) return null;
    this.#emit = emit; this.#capture?.({ kind: "binding", binding: copy(this.#held.binding) });
    const held = this.#held, view = held.interactions.current();
    return { ...held.owned, native: { ...held.owned.native, interactionsComplete: view.baseline === "complete", interactions: view.items.filter(item => item.state === "pending").map(({ prompt }) => ({ id: prompt.id, owner: prompt.owner.nativeAgent, kind: prompt.type.endsWith("question") ? "userInput" : prompt.type.endsWith("elicitation") ? "elicitation" : prompt.type.endsWith("plan") ? "exitPlan" : prompt.type.endsWith("permission") ? "permission" : "approval", choices: interactionChoices(prompt) })) } };
  }
  dispose(): void { requireThat(!this.#opening && (!this.#held || this.#halted) && !this.#uncertain); this.retireTransient(); for (const cleanup of this.cleanups.splice(0)) cleanup(); this.#capture = undefined; }
}
import { choices as interactionChoices } from "../../v8-interactions/src/native.js";
