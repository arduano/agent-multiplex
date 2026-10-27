import assert from "node:assert/strict";
import test from "node:test";
import { FixturePool, ProcessFixturePort, compareScaffolding, executing } from "./process-fixture.js";

test("a root PID exit is insufficient: its fixture tools continue until the owned group ends", async () => {
  const pool = await FixturePool.open();
  try {
    await pool.call("start", "root", true);
    const children = [...pool.pids].filter(pid => pid !== pool.child.pid); assert.equal(children.length, 2);
    pool.child.kill("SIGKILL"); await pool.exited;
    assert.equal((await Promise.all(children.map(executing))).every(Boolean), true);
    await pool.forceOwnGroup();
    assert.equal((await Promise.all([...pool.pids].map(executing))).some(Boolean), false);
  } finally { await pool.forceOwnGroup(); }
});

test("shared graceful stop ends its exact fixture tree and preserves its peer; a stalled stop never kills the shared owner", async () => {
  const pool = await FixturePool.open();
  try {
    await pool.call("start", "a", true); await pool.call("start", "b", true);
    await pool.call("stall", "a"); let settled = false;
    const stopping = pool.stop("a").then(() => { settled = true; });
    const stats = await pool.call("stats"); assert.deepEqual(stats.roots, ["a", "b"]); assert.equal(settled, false);
    await pool.call("unblock", "a"); await stopping;
    assert.deepEqual((await pool.call("stats")).roots, ["b"]); assert.equal(await executing(pool.child.pid!), true);
    await pool.stop("b"); await pool.close();
    assert.equal((await Promise.all([...pool.pids].map(executing))).some(Boolean), false);
  } finally { await pool.forceOwnGroup(); }
});

test("bounded placement scaffolding comparison records both candidates without claiming native costs", async () => {
  const rows = await compareScaffolding(); assert.equal(rows.length, 8);
  process.stdout.write(`V8_SESSION_COMPARISON ${JSON.stringify(rows)}\n`);
});

test("dedicated fixture Stop proves its own tree ended after graceful Stop stalls", async () => {
  const pool = await FixturePool.open(), port = new ProcessFixturePort("codex", "dedicated", pool);
  try {
    const scope = { connection: "fixture", principal: "owner", host: "dedicated", session: "root" };
    const run = await port.start({ scope, generation: 1, placement: "dedicated", operationId: "create", nativeSession: null, policy: { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" } }, () => {});
    await pool.call("stall", JSON.stringify([scope.session, 1]));
    const proof = await run.stop();
    assert.deepEqual(proof.run, run.run); assert.equal(proof.scope, "nativeTree");
    assert.equal((await Promise.all([...pool.pids].map(executing))).some(Boolean), false);
    assert.equal(port.stops, 1);
  } finally { await pool.forceOwnGroup(); }
});
