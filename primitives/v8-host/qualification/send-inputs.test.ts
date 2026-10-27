import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHost, type AgentHost } from "../../v8-lifecycle-default/src/node.js";
import { FileHost } from "../../v8-files/src/host/index.js";
import type { ArtifactRef, FileScope } from "../../v8-files/src/contracts/types.js";
import type { Harness, ManagedPolicy, NativeControlCommand, NativeOutcome, SendInputsFor, SessionCommand, SessionScope } from "../../v8-session/src/contracts/types.js";
import { fixture as sessionFixture } from "../../v8-session/qualification/host-fixture.js";
import { validateCommand } from "../../v8-harness-defaults/src/validation.js";
import { scriptedHost, deferred, until } from "./fixture.js";

const scope: SessionScope = { connection: "send-fixture", principal: "owner", host: "local", session: "logical" };
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array<number>(16).fill(0)]);
const policy = (kind: Harness): ManagedPolicy => kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" };
async function fixture(kind: Harness, configuredRoots = true, configure?: (driver: ReturnType<typeof scriptedHost>) => void, observationMs = 10000) {
  const root = await mkdtemp(join(tmpdir(), "v8-send-inputs-")), cwd = join(root, "cwd"), directory = join(root, "state"); await mkdir(cwd);
  const driver = scriptedHost(kind, { cwd }); configure?.(driver);
  const options = { scope, cwd, directory, policy: policy(kind), controller: driver.controller, observationMs, ...(configuredRoots ? { nativeInputRoots: [cwd] } : {}), files: { limits: { cleanupBatch: 2 } } };
  let host = await openHost(options);
  const submit = async (command: SessionCommand, id: string) => host.session.submit({ scope, id, generation: (await host.session.snapshot(scope)).generation, command });
  return { root, cwd, directory, driver, get host() { return host; }, submit,
    async put(id = "image", bytes = png, mediaType = "image/png") {
      const fileScope = host.fileScope()!, manifest = { id, name: `${id}.bin`, mediaType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      await host.files.call("begin", { scope: fileScope, manifest }); await host.files.call("write", { scope: fileScope, id, offset: 0, data: bytes }); return host.files.call("commit", { scope: fileScope, id });
    },
    async reopen() { await host.terminate(); host = await openHost(options); },
    async dispose() { await host.terminate(); await rm(root, { recursive: true, force: true }); },
  };
}
function inputs(kind: Harness, artifact: ArtifactRef): SendInputsFor<Harness> { return kind === "codex" ? { kind, items: [{ type: "image", artifact }] } : { kind, items: [{ type: "blob", artifact }] }; }
function fileRows(directory: string, nativeSession: string): { id: string; settled: boolean; consumers: string[]; released: boolean[] }[] {
  const path = join(directory, "files", createHash("sha256").update(nativeSession).digest("hex"), "files.sqlite"), db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT json FROM operations ORDER BY id").all().map(row => JSON.parse(String(row.json))); } finally { db.close(); }
}

for (const kind of ["codex", "copilot"] as const) test(`${kind} archive waits for actual byte leases and preserves stopped Send uncertainty and artifact bytes`, async () => {
  const reply = deferred<NativeOutcome>(), began = deferred<void>();
  const f = await fixture(kind, true, driver => {
    const open = driver.controller.open.bind(driver.controller);
    driver.controller.open = async (...args) => {
      const owner = await open(...args), invoke = owner.native.invoke.bind(owner.native);
      return { ...owner, native: { ...owner.native, invoke: command => { if (command.type === "send") { began.resolve(); return reply.promise; } return invoke(command); } } };
    };
  });
  try {
    await f.submit({ type: "create" }, "create"); const artifact = await f.put();
    const sending = f.submit(validateCommand(kind, { type: "send", text: "unknown original", inputs: inputs(kind, artifact) }), "unknown-send");
    await began.promise; await f.submit({ type: "stop" }, "stop"); assert.equal((await sending).state, "outcomeUnknown");
    await until(() => f.host.updateReadiness().ready);
    const lease = await f.host.files.call("acquire", { scope: artifact.owner, id: artifact.id });
    assert.equal((await f.submit({ type: "archive" }, "busy-archive")).state, "refused");
    assert.equal((await f.host.session.snapshot(scope)).archive, undefined);
    await f.host.files.call("release", { scope: artifact.owner, leaseId: lease.leaseId });
    assert.equal((await f.submit({ type: "archive" }, "archive")).state, "acknowledged");
    const original = await f.host.session.receipt(scope, "unknown-send"); assert.equal(original?.state, "outcomeUnknown");
    const row = fileRows(f.directory, artifact.owner.session).find(value => value.id === "unknown-send")!;
    assert.equal(row.settled, false); assert.deepEqual(row.released, [true]);
    const db = new DatabaseSync(join(f.directory, "files", createHash("sha256").update(artifact.owner.session).digest("hex"), "files.sqlite"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT state FROM entries WHERE id=?").get(artifact.id)!.state, "committed"); } finally { db.close(); }
    await assert.rejects(f.host.files.call("acquire", { scope: artifact.owner, id: artifact.id }), { code: "FENCED" });
    assert.equal((await f.submit({ type: "resume" }, "blocked-resume")).reason, "archived");
    assert.equal(f.driver.counts.resumes, 0); await until(() => f.host.updateReadiness().ready); await f.host.close();
  } finally { reply.resolve({ status: "accepted" }); await f.dispose(); }
});

for (const kind of ["codex", "copilot"] as const) test(`${kind} admitted Send privately prepares actual FileHost bytes once, refuses forged metadata before settings and settles only its original`, async () => {
  const nativeCommands: NativeControlCommand[] = [];
  const f = await fixture(kind, true, driver => {
    const open = driver.controller.open.bind(driver.controller);
    driver.controller.open = async (...args) => {
      const owner = await open(...args), invoke = owner.native.invoke.bind(owner.native);
      return { ...owner, native: { ...owner.native, invoke: command => { nativeCommands.push(command); return invoke(command); } } };
    };
  });
  try {
    await f.submit({ type: "create" }, "create"); const artifact = await f.put(), manifest = inputs(kind, artifact);
    const command = { type: "send" as const, text: "original", inputs: manifest, ...(kind === "copilot" ? { selection: { kind: "copilot", mode: "plan", permissions: "allow-all" } } : {}) } as SessionCommand;
    const first = await f.submit(command, "send"); await f.submit(command, "send");
    assert.equal(first.state, "acknowledged"); assert.equal(f.driver.counts.sends, 1);
    const nativeSend = nativeCommands.find(command => command.type === "send")!;
    assert.ok("nativeInputs" in nativeSend); const image = nativeSend.nativeInputs.items[0]!; assert.ok("bytes" in image); assert.deepEqual(image.bytes, png);
    if (kind === "copilot") assert.deepEqual(nativeCommands.map(command => command.type), ["copilot.mode", "copilot.permissions", "send"]);
    await until(() => fileRows(f.directory, artifact.owner.session).find(row => row.id === "send")?.settled === true);
    const row = fileRows(f.directory, artifact.owner.session).find(row => row.id === "send")!; assert.deepEqual(row.released, [true]);
    const db = new DatabaseSync(join(f.directory, "session", "session.sqlite"), { readOnly: true });
    try {
      const saved = String(db.prepare("SELECT payload FROM operations WHERE id=?").get("send")!.payload);
      assert.ok(saved.includes(artifact.sha256)); assert.ok(!saved.includes("nativeInputs") && !saved.includes("data:image") && !saved.includes("bytes\":{\"0\""));
    } finally { db.close(); }
    const before = f.driver.requests.length;
    const refused = await f.submit({ type: "send", text: "bad metadata", inputs: inputs(kind, { ...artifact, name: "forged-name.png" }), ...(kind === "copilot" ? { selection: { kind: "copilot", permissions: "allow-all" } as const } : {}) } as SessionCommand, "forged");
    assert.equal(refused.state, "refused"); assert.equal(f.driver.requests.length, before); assert.equal(f.driver.counts.sends, 1);
    const foreign = { ...artifact, owner: { ...artifact.owner, session: "foreign-native" } };
    assert.equal((await f.submit({ type: "send", text: "foreign", inputs: inputs(kind, foreign) } as SessionCommand, "foreign")).state, "refused");
    assert.equal(f.driver.counts.sends, 1);
    const steer = kind === "codex" ? { type: "codex.steer", expectedTurnId: "exact-turn", text: "correct", inputs: manifest } : { type: "copilot.steer", text: "correct", inputs: manifest };
    const messages: SessionCommand[] = [validateCommand(kind, steer), ...(kind === "codex" ? [validateCommand(kind, { type: "codex.queue.add", text: "queued", inputs: manifest })] : [])];
    for (const [index, message] of messages.entries()) {
      const id = `attachment-message-${index}`; assert.equal((await f.submit(message, id)).state, "acknowledged");
      const prepared = nativeCommands.find(value => value.type === message.type)!; assert.ok("nativeInputs" in prepared);
      const item = prepared.nativeInputs.items[0]!; assert.ok("bytes" in item); assert.deepEqual(item.bytes, png);
      await until(() => fileRows(f.directory, artifact.owner.session).find(value => value.id === id)?.settled === true);
      assert.deepEqual(fileRows(f.directory, artifact.owner.session).find(value => value.id === id)!.released, [true]);
    }
    await f.submit({ type: "stop" }, "stop");
  } finally { await f.dispose(); }
});

test("an unconfigured trusted preparation hook refuses an admitted attachment Send before any native call", async () => {
  const f = await sessionFixture();
  try {
    await f.create();
    const artifact: ArtifactRef = { kind: "artifact", owner: { ...f.port.run!.scope, session: f.port.run!.nativeSession }, id: "unconfigured", name: "image.png", mediaType: "image/png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), capturedAt: 1 };
    const receipt = await f.submit({ type: "send", text: "", inputs: { kind: "codex", items: [{ type: "image", artifact }] } });
    assert.equal(receipt.state, "refused"); assert.equal(receipt.reason, "inputsUnsupported"); assert.equal(f.port.calls.length, 0); await f.submit({ type: "stop" });
  } finally { await f.dispose(); }
});

test("a dropped Send observer cannot settle file custody; late actual native acknowledgement commits the exact original once", async () => {
  const gate = deferred<void>(), invoked = deferred<void>();
  const f = await fixture("codex", true, driver => {
    const open = driver.controller.open.bind(driver.controller);
    driver.controller.open = async (...args) => {
      const owner = await open(...args), invoke = owner.native.invoke.bind(owner.native);
      return { ...owner, native: { ...owner.native, invoke: async command => {
        const result = await invoke(command);
        if (command.type === "send") { invoked.resolve(); await gate.promise; }
        return result;
      } } };
    };
  }, 2000);
  try {
    await f.submit({ type: "create" }, "create"); await until(async () => (await f.host.session.snapshot(scope)).phase === "running"); const artifact = await f.put();
    // The client drops its submit response. Only exact receipt reads follow.
    void f.submit({ type: "send", text: "one original", inputs: { kind: "codex", items: [{ type: "image", artifact }] } }, "late-send");
    await invoked.promise; await until(async () => (await f.host.session.receipt(scope, "late-send"))!.state === "outcomeUnknown");
    const before = fileRows(f.directory, artifact.owner.session).find(row => row.id === "late-send")!; assert.equal(before.settled, false); assert.deepEqual(before.released, [false]);
    gate.resolve(); await until(async () => (await f.host.session.receipt(scope, "late-send"))!.state === "acknowledged");
    await until(() => { const row = fileRows(f.directory, artifact.owner.session).find(row => row.id === "late-send")!; return row.settled && row.released[0] === true; });
    assert.equal(f.driver.counts.sends, 1); await f.submit({ type: "stop" }, "stop");
  } finally { gate.resolve(); await f.dispose(); }
});

test("Stop while a real preparation read is held refuses the undispatched original, preserves the actual lease and fences all Copilot settings across Resume", async () => {
  const f = await fixture("copilot", true, undefined, 50), gate = deferred<void>(), entered = deferred<void>(), call = FileHost.prototype.call; let held = false;
  FileHost.prototype.call = async function(this: FileHost, method, input) {
    if (method === "read" && input.scope.connection === scope.connection && !held) { held = true; entered.resolve(); await gate.promise; }
    return call.call(this, method, input);
  } as FileHost["call"];
  try {
    await f.submit({ type: "create" }, "create"); await until(async () => (await f.host.session.snapshot(scope)).phase === "running"); const artifact = await f.put(); const before = f.driver.requests.length;
    const pending = f.submit({ type: "send", text: "held", inputs: { kind: "copilot", items: [{ type: "blob", artifact }] }, selection: { kind: "copilot", permissions: "allow-all", mode: "plan" } }, "held-send");
    await entered.promise; assert.equal((await f.host.files.call("usage", { scope: artifact.owner })).activeReads, 1);
    assert.equal((await pending).state, "admitted", "Observer expiry must preserve known nondispatch while the actual read remains held");
    assert.equal((await f.host.session.receipt(scope, "held-send"))!.state, "admitted");
    const stop = await f.submit({ type: "stop" }, "stop"); assert.ok(stop.state === "acknowledged" || stop.state === "outcomeUnknown"); await until(async () => (await f.host.session.snapshot(scope)).phase === "stopped");
    assert.equal((await f.host.session.receipt(scope, "held-send"))!.state, "refused");
    assert.equal((await f.host.files.call("usage", { scope: artifact.owner })).activeReads, 1);
    await f.submit({ type: "resume" }, "resume"); await until(async () => (await f.host.session.receipt(scope, "resume"))!.state === "acknowledged"); const generation = (await f.host.session.snapshot(scope)).generation;
    gate.resolve(); await until(async () => (await f.host.files.call("usage", { scope: artifact.owner })).activeReads === 0);
    await until(() => fileRows(f.directory, artifact.owner.session).find(row => row.id === "held-send")?.released[0] === true);
    assert.equal(f.driver.counts.sends, 0); assert.equal((await f.host.session.receipt(scope, "held-send"))!.state, "refused"); assert.equal((await f.host.session.snapshot(scope)).generation, generation);
    assert.ok(!f.driver.requests.slice(before).some(row => row.method === "permissions.setMode" && (row.params as { mode: string }).mode === "allow-all"));
    await f.submit({ type: "stop" }, "final-stop");
  } finally { gate.resolve(); FileHost.prototype.call = call; await f.dispose(); }
});

test("writer reopen keyset-reconciles only exact terminal originals with retired inline consumers; unknown and unrelated holds stay protected", async () => {
  const f = await fixture("copilot");
  try {
    await f.submit({ type: "create" }, "create"); const artifact = await f.put(), epoch = (await f.host.session.snapshot(scope)).epoch;
    for (const id of ["a-ack", "b-refused", "c-unknown", "d-ack", "e-legacy", "f-current", "g-missing"])
      await f.host.files.call("protect", { scope: artifact.owner, operationId: id, artifactIds: [artifact.id], consumers: [id === "e-legacy" ? "legacy" : `send-input-v1.e${id === "f-current" ? epoch + 1 : epoch}.g1`] });
    await f.submit({ type: "send", text: "ack" }, "a-ack");
    await f.submit({ type: "send", text: "refused", selection: { kind: "copilot", permissions: "assisted" } }, "b-refused");
    f.driver.onSend = () => { throw new Error("Scripted post-dispatch loss"); };
    assert.equal((await f.submit({ type: "send", text: "uncertain" }, "c-unknown")).state, "outcomeUnknown"); f.driver.onSend = undefined;
    await f.submit({ type: "send", text: "second acknowledgement" }, "d-ack");
    // Make this consumer refer to a different original generation without
    // changing either journal. Exact evidence must fail closed.
    await f.host.files.call("protect", { scope: artifact.owner, operationId: "z-wrong-generation", artifactIds: [artifact.id], consumers: [`send-input-v1.e${epoch}.g2`] });
    await f.submit({ type: "send", text: "other generation" }, "z-wrong-generation");
    await f.reopen();
    await until(() => fileRows(f.directory, artifact.owner.session).filter(row => row.id === "a-ack" || row.id === "b-refused" || row.id === "d-ack").every(row => row.settled && row.released[0]));
    const rows = fileRows(f.directory, artifact.owner.session);
    for (const id of ["c-unknown", "e-legacy", "f-current", "g-missing", "z-wrong-generation"]) { const row = rows.find(value => value.id === id)!; assert.equal(row.settled, false); assert.deepEqual(row.released, [false]); }
    assert.equal(f.driver.counts.sends, 4); assert.equal(f.driver.counts.opens, 1); await f.submit({ type: "stop" }, "stop");
  } finally { await f.dispose(); }
});

test("native disk inputs require explicit visible roots and existing path policy; references do not copy or capture files", async () => {
  const f = await fixture("copilot"), g = await fixture("copilot", false);
  try {
    await f.submit({ type: "create" }, "create"); await g.submit({ type: "create" }, "create");
    const path = join(f.cwd, "owned.txt"); await writeFile(path, "owned reference");
    const file = { kind: "disk" as const, owner: f.host.fileScope()!, sourceKey: "owned", path };
    assert.equal((await f.submit({ type: "send", text: "reference", inputs: { kind: "copilot", items: [{ type: "file", file }] } }, "native-file")).state, "acknowledged");
    const sibling = join(f.root, "sibling.txt"), symbolic = join(f.cwd, "symbolic.txt"), hard = join(f.cwd, "hard.txt"); await writeFile(sibling, "outside"); await symlink(sibling, symbolic); await link(path, hard);
    for (const [id, target] of [["sibling", sibling], ["symbolic", symbolic], ["hard", hard], ["private", join(f.directory, "session", "session.sqlite")], ["url", "https://fixture.invalid/x"]])
      assert.equal((await f.submit({ type: "send", text: "refused", inputs: { kind: "copilot", items: [{ type: "file", file: { ...file, path: target! } }] } }, `bad-${id}`)).state, "refused");
    await writeFile(join(g.cwd, "owned.txt"), "no visible mount");
    assert.equal((await g.submit({ type: "send", text: "unconfigured", inputs: { kind: "copilot", items: [{ type: "file", file: { ...file, owner: g.host.fileScope()!, path: join(g.cwd, "owned.txt") } }] } }, "unconfigured")).state, "refused");
    assert.equal((await f.host.files.call("usage", { scope: file.owner })).entries, 0); assert.equal(f.driver.counts.sends, 1); assert.equal(g.driver.counts.sends, 0);
    await f.submit({ type: "stop" }, "stop"); await g.submit({ type: "stop" }, "stop");
  } finally { await f.dispose(); await g.dispose(); }
});

test("wire manifests are closed and bounded references; private buffers cannot enter originals and attachment-only Send is explicit", () => {
  const artifact: ArtifactRef = { kind: "artifact", owner: scope, id: "image", name: "image.png", mediaType: "image/png", bytes: 24, sha256: "a".repeat(64), capturedAt: 1 };
  assert.equal(validateCommand("codex", { type: "send", text: "", inputs: inputs("codex", artifact) }).type, "send");
  for (const command of [
    { type: "send", text: "" }, { type: "send", text: "x", nativeInputs: { kind: "codex", items: [] } },
    { type: "send", text: "x", inputs: inputs("copilot", artifact) },
    { type: "send", text: "x", inputs: { kind: "codex", items: new Array(9).fill({ type: "image", artifact }) } },
    { type: "send", text: "x", inputs: { kind: "codex", items: new Array(3).fill({ type: "image", artifact: { ...artifact, bytes: 10 * 1024 * 1024 } }) } },
    { type: "send", text: "x", inputs: { kind: "codex", items: [{ type: "image", artifact: { ...artifact, data: "forged" } }] } },
  ]) assert.throws(() => validateCommand("codex", command));
});
