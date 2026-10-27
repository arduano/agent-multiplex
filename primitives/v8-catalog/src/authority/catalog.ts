import { CatalogJournal } from "./journal.js";
import { catalogKey, CatalogError, type ArchivePublication, type CatalogEntry, type CatalogPort, type CatalogScope, type CreateRequest, type Creation, type CreationState, type HostCreationPort, type HostCreationStatus, type HostTarget, type RenameRequest, type WatchRequest, type MetadataOriginal } from "../contracts/types.js";
import { archive as validateArchive, binding, canonical, check, copy, create as validateCreate, id, rename as validateRename, watch as validateWatch, scope as validateScope, target as validateTarget } from "../contracts/validation.js";
type CreationWatch = { owner: HostCreationPort; creation: Creation; active: boolean; release?: () => void; pending?: HostCreationStatus; running: boolean };
const targetKey = (t: HostTarget): string => canonical(t);
/** One authority, one durable catalog. Host effects and native status remain external. */
export class CatalogAuthority implements CatalogPort {
  readonly #journal: CatalogJournal; readonly #scope: CatalogScope; readonly #hosts = new Map<string, HostCreationPort>();
  readonly #jobs = new Map<string, Promise<Creation>>(); readonly #listeners = new Set<(entry: CatalogEntry) => void>();
  readonly #watches = new Map<string, CreationWatch>(); #transitionTail: Promise<void> = Promise.resolve();
  readonly #creates = new Set<Promise<Creation>>(); readonly #legacyCreates = new Set<Promise<HostCreationStatus>>();
  readonly #unprovedCreates = new Set<string>();
  #wakeSeal!: () => void; readonly #sealSignal = new Promise<void>(resolve => { this.#wakeSeal = resolve; });
  readonly #observationMs: number; #closed = false; #sealed = false;
  private constructor(journal: CatalogJournal, scope: CatalogScope, observationMs: number) { this.#journal = journal; this.#scope = scope; this.#observationMs = observationMs; }
  static async open(options: Readonly<{ directory: string; scope: CatalogScope; maxSessions?: number; maxOperations?: number; observationMs?: number }>): Promise<CatalogAuthority> {
    validateScope(options.scope); const maxSessions = options.maxSessions ?? 128, maxOperations = options.maxOperations ?? 512, ms = options.observationMs ?? 100;
    check(Number.isSafeInteger(maxSessions) && maxSessions > 0 && maxSessions <= 512 && Number.isSafeInteger(maxOperations) && maxOperations >= maxSessions && maxOperations <= 2048 && Number.isSafeInteger(ms) && ms > 0 && ms <= 30000);
    const scope = copy(options.scope), journal = await CatalogJournal.open({ directory: options.directory, scope, maxSessions, maxOperations }); return new CatalogAuthority(journal, scope, ms);
  }
  #bound(s: CatalogScope): void { if (this.#closed) throw new CatalogError("CLOSED"); validateScope(s); if (catalogKey(s) !== catalogKey(this.#scope)) throw new CatalogError("FENCED"); }
  register(port: HostCreationPort): () => void {
    this.#bound(this.#scope); validateTarget(port.target); const target = copy(port.target), key = targetKey(target);
    // Registered callbacks are capabilities: do not read mutable caller properties after await.
    const fixed: HostCreationPort = Object.freeze({ target, create: port.create.bind(port), ...(port.createAdmitted ? {createAdmitted: port.createAdmitted.bind(port)} : {}), read: port.read.bind(port), ...(port.readArchive ? { readArchive: port.readArchive.bind(port) } : {}), ...(port.watch ? { watch: port.watch.bind(port) } : {}) });
    for (const [id, watch] of this.#watches) if (watch.creation.original.target.host === target.host) this.#releaseWatch(id);
    if (!this.#hosts.has(target.host) && this.#hosts.size >= 128) throw new CatalogError("FULL"); this.#hosts.set(target.host, fixed); return () => { if (this.#hosts.get(target.host) === fixed) { this.#hosts.delete(target.host); for (const [id, watch] of this.#watches) if (watch.owner === fixed) this.#releaseWatch(id); } };
  }
  #owner(target: HostTarget): HostCreationPort | undefined { const port = this.#hosts.get(target.host); return port && targetKey(port.target) === targetKey(target) ? port : undefined; }
  #publish(e: CatalogEntry): void { for (const listener of [...this.#listeners]) { try { listener(e); } catch { /* Renderer errors cannot undo a durable commit. */ } } }
  subscribe(s: CatalogScope, listener: (entry: CatalogEntry) => void): () => void { this.#bound(s); if (!this.#listeners.has(listener) && this.#listeners.size >= 128) throw new CatalogError("FULL"); this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  async list(s: CatalogScope): Promise<readonly CatalogEntry[]> { this.#bound(s); return this.#journal.call("list", {}); }
  async get(s: CatalogScope, session: string): Promise<CatalogEntry | null> { this.#bound(s); id(session); return this.#journal.call("get", { session }); }
  async rename(request: RenameRequest): Promise<CatalogEntry> { this.#bound(request.scope); const fixed = validateRename(request), result = await this.#journal.call<CatalogEntry>("metadata", { request: fixed }); this.#publish(result); return result; }
  async setWatched(request: WatchRequest): Promise<CatalogEntry> { this.#bound(request.scope); const fixed = validateWatch(request), result = await this.#journal.call<CatalogEntry>("metadata", { request: fixed }); this.#publish(result); return result; }
  async metadataOriginal(scope: CatalogScope, originalId: string): Promise<MetadataOriginal | null> { this.#bound(scope); id(originalId); return this.#journal.call("metadata.original", { id: originalId }); }
  async publishArchive(request: ArchivePublication): Promise<CatalogEntry> {
    this.#bound(request.scope); const fixed = validateArchive(request), entry = await this.get(fixed.scope, fixed.session);
    if (!entry) throw new CatalogError("FENCED");
    if (entry.archive) { if (entry.archive.id !== fixed.id || entry.archive.generation !== fixed.generation) throw new CatalogError("CONFLICT"); return entry; }
    const creation = await this.#journal.call<Creation | null>("creation", { id: entry.createId }), owner = this.#owner(entry.target);
    if (!creation || !["nativeCreated", "refused"].includes(creation.state) || !owner?.readArchive) throw new CatalogError("BUSY");
    const proved = await owner.readArchive(creation.original, fixed.id, fixed.generation); this.#bound(fixed.scope);
    if (this.#owner(entry.target) !== owner) throw new CatalogError("FENCED");
    if (proved !== true) throw new CatalogError("BUSY");
    const result = await this.#journal.call<CatalogEntry>("archive", { request: fixed, target: entry.target, createId: entry.createId }); this.#publish(result); return result;
  }
  #releaseWatch(id: string): void { const watch = this.#watches.get(id); if (!watch) return; watch.active = false; delete watch.pending; this.#watches.delete(id); try { watch.release?.(); } catch { /* Releasing observation cannot change native lifetime. */ } }
  async #watch(c: Creation, owner: HostCreationPort): Promise<void> {
    if (!owner.watch || this.#watches.has(c.original.id)) return;
    if (this.#watches.size >= 128) throw new CatalogError("FULL");
    const watch: CreationWatch = { owner, creation: c, active: true, running: false }; this.#watches.set(c.original.id, watch);
    try {
      const release = await owner.watch(c.original, value => {
        if (!watch.active || this.#closed || this.#owner(c.original.target) !== owner) return;
        if (!watch.pending || !["created", "refused"].includes(watch.pending.state)) watch.pending = copy(value); if (watch.running) return; watch.running = true;
        void (async () => { try {
          while (watch.active && watch.pending && !this.#closed && this.#owner(c.original.target) === owner) {
            const next = watch.pending; delete watch.pending;
            await this.#apply(c, next, () => watch.active && !this.#closed && this.#owner(c.original.target) === owner);
          }
        } catch { /* Keep exact original available for explicit reconciliation. */ } finally { watch.running = false; } })();
      });
      if (!watch.active || this.#closed || this.#owner(c.original.target) !== owner) { try { release(); } catch {} this.#releaseWatch(c.original.id); }
      else watch.release = release;
    } catch (error) { this.#releaseWatch(c.original.id); throw error; }
  }
  async #transition(c: Creation, state: CreationState, native = c.native, current?: () => boolean): Promise<Creation> {
    const work = this.#transitionTail.then(async () => {
      if (current && !current()) return c;
      const result = await this.#journal.call<Creation>("transition", { id: c.original.id, state, ...(native ? { binding: native } : {}) });
      if (result.state === "nativeCreated" || result.state === "refused") this.#unprovedCreates.delete(c.original.id);
      if (result.state === "nativeCreated" || result.state === "refused") this.#releaseWatch(c.original.id);
      this.#publish(result.entry); return result;
    });
    this.#transitionTail = work.then(() => {}, () => {}); return work;
  }
  async #apply(c: Creation, value: HostCreationStatus, current?: () => boolean): Promise<Creation> {
    if (value.state === "created" || value.state === "refused") this.#unprovedCreates.delete(c.original.id);
    if (value.state === "created") {
      const native = binding(value.binding, c.original.target);
      try { return await this.#transition(c, "nativeCreated", native, current); }
      catch { return copy({ ...c, state: "nativeCreated", native, publication: "pending" }); }
    }
    check(["pending", "unknown", "refused"].includes(value.state));
    return this.#transition(c, value.state === "refused" ? "refused" : "outcomeUnknown", c.native, current);
  }
  #own(key: string, work: () => Promise<Creation>): Promise<Creation> {
    const prior = this.#jobs.get(key); if (prior) return prior;
    if (this.#jobs.size >= 32) throw new CatalogError("BUSY");
    const p = Promise.resolve().then(work); this.#jobs.set(key, p); void p.finally(() => { if (this.#jobs.get(key) === p) this.#jobs.delete(key); }).catch(() => {}); return p;
  }
  async #observe(work: Promise<Creation>, original: CreateRequest): Promise<Creation> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<Creation>((resolve, reject) => { timer = setTimeout(() => { void this.#journal.call<Creation>("creation", { id: original.id }).then(resolve, reject); }, this.#observationMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async create(request: CreateRequest): Promise<Creation> {
    this.#bound(request.scope); const original = validateCreate(request);
    if (this.#sealed) {
      const prior = await this.#journal.call<Creation | null>("creation", {id: original.id});
      if (!prior) throw new CatalogError("CLOSED");
      if (canonical(prior.original) !== canonical(original)) throw new CatalogError("CONFLICT");
      return prior; // Existing original remains readable; never dispatch after seal.
    }
    const reservation = this.#journal.call<{ fresh: boolean; value: Creation }>("reserve", { original });
    // Register before awaiting SQLite: shutdown owns the reservation window too.
    const actual = reservation.then(async admitted => {
      if (!admitted.fresh) return admitted.value; this.#publish(admitted.value.entry);
      const owner = this.#owner(original.target);
      if (this.#sealed || !owner) return this.#transition(admitted.value, "refused");
      try { return await this.#own(original.id, async () => {
        let c = await this.#transition(admitted.value, "dispatching");
        if (this.#closed || this.#sealed || this.#owner(original.target) !== owner) return this.#transition(c, "refused");
        try { await Promise.race([this.#watch(c, owner), this.#sealSignal]); }
        catch { return this.#transition(c, "refused"); } // No Host mutation was invoked.
        if (this.#closed || this.#sealed || this.#owner(original.target) !== owner) return this.#transition(c, "refused");
        try {
          const call = owner.createAdmitted ? owner.createAdmitted(original) : owner.create(original);
          if (!owner.createAdmitted) { this.#legacyCreates.add(call); void call.finally(() => this.#legacyCreates.delete(call)).catch(() => {}); }
          const result = await call;
          if (result.state === "unknown" || !owner.createAdmitted && result.state === "pending") this.#unprovedCreates.add(original.id);
          return await this.#apply(c, result);
        } catch { this.#unprovedCreates.add(original.id); return this.#transition(c, "outcomeUnknown"); }
      }); } catch { return this.#transition(admitted.value, "refused"); }
    });
    this.#creates.add(actual); void actual.finally(() => this.#creates.delete(actual)).catch(() => {});
    await reservation; // Observation timeout cannot precede the original's row.
    return this.#observe(actual, original);
  }
  /** Process admission boundary, separate from Stop and from observation close.
   * The real admission-capable Host returns before native work completes. A
   * legacy pending actual call has no such proof and retains custody as BUSY. */
  async sealAdmissions(): Promise<void> {
    this.#bound(this.#scope); this.#sealed = true; this.#wakeSeal();
    if (this.#legacyCreates.size || this.#unprovedCreates.size) throw new CatalogError("BUSY", "A Host Create has not proved its admission boundary");
    await Promise.allSettled([...this.#creates]);
    if (this.#unprovedCreates.size) throw new CatalogError("BUSY", "A Host Create has not proved its admission boundary");
  }
  async creation(s: CatalogScope, requestId: string): Promise<Creation | null> {
    this.#bound(s); id(requestId); const c = await this.#journal.call<Creation | null>("creation", { id: requestId });
    if (!c || c.state === "nativeCreated" || c.state === "refused" || c.state === "reserved") return c;
    const owner = this.#owner(c.original.target); if (!owner) return c;
    // Joins ongoing create, otherwise only exact-original read. No create on restart/reconnect.
    const p = this.#own(requestId, async () => { try { return await this.#apply(c, await owner.read(c.original)); } catch { return c; } });
    return this.#observe(p, c.original);
  }
  async close(): Promise<void> { if (this.#closed) return; this.#closed = true; for (const id of [...this.#watches.keys()]) this.#releaseWatch(id); this.#hosts.clear(); this.#listeners.clear(); await this.#journal.close(); }
  /** Disposable crash/restart qualification only; never claims native cleanup. */
  async terminate(): Promise<void> { this.#closed = true; for (const id of [...this.#watches.keys()]) this.#releaseWatch(id); this.#hosts.clear(); this.#listeners.clear(); await this.#journal.terminate(); }
}
