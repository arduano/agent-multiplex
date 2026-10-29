import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AttachmentOwner } from "../../src/attachments/index.js";
import type { AssetRemote, UploadSpec } from "../../src/assets/index.js";
import { Chat } from "../../src/chat/index.js";
import { RetainedWorkspace } from "../../src/client/index.js";
import type { StoredFile } from "../../src/files/index.js";
import { deferred, fixture, scope } from "../client/fixture.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
test("actual composer picker/drop/paste confirm files, block Send during transfer and dispatch one exact text-plus-ID payload", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    barrier = deferred<void>();
  let spec!: UploadSpec;
  const confirmed = new Map<string, StoredFile>();
  const status = () => ({
    state: "receiving" as const,
    id: spec.id,
    token: "token",
    received: 0,
    bytes: spec.bytes,
    expiresAt: 1000,
  });
  const remote: AssetRemote = {
    async begin(input) {
      spec = input.file;
      return status();
    },
    async status(input) {
      const file = confirmed.get(input.id);
      return file ? { state: "complete", file } : { state: "unknown", id: input.id };
    },
    async abort() {},
    async acquire() {
      throw Error("unused");
    },
  };
  const uploads = new AttachmentOwner(view.entry, remote, {
    async sendFile(source) {
      const fileSpec = source.metadata!.file;
      const manifest = {
        transferId: "fixture",
        name: source.name,
        size: source.size,
        digest: "0".repeat(64),
        chunkSize: 65536,
        chunkCount: 1,
        metadata: source.metadata,
      };
      return {
        manifest,
        cancel() {},
        async *progress() {},
        result: (async () => {
          await barrier.promise;
          const file: StoredFile = {
            ...fileSpec,
            kind: "stored",
            scope,
            origin: "upload",
            retention: "session",
          };
          confirmed.set(file.id, file);
          return { manifest, resumed: false, durationMs: 0 };
        })(),
      };
    },
  });
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(
      h(Chat, {
        view,
        attachments: uploads,
        actions: {
          draft(text, snapshot) {
            return {
              id: "files-once",
              kind: "send",
              run: snapshot.state!.run!,
              optimisticText: text,
              payload: { text, attachments: snapshot.attachments.map((file) => ({ id: file.id })) },
            };
          },
        },
      }),
    );
  });
  const picked = new File(["one"], "one.txt", { type: "text/plain" }),
    dropped = new File(["two"], "two.txt", { type: "text/plain" }),
    pasted = new File(["three"], "three.txt", { type: "text/plain" });
  await act(async () => {
    node.root
      .findByProps({ type: "file" })
      .props.onChange({ currentTarget: { files: [picked], value: "picked" } });
  });
  await act(async () => {
    node.root
      .findByType("form")
      .props.onDrop({ preventDefault() {}, dataTransfer: { files: [dropped] } });
    node.root.findByType("form").props.onPaste({
      preventDefault() {},
      clipboardData: { files: [pasted], getData: () => "" },
    });
  });
  await act(async () => {
    node.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  assert.equal(f.feed.dispatches.length, 0);
  assert.equal(uploads.getSnapshot().busy, true);
  await act(async () => {
    barrier.resolve();
    await new Promise<void>((resolve) => {
      if (!uploads.getSnapshot().busy) return resolve();
      const release = uploads.subscribe(() => {
        if (!uploads.getSnapshot().busy) {
          release();
          resolve();
        }
      });
    });
  });
  assert.deepEqual(
    view.entry.getSnapshot().attachments.map((file) => file.name),
    ["one.txt", "two.txt", "three.txt"],
  );
  await act(async () => {
    await view.entry.setDraft("with files");
  });
  const ids = view.entry.getSnapshot().attachments.map((file) => ({ id: file.id }));
  await act(async () => {
    const submit = node.root.findByType("form").props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
  });
  assert.equal(f.feed.dispatches.length, 1);
  assert.deepEqual(f.feed.dispatches[0]!.command.payload, { text: "with files", attachments: ids });
  assert.deepEqual(view.entry.getSnapshot().attachments, []);
  await act(async () => node.unmount());
  await uploads.close();
  await workspace.settled();
  await workspace.close();
});
