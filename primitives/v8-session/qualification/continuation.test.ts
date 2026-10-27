import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { OpeningIdentity, ParentCustody } from "../src/contracts/types.js";
import { defer, fixture, scope, ScriptedPort, until } from "./host-fixture.js";

test("explicit reopening retains native identity and never chains a context turn; warm Continue refuses working, retrying and input states", async () => {
  const f = await fixture();
  try {
    await f.create(); await f.submit({ type: "stop" });
    assert.equal((await f.submit({ type: "resume" })).state, "acknowledged");
    assert.equal(f.port.starts.length, 2); assert.equal(f.port.starts[1]!.nativeSession, "native-original"); assert.equal(f.port.calls.length, 0);
    const run = f.port.run!;
    f.port.emit({ type: "activity", run, activity: "working" });
    assert.equal((await f.submit({ type: "codex.continue" })).state, "refused");
    f.port.emit({ type: "activity", run, activity: "idle" });
    f.port.emit({ type: "interactions", run, complete: false, items: [] });
    assert.equal((await f.submit({ type: "codex.continue" })).state, "refused");
    f.port.emit({ type: "interactions", run, complete: true, items: [] });
    f.port.emit({ type: "attention", run, attention: { state: "retrying", cause: { source: "codex.turn", id: "retry-turn" } } });
    assert.equal((await f.submit({ type: "codex.continue" })).state, "refused");
    f.port.emit({ type: "attention", run, attention: { state: "error", cause: { source: "codex.turn", id: "failed-turn" } } });
    assert.equal((await f.submit({ type: "codex.continue" })).state, "acknowledged");
    assert.deepEqual(f.port.calls, [{ type: "codex.continue" }]);
    await f.submit({ type: "stop" }); await f.host.close();
  } finally { await f.dispose(); }
});

class ParentPort extends ScriptedPort {
  identity: OpeningIdentity = { attachment: "owned-host-service", process: "private-parent-invocation-1", containment: "private-invocation-group-1", placement: "shared" };
  retired = false;
  readonly inspected: OpeningIdentity[] = [];
  get parentCustody(): ParentCustody {
    return { identity: this.identity, inspect: async identity => {
      this.inspected.push(identity);
      return this.retired ? { identity, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true } : null;
    } };
  }
  replaceParent(): void { this.identity = { ...this.identity, process: "private-parent-invocation-2", containment: "private-invocation-group-2" }; }
}

test("durable exact parent retirement settles pre-capsule Starting without inventing an original result or native identity", async () => {
  const port = new ParentPort(), release = defer<void>(); port.startGate = release.promise;
  const f = await fixture(port, { observationMs: 20 });
  try {
    port.onStart = () => {
      const db = new DatabaseSync(join(f.directory, "session.sqlite"), { readOnly: true });
      try { assert.deepEqual(JSON.parse(String(db.prepare("SELECT parent FROM state").get()!.parent)), port.identity); }
      finally { db.close(); }
    };
    const pending = f.create(); await until(() => port.starts.length === 1); const creating = await pending;
    assert.ok(["admitted", "dispatched", "outcomeUnknown"].includes(creating.state));
    port.replaceParent(); await f.reopen();
    assert.equal((await f.host.snapshot(scope)).phase, "starting", "changed invocation alone proves no retirement");
    port.retired = true; await f.reopen();
    const snapshot = await f.host.snapshot(scope);
    assert.equal(snapshot.phase, "stopped"); assert.equal(snapshot.nativeSession, null);
    assert.equal((await f.host.receipt(scope, creating.id))!.state, "outcomeUnknown");
    assert.equal(port.starts.length, 1); assert.equal(port.stops, 0);
    assert.ok(!JSON.stringify(snapshot).includes("private-parent"));
    await f.host.close();
  } finally { release.resolve(); await f.dispose(); }
});

test("reader allocation intent retains its old parent until exact positive retirement; inspection never opens an agent or reader", async () => {
  const port = new ParentPort(), f = await fixture(port);
  try {
    await f.create(); const run = port.run!; await f.submit({ type: "stop" });
    await f.host.readers.begin(run, { scope, generation: run.generation, operationId: "owned-reader-intent" });
    port.replaceParent(); await f.reopen();
    assert.equal((await f.host.readers.read()).state, "allocating");
    port.retired = true; await f.reopen();
    assert.deepEqual(await f.host.readers.read(), { state: "none" });
    assert.equal((await f.host.snapshot(scope)).phase, "stopped");
    assert.equal(port.starts.length, 1); assert.equal(port.stops, 1);
    await f.host.close();
  } finally { await f.dispose(); }
});
