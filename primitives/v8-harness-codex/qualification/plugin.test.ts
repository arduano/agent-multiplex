import assert from "node:assert/strict";
import test from "node:test";
import { compileCodexContributions, codexInstructions, codexMcp, codexSettings } from "../src/contributions.js";
import { codexHarness } from "../src/plugin.js";
import { codexHarnessRouter } from "../src/router.js";
import { fixture, scope, ScriptedPort } from "../../v8-session/qualification/host-fixture.js";
import type { HostContext } from "../../v8-plugins/src/contracts.js";

const context = (generation: number): HostContext => ({ identity: { connection: scope.connection, principal: scope.principal, actions: ["read", "control"] }, route: { authority: "root", host: scope.host, owner: "owner", routeEpoch: "epoch" }, session: { id: scope.session, generation } });
const privateOptions = () => ({ binary: "/private/codex", packageRoot: "/private/package", model: "offline-model", environment: { PRIVATE_KEY: "private-value" }, provider: { id: "private-route", baseUrl: "http://offline.invalid/v1", environmentKey: "PRIVATE_KEY", copilotOnly: true }, catalog: async () => ({ available: true, choices: [] }) });

test("Codex contribution compilation rejects ownership conflicts and freezes ordered startup inputs before construction", async () => {
  const a = { target: "codex" as const, type: "instructions" as const, id: "first", text: "First instruction" };
  const definition = codexHarness({ ...privateOptions(), contributions: [a, codexInstructions({ id: "second", text: "Second instruction" }), codexSettings({ id: "limits", multiAgent: { maxThreads: 2, maxDepth: 1 } })] });
  a.text = "changed later";
  const compiled = compileCodexContributions([codexInstructions({ id: "first", text: "First instruction" }), codexInstructions({ id: "second", text: "Second instruction" })]);
  assert.equal(compiled.developerInstructions, "First instruction\n\nSecond instruction");
  assert.throws(() => codexHarness({ ...privateOptions(), contributions: [codexMcp({ id: "a", servers: { same: { command: "/usr/bin/node", args: [] } } }), codexMcp({ id: "b", servers: { same: { command: "/usr/bin/node", args: [] } } })] }), /Duplicate/);
  assert.throws(() => codexHarness({ ...privateOptions(), contributions: [codexSettings({ id: "a", multiAgent: false }), codexSettings({ id: "b", multiAgent: false })] }), /Duplicate/);
  const publicPart = JSON.stringify({ identity: definition.identity, capabilities: definition.capabilities, contributions: definition.contributions });
  for (const secret of ["private-value", "offline.invalid", "First instruction", "/private/package"]) assert.equal(publicPart.includes(secret), false);
  assert.deepEqual(definition.unsupported, ["startup.skills", "startup.custom-agents", "startup.direct-tools"]);
  let nativeCalls = 0;
  const inert = codexHarness({ ...privateOptions(), commands: { exec: async () => { nativeCalls++; throw Error("unreachable"); } }, wire: () => { nativeCalls++; throw Error("unreachable"); } });
  const runtime = await inert.create({ scope, cwd: "/private/workspace", directory: "/private/disposable" });
  assert.equal(nativeCalls, 0); await runtime.close(); assert.equal(nativeCalls, 0);
});

test("Codex router uses authenticated scope and the actual original journal; wrong harness/generation never admits", async () => {
  const f = await fixture(new ScriptedPort("codex"));
  try {
    await f.create(); const generation = (await f.host.snapshot(scope)).generation;
    const router = codexHarnessRouter({ sessions: { session: async target => { assert.deepEqual(target, scope); return f.host; } } }), caller = router.createCaller(context(generation));
    const input = { id: "one-original", generation, command: { type: "send" as const, text: "one scripted effect" } };
    const [a, b] = await Promise.all([caller.submit(input), caller.submit(input)]);
    assert.deepEqual(a, b); assert.equal(f.port.calls.length, 1); assert.deepEqual(await caller.original({ id: input.id }), a);
    await assert.rejects(caller.submit({ id: "wrong-generation", generation: generation + 1, command: { type: "send", text: "never dispatch" } }));
    await assert.rejects((caller.submit as (input: unknown) => Promise<unknown>)({ id: "wrong-kind", generation, command: { type: "copilot.mode", mode: "plan" } }));
    assert.equal(await f.host.receipt(scope, "wrong-generation"), null); assert.equal(await f.host.receipt(scope, "wrong-kind"), null); assert.equal(f.port.calls.length, 1);
  } finally { await f.dispose(); }
});
