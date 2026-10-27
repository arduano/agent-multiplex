import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileCopilotContributions, copilotAgents, copilotInstructions, copilotMcp, copilotSettings, copilotSkills, copilotTools, type CopilotAgent } from "../src/contributions.js";
import { provisionSkillAssets, type SkillAssets } from "../src/assets.js";
import { copilotHarness } from "../src/plugin.js";
import { copilotHarnessRouter } from "../src/router.js";
import { fixture, scope, ScriptedPort } from "../../v8-session/qualification/host-fixture.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function bundle() {
  const root = await mkdtemp(join(tmpdir(), "v8-skill-plugin-")), directory = join(root, "assets"); await mkdir(join(directory, "example"), { recursive: true, mode: 0o700 });
  const content = "---\nname: example\ndescription: Offline scripted skill\n---\nUse references.txt.\n", reference = "full packaged reference\n";
  await writeFile(join(directory, "example", "SKILL.md"), content, { mode: 0o600 }); await writeFile(join(directory, "example", "references.txt"), reference, { mode: 0o600 });
  const assets: SkillAssets = { directory, files: [{ path: "example/SKILL.md", sha256: digest(content), bytes: Buffer.byteLength(content) }, { path: "example/references.txt", sha256: digest(reference), bytes: Buffer.byteLength(reference) }] };
  return { root, assets, content, reference };
}

test("Copilot startup compiles ordered inputs, rejects collisions including tool allow/exclude, and publishes no private data", () => {
  const values = [copilotInstructions({ id: "a", text: "First" }), copilotInstructions({ id: "b", text: "Second" }), copilotTools({ id: "tools", available: ["view"], excluded: ["edit"] })];
  const compiled = compileCopilotContributions(values); assert.deepEqual(compiled.sessionOptions.systemMessage, { mode: "append", content: "First\n\nSecond" });
  assert.throws(() => compileCopilotContributions([copilotTools({ id: "a", available: ["view"] }), copilotTools({ id: "b", excluded: ["view"] })]), /Duplicate/);
  assert.throws(() => compileCopilotContributions([copilotMcp({ id: "a", servers: { same: { type: "http", url: "http://offline.invalid/mcp" } } }), copilotMcp({ id: "b", servers: { same: { type: "http", url: "http://offline.invalid/mcp" } } })]), /Duplicate/);
  assert.equal(JSON.stringify(compiled.manifests).includes("First"), false);
  assert.equal(compileCopilotContributions([copilotSettings({ id: "credential-store", mcpOAuthTokenStorage: "persistent" })]).sessionOptions.mcpOAuthTokenStorage, "persistent");
  assert.throws(() => compileCopilotContributions([copilotSettings({ id: "one", mcpOAuthTokenStorage: "persistent" }), copilotSettings({ id: "two", mcpOAuthTokenStorage: "in-memory" })]), /Duplicate/);
  assert.deepEqual(compileCopilotContributions([copilotTools({ id: "none", available: [], excluded: [] })]).sessionOptions, { availableTools: [], excludedTools: [] });
});

test("Copilot custom agents preserve native model/effort requests and reject unknown or malformed native fields", () => {
  const agents: CopilotAgent[] = [
    { name: "inherited", prompt: "Use the native inherited model and effort.", tools: null },
    ...(["low", "medium", "high", "xhigh", "max"] as const).map(reasoningEffort => ({ name: `explicit-${reasoningEffort}`, prompt: "One bounded task.", model: "offline-child-model", reasoningEffort, tools: [] })),
  ];
  const compiled = compileCopilotContributions([copilotAgents({ id: "named-agents", agents })]);
  assert.deepEqual(compiled.sessionOptions.customAgents, agents);
  assert.equal(Object.hasOwn(compiled.sessionOptions.customAgents![0]!, "model"), false);
  assert.equal(Object.hasOwn(compiled.sessionOptions.customAgents![0]!, "reasoningEffort"), false);
  assert.equal(JSON.stringify(compiled.manifests).includes("offline-child-model"), false);
  const compile = compileCopilotContributions as (input: unknown) => unknown;
  for (const invalid of [
    { model: "" }, { model: "   " }, { model: "unsafe\nmodel" }, { model: 42 }, { model: null },
    { reasoningEffort: "ultra" }, { reasoningEffort: null }, { reasoningEffort: 1 },
    { effort: "high" }, { modelProvider: "codex-route" }, { unknownNativeOption: true },
    { tools: [42] }, { skills: null }, { infer: "true" },
  ]) assert.throws(() => compile([{ target: "copilot", id: "invalid", type: "agents", agents: [{ name: "child", prompt: "One task.", ...invalid }] }]), /Invalid Copilot custom agent/);
});

test("Copilot skill assets require a complete digest closure, preserve existing native state and forbid changed installation or symlinks", async () => {
  const f = await bundle();
  try {
    const home = join(f.root, "home"), target = await provisionSkillAssets(f.assets, home, "bundle");
    assert.equal(await readFile(join(target, "example", "references.txt"), "utf8"), f.reference);
    assert.equal(await provisionSkillAssets(f.assets, home, "bundle"), target);
    await writeFile(join(target, "example", "SKILL.md"), "native modified contents");
    await assert.rejects(provisionSkillAssets(f.assets, home, "bundle"), /Existing managed skill differs/);
    assert.equal(await readFile(join(target, "example", "SKILL.md"), "utf8"), "native modified contents");
    const changed = { ...f.assets, files: [f.assets.files[0]!] };
    await assert.rejects(provisionSkillAssets(changed, join(f.root, "another-home"), "bundle"), /Unlisted/);
    await symlink(join(f.assets.directory, "example", "references.txt"), join(f.assets.directory, "example", "alias"));
    await assert.rejects(provisionSkillAssets(f.assets, join(f.root, "symlink-home"), "bundle"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Copilot harness provisions a complete skill into the owned native home without starting SDK/native; configuration stays private", async () => {
  const f = await bundle(); let nativeCalls = 0;
  try {
    const cliPackageRoot = join(f.root, "cli"); await mkdir(cliPackageRoot); await writeFile(join(cliPackageRoot, "package.json"), JSON.stringify({ name: "@github/copilot-linux-x64", version: "1.0.95" }));
    const definition = copilotHarness({ cliBinary: join(cliPackageRoot, "copilot"), cliPackageRoot, model: "offline-model", provider: { id: "private-route", copilotOnly: true, config: { baseUrl: "http://offline.invalid/v1", apiKey: "private-value" } }, catalog: async () => ({ available: true, choices: [] }), contributions: [copilotSkills({ id: "bundle", assets: f.assets })] }, { commands: { exec: async () => { nativeCalls++; throw Error("unreachable"); } }, client: () => { nativeCalls++; throw Error("unreachable"); } });
    const directory = join(f.root, "owned"), runtime = await definition.create({ scope, directory, cwd: join(f.root, "work") });
    assert.equal(nativeCalls, 0); assert.equal(await readFile(join(directory, "native-home", "contributions", "skills", "bundle", "example", "SKILL.md"), "utf8"), f.content);
    const descriptor = JSON.stringify({ identity: definition.identity, contributions: definition.contributions, capabilities: definition.capabilities });
    for (const privateValue of [f.root, "offline.invalid", "private-value", f.content]) assert.equal(descriptor.includes(privateValue), false);
    await runtime.close(); assert.equal(nativeCalls, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Copilot router narrows commands and preserves one actual original through duplicate observations", async () => {
  const f = await fixture(new ScriptedPort("copilot"));
  try {
    await f.create(); const generation = (await f.host.snapshot(scope)).generation;
    const caller = copilotHarnessRouter({ sessions: { session: async target => { assert.deepEqual(target, scope); return f.host; } } }).createCaller({ identity: { connection: scope.connection, principal: scope.principal, actions: ["read", "control"] }, route: { authority: "root", host: scope.host, owner: "owner", routeEpoch: "epoch" }, session: { id: scope.session, generation } });
    const request = { id: "model-original", generation, command: { type: "copilot.model" as const, model: "model-a", providerId: "provider", effort: "high" } };
    const receipt = await caller.submit(request); assert.deepEqual(await caller.submit(request), receipt); assert.equal(f.port.calls.length, 1); assert.deepEqual(await caller.original({ id: request.id }), receipt);
    await assert.rejects((caller.submit as (input: unknown) => Promise<unknown>)({ id: "wrong-kind", generation, command: { type: "codex.interrupt", turnId: "turn" } }));
    assert.equal(await f.host.receipt(scope, "wrong-kind"), null); assert.equal(f.port.calls.length, 1);
  } finally { await f.dispose(); }
});
