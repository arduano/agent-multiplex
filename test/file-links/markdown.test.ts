import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ChatMarkdown, FilePreview, HistoryRow } from "../../src/chat/index.js";
import type { FileLink, FileLinkLease, ResolveFile } from "../../src/file-links/index.js";
import type { EntrySnapshot } from "../../src/client/contracts.js";
import type { Row } from "../../src/history/index.js";
import { deferred, runFor, scope } from "../client/fixture.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const file = {
  kind: "stored" as const,
  scope,
  id: "captured",
  name: "note.txt",
  bytes: 4,
  sha256: "a".repeat(64),
  mediaType: "text/plain",
  origin: "capture" as const,
  retention: "cache" as const,
};
const context = { run: runFor(), stream: "child-native-stream", rowId: "native-row" };
const previewButton = (node: ReactTestRenderer) =>
  node.root.findByProps({ "aria-label": "Preview note.txt" });

test("Markdown never captures on render; one explicit click survives streaming rerenders and releases its exact lease", async () => {
  const calls: FileLink[] = [];
  let releases = 0;
  const resolveFile: ResolveFile = async (link) => {
    calls.push(link);
    return {
      state: "ready",
      preview: { kind: "text", file, text: "data" },
      async release() {
        releases++;
      },
    };
  };
  const render = (text: string) =>
    h(StrictMode, null, h(ChatMarkdown, { text, resolveFile, fileContext: context }));
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(render("[File](note.txt) [Website](https://example.test/)"));
  });
  assert.equal(calls.length, 0);
  assert.equal(node.root.findAllByType("a")[0]!.props.href, "https://example.test/");
  await act(async () => {
    const click = previewButton(node).props.onClick;
    click();
    click();
  });
  assert.deepEqual(calls, [{ ...context, href: "note.txt" }]);
  assert.equal(node.root.findAllByType(FilePreview).length, 1);
  await act(async () => {
    node.update(render("[File](note.txt) [Website](https://example.test/)\n\nMore streaming text"));
  });
  assert.equal(calls.length, 1);
  assert.equal(releases, 0);
  assert.equal(node.root.findAllByType(FilePreview).length, 1);
  await act(async () => node.unmount());
  assert.equal(releases, 1);
});

test("late preview completion after unmount releases ownership and never publishes into another row", async () => {
  const late = deferred<FileLinkLease>();
  let releases = 0,
    calls = 0,
    node!: ReactTestRenderer;
  const resolveFile: ResolveFile = () => {
    calls++;
    return late.promise;
  };
  await act(async () => {
    node = create(h(ChatMarkdown, { text: "[File](note.txt)", resolveFile, fileContext: context }));
  });
  await act(async () => {
    previewButton(node).props.onClick();
  });
  assert.equal(calls, 1);
  await act(async () => node.unmount());
  await act(async () => {
    late.resolve({
      state: "ready",
      preview: { kind: "text", file, text: "data" },
      async release() {
        releases++;
      },
    });
  });
  assert.equal(releases, 1);
});

test("HistoryRow resolves against its native origin and absent origin never fabricates root authority", async () => {
  const row: Row = {
    id: context.rowId,
    version: 1,
    kind: "assistant",
    lifecycle: "completed",
    body: { kind: "complete", text: "[File](note.txt)", evidence: "native" },
    native: {},
  };
  const calls: FileLink[] = [];
  const resolveFile: ResolveFile = async (link) => {
    calls.push(link);
    return { state: "unavailable" };
  };
  const origin = {
    scope: { run: context.run, attachment: "attachment", stream: context.stream },
    generation: 1,
  };
  const snapshot = {
    freshness: "current",
    historyFreshness: "current",
    state: null,
    history: { current: null, origins: { [row.id]: origin } },
  } as unknown as EntrySnapshot;
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(h(HistoryRow, { row, snapshot, props: { actions: {}, resolveFile } }));
  });
  await act(async () => {
    previewButton(node).props.onClick();
  });
  assert.deepEqual(calls, [{ ...context, href: "note.txt" }]);
  await act(async () => {
    node.update(
      h(HistoryRow, {
        row,
        snapshot: { ...snapshot, history: { ...snapshot.history, origins: {} } },
        props: { actions: {}, resolveFile },
      }),
    );
  });
  assert.equal(node.root.findAllByType("button").length, 0);
  assert.equal(calls.length, 1);
  await act(async () => node.unmount());
});
