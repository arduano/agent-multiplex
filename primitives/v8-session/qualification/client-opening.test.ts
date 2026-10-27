import assert from "node:assert/strict";
import test from "node:test";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { SessionWorkspace } from "../src/client/workspace.js";
import { ClientFixture } from "./client-fixture.js";

test("logical control retains pre-ID Stop through disconnect with no provisional history; positive binding preserves the same original owner", async () => {
  const scope = { connection: "opening", principal: "owner", host: "host", session: "a" };
  const port = new ClientFixture(), history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal, maxOperationsPerSession: 1 });
  port.add(scope, "codex"); port.publish(scope, { phase: "starting", nativeSession: null, activity: "unknown", interactionsComplete: false });
  const workspace = new SessionWorkspace({ port, history }), control = await workspace.prepare(scope, "codex");
  try {
    assert.equal(history.size, 0); assert.equal(control.getSnapshot().active, true);
    assert.throws(() => workspace.entry(scope), { code: "FENCED" });
    assert.throws(() => workspace.request(scope, { type: "send", text: "cannot invent history" }), { code: "FENCED" });
    const stop = workspace.request(scope, { type: "stop" }, "original-opening-stop"); await stop.result;
    await workspace.request(scope, { type: "stop" }, "second-settled-opening-stop").result;
    workspace.setConnected(false); workspace.setConnected(true); await workspace.refresh(scope);
    assert.equal(control.getSnapshot().native!.phase, "starting", "a Stop receipt cannot invent native Stopped");
    assert.equal(port.submitted.length, 2); assert.equal(history.size, 0);
    await assert.rejects(workspace.prepare(scope, "copilot"), { code: "FENCED" });
    // Independent positive native observation supplies the actual ID. This is
    // client evidence only; backend custody/late-open fencing has its own oracle.
    port.publish(scope, { nativeSession: "native-a", phase: "stopping", stopRequested: true });
    const attached = { kind: "codex" as const, origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: "native-a", attachment: "observed" }, threadId: "native-a" };
    const entry = await workspace.bind(scope, attached);
    assert.equal(entry, control); assert.equal(history.size, 1);
    assert.equal(entry.history.operations[0]!.id, stop.id);
    assert.equal(entry.getSnapshot().operations[0]!.request, stop.request);
    assert.equal((await workspace.checkReceipt(scope, stop.id))!.id, stop.id); assert.equal(port.submitted.length, 2);
    port.publish(scope, { phase: "stopped", activity: "idle", stopRequested: false });
    assert.equal(control.getSnapshot().active, false);
  } finally { workspace.close(); }
});
