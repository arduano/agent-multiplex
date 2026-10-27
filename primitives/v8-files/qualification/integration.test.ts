import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryHub, HistoryWorkspace, createCodexCodec, createCopilotCodec, rowMedia } from "../../v8-history/src/index.js";
import type { Scope } from "../../v8-history/src/index.js";
import { ScriptedActionOwner, ScriptedLink } from "../../v8-history/src/scripted/link.js";
import { FileHost } from "../src/host/index.js";
import { FileWorkspace, MemoryDraftPersistence } from "../src/client/index.js";
import { NativeFileCapture, prepareCodexImage, prepareCopilotImage } from "../src/native/index.js";
import { FileError, type FilePort, type FileScope } from "../src/contracts/types.js";

const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
for (const kind of ["codex", "copilot"] as const) {
  test(`${kind}: durable uploaded image and disk snapshot compose with actual retained history through zero viewers, reconnect and original receipt`, async () => {
    const root = mkdtempSync(join(tmpdir(), "v8-files-conversation-")), cwd = join(root, "workspace"); mkdirSync(cwd, { mode: 0o700 });
    const owner: FileScope = { connection: "isolated", principal: "owner", host: kind, session: `${kind}-root` };
    const origin = { connection: owner.connection, principal: owner.principal, host: owner.host, nativeSession: owner.session, attachment: "binding-1" };
    const scope: Scope = kind === "codex" ? { kind, origin, threadId: owner.session } : { kind, origin, agentId: null };
    let host: FileHost | undefined, files: FileWorkspace | undefined, link: ScriptedLink | undefined, capture: NativeFileCapture | undefined;
    try {
      host = await FileHost.open({ directory: join(root, "store"), bindings: [{ scope: owner, cwd, dialect: "posix" }], limits: { sessionBytes: 4096, hostBytes: 8192 } });
      const hub = new HistoryHub({ maxReplayFrames: 1 }); const history = new HistoryWorkspace({ connection: owner.connection, principal: owner.principal });
      let loseCommit = true;
      const actualHost = host;
      const lossy: FilePort = { async call(method, input) {
        const result = await actualHost.call(method, input);
        if (method === "commit" && loseCommit) { loseCommit = false; throw new FileError("IO", "Scripted lost commit reply"); }
        return result;
      } };
      files = new FileWorkspace({ history, persistence: new MemoryDraftPersistence(), port: lossy }); await files.bind(owner, scope);
      const draft = await files.saveDraft(owner, { id: `image-${kind}`, name: "input.png", mediaType: "image/png", blob: new Blob([png]) });
      await files.recordRequest(owner, draft.manifest.id, "original-send");
      await assert.rejects(files.upload(owner, draft.manifest.id), /lost commit/);
      const artifact = await files.reconcile(owner, draft.manifest.id);
      assert.equal(artifact.id, draft.manifest.id);
      const nativeImage = kind === "codex" ? await prepareCodexImage({ harness: kind, scope: owner, artifact, bytes: png }) : await prepareCopilotImage({ harness: kind, scope: owner, artifact, bytes: png });
      capture = new NativeFileCapture({ port: host, mapScope: current => {
        assert.equal(current.origin.nativeSession, owner.session); return owner;
      } });
      const media = capture.handler;
      const codec = kind === "codex" ? createCodexCodec({ origin, capture: hub, rootThreadId: owner.session, knownStart: true, media }) : createCopilotCodec({ origin, capture: hub, knownStart: true, media });
      let event = 0;
      const observe = (type: string, data: Record<string, unknown>) => codec.observe(kind === "codex" ? { method: type, params: { threadId: owner.session, turnId: "turn", ...data } } : { id: `event-${++event}`, type, data, parentId: null, timestamp: "2026-10-23T00:00:00Z" });
      link = new ScriptedLink(hub, history, scope); const actions = new ScriptedActionOwner(scope); link.connect();
      await host.call("protect", { scope: owner, operationId: "original-send", artifactIds: [artifact.id], consumers: ["native-input"] });
      link.send(actions, "original-send", { text: "original image Send", artifactId: artifact.id }, true);
      if (kind === "codex") {
        observe("turn/started", { turn: { id: "turn", status: "inProgress", items: [], itemsView: "notLoaded" } });
        observe("item/completed", { item: { id: "original-native", type: "userMessage", content: [{ type: "text", text: "original image Send" }, nativeImage] } });
      } else {
        observe("assistant.turn_start", { turnId: "turn" });
        observe("user.message", { messageId: "original-native", content: "original image Send", attachments: [nativeImage] });
      }
      link.flush(); files.setPinned(owner, true); await link.disconnect();
      if (kind === "codex") {
        observe("item/completed", { item: { id: "terminal", type: "commandExecution", command: "echo fixture", processId: "fixture-pty", status: "completed", aggregatedOutput: "fixture\n", exitCode: 0 } });
        observe("item/completed", { item: { id: "answer", type: "agentMessage", text: "image received by scripted host" } });
        observe("turn/completed", { turn: { id: "turn", status: "completed", items: [], itemsView: "notLoaded" } });
      } else {
        observe("tool.execution_start", { toolCallId: "terminal", toolName: "shell" });
        observe("tool.execution_complete", { toolCallId: "terminal", success: true, result: { content: "fixture\n" } });
        observe("assistant.message", { messageId: "answer", content: "image received by scripted host" }); observe("assistant.turn_end", { turnId: "turn" });
      }
      assert.equal(hub.owner(scope).subscriberCount, 0); link.connect();
      const rows = history.session(scope).client.current!.rows;
      const user = rows.find(row => row.kind === "user")!;
      const occurrence = rowMedia(user)[0]!;
      await capture.drain(); const capturedImage = capture.artifact(scope, occurrence.id)!;
      assert.equal(capturedImage.sha256, artifact.sha256);
      assert.equal(occurrence.artifactId, capturedImage.id); assert.notEqual(capturedImage.id, artifact.id);
      const imageLease = await host.call("acquire", { scope: owner, id: capturedImage.id });
      assert.deepEqual(new Uint8Array(await host.call("read", { scope: owner, leaseId: imageLease.leaseId, offset: 0, length: png.length })), png);
      await host.call("release", { scope: owner, leaseId: imageLease.leaseId });
      assert.ok(!JSON.stringify(rows).includes(Buffer.from(png).toString("base64")));
      assert.ok(rows.some(row => row.kind === "tool" && row.body.kind === "complete" && row.body.text === "fixture\n"));
      assert.equal(history.session(scope).operations[0]!.settled, false); link.checkOriginal(actions, "original-send");
      assert.equal(actions.submitted, 1); assert.equal(actions.checked, 1);
      assert.deepEqual(link.counters, { nativeBodyReads: 0, nativeMetadataReads: 0, nativeStops: 0 });
      writeFileSync(join(cwd, "note.txt"), "first captured bytes");
      const captured = await host.call("capture", { scope: owner, sourceKey: "note-first-preview", path: "note.txt" });
      writeFileSync(join(cwd, "note.txt"), "later bytes");
      assert.equal((await host.call("capture", { scope: owner, sourceKey: "note-first-preview", path: "note.txt" })).sha256, captured.sha256);
      const current = await host.call("capture", { scope: owner, sourceKey: "explicit-current-1", path: "note.txt", current: true }); assert.notEqual(current.id, captured.id);
      await host.call("settle", { scope: owner, operationId: "original-send" });
      assert.ok(!(await host.call("collect", { scope: owner, requiredBytes: 4096 })).expired.includes(artifact.id));
      await host.call("releaseConsumer", { scope: owner, operationId: "original-send", consumer: "native-input" });
      assert.ok((await host.call("collect", { scope: owner, requiredBytes: 4096 })).expired.includes(artifact.id));
      await assert.rejects(host.call("acquire", { scope: owner, id: artifact.id }), /EXPIRED/);
      assert.equal(rowMedia(user)[0]!.artifactId, capturedImage.id); // Historical identity is stable despite storage expiry.
    } finally { files?.close(); capture?.close(); await capture?.drain(); await link?.disconnect(); await host?.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
