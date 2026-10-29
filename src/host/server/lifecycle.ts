import { isAbsolute } from "node:path";
import {
  canonicalJson,
  scopeKey,
  type Json,
  type Original,
  type Receipt,
  type RunRef,
  type SessionScope,
} from "../../protocol/index.js";
import { openingCapsule, openingProof } from "../../runtime/index.js";
import type {
  HostActivationContext,
  HostContext,
  UpdateReadiness,
  NativeObservation,
  NativeResult,
  SessionState,
  RunSelection,
  WorkspaceAllocation,
} from "../contracts.js";
import type { LifecycleOptions } from "../node-contracts.js";
import {
  copy,
  allocationSchema,
  preparationRefusalSchema,
  recordSchema,
  type Entry,
} from "../internal/lifecycle-codec.js";
import type { z } from "zod";

const lifecycleWriters = new WeakSet<object>();
const nativeOwners = new WeakSet<object>();
/** One durable lifecycle owner. Observer delivery, native history and transport
 * reconnect are deliberately absent; they cannot become a second effect owner. */
export class DefaultLifecycle<
  Input extends z.ZodType,
  Data extends z.ZodType<Json>,
  Command extends z.ZodType,
  Message extends z.ZodType = z.ZodType<Json>,
  Requested extends z.ZodType = z.ZodType<Json>,
  Observed extends z.ZodType = z.ZodType<Json>,
> {
  readonly #defaultSelection: z.output<Requested>;
  readonly #entries = new Map<string, Entry>();
  readonly #actual = new Set<Promise<unknown>>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(
    readonly options: LifecycleOptions<Input, Data, Command, Message, Requested, Observed>,
    readonly context: HostActivationContext,
  ) {
    if (nativeOwners.has(options.native))
      throw new Error("Native port already has a lifecycle owner");
    if (lifecycleWriters.has(options.journal.writerIdentity))
      throw new Error("Original writer already has a lifecycle owner");
    if (!Number.isSafeInteger(options.maxSessions ?? 128) || (options.maxSessions ?? 128) < 1)
      throw new TypeError("Invalid session capacity");
    this.#defaultSelection = copy(
      options.native.selectionInput.parse(options.selection) as Json,
    ) as z.output<Requested>;
    for (const checkpoint of options.journal.checkpoints()) {
      const record = recordSchema.parse(checkpoint.value);
      const selectionSchema =
        record.selectionSource === "requested"
          ? options.native.selectionInput
          : options.native.selectionOutput;
      const parsedSelection = selectionSchema.parse(record.selection);
      if (
        canonicalJson(parsedSelection as Json, 262144).json !==
        canonicalJson(record.selection, 262144).json
      )
        throw new Error("Stored selection is not a canonical schema output");
      if (canonicalJson(record.custody, 8192).json !== canonicalJson(this.#custody(), 8192).json)
        throw new Error("Stored native/workspace custody is incompatible");
      if (
        scopeKey(checkpoint.scope) !== scopeKey(record.scope) ||
        record.scope.host !== context.route.host
      )
        throw new Error("Lifecycle checkpoint scope mismatch");
      if (record.capsule) {
        openingCapsule(record.capsule);
        if (
          scopeKey(record.capsule.opening.scope) !== scopeKey(record.scope) ||
          record.capsule.opening.generation !== record.generation
        )
          throw new Error("Lifecycle capsule binding mismatch");
      }
      if ((record.phase === "stopped" || record.phase === "archived") && record.nativeAttempted) {
        if (!record.capsule || !record.stopProof)
          throw new Error("Stopped checkpoint lacks native proof");
        openingProof(
          record.capsule,
          record.stopProof as unknown as import("../../runtime/contracts.js").OpeningStopProof,
        );
      }
      // Admission and this initial record share one commit. Only this exact
      // positive no-attempt state can refuse a crashed Create without I/O.
      if (
        record.phase === "preparing" &&
        record.generation === 0 &&
        !record.nativeAttempted &&
        !record.workspaceAttempted &&
        !record.workspace &&
        !record.nativeSession &&
        !record.opening &&
        !record.capsule &&
        !record.stopProof
      ) {
        const unresolved = options.journal.unresolved(record.scope);
        const original = unresolved.length === 1 ? unresolved[0] : undefined;
        const raw = original?.request;
        const request =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Readonly<Record<string, Json>>)
            : undefined;
        if (
          original &&
          request?.type === "create" &&
          request.selection !== undefined &&
          canonicalJson(request.selection, 262144).json ===
            canonicalJson(record.selection, 262144).json
        ) {
          record.phase = "stopped";
          record.stopRequested = true;
          record.activity = "idle";
          options.journal.settle(
            record.scope,
            original.receipt.id,
            { state: "refused", result: { reason: "Create interrupted before allocation" } },
            { scope: record.scope, value: copy(record as unknown as Json) },
          );
        }
      }
      // A process restart observes retained custody; it neither reopens native
      // work nor treats an old in-memory running projection as current evidence.
      if (!["stopped", "archived"].includes(record.phase)) {
        record.phase = "uncertain";
        record.activity = "unknown";
      }
      this.#entries.set(scopeKey(record.scope), { record, revision: 0, actual: new Set() });
    }
    lifecycleWriters.add(options.journal.writerIdentity);
    nativeOwners.add(options.native);
  }
  #custody() {
    return {
      native: {
        id: this.options.native.identity.id,
        recordVersion: this.options.native.identity.recordVersion,
      },
      workspace: {
        id: this.options.workspace.identity.id,
        recordVersion: this.options.workspace.identity.recordVersion,
      },
    };
  }
  #active(): void {
    if (this.#closed || this.#closing) throw new Error("Lifecycle closed");
  }
  #entry(scope: SessionScope): Entry {
    this.#active();
    const entry = this.#entries.get(scopeKey(scope));
    if (scope.host !== this.context.route.host || !entry) throw new Error("Session scope fenced");
    return entry;
  }
  #save(entry: Entry): void {
    this.options.journal.saveCheckpoint(entry.record.scope, copy(entry.record as unknown as Json));
    entry.revision++;
    this.#publish();
  }
  #publish(): void {
    for (const listener of this.#listeners)
      try {
        listener();
      } catch {
        /* Observers cannot own effects. */
      }
  }
  #own<T>(entry: Entry, work: Promise<T>): Promise<T> {
    this.#actual.add(work);
    entry.actual.add(work);
    void work
      .finally(() => {
        this.#actual.delete(work);
        entry.actual.delete(work);
      })
      .catch(() => {});
    return work;
  }
  #start(entry: Entry, id: string, effect: () => Promise<Receipt>): Promise<Receipt> {
    this.options.journal.markDispatched(entry.record.scope, id, {
      scope: entry.record.scope,
      value: copy(entry.record as unknown as Json),
    });
    const work = this.#own(entry, Promise.resolve().then(effect));
    entry.revision++;
    this.#publish();
    return work;
  }
  #settle(entry: Entry, id: string, outcome: NativeResult | { state: "unknown" }): Receipt {
    const receipt = this.options.journal.settle(entry.record.scope, id, outcome, {
      scope: entry.record.scope,
      value: copy(entry.record as unknown as Json),
    });
    entry.revision++;
    this.#publish();
    return receipt;
  }
  #result(entry: Entry, id: string, result: Json = { accepted: true }): Receipt {
    return this.#settle(entry, id, { state: "succeeded", result });
  }
  #refuse(scope: SessionScope, id: string, reason: string): Receipt {
    return this.options.journal.settle(scope, id, { state: "refused", result: { reason } });
  }
  #run(entry: Entry): RunRef {
    if (!entry.record.nativeSession || !entry.record.capsule)
      throw new Error("Native binding unavailable");
    return {
      scope: entry.record.scope,
      generation: entry.record.generation,
      nativeSession: entry.record.nativeSession,
    };
  }
  #observation(entry: Entry, value: NativeObservation<z.output<Observed>>): boolean {
    const run = this.#run(entry);
    if (
      scopeKey(value.run.scope) !== scopeKey(run.scope) ||
      value.run.generation !== run.generation ||
      value.run.nativeSession !== run.nativeSession
    )
      throw new Error("Native observation fenced");
    const selection = copy(this.options.native.selectionOutput.parse(value.selection) as Json),
      changed =
        entry.record.selectionSource !== "observed" ||
        entry.record.activity !== value.activity ||
        canonicalJson(entry.record.selection, 262144).json !==
          canonicalJson(selection, 262144).json;
    entry.record.activity = value.activity;
    entry.record.selection = selection;
    entry.record.selectionSource = "observed";
    return changed;
  }
  #selection(entry: Entry): RunSelection<z.output<Requested>, z.output<Observed>> {
    return entry.record.selectionSource === "requested"
      ? { selectionSource: "requested", selection: entry.record.selection as z.output<Requested> }
      : { selectionSource: "observed", selection: entry.record.selection as z.output<Observed> };
  }
  state(scope: SessionScope): SessionState<z.output<Requested>, z.output<Observed>> {
    const { record } = this.#entry(scope),
      base = {
        scope: record.scope,
        generation: record.generation,
        nativeSession: record.nativeSession,
        ...this.#selection(this.#entry(scope)),
        workspace: record.workspace,
      };
    if (record.phase === "running")
      return copy({
        ...base,
        phase: "running",
        run: this.#run(this.#entry(scope)),
        activity: record.activity,
        mayRun: true,
      } as unknown as Json) as unknown as SessionState<z.output<Requested>, z.output<Observed>>;
    if (record.phase === "stopped" || record.phase === "archived")
      return { ...structuredClone(base), phase: record.phase, activity: "idle", mayRun: false };
    return {
      ...structuredClone(base),
      phase: record.phase,
      activity: "unknown",
      mayRun: record.nativeAttempted,
    };
  }
  list(
    context: Pick<HostContext, "identity">,
  ): readonly SessionState<z.output<Requested>, z.output<Observed>>[] {
    this.#active();
    return [...this.#entries.values()]
      .filter(
        ({ record }) =>
          record.scope.connection === context.identity.connection &&
          record.scope.principal === context.identity.principal,
      )
      .map(({ record }) => this.state(record.scope));
  }
  subscribe(listener: () => void): () => void {
    this.#active();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  original(scope: SessionScope, id: string): Receipt | null {
    this.#active();
    return this.options.journal.read(scope, id);
  }
  /** Trusted native events use the same generation check as explicit inspect. */
  observe(scope: SessionScope, observation: NativeObservation<z.output<Observed>>): void {
    const entry = this.#entry(scope);
    if (entry.record.stopRequested || entry.record.phase === "archived") return;
    const changed = this.#observation(entry, observation),
      phaseChanged = entry.record.phase !== "running";
    entry.record.phase = "running";
    if (changed || phaseChanged) this.#save(entry);
  }
  async inspect(
    scope: SessionScope,
  ): Promise<SessionState<z.output<Requested>, z.output<Observed>>> {
    const entry = this.#entry(scope),
      capsule = entry.record.capsule,
      revision = entry.revision;
    if (!capsule || entry.record.phase === "archived") return this.state(scope);
    const observed = await this.options.native.inspect(capsule);
    this.#active();
    if (entry.revision !== revision) return this.state(scope);
    if (observed && "state" in observed) {
      openingProof(capsule, observed);
      entry.record.stopProof = copy(observed as unknown as Json);
      entry.record.phase = "stopped";
      entry.record.stopRequested = true;
      entry.record.activity = "idle";
      this.#save(entry);
    } else if (observed && !entry.record.stopRequested) {
      this.#observation(entry, observed);
      entry.record.phase = "running";
      this.#save(entry);
    } else if (observed && entry.record.phase === "stopped") {
      entry.record.phase = "uncertain";
      entry.record.activity = "unknown";
      this.#save(entry);
    }
    return this.state(scope);
  }
  create(
    scope: SessionScope,
    id: string,
    input: z.input<Input>,
    selection?: z.input<Requested>,
  ): Promise<Receipt> {
    this.#active();
    scopeKey(scope);
    if (scope.host !== this.context.route.host) throw new Error("Host scope fenced");
    const parsed = copy(this.options.workspace.input.parse(input) as Json) as z.output<Input>,
      selected = copy(
        selection === undefined
          ? (this.#defaultSelection as Json)
          : (this.options.native.selectionInput.parse(selection) as Json),
      );
    const reason = this.#entries.has(scopeKey(scope))
      ? "Session already exists"
      : [...this.#entries.values()].filter(({ record }) => record.phase !== "archived").length >=
          (this.options.maxSessions ?? 128)
        ? "Session capacity reached"
        : undefined;
    const entry: Entry = {
      revision: 0,
      actual: new Set(),
      record: {
        version: 2,
        custody: this.#custody(),
        scope: structuredClone(scope),
        phase: "preparing",
        generation: 0,
        nativeSession: null,
        selection: selected,
        selectionSource: "requested",
        activity: "unknown",
        workspace: null,
        opening: null,
        capsule: null,
        stopProof: null,
        stopRequested: false,
        workspaceAttempted: false,
        nativeAttempted: false,
      },
    };
    const admitted = this.options.journal.admit(
      scope,
      id,
      { type: "create", input: parsed as Json, selection: selected },
      reason ? {} : { checkpoint: { scope, value: copy(entry.record as unknown as Json) } },
    );
    if (!admitted.fresh) return Promise.resolve(admitted.receipt);
    if (reason) return Promise.resolve(this.#refuse(scope, id, reason));
    this.#entries.set(scopeKey(scope), entry);
    return this.#open(entry, id, "create", parsed);
  }
  reopen(
    scope: SessionScope,
    id: string,
    generation: number,
    selection?: z.input<Requested>,
  ): Promise<Receipt> {
    const selected =
      selection === undefined
        ? undefined
        : copy(this.options.native.selectionInput.parse(selection) as Json);
    const entry = this.#entry(scope),
      admitted = this.options.journal.admit(scope, id, {
        type: "reopen",
        generation,
        ...(selected === undefined ? {} : { selection: selected }),
      });
    if (!admitted.fresh) return Promise.resolve(admitted.receipt);
    if (
      entry.record.generation !== generation ||
      entry.record.phase !== "stopped" ||
      entry.actual.size ||
      !entry.record.workspace ||
      !entry.record.nativeSession
    )
      return Promise.resolve(this.#refuse(scope, id, "Reopen requires stopped native session"));
    return this.#open(entry, id, "reopen", undefined, selected);
  }
  #open(
    entry: Entry,
    id: string,
    mode: "create" | "reopen",
    input?: z.output<Input>,
    selection?: Json,
  ): Promise<Receipt> {
    const record = entry.record,
      previous = structuredClone(record);
    if (mode === "reopen") {
      record.stopRequested = false;
      if (selection !== undefined) {
        record.selection = selection;
        record.selectionSource = "requested";
      }
    }
    this.options.journal.markDispatched(record.scope, id, {
      scope: record.scope,
      value: copy(record as unknown as Json),
    });
    entry.acquisition = Promise.resolve().then(async () => {
      if (record.stopRequested) return null;
      if (mode === "create") {
        record.workspaceAttempted = true;
        this.#save(entry);
        if (record.stopRequested) return null;
        const allocation = await this.options.workspace.allocate({
          scope: record.scope,
          originalId: id,
          input: input!,
        });
        if ("state" in allocation) {
          if (allocation.state !== "refused" || allocation.noAllocation !== true)
            throw new Error("Workspace refusal unproved");
          return null;
        }
        if (!isAbsolute(allocation.cwd)) throw new Error("Workspace cwd must be absolute");
        record.workspace = {
          ...allocationSchema.parse(allocation),
          data: this.options.workspace.data.parse(allocation.data),
        };
        this.#save(entry);
      }
      if (record.stopRequested) return null;
      record.generation++;
      record.phase = "opening";
      record.nativeAttempted = true;
      record.opening = { scope: record.scope, generation: record.generation, operationId: id };
      record.capsule = null;
      record.stopProof = null;
      this.#save(entry);
      const prepared = await this.options.native.prepare({
        opening: record.opening,
        cwd: record.workspace!.cwd,
        mode,
        ...this.#selection(entry),
        ...(mode === "reopen" && selection !== undefined
          ? {
              previousSelection: previous.selection as z.output<Requested> | z.output<Observed>,
              previousSelectionSource: previous.selectionSource,
            }
          : {}),
      });
      if ("state" in prepared) {
        const refusal = preparationRefusalSchema.parse(prepared);
        // Positive absence of this new allocation restores the previous exact
        // stopped lifetime. Failed intent remains in its original, not state.
        if (mode === "reopen") Object.assign(record, previous);
        else {
          record.generation = previous.generation;
          record.opening = null;
          record.capsule = null;
          record.stopProof = null;
          record.nativeAttempted = false;
          record.phase = "stopped";
          record.activity = "idle";
          record.stopRequested = true;
        }
        return refusal;
      }
      const capsule = openingCapsule({ opening: prepared.opening, identity: prepared.identity });
      if (
        canonicalJson(capsule.opening as unknown as Json, 8192).json !==
        canonicalJson(record.opening as unknown as Json, 8192).json
      )
        throw new Error("Native allocation fenced");
      entry.prepared = prepared;
      record.capsule = capsule;
      this.#save(entry);
      return prepared;
    });
    const work = Promise.resolve().then(async () => {
      try {
        const prepared = await entry.acquisition;
        if (prepared && "state" in prepared)
          return this.#settle(entry, id, {
            state: "refused",
            result: {
              reason: "Native preparation refused",
              code: prepared.code,
              noAllocation: true,
            },
          });
        if (!prepared) {
          if (!record.stopRequested) record.phase = "stopped";
          return this.#settle(entry, id, {
            state: "refused",
            result: {
              reason: record.stopRequested ? "Stopped before native launch" : "Workspace refused",
            },
          });
        }
        if (record.stopRequested)
          return this.#settle(entry, id, {
            state: "refused",
            result: { reason: "Stopped before native launch" },
          });
        const capsule = record.capsule!;
        const observed = await this.options.native.open({
          capsule,
          cwd: record.workspace!.cwd,
          mode,
          nativeSession: record.nativeSession,
          ...this.#selection(entry),
          commitBinding: (binding) => {
            if (
              entry.record !== record ||
              record.phase === "archived" ||
              !record.capsule ||
              canonicalJson(record.capsule as unknown as Json, 8192).json !==
                canonicalJson(capsule as unknown as Json, 8192).json ||
              scopeKey(binding.scope) !== scopeKey(record.scope) ||
              binding.generation !== record.generation ||
              !binding.nativeSession ||
              binding.nativeSession.length > 256 ||
              (record.nativeSession !== null && record.nativeSession !== binding.nativeSession)
            )
              throw new Error("Early native binding fenced");
            // Known native identity must survive a lost post-open settings reply.
            // This does not prove initialization, idle, completion or Running.
            record.nativeSession = binding.nativeSession;
            this.#save(entry);
          },
        });
        if (
          scopeKey(observed.run.scope) !== scopeKey(record.scope) ||
          observed.run.generation !== record.generation ||
          !observed.run.nativeSession
        )
          throw new Error("Native opening binding fenced");
        if (record.nativeSession !== null && observed.run.nativeSession !== record.nativeSession)
          throw new Error("Reopened native identity changed");
        record.nativeSession = observed.run.nativeSession;
        if (!record.stopRequested) {
          if (
            mode === "create" &&
            (observed.kind !== "created" ||
              observed.quiescent !== true ||
              observed.activity !== "idle")
          )
            throw new Error("Fresh creation quiescence unproved");
          if (mode === "reopen" && observed.kind !== "reopened")
            throw new Error("Reopening observation unproved");
          this.#observation(entry, observed);
          record.phase = "running";
        }
        return this.#result(entry, id, {
          opened: true,
          run: observed.run as unknown as Json,
          continuationAllowed: mode === "reopen",
        });
      } catch {
        if (record.phase !== "stopped") {
          record.phase = "uncertain";
          record.activity = "unknown";
        }
        return this.#settle(entry, id, { state: "unknown" });
      }
    });
    entry.openingTask = this.#own(entry, work);
    entry.revision++;
    this.#publish();
    return entry.openingTask;
  }
  send(
    scope: SessionScope,
    id: string,
    message: z.input<Message>,
    expectedRun: RunRef,
  ): Promise<Receipt> {
    const captured = copy(
      this.options.native.messageInput.parse(message) as Json,
    ) as z.output<Message>;
    return this.#control(
      scope,
      id,
      expectedRun,
      { type: "send", message: captured as Json },
      (entry, _original, run) =>
        this.options.native.send({
          capsule: entry.record.capsule!,
          run,
          originalId: id,
          message: captured,
        }),
    );
  }
  command(
    scope: SessionScope,
    id: string,
    command: z.input<Command>,
    expectedRun: RunRef,
  ): Promise<Receipt> {
    const parsed = copy(
      this.options.native.commandInput.parse(command) as Json,
    ) as z.output<Command>;
    return this.#control(
      scope,
      id,
      expectedRun,
      { type: "native", command: parsed as Json },
      (entry, original, run) =>
        this.options.native.command({
          capsule: entry.record.capsule!,
          run,
          originalId: id,
          original,
          command: parsed,
        }),
    );
  }
  #control(
    scope: SessionScope,
    id: string,
    expectedRun: RunRef,
    request: Json,
    effect: (entry: Entry, original: Original, run: RunRef) => Promise<NativeResult>,
  ): Promise<Receipt> {
    const target = structuredClone(expectedRun),
      entry = this.#entry(scope),
      admitted = this.options.journal.admit(scope, id, { run: target as unknown as Json, request });
    if (!admitted.fresh) return Promise.resolve(admitted.receipt);
    const running = () =>
      scopeKey(target.scope) === scopeKey(entry.record.scope) &&
      target.generation === entry.record.generation &&
      target.nativeSession === entry.record.nativeSession &&
      entry.record.phase === "running" &&
      !entry.record.stopRequested;
    if (!running())
      return Promise.resolve(this.#refuse(scope, id, "Native session is not running"));
    entry.record.activity = "unknown";
    return this.#start(entry, id, async () => {
      if (!running()) return this.#refuse(entry.record.scope, id, "Stopped before native dispatch");
      try {
        return this.#settle(
          entry,
          id,
          await effect(
            entry,
            {
              scope: admitted.receipt.scope,
              id: admitted.receipt.id,
              requestHash: admitted.receipt.requestHash,
            },
            target,
          ),
        );
      } catch {
        return this.#settle(entry, id, { state: "unknown" });
      }
    });
  }
  stop(scope: SessionScope, id: string, generation: number): Promise<Receipt> {
    const entry = this.#entry(scope),
      record = entry.record,
      admitted = this.options.journal.admit(
        scope,
        id,
        { type: "stop", generation },
        { priority: "stop" },
      );
    if (!admitted.fresh) return Promise.resolve(admitted.receipt);
    if (
      record.generation !== generation ||
      record.phase === "archived" ||
      record.phase === "archiving"
    )
      return Promise.resolve(this.#refuse(scope, id, "Session archived or archiving"));
    record.stopRequested = true;
    const alreadyStopped = record.phase === "stopped";
    if (!alreadyStopped) record.phase = "stopping";
    return this.#start(entry, id, async () => {
      try {
        if (!alreadyStopped) {
          const prepared = entry.acquisition ? await entry.acquisition : entry.prepared;
          if (record.phase === "stopped" && record.stopProof) {
            openingProof(
              record.capsule!,
              record.stopProof as unknown as import("../../runtime/contracts.js").OpeningStopProof,
            );
          } else if (record.capsule) {
            const proof =
              prepared && !("state" in prepared)
                ? await prepared.stop()
                : await this.options.native.stop(record.capsule);
            openingProof(record.capsule, proof);
            record.stopProof = copy(proof as unknown as Json);
          } else if (
            record.nativeAttempted ||
            (!entry.acquisition && record.workspaceAttempted && !record.workspace)
          )
            throw new Error("Native/workspace allocation outcome unproved");
        }
        record.phase = "stopped";
        record.activity = "idle";
        return this.#result(entry, id, { stopped: true });
      } catch {
        record.phase = "uncertain";
        record.activity = "unknown";
        return this.#settle(entry, id, { state: "unknown" });
      }
    });
  }
  archive(scope: SessionScope, id: string, generation: number): Promise<Receipt> {
    const entry = this.#entry(scope),
      admitted = this.options.journal.admit(scope, id, { type: "archive", generation });
    if (!admitted.fresh) return Promise.resolve(admitted.receipt);
    if (
      entry.record.generation !== generation ||
      entry.record.phase !== "stopped" ||
      entry.actual.size
    )
      return Promise.resolve(this.#refuse(scope, id, "Archive requires positive Stop"));
    if (entry.record.workspace?.ownership === "owned" && !this.options.workspace.release)
      return Promise.resolve(this.#refuse(scope, id, "Workspace release unsupported"));
    entry.record.phase = "archiving";
    return this.#start(entry, id, async () => {
      try {
        if (entry.record.workspace?.ownership === "owned")
          await this.options.workspace.release!(
            entry.record.workspace as WorkspaceAllocation<z.output<Data>>,
            { scope, originalId: id },
          );
        entry.record.phase = "archived";
        return this.#result(entry, id, { archived: true });
      } catch {
        entry.record.phase = "uncertain";
        return this.#settle(entry, id, { state: "unknown" });
      }
    });
  }
  readiness(): UpdateReadiness {
    if (this.#closing && !this.#closed)
      return { ready: false, reasons: ["Native resource close remains owned"] };
    if (
      this.#actual.size ||
      [...this.#entries.values()].some(
        ({ record }) => record.phase !== "stopped" && record.phase !== "archived",
      )
    )
      return { ready: false, reasons: ["Lifecycle retains native or unsettled work"] };
    return this.options.native.readiness();
  }
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    if (!this.readiness().ready) throw new Error("Lifecycle retains native or unsettled work");
    // Seal synchronously, before adapter cleanup's first await. A failure keeps
    // the exact owner and rejected close observable; it cannot release leases.
    this.#closing = Promise.resolve()
      .then(() => this.options.native.close())
      .then(() => {
        this.#closed = true;
        this.#listeners.clear();
        lifecycleWriters.delete(this.options.journal.writerIdentity);
        nativeOwners.delete(this.options.native);
      });
    return this.#closing;
  }
}
