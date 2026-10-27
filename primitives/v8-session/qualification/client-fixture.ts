import { scopeKey, type RunRef, type NativeRead, type NativeReadResult, type Receipt, type SessionPort, type SessionScope, type SessionSnapshot, type Submit } from "../src/contracts/types.js";
import { copy } from "../src/contracts/validation.js";
/** Scripted browser/client facts only; no claim of native stop, journal or process proof. */
export class ClientFixture implements SessionPort {
  readonly snapshots = new Map<string, SessionSnapshot>(); readonly receipts = new Map<string, Receipt>();
  readonly listeners = new Map<string, Set<(snapshot: SessionSnapshot) => void>>();
  readonly submitted: Submit[] = []; readonly reads: string[] = [];
  nativeRead: ((run: RunRef, request: NativeRead) => Promise<NativeReadResult>) | undefined;
  async read(run: RunRef, request: NativeRead): Promise<NativeReadResult> { if (!this.nativeRead) throw new Error("Scripted read unavailable"); return this.nativeRead(run, request); }
  invoke: ((request: Submit) => Promise<Receipt>) | undefined;
  add(scope: SessionScope, kind: "codex" | "copilot" = "copilot"): SessionSnapshot {
    const snapshot: SessionSnapshot = { scope, kind, placement: "shared", epoch: 1, revision: 1, generation: 1, phase: "running", activity: "idle", nativeSession: `native-${scope.session}`, stopRequested: false,
      selection: kind === "copilot" ? { kind, model: "original", providerId: "copilot", effort: "low", mode: "interactive", permissions: "manual" } : { kind, model: "original", effort: "low" },
      interactionsComplete: true, interactions: [], capabilities: { commands: kind === "copilot" ? ["send", "answer", "copilot.model", "copilot.mode", "copilot.permissions", "copilot.abort"] : ["send", "answer", "codex.defaults", "codex.turn", "codex.interrupt"], fullStop: true, createAndWait: true, reopen: true } };
    this.snapshots.set(scopeKey(scope), copy(snapshot)); return snapshot;
  }
  publish(scope: SessionScope, patch: Partial<SessionSnapshot>): SessionSnapshot {
    const prior = this.snapshots.get(scopeKey(scope))!; const changed = { ...prior, ...patch, revision: prior.revision + 1 };
    if (changed.issue === undefined) delete changed.issue;
    const snapshot = copy(changed);
    this.snapshots.set(scopeKey(scope), snapshot); for (const listener of this.listeners.get(scopeKey(scope)) ?? []) listener(snapshot); return snapshot;
  }
  async snapshot(scope: SessionScope): Promise<SessionSnapshot> { this.reads.push("snapshot"); return this.snapshots.get(scopeKey(scope))!; }
  async submit(request: Submit): Promise<Receipt> {
    request = copy(request); this.submitted.push(request);
    const receipt: Receipt = this.invoke ? await this.invoke(request) : { scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state: "acknowledged", outcome: { status: "accepted" } };
    this.receipts.set(`${scopeKey(request.scope)}:${request.id}`, receipt); return receipt;
  }
  async receipt(scope: SessionScope, id: string): Promise<Receipt | null> { this.reads.push("receipt"); return this.receipts.get(`${scopeKey(scope)}:${id}`) ?? null; }
  subscribe(scope: SessionScope, listener: (snapshot: SessionSnapshot) => void): () => void {
    const key = scopeKey(scope), listeners = this.listeners.get(key) ?? new Set(); this.listeners.set(key, listeners); listeners.add(listener); return () => { listeners.delete(listener); };
  }
}
