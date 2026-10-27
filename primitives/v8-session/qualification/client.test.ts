import assert from "node:assert/strict";
import test from "node:test";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import type { Scope } from "../../v8-history/src/contracts/types.js";
import { FileWorkspace } from "../../v8-files/src/client/workspace.js";
import { MemoryDraftPersistence } from "../../v8-files/src/client/persistence.js";
import { SessionWorkspace } from "../src/client/workspace.js";
import { SessionError, scopeKey, type CopilotSelection, type Receipt, type SessionPort, type SessionScope, type SessionCommand, type Submit } from "../src/contracts/types.js";
import { ClientFixture } from "./client-fixture.js";
const a: SessionScope = { connection: "client", principal: "owner", host: "host", session: "a" }, b = { ...a, session: "b" };
const historyScope = (scope: SessionScope, attachment = "one", kind: "copilot" | "codex" = "copilot"): Scope => ({ kind, origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: `native-${scope.session}`, attachment }, ...(kind === "copilot" ? { agentId: null } : { threadId: `native-${scope.session}` }) }) as Scope;
function fixture(options: { maxOperations?: number; maxSessions?: number } = {}) {
  const history = new HistoryWorkspace({ connection: a.connection, principal: a.principal }); const port = new ClientFixture(); port.add(a); port.add(b);
  return { history, port, workspace: new SessionWorkspace({ history, port, ...options }) };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const receipt = (request: Submit, state: Receipt["state"] = "acknowledged"): Receipt => ({ scope: request.scope, id: request.id, type: request.command.type, generation: request.generation, state, outcome: { status: "accepted" } });
test('a lost committed submit reply automatically reads its exact original while native observations stay healthy', async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)), reads: string[] = [];
  port.receipt = async (scope, id) => { assert.deepEqual(scope, a); reads.push(id); return port.receipts.get(`${scopeKey(scope)}:${id}`) ?? null; };
  port.invoke = async request => {
    port.receipts.set(`${scopeKey(request.scope)}:${request.id}`, receipt(request));
    port.publish(a, { activity: 'working' });
    throw Error('lost committed response');
  };
  try {
    const original = workspace.request(a, { type: 'send', text: 'one original only' }, 'lost-response');
    await assert.rejects(original.result, /lost committed response/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.getSnapshot().operations[0]!.receipt?.state, 'acknowledged');
    assert.equal(entry.getSnapshot().connected, true); assert.equal(entry.getSnapshot().stale, false);
    assert.deepEqual(reads, [original.id]); assert.equal(port.submitted.length, 1);
    port.publish(a, { activity: 'idle' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [original.id], 'final originals need no further reconciliation');
  } finally { workspace.close(); }
});
test('healthy native revision pulses coalesce nonfinal exact receipt reads; null stays unknown without a timer or command replay', async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a));
  port.invoke = async request => receipt(request, 'outcomeUnknown');
  let reads = 0; port.receipt = async () => { reads++; return null; };
  try {
    const original = workspace.request(a, { type: 'send', text: 'nonfinal once' }); await original.result;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
    assert.equal(entry.getSnapshot().operations[0]!.receipt!.state, 'outcomeUnknown');
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(reads, 1, 'no timer/poller retries the read');
    const held = deferred<void>(), entered = deferred<void>();
    port.receipt = async (scope, id) => {
      assert.deepEqual(scope, a); assert.equal(id, original.id); reads++;
      if (reads === 2) { entered.resolve(); await held.promise; return receipt(original.request, 'outcomeUnknown'); }
      return receipt(original.request);
    };
    port.publish(a, { activity: 'working' }); await entered.promise;
    for (let index = 0; index < 20; index++) port.publish(a, { activity: 'working' });
    assert.equal(reads, 2, 'one actual read owns capacity throughout an observation burst');
    held.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.getSnapshot().operations[0]!.receipt!.state, 'acknowledged');
    assert.equal(reads, 3, 'one trailing sweep consumes the coalesced pulse after the held stale result');
    port.publish(a, { activity: 'idle' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 3);
    assert.equal(port.submitted.length, 1);
  } finally { workspace.close(); }
});
test('a third authoritative pulse during the second held receipt read cannot drop the final original settlement', async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a));
  const first = deferred<Receipt>(), second = deferred<Receipt>(), firstEntered = deferred<void>(), secondEntered = deferred<void>();
  let reads = 0, original: ReturnType<SessionWorkspace['request']> | undefined;
  port.invoke = async request => receipt(request, 'outcomeUnknown');
  port.receipt = async (value, id) => {
    assert.deepEqual(value, a); assert.equal(id, original!.id); reads++;
    if (reads === 1) { firstEntered.resolve(); return first.promise; }
    if (reads === 2) { secondEntered.resolve(); return second.promise; }
    return receipt(original!.request);
  };
  try {
    original = workspace.request(a, { type: 'send', text: 'only once across three pulses' }); await original.result; await firstEntered.promise;
    port.publish(a, { activity: 'working' }); first.resolve(receipt(original.request, 'outcomeUnknown')); await secondEntered.promise;
    port.publish(a, { activity: 'idle' }); second.resolve(receipt(original.request, 'outcomeUnknown'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.getSnapshot().operations[0]!.receipt?.state, 'acknowledged'); assert.equal(reads, 3);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(reads, 3, 'no request occurs without new input');
    assert.equal(entry.getSnapshot().activeJobs, 0); assert.equal(port.submitted.length, 1);
  } finally {
    if (original) { first.resolve(receipt(original.request, 'outcomeUnknown')); second.resolve(receipt(original.request, 'outcomeUnknown')); }
    workspace.close();
  }
});
test('an authoritative pulse at a completed receipt sweep handoff cannot join and disappear into the old read job', async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a));
  const first = deferred<Receipt>(), entered = deferred<void>(), pulsed = deferred<void>();
  let reads = 0, original: ReturnType<SessionWorkspace['request']> | undefined, off = () => {};
  port.invoke = async request => receipt(request, 'outcomeUnknown');
  port.receipt = async () => { reads++; if (reads === 1) { entered.resolve(); return first.promise; } return receipt(original!.request); };
  try {
    original = workspace.request(a, { type: 'send', text: 'only once at read handoff' }); await original.result; await entered.promise;
    const previous = entry.getSnapshot().operations[0]!.receipt; let queued = false;
    off = entry.subscribe(() => {
      if (!queued && entry.getSnapshot().operations[0]!.receipt !== previous) {
        queued = true;
        // The first hop precedes the sweep's await continuation; the second
        // follows its quiescence check but precedes the outer read cleanup.
        queueMicrotask(() => queueMicrotask(() => { port.publish(a, { activity: 'idle' }); pulsed.resolve(); }));
      }
    });
    first.resolve(receipt(original.request, 'outcomeUnknown')); await pulsed.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.getSnapshot().operations[0]!.receipt?.state, 'acknowledged'); assert.equal(reads, 2);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(reads, 2); assert.equal(port.submitted.length, 1); assert.equal(entry.getSnapshot().activeJobs, 0);
  } finally { if (original) first.resolve(receipt(original.request, 'outcomeUnknown')); off(); workspace.close(); }
});
test('a newly restored original at receipt sweep handoff is checked even without another native pulse', async () => {
  const history = new HistoryWorkspace({ connection: a.connection, principal: a.principal }), port = new ClientFixture(); port.add(a);
  const workspace = new SessionWorkspace({ history, port, receiptOwner: () => 'durable-owner' }), entry = await workspace.bind(a, historyScope(a));
  const first = workspace.receiptReference(a, 'first', 'send'), second = workspace.receiptReference(a, 'second', 'send');
  const result = (id: string, state: Receipt['state']): Receipt => ({ scope: a, id, type: 'send', generation: first.generation, state, outcome: { status: 'accepted' } });
  const held = deferred<Receipt>(), entered = deferred<void>(), restored = deferred<void>(), reads: string[] = [];
  let off = () => {};
  port.receipt = async (_scope, id) => { reads.push(id); if (reads.length === 1) { entered.resolve(); return held.promise; } return result(id, id === second.id ? 'acknowledged' : 'outcomeUnknown'); };
  try {
    workspace.restoreOriginals(a, [first]); await entered.promise;
    const native = entry.getSnapshot().native; let queued = false;
    off = entry.subscribe(() => {
      if (!queued && entry.getSnapshot().operations[0]!.receipt) {
        queued = true;
        queueMicrotask(() => queueMicrotask(() => { workspace.restoreOriginals(a, [second]); restored.resolve(); }));
      }
    });
    held.resolve(result(first.id, 'outcomeUnknown')); await restored.promise; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [first.id, first.id, second.id]);
    assert.deepEqual(entry.getSnapshot().operations.map(item => item.receipt?.state), ['outcomeUnknown', 'acknowledged']);
    assert.equal(entry.getSnapshot().native, native); assert.equal(port.submitted.length, 0); assert.equal(entry.getSnapshot().activeJobs, 0);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(reads.length, 3, 'unchanged unknown original does not poll');
  } finally { held.resolve(result(first.id, 'outcomeUnknown')); off(); workspace.close(); }
});
test('a retained receipt read outlives view unmount but cannot publish into a closed workspace', async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)), held = deferred<Receipt>(), entered = deferred<void>();
  port.invoke = async () => { throw Error('lost reply'); };
  port.receipt = async () => { entered.resolve(); return held.promise; };
  let changes = 0; const off = entry.subscribe(() => { changes++; });
  try {
    const original = workspace.request(a, { type: 'send', text: 'one retained original' }); await assert.rejects(original.result); await entered.promise;
    off(); assert.equal(entry.getSnapshot().activeJobs > 0, true, 'a mounted subscriber does not own the read lifetime');
    workspace.close(); const closedChanges = changes;
    held.resolve(receipt(original.request)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.getSnapshot().operations[0]!.receipt, null); assert.equal(entry.getSnapshot().activeJobs, 0); assert.equal(changes, closedChanges);
    assert.equal(port.submitted.length, 1);
  } finally { held.resolve(receipt(port.submitted[0]!)); off(); workspace.close(); }
});
test('automatic receipt reconciliation honors local read admission and the original durable owner after an await', async () => {
  const port = new ClientFixture(); port.add(a); const history = new HistoryWorkspace({ connection: a.connection, principal: a.principal });
  let owner = 'original-owner', read = true, calls = 0;
  const workspace = new SessionWorkspace({ history, port, receiptOwner: () => owner, admit: (_scope, action) => { if (action === 'read' && !read) throw new SessionError('FENCED'); } });
  const held = deferred<Receipt>(), entered = deferred<void>(); let original: ReturnType<SessionWorkspace['request']> | undefined;
  port.invoke = async () => { throw Error('lost reply'); };
  port.receipt = async () => { calls++; entered.resolve(); return held.promise; };
  try {
    const entry = await workspace.bind(a, historyScope(a)); original = workspace.request(a, { type: 'send', text: 'one protected original' });
    await assert.rejects(original.result); await entered.promise;
    owner = 'replacement-owner'; held.resolve(receipt(original.request)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.getSnapshot().operations[0]!.receipt, null, 'an old read cannot adopt another owner');
    read = false; port.publish(a, { activity: 'working' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    read = true; port.publish(a, { activity: 'working' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1, 'owner mismatch refuses before network');
    assert.equal(port.submitted.length, 1); assert.equal(entry.getSnapshot().activeJobs, 0);
  } finally { if (original) held.resolve(receipt(original.request)); workspace.close(); }
});
test('native MCP login actions honor current local admission and private link reads never become cached observations', async () => {
  for (const kind of ['codex', 'copilot'] as const) {
    const history = new HistoryWorkspace({ connection: a.connection, principal: a.principal }), native = new ClientFixture();
    const initial = native.add(a, kind); native.publish(a, { capabilities: { ...initial.capabilities, commands: [...initial.capabilities.commands, kind === 'codex' ? 'codex.mcp.login' : 'copilot.mcp.login'] } });
    let read = true, control = false, calls = 0, expectedOriginal = 'original-login', held: ReturnType<typeof deferred<void>> | undefined;
    const secret = 'https://owned.invalid/login?private-code=NOT-A-COMPOSITE-FACT', port: SessionPort = native;
    port.mcpLoginLink = async (run, originalId) => { assert.equal(run.nativeSession, 'native-a'); assert.equal(originalId, expectedOriginal); calls++; await held?.promise; return { state: 'available', status: 'initiated', authorizationUrl: secret, expiresInMs: 1000 }; };
    const workspace = new SessionWorkspace({ history, port, admit: (scope, action) => { assert.deepEqual(scope, a); if (!(action === 'read' ? read : control)) throw new SessionError('FENCED'); } });
    try {
      const entry = await workspace.bind(a, historyScope(a, 'login-test', kind)), agent = workspace.agent(a);
      if (agent.kind === 'unsupported') assert.fail('Expected native actions');
      assert.throws(() => agent.actions.loginMcp!('remote'), { code: 'FENCED' });
      await assert.rejects(agent.actions.mcpLoginLink!('original-login'), { code: 'FENCED' });
      assert.deepEqual(entry.getSnapshot().operations, []); assert.equal(native.submitted.length, 0); assert.equal(calls, 0);
      control = true;
      const original = agent.kind === 'codex' ? agent.actions.loginMcp!('remote') : agent.actions.loginMcp!('remote', true); await original.result;
      expectedOriginal = original.id;
      assert.equal(original.request.command.type, kind === 'codex' ? 'codex.mcp.login' : 'copilot.mcp.login');
      for (let i = 0; i < 2; i++) assert.equal((await agent.actions.mcpLoginLink!(expectedOriginal)).state, 'available');
      assert.equal(calls, 2, 'each explicit link read reaches the private port without a generic native-read cache');
      assert.deepEqual(entry.getSnapshot().nativeReads, []); assert.equal(JSON.stringify(entry.getSnapshot()).includes(secret), false);
      read = false; await assert.rejects(agent.actions.mcpLoginLink!(expectedOriginal), { code: 'FENCED' }); assert.equal(calls, 2);
      read = true; held = deferred<void>(); const pending = agent.actions.mcpLoginLink!(expectedOriginal);
      native.publish(a, { phase: 'stopped' }); held.resolve(); await assert.rejects(pending, { code: 'FENCED' });
      assert.equal(JSON.stringify(entry.getSnapshot()).includes(secret), false); assert.equal(native.submitted.length, 1);
      workspace.close(); await assert.rejects(agent.actions.mcpLoginLink!(expectedOriginal), { code: 'CLOSED' });
    } finally { held?.resolve(); workspace.close(); }
  }
});
test("read-only bind, A/B/A selection, mount cleanup, pins and reconnect preserve actual history owners with zero native effects", async () => {
  const { workspace, history, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)); await workspace.bind(b, historyScope(b));
  const first = workspace.select(a); entry.history.setDraft("retained history draft"); workspace.setDraft(a, { kind: "copilot", model: "next" }); workspace.setPinned(a, true);
  workspace.select(b); first.release(); workspace.setConnected(false);
  assert.equal(entry.getSnapshot().native!.phase, "running"); assert.equal(entry.getSnapshot().active, true); assert.equal(entry.getSnapshot().connected, false); assert.equal(entry.history.pinned, true);
  port.publish(a, { activity: "working" }); workspace.setConnected(true); await workspace.refresh(a); workspace.select(a);
  assert.equal(entry.history, history.session(historyScope(a))); assert.equal(entry.history.draft, "retained history draft"); assert.equal(entry.getSnapshot().draft!.model, "next"); assert.equal(entry.getSnapshot().stale, false);
  workspace.close(); assert.deepEqual(port.submitted, []);
});
test("draft and observed selection are independent of an older acknowledgement and lost viewer connection", async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)); const reply = deferred<Receipt>(); port.invoke = () => reply.promise;
  const agent = workspace.agent(a); assert.equal(agent.kind, "copilot"); if (agent.kind !== "copilot") throw new Error();
  const original = agent.actions.setModel!("requested", { effort: "high" }); workspace.setDraft(a, { kind: "copilot", model: "next-draft" });
  port.publish(a, { selection: { kind: "copilot", model: "native-newer", effort: null } }); workspace.setConnected(false);
  reply.resolve(receipt(original.request)); await original.result;
  assert.equal(entry.getSnapshot().native!.selection.model, "native-newer"); assert.equal(entry.getSnapshot().draft!.model, "next-draft"); assert.equal(entry.getSnapshot().operations[0]!.receipt!.state, "acknowledged");
  workspace.setConnected(true); await workspace.refresh(a); assert.equal(port.submitted.length, 1); assert.equal(entry.getSnapshot().operations[0]!.receipt!.state, "acknowledged");
});
test("public actions freeze original scope, input and sensitive answer before dispatch; history stores only identity marker", async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)); const mutableScope = { ...a }, selected: { kind: "copilot"; model: string } = { kind: "copilot", model: "original" };
  const send = workspace.request(mutableScope, { type: "send", text: "original text", selection: selected }); mutableScope.session = "b"; selected.model = "changed";
  await send.result; assert.equal(port.submitted[0]!.scope.session, "a"); assert.equal((port.submitted[0]!.command as { selection: CopilotSelection }).selection.model, "original");
  const body = { secret: "private-answer" }; const answer = workspace.request(a, { type: "answer", interactionId: "question", choice: "accept", value: body }); body.secret = "changed"; await answer.result;
  assert.equal((answer.request.command as unknown as { value: { secret: string } }).value.secret, "private-answer"); assert.equal(JSON.stringify(entry.history.operations).includes("private-answer"), false); assert.equal(Object.isFrozen(answer.request.command), true);
  const originals = entry.getSnapshot().operations.length;
  assert.throws(() => workspace.request(a, { type: "copilot.steer", text: "wrong harness", inputs: { kind: "codex", items: [] } } as unknown as SessionCommand), { code: "FENCED" });
  assert.equal(entry.getSnapshot().operations.length, originals, "Wrong-harness steering cannot retain an original");
});
test("new generation requires explicit history rebind; old action closures and old receipts remain fenced and retained", async () => {
  const { workspace, history, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)), oldHistory = entry.history, oldAgent = workspace.agent(a);
  const sent = workspace.request(a, { type: "send", text: "before" }); await sent.result;
  port.publish(a, { generation: 2, phase: "starting", activity: "unknown", nativeSession: null });
  assert.equal(entry.getSnapshot().active, true); assert.equal(entry.getSnapshot().requiresRebind, true);
  if (oldAgent.kind !== "copilot") throw new Error(); assert.throws(() => oldAgent.actions.stop(), { code: "FENCED" });
  assert.throws(() => workspace.request(a, { type: "send", text: "wrong attachment" }), { code: "FENCED" });
  port.publish(a, { phase: "running", nativeSession: "native-a" }); await workspace.rebind(a, historyScope(a, "two"));
  assert.equal(entry.history, oldHistory); assert.equal(history.size, 1); assert.equal(entry.history.operations[0]!.id, sent.id); assert.equal(entry.getSnapshot().operations[0]!.receipt!.id, sent.id);
  assert.equal(entry.getSnapshot().requiresRebind, false);
});
test("Stopping remains active through failed stop and only a later authoritative stopped observation changes it", async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a));
  port.invoke = async request => { port.publish(a, { phase: "stopping", activity: "unknown", stopRequested: true, issue: "stopUnconfirmed" }); return receipt(request, "outcomeUnknown"); };
  const agent = workspace.agent(a); if (agent.kind !== "copilot") throw new Error(); const stopped = agent.actions.stop(); await stopped.result;
  assert.equal(entry.getSnapshot().active, true); assert.equal(entry.getSnapshot().issue, "stopUnconfirmed"); workspace.setConnected(false); assert.equal(entry.getSnapshot().native!.phase, "stopping");
  port.publish(a, { phase: "stopped", issue: undefined } as unknown as Partial<ReturnType<ClientFixture["add"]>>);
  assert.equal(entry.getSnapshot().active, false); assert.equal(entry.getSnapshot().operations[0]!.receipt!.state, "outcomeUnknown"); assert.equal(port.submitted.length, 1);
});
test("an observed archive seal cannot disappear, change original or return to pending across observation incarnations", async () => {
  const { workspace, port } = fixture();
  try {
    const entry = await workspace.bind(a, historyScope(a));
    const sealed = port.publish(a, { phase: "stopped", archive: { id: "original-archive", state: "complete" } });
    const retained = entry.getSnapshot().native;
    const missing = { ...sealed }; delete missing.archive;
    for (const value of [missing, { ...sealed, archive: { id: "different", state: "complete" as const } }, { ...sealed, archive: { id: "original-archive", state: "pending" as const } }, { ...sealed, generation: sealed.generation + 1 }]) {
      port.snapshots.set(scopeKey(a), { ...value, epoch: sealed.epoch + 1, revision: 1 });
      await assert.rejects(workspace.refresh(a), { code: "FENCED" });
      assert.equal(entry.getSnapshot().native, retained);
    }
    assert.equal(port.submitted.length, 0);
  } finally { workspace.close(); }
});
test("session/operation capacity refuses without evicting and unresolved actual jobs stay occupied", async () => {
  const { workspace, port } = fixture({ maxOperations: 1, maxSessions: 1 }); const entry = await workspace.bind(a, historyScope(a)); await assert.rejects(workspace.bind(b, historyScope(b)), { code: "FULL" });
  const pending = deferred<Receipt>(); port.invoke = () => pending.promise; const first = workspace.request(a, { type: "send", text: "only original" }, "one");
  assert.throws(() => workspace.request(a, { type: "send", text: "new" }), { code: "FULL" }); workspace.setConnected(false); assert.equal(entry.getSnapshot().activeJobs, 1);
  assert.equal(workspace.request(a, { type: "send", text: "only original" }, "one"), first); pending.resolve(receipt(first.request)); await first.result;
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(entry.getSnapshot().activeJobs, 0); assert.equal(entry.getSnapshot().operations.length, 1); assert.equal(port.submitted.length, 1);
});
test("malformed/foreign snapshots and same-revision conflicts cannot overwrite retained known selection", async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)); const before = entry.getSnapshot().native!;
  const listener = [...port.listeners.get(scopeKey(a))!][0]!;
  listener({ ...before, scope: b, revision: 2 }); assert.equal(entry.getSnapshot().native, before); assert.equal(entry.getSnapshot().stale, true);
  listener({ ...before, selection: { kind: "codex" } }); assert.equal(entry.getSnapshot().native, before);
  listener({ ...before, activity: "working" }); assert.equal(entry.getSnapshot().native, before);
  await workspace.refresh(a); assert.equal(entry.getSnapshot().stale, false);
  await assert.rejects(workspace.bind({ ...a, session: "other" }, historyScope({ ...a, host: "wrong" })), { code: "FENCED" });
});
test("optional actual file workspace composition retains file draft through session switches without native calls", async () => {
  const { history, port } = fixture(); const files = new FileWorkspace({ history, persistence: new MemoryDraftPersistence(), port: { async call() { throw new Error("No upload was requested"); } } });
  const workspace = new SessionWorkspace({ history, port, files }); await workspace.bind(a, historyScope(a)); await workspace.bind(b, historyScope(b));
  const draft = await files.saveDraft({ ...a, session: "native-a" }, { name: "retained.txt", mediaType: "text/plain", blob: new Blob(["retained bytes"]) });
  workspace.select(a); workspace.select(b); workspace.setPinned(a, true); workspace.select(a); assert.equal(files.getSnapshot().records[0]!.manifest.id, draft.manifest.id); assert.deepEqual(port.submitted, []);
});
test("unknown/loading ownership remains active until an authoritative Stopped snapshot", async () => {
  const { workspace, port } = fixture(); const pending = deferred<ReturnType<ClientFixture["add"]>>();
  port.snapshot = () => pending.promise;
  const binding = workspace.bind(a, historyScope(a)), entry = workspace.control(a);
  assert.equal(entry.getSnapshot().native, null); assert.equal(entry.getSnapshot().active, true);
  pending.resolve(port.snapshots.get(scopeKey(a))!); await binding;
  assert.equal(entry.getSnapshot().active, true); assert.equal(entry.getSnapshot().native!.activity, "idle");
  port.publish(a, { phase: "stopped" }); assert.equal(entry.getSnapshot().active, false); assert.deepEqual(port.submitted, []);
});
test("a throwing subscriber cannot reject native state, suppress other listeners or occupy unlimited listeners", async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a)); let delivered = 0;
  const bad = entry.subscribe(() => { throw new Error("Broken renderer"); });
  const good = entry.subscribe(() => { delivered++; });
  port.publish(a, { activity: "working" }); assert.equal(delivered, 1); assert.equal(entry.getSnapshot().native!.activity, "working"); assert.equal(entry.getSnapshot().stale, false);
  workspace.setDraft(a, { kind: "copilot", model: "retained-next" }); assert.equal(delivered, 2);
  const releases = Array.from({ length: 126 }, () => entry.subscribe(() => {}));
  assert.throws(() => entry.subscribe(() => {}), { code: "FULL" });
  bad(); const replacement = entry.subscribe(() => {}); replacement(); good(); for (const release of releases) release();
  assert.equal(entry.getSnapshot().draft!.model, "retained-next");
});
test("durable observation incarnation supersedes high RAM revisions without regressing native generation or replaying originals", async () => {
  const { workspace, port } = fixture(); const entry = await workspace.bind(a, historyScope(a));
  workspace.setDraft(a, { kind: "copilot", model: "retained-draft" }); workspace.setPinned(a, true);
  const original = workspace.request(a, { type: "send", text: "original once" }); await original.result;
  const listener = [...port.listeners.get(scopeKey(a))!][0]!, first = entry.getSnapshot().native!;
  const high = { ...first, epoch: 1, revision: 500, activity: "working" as const }; listener(high);
  assert.equal(entry.getSnapshot().native!.revision, 500);
  const reopened = { ...high, epoch: 2, revision: 0, phase: "stopped" as const, activity: "idle" as const };
  port.snapshots.set(scopeKey(a), reopened); listener(reopened);
  assert.equal(entry.getSnapshot().native!.epoch, 2); assert.equal(entry.getSnapshot().native!.revision, 0); assert.equal(entry.getSnapshot().active, false);
  listener({ ...high, revision: 9000 }); assert.equal(entry.getSnapshot().native!.epoch, 2); assert.equal(entry.getSnapshot().active, false);
  listener({ ...reopened, epoch: 3, generation: 0 }); assert.equal(entry.getSnapshot().native!.epoch, 2); assert.equal(entry.getSnapshot().native!.generation, 1); assert.equal(entry.getSnapshot().stale, true);
  for (const epoch of [undefined, null, -1, 0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "3"]) {
    listener({ ...reopened, epoch, revision: 1 } as unknown as typeof reopened);
    assert.equal(entry.getSnapshot().native!.epoch, 2);
  }
  workspace.setConnected(false); workspace.setConnected(true); await workspace.refresh(a);
  assert.equal(entry.getSnapshot().stale, false); assert.equal(entry.getSnapshot().requiresRebind, false);
  assert.equal(entry.getSnapshot().draft!.model, "retained-draft"); assert.equal(entry.history.pinned, true);
  assert.equal(entry.getSnapshot().operations[0]!.receipt!.id, original.id); assert.equal(entry.getSnapshot().operations[0]!.receipt!.state, "acknowledged");
  assert.equal(port.submitted.length, 1);
});


test("recovery coalesces more than four unresolved originals and reads each receipt sequentially without replay", async () => {
  const { workspace, port } = fixture(); await workspace.bind(a, historyScope(a));
  port.invoke = async request => receipt(request, "outcomeUnknown");
  const originals = Array.from({ length: 7 }, (_, index) => workspace.request(a, { type: "send", text: `original-${index}` }, `original-${index}`)); await Promise.all(originals.map(original => original.result));
  const held = deferred<void>(), firstRead = deferred<void>(), byId = new Map(originals.map(original => [original.id, original.request])), reads: string[] = []; let active = 0, peak = 0;
  port.receipt = async (_scope, id) => { active++; peak = Math.max(peak, active); reads.push(id); try { if (active > 4) throw new SessionError("BUSY", "Four optional reads occupied"); if (reads.length === 1) { firstRead.resolve(); await held.promise; } return receipt(byId.get(id)!); } finally { active--; } };
  try {
    workspace.setConnected(false); workspace.setConnected(true); const recovery = workspace.reobserve(a), duplicate = workspace.reobserve(a); assert.equal(recovery, duplicate); await firstRead.promise;
    assert.equal(reads.length, 1); assert.equal(active, 1); held.resolve(); await Promise.all([recovery, duplicate]);
    assert.deepEqual(reads, originals.map(original => original.id)); assert.equal(peak, 1); assert.equal(port.submitted.length, 7); assert.equal(workspace.control(a).getSnapshot().operations.every(value => value.receipt?.state === "acknowledged"), true);
    await workspace.reobserve(a); assert.equal(reads.length, 7); assert.equal(port.submitted.length, 7);
  } finally { held.resolve(); workspace.close(); }
});

test("explicit native reads remain retained across selection, coalesce held IO, preserve stale facts, and fence stopped generations without a poller", async () => {
  const { workspace, port } = fixture();
  port.add(a, "copilot"); port.add(b, "copilot");
  port.publish(a, { capabilities: { commands: ["send"], fullStop: true, createAndWait: true, reopen: true, reads: ["copilot.queue", "copilot.task.progress"] } });
  await workspace.bind(a, historyScope(a)); await workspace.bind(b, historyScope(b));
  const gate = deferred<import("../src/contracts/types.js").NativeReadResult>(); let calls = 0;
  port.nativeRead = async () => { calls++; return gate.promise; };
  const agent = workspace.agent(a); assert.equal(agent.kind, "copilot"); if (agent.kind !== "copilot") throw Error("wrong host");
  const pending = agent.actions.read!({ type: "copilot.queue" }), duplicate = agent.actions.read!({ type: "copilot.queue" });
  const first = workspace.select(a); first.release(); const other = workspace.select(b); other.release(); const again = workspace.select(a); again.release();
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(workspace.control(a).getSnapshot().nativeReads[0]?.state, "loading");
  const run = { scope: a, generation: 1, nativeSession: `native-${a.session}` };
  gate.resolve({ run, type: "copilot.queue", items: [{ id: "native-queued", kind: "message", displayText: "retained", agentMode: "interactive" }], steeringMessages: [] });
  await Promise.all([pending, duplicate]); assert.equal(workspace.control(a).getSnapshot().nativeReads[0]?.state, "available");
  workspace.setConnected(false); assert.equal(workspace.control(a).getSnapshot().nativeReads[0]?.stale, true);
  assert.equal(workspace.control(a).getSnapshot().nativeReads[0]?.value?.type, "copilot.queue");
  workspace.setConnected(true); await workspace.refresh(a); assert.equal(calls, 1, "reconnect does not implicitly read native queue");
  const late = deferred<import("../src/contracts/types.js").NativeReadResult>(); port.nativeRead = async () => { calls++; return late.promise; };
  const current = workspace.agent(a); if (current.kind !== "copilot") throw Error("wrong host");
  const old = current.actions.read!({ type: "copilot.task.progress", id: "exact-task" });
  await assert.rejects(current.actions.read!({ type: "copilot.task.progress", id: "replacement-task" }), (error: unknown) => error instanceof SessionError && error.code === "BUSY");
  await Promise.resolve(); port.publish(a, { generation: 2, phase: "stopped" });
  late.resolve({ run, type: "copilot.task.progress", id: "exact-task", progress: null });
  await assert.rejects(old, (error: unknown) => error instanceof SessionError && error.code === "FENCED");
  assert.ok(workspace.control(a).getSnapshot().nativeReads.every(value => value.stale));
  const entry = workspace.control(a); workspace.close(); assert.deepEqual(entry.getSnapshot().nativeReads, []);
});

test('failed subscription acquisition can retry, while later snapshot failure preserves the acquired observer and retained draft', async () => {
  const { workspace, port } = fixture(), subscribe = port.subscribe.bind(port), snapshot = port.snapshot.bind(port);
  let acquisitions = 0;
  port.subscribe = (...args) => { if (++acquisitions === 1) throw new SessionError('FULL'); return subscribe(...args); };
  try {
    await assert.rejects(workspace.prepare(a, 'copilot'), { code: 'FULL' });
    const entry = await workspace.prepare(a, 'copilot');
    assert.equal(acquisitions, 2); assert.equal(port.listeners.get(scopeKey(a))!.size, 1);
    workspace.setDraft(a, { kind: 'copilot', model: 'retained-next-intent' });
    port.snapshot = async () => { throw new SessionError('IO'); };
    await assert.rejects(workspace.prepare(a, 'copilot'), { code: 'IO' });
    port.publish(a, { activity: 'working' });
    assert.equal(entry.getSnapshot().native!.activity, 'working');
    assert.deepEqual(entry.getSnapshot().draft, { kind: 'copilot', model: 'retained-next-intent' });
    port.snapshot = snapshot;
    assert.equal(await workspace.prepare(a, 'copilot'), entry);
    assert.equal(acquisitions, 2, 'a failed snapshot read does not reacquire an owned subscription');
    assert.equal(port.submitted.length, 0);
  } finally { workspace.close(); }
});

test('close during synchronous subscription acquisition immediately retires the returned observer', async () => {
  const { workspace, port } = fixture(), subscribe = port.subscribe.bind(port);
  let releases = 0, release: (() => void) | undefined;
  port.subscribe = (...args) => { release = subscribe(...args); workspace.close(); return () => { releases++; release!(); }; };
  try {
    await assert.rejects(workspace.prepare(a, 'copilot'), { code: 'CLOSED' });
    assert.equal(releases, 1); assert.equal(port.listeners.get(scopeKey(a))!.size, 0);
    workspace.close(); assert.equal(releases, 1); assert.equal(port.submitted.length, 0);
  } finally { release?.(); workspace.close(); }
});

test('close invalidates every retained entry and attempts every release, retaining only failed exact cleanup for explicit retry', async () => {
  const { workspace, port } = fixture(), subscribe = port.subscribe.bind(port), acquired: (() => void)[] = [];
  let firstCalls = 0, secondCalls = 0, fail = true;
  port.subscribe = (scope, listener) => {
    const release = subscribe(scope, listener); acquired.push(release);
    return () => {
      if (scope.session === a.session) {
        firstCalls++;
        assert.equal(second.getSnapshot().connected, false, 'all entries retire before an external release runs');
        assert.equal(second.getSnapshot().stale, true);
        if (fail) throw Error('SCRIPTED_RELEASE_FAILED');
      } else secondCalls++;
      release();
    };
  };
  const first = await workspace.prepare(a, 'copilot'), second = await workspace.prepare(b, 'copilot');
  const off = first.subscribe(() => { assert.equal(second.getSnapshot().connected, false); assert.equal(second.getSnapshot().stale, true); });
  try {
    assert.throws(() => workspace.close(), AggregateError);
    assert.equal(first.getSnapshot().connected, false); assert.equal(first.getSnapshot().stale, true);
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 1);
    assert.equal(port.listeners.get(scopeKey(a))!.size, 1); assert.equal(port.listeners.get(scopeKey(b))!.size, 0);
    fail = false; workspace.close(); workspace.close();
    assert.equal(firstCalls, 2); assert.equal(secondCalls, 1);
    assert.equal(port.listeners.get(scopeKey(a))!.size, 0); assert.equal(port.submitted.length, 0);
  } finally { off(); fail = false; for (const release of acquired) release(); workspace.close(); }
});


test('settled Activity is recent, unresolved originals stay protected, and Stop bypasses ordinary local pressure', async () => {
  const { workspace, port } = fixture({ maxOperations: 1 });
  try {
    const entry = await workspace.bind(a, historyScope(a));
    const first = workspace.request(a, { type: 'send', text: 'first' }, 'first'); await first.result;
    for (let i = 0; i < 40; i++) await workspace.request(a, { type: 'send', text: 'next' }, `later-${i}`).result;
    assert.equal(entry.getSnapshot().operations.length, 32); assert.equal(entry.getSnapshot().operations.some(op => op.original.id === 'first'), false);
    assert.equal((await first.result).state, 'acknowledged', 'an evicted handle remains inert');
    port.invoke = async request => receipt(request, request.command.type === 'stop' ? 'acknowledged' : 'outcomeUnknown');
    await workspace.request(a, { type: 'send', text: 'unknown' }, 'unknown').result;
    assert.throws(() => workspace.request(a, { type: 'send', text: 'overflow' }, 'overflow'), { code: 'FULL' });
    assert.equal((await workspace.request(a, { type: 'stop' }, 'urgent').result).state, 'acknowledged');
    assert.equal(entry.getSnapshot().operations.some(op => op.original.id === 'unknown' && op.receipt?.state === 'outcomeUnknown'), true);
    assert.equal(entry.history.operations.filter(op => !op.settled).length, 1);
  } finally { workspace.close(); }
});


test('composer protected terminal originals survive Activity trimming; evicted references stay read-only across generations', async () => {
  const port = new ClientFixture(); port.add(a);
  const history = new HistoryWorkspace({ connection: a.connection, principal: a.principal });
  const protectedIds = new Set(['protected', 'protected-second']); let owner = 'durable-owner';
  const workspace = new SessionWorkspace({ port, history, maxOperations: 2, receiptOwner: () => owner, protectOriginal: ref => protectedIds.has(ref.id) });
  try {
    const entry = await workspace.bind(a, historyScope(a)), reference = workspace.receiptReference(a, 'protected', 'send');
    await workspace.request(a, { type: 'send', text: 'protected body' }, 'protected').result;
    await workspace.request(a, { type: 'send', text: 'second protected' }, 'protected-second').result;
    assert.throws(() => workspace.request(a, { type: 'send', text: 'protected capacity full' }, 'protected-overflow'), { code: 'FULL' });
    assert.equal((await workspace.request(a, { type: 'stop' }, 'protected-stop').result).state, 'acknowledged');
    protectedIds.delete('protected-second');
    for (let i = 0; i < 40; i++) await workspace.request(a, { type: 'send', text: 'later' }, `recent-${i}`).result;
    assert.equal(entry.getSnapshot().operations.length, 33);
    assert.equal(entry.getSnapshot().operations.some(op => op.original.id === 'protected'), true);
    protectedIds.clear(); await workspace.request(a, { type: 'send', text: 'released' }, 'released').result;
    assert.equal(entry.getSnapshot().operations.length, 32);
    assert.equal(entry.getSnapshot().operations.some(op => op.original.id === 'protected'), false);
    port.publish(a, { generation: 2 }); const submitted = port.submitted.length;
    assert.equal((await workspace.checkOriginal(reference))?.state, 'acknowledged');
    assert.equal(port.submitted.length, submitted); assert.equal(entry.getSnapshot().operations.length, 32);
    await assert.rejects(workspace.checkOriginal({ ...reference, generation: 2 }), { code: 'FENCED' });
    owner = 'foreign-owner'; await assert.rejects(workspace.checkOriginal(reference), { code: 'FENCED' });
    assert.equal(port.submitted.length, submitted);
  } finally { workspace.close(); }
});
