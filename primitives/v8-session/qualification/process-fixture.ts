import { codexProtocol } from "../../v8-harness-codex/src/protocol.js";
import { copilotProtocol } from "../../v8-harness-copilot/src/protocol.js";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { copy } from "../src/contracts/validation.js";
import { sameRun, SessionError, type Catalog, type Harness, type NativeEvent, type NativePort, type NativeRun, type NativeStart, type Placement, type RunRef, type Selection, type StopProof } from "../src/contracts/types.js";

type Reply = { request?: number; ok?: boolean; roots?: string[]; rss?: number; type?: string; id?: string; pid?: number; child?: { pid: number } };
const ownedPools = new Set<FixturePool>();
function cleanupOwned(): void { for (const pool of ownedPools) { const pid = pool.child.pid; if (pid && pid > 1 && pid !== process.pid) { try { process.kill(-pid, "SIGKILL"); } catch {} } } }
process.once("exit", cleanupOwned);
process.once("SIGTERM", () => { cleanupOwned(); process.exit(143); });
/** Tracks only processes created by this fixture, never a service or existing session. */
export class FixturePool {
  readonly child: ChildProcess;
  readonly pids = new Set<number>();
  readonly #pending = new Map<number, { resolve(value: Reply): void; reject(error: unknown): void }>();
  readonly #stops = new Map<string, { promise: Promise<void>; resolve(): void }>();
  #serial = 0;
  #exited = false;
  readonly exited: Promise<void>;
  private constructor() {
    this.child = spawn(process.execPath, [fileURLToPath(new URL("./process-worker.js", import.meta.url)), "pool"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} });
    ownedPools.add(this);
    this.exited = new Promise(resolve => this.child.once("exit", () => {
      this.#exited = true;
      for (const pending of this.#pending.values()) pending.reject(new Error("Owned fixture exited")); this.#pending.clear();
      resolve();
    }));
    this.child.on("message", (raw: unknown) => {
      const value = raw as Reply;
      if (value.pid) this.pids.add(value.pid); if (value.child?.pid) this.pids.add(value.child.pid);
      if (value.type === "stopped" && value.id) this.#stops.get(value.id)?.resolve();
      if (typeof value.request === "number") {
        const pending = this.#pending.get(value.request); this.#pending.delete(value.request);
        if (value.ok) pending?.resolve(value); else pending?.reject(new Error("Fixture operation refused"));
      }
    });
  }
  static async open(): Promise<FixturePool> {
    if (process.platform !== "linux") throw new SessionError("UNSUPPORTED", "Linux disposable process fixture only");
    const pool = new FixturePool();
    await new Promise<void>((resolve, reject) => { pool.child.once("message", () => resolve()); pool.child.once("error", reject); });
    return pool;
  }
  call(type: string, id = "", tools = false): Promise<Reply> {
    if (this.#exited) return Promise.reject(new Error("Fixture closed"));
    if (this.#pending.size >= 32) return Promise.reject(new Error("Fixture capacity"));
    const request = ++this.#serial;
    return new Promise((resolve, reject) => {
      this.#pending.set(request, { resolve, reject });
      this.child.send({ type, id, request, tools }, error => { if (error) { this.#pending.delete(request); reject(error); } });
    });
  }
  stop(id: string): Promise<void> {
    const previous = this.#stops.get(id); if (previous) return previous.promise;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.#stops.set(id, { promise, resolve });
    // The worker emits stopped only after its exact tool/grandchild shutdown.
    void this.call("stop", id).catch(() => {}); return promise;
  }
  async forceOwnGroup(): Promise<void> {
    if (this.#exited && !(await Promise.all([...this.pids].map(executing))).some(Boolean)) { ownedPools.delete(this); return; }
    const pid = this.child.pid;
    if (!pid || pid === process.pid || pid <= 1) throw new Error("Missing owned fixture process capability");
    // detached:true established THIS spawned child's process group, not its parent unit.
    try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await this.exited;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await Promise.all([...this.pids].map(executing))).some(Boolean)) { ownedPools.delete(this); for (const stop of this.#stops.values()) stop.resolve(); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Owned fixture descendants still executing");
  }
  async close(): Promise<void> {
    if (!this.#exited) { await this.call("close"); await this.exited; }
    if ((await Promise.all([...this.pids].map(executing))).some(Boolean)) await this.forceOwnGroup();
    ownedPools.delete(this);
  }
}
export async function executing(pid: number): Promise<boolean> {
  try { const text = await readFile(`/proc/${pid}/stat`, "utf8"); return text.slice(text.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; }
  catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}

/** Synthetic native port around real owned Node processes. NOT Codex/Copilot acceptance. */
export class ProcessFixturePort implements NativePort {
  get protocol() { return this.kind === "codex" ? codexProtocol : copilotProtocol; }
  readonly capabilities;
  readonly handles = new Map<number, NativeRun>();
  starts = 0; stops = 0; invokes = 0; inspections = 0;
  constructor(readonly kind: Harness, readonly placement: Placement, readonly pool: FixturePool, readonly tools = true) {
    this.capabilities = copy({ fullStop: true, createAndWait: true, reopen: true, commands: ["send", "answer", ...(kind === "codex" ? ["codex.defaults", "codex.turn", "codex.interrupt"] as const : ["copilot.model", "copilot.mode", "copilot.permissions", "copilot.abort"] as const)] as const });
  }
  async start(input: NativeStart, emit: (event: NativeEvent) => void): Promise<NativeRun> {
    this.starts++;
    const run: RunRef = copy({ scope: input.scope, generation: input.generation, nativeSession: input.nativeSession ?? `fixture-${input.scope.session}` });
    const id = JSON.stringify([input.scope.session, input.generation]);
    await this.pool.call("start", id, this.tools);
    const selection: Selection = input.selection ?? (this.kind === "codex" ? { kind: "codex", model: "fixture-model", effort: "low" } : { kind: "copilot", model: "fixture-model", providerId: "fixture", effort: "low", mode: "interactive", permissions: "manual" });
    let stopping: Promise<StopProof> | undefined;
    const handle: NativeRun = {
      run, selection, interactionsComplete: true, interactions: [],
      stop: () => {
        if (stopping) return stopping;
        this.stops++;
        stopping = (async () => {
          if (this.placement === "dedicated") {
            const graceful = await Promise.race([this.pool.stop(id).then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 250))]);
            if (!graceful) await this.pool.forceOwnGroup();
          } else await this.pool.stop(id);
          if (this.placement === "dedicated") await this.pool.close();
          const proof: StopProof = copy({ run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true });
          emit({ run, type: "stopped", proof }); return proof;
        })(); return stopping;
      },
      invoke: async () => { this.invokes++; return { status: "accepted" }; },
    };
    emit({ run, type: "activity", activity: "idle" });
    this.handles.set(run.generation, handle); return handle;
  }
  async inspect(run: RunRef): Promise<NativeRun | null> { this.inspections++; const value = this.handles.get(run.generation); return value && sameRun(value.run, run) ? value : null; }
  async catalog(): Promise<Catalog> { return { available: true, choices: [{ model: "fixture-model", providerId: "fixture", efforts: ["low", "medium"] }] }; }
}

export async function compareScaffolding(): Promise<readonly unknown[]> {
  const started = performance.now(), rows: unknown[] = [];
  for (const placement of ["shared", "dedicated"] as const) for (const roots of [1, 4]) for (let repetition = 0; repetition < 2; repetition++) {
    if (performance.now() - started > 600000) throw new Error("Comparison ten-minute ceiling");
    const pools: FixturePool[] = [];
    try {
      const before = performance.now();
      for (let i = 0; i < (placement === "shared" ? 1 : roots); i++) pools.push(await FixturePool.open());
      for (let i = 0; i < roots; i++) await pools[placement === "shared" ? 0 : i]!.call("start", String(i));
      const startMs = performance.now() - before;
      const stats = await Promise.all(pools.map(pool => pool.call("stats")));
      const rssBytes = stats.reduce((sum, row) => sum + (row.rss ?? 0), 0);
      if (rssBytes > 2 * 1024 ** 3) throw new Error("Comparison two-GiB ceiling");
      const stopping = performance.now(); for (let i = 0; i < roots; i++) await pools[placement === "shared" ? 0 : i]!.stop(String(i));
      for (const pool of pools) await pool.close();
      rows.push({ placement, roots, repetition, startMs, stopMs: performance.now() - stopping, rssBytes, processes: pools.length, boundary: "synthetic Node fixture only; no native performance claim" });
    } finally { for (const pool of pools) await pool.forceOwnGroup(); }
  }
  return rows;
}
