import assert from "node:assert/strict";
import test from "node:test";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { SessionWorkspace, type OriginalReceiptReference } from "../src/client/workspace.js";
import { scopeKey, type Receipt } from "../src/contracts/types.js";
import { ClientFixture } from "./client-fixture.js";

const scope = { connection: "client", principal: "owner", host: "host", session: "a" };
const attached = { kind: "codex" as const, origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: "native-a", attachment: "observed" }, threadId: "native-a" };
const history = (capacity = 128) => new HistoryWorkspace({ connection: scope.connection, principal: scope.principal, maxOperationsPerSession: capacity });

test("reload restores an inert exact original across run changes; owner changes fence lookup before IO and a stored reference can never submit", async () => {
  const port = new ClientFixture(); port.add(scope, "codex"); let owner = "authority/host-owner";
  const first = new SessionWorkspace({ port, history: history(), receiptOwner: () => owner });
  await first.bind(scope, attached);
  port.invoke = async request => {
    const receipt: Receipt = { scope, id: request.id, generation: request.generation, type: "send", state: "acknowledged", outcome: { status: "accepted" } };
    port.receipts.set(`${scopeKey(scope)}:${request.id}`, receipt); throw Error("original reply lost after native acceptance");
  };
  const operation = first.request(scope, { type: "send", text: "private-original-body" }, "original-send");
  await assert.rejects(operation.result);
  const references = JSON.parse(JSON.stringify(first.originalReferences(scope))) as readonly OriginalReceiptReference[];
  assert.equal(JSON.stringify(references).includes("private-original-body"), false);
  assert.equal(references[0]!.generation, 1); assert.equal(first.control(scope).getSnapshot().operations[0]!.transmission, "unavailable");
  first.close(); port.invoke = undefined; port.publish(scope, { generation: 2 });
  const second = new SessionWorkspace({ port, history: history(), receiptOwner: () => owner });
  try {
    const entry = await second.bind(scope, attached);
    const native = entry.getSnapshot().native;
    const wrong = { ...references[0]!, id: "other", owner: "different-authority/owner" };
    assert.throws(() => second.restoreOriginals(scope, [references[0]!, wrong]), { code: "FENCED" });
    assert.equal(entry.getSnapshot().operations.length, 0); assert.equal(entry.history.operations.length, 0);
    second.restoreOriginals(scope, references); second.restoreOriginals(scope, references);
    assert.equal(entry.getSnapshot().operations.length, 1); assert.equal(entry.getSnapshot().operations[0]!.request, null);
    assert.equal(entry.history.operations.length, 1);
    assert.throws(() => second.request(scope, { type: "send", text: "private-original-body" }, "original-send"), { code: "CONFLICT" });
    assert.throws(() => second.request(scope, { type: "send", text: "new" }, "new-original", 1), { code: "FENCED" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.getSnapshot().operations[0]!.receipt?.state, 'acknowledged', 'quiet restored originals reconcile without Check, a new snapshot or reconnect');
    assert.equal(entry.getSnapshot().native, native, 'receipt observation does not change current generation or selection');
    assert.equal(entry.getSnapshot().operations[0]!.original.generation, 1); assert.equal(entry.history.operations[0]!.settled, true);
    assert.equal(port.submitted.length, 1, "reload and exact lookup never replay the Send");
    const reads = port.reads.length; owner = "authority/replacement-host-owner";
    await assert.rejects(second.checkReceipt(scope, "original-send"), { code: "FENCED" });
    assert.throws(() => second.originalReferences(scope), { code: "FENCED" });
    assert.equal(port.reads.length, reads, "a new owner cannot receive the old receipt query");
  } finally { second.close(); }
});

test("reference restore validates the entire batch and shared history capacity before retaining any original", async () => {
  const port = new ClientFixture(); port.add(scope, "codex");
  const workspace = new SessionWorkspace({ port, history: history(1), maxOperations: 4, receiptOwner: () => "owner" });
  try {
    const entry = await workspace.bind(scope, attached);
    const a = workspace.receiptReference(scope, "a", "send"), b = workspace.receiptReference(scope, "b", "send");
    assert.throws(() => workspace.restoreOriginals(scope, [a, b]));
    assert.equal(entry.history.operations.length, 0); assert.equal(entry.getSnapshot().operations.length, 0);
    assert.throws(() => workspace.restoreOriginals(scope, [{ ...a, command: { type: "send", text: "cannot persist a request" } } as OriginalReceiptReference]), { code: "INVALID" });
    assert.equal(entry.history.operations.length, 0);
    workspace.restoreOriginals(scope, [a]); assert.equal(entry.history.operations.length, 1);
    assert.throws(() => workspace.restoreOriginals(scope, [{ ...b, scope: { ...scope, session: "other" } }]), { code: "FENCED" });
    assert.equal(workspace.originalReferences(scope).length, 1); assert.equal(port.submitted.length, 0);
  } finally { workspace.close(); }
});

test("all newly advertised native action originals mint, export and restore as inert exact references without replay", async () => {
  const cases: readonly Readonly<{ kind: "codex" | "copilot"; commands: readonly import("../src/contracts/types.js").ControlCommand[] }>[] = [
    { kind: "codex", commands: [{ type: "codex.steer", expectedTurnId: "turn", text: "private correction" }, { type: "codex.queue.add", text: "private queued text" }, { type: "codex.compact" }, { type: "codex.goal.set", objective: "private goal" }, { type: "codex.goal.clear" }, { type: "codex.mcp.reload" }, { type: "codex.mcp.login", serverName: "fixture" }] },
    { kind: "copilot", commands: [{ type: "copilot.steer", text: "private correction" }, { type: "copilot.queue.promote", id: "queue" }, { type: "copilot.compact" }, { type: "copilot.task.cancel", id: "task" }, { type: "copilot.task.promote", id: "task" }, { type: "copilot.mcp.reconnect", serverName: "fixture" }, { type: "copilot.mcp.login", serverName: "fixture", forceReauth: true }] },
  ];
  for (const { kind, commands } of cases) {
    const port = new ClientFixture(), snapshot = port.add(scope, kind), scopedHistory = kind === "codex" ? attached : { kind: "copilot" as const, origin: attached.origin, agentId: null };
    port.publish(scope, { capabilities: { ...snapshot.capabilities, commands: commands.map(command => command.type) } });
    const first = new SessionWorkspace({ port, history: history(), receiptOwner: () => "owner" });
    await first.bind(scope, scopedHistory);
    for (const [index, command] of commands.entries()) {
      const id = `${kind}-new-original-${index}`, reference = first.receiptReference(scope, id, command.type);
      assert.equal(reference.type, command.type); await first.request(scope, command, id).result;
    }
    const references = first.originalReferences(scope); assert.equal(references.length, commands.length); assert.ok(!JSON.stringify(references).includes("private")); first.close();
    const restored = new SessionWorkspace({ port, history: history(), receiptOwner: () => "owner" });
    try {
      await restored.bind(scope, scopedHistory); restored.restoreOriginals(scope, references);
      for (const reference of references) assert.equal((await restored.checkReceipt(scope, reference.id))?.type, reference.type);
      assert.ok(restored.control(scope).getSnapshot().operations.every(operation => operation.request === null));
      assert.equal(port.submitted.length, commands.length, "restore and original lookup never replay any native action");
      assert.throws(() => restored.restoreOriginals(scope, [{ ...references[0]!, id: "unsupported", type: "codex.not-real" as never }]), { code: "INVALID" });
    } finally { restored.close(); }
  }
});
