import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HistoryHub } from "../src/host/history-owner.js";
import { createCodexCodec } from "../src/native/codex/index.js";
import { createCopilotCodec } from "../src/native/copilot/index.js";
import { createCodexHistoryPort } from "../src/native/codex/history.js";
import { createCopilotHistoryPort } from "../src/native/copilot/history.js";
import { inlineMedia, mediaDigest, rowMedia, type NativeMediaHandler } from "../src/contracts/media.js";
import type { CodexScope, CopilotScope, Origin, Row } from "../src/contracts/types.js";

const origin: Origin = { connection: "test", principal: "owner", host: "host", nativeSession: "root", attachment: "epoch" };
const codex: CodexScope = { kind: "codex", origin, threadId: "root" };
const copilot: CopilotScope = { kind: "copilot", origin, agentId: null };
const inputBytes = Buffer.alloc(300_000, 17), encoded = inputBytes.toString("base64");
const imagePart = { type: "image", url: `data:image/png;base64,${encoded}` };
function handler(seen: Parameters<NativeMediaHandler>[0][]): NativeMediaHandler {
  return value => { seen.push(value); return { state: "pending", artifactId: `media-${seen.length}` }; };
}
const event = (id: string, data: Record<string, unknown>, type = "user.message") => ({ id, type, data });

test("media digest agrees with independent SHA-256 across padding boundaries and the full native bound", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1_000, 10 * 1024 * 1024]) {
    const bytes = Buffer.alloc(size, 173);
    assert.equal(mediaDigest(bytes), createHash("sha256").update(bytes).digest("hex"));
  }
  assert.throws(() => inlineMedia("a==a", "image/png"), /MEDIA_ENCODING/);
  assert.throws(() => inlineMedia("====", "image/png"), /MEDIA_ENCODING/);
});

test("Codex user media is stripped before publication and preserves text with exact byte identity", () => {
  const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
  const codec = createCodexCodec({ origin, rootThreadId: "root", capture: hub, media: handler(seen) });
  codec.observe({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: {
    id: "user", type: "userMessage", content: [{ type: "text", text: "look here" }, imagePart],
  } } });
  const snapshot = hub.snapshot(codex), row = snapshot.rows[0]!;
  assert.equal(seen.length, 1); assert.deepEqual(seen[0]!.scope, codex); assert.deepEqual(seen[0]!.bytes, new Uint8Array(inputBytes));
  assert.equal(row.body.kind, "complete"); assert.equal(row.body.text, "look here");
  assert.equal(rowMedia(row)[0]!.sha256, createHash("sha256").update(inputBytes).digest("hex"));
  assert.ok(JSON.stringify(snapshot).length < 5_000); assert.ok(!JSON.stringify(snapshot).includes(encoded.slice(0, 100)));
});

test("Codex unowned children cannot deliver bytes to storage; allowed media and unknown content do not drop text", () => {
  const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
  const codec = createCodexCodec({ origin, rootThreadId: "root", capture: hub, media: handler(seen) });
  const item = { id: "user", type: "userMessage", content: [{ type: "text", text: "kept" }, imagePart, { type: "futureAudio", secret: encoded }] };
  codec.observe({ method: "item/completed", params: { threadId: "foreign", turnId: "t", item } });
  assert.equal(seen.length, 0);
  codec.observe({ method: "item/completed", params: { threadId: "root", turnId: "t", item } });
  const row = hub.snapshot(codex).rows[0]!;
  assert.equal(row.body.kind, "partial"); assert.equal(row.body.text, "kept");
  assert.equal(rowMedia(row)[1]!.state, "unsupported");
  assert.ok(hub.snapshot(codex).coverage.gaps.some(g => g.kind === "unsupported" && g.rowId === row.id));
});

test("Codex media replay fences compare bytes, independently of evolving storage receipt state", () => {
  const hub = new HistoryHub(); let count = 0;
  const codec = createCodexCodec({ origin, rootThreadId: "root", capture: hub,
    media: () => ++count === 1 ? { state: "pending" } : { state: "available", artifactId: "committed" } });
  const send = (url: string) => codec.observe({ method: "item/completed", params: { threadId: "root", turnId: "t", item: { id: "u", type: "userMessage", content: [{ type: "image", url }] } } });
  send(imagePart.url); send(imagePart.url);
  assert.ok(!hub.snapshot(codex).coverage.gaps.some(g => g.id.includes("conflictingFinal")));
  send("data:image/png;base64,AQID");
  assert.ok(hub.snapshot(codex).coverage.gaps.some(g => g.id.includes("conflictingFinal")));
});

test("Codex native references and disk paths remain references without invented inline byte fields", () => {
  const hub = new HistoryHub(); const codec = createCodexCodec({ origin, rootThreadId: "root", capture: hub });
  codec.observe({ method: "item/completed", params: { threadId: "root", turnId: "t", item: { type: "userMessage", id: "u", content: [
    { type: "image", fileId: "native-asset" }, { type: "localImage", path: "/output/a%20b.png" },
  ] } } });
  const media = rowMedia(hub.snapshot(codex).rows[0]!);
  assert.equal(media[0]!.assetId, "native-asset"); assert.equal(media[0]!.absent, true);
  assert.equal(media[1]!.path, "/output/a%20b.png"); assert.equal(media[1]!.state, "unavailable");
  assert.ok(media.every(m => !("data" in m)));
});

test("Codex page normalization strips media before clone bounds and authorizes scope before capture", async () => {
  const seen: Parameters<NativeMediaHandler>[0][] = [];
  const port = createCodexHistoryPort({ scope: codex, authorize: async () => {}, media: handler(seen), list: async () => ({
    data: [{ turnId: "t", startedAtMs: null, completedAtMs: null, item: { type: "userMessage", id: "u", content: [imagePart, { type: "text", text: "page text" }] } }], nextCursor: null, backwardsCursor: null,
  }) });
  const page = await port.read({ scope: codex, cursor: null, count: 1 });
  assert.equal(seen.length, 1); assert.equal(rowMedia(page.records[0]!)[0]!.bytes, inputBytes.length);
  const foreign = createCodexHistoryPort({ scope: codex, authorize: async () => {}, media: handler(seen), list: async () => ({
    data: [{ turnId: "t", threadId: "foreign", startedAtMs: null, completedAtMs: null, item: { type: "userMessage", id: "u", content: [imagePart] } }], nextCursor: null, backwardsCursor: null,
  }) });
  await assert.rejects(foreign.read({ scope: codex, cursor: null, count: 1 }), /FOREIGN_THREAD/); assert.equal(seen.length, 1);
});

test("Copilot strips large image attachments before canonical bounds and byte conflicts remain visible", () => {
  const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
  const codec = createCopilotCodec({ origin, capture: hub, media: handler(seen) });
  const data = { messageId: "m", content: "visible", attachments: [{ type: "blob", mimeType: "image/png", data: encoded }] };
  codec.observe(event("e", data)); const row = hub.snapshot(copilot).rows[0]!;
  assert.equal(seen.length, 1); assert.deepEqual(seen[0]!.bytes, new Uint8Array(inputBytes));
  assert.equal(rowMedia(row)[0]!.bytes, inputBytes.length); assert.ok(JSON.stringify(row).length < 4_000);
  assert.throws(() => codec.observe(event("e", { ...data, attachments: [{ type: "blob", mimeType: "image/png", data: "AQID" }] })), /EVENT_CONFLICT/);
});

test("Copilot preserves native asset absence and distinct omission reasons independently of complete text", () => {
  const hub = new HistoryHub(); const codec = createCopilotCodec({ origin, capture: hub });
  codec.observe(event("e", { messageId: "m", content: "kept", attachments: [
    { type: "image", mimeType: "image/png", assetId: "asset", omittedReason: "asset_unavailable" },
    { type: "image", mimeType: "image/png", omittedReason: "too_large" }, { type: "newBinary", data: encoded },
  ] }));
  const row = hub.snapshot(copilot).rows[0]!, media = rowMedia(row);
  assert.equal(media[0]!.assetId, "asset"); assert.equal(media[0]!.absent, true); assert.equal(media[0]!.omittedReason, "asset_unavailable");
  assert.equal(media[1]!.omittedReason, "too_large"); assert.equal(media[2]!.state, "unsupported");
  assert.equal(row.body.kind, "complete"); assert.equal(row.body.text, "kept");
  assert.ok(hub.snapshot(copilot).coverage.gaps.some(gap => gap.kind === "unsupported"));
});

test("Copilot explicit user text stays complete across live capture and cold mixed unsupported attachments", async () => {
  const content = "Exact explicit text: 日本語 💬\nkeep the final newline\n";
  const blob = Buffer.from("document bytes are not transcript text").toString("base64");
  const native = event("mixed-event", { messageId: "mixed-message", content, attachments: [
    { type: "blob", mimeType: "image/png", data: encoded },
    { type: "blob", mimeType: "text/plain", data: blob },
    { type: "file", path: "/work/context.ts", displayName: "context", taggedFilesEntry: "* /work/context.ts (12 lines)", byteLength: 42 },
    { type: "futureImage", mimeType: "image/png", data: encoded },
  ] });
  const seen: Parameters<NativeMediaHandler>[0][] = [], live = new HistoryHub();
  createCopilotCodec({ origin, capture: live, media: handler(seen) }).observe(native);
  const liveRow = live.snapshot(copilot).rows[0]!;
  assert.deepEqual(liveRow.body, { kind: "complete", text: content, evidence: "nativeFullBody" });
  assert.ok(live.snapshot(copilot).coverage.gaps.some(gap => gap.kind === "unsupported" && gap.rowId === undefined));

  const port = createCopilotHistoryPort({ scope: copilot, mode: "persisted", media: handler(seen), read: async () => ({
    events: [native], cursor: "", hasMore: false, cursorStatus: "ok",
  }) });
  const page = await port.read({ scope: copilot, cursor: null, count: 1 });
  const cold = new HistoryHub(); cold.open(copilot); const owner = cold.owner(copilot), fence = owner.beginRead();
  try { owner.mergeRead(fence, page.records, { state: "end", evidence: "nativeBoundary" }, page.gaps, true); }
  finally { owner.endRead(fence); }
  const coldRow = cold.snapshot(copilot).rows[0]!;
  assert.equal(coldRow.id, liveRow.id); assert.deepEqual(coldRow.body, liveRow.body);
  assert.ok(cold.snapshot(copilot).coverage.gaps.some(gap => gap.kind === "unsupported" && gap.rowId === undefined));
  for (const row of [liveRow, coldRow]) {
    const media = rowMedia(row);
    assert.deepEqual(media.map(item => item.kind), ["image", "unsupported", "unsupported", "unsupported"]);
    assert.equal(media[0]!.bytes, inputBytes.length);
    assert.equal(media[0]!.sha256, createHash("sha256").update(inputBytes).digest("hex"));
    assert.equal(media[1]!.nativeType, "blob"); assert.equal(media[2]!.path, "/work/context.ts");
    assert.equal(media[2]!.taggedFilesEntry, "* /work/context.ts (12 lines)"); assert.equal(media[2]!.declaredBytes, 42);
    assert.equal(media[3]!.nativeType, "futureImage");
    assert.ok(media.slice(1).every(item => item.state === "unsupported" && item.bytes === undefined && item.sha256 === undefined && item.artifactId === undefined));
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes(encoded.slice(0, 100)) && !serialized.includes(blob));
  }
  assert.equal(seen.length, 2); // Only the admitted image from each live/cold observation schedules bytes.
  assert.ok(seen.every(item => item.occurrence.kind === "image" && item.bytes?.length === inputBytes.length));
  assert.throws(() => rowMedia({ native: { media: [{ id: "extended", kind: "file", source: "disk", state: "available", artifactId: "invented" }] } }), /MEDIA_REFERENCE/);
});

test("Copilot exact child scope precedes capture and contradictory markers cannot publish bytes", () => {
  const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
  const codec = createCopilotCodec({ origin, capture: hub, media: handler(seen) });
  codec.observe({ ...event("e", { messageId: "m", content: "child", attachments: [{ type: "blob", mimeType: "image/png", data: encoded }] }), agentId: "child" });
  assert.deepEqual(seen[0]!.scope, { ...copilot, agentId: "child" }); assert.equal(hub.snapshot(copilot).rows.length, 0);
  codec.observe({ ...event("bad", { agentId: "another", content: "bad", attachments: [{ type: "blob", mimeType: "image/png", data: encoded }] }), agentId: "child" });
  assert.equal(seen.length, 1); assert.equal(codec.diagnostics().quarantined.length, 1);
});

test("Copilot file assets retain model-facing identity and frozen tagged prompt context independently of current paths", () => {
  const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
  const codec = createCopilotCodec({ origin, capture: hub, media: handler(seen) });
  codec.observe(event("file", { messageId: "m", content: "keep provenance", attachments: [
    { type: "file", path: "/old/image.png", displayName: "image", mimeType: "image/png", assetId: "resized-asset", byteLength: 128 },
    { type: "file", path: "/work/context.ts", displayName: "context", taggedFilesEntry: "* /work/context.ts (12 lines)" },
  ] }));
  const media = rowMedia(hub.snapshot(copilot).rows[0]!);
  assert.equal(media[0]!.source, "native"); assert.equal(media[0]!.assetId, "resized-asset"); assert.equal(media[0]!.declaredBytes, 128);
  assert.equal(media[0]!.path, "/old/image.png"); assert.equal(media[0]!.absent, true); assert.equal(seen[0]!.bytes, undefined);
  assert.equal(media[1]!.taggedFilesEntry, "* /work/context.ts (12 lines)");
  assert.equal(media[1]!.state, "unsupported");
});

test("Copilot contradictory aliases and exhausted ownership capacity fail before media scheduling", () => {
  const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
  const codec = createCopilotCodec({ origin, capture: hub, media: handler(seen) });
  const data = { messageId: "m", content: "child", parentToolCallId: "tool", attachments: [{ type: "blob", mimeType: "image/png", data: encoded }] };
  codec.observe({ ...event("e", data), agentId: "child" }); assert.equal(seen.length, 1);
  assert.throws(() => codec.observe({ ...event("conflict", data), agentId: "another" }), /ALIAS_CONFLICT/); assert.equal(seen.length, 1);
  const full = createCopilotCodec({ origin, capture: new HistoryHub(), media: handler(seen), limits: { maxScopes: 1 } });
  assert.throws(() => full.observe({ ...event("full", data), agentId: "child" }), /SCOPE_LIMIT/); assert.equal(seen.length, 1);
});

test("Copilot historical media conflicts include exact bytes and foreign persisted payloads are not inspected", async () => {
  let current = encoded; const seen: Parameters<NativeMediaHandler>[0][] = [];
  const port = createCopilotHistoryPort({ scope: copilot, mode: "active", media: handler(seen), read: async () => ({
    events: [event("e", { messageId: "m", content: "page", attachments: [{ type: "blob", mimeType: "image/png", data: current }] })], cursor: "", hasMore: false, cursorStatus: "ok",
  }) });
  const page = await port.read({ scope: copilot, cursor: null, count: 1 }); assert.equal(rowMedia(page.records[0]!)[0]!.bytes, inputBytes.length);
  current = "AQID"; await assert.rejects(port.read({ scope: copilot, cursor: null, count: 1 }), /EVENT_CONFLICT/);
  let inspected = false; const foreignData = { content: "foreign", get attachments() { inspected = true; throw new Error("private"); } };
  const foreign = createCopilotHistoryPort({ scope: copilot, mode: "persisted", media: handler(seen), read: async () => ({
    events: [{ ...event("foreign", foreignData), agentId: "child" }], cursor: "", hasMore: false, cursorStatus: "ok",
  }) });
  await foreign.read({ scope: copilot, cursor: null, count: 1 }); assert.equal(inspected, false);
});

test("Copilot selected tool image leaves preserve exact byte metadata; arbitrary arguments are not media scanned", () => {
  const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
  const codec = createCopilotCodec({ origin, capture: hub, media: handler(seen) });
  codec.observe(event("e", { toolCallId: "tool", success: true, result: { content: "tool text", contents: [
    { type: "text", text: "structured text" }, { type: "image", mimeType: "image/png", data: encoded },
  ] } }, "tool.execution_complete"));
  assert.equal(seen.length, 1); assert.equal(rowMedia(hub.snapshot(copilot).rows[0]!)[0]!.bytes, inputBytes.length);
  assert.throws(() => codec.observe(event("args", { toolCallId: "next", arguments: { arbitrary: imagePart } }, "tool.execution_start")), /LIMIT/);
  assert.equal(seen.length, 1);
});

test("media handler failure never drops text and the typed accessor rejects inline masquerading", () => {
  const hub = new HistoryHub(); const codec = createCopilotCodec({ origin, capture: hub, media: () => { throw new Error("storage full"); } });
  codec.observe(event("e", { messageId: "m", content: "kept", attachments: [{ type: "blob", mimeType: "image/png", data: "AQID" }] }));
  const row = hub.snapshot(copilot).rows[0]!; assert.equal(rowMedia(row)[0]!.state, "unavailable"); assert.equal(row.body.kind, "complete");
  assert.throws(() => rowMedia({ native: { media: [{ id: "x", kind: "image", source: "inline", state: "pending", data: encoded }] } }), /MEDIA_INLINE_FORBIDDEN/);
});

test("Copilot native full tool text stays complete through terminal metadata, late output and persisted Host merge", async () => {
  const leaves = [
    { type: "terminal", text: "terminal display", cwd: "/fixture", exitCode: 0 },
    { type: "shell_exit", shellId: "shell", exitCode: 0, cwd: "/fixture", outputPreview: "truncated preview", outputTruncated: true, outputFilePath: "/fixture/output" },
  ];
  for (const [index, leaf] of leaves.entries()) {
    const hub = new HistoryHub(), seen: Parameters<NativeMediaHandler>[0][] = [];
    const codec = createCopilotCodec({ origin, capture: hub, knownStart: true, media: handler(seen) });
    const toolCallId = `tool-${index}`, full = "EXACT_START\nExact native result 日本語\nEXACT_END\n";
    codec.observe(event(`start-${index}`, { toolCallId, toolName: "bash" }, "tool.execution_start"));
    codec.observe(event(`output-${index}`, { toolCallId, text: "streamed prefix", sequence: 0 }, "tool.shell_output"));
    codec.observe(event(`partial-${index}`, { toolCallId, partialOutput: "partial replacement" }, "tool.execution_partial_result"));
    assert.equal(hub.snapshot(copilot).rows[0]!.body.kind, "partial");
    const completed = event(`complete-${index}`, { toolCallId, success: true, result: { content: "concise", detailedContent: full, contents: [leaf] } }, "tool.execution_complete");
    codec.observe(completed);
    codec.observe(event(`late-partial-${index}`, { toolCallId, partialOutput: "late replacement" }, "tool.execution_partial_result"));
    codec.observe(event(`late-shell-${index}`, { toolCallId, text: "late suffix", sequence: 1 }, "tool.shell_output"));
    const live = hub.snapshot(copilot), row = live.rows[0]!;
    assert.deepEqual(row.body, { kind: "complete", text: full, evidence: "nativeFullBody" });
    assert.equal(row.lifecycle, "completed"); assert.equal(live.coverage.gaps.length, 0); assert.equal(seen.length, 0); assert.deepEqual(rowMedia(row), []);
    const port = createCopilotHistoryPort({ scope: copilot, mode: "persisted", media: handler(seen), read: async () => ({ events: [completed], cursor: "", hasMore: false, cursorStatus: "ok" }) });
    const page = await port.read({ scope: copilot, cursor: null, count: 1 });
    const cold = new HistoryHub(); cold.open(copilot); const owner = cold.owner(copilot), fence = owner.beginRead();
    try { owner.mergeRead(fence, page.records, { state: "end", evidence: "nativeBoundary" }, page.gaps, true); } finally { owner.endRead(fence); }
    assert.deepEqual(cold.snapshot(copilot).rows[0]!.body, row.body); assert.equal(cold.snapshot(copilot).rows[0]!.id, row.id); assert.equal(page.gaps.length, 0); assert.equal(seen.length, 0);
  }
});

test("Copilot terminal previews never invent full bytes and malformed or future leaves remain bounded", async () => {
  const terminal = { type: "terminal", text: "display only", exitCode: 0 };
  const shell = { type: "shell_exit", shellId: "shell", exitCode: 0, outputPreview: "preview only", outputTruncated: false };
  for (const [index, leaf] of [terminal, shell, { ...shell, outputTruncated: true }].entries()) {
    const hub = new HistoryHub(), codec = createCopilotCodec({ origin, capture: hub, knownStart: true });
    codec.observe(event(`s-${index}`, { toolCallId: "tool", toolName: "bash" }, "tool.execution_start"));
    codec.observe(event(`o-${index}`, { toolCallId: "tool", sequence: 0, text: "captured prefix" }, "tool.shell_output"));
    const completed = event(`c-${index}`, { toolCallId: "tool", success: true, result: { contents: [leaf] } }, "tool.execution_complete");
    codec.observe(completed); const row: Row = hub.snapshot(copilot).rows[0]!;
    assert.equal(row.lifecycle, "completed"); assert.deepEqual(row.body, { kind: "partial", text: "captured prefix", missing: ["final"] });
    const page = await createCopilotHistoryPort({ scope: copilot, mode: "persisted", read: async () => ({ events: [completed], cursor: "", hasMore: false, cursorStatus: "ok" }) }).read({ scope: copilot, cursor: null, count: 1 });
    assert.deepEqual(page.records[0]!.body, { kind: "unavailable", reason: "nativeOmitted" }); assert.ok(page.gaps.some(gap => gap.kind === "missingFinal"));
  }
  for (const leaf of [
    { ...terminal, exitCode: 0.5 }, { ...terminal, text: "x".repeat(65_537) }, { ...terminal, cwd: "x".repeat(4097) },
    { ...shell, shellId: "" }, { ...shell, outputTruncated: "false" }, { ...shell, outputPreview: "x".repeat(65_537) }, { ...shell, futureConstraint: true },
  ]) {
    const hub = new HistoryHub(); hub.open(copilot); const codec = createCopilotCodec({ origin, capture: hub });
    const completed = event("bad", { toolCallId: "tool", success: true, result: { content: "cannot publish malformed metadata", contents: [leaf] } }, "tool.execution_complete");
    assert.throws(() => codec.observe(completed), /COPILOT_TERMINAL_/); assert.equal(hub.snapshot(copilot).rows.length, 0);
    await assert.rejects(createCopilotHistoryPort({ scope: copilot, mode: "persisted", read: async () => ({ events: [completed], cursor: "", hasMore: false, cursorStatus: "ok" }) }).read({ scope: copilot, cursor: null, count: 1 }), /COPILOT_TERMINAL_/);
  }
  const hub = new HistoryHub(); createCopilotCodec({ origin, capture: hub }).observe(event("future", { toolCallId: "tool", success: true, result: { content: "native text", contents: [{ type: "futureTerminal", text: "untrusted extension" }] } }, "tool.execution_complete"));
  const row = hub.snapshot(copilot).rows[0]!; assert.equal(row.body.kind, "partial"); assert.equal(rowMedia(row)[0]!.state, "unsupported"); assert.ok(hub.snapshot(copilot).coverage.gaps.some(gap => gap.kind === "unsupported"));
});

test("Codex pinned output/tool image families share live and cold occurrence identity and never scan arguments", async () => {
  const bytes = Buffer.from("exact-output-image-bytes"), encoded = bytes.toString("base64"), dataUrl = `data:image/png;base64,${encoded}`;
  const items = [
    { type: "message", id: "response", content: [{ type: "output_text", text: "response text" }, { type: "input_image", image_url: dataUrl }] },
    ...["functionCallOutput", "function_call_output", "custom_tool_call_output"].map((type, index) => ({ type, id: `output-${index}`, output: [{ type: "input_text", text: "tool text" }, { type: "input_image", image_url: dataUrl }] })),
    { type: "dynamicToolCall", id: "dynamic", contentItems: [{ type: "inputText", text: "dynamic text" }, { type: "inputImage", imageUrl: dataUrl }], arguments: { type: "image", data: "private nonmedia" } },
    { type: "mcpToolCall", id: "mcp", result: { content: [{ type: "text", text: "MCP text" }, { type: "image", data: encoded, mimeType: "image/png" }] }, arguments: { type: "image", data: "private nonmedia" } },
    { type: "imageGeneration", id: "generated", status: "completed", result: encoded, savedPath: "/workspace/generated.png" },
    { type: "image_generation_call", id: "raw-generation", result: encoded },
    { type: "imageView", id: "view", path: "/workspace/view.png" },
  ];
  for (const item of items) {
    const seen: Parameters<NativeMediaHandler>[0][] = [], hub = new HistoryHub();
    createCodexCodec({ origin, rootThreadId: "root", capture: hub, media: handler(seen) }).observe({ method: "item/completed", params: { threadId: "root", turnId: "turn", item } });
    const live = hub.snapshot(codex); assert.equal(live.rows.length, 1, item.type); assert.equal(live.coverage.gaps.filter(gap => gap.kind === "unsupported").length, 0, item.type);
    const page = await createCodexHistoryPort({ scope: codex, media: handler(seen), authorize: async () => {}, list: async () => ({ data: [{ turnId: "turn", item, startedAtMs: 1, completedAtMs: 2 }], nextCursor: null, backwardsCursor: "back" }) }).read({ scope: codex, cursor: null, count: 1 });
    assert.equal(page.gaps.length, 0, item.type);
    const identity = (row: Pick<Row, "native">) => rowMedia(row).map(({ state: _state, artifactId: _artifactId, ...identity }) => identity);
    assert.deepEqual(identity(live.rows[0]!), identity(page.records[0]!), item.type);
    for (const occurrence of seen.filter(value => value.occurrence.source === "inline")) assert.deepEqual(occurrence.bytes, new Uint8Array(bytes));
    assert.equal(rowMedia(live.rows[0]!)[0]!.id.startsWith('["root","turn",'), true);
    assert.equal(JSON.stringify(live).includes(encoded), false);
    assert.equal(JSON.stringify(page.records).includes(encoded), false, "selected bytes do not leak through metadata");
  }
});

test("Codex unsupported output content preserves useful text with explicit gaps and never fetches remote images", async () => {
  const seen: Parameters<NativeMediaHandler>[0][] = [], hub = new HistoryHub();
  const item = { id: "mixed-output", type: "mcpToolCall", result: { content: [{ type: "text", text: "useful native text" }, { type: "image", mimeType: "image/png", data: "AA=A" }, { type: "futureResource", value: "opaque" }], structuredContent: { image: { data: encoded } } } };
  createCodexCodec({ origin, rootThreadId: "root", capture: hub, media: handler(seen) }).observe({ method: "item/completed", params: { threadId: "root", turnId: "turn", item } });
  const body = hub.snapshot(codex).rows[0]!.body; assert.equal(body.kind, "partial");
  assert.equal(body.kind === "partial" && body.text, "useful native text"); assert.equal(seen.length, 0);
  assert.ok(hub.snapshot(codex).coverage.gaps.some(value => value.kind === "unsupported"));
  const remote = { id: "remote", type: "dynamicToolCall", contentItems: [{ type: "inputText", text: "remote linked only" }, { type: "inputImage", imageUrl: "https://example.invalid/private.png" }] };
  const page = await createCodexHistoryPort({ scope: codex, media: handler(seen), authorize: async () => {}, list: async () => ({ data: [{ turnId: "turn", item: remote, startedAtMs: 1, completedAtMs: 2 }], nextCursor: null, backwardsCursor: "back" }) }).read({ scope: codex, cursor: null, count: 1 });
  assert.equal(seen.length, 0); assert.equal(page.records[0]!.body.kind, "partial"); assert.equal(rowMedia(page.records[0]!)[0]!.state, "unsupported");
});

test("Codex image generation keeps opaque native status and captures only actual completed output after an empty start", async () => {
  const seen: Parameters<NativeMediaHandler>[0][] = [], hub = new HistoryHub(), codec = createCodexCodec({ origin, rootThreadId: "root", capture: hub, media: handler(seen) });
  const item = { type: "imageGeneration", id: "generation", status: "in_progress", result: "" };
  codec.observe({ method: "item/started", params: { threadId: "root", turnId: "turn", item } });
  let row = hub.snapshot(codex).rows[0]!; assert.equal(row.lifecycle, "running"); assert.equal(row.native.status, "in_progress"); assert.deepEqual(rowMedia(row), []); assert.equal(seen.length, 0);
  codec.observe({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: { ...item, status: "completed", result: encoded } } });
  row = hub.snapshot(codex).rows[0]!; assert.equal(row.lifecycle, "completed"); assert.equal(rowMedia(row)[0]!.sha256, createHash("sha256").update(inputBytes).digest("hex")); assert.equal(seen.length, 1);
  for (const completedAtMs of [null, 2]) {
    const page = await createCodexHistoryPort({ scope: codex, media: handler(seen), authorize: async () => {}, list: async () => ({ data: [{ turnId: "turn", startedAtMs: 1, completedAtMs, item: { ...item, status: "native-extension-status", result: encoded } }], nextCursor: null, backwardsCursor: "back" }) }).read({ scope: codex, cursor: null, count: 1 });
    assert.equal(page.records[0]!.lifecycle, completedAtMs === null ? "unknown" : "completed"); assert.equal(page.records[0]!.native.status, "native-extension-status");
    assert.equal(seen.length, completedAtMs === null ? 1 : 2);
  }
});
