import { copilotSelectionSchema, copilotMessageSchema } from "../../src/copilot/contracts.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json, RunRef } from "../../src/protocol/index.js";
import type { StoredFile } from "../../src/files/index.js";
import { CopilotMedia } from "../../src/copilot/server/media.js";
import type { HistoryWindow } from "../../src/history/index.js";
import type { CopilotAsset } from "../../src/copilot/index.js";
import { fixture, deferred, scope, tick } from "./fixture.js";
const run: RunRef = { scope, generation: 1, nativeSession: "native" };
const stored: StoredFile = {
  kind: "stored",
  scope,
  id: "f",
  name: "image.png",
  bytes: 3,
  sha256: "0".repeat(64),
  mediaType: "image/png",
  origin: "capture",
  retention: "cache",
};
test("media without materializer exposes bounded unavailable metadata, never native bytes or paths", () => {
  const media = new CopilotMedia(
    run,
    "a",
    undefined,
    (value) => value,
    () => {},
  );
  const projected = media.project({
    id: "one",
    type: "user.message",
    data: {
      messageId: "m",
      content: "image",
      attachments: [
        {
          type: "file",
          path: "/private/image.png",
          displayName: "/private/image.png",
          mimeType: "image/png",
          data: "PRIVATE_BASE64",
        },
      ],
    },
  });
  const wire = JSON.stringify(projected);
  assert.equal(wire.includes("PRIVATE_BASE64"), false);
  assert.equal(wire.includes("/private"), false);
  assert.equal(wire.includes('"reason":"noMaterializer"'), true);
});
test("late media publication updates newest row without overwriting content or lifecycle; Stop retains pending cleanup", () => {
  const capture = deferred<StoredFile>();
  const later = deferred<StoredFile>();
  let called = 0;
  return fixture(
    async (value) => {
      const { run, capsule, client } = await value.open();
      client.emit("tool.execution_complete", {
        toolCallId: "t",
        success: true,
        result: {
          content: "first",
          binaryResultsForLlm: [
            { type: "image", assetId: "asset", data: "AAAA", mimeType: "image/png" },
          ],
        },
      });
      const first = value.adapter.history(run).getSnapshot().rows[0]!;
      assert.equal((first.native.assets as Json[])[0] instanceof Object, true);
      // A proved history edit may reuse a row identity in a new window generation.
      const window = value.adapter.history(run) as HistoryWindow;
      window.reset("native rewind");
      window.update({
        rows: [
          {
            id: first.id,
            kind: first.kind,
            lifecycle: "failed",
            body: { kind: "complete", text: "newer failure", evidence: "native" },
            native: first.native,
          },
        ],
      });
      await tick();
      assert.equal(called, 1);
      capture.resolve({ ...stored, scope: run.scope });
      await tick();
      const row = value.adapter.history(run).getSnapshot().rows[0]!;
      assert.equal(row.lifecycle, "failed");
      assert.equal(row.body.kind === "complete" && row.body.text, "newer failure");
      assert.equal((row.native.assets as unknown as CopilotAsset[])[0]!.state, "ready");
      // Retain an actual auxiliary promise through positive process-tree Stop.
      client.emit("tool.execution_complete", {
        toolCallId: "u",
        success: true,
        result: {
          content: "other",
          binaryResultsForLlm: [
            { type: "image", assetId: "other", data: "BBBB", mimeType: "image/png" },
          ],
        },
      });
      // The materializer's second capture returns a separately controlled job.
      await tick();
      const stop = await value.adapter.native.stop(capsule);
      assert.equal(stop.noAutomaticContinuation, true);
      await tick();
      assert.equal(value.adapter.native.readiness().ready, false);
      later.resolve({ ...stored, scope: run.scope });
      await tick();
      assert.equal(value.adapter.native.readiness().ready, true);
    },
    {
      media: {
        async capture() {
          called++;
          return called === 1 ? capture.promise : later.promise;
        },
      },
    },
  );
});
test("bounded media capture fences foreign scope, data conflicts and pending capacity without dropping text", async () => {
  const pending = deferred<StoredFile>();
  const changes: CopilotAsset[] = [];
  let captures = 0;
  const media = new CopilotMedia(
    run,
    "a",
    {
      async capture() {
        captures++;
        return pending.promise;
      },
    },
    (value) => value,
    (asset) => changes.push(asset),
  );
  const event = (id: string, data: string) => ({
    id: `event-${id}`,
    type: "tool.execution_complete",
    data: {
      toolCallId: id,
      success: true,
      result: {
        content: "tool text",
        binaryResultsForLlm: [{ assetId: id, data, mimeType: "image/png" }],
      },
    },
  });
  const pages = ["a", "b", "c", "d", "e"].map((id) => media.project(event(id, "AAAA")));
  assert.equal((pages[4]!.data._assets as CopilotAsset[])[0]!.state, "unavailable");
  const conflict = media.project(event("a", "different"));
  assert.equal((conflict.data._assets as CopilotAsset[])[0]!.state, "unavailable");
  assert.equal(
    (conflict.data._assets as CopilotAsset[])[0]!.state === "unavailable" &&
      (
        conflict.data._assets as Extract<
          CopilotAsset,
          {
            state: "unavailable";
          }
        >[]
      )[0]!.reason,
    "identity",
  );
  pending.resolve({ ...stored, scope: { ...scope, principal: "foreign" } });
  await Promise.all(pages.slice(0, 4).map((page) => media.settled(page)));
  assert.equal(captures, 4);
  assert.equal(
    changes.every((asset) => asset.state === "unavailable" && asset.reason === "captureFailed"),
    true,
  );
});
test("in-flight input release finishes readiness after Stop's independent cleanup", () => {
  const release = deferred<void>();
  let calls = 0;
  return fixture(
    async (value) => {
      const { run, capsule, client } = await value.open();
      await value.adapter.native.send({
        run,
        capsule,
        originalId: "input",
        message: copilotMessageSchema.parse({ text: "file", files: ["f"] }),
      });
      client.emit("user.message", { messageId: "message1", content: "file" });
      client.emit("session.idle", {});
      await tick();
      assert.equal(calls, 1);
      await value.adapter.native.stop(capsule);
      await tick();
      assert.equal(value.adapter.native.readiness().ready, false);
      const before = value.allocations.length;
      const refusal = await value.adapter.native.prepare({
        opening: { scope, generation: 2, operationId: "busy" },
        cwd: value.directory,
        mode: "reopen",
        selectionSource: "requested",
        selection: copilotSelectionSchema.parse({ model: "m" }),
      });
      assert.deepEqual(refusal, { state: "refused", noAllocation: true, code: "BUSY" });
      assert.equal(value.allocations.length, before);
      release.resolve();
      await tick();
      assert.equal(value.adapter.native.readiness().ready, true);
      assert.equal(calls, 1);
    },
    {
      prepareInputs: async () => ({
        attachments: [],
        async release() {
          calls++;
          await release.promise;
        },
      }),
    },
  );
});
test("large optional arguments and attachment metadata cannot erase valid history", () =>
  fixture(async (value) => {
    const { run, client } = await value.open();
    client.emit("tool.execution_start", {
      toolCallId: "large",
      toolName: "largeTool",
      arguments: { content: "x".repeat(70000) },
    });
    client.emit("tool.execution_complete", {
      toolCallId: "large",
      success: true,
      result: {
        content: "kept result",
        binaryResultsForLlm: Array.from({ length: 32 }, (_, index) => ({
          assetId: `asset-${index}`,
          data: "AAAA",
          mimeType: "image/png",
          displayName: "n".repeat(200),
        })),
      },
    });
    const snapshot = value.adapter.history(run).getSnapshot();
    assert.equal(snapshot.gaps.length, 0);
    assert.equal(
      snapshot.rows[0]!.body.kind === "complete" && snapshot.rows[0]!.body.text,
      "kept result",
    );
    assert.equal(
      new TextEncoder().encode(JSON.stringify(snapshot.rows[0]!.native)).length <= 8192,
      true,
    );
  }));
