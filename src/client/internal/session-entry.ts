import {
  applyFrame,
  historyScopeKey,
  mergeHistoryOrder,
  type Frame,
  type HistoryScope,
  type ReadObservation,
  type Row,
} from "../../history/index.js";
import type { InteractionSnapshot } from "../../interactions/contracts.js";
import { scopeKey, type Receipt, type RunRef, type SessionScope } from "../../protocol/index.js";
import type {
  ClientLimits,
  ClientOriginal,
  ClientPersistence,
  Command,
  ConfirmedDraftAttachment,
  DraftAttachmentLimits,
  EntrySnapshot,
  ObservationConnector,
  OriginalHandle,
  PersistedEntry,
  SessionFeed,
  SessionState,
} from "../contracts.js";
import {
  byteLength,
  check,
  ClientError,
  draftAttachments,
  id,
  immutable,
  json,
  receiptFor,
  runKey,
  sameScope,
} from "./validation.js";

type Job = {
  view: ClientOriginal;
  meaning: string;
  admission: Promise<OriginalHandle>;
  settled: Promise<ClientOriginal>;
  resolve(value: ClientOriginal): void;
  handle: OriginalHandle;
  active: boolean;
};
type Watch = { token: object; release?: () => void | Promise<void> };
type RetainedRow = { row: Row; scope: HistoryScope; generation: number };
type EntryOptions = Readonly<{
  scope: SessionScope;
  feed: SessionFeed;
  observations: ObservationConnector;
  persistence: ClientPersistence;
  limits: ClientLimits;
  attachmentLimits?: Partial<DraftAttachmentLimits>;
  reserveView(): void;
}>;

/** The single retained conversation owner. React views, transport routes and
 * native lifetimes are not additional copies of this state. */
export class SessionEntry {
  readonly owner = Object.freeze({}) as import("../contracts.js").SessionOwnerIdentity;
  readonly scope: SessionScope;
  readonly attachmentLimits: DraftAttachmentLimits;
  readonly #options: EntryOptions;
  #snapshot: EntrySnapshot;
  #jobs = new Map<string, Job>();
  #rows = new Map<string, RetainedRow>();
  #order: string[] = [];
  #views = new Set<object>();
  #listeners = new Set<() => void>();
  #cleanup = new Set<Promise<void>>();
  #stateWatch: Watch | undefined;
  #historyWatch: Watch | undefined;
  #interactionWatch: Watch | undefined;
  #observedRun: string | undefined;
  #closed = false;
  #writes = 0;
  #draftIntent = 0;
  #saveTail: Promise<void> = Promise.resolve();
  #read: { key: string; work: Promise<ReadObservation>; active: boolean } | undefined;
  #preparations = 0;
  #preparationBytes = 0;
  constructor(options: EntryOptions, stored?: PersistedEntry) {
    scopeKey(options.scope);
    this.scope = immutable(options.scope);
    this.#options = options;
    this.attachmentLimits = Object.freeze({
      maxFiles: 8,
      maxBytes: 33554432,
      ...options.attachmentLimits,
    });
    check(
      Number.isSafeInteger(this.attachmentLimits.maxFiles) &&
        this.attachmentLimits.maxFiles > 0 &&
        this.attachmentLimits.maxFiles <= 8 &&
        Number.isSafeInteger(this.attachmentLimits.maxBytes) &&
        this.attachmentLimits.maxBytes > 0 &&
        this.attachmentLimits.maxBytes <= 33554432,
    );
    const attachments = draftAttachments(
      stored?.attachments === undefined ? [] : stored.attachments,
      this.scope,
      this.attachmentLimits,
    );
    this.#snapshot = immutable({
      scope: this.scope,
      revision: 0,
      draft: stored?.draft ?? "",
      attachments,
      pinned: stored?.pinned ?? false,
      state: null,
      freshness: "unobserved",
      history: { current: null, rows: [], origins: {}, residencyOmitted: false },
      historyFreshness: "unobserved",
      interactions: null,
      interactionsFreshness: "unobserved",
      originals: [],
      persistenceIssue: false,
      historyRead: null,
    });
    if (stored) this.#restore(stored);
  }
  getSnapshot = (): EntrySnapshot => this.#snapshot;
  getDraft = (): import("../contracts.js").DraftSnapshot =>
    Object.freeze({
      text: this.#snapshot.draft,
      attachments: this.#snapshot.attachments,
      archived: this.#snapshot.state?.phase === "archived",
    });
  subscribe = (listener: () => void): (() => void) => {
    check(this.#listeners.size < this.#options.limits.maxListeners, "FULL");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  get viewCount(): number {
    return this.#views.size;
  }
  get evictable(): boolean {
    return (
      !this.#snapshot.pinned &&
      !this.#snapshot.draft &&
      !this.#snapshot.attachments.length &&
      !this.#preparations &&
      !this.#views.size &&
      !this.#writes &&
      !this.#cleanup.size &&
      !this.#read?.active &&
      [...this.#jobs.values()].every((job) => !job.active && this.#terminal(job.view))
    );
  }
  get actualWork(): number {
    return (
      this.#preparations +
      this.#cleanup.size +
      this.#writes +
      Number(!!this.#read?.active) +
      [...this.#jobs.values()].filter((job) => job.active).length
    );
  }
  acquireView(): () => void {
    this.#active();
    this.#options.reserveView();
    const token = {};
    this.#views.add(token);
    this.#ensureObservations();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#views.delete(token);
      this.#ensureObservations();
    };
  }
  startPinned(): void {
    this.#ensureObservations();
  }
  async setDraft(draft: string): Promise<void> {
    this.#active();
    check(
      typeof draft === "string" && byteLength(draft) <= this.#options.limits.maxDraftBytes,
      "FULL",
    );
    this.#draftIntent++;
    this.#publish({ draft });
    await this.#persist();
  }
  async setAttachments(files: readonly ConfirmedDraftAttachment[]): Promise<void> {
    this.#active();
    const attachments = draftAttachments(files, this.scope, this.attachmentLimits);
    check(
      attachments.length + this.#preparations <= this.attachmentLimits.maxFiles &&
        attachments.reduce((sum, file) => sum + file.bytes, 0) + this.#preparationBytes <=
          this.attachmentLimits.maxBytes,
      "FULL",
    );
    this.#draftIntent++;
    this.#publish({ attachments });
    await this.#persist();
  }
  /** Actual upload/preparation custody only; it opens no observation or pin. */
  holdDraftPreparation(bytes: number): () => void {
    this.#active();
    check(Number.isSafeInteger(bytes) && bytes >= 0);
    check(
      this.#snapshot.attachments.length + this.#preparations < this.attachmentLimits.maxFiles &&
        this.#snapshot.attachments.reduce((sum, file) => sum + file.bytes, 0) +
          this.#preparationBytes +
          bytes <=
          this.attachmentLimits.maxBytes,
      "FULL",
    );
    this.#preparations++;
    this.#preparationBytes += bytes;
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.#preparations--;
        this.#preparationBytes -= bytes;
      }
    };
  }
  async pin(pinned: boolean): Promise<void> {
    this.#active();
    check(typeof pinned === "boolean");
    this.#publish({ pinned });
    this.#ensureObservations();
    await this.#persist();
  }
  submitDraft(command: Command, onAdmission?: () => void): Promise<OriginalHandle> {
    check(!this.#preparations, "PENDING_WORK");
    check(
      ["send", "steer", "queue"].includes(command.kind) &&
        command.optimisticText === this.#snapshot.draft,
    );
    const intent = this.#draftIntent,
      draft = this.#snapshot.draft;
    return this.submit(command, () => {
      if (intent === this.#draftIntent && draft === this.#snapshot.draft) {
        this.#draftIntent++;
        this.#publish({ draft: "", attachments: [] });
        void this.#persist().catch(() => {});
      }
      onAdmission?.();
    });
  }
  submit(command: Command, onAdmission?: () => void): Promise<OriginalHandle> {
    this.#active();
    const value = this.#command(command),
      meaning = json(value, this.#options.limits.maxRequestBytes),
      previous = this.#jobs.get(value.id);
    if (previous) {
      check(previous.meaning === meaning, "CONFLICT");
      return previous.admission;
    }
    const unresolved = [...this.#jobs.values()].filter((job) => !this.#terminal(job.view));
    const maximum =
      this.#options.limits.maxOriginals +
      (value.kind === "stop" ? this.#options.limits.reservedStops : 0);
    check(unresolved.length < maximum, "FULL");
    const reserveBytes =
      value.kind === "stop"
        ? this.#options.limits.reservedStops * this.#options.limits.maxRequestBytes
        : 0;
    check(
      unresolved.reduce((sum, job) => sum + byteLength(job.meaning), 0) + byteLength(meaning) <=
        this.#options.limits.maxOriginalBytes + reserveBytes,
      "FULL",
    );
    const job = this.#job({
      command: value,
      state: "persisting",
      receipt: null,
      nativeConfirmed: false,
    });
    this.#jobs.set(value.id, job);
    this.#refreshOriginals();
    job.admission = (async () => {
      try {
        await this.#persist();
      } catch {
        job.view = immutable({ ...job.view, state: "localFailure" });
        job.resolve(job.view);
        this.#refreshOriginals();
        throw new ClientError("PERSISTENCE");
      }
      job.view = immutable({ ...job.view, state: "pending" });
      job.active = true;
      this.#refreshOriginals();
      try {
        onAdmission?.();
      } catch {
        /* Presentation cannot cancel an admitted original. */
      }
      // A new run/route appearing while persistence commits never rewrites this original.
      void Promise.resolve()
        .then(() => this.#options.feed.dispatch(this.scope, value))
        .then((receipt) => this.#receipt(job, receipt))
        .catch(() => {
          job.view = immutable({ ...job.view, state: "unknown" });
          this.#refreshOriginals();
        })
        .finally(async () => {
          job.active = false;
          this.#refreshOriginals();
          try {
            await this.#persist();
          } catch {}
          job.resolve(job.view);
        });
      return job.handle;
    })();
    void job.admission.catch(() => {});
    return job.admission;
  }
  async checkOriginal(originalId: string): Promise<ClientOriginal | null> {
    this.#active();
    id(originalId);
    const job = this.#jobs.get(originalId);
    check(job, "FENCED");
    const receipt = await this.#options.feed.original(this.scope, originalId);
    if (receipt) {
      this.#receipt(job, receipt);
      await this.#persist();
    }
    return job.view;
  }
  baseline(): Promise<ReadObservation> {
    return this.#readHistory("baseline", null);
  }
  older(cursor: string): Promise<ReadObservation> {
    idCursor(cursor);
    return this.#readHistory("older", cursor);
  }
  #readHistory(kind: "baseline" | "older", cursor: string | null): Promise<ReadObservation> {
    this.#active();
    const run = this.#snapshot.state?.run;
    check(run && this.#snapshot.freshness === "current", "FENCED");
    const current = this.#snapshot.history.current;
    const key = json([
      runKey(run),
      current?.generation ?? null,
      current?.readEpoch ?? null,
      kind,
      cursor,
    ]);
    if (this.#read?.key === key) return this.#read.work;
    check(!this.#read?.active, "PENDING_WORK");
    this.#publish({ historyRead: { kind, cursor, state: "pending" } });
    const job = { key, active: true, work: undefined! as Promise<ReadObservation> };
    this.#read = job;
    job.work = Promise.resolve()
      .then(() =>
        kind === "baseline"
          ? this.#options.feed.baseline(run)
          : this.#options.feed.older(run, cursor!),
      )
      .then(
        (value) => {
          if (this.#snapshot.state?.run && runKey(this.#snapshot.state.run) === runKey(run))
            this.#publish({ historyRead: { kind, cursor, state: "settled", outcome: value } });
          return value;
        },
        () => {
          const value = { state: "failed", code: "READ_UNAVAILABLE" } as const;
          if (
            this.#read === job &&
            this.#snapshot.state?.run &&
            runKey(this.#snapshot.state.run) === runKey(run)
          )
            this.#publish({ historyRead: { kind, cursor, state: "settled", outcome: value } });
          return value;
        },
      )
      .finally(() => {
        job.active = false;
      });
    return job.work;
  }
  #command(command: Command): Command {
    json(command, this.#options.limits.maxRequestBytes);
    id(command.id);
    check(["send", "steer", "queue", "control", "stop"].includes(command.kind));
    check(
      Object.keys(command).every((key) =>
        ["id", "kind", "run", "payload", "optimisticText"].includes(key),
      ) && Object.hasOwn(command, "payload"),
    );
    if (command.kind === "stop") {
      const payload = command.payload;
      check(
        payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          Number.isSafeInteger(payload.generation) &&
          (payload.generation as number) >= 0 &&
          command.optimisticText === undefined,
      );
      if (command.run)
        check(
          sameScope(command.run.scope, this.scope) && payload.generation === command.run.generation,
          "FENCED",
        );
    } else
      check(
        command.run &&
          sameScope(command.run.scope, this.scope) &&
          this.#snapshot.state?.run &&
          runKey(command.run) === runKey(this.#snapshot.state.run) &&
          this.#snapshot.freshness === "current" &&
          this.#snapshot.state.phase === "running",
        "FENCED",
      );
    if (command.optimisticText !== undefined)
      check(
        typeof command.optimisticText === "string" &&
          byteLength(command.optimisticText) <= this.#options.limits.maxRequestBytes,
      );
    return immutable(command);
  }
  #job(value: ClientOriginal): Job {
    let resolve!: (value: ClientOriginal) => void;
    const settled = new Promise<ClientOriginal>((accept) => {
      resolve = accept;
    });
    const job = {
      view: immutable(value),
      meaning: json(value.command, this.#options.limits.maxRequestBytes),
      active: false,
      admission: undefined! as Promise<OriginalHandle>,
      settled,
      resolve,
      handle: undefined! as OriginalHandle,
    };
    job.handle = Object.freeze({ getSnapshot: () => job.view, settled });
    return job;
  }
  #receipt(job: Job, receipt: Receipt): void {
    const value = receiptFor(receipt, this.scope, job.view.command.id, job.view.receipt);
    const settledNow =
      !this.#terminal(job.view) && (value.state === "succeeded" || value.state === "refused");
    job.view = immutable({
      ...job.view,
      receipt: value,
      state: value.state === "succeeded" || value.state === "refused" ? value.state : "unknown",
    });
    if (settledNow && this.#jobs.get(job.view.command.id) === job) {
      this.#jobs.delete(job.view.command.id);
      this.#jobs.set(job.view.command.id, job);
    }
    this.#refreshOriginals();
  }
  #terminal(value: ClientOriginal): boolean {
    return (
      value.state === "succeeded" || value.state === "refused" || value.state === "localFailure"
    );
  }
  #refreshOriginals(): void {
    const recent = [...this.#jobs.values()].filter(
      (job) => !job.active && this.#terminal(job.view),
    );
    for (const job of recent.slice(
      0,
      Math.max(0, recent.length - this.#options.limits.recentOriginals),
    ))
      this.#jobs.delete(job.view.command.id);
    this.#publish({ originals: [...this.#jobs.values()].map((job) => job.view) });
  }
  #persist(): Promise<void> {
    const value: PersistedEntry = immutable({
      version: 1,
      scope: this.scope,
      draft: this.#snapshot.draft,
      attachments: this.#snapshot.attachments,
      pinned: this.#snapshot.pinned,
      originals: [...this.#jobs.values()].map((job) => job.view),
    });
    this.#writes++;
    const work = this.#saveTail
      .catch(() => {})
      .then(() => this.#options.persistence.save(value))
      .then(
        () => {
          if (this.#snapshot.persistenceIssue) this.#publish({ persistenceIssue: false });
        },
        () => {
          this.#publish({ persistenceIssue: true });
          throw new ClientError("PERSISTENCE");
        },
      )
      .finally(() => {
        this.#writes--;
      });
    this.#saveTail = work;
    return work;
  }
  #restore(stored: PersistedEntry): void {
    check(stored.version === 1 && sameScope(stored.scope, this.scope));
    check(
      typeof stored.draft === "string" &&
        byteLength(stored.draft) <= this.#options.limits.maxDraftBytes &&
        typeof stored.pinned === "boolean",
    );
    check(
      Array.isArray(stored.originals) &&
        stored.originals.length <=
          this.#options.limits.maxOriginals +
            this.#options.limits.reservedStops +
            this.#options.limits.recentOriginals,
    );
    let pendingBytes = 0;
    for (const original of stored.originals) {
      id(original.command.id);
      check(!this.#jobs.has(original.command.id));
      if (original.command.run) {
        check(sameScope(original.command.run.scope, this.scope));
        runKey(original.command.run);
      } else check(original.command.kind === "stop");
      check(
        ["send", "steer", "queue", "control", "stop"].includes(original.command.kind) &&
          Object.hasOwn(original.command, "payload") &&
          ["persisting", "pending", "unknown", "succeeded", "refused", "localFailure"].includes(
            original.state,
          ) &&
          typeof original.nativeConfirmed === "boolean",
      );
      const state = this.#terminal(original) ? original.state : "unknown";
      const value = immutable({ ...original, state });
      const job = this.#job(value);
      if (value.receipt) receiptFor(value.receipt, this.scope, value.command.id);
      if (!this.#terminal(value)) pendingBytes += byteLength(job.meaning);
      job.resolve(value);
      job.admission = Promise.resolve(job.handle);
      this.#jobs.set(value.command.id, job);
    }
    check(
      pendingBytes <=
        this.#options.limits.maxOriginalBytes +
          this.#options.limits.reservedStops * this.#options.limits.maxRequestBytes,
      "FULL",
    );
    this.#refreshOriginals();
  }
  #ensureObservations(): void {
    const needed = !this.#closed && (this.#views.size > 0 || this.#snapshot.pinned);
    if (!needed) {
      this.#closeWatch("state");
      this.#closeRunWatches();
      return;
    }
    if (!this.#stateWatch)
      this.#stateWatch = this.#watch(
        `state:${scopeKey(this.scope)}`,
        (signal) =>
          this.#options.feed.state(this.scope, signal, () =>
            this.#publish({ freshness: "unavailable" }),
          ),
        (value) => this.#state(value),
        () => this.#publish({ freshness: "unavailable" }),
      );
    const run = this.#snapshot.state?.run;
    if (run) this.#runWatches(run);
  }
  #state(value: SessionState): void {
    json(value);
    check(sameScope(value.scope, this.scope), "FENCED");
    check(
      ["unknown", "starting", "running", "stopping", "stopped", "archived"].includes(value.phase) &&
        ["unknown", "working", "idle"].includes(value.activity),
    );
    if (value.run) {
      check(sameScope(value.run.scope, this.scope), "FENCED");
      runKey(value.run);
    }
    this.#publish({ state: value, freshness: "current" });
    if (value.run) this.#runWatches(value.run);
    else this.#closeRunWatches();
  }
  #runWatches(run: RunRef): void {
    const key = runKey(run);
    if (this.#observedRun !== key) {
      this.#closeRunWatches();
      this.#observedRun = key;
      this.#publish({
        history: { ...this.#snapshot.history, current: null },
        historyFreshness: "unobserved",
        interactions: null,
        interactionsFreshness: "unobserved",
        historyRead: null,
      });
    }
    if (!this.#historyWatch)
      this.#historyWatch = this.#watch(
        `history:${key}`,
        (signal) =>
          this.#options.feed.history(run, signal, () =>
            this.#publish({ historyFreshness: "unavailable" }),
          ),
        (frame) => this.#frame(run, frame),
        () => this.#publish({ historyFreshness: "unavailable" }),
      );
    if (!this.#interactionWatch)
      this.#interactionWatch = this.#watch(
        `interactions:${key}`,
        (signal) =>
          this.#options.feed.interactions(run, signal, () =>
            this.#publish({ interactionsFreshness: "unavailable" }),
          ),
        (value) => this.#interactions(run, value),
        () => this.#publish({ interactionsFreshness: "unavailable" }),
      );
  }
  #frame(run: RunRef, frame: Frame): void {
    const frameScope = frame.kind === "snapshot" ? frame.snapshot.scope : frame.scope;
    check(runKey(frameScope.run) === runKey(run), "FENCED");
    const previous = this.#snapshot.history.current;
    const reducerBaseline =
      frame.kind === "snapshot" &&
      previous &&
      historyScopeKey(previous.scope) !== historyScopeKey(frameScope)
        ? undefined
        : (previous ?? undefined);
    const result = applyFrame(reducerBaseline, frame);
    check(result.status !== "needsSnapshot", "CONFLICT");
    if (result.status === "stale" || result.status === "duplicate") {
      this.#publish({ historyFreshness: "current" });
      return;
    }
    const current = result.snapshot!;
    const retained = [...this.#rows.values()];
    const sameNative =
      retained.length > 0 &&
      retained.every(
        (value) =>
          value.scope.run.nativeSession === run.nativeSession &&
          scopeKey(value.scope.run.scope) === scopeKey(run.scope),
      );
    // Keep previously observed text visible as stale evidence while an empty,
    // unknown new attachment obtains its baseline. Never promote its origins.
    if (!current.rows.length && current.olderEdge.state === "unknown" && sameNative) {
      this.#publish({
        history: { ...this.#snapshot.history, current },
        historyFreshness: "unobserved",
      });
      return;
    }
    const residentCurrent = retained.every(
      (value) =>
        historyScopeKey(value.scope) === historyScopeKey(current.scope) &&
        value.generation === current.generation,
    );
    const same =
      previous &&
      historyScopeKey(previous.scope) === historyScopeKey(current.scope) &&
      previous.generation === current.generation;
    const rows = new Map(this.#rows);
    let order = [...this.#order];
    const anchored = order.some((id) => current.rows.some((row) => row.id === id));
    let omission = current.residencyOmitted || (!!same && this.#snapshot.history.residencyOmitted);
    if (!same || (!residentCurrent && !anchored)) {
      omission = current.residencyOmitted;
      rows.clear();
      order = [];
    } else if (frame.kind === "snapshot" && !anchored && order.length > 0) {
      omission = true;
      rows.clear();
      order = [];
    }
    const incoming = current.rows.map((row) => row.id);
    order = mergeHistoryOrder(
      order,
      incoming,
      frame.kind === "commit" && frame.placement === "before",
    );
    for (const row of current.rows) {
      const prior = rows.get(row.id);
      if (
        prior &&
        prior.row.body.kind === "complete" &&
        !["running", "unknown"].includes(prior.row.lifecycle) &&
        (row.body.kind !== "complete" || ["running", "unknown"].includes(row.lifecycle))
      )
        continue;
      if (
        prior &&
        historyScopeKey(prior.scope) === historyScopeKey(current.scope) &&
        prior.generation === current.generation &&
        prior.row.version === row.version
      )
        check(json(prior.row) === json(row), "CONFLICT");
      rows.set(row.id, { row, scope: current.scope, generation: current.generation });
    }
    const size = () => byteLength(json(order.map((id) => rows.get(id)!)));
    const protectedIds = new Set(current.rows.map((row) => row.id));
    while (
      order.length > this.#options.limits.maxHistoryRows ||
      size() > this.#options.limits.maxHistoryBytes
    ) {
      const first =
        frame.kind === "commit" && frame.placement === "before" ? order.at(-1) : order[0];
      check(
        first && !protectedIds.has(first) && rows.get(first)!.row.lifecycle !== "running",
        "FULL",
      );
      rows.delete(first);
      if (frame.kind === "commit" && frame.placement === "before") order.pop();
      else order.shift();
      omission = true;
    }
    const origins = Object.fromEntries(
      order.map((id) => {
        const value = rows.get(id)!;
        return [id, { scope: value.scope, generation: value.generation }];
      }),
    );
    for (const row of current.rows)
      if (row.kind === "user" && typeof row.native.originalId === "string") {
        const job = this.#jobs.get(row.native.originalId);
        if (job?.view.command.run && runKey(job.view.command.run) === runKey(run))
          job.view = immutable({ ...job.view, nativeConfirmed: true });
      }
    this.#rows = rows;
    this.#order = order;
    this.#publish({
      history: {
        current,
        rows: order.map((id) => rows.get(id)!.row),
        origins,
        residencyOmitted: omission,
      },
      historyFreshness: "current",
      originals: [...this.#jobs.values()].map((job) => job.view),
    });
  }
  #interactions(run: RunRef, value: InteractionSnapshot): void {
    check(runKey(value.run) === runKey(run), "FENCED");
    json(value);
    this.#publish({ interactions: value, interactionsFreshness: "current" });
  }
  #watch<T>(
    key: string,
    open: (signal: AbortSignal) => AsyncIterable<T>,
    receive: (value: T) => void,
    unavailable: () => void,
  ): Watch {
    const watch: Watch = { token: {} };
    let active = true;
    // The slot is assigned before a connector can synchronously deliver a
    // baseline. A StrictMode release that wins first never opens an observer.
    const connected = Promise.resolve().then(() =>
      active && !this.#closed
        ? this.#options.observations.connect({
            key,
            open,
            receive: (value) => {
              if (active && !this.#closed) receive(value);
            },
            unavailable: () => {
              if (active && !this.#closed) unavailable();
            },
          })
        : () => {},
    );
    void connected.catch(() => {
      if (active && !this.#closed) unavailable();
    });
    watch.release = () => {
      active = false;
      return connected.then((release) => release());
    };
    return watch;
  }
  #closeWatch(kind: "state" | "history" | "interaction"): void {
    const watch =
      kind === "state"
        ? this.#stateWatch
        : kind === "history"
          ? this.#historyWatch
          : this.#interactionWatch;
    if (kind === "state") this.#stateWatch = undefined;
    else if (kind === "history") this.#historyWatch = undefined;
    else this.#interactionWatch = undefined;
    if (watch?.release) {
      let work: Promise<void>;
      try {
        work = Promise.resolve(watch.release());
      } catch {
        work = Promise.reject(new ClientError("PENDING_WORK"));
      }
      this.#cleanup.add(work);
      void work.then(
        () => this.#cleanup.delete(work),
        () => {
          /* Failed actual cleanup stays owned and blocks eviction. */
        },
      );
    }
  }
  #closeRunWatches(): void {
    this.#closeWatch("history");
    this.#closeWatch("interaction");
    this.#observedRun = undefined;
  }
  #publish(patch: Partial<EntrySnapshot>): void {
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...immutable(patch),
      revision: this.#snapshot.revision + 1,
    });
    for (const listener of [...this.#listeners])
      try {
        listener();
      } catch {
        /* One viewer cannot own the entry. */
      }
  }
  #active(): void {
    check(!this.#closed, "CLOSED");
  }
  async settled(): Promise<void> {
    await this.#saveTail.catch(() => {});
    await Promise.all([...this.#cleanup]);
  }
  async close(): Promise<void> {
    check(
      !this.#preparations &&
        ![...this.#jobs.values()].some((job) => job.active) &&
        !this.#read?.active,
      "PENDING_WORK",
    );
    this.#closed = true;
    this.#closeWatch("state");
    this.#closeRunWatches();
    await this.settled();
    this.#listeners.clear();
  }
}
function idCursor(value: string): void {
  check(typeof value === "string" && value.length > 0 && value.length <= 16384);
}
