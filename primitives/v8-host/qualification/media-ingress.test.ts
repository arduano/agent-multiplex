import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openHost } from "../../v8-lifecycle-default/src/assembly.js";
import { rowMedia } from "../../v8-history/src/contracts/media.js";
import { until, deferred } from "./fixture.js";
import { createCodexController, type CodexNotification, type CodexRequests, type CodexTransport } from "../../v8-harness-codex/src/controller.js";
import { CodexStdioRpc, type CodexWire } from "../../v8-harness-codex/src/rpc.js";
import { projectCodexMediaNotification, projectCodexMediaResult, projectCopilotMediaEvent } from "../src/native-media.js";
import { createCodexHistoryPort } from "../../v8-history/src/native/codex/history.js";
import { CodexCodec } from "../../v8-history/src/native/codex/index.js";
import { createCopilotCodec } from "../../v8-history/src/native/copilot/index.js";
import { NativeFileCapture, type NativeCapturePort } from "../../v8-files/src/native/capture.js";
import type { ArtifactRef, FileManifest, FileMethod, FileOutputs, FilePort, FileScope } from "../../v8-files/src/contracts/types.js";
import type { Action } from "../../v8-history/src/contracts/types.js";
import type { RuntimeEvent } from "../../v8-runtime/src/contracts.js";
import type { NativeStart } from "../../v8-session/src/contracts/types.js";
import { ScriptedContainment, scriptedHost } from "./fixture.js";

const scope = { connection: "media", principal: "owner", host: "host", session: "logical" };
const image = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(1_600_000)}--></svg>`), encoded = image.toString("base64"), url = `data:image/svg+xml;base64,${encoded}`;
const item = (id = "image-item") => ({ type: "userMessage", id, content: [{ type: "text", text: "caption", text_elements: [] }, { type: "image", url }] });
const nativeInput: NativeStart = { scope, generation: 1, operationId: "create", placement: "dedicated", nativeSession: null, policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } };

function files() {
  const entries = new Map<string, { manifest: FileManifest; scope: FileScope; bytes: Uint8Array; offset: number; artifact?: ArtifactRef }>();
  const occurrences = new Map<string, string>();
  const port: NativeCapturePort = { async native(method, input, occurrence) {
    const prior = occurrences.get(occurrence.key); if (prior !== undefined && prior !== occurrence.signature) throw Error("Conflicting scripted occurrence"); occurrences.set(occurrence.key, occurrence.signature);
    return port.call(method, input);
  }, async call<M extends FileMethod>(method: M, input: Parameters<FilePort["call"]>[1]): Promise<FileOutputs[M]> {
    const value = input as unknown as { scope: FileScope; manifest?: FileManifest; id?: string; offset?: number; data?: Uint8Array };
    let entry = entries.get(value.id ?? value.manifest!.id), result: unknown;
    if (method === "begin") { const manifest = value.manifest!; entry = { manifest, scope: value.scope, bytes: new Uint8Array(manifest.bytes), offset: 0 }; entries.set(manifest.id, entry); result = { state: "uploading", manifest, offset: 0 }; }
    else if (method === "write") { assert.ok(entry); assert.equal(value.offset, entry.offset); entry.bytes.set(value.data!, entry.offset); entry.offset += value.data!.length; result = { state: "uploading", manifest: entry.manifest, offset: entry.offset }; }
    else if (method === "commit") { assert.ok(entry); assert.equal(entry.offset, entry.manifest.bytes); entry.artifact = { kind: "artifact", owner: entry.scope, ...entry.manifest, capturedAt: 0 }; result = entry.artifact; }
    else if (method === "abandon") result = undefined;
    else throw Error("Unexpected native capture method");
    return result as FileOutputs[M];
  } };
  const capture = new NativeFileCapture({ port, mapScope: value => ({ connection: value.origin.connection, principal: value.origin.principal, host: value.origin.host, session: value.origin.nativeSession }) });
  return { capture, entries };
}
class Wire implements CodexWire {
  readonly listeners = new Set<(text: string) => void>(); readonly writes: Record<string, unknown>[] = []; readonly closed = new Set<() => void>();
  onData(fn: (text: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onClose(fn: () => void) { this.closed.add(fn); return () => this.closed.delete(fn); }
  feed(text: string) { for (const listener of this.listeners) listener(text); }
  frame(value: unknown) { this.feed(JSON.stringify(value) + "\n"); }
  async write(line: string) { const value = JSON.parse(line) as Record<string, unknown>; this.writes.push(value); if (value.method === "initialize") this.frame({ id: value.id, result: { userAgent: "codex/0.162.1 (scripted)" } }); }
  reply(method: string, result: unknown) { const request = this.writes.findLast(value => value.method === method)!; assert.ok(request); this.frame({ id: request.id, result }); }
  async close() { for (const listener of this.closed) listener(); }
}

test("large Codex media survives exact live capture, pending history/Send responses, split tail and coalesced frames; ordinary oversized frames fail closed", async () => {
  const wire = new Wire(), notifications = new Set<(value: CodexNotification) => void>(), rpc = new CodexStdioRpc(wire, value => { for (const listener of notifications) listener(value); }, () => {});
  await rpc.initialize();
  const containment = new ScriptedContainment({ opens: 0, resumes: 0, sends: 0, stops: 0, discovery: 0, bodyReads: 0, replies: 0 });
  const transport: CodexTransport = { request: <M extends keyof CodexRequests>(method: M, params: CodexRequests[M]) => rpc.request(method, params), onNotification: fn => { notifications.add(fn); return () => { notifications.delete(fn); }; }, onRequest: () => () => {} };
  const controller = createCodexController({ transport, containment, cwd: "/workspace", model: "scripted", provider: { id: "route", copilotOnly: true }, catalog: async () => ({ available: true, choices: [] }) }), store = files(), actions: Action[] = [];
  let captured = 0, historyGaps = 0, codec: CodexCodec | undefined; const events: RuntimeEvent[] = [];
  controller.observe(capture => { if (capture.kind === "historyGap") historyGaps++; else if (capture.kind === "binding") codec = new CodexCodec({ origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: capture.binding.run.nativeSession, attachment: "epoch" }, rootThreadId: capture.binding.run.nativeSession, capture: { open() {}, emit(_scope, value) { actions.push(...value); }, reset() {} }, media: store.capture.handler }); else if (capture.kind === "codex") { captured++; codec!.observe(capture.value); } });
  const opening = controller.open(nativeInput, event => { events.push(event); });
  wire.frame({ method: "item/completed", params: { threadId: "native", turnId: "turn", item: item("prebinding") } });
  assert.equal(captured, 0); assert.equal(store.capture.diagnostics().occurrences, 0, "prebinding media must never be retained for later adoption");
  wire.reply("thread/start", { thread: { id: "native" }, model: "scripted", modelProvider: "route", approvalPolicy: "on-request", sandbox: { type: "dangerFullAccess" } });
  const held = await opening;
  // Retire the old false coupling: losing closed transcript media is not a
  // missing reverse request. Keep its own history/progress loss explicit.
  assert.equal(held.native.interactionsComplete, true, "prebinding media loss cannot revoke a positive continuous callback certificate");
  assert.equal(historyGaps, 1);
  assert.ok(events.some(value => value.type === "native" && value.event.type === "activity" && value.event.activity === "unknown"));
  const raw = { method: "item/completed", params: { threadId: "native", turnId: "turn", item: item() } }, line = JSON.stringify(raw) + "\n";
  assert.ok(Buffer.byteLength(line) > 2_000_000); wire.feed(line.slice(0, 100)); wire.feed(line.slice(100, -20)); wire.feed(line.slice(-20) + JSON.stringify({ method: "thread/status/changed", params: { threadId: "native", status: { type: "idle" } } }) + "\n");
  assert.equal(captured, 2); assert.equal(codec!.diagnostics().rejected, 0); assert.equal(store.capture.diagnostics().occurrences, 1); await store.capture.drain();
  assert.equal(store.entries.size, 1); assert.deepEqual([...store.entries.values()][0]!.bytes, new Uint8Array(image)); assert.ok([...store.entries.values()][0]!.artifact); assert.equal(JSON.stringify(actions).includes("data:image"), false);
  const history = rpc.request("thread/items/list", {}); wire.reply("thread/items/list", { data: [{ item: item(), turnId: "turn", startedAtMs: 0, completedAtMs: 1 }], nextCursor: null });
  assert.equal(((await history) as { data: { item: ReturnType<typeof item> }[] }).data[0]!.item.content[1]!.url, url);
  const send = held.native.invoke({ type: "send", text: "normal" }); await until(() => wire.writes.some(value => value.method === "turn/start")); wire.reply("turn/start", { turn: { id: "new-turn", items: [item()] } }); assert.deepEqual(await send, { status: "accepted", detail: { turnId: "new-turn" } });
  const ordinary = JSON.stringify({ method: "ordinary", params: { text: "x".repeat(1_100_000) } }) + "\n"; wire.feed(ordinary + ordinary); assert.equal(rpc.observation().connected, true, "separate ordinary frames may coalesce above the per-frame bound");
  wire.frame({ method: "item/agentMessage/delta", params: { threadId: "native", delta: "x".repeat(2_000_001) } }); assert.equal(rpc.diagnostics().rpc.failure, "invalidFrame");
  await held.stopTree(); controller.dispose(); await rpc.close(); store.capture.close();
});

test("Copilot image/blob and binary-asset control projections capture original once under the existing file owner and retain strict exception bounds", async () => {
  const driver = scriptedHost("copilot", { cwd: "/workspace" }), store = files(), actions: Action[] = [];
  let captured = 0, historyGaps = 0; const events: RuntimeEvent[] = [];
  const held = await driver.controller.open({ ...nativeInput, policy: { kind: "copilot", provider: "copilot-only", permissions: "manual" } }, event => { events.push(event); }), root = held.identity.run.nativeSession;
  const codec = createCopilotCodec({ origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: root, attachment: "epoch" }, capture: { open() {}, emit(_scope, value) { actions.push(...value); }, reset() {} }, media: store.capture.handler });
  const detach = driver.controller.observe(capture => { if (capture.kind === "historyGap") historyGaps++; else if (capture.kind === "copilot") { captured++; codec.observe(capture.value); } });
  driver.event("user.message", { messageId: "user", content: "caption", attachments: [{ type: "blob", mimeType: "image/svg+xml", data: encoded }] });
  assert.equal(captured, 1); assert.equal(store.capture.diagnostics().occurrences, 1);
  driver.event("session.binary_asset", { type: "image", mimeType: "image/svg+xml", data: encoded, assetId: "asset" });
  assert.equal(captured, 2); assert.equal(store.capture.diagnostics().occurrences, 2); await store.capture.drain(); assert.equal(store.entries.size, 2); assert.equal(JSON.stringify(actions).includes(encoded.slice(0, 100)), false);
  driver.event("user.message", { messageId: "bad", content: "caption", attachments: [{ type: "blob", mimeType: "image/svg+xml", data: encoded, unknown: "x".repeat(65536) }] });
  assert.equal(captured, 2, "unknown metadata cannot hide behind admitted media");
  // user.message media has no permission capability. Reject its oversized
  // metadata without manufacturing lost callbacks or accepting its bytes.
  const owner = driver.controller.interactions(held.identity.run);
  assert.equal(owner.current().baseline, "complete"); assert.equal(historyGaps, 1);
  assert.ok(events.some(value => value.type === "native" && value.event.type === "activity" && value.event.activity === "unknown"));
  assert.equal(store.capture.diagnostics().occurrences, 2); assert.equal(store.entries.size, 2);
  driver.event("permission.requested", { requestId: "after-media-loss", permissionRequest: { kind: "mcp", serverName: "scripted-fixture", toolName: "echo" } });
  const prompt = owner.current().items[0]!.prompt; assert.equal(prompt.type, "copilot.permission");
  const answer = { type: "answer" as const, interactionId: prompt.id, choice: "approve-once", value: { type: "copilot.permission" as const, kind: "approve-once" as const } };
  assert.equal((await owner.invoke(answer)).status, "acknowledged");
  assert.equal((await owner.invoke(answer)).status, "targetUnavailable");
  assert.equal(driver.counts.replies, 1); assert.equal(owner.current().items.length, 0); assert.equal(owner.current().baseline, "complete");
  assert.equal(captured, 3, "the one legitimate permission notification is also observed");
  assert.throws(() => projectCodexMediaNotification({ method: "item/completed", params: { item: { ...item(), content: Array.from({ length: 11 }, () => ({ type: "image", url: "data:image/png;base64,AA==" })) } } }));
  assert.throws(() => projectCopilotMediaEvent({ type: "user.message", data: { attachments: [{ type: "blob", mimeType: "image/png", data: "AA=A" }] } }));
  const tooManyBytes = "A".repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4);
  assert.throws(() => projectCopilotMediaEvent({ type: "user.message", data: { attachments: Array.from({ length: 3 }, () => ({ type: "blob", mimeType: "application/pdf", data: tooManyBytes })) } }));
  assert.equal(projectCodexMediaResult("initialize", { turn: { items: [item()] } }), null); assert.equal(projectCodexMediaNotification({ method: "tool/result", params: { item: item() } }), null); assert.ok(projectCopilotMediaEvent({ type: "tool.execution_complete", data: { result: { contents: [{ type: "image", mimeType: "image/png", data: encoded }] } } }));
  await held.stopTree(); driver.event("user.message", { messageId: "late", content: "late", attachments: [{ type: "image", mimeType: "image/svg+xml", data: encoded }] }); assert.equal(captured, 3, "halted native media cannot reacquire custody beyond the two media and one permission notification"); detach(); driver.controller.dispose(); store.capture.close();
});

test("Copilot closed tool-image leaves reach the real controller and file capture beyond ordinary framing without inspecting arguments", async () => {
  const driver = scriptedHost("copilot", { cwd: "/workspace" }), store = files(), hub = new (await import("../../v8-history/src/host/history-owner.js")).HistoryHub();
  const held = await driver.controller.open({ ...nativeInput, policy: { kind: "copilot", provider: "copilot-only", permissions: "manual" } }, () => {});
  const nativeScope = { kind: "copilot" as const, origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: held.identity.run.nativeSession, attachment: "media" }, agentId: null };
  const codec = createCopilotCodec({ origin: nativeScope.origin, capture: hub, media: store.capture.handler }); let gaps = 0;
  const off = driver.controller.observe(value => { if (value.kind === "copilot") codec.observe(value.value); else if (value.kind === "historyGap") gaps++; });
  try {
    driver.event("tool.execution_complete", { toolCallId: "tool-image", success: true, result: { content: "caption", contents: [{ type: "image", mimeType: "image/svg+xml", data: encoded }], binaryResultsForLlm: [{ type: "image", mimeType: "image/svg+xml", data: encoded }] } });
    assert.equal(gaps, 0); assert.equal(rowMedia(hub.snapshot(nativeScope).rows[0]!).length, 2); await store.capture.drain(); assert.equal(store.entries.size, 2);
    assert.equal(hub.snapshot(nativeScope).rows[0]!.body.kind, "complete"); assert.equal(driver.controller.interactions(held.identity.run).current().baseline, "complete");
    assert.equal(projectCopilotMediaEvent({ type: "tool.execution_start", data: { arguments: { image: { type: "image", mimeType: "image/svg+xml", data: encoded } } } }), null);
    driver.event("tool.execution_complete", { toolCallId: "too-much-metadata", success: true, result: { content: "x".repeat(65536), contents: [{ type: "image", mimeType: "image/svg+xml", data: encoded }] } });
    assert.equal(gaps, 1); assert.equal(store.entries.size, 2, "an image exception cannot admit oversized ordinary metadata");
    assert.equal(driver.counts.sends, 0);
  } finally { off(); await held.stopTree(); driver.controller.dispose(); store.capture.close(); await store.capture.drain(); }
});

test("one Host file owner resolves exact child-relative captures and rejects stale metadata without adopting root cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "v8-child-file-context-")), cwd = join(root, "root"), childCwd = join(root, "child"); await mkdir(cwd); await mkdir(childCwd);
  await writeFile(join(cwd, "note.txt"), "root bytes"); await writeFile(join(childCwd, "note.txt"), "child bytes");
  const held = deferred<void>(); let metadata = 0;
  const driver = scriptedHost("codex", { cwd }), host = await openHost({ directory: join(root, "owner"), cwd, scope, controller: driver.controller, policy: nativeInput.policy,
    history: { port: (_run, attached) => ({ scope: attached, mode: "active", read: async () => ({ scope: attached, status: "unsupported", records: [], gaps: [], hasMore: false, nextCursor: null }) }),
      pathContext: async (_run, attached, current) => { metadata++; if (attached.kind === "codex" && attached.threadId === "held-child") await held.promise; current(); return { cwd: childCwd, dialect: "posix" }; } } });
  try {
    await host.session.submit({ scope, id: "create", generation: 0, command: { type: "create" } }); const binding = (await host.binding())!;
    assert.equal(binding.history.kind, "codex"); if (binding.history.kind !== "codex") throw Error("Codex expected");
    const child = { ...binding.history, threadId: "child" };
    for (const id of ["child", "held-child"]) driver.notify("thread/started", { thread: { id, sessionId: binding.run.nativeSession, parentThreadId: binding.run.nativeSession } });
    const fileScope = host.fileScope()!, parent = await host.files.call("capture", { scope: fileScope, sourceKey: "root-link", path: "note.txt" });
    const [a, b] = await Promise.all([host.files.call("capture", { scope: fileScope, sourceKey: "child-link", path: "note.txt", historyScope: child }), host.files.call("capture", { scope: fileScope, sourceKey: "child-link", path: "note.txt", historyScope: child })]);
    assert.deepEqual(a, b); assert.deepEqual(a.owner, parent.owner); assert.notEqual(a.sha256, parent.sha256); assert.equal(a.sha256, createHash("sha256").update("child bytes").digest("hex")); assert.equal(metadata, 1);
    await assert.rejects(host.files.call("capture", { scope: fileScope, sourceKey: "child-link", path: join(cwd, "note.txt"), historyScope: child }), { code: "CONFLICT" });
    await assert.rejects(host.files.call("capture", { scope: fileScope, sourceKey: "foreign", path: "note.txt", historyScope: { ...child, threadId: "foreign" } }), { code: "FENCED" });
    await assert.rejects(host.files.call("capture", { scope: fileScope, sourceKey: "stale", path: "note.txt", historyScope: { ...child, origin: { ...child.origin, attachment: "other" } } }), { code: "FENCED" });
    assert.equal(metadata, 1);
    const pending = host.files.call("capture", { scope: fileScope, sourceKey: "held", path: "note.txt", historyScope: { ...child, threadId: "held-child" } }); const rejected = assert.rejects(pending, { code: "FENCED" });
    await until(() => metadata === 2); await host.session.submit({ scope, id: "stop", generation: binding.run.generation, command: { type: "stop" } }); held.resolve(); await rejected;
    assert.equal(driver.counts.sends, 0); assert.equal(driver.counts.bodyReads, 0);
  } finally { held.resolve(); await host.terminate(); driver.controller.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("large Codex output/tool leaves share the framing map and capture original bytes once while metadata stays bounded", async () => {
  const wire = new Wire(), store = files(), actions: Action[] = [];
  const codec = new CodexCodec({ origin: { connection: scope.connection, principal: scope.principal, host: scope.host, nativeSession: "native", attachment: "epoch" }, rootThreadId: "native", capture: { open() {}, emit(_scope, value) { actions.push(...value); }, reset() {} }, media: store.capture.handler });
  const rpc = new CodexStdioRpc(wire, value => codec.observe(value), () => {}); await rpc.initialize();
  try {
    const native = { method: "item/completed", params: { threadId: "native", turnId: "turn", item: { type: "mcpToolCall", id: "output", status: "completed", result: { content: [{ type: "text", text: "native output" }, { type: "image", data: encoded, mimeType: "image/svg+xml" }] }, arguments: { type: "image", data: "opaque argument" } } } };
    assert.ok(Buffer.byteLength(JSON.stringify(native)) > 2_000_000);
    assert.ok(projectCodexMediaNotification(native)); wire.frame(native); wire.frame(native);
    assert.equal(rpc.observation().connected, true); assert.equal(codec.diagnostics().rejected, 0); assert.equal(store.capture.diagnostics().occurrences, 1);
    await store.capture.drain(); assert.equal(store.entries.size, 1); assert.deepEqual([...store.entries.values()][0]!.bytes, new Uint8Array(image));
    assert.equal(JSON.stringify(actions).includes(encoded.slice(0, 100)), false);
    const result = rpc.request("thread/items/list", {}); wire.reply("thread/items/list", { data: [{ turnId: "turn", item: native.params.item }], nextCursor: null });
    assert.equal(((await result) as { data: { item: typeof native.params.item }[] }).data[0]!.item.result.content[1]!.data, encoded);
    assert.equal(projectCodexMediaResult("thread/read", { thread: { turns: [{ items: [native.params.item] }] } }), null, "unselected response paths never bypass frame bounds");
    const ordinary = { ...native, params: { ...native.params, item: { ...native.params.item, arguments: { image: encoded } } } };
    wire.frame(ordinary); assert.equal(rpc.diagnostics().rpc.failure, "invalidFrame"); assert.equal(store.entries.size, 1, "opaque arguments cannot hide behind image allowance");
  } finally { await rpc.close(); store.capture.close(); }
});

test("actual Host publishes native inline and disk capture settlement through its existing history stream without changing body provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "v8-host-media-delivery-")), directory = join(root, "host"), cwd = join(root, "workspace"); await mkdir(cwd);
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const pngEncoded = Buffer.from(png).toString("base64"), path = join(cwd, "output.png"); await writeFile(path, png);
  let pageReads = 0;
  const driver = scriptedHost("codex", { cwd }), host = await openHost({ directory, cwd, scope, policy: nativeInput.policy, controller: driver.controller, observationMs: 60000,
    history: { port(_run, history, media) {
      if (history.kind !== "codex") throw Error("Wrong native family");
      return createCodexHistoryPort({ scope: history, ...(media ? { media } : {}), authorize: async () => {}, list: async request => {
        pageReads++; return { data: [{ turnId: "historical-turn", startedAtMs: 1, completedAtMs: 2, item: request.cursor === null
          ? { type: "agentMessage", id: "baseline", text: "cold baseline" }
          : { type: "imageGeneration", id: "older-output", status: "native-extension", result: pngEncoded } }], nextCursor: request.cursor === null ? "older-media" : null, backwardsCursor: "back" };
      } });
    } }
  });
  const submit = async (type: "create" | "stop", id: string) => host.session.submit({ scope, id, generation: (await host.session.snapshot(scope)).generation, command: { type } });
  let stream: ReturnType<typeof host.history.watch> | undefined;
  try {
    await submit("create", "media-create"); const binding = (await host.binding())!;
    stream = host.history.watch(binding.history); stream.drain();
    driver.notify("item/started", { threadId: binding.run.nativeSession, turnId: "turn", item: { type: "imageGeneration", id: "generated", status: "in_progress", result: "" } });
    assert.deepEqual(rowMedia(host.history.snapshot(binding.history).rows[0]!), []);
    driver.notify("item/completed", { threadId: binding.run.nativeSession, turnId: "turn", item: { type: "imageGeneration", id: "generated", status: "completed", result: pngEncoded } });
    driver.notify("item/completed", { threadId: binding.run.nativeSession, turnId: "turn", item: { type: "imageView", id: "disk", path } });
    const pending = host.history.snapshot(binding.history); assert.equal(pending.rows.length, 2);
    assert.ok(pending.rows.every(row => rowMedia(row)[0]!.state === "pending"));
    const before = pending.rows.map(row => ({ id: row.id, lifecycle: row.lifecycle, body: row.body, contentVersion: row.contentVersion }));
    await until(() => host.history.snapshot(binding.history).rows.every(row => rowMedia(row)[0]!.state === "available"), 30000);
    const settled = host.history.snapshot(binding.history); assert.ok(settled.revision > pending.revision);
    assert.deepEqual(settled.rows.map(row => ({ id: row.id, lifecycle: row.lifecycle, body: row.body, contentVersion: row.contentVersion })), before);
    assert.deepEqual(settled.coverage, pending.coverage); assert.deepEqual(settled.activity, pending.activity);
    const frames = stream.drain(); assert.ok(frames.some(frame => frame.kind === "commit" && frame.changes.some(change => change.kind === "replaceRow" && rowMedia(change.row).some(media => media.state === "available"))));
    for (const row of settled.rows) {
      const media = rowMedia(row)[0]!, owner = host.fileScope()!;
      const status = await host.files.call("status", { scope: owner, id: media.artifactId! }); assert.equal(status.state, "committed");
      if (status.state !== "committed") throw Error("Artifact not committed");
      assert.equal(status.artifact.sha256, createHash("sha256").update(png).digest("hex"));
      const lease = await host.files.call("acquire", { scope: owner, id: status.artifact.id });
      try { assert.deepEqual(await host.files.call("read", { scope: owner, leaseId: lease.leaseId, offset: 0, length: png.length }), png); }
      finally { await host.files.call("release", { scope: owner, leaseId: lease.leaseId }); }
    }
    assert.equal(pageReads, 0, "healthy native media and observer delivery perform zero history reads");
    driver.notify("thread/reverted", { threadId: binding.run.nativeSession });
    assert.equal((await host.history.recover(binding.history)).state, "value");
    const boundary = host.history.snapshot(binding.history); assert.equal(boundary.olderEdge.state, "available");
    if (boundary.olderEdge.state !== "available") throw Error("Missing older boundary");
    const older = await host.history.older(binding.history, boundary.olderEdge.cursor, boundary.generation);
    const historicalMedia = rowMedia(older.rows[0]!)[0]!;
    assert.equal(historicalMedia.state, "available", "private older page returns final media resolution after finite file jobs");
    assert.equal(older.rows[0]!.lifecycle, "completed"); assert.equal(pageReads, 2);
    assert.equal(host.history.snapshot(binding.history).rows.some(row => row.id === older.rows[0]!.id), false, "private older page does not expand current stream residency");
    const artifact = await host.files.call("status", { scope: host.fileScope()!, id: historicalMedia.artifactId! });
    assert.equal(artifact.state, "committed"); if (artifact.state === "committed") assert.equal(artifact.artifact.sha256, createHash("sha256").update(png).digest("hex"));
    assert.equal(driver.counts.bodyReads, 0); assert.equal(driver.counts.sends, 0); await submit("stop", "media-stop"); await stream.return(); stream = undefined; await host.close();
  } finally { await stream?.return(); await host.terminate(); driver.controller.dispose(); await rm(root, { recursive: true, force: true }); }
});
