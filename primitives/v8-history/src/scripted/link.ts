import { canonical, deepFreeze, invariant } from "../contracts/validation.js";
import type { Cursor, Json, Scope } from "../contracts/types.js";
import type { HistorySubscription } from "../host/history-owner.js";
import { HistoryHub } from "../host/history-owner.js";
import { HistoryWorkspace } from "../client/workspace.js";
import { scopeKey } from "../contracts/identity.js";

export type ScriptedReceipt = Readonly<{ id: string; accepted: true; nativeRequestId: string }>;
/** Qualification fixture only: a Host-owned action ledger, deliberately separate from history. */
export class ScriptedActionOwner {
  readonly #requests = new Map<string, { meaning: string; receipt: ScriptedReceipt }>();
  submitted = 0;
  checked = 0;
  constructor(readonly scope: Scope, readonly maxRequests = 32) {
    invariant(Number.isSafeInteger(maxRequests) && maxRequests > 0 && maxRequests <= 128, "SCRIPT_LIMIT");
  }
  submit(id: string, intent: Json): ScriptedReceipt {
    invariant(id.length > 0 && id.length <= 256, "ORIGINAL_REQUEST_ID"); const meaning = canonical(intent);
    const old = this.#requests.get(id);
    if (old) { invariant(old.meaning === meaning, "ORIGINAL_REQUEST_CONFLICT"); return old.receipt; }
    invariant(this.#requests.size < this.maxRequests, "SCRIPT_ACTION_CAPACITY");
    this.submitted++;
    const receipt = deepFreeze({ id, accepted: true as const, nativeRequestId: `scripted-${this.submitted}` });
    this.#requests.set(id, { meaning, receipt }); return receipt;
  }
  check(scope: Scope, id: string): ScriptedReceipt | null {
    invariant(scopeKey(scope) === scopeKey(this.scope), "FOREIGN_RECEIPT_SCOPE"); this.checked++;
    return this.#requests.get(id)?.receipt ?? null;
  }
}

/** A lossy browser link to a persistent Host, never a catalog/native owner or a real transport. */
export class ScriptedLink {
  #stream: HistorySubscription | undefined;
  #cursor: Cursor | undefined;
  connected = false;
  deliveries = 0;
  retainedSnapshots = 0;
  readonly counters = { nativeBodyReads: 0, nativeMetadataReads: 0, nativeStops: 0 };
  constructor(readonly hub: HistoryHub, readonly workspace: HistoryWorkspace, readonly scope: Scope) {}
  connect(): void {
    invariant(!this.connected, "ALREADY_CONNECTED");
    this.#stream = this.hub.watch(this.scope, this.#cursor); this.connected = true;
    this.workspace.setConnected(true); this.flush();
  }
  flush(): void {
    invariant(this.connected && this.#stream, "BROWSER_OFFLINE");
    const client = this.workspace.session(this.scope).client;
    for (const frame of this.#stream.drain()) {
      const result = client.apply(frame); invariant(result !== "needsSnapshot", "UNEXPECTED_REPLAY_GAP");
      this.deliveries++; if (frame.kind === "snapshot") this.retainedSnapshots++;
    }
    if (client.current) this.#cursor = { generation: client.current.generation, revision: client.current.revision };
  }
  async disconnect(): Promise<void> {
    await this.#stream?.return(); this.#stream = undefined; this.connected = false; this.workspace.setConnected(false);
  }
  loseCursor(): void { invariant(!this.connected, "BROWSER_STILL_CONNECTED"); this.#cursor = undefined; }
  send(owner: ScriptedActionOwner, id: string, intent: Json, loseReply = false): void {
    invariant(this.connected, "BROWSER_OFFLINE"); invariant(scopeKey(owner.scope) === scopeKey(this.scope), "FOREIGN_SEND_SCOPE");
    const session = this.workspace.session(this.scope); session.recordOperation(id, intent);
    const receipt = owner.submit(id, intent);
    // A transport timeout cannot know whether the original reached the Host.
    session.observeOperation(id, loseReply ? { state: "unobserved" } : { state: "accepted", receipt: { ...receipt } }, !loseReply);
  }
  checkOriginal(owner: ScriptedActionOwner, id: string): void {
    invariant(this.connected, "BROWSER_OFFLINE");
    const receipt = owner.check(this.scope, id);
    if (receipt) this.workspace.session(this.scope).observeOperation(id, { state: "accepted", receipt: { ...receipt } }, true);
  }
}
