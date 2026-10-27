import assert from "node:assert/strict";
import test from "node:test";
import { createCodexController, type CodexRequests, type CodexTransport } from "../../v8-harness-codex/src/controller.js";
import { createCopilotController, type CopilotSession, type CopilotSessionConfig, type CopilotTransport } from "../../v8-harness-copilot/src/controller.js";
import type { Harness, NativeControlCommand, NativeSendCommand, NativeMessageCommand, NativeStart } from "../../v8-session/src/contracts/types.js";
import type { ArtifactRef } from "../../v8-files/src/contracts/types.js";
import { digest } from "../../v8-files/src/contracts/content.js";
import { ScriptedContainment, type ScriptCounts } from "./fixture.js";

const scope = { connection: "native-send", principal: "owner", host: "host", session: "logical" };
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
async function fixture(kind: Harness) {
  const counts: ScriptCounts = { opens: 0, resumes: 0, sends: 0, stops: 0, discovery: 0, bodyReads: 0, replies: 0 }, containment = new ScriptedContainment(counts);
  const sent: unknown[] = [], controls: string[] = [], model = "scripted-model", nativeSession = `native-${kind}`;
  const catalog = async () => ({ available: true, choices: [{ model, efforts: [] }] });
  const transport: CodexTransport = { request: async <M extends keyof CodexRequests>(method: M, params: CodexRequests[M]) => {
    if (method === "thread/start") return { thread: { id: nativeSession }, model, modelProvider: "route", approvalPolicy: "on-request", sandbox: { type: "dangerFullAccess" } };
    if (method === "turn/start") { sent.push(structuredClone(params)); return { turn: { id: "accepted-turn", items: [{ privateBody: "private-native-echo".repeat(10000) }] } }; }
    if (method === "turn/steer") { sent.push(structuredClone(params)); return { turnId: (params as CodexRequests["turn/steer"]).expectedTurnId }; }
    if (method === "thread/queue/add") { sent.push(structuredClone(params)); return { queuedSubmission: { id: "queued", clientUserMessageId: (params as CodexRequests["thread/queue/add"]).clientUserMessageId } }; }
    controls.push(method); return {};
  }, onNotification: () => () => {}, onRequest: () => () => {} };
  const copilot = (config: CopilotSessionConfig): CopilotSession => ({ sessionId: config.sessionId,
    send: async value => { sent.push(structuredClone(value)); return "accepted-message"; }, abort: async () => {},
    rpc: { model: { getCurrent: async () => ({ modelId: model, providerId: "route" }), switchTo: async () => { controls.push("model"); return { modelState: { modelId: model, providerId: "route" } }; } },
      mode: { set: async () => { controls.push("mode"); return { status: "success", modeApplied: true, modelChanged: false }; } },
      permissions: { setMode: async value => ({ success: true, mode: value.mode }), setRequired: async () => ({ success: true }), handlePendingPermissionRequest: async () => ({ success: true }) }, mcp: { listConfigured: async () => ({ servers: [] }) } } });
  const copilotTransport: CopilotTransport = { createSession: async config => copilot(config), resumeSession: async (_id, config) => copilot(config) };
  const controller = kind === "codex" ? createCodexController({ transport, containment, cwd: "/workspace", model, provider: { id: "route", copilotOnly: true }, catalog }) : createCopilotController({ transport: copilotTransport, containment, cwd: "/workspace", model, provider: { id: "route", copilotOnly: true, config: {} }, catalog, newSessionId: () => nativeSession });
  const input: NativeStart = { scope, generation: 1, operationId: "create", nativeSession: null, placement: "dedicated", policy: kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" } };
  const attachment = await controller.open(input, () => {}), owner = { connection: scope.connection, principal: scope.principal, host: scope.host, session: nativeSession };
  const artifact = async (bytes: Uint8Array = png, mediaType = "image/png"): Promise<ArtifactRef> => ({ kind: "artifact", owner, id: "artifact", name: mediaType === "image/png" ? "image.png" : "document.pdf", mediaType, bytes: bytes.length, sha256: await digest(bytes), capturedAt: 0 });
  return { attachment, sent, controls, artifact, async close() { await attachment.stopTree(); controller.dispose(); } };
}

test("concrete Codex Send preserves ordered image/local-image/mention primitives and returns only accepted turn identity", async () => {
  const f = await fixture("codex"); try {
    const artifact = await f.artifact(), bytes = new Uint8Array(png);
    const command: NativeSendCommand<"codex"> = { type: "send", text: "Inspect these references", nativeInputs: { kind: "codex", items: [{ type: "image", artifact, bytes }, { type: "localImage", path: "/workspace/native.png" }, { type: "mention", path: "/workspace/code.ts", name: "code.ts" }] } };
    const pending = f.attachment.native.invoke(command); bytes.fill(0); const outcome = await pending;
    assert.deepEqual(outcome, { status: "accepted", detail: { turnId: "accepted-turn" } });
    const value = f.sent[0] as CodexRequests["turn/start"]; assert.equal(value.threadId, "native-codex"); assert.equal(value.input.length, 4);
    assert.deepEqual(value.input[0], { type: "text", text: command.text, text_elements: [] });
    assert.deepEqual(value.input[1], { type: "image", url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
    assert.deepEqual(value.input.slice(2), [{ type: "localImage", path: "/workspace/native.png" }, { type: "mention", path: "/workspace/code.ts", name: "code.ts" }]);
    assert.equal(JSON.stringify(outcome).includes("private-native-echo"), false); assert.equal(JSON.stringify(value).includes('"artifact"'), false);
  } finally { await f.close(); }
});

test("concrete Copilot Send uses explicit blob/file attachments without embedding file bytes into prompt", async () => {
  const f = await fixture("copilot"); try {
    const bytes = new TextEncoder().encode("%PDF-scripted native payload"), artifact = await f.artifact(bytes, "application/pdf");
    const command: NativeSendCommand<"copilot"> = { type: "send", text: "Review attachment", nativeInputs: { kind: "copilot", items: [{ type: "blob", artifact, bytes }, { type: "file", path: "/workspace/notes.txt", displayName: "notes" }] } };
    const pending = f.attachment.native.invoke(command); bytes.fill(0); assert.deepEqual(await pending, { status: "accepted", detail: { messageId: "accepted-message" } });
    assert.deepEqual(f.sent, [{ prompt: "Review attachment", mode: "enqueue", attachments: [{ type: "blob", mimeType: "application/pdf", data: Buffer.from("%PDF-scripted native payload").toString("base64"), displayName: "document.pdf" }, { type: "file", path: "/workspace/notes.txt", displayName: "notes" }] }]);
  } finally { await f.close(); }
});


test("steer and explicit queue preserve verified attachments in both concrete native encoders", async () => {
  for (const kind of ["codex", "copilot"] as const) {
    const f = await fixture(kind); try {
      const artifact = await f.artifact(), nativeInputs = kind === "codex" ? { kind, items: [{ type: "image" as const, artifact, bytes: png }] } : { kind, items: [{ type: "blob" as const, artifact, bytes: png }] };
      const steer = kind === "codex" ? { type: "codex.steer" as const, expectedTurnId: "exact-active-turn", text: "correct this", nativeInputs } : { type: "copilot.steer" as const, text: "correct this", nativeInputs };
      assert.equal((await f.attachment.native.invoke(steer as NativeMessageCommand)).status, "accepted");
      if (kind === "codex") {
        const value = f.sent[0] as CodexRequests["turn/steer"];
        assert.equal(value.expectedTurnId, "exact-active-turn"); assert.equal(value.input.length, 2); assert.equal(value.input[1]!.type, "image");
        await f.attachment.native.invoke({ type: "codex.queue.add", text: "explicit queue", clientUserMessageId: "queue-original", nativeInputs } as NativeMessageCommand);
        const queued = f.sent[1] as CodexRequests["thread/queue/add"]; assert.equal(queued.clientUserMessageId, "queue-original"); assert.deepEqual(queued.input[1], value.input[1]);
      } else {
        const value = f.sent[0] as { mode: string; attachments: unknown[] }; assert.equal(value.mode, "immediate"); assert.equal(value.attachments.length, 1);
      }
      assert.deepEqual(f.controls, []);
    } finally { await f.close(); }
  }
});

test("concrete encoders reject corrupt/foreign/wrong-harness or unprepared inputs before native controls or Send", async () => {
  for (const kind of ["codex", "copilot"] as const) {
    const f = await fixture(kind); try {
      const artifact = await f.artifact(), type = kind === "codex" ? "image" : "blob";
      const command = { type: "send", text: "unchanged", nativeInputs: { kind, items: [{ type, artifact, bytes: new Uint8Array(png.length) }] } };
      await assert.rejects(f.attachment.native.invoke(command as NativeControlCommand));
      await assert.rejects(f.attachment.native.invoke({ ...command, nativeInputs: { kind, items: [{ type, artifact: { ...artifact, owner: { ...artifact.owner, principal: "foreign" } }, bytes: png }] } } as NativeControlCommand));
      await assert.rejects(f.attachment.native.invoke({ ...command, nativeInputs: { kind: kind === "codex" ? "copilot" : "codex", items: [] } } as unknown as NativeControlCommand));
      await assert.rejects(f.attachment.native.invoke({ type: "send", text: "unchanged", inputs: { kind, items: [] } } as NativeControlCommand));
      assert.equal(f.sent.length, 0, kind); assert.deepEqual(f.controls, [], kind);
    } finally { await f.close(); }
  }
});

test("Stop during asynchronous private byte encoding fences actual native Send in both concrete controllers", async () => {
  for (const kind of ["codex", "copilot"] as const) {
    const f = await fixture(kind); try {
      const artifact = await f.artifact(), command = { type: "send", text: "must not send after halt", nativeInputs: { kind, items: [{ type: kind === "codex" ? "image" : "blob", artifact, bytes: png }] } };
      const actual = f.attachment.native.invoke(command as NativeControlCommand), halted = f.attachment.stopTree();
      await assert.rejects(actual); await halted; assert.equal(f.sent.length, 0, kind); assert.deepEqual(f.controls, [], kind);
    } finally { await f.close(); }
  }
});
