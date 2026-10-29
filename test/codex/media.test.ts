import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStore } from "../../src/files/node.js";
import type { StoredFile } from "../../src/files/index.js";
import type { CodexMediaInput } from "../../src/codex/node.js";
import { fixture, defaultHandler, opening } from "./fixtures.js";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(16).fill(0)]);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function files(work: (store: FileStore, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "multiplex-codex-media-")),
    directory = join(root, "files");
  await mkdir(directory, { mode: 0o700 });
  const store = await FileStore.open({ directory });
  const path = join(root, "image.png");
  await writeFile(path, png);
  try {
    await work(store, path);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function capture(
  store: FileStore,
  path: string,
  input: CodexMediaInput,
): Promise<StoredFile> {
  const source = input.source as Record<string, unknown>;
  const bytes =
    typeof source.path === "string"
      ? (assert.equal(source.path, path), await readFile(path))
      : Buffer.from(String(source.data), "base64");
  return store.put(
    input.run.scope,
    { id: input.assetId, name: "image.png", mediaType: "image/png", retention: "cache" },
    bytes,
    "capture",
  );
}
test("live Codex media uses real scoped immutable bytes; late completion cannot restore old text and Stop retains jobs", () =>
  files(async (store, path) => {
    const first = deferred<void>(),
      second = deferred<void>();
    let count = 0;
    const work: Promise<StoredFile>[] = [];
    const f = await fixture({
      media: {
        capture(input) {
          const gate = ++count === 1 ? first : second;
          const pending = gate.promise.then(() => capture(store, path, input));
          work.push(pending);
          return pending;
        },
      },
    });
    try {
      const { capsule, result } = await f.open(),
        wire = f.wires[0]!,
        history = f.adapter.history(result.run).window();
      const binary = {
        type: "image",
        data: Buffer.from(png).toString("base64"),
        mimeType: "image/png",
      };
      wire.emit({
        method: "item/started",
        params: {
          threadId: "native-root",
          turnId: "turn",
          item: {
            id: "tool",
            type: "mcpToolCall",
            result: { content: [{ type: "text", text: "old partial" }, binary] },
          },
        },
      });
      await tick();
      assert.equal(count, 1);
      wire.emit({
        method: "item/completed",
        params: {
          threadId: "native-root",
          turnId: "turn",
          item: {
            id: "tool",
            type: "mcpToolCall",
            result: { content: [{ type: "text", text: "new full output" }, binary] },
          },
        },
      });
      first.resolve();
      await work[0];
      await tick();
      const row = history.getSnapshot().rows[0]!;
      assert.equal(row.lifecycle, "completed");
      assert.equal(row.body.kind === "complete" && row.body.text, "new full output");
      assert.equal(
        (
          row.native.assets as {
            state: string;
          }[]
        )[0]!.state,
        "ready",
      );
      assert.equal(JSON.stringify(row).includes("base64"), false);
      wire.emit({
        method: "item/completed",
        params: {
          threadId: "native-root",
          turnId: "turn",
          item: { id: "image", type: "imageView", path },
        },
      });
      await tick();
      assert.equal(count, 2);
      const stopped = await f.adapter.stop(capsule);
      assert.equal(stopped.noAutomaticContinuation, true);
      assert.equal(f.adapter.readiness().ready, false);
      second.resolve();
      await work[1];
      await tick();
      assert.equal(f.adapter.readiness().ready, true);
      assert.equal(
        wire.requests.some((request) => request.method === "turn/start"),
        false,
      );
      assert.equal(JSON.stringify(history.getSnapshot()).includes(path), false);
    } finally {
      first.resolve();
      second.resolve();
      await f.cleanup();
    }
  }));
test("cold stopped Codex image pages materialize through the same port without Resume and preserve child scope", () =>
  files(async (store, path) => {
    let captureStream = "";
    const f = await fixture(
      {
        media: {
          async capture(input) {
            captureStream = input.stream;
            return capture(store, path, input);
          },
        },
      },
      (request, wire) =>
        request.method === "thread/timeline/list"
          ? {
              threadId: request.params!.threadId,
              data: [
                {
                  position: 1,
                  type: "item",
                  turnId: "old",
                  item: { id: "image", type: "imageView", path },
                },
              ],
              nextCursor: null,
            }
          : defaultHandler(request, wire),
    );
    try {
      const reader = await f.adapter.reader({
        opening: { ...opening, operationId: "image-reader" },
        async begin() {},
        async owned() {},
        async released() {},
      });
      const run = { scope: opening.scope, generation: 1, nativeSession: "native-root" };
      const page = await reader
        .history({ run, attachment: "read-attachment", stream: "native-child" })
        .read({ cursor: null, count: 100 }, () => {});
      assert.equal(page.status, "page");
      if (page.status === "page") {
        assert.equal(
          (
            page.rows[0]!.native.assets as {
              state: string;
            }[]
          )[0]!.state,
          "ready",
        );
        assert.equal(JSON.stringify(page).includes(path), false);
      }
      assert.equal(captureStream, "native-child");
      assert.equal(
        f.wires[0]!.requests.some((request) =>
          ["thread/start", "thread/resume"].includes(request.method),
        ),
        false,
      );
      await reader.close();
    } finally {
      await f.cleanup();
    }
  }));
test("native image paths without a materializer stay unavailable metadata rather than public path authority", async () => {
  const f = await fixture();
  try {
    const { result } = await f.open();
    f.wires[0]!.emit({
      method: "item/completed",
      params: {
        threadId: "native-root",
        turnId: "t",
        item: { id: "image", type: "imageView", path: "/private/native.png" },
      },
    });
    const row = f.adapter.history(result.run).window().getSnapshot().rows[0]!;
    assert.equal(JSON.stringify(row).includes("/private"), false);
    assert.equal(
      (
        row.native.assets as {
          state: string;
        }[]
      )[0]!.state,
      "unavailable",
    );
    f.wires[0]!.emit({
      method: "item/completed",
      params: {
        threadId: "native-root",
        turnId: "t",
        item: {
          id: "native-message",
          type: "userMessage",
          clientUserMessageId: "exact-original",
          content: [{ type: "text", text: "sent" }],
        },
      },
    });
    f.wires[0]!.emit({
      method: "item/completed",
      params: {
        threadId: "native-root",
        turnId: "t",
        item: {
          id: "looks-original",
          type: "userMessage",
          content: [{ type: "text", text: "other" }],
        },
      },
    });
    const rows = f.adapter.history(result.run).window().getSnapshot().rows;
    assert.equal(
      rows.find((row) => row.id === "native-root:native-message")!.native.originalId,
      "exact-original",
    );
    assert.equal(
      rows.find((row) => row.id === "native-root:looks-original")!.native.originalId,
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});
test("cold-page publication cannot admit captures after the bounded preparation owner settles", () =>
  files(async (store, path) => {
    let captures = 0;
    const work: Promise<StoredFile>[] = [];
    let reader:
      Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["adapter"]["reader"]>> | undefined;
    const f = await fixture(
      {
        media: {
          capture(input) {
            captures++;
            const pending = capture(store, path, input);
            work.push(pending);
            return pending;
          },
        },
      },
      (request, wire) =>
        request.method === "thread/timeline/list"
          ? {
              threadId: request.params!.threadId,
              data: [
                {
                  position: 1,
                  type: "item",
                  turnId: "old",
                  item: {
                    id: "six-images",
                    type: "mcpToolCall",
                    result: {
                      content: Array.from({ length: 6 }, () => ({
                        type: "image",
                        data: Buffer.from(png).toString("base64"),
                        mimeType: "image/png",
                      })),
                    },
                  },
                },
              ],
              nextCursor: null,
            }
          : defaultHandler(request, wire),
    );
    try {
      reader = await f.adapter.reader({
        opening: { ...opening, operationId: "bounded-image-reader" },
        async begin() {},
        async owned() {},
        async released() {},
      });
      const run = { scope: opening.scope, generation: 1, nativeSession: "native-root" };
      const page = await reader
        .history({ run, attachment: "read-attachment", stream: "native-root" })
        .read({ cursor: null, count: 100 }, () => {});
      assert.equal(page.status, "page");
      if (page.status === "page") {
        const assets = page.rows[0]!.native.assets as { state: string }[];
        assert.equal(assets.length, 6);
        assert.equal(assets.filter((asset) => asset.state === "ready").length, 4);
        assert.equal(assets.filter((asset) => asset.state === "unavailable").length, 2);
        assert.equal(
          assets.some((asset) => asset.state === "pending"),
          false,
        );
      }
      await tick();
      assert.equal(captures, 4);
      assert.equal(reader.readyToClose(), true);
      await reader.close();
    } finally {
      await Promise.allSettled(work);
      await reader?.close();
      await f.cleanup();
    }
  }));
