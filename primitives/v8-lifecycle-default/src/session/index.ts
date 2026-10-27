import { createHash } from "node:crypto";
import { canonical, copy, id, scope as validateScope } from "../../../v8-session/src/contracts/validation.js";
import { SessionError, sameRun, scopeKey, supportsNativeOpening, isMessageCommand, type OpeningIdentity, type NativeRead, type NativeReadResult, type Capabilities, type ControlCommand, type NativeControlCommand, type NativeSendCommand, type PreparedSend, type SendSubmit, type ManagedPolicy, type NativeEvent, type NativeOutcome, type NativeOpening, type OpeningCapsule, type OpeningStopProof, type ReaderCustody, type ReaderCustodyPort, type NativePort, type NativeRun, type Receipt, type RunRef, type Selection, type SessionPort, type SessionScope, type SessionSnapshot, type StopProof, type Submit } from "../../../v8-session/src/contracts/types.js";
import { openingCapsule, openingProof, sameOpening, parentIdentity, parentProof } from "../../../v8-session/src/native/opening.js";
import { validateOutcome, validateRun, validateStopProof } from "../../../v8-session/src/native/validation.js";
import { sameAttention } from "../../../v8-session/src/contracts/attention.js";
import { SessionJournal, sessionLimits, type Admission, type RecordIdentity, type SessionLimits } from "./journal.js";

export interface SessionHostOptions { directory: string; scope: SessionScope; port: NativePort; policy: ManagedPolicy; observationMs?: number; limits?: Partial<SessionLimits>; identity?: RecordIdentity; archive?: Readonly<{ ready(): Promise<boolean>; release(): Promise<void> }> }
type Work = { hash: string; promise: Promise<Receipt>; actual: Promise<Receipt>; request: Submit; retire(receipt: Receipt): void };
type StartAttempt = { base: number; invoked: boolean; completion?: Promise<unknown> };
const failure = (code: string): NativeOutcome => ({ status: "refused", detail: { reason: code } });
const deferred = (): { promise: Promise<void>; resolve(): void } => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const retirement = (): { promise: Promise<Receipt>; resolve(value: Receipt): void } => { let resolve!: (value: Receipt) => void; const promise = new Promise<Receipt>(done => { resolve = done; }); return { promise, resolve }; };

/** One root's durable effect ownership. Native process mechanics remain an injected port. */
export class SessionHost implements SessionPort {
  readonly #scope: SessionScope; readonly #port: NativePort; readonly #policy: ManagedPolicy; readonly #journal: SessionJournal;
  readonly #limits: SessionLimits; readonly #observationMs: number;
  readonly #archive: SessionHostOptions["archive"];
  readonly #listeners = new Set<(snapshot: SessionSnapshot) => void>();
  readonly #receiptListeners = new Set<{ id: string; listener: (receipt: Receipt) => void }>();
  readonly #reads = new Map<string, Promise<NativeReadResult>>();
  readonly #requests = new Map<string, Work>(); readonly #actual = new Set<Promise<unknown>>();
  readonly #actualOwners = new Map<Promise<unknown>, { generation: number; stop: boolean }>();
  readonly #retired = new Map<string, Receipt>();
  readonly #arrivedResults = new Map<string, { receipt: Receipt; promise: Promise<Receipt> }>();
  #resultTail: Promise<void> = Promise.resolve();
  #state: SessionSnapshot; #run: NativeRun | undefined; #start: Promise<void> | undefined; #stop: Promise<StopProof | OpeningStopProof | undefined> | undefined;
  #opening: NativeOpening | undefined; #openingCapsule: OpeningCapsule | undefined;
  #normal: { id: string; generation: number; type: Submit["command"]["type"] } | undefined; #closed = false; #revision = 0;
  #early: NativeEvent[] = []; #earlyBytes = 0;
  #stateTail: Promise<void> = Promise.resolve(); #stopFence = false; #attempt: StartAttempt | undefined;
  #capturingInitial = false; #baselineLost = false;
  #halt: { generation: number; promise: Promise<void>; resolve(): void } | undefined;
  #nativeReady: { generation: number; promise: Promise<void>; resolve(): void } | undefined;
  #finalization: { generation: number; promise: Promise<void> } | undefined;
  private constructor(options: SessionHostOptions, journal: SessionJournal, snapshot: SessionSnapshot) {
    this.#scope = copy(options.scope); this.#port = options.port; this.#policy = copy(options.policy); this.#journal = journal;
    this.#limits = sessionLimits(options.limits); this.#observationMs = options.observationMs ?? 1000; this.#state = copy(snapshot); this.#revision = snapshot.revision; this.#archive = options.archive;
  }
  /** Derived from the existing command admission and durable seal. */
  get archiving(): boolean { return this.#normal?.type === "archive" || this.#state.archive !== undefined; }
  /** Completed Archive seals effects, not retained native transcript reads.
   * The journal independently proves Archive completion before reader intent. */
  get historyReadable(): boolean { return !this.archiving || this.#normal?.type !== "archive" && this.#state.archive?.state === "complete" && this.#state.phase === "stopped"; }
  readonly readers: ReaderCustodyPort = Object.freeze<ReaderCustodyPort>({
    read: (): Promise<ReaderCustody> => { this.#check(this.#scope); return this.#journal.call("reader.read", {}); },
    begin: async (run, opening) => { this.#check(run.scope); if (!this.historyReadable) throw new SessionError("FENCED"); await this.#stampParent(); await this.#journal.call("reader.begin", { run, opening }); },
    owned: async (run, capsule) => { this.#check(run.scope); await this.#journal.call("reader.owned", { run, capsule }); },
    released: async proof => { this.#check(proof.opening.scope); await this.#journal.call("reader.released", { proof }); },
  });
  static async open(options: SessionHostOptions): Promise<SessionHost> {
    const native = options.port;
    if (!native.protocol || typeof native.protocol.command !== "function" || typeof native.protocol.policy !== "function") throw new SessionError("UNSUPPORTED", "An explicit harness protocol is required");
    const port: NativePort = Object.freeze({ kind: native.kind, protocol: native.protocol, placement: native.placement, capabilities: copy(native.capabilities), start: native.start.bind(native), inspect: native.inspect.bind(native), catalog: native.catalog.bind(native), ...(native.parentCustody ? { parentCustody: native.parentCustody } : {}), ...(native.read ? { read: native.read.bind(native) } : {}), ...(native.mcpLoginLink ? { mcpLoginLink: native.mcpLoginLink.bind(native) } : {}), ...(native.inspectOpening ? { inspectOpening: native.inspectOpening.bind(native) } : {}), ...(native.prepareSend ? { prepareSend: native.prepareSend.bind(native) } : {}) });
    const fixed = { ...options, port, scope: copy(options.scope), policy: port.protocol.policy(copy(options.policy)) };
    validateScope(fixed.scope);
    if (fixed.policy.kind !== fixed.port.kind || !["shared", "dedicated"].includes(fixed.port.placement)) throw new SessionError("FENCED");
    if (!Number.isSafeInteger(options.observationMs ?? 1000) || (options.observationMs ?? 1000) <= 0) throw new SessionError("INVALID");
    const capabilities = copy(fixed.port.capabilities);
    canonical(capabilities);
    const initial: SessionSnapshot = { scope: fixed.scope, kind: fixed.port.kind, placement: fixed.port.placement, epoch: 0, revision: 0, generation: 0, phase: "stopped", activity: "idle", nativeSession: null, stopRequested: false, selection: { kind: fixed.port.kind }, interactionsComplete: false, interactions: [], capabilities };
    const { journal, snapshot } = await SessionJournal.open(fixed.directory, fixed.scope, sessionLimits(fixed.limits), initial, fixed.identity);
    if (snapshot.kind !== fixed.port.kind || snapshot.placement !== fixed.port.placement) { await journal.terminate(); throw new SessionError("FENCED"); }
    const host = new SessionHost(fixed, journal, snapshot);
    try { host.#openingCapsule = await journal.call<OpeningCapsule | null>("opening.read", {}) ?? undefined; await host.#reconcileParent(); await host.#inspect(); return host; } catch (error) { await journal.terminate(); throw error; }
  }
  #check(scope: SessionScope): void { if (this.#closed) throw new SessionError("CLOSED"); validateScope(scope); if (scopeKey(scope) !== scopeKey(this.#scope)) throw new SessionError("FENCED"); }
  async snapshot(scope: SessionScope): Promise<SessionSnapshot> { this.#check(scope); return copy(this.#state); }
  subscribe(scope: SessionScope, listener: (snapshot: SessionSnapshot) => void): () => void {
    this.#check(scope); if (this.#listeners.size >= this.#limits.maxListeners) throw new SessionError("BUSY");
    this.#listeners.add(listener); try { listener(copy(this.#state)); } catch { /* Consumers cannot change native ownership. */ }
    return () => { this.#listeners.delete(listener); };
  }
  async receipt(scope: SessionScope, operationId: string): Promise<Receipt | null> { this.#check(scope); id(operationId); return this.#journal.call("receipt", { id: operationId }); }
  async mcpLoginLink(runValue: RunRef, originalId: string) {
    const run = validateRun(runValue); this.#check(run.scope); id(originalId);
    const active = (): void => {
      this.#check(run.scope);
      if (this.archiving || this.#state.phase !== "running" || this.#stopFence || this.#state.stopRequested || !this.#run || !sameRun(this.#run.run, run)) throw new SessionError("FENCED");
    };
    active(); if (!this.#port.mcpLoginLink) throw new SessionError("UNSUPPORTED");
    const link = await this.#port.mcpLoginLink(run, originalId); active(); return copy(link);
  }
  /** Observation timeouts do not release actual read admission or start another native call. */
  read(runValue: RunRef, value: NativeRead): Promise<NativeReadResult> {
    const run = validateRun(runValue); this.#check(run.scope); const request = this.#port.protocol.read(value);
    const active = (): void => {
      this.#check(run.scope);
      if (this.archiving || this.#state.phase !== "running" || this.#stopFence || this.#state.stopRequested || !this.#run || !sameRun(this.#run.run, run)) throw new SessionError("FENCED");
    };
    active(); if (!this.#port.read || !this.#port.capabilities.reads?.includes(request.type)) return Promise.reject(new SessionError("UNSUPPORTED"));
    const key = canonical({ run, request }), prior = this.#reads.get(key); if (prior) return prior;
    if (this.#reads.size >= 4) return Promise.reject(new SessionError("BUSY"));
    const pending = Promise.resolve().then(async () => { active(); const result = await this.#port.read!(run, request); active(); return this.#port.protocol.readResult(run, request, result); });
    this.#reads.set(key, pending); void pending.finally(() => { if (this.#reads.get(key) === pending) this.#reads.delete(key); }).catch(() => {}); return pending;
  }
  subscribeReceipt(scope: SessionScope, operationId: string, listener: (receipt: Receipt) => void): () => void {
    this.#check(scope); id(operationId); if (this.#receiptListeners.size >= 128) throw new SessionError("BUSY");
    const entry = { id: operationId, listener }; this.#receiptListeners.add(entry); return () => { this.#receiptListeners.delete(entry); };
  }
  #committedReceipt(receipt: Receipt): Receipt {
    // Final originals can commit after the last native frame. Wake the existing
    // session watch only after durable settlement; phase/activity/generation
    // stay current, including when this result belongs to an older generation.
    // Nonfinal #save transitions retain their own ordered state publication.
    if (!this.#closed && (receipt.state === 'acknowledged' || receipt.state === 'refused')) this.#publish({});
    for (const entry of [...this.#receiptListeners]) if (!this.#closed && entry.id === receipt.id) try { entry.listener(copy(receipt)); } catch { /* Receipt observation cannot change the committed original. */ }
    return receipt;
  }
  #publish(patch: Partial<SessionSnapshot>): void {
    const next = { ...this.#state, ...patch, revision: ++this.#revision };
    for (const key of Object.keys(next)) if (next[key as keyof SessionSnapshot] === undefined) delete (next as Record<string, unknown>)[key];
    this.#state = copy(next);
    for (const listener of this.#listeners) try { listener(copy(this.#state)); } catch { /* Renderer isolation. */ }
  }
  async #save(patch: Partial<SessionSnapshot> | (() => Partial<SessionSnapshot> | null), request?: Submit, beforePublish?: () => void): Promise<void> {
    const work = this.#stateTail.then(async () => {
      const update = typeof patch === "function" ? patch() : patch; if (update === null) return;
      if (request?.command.type === "stop" && (this.#finalization?.generation === this.#state.generation || this.#state.phase === "stopped" && !this.#attempt)) return;
      const effective = request && ["create", "resume"].includes(request.command.type) && this.#stopFence ? { ...update, phase: "stopping" as const, stopRequested: true, issue: "stopUnconfirmed" as const } : { ...update };
      // Retained facts cannot describe a replacement native identity, even
      // before its first checkpoint. Same-native Resume retains provenance.
      if (effective.nativeSession !== undefined && effective.nativeSession !== this.#state.nativeSession) Object.assign(effective, { usage: undefined, attention: undefined });
      const next = { ...this.#state, ...effective, revision: this.#revision + 1 };
      for (const key of Object.keys(next)) if (next[key as keyof SessionSnapshot] === undefined) delete (next as Record<string, unknown>)[key];
      const state = copy(next);
      if (request) await this.#transition(request, "dispatched", undefined, undefined, state);
      else await this.#journal.call("state", { snapshot: state });
      beforePublish?.();
      this.#publish(effective);
    });
    this.#stateTail = work.catch(() => {}); await work;
  }
  async #reconcileParent(): Promise<void> {
    const identity = await this.#journal.call<OpeningIdentity | null>("parent.read", {}), custody = this.#port.parentCustody;
    if (!identity || !custody) return;
    const observed = await custody.inspect(copy(identity)); if (!observed) return;
    const proof = parentProof(identity, observed);
    await this.#journal.call("parent.retired", { proof });
    if (this.#state.phase !== "stopped") await this.#finalizeStopped(this.#state.generation, () => true);
  }
  async #stampParent(): Promise<void> {
    const custody = this.#port.parentCustody;
    let previous = await this.#journal.call<OpeningIdentity | null>("parent.read", {});
    if (previous && (!custody || canonical(previous) !== canonical(custody.identity))) {
      await this.#reconcileParent(); previous = await this.#journal.call<OpeningIdentity | null>("parent.read", {});
      if (previous) throw new SessionError("FENCED");
    }
    if (custody) await this.#journal.call("parent.save", { identity: parentIdentity(custody.identity) });
  }
  #canContinue(): boolean { return this.#state.activity === "idle" && this.#state.interactionsComplete && this.#state.interactions.length === 0 && !(this.#state.attention?.state === "retrying" && this.#state.attention.generation === this.#state.generation && this.#state.attention.epoch === this.#state.epoch); }
  #runRef(): RunRef | null { return this.#state.nativeSession ? { scope: this.#scope, generation: this.#state.generation, nativeSession: this.#state.nativeSession } : null; }
  #haltFor(generation: number): Promise<void> { if (this.#halt?.generation !== generation) this.#halt = { generation, ...deferred() }; return this.#halt!.promise; }
  #nativeReadyFor(generation: number): Promise<void> { if (this.#nativeReady?.generation !== generation) this.#nativeReady = { generation, ...deferred() }; return this.#nativeReady.promise; }
  #current(run: RunRef): boolean { const current = this.#runRef(); return !!current && sameRun(current, run); }
  async #inspect(): Promise<void> {
    if (this.#state.phase === "stopped") return;
    this.#publish({ activity: "unknown", interactionsComplete: false, interactions: [], issue: this.#state.stopRequested ? "stopUnconfirmed" : "ownershipUnconfirmed" });
    const run = this.#runRef(); if (!run) {
      this.#publish({ issue: "startUnconfirmed" }); const capsule = this.#openingCapsule;
      if (capsule && this.#port.inspectOpening) {
        const actual = this.#port.inspectOpening(copy(capsule)).then(async found => {
          if (this.#closed || this.#state.generation !== capsule.opening.generation || !found) return;
          if ("state" in found) await this.#stoppedOpening(openingProof(capsule, found));
          else this.#installOpening(found, capsule);
        }).catch(() => { if (!this.#closed) this.#publish({ issue: "ownershipUnconfirmed" }); });
        this.#own(actual, capsule.opening.generation); let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([actual, new Promise<void>(resolve => { timer = setTimeout(resolve, this.#observationMs); })]); if (timer) clearTimeout(timer);
      }
      return;
    }
    // Inspection obtains no new native execution and never replays an unfinished Stop.
    this.#capturingInitial = true;
    const inspect = (async () => {
      const capsule = this.#openingCapsule;
      if (capsule?.opening.generation === run.generation && this.#port.inspectOpening) {
        const opening = await this.#port.inspectOpening(copy(capsule));
        if (this.#closed || !this.#current(run)) return null;
        if (opening && "state" in opening) { await this.#stoppedOpening(openingProof(capsule, opening)); return null; }
        if (opening) this.#installOpening(opening, capsule);
      }
      if (this.#state.phase === "stopped") return null;
      return this.#port.inspect(copy(run), event => this.#event(event));
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const actual = inspect.then(async found => {
      if (this.#closed || !this.#current(run)) return;
      if (!found) return;
      if ("state" in found) await this.#stopped(validateStopProof(run, copy(found)));
      else await this.#install(found, run);
    }).catch(() => { if (!this.#closed) this.#publish({ issue: "ownershipUnconfirmed" }); });
    this.#own(actual, run.generation);
    await Promise.race([actual, new Promise<void>(resolve => { timer = setTimeout(resolve, this.#observationMs); })]);
    if (timer) clearTimeout(timer);
  }
  #own<T>(work: Promise<T>, generation = this.#state.generation, stop = false): Promise<T> { this.#actual.add(work); this.#actualOwners.set(work, { generation, stop }); void work.finally(() => { this.#actual.delete(work); this.#actualOwners.delete(work); }).catch(() => {}); return work; }
  submit(value: Submit): Promise<Receipt> {
    const request = copy(value); this.#check(request.scope); id(request.id); canonical(request);
    if (Object.keys(request).some(key => !["scope", "id", "generation", "command"].includes(key)) || Object.keys(request.scope).some(key => !["connection", "principal", "host", "session"].includes(key))) throw new SessionError("INVALID");
    const command = this.#port.protocol.command(request.command); const fixed = copy({ ...request, command });
    if (!Number.isSafeInteger(fixed.generation) || fixed.generation < 0) throw new SessionError("INVALID");
    const hash = createHash("sha256").update(canonical(fixed)).digest("hex"), existing = this.#requests.get(fixed.id);
    if (existing) { if (existing.hash !== hash) return Promise.reject(new SessionError("CONFLICT")); return existing.promise; }
    if (this.#requests.size >= this.#limits.maxPending - (command.type === "stop" ? 0 : 1)) return Promise.reject(new SessionError("BUSY"));
    const dependent = !this.#port.protocol.urgent(command.type), owner = { id: fixed.id, generation: fixed.generation, type: command.type };
    const busy = dependent && !!this.#normal;
    if (dependent && !busy) this.#normal = owner;
    if (!busy && !this.#state.archive && (command.type === "create" || command.type === "resume") && this.#state.phase === "stopped" && fixed.generation === this.#state.generation) this.#attempt = { base: fixed.generation, invoked: false };
    if (command.type === "stop" && (fixed.generation === this.#state.generation || fixed.generation === this.#attempt?.base)) this.#stopFence = true;
    const attempt = this.#attempt;
    const admission = deferred();
    const actual = this.#own(this.#submit(fixed, hash, busy, admission.resolve, () => {
      // A completed validated native sequence releases ordinary admission;
      // its receipt IO remains independently owned. Native opening uses the
      // committed-before-Running boundary. An older original cannot release
      // a replacement owner or its still-pending native sequence.
      if (this.#normal === owner) this.#normal = undefined;
    }), (command.type === "create" || command.type === "resume") ? fixed.generation + 1 : fixed.generation, command.type === "stop");
    if ((command.type === "create" || command.type === "resume") && !busy && attempt) attempt.completion = actual;
    const retired = retirement(), observed = this.#observe(actual, fixed, admission.promise, retired.promise);
    this.#requests.set(fixed.id, { hash, promise: observed, actual, request: fixed, retire: retired.resolve });
    void actual.finally(() => { this.#requests.delete(fixed.id); if (this.#normal === owner) this.#normal = undefined; }).catch(() => {});
    return observed;
  }
  async #observe(actual: Promise<Receipt>, request: Submit, admission: Promise<void>, retired: Promise<Receipt>): Promise<Receipt> {
    let settled = false;
    const completion = Promise.race([actual, retired]);
    await Promise.race([admission, completion.then(() => { settled = true; }, () => { settled = true; })]);
    if (settled) return completion;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([completion, new Promise<Receipt>((resolve, reject) => { timer = setTimeout(() => {
      if (!this.#closed && this.#state.phase !== "stopped" && !this.#retired.has(request.id)) {
        if (request.command.type === "stop" && request.generation === this.#state.generation && this.#state.phase === "stopping") this.#publish({ issue: "stopUnconfirmed" });
        else if ((request.command.type === "create" || request.command.type === "resume") && request.generation + 1 === this.#state.generation && this.#state.phase === "starting") this.#publish({ issue: "startUnconfirmed" });
      }
      void (async () => {
        const observed = await this.receipt(this.#scope, request.id);
        if (!observed) throw new SessionError("IO");
        // A caller deadline is not evidence that native dispatch occurred.
        // Retain known admission while preparation/preflight still owns work;
        // only an actual dispatched original can become outcomeUnknown.
        return observed.state === "dispatched" ? this.#transition(request, "outcomeUnknown", undefined, "observationExpired") : observed;
      })().then(resolve, reject);
    }, this.#observationMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async #transition(request: Submit, state: Receipt["state"], outcome?: NativeOutcome, reason?: string, snapshot?: SessionSnapshot): Promise<Receipt> {
    const retired = this.#retired.get(request.id); if (retired) return copy(retired);
    return this.#writeReceipt(request, state, outcome, reason, snapshot);
  }
  async #writeReceipt(request: Submit, state: Receipt["state"], outcome?: NativeOutcome, reason?: string, snapshot?: SessionSnapshot): Promise<Receipt> {
    if (this.#closed) return copy(this.#retired.get(request.id) ?? { scope: this.#scope, id: request.id, type: request.command.type, generation: request.generation, state: "outcomeUnknown", reason: "hostClosed" });
    const safeOutcome = outcome && request.command.type === "answer" ? { status: outcome.status } : outcome;
    const receipt: Receipt = { scope: this.#scope, id: request.id, type: request.command.type, generation: request.generation, state, ...(safeOutcome ? { outcome: safeOutcome } : {}), ...(reason ? { reason } : {}) };
    const committed = await this.#journal.call<Receipt>("transition", { receipt: copy(receipt), ...(snapshot ? { snapshot: copy(snapshot) } : {}) });
    return this.#committedReceipt(committed);
  }
  async #controlResult(request: Submit, outcome: NativeOutcome): Promise<Receipt> {
    // This exact invocation's response can settle only its own receipt, never a current run or selection.
    if (this.#closed) return this.#writeReceipt(request, "outcomeUnknown");
    const existing = this.#arrivedResults.get(request.id); if (existing) return existing.promise;
    // Every result has one already-admitted original; this bound cannot exceed the durable operation cap.
    if (this.#arrivedResults.size >= this.#limits.maxOperations) throw new SessionError("FULL");
    const receipt: Receipt = copy({ scope: this.#scope, id: request.id, type: request.command.type, generation: request.generation, state: outcome.status === "refused" || outcome.status === "targetUnavailable" ? "refused" : "acknowledged", outcome: request.command.type === "answer" ? { status: outcome.status } : outcome });
    const pending = this.#resultTail.then(async () => {
      if (this.#closed) return this.#writeReceipt(request, "outcomeUnknown");
      const saved = await this.#journal.callWhenAvailable<Receipt>("transition", { receipt });
      if (this.#retired.has(request.id)) this.#retired.set(request.id, saved);
      this.#arrivedResults.delete(request.id); return this.#committedReceipt(saved);
    });
    this.#arrivedResults.set(request.id, { receipt, promise: pending });
    // Actual IO failure retains its bounded proof in RAM and prevents close; no implicit repair/reopen.
    this.#resultTail = pending.then(() => {}, () => { if (!this.#closed) this.#publish({ issue: "storageUnavailable" }); });
    return pending;
  }
  async #submit(request: Submit, hash: string, busy: boolean, admitted: () => void, releaseAdmission: () => void): Promise<Receipt> {
    const command = request.command;
    const payload = command.type === "answer" ? { ...request, command: { type: "answer", interactionId: command.interactionId, choice: command.choice, privateAnswer: command.value !== undefined } } : request;
    const admission = await this.#journal.call<Admission>("admit", { hash, payload, receipt: { scope: this.#scope, id: request.id, type: command.type, generation: request.generation, state: "admitted" } });
    if (admission.fresh) this.#committedReceipt(admission.receipt);
    admitted();
    if (!admission.fresh) return admission.receipt;
    const refuse = (reason: string) => this.#transition(request, "refused", failure(reason), reason);
    if (request.generation !== this.#state.generation && !(command.type === "stop" && request.generation === this.#attempt?.base)) return refuse("staleGeneration");
    if (busy) return refuse("busy");
    if (this.#state.archive) return refuse("archived");
    let invoked = false, prepared: PreparedSend | undefined;
    try {
      if (command.type === "archive") {
        const quiescent = () => this.#state.phase === "stopped" && !this.#run && !this.#opening && !this.#attempt && !this.#start && !this.#stop && !this.#finalization && !this.#reads.size && !this.#arrivedResults.size && this.#requests.size <= 1 && this.#actual.size <= 1;
        if (!this.#archive) return refuse("archiveUnsupported");
        if (!quiescent()) return refuse("archiveBusy");
        const reader = await this.readers.read();
        if (reader.state !== "none" && reader.state !== "owned") return refuse("readerCustodyUnconfirmed");
        if (!await this.#archive.ready() || !quiescent()) return refuse("archiveBusy");
        // Keep conservative custody even if the seal commit's acknowledgement
        // is lost. No cleanup starts until the same seal is durably returned.
        invoked = true; this.#publish({ archive: { id: request.id, state: "pending" } });
        await this.#save({ archive: { id: request.id, state: "pending" } }, request);
        await this.#archive.release();
        if ((await this.readers.read()).state !== "none") throw new SessionError("BUSY", "Reader custody remains unconfirmed");
        const archive = { id: request.id, state: "complete" as const };
        const receipt = await this.#transition(request, "acknowledged", { status: "acknowledged" }, undefined, { ...this.#state, revision: this.#revision + 1, archive });
        this.#publish({ archive }); return receipt;
      }
      if (command.type === "create" || command.type === "resume") {
        if (this.#state.phase !== "stopped" || command.type === "create" && this.#state.nativeSession !== null || command.type === "resume" && this.#state.nativeSession === null) return refuse("notStopped");
        if (!supportsNativeOpening(this.#port.capabilities, this.#state.nativeSession)) return refuse("unsupportedLifetime");
        if (command.type === "create" && this.#openingCapsule?.opening.generation === this.#state.generation && this.#state.nativeSession === null) return refuse("originalCreationUnresolved");
        if (this.#stopFence) return refuse("retiredBeforeStart");
        const generation = this.#state.generation + 1, oldNative = this.#state.nativeSession,
          selection = command.type === "create" ? command.selection : this.#state.selection;
        this.#haltFor(generation);
        this.#nativeReadyFor(generation);
        const next = copy({ ...this.#state, generation, phase: "starting" as const, activity: "unknown" as const, stopRequested: false, interactions: [], interactionsComplete: false, selection: { kind: this.#port.kind } as Selection });
        await this.#stampParent();
        await this.#save(next, request);
        if (this.#closed || this.#stopFence || this.#state.stopRequested || this.#state.generation !== generation) return refuse("retiredBeforeStart");
        this.#early = []; this.#earlyBytes = 0; this.#capturingInitial = true; this.#baselineLost = false;
        const work = Promise.resolve().then(async () => {
          if (this.#closed || this.#stopFence || this.#state.stopRequested || this.#state.generation !== generation) throw new SessionError("FENCED");
          if (this.#attempt) this.#attempt.invoked = true;
          invoked = true;
          const expected = (native: NativeRun): RunRef => ({ scope: this.#scope, generation, nativeSession: command.type === "resume" ? oldNative! : native.run.nativeSession });
          const native = await this.#port.start(copy({ scope: this.#scope, generation, placement: this.#port.placement, operationId: request.id, nativeSession: command.type === "resume" ? oldNative : null, ...(selection ? { selection } : {}), policy: this.#policy }), event => this.#event(event), async owned => { await this.#install(owned, expected(owned), true); }, async owner => {
            const capsule = openingCapsule({ opening: owner.opening, identity: owner.identity });
            if (capsule.opening.operationId !== request.id || capsule.opening.generation !== generation || scopeKey(capsule.opening.scope) !== scopeKey(this.#scope) || capsule.identity.placement !== this.#port.placement || this.#closed || this.#state.generation !== generation || this.#state.phase === "stopped") throw new SessionError("FENCED");
            await this.#journal.call("opening.save", { capsule });
            this.#installOpening(owner, capsule);
          });
          await this.#install(native, { scope: this.#scope, generation, nativeSession: command.type === "resume" ? oldNative! : native.run.nativeSession }, false, releaseAdmission);
        });
        this.#start = this.#own(work, generation);
        try { await work; return await this.#transition(request, "acknowledged", { status: "acknowledged" }); }
        finally { if (this.#start === work) this.#start = undefined; }
      }
      if (command.type === "stop") {
        if (this.#state.phase === "stopped" && !this.#attempt) { this.#stopFence = false; return this.#transition(request, "acknowledged", { status: "acknowledged" }); }
        if (this.#port.capabilities.fullStop !== true) return refuse("unsupportedLifetime");
        if (this.#finalization?.generation === this.#state.generation) { await this.#finalization.promise; return this.#transition(request, "acknowledged", { status: "acknowledged" }); }
        await this.#save({ phase: "stopping", stopRequested: true, issue: "stopUnconfirmed" }, request);
        if (this.#state.phase === "stopped") return this.#transition(request, "acknowledged", { status: "acknowledged" });
        if (this.#finalization?.generation === this.#state.generation) { await this.#finalization.promise; return this.#transition(request, "acknowledged", { status: "acknowledged" }); }
        if (!this.#stop) this.#stop = this.#own((async () => {
          const attempt = this.#attempt;
          const halt = this.#haltFor(this.#state.generation);
          await Promise.race([this.#nativeReadyFor(this.#state.generation), Promise.resolve(attempt?.completion).then(() => this.#start).catch(() => {}), halt]);
          if (this.#state.phase === "stopped") return undefined;
          const native = this.#run;
          if (!native && attempt && !attempt.invoked) {
            await this.#save({ phase: "stopped", activity: "idle", stopRequested: false, interactions: [], interactionsComplete: false, issue: undefined } as unknown as Partial<SessionSnapshot>);
            this.#attempt = undefined; this.#stopFence = false; return undefined;
          }
          if (!native && this.#opening) {
            const opening = this.#opening, capsule = this.#openingCapsule!;
            const proof = openingProof(capsule, await opening.stop()); await this.#stoppedOpening(proof); return proof;
          }
          if (!native || !this.#current(native.run)) throw new SessionError("FENCED");
          const proof = await Promise.race([native.stop().then(value => validateStopProof(native.run, copy(value))), halt.then(() => undefined)]);
          if (proof) await this.#stopped(proof); return proof;
        })(), this.#state.generation, true);
        const stopping = this.#stop;
        try { await stopping; return this.#transition(request, "acknowledged", { status: "acknowledged" }); }
        catch (error) { if (this.#stop === stopping) this.#stop = undefined; throw error; }
      }
      if (!this.#port.capabilities.commands.includes(command.type)) return refuse("unsupportedCommand");
      if (this.#stopFence || this.#state.phase !== "running" && !(command.type === "answer" && this.#state.phase === "starting") || this.#state.stopRequested || !this.#run) return refuse("notRunning");
      if (this.#port.protocol.settings(command.type) && !this.#state.interactionsComplete) return refuse("interactionsUnknown");
      const continuing = command.type === "codex.continue" || command.type === "copilot.continue";
      if (continuing && !this.#canContinue()) return refuse("nativeWorkPending");
      const native = this.#run;
      if (command.type === "answer") {
        const interaction = this.#state.interactions.find(item => item.id === command.interactionId);
        if (!interaction || !interaction.choices.includes(command.choice)) return refuse("staleInteraction");
      }
      const steps = this.#port.protocol.controlSteps(command, this.#state.selection, this.#port.capabilities);
      if (steps) { for (const step of steps) await this.#preflight(step); }
      else await this.#preflight(command);
      let invocation: NativeControlCommand = this.#port.protocol.prepare(command, request.id);
      if (isMessageCommand(command) && command.inputs) {
        if (!this.#port.prepareSend) return refuse("inputsUnsupported");
        const current = (): void => {
          if (this.#closed || this.#stopFence || this.#state.stopRequested || this.#state.phase !== "running" || !this.#current(native.run) || request.generation !== this.#state.generation || !this.#state.interactionsComplete) throw new SessionError("FENCED");
        };
        current(); prepared = await this.#port.prepareSend(request as SendSubmit, native.run, current); current();
        invocation = this.#port.protocol.nativeCommand({ ...prepared.command, ...("clientUserMessageId" in invocation ? { clientUserMessageId: invocation.clientUserMessageId } : {}) });
        if (invocation.type !== command.type || !("nativeInputs" in invocation) || invocation.text !== command.text || canonical("selection" in invocation ? invocation.selection : null) !== canonical("selection" in command ? command.selection : null) || (command.type === "codex.steer" && (invocation.type !== "codex.steer" || invocation.expectedTurnId !== command.expectedTurnId)) || invocation.nativeInputs.items.length !== command.inputs.items.length) throw new SessionError("FENCED");
      }
      await this.#transition(request, "dispatched");
      if (this.#closed || this.#stopFence || this.#state.stopRequested || this.#state.phase !== "running" && !(command.type === "answer" && this.#state.phase === "starting") || !this.#current(native.run) || request.generation !== this.#state.generation) return refuse("retiredBeforeDispatch");
      if (this.#port.protocol.settings(command.type) && !this.#state.interactionsComplete) return refuse("interactionsUnknown");
      if (command.type === "answer" && !this.#state.interactions.some(item => item.id === command.interactionId && item.choices.includes(command.choice))) return refuse("staleInteraction");
      if (continuing && !this.#canContinue()) return refuse("nativeWorkPending");
      invoked = true;
      const completed = steps ? await this.#controlSequence(native, request, steps, invocation as Extract<NativeControlCommand, { type: "send" }>) : { outcome: validateOutcome(copy(await native.invoke(invocation))), nativeResult: true };
      const result = completed.outcome;
      canonical(result, 8192);
      if (prepared) {
        const buffers = prepared; prepared = undefined; invocation = command;
        try { await buffers.release(); } catch { /* Exact receipt remains authoritative; failed file cleanup blocks future preparation. */ }
      }
      // All native work for this control sequence has returned and validated.
      // Harness-ordered settings retain admission through every ordered settings
      // substep and the final bare Send. Receipt storage/notification may lag,
      // but cannot make a new intentional command spuriously busy.
      releaseAdmission();
      return completed.nativeResult ? this.#controlResult(request, result) : this.#transition(request, result.status === "refused" || result.status === "targetUnavailable" ? "refused" : "acknowledged", result);
    } catch { return invoked || command.type === "stop" ? this.#transition(request, "outcomeUnknown", undefined, command.type === "archive" ? "archiveUnconfirmed" : "nativeOutcomeUnknown") : refuse("notDispatched"); }
    finally {
      // The original actual promise owns buffers even after its observer timed
      // out. Cleanup failures remain protected and block future file preparation.
      if (prepared) try { await prepared.release(); } catch { /* File owner retains the failed cleanup obligation. */ }
    }
  }
  async #controlSequence(native: NativeRun, request: Submit, steps: readonly ControlCommand[], command: Extract<NativeControlCommand, { type: "send" }>): Promise<{ outcome: NativeOutcome; nativeResult: boolean }> {
    const completed: string[] = [];
    const current = (): boolean => !this.#closed && !this.#stopFence && !this.#state.stopRequested && this.#state.phase === "running" && this.#current(native.run) && request.generation === this.#state.generation && this.#state.interactionsComplete;
    for (const step of steps) {
      if (!current()) return { outcome: { status: "deferred", detail: { sendDispatched: false, completedSubsteps: completed, reason: "retiredBeforeSend" } }, nativeResult: false };
      const result = validateOutcome(copy(await native.invoke(step))); canonical(result, 7168);
      if (result.status !== "applied") return { outcome: { ...result, detail: { native: result.detail ?? null, sendDispatched: false, completedSubsteps: completed } }, nativeResult: true };
      completed.push(step.type);
    }
    if (!current()) return { outcome: { status: "deferred", detail: { sendDispatched: false, completedSubsteps: completed, reason: "retiredBeforeSend" } }, nativeResult: false };
    const send = "nativeInputs" in command ? { type: "send" as const, text: command.text, nativeInputs: command.nativeInputs } : { type: "send" as const, text: command.text };
    return { outcome: validateOutcome(copy(await native.invoke(send))), nativeResult: true };
  }
  async #preflight(command: ControlCommand): Promise<void> {
    await this.#port.protocol.preflight(command, this.#state.selection, this.#port.catalog, () => this.#state.selection);
  }
  async #install(value: NativeRun, expected: RunRef, opening = false, openingReady?: () => void): Promise<void> {
    const run = validateRun(copy(value.run));
    if (this.#closed || this.#state.phase === "stopped" || this.#finalization?.generation === run.generation || !sameRun(run, expected) || scopeKey(run.scope) !== scopeKey(this.#scope) || run.generation !== this.#state.generation || typeof value.stop !== "function" || typeof value.invoke !== "function") throw new SessionError("FENCED");
    const selection = this.#port.protocol.selection(copy(value.selection));
    const interaction = this.#port.protocol.event({ run, type: "interactions", complete: value.interactionsComplete, items: copy(value.interactions) });
    if (interaction.type !== "interactions") throw new SessionError("INVALID");
    if (value.initializationComplete !== undefined && typeof value.initializationComplete !== "boolean") throw new SessionError("INVALID");
    const installed = Object.freeze({ run, selection, ...(value.initializationComplete === undefined ? {} : { initializationComplete: value.initializationComplete }), interactions: interaction.items, interactionsComplete: interaction.complete, stop: value.stop.bind(value), invoke: value.invoke.bind(value) });
    this.#run = installed;
    await this.#save({ nativeSession: run.nativeSession, phase: this.#state.stopRequested || this.#stopFence ? "stopping" : opening || value.initializationComplete === false ? "starting" : "running", selection, interactionsComplete: interaction.complete && !this.#baselineLost, interactions: interaction.items, ...(!this.#state.stopRequested && !this.#stopFence ? { issue: undefined } : {}) } as unknown as Partial<SessionSnapshot>, undefined, () => {
      // The first Create may not use onOwned, so its native ID is part of the
      // committed next state rather than the already published snapshot.
      if (!this.#closed && !opening && value.initializationComplete !== false && !this.#state.stopRequested && !this.#stopFence && this.#state.generation === run.generation && this.#run === installed) openingReady?.();
    });
    this.#nativeReadyFor(run.generation); this.#nativeReady!.resolve();
    // Early custody does not finish startup. Native applied-settings events
    // can follow their ACK while the final installation is still persisting;
    // retain them until that older opening snapshot can no longer overwrite
    // their observation. Stop evidence remains handled before this buffer.
    if (!opening && value.initializationComplete !== false) {
      this.#capturingInitial = false;
      for (const event of this.#early) this.#event(event);
      this.#early = []; this.#earlyBytes = 0;
    }
  }
  #event(value: NativeEvent): void {
    if (this.#closed || this.#state.archive) return;
    let event: NativeEvent;
    try { event = this.#port.protocol.event(copy(value)); canonical(event); } catch { this.#publish({ interactionsComplete: false, issue: "ownershipUnconfirmed" }); return; }
    if (scopeKey(event.run.scope) !== scopeKey(this.#scope) || event.run.generation !== this.#state.generation) return;
    if (event.type === "stopped" && this.#state.phase !== "stopped" && (!this.#state.nativeSession || this.#current(event.run))) {
      const work = (async () => { if (!this.#state.nativeSession) await this.#save({ nativeSession: event.run.nativeSession }); await this.#stopped(event.proof); })().catch(() => this.#publish({ issue: "storageUnavailable" })); this.#own(work, event.run.generation, true); return;
    }
    if (this.#capturingInitial || !this.#state.nativeSession && this.#state.phase !== "stopped") {
      const size = Buffer.byteLength(canonical(event));
      if (this.#early.length >= this.#limits.maxEvents || this.#earlyBytes + size > 256 * 1024) { this.#baselineLost = true; this.#publish({ interactionsComplete: false, issue: "ownershipUnconfirmed" }); return; }
      this.#early.push(event); this.#earlyBytes += size; return;
    }
    if (!this.#current(event.run) || this.#state.phase === "stopped") return;
    if (event.type === "selection") this.#publish({ selection: event.selection });
    else if (event.type === "copilot.usage") {
      const observedAt = new Date().toISOString();
      const work = this.#save(() => {
        // Recheck in the serialized writer: several native checkpoints may
        // arrive before the first SQLite commit or after a replacement starts.
        if (!this.#current(event.run) || this.#state.archive) return null;
        const prior = this.#state.usage;
        if (prior && (event.totalNanoAiu < prior.totalNanoAiu || Date.parse(event.reportedAt) < Date.parse(prior.reportedAt) || event.totalNanoAiu === prior.totalNanoAiu && event.reportedAt === prior.reportedAt)) return null;
        return { usage: { nativeSession: event.run.nativeSession, totalNanoAiu: event.totalNanoAiu, reportedAt: event.reportedAt, observedAt } };
      }).catch(() => this.#publish({ issue: "storageUnavailable" }));
      this.#own(work, event.run.generation);
    }
    else if (event.type === "attention") {
      const work = this.#save(() => {
        // This is the existing serialized writer's committed revision, not a
        // counter driven by settings, tokens, observer mounts or reconnects.
        if (!this.#current(event.run) || this.#closed || this.#state.archive || this.#state.phase === "stopped") return null;
        const prior = this.#state.attention;
        if (prior?.generation === event.run.generation && sameAttention(prior, event.attention)) return null;
        return { attention: { ...event.attention, nativeSession: event.run.nativeSession, generation: event.run.generation, epoch: this.#state.epoch, revision: this.#revision + 1 } };
      }).catch(() => this.#publish({ issue: "storageUnavailable" }));
      this.#own(work, event.run.generation);
    }
    else if (event.type === "activity") this.#publish({ activity: event.activity });
    else if (event.type === "controlLost") this.#publish({ activity: "unknown", interactionsComplete: false, issue: "ownershipUnconfirmed" });
    else if (event.type === "nativeState") this.#publish({});
    else if (event.type === "interactions") this.#publish({ interactionsComplete: event.complete && !this.#baselineLost, interactions: event.items });
    else { const work = this.#stopped(event.proof).catch(() => this.#publish({ issue: "storageUnavailable" })); this.#own(work, event.run.generation, true); }
  }
  #installOpening(owner: NativeOpening, expected: OpeningCapsule): void {
    const capsule = openingCapsule({ opening: owner.opening, identity: owner.identity });
    if (this.#closed || !sameOpening(capsule, expected) || capsule.opening.generation !== this.#state.generation || this.#state.phase === "stopped" || this.#finalization?.generation === capsule.opening.generation || typeof owner.stop !== "function") throw new SessionError("FENCED");
    this.#openingCapsule = capsule; this.#opening = { ...capsule, stop: owner.stop.bind(owner) };
    this.#nativeReadyFor(capsule.opening.generation); this.#nativeReady!.resolve();
  }
  #stoppedOpening(proof: OpeningStopProof): Promise<void> {
    const capsule = this.#openingCapsule;
    if (!capsule) return Promise.reject(new SessionError("FENCED")); openingProof(capsule, proof);
    return this.#finalizeStopped(capsule.opening.generation, () => !!this.#openingCapsule && sameOpening(capsule, this.#openingCapsule));
  }
  #stopped(proof: StopProof): Promise<void> {
    validateStopProof(proof.run, proof);
    return this.#finalizeStopped(proof.run.generation, () => this.#current(proof.run));
  }
  #finalizeStopped(generation: number, current: () => boolean): Promise<void> {
    if (this.#finalization?.generation === generation) return this.#finalization.promise;
    if (this.#state.generation !== generation || !current()) return Promise.reject(new SessionError("FENCED"));
    this.#stopFence = true;
    const halt = this.#halt;
    // One finalizer per generation. Never expose Stopped before old asynchronous cleanup is finished.
    const pending = Promise.resolve().then(async () => {
      this.#publish({ phase: "stopping", stopRequested: true, issue: undefined } as unknown as Partial<SessionSnapshot>);
      // Exact nativeTree release can retire orphan JS waits; their unknown receipts remain durable.
      for (const [operationId, work] of this.#requests) {
        if (work.request.command.type === "stop") continue;
        const workGeneration = ["create", "resume"].includes(work.request.command.type) ? work.request.generation + 1 : work.request.generation;
        if (workGeneration !== generation) continue;
        const original = work.request.command.type === "send" ? await this.receipt(this.#scope, operationId) : null;
        const notDispatched = original?.state === "admitted";
        const receipt = await this.#transition(work.request, notDispatched ? "refused" : "outcomeUnknown", notDispatched ? failure("retiredBeforeDispatch") : undefined, notDispatched ? "retiredBeforeDispatch" : "executionStopped"); this.#retired.set(operationId, receipt); work.retire(receipt); this.#requests.delete(operationId); this.#actual.delete(work.actual); this.#actualOwners.delete(work.actual);
      }
      if (this.#state.generation !== generation || !current()) throw new SessionError("FENCED");
      await this.#save({ phase: "stopped", activity: "idle", stopRequested: false, interactions: [], interactionsComplete: false, issue: undefined } as unknown as Partial<SessionSnapshot>, undefined, () => {
        for (const [work, owner] of this.#actualOwners) if (!owner.stop && owner.generation === generation) { this.#actual.delete(work); this.#actualOwners.delete(work); }
        this.#run = undefined; this.#opening = undefined; this.#normal = undefined; this.#start = undefined; this.#stop = undefined; this.#attempt = undefined; this.#stopFence = false;
        if (halt?.generation === generation) halt.resolve();
      });
    });
    this.#finalization = { generation, promise: pending };
    void pending.finally(() => { if (this.#finalization?.promise === pending) this.#finalization = undefined; }).catch(() => {});
    return pending;
  }
  /** Activation changes require actual quiescence, not a renderer's phase. Old
   * uncertain receipts may remain, but no opening/runtime/result IO may remain. */
  updateReadiness(): Readonly<{ ready: boolean; reasons: readonly string[] }> {
    if (this.#closed) return { ready: false, reasons: ["closed"] };
    const reasons: string[] = [];
    if (this.#state.phase !== "stopped" || this.#run || this.#opening || this.#attempt) reasons.push("native-ownership-unsettled");
    if (this.#actual.size || this.#requests.size || this.#reads.size || this.#arrivedResults.size || this.#finalization || this.#start || this.#stop) reasons.push("admitted-work-unsettled");
    if (this.#journal.pending) reasons.push("journal-io-unsettled");
    return { ready: reasons.length === 0, reasons };
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#state.phase !== "stopped" || this.#run || this.#actual.size || this.#requests.size || this.#arrivedResults.size) throw new SessionError("BUSY", "Stop and settle actual native ownership and arrived receipts before closing");
    this.#closed = true; this.#listeners.clear(); this.#receiptListeners.clear(); await this.#journal.close();
  }
  /** Qualification abrupt journal-worker termination. Does not claim native release. */
  async terminate(): Promise<void> { this.#closed = true; this.#listeners.clear(); this.#receiptListeners.clear(); await this.#journal.terminate(); }
}
