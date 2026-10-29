import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionReadPort,
  SessionViewPort,
  TranscriptViewPort,
} from "../../src/client/contracts.js";
import { RetainedWorkspace } from "../../src/client/index.js";
import { fixture, scope } from "./fixture.js";

function capabilities(view: SessionViewPort, transcript: TranscriptViewPort) {
  const read: SessionReadPort = {
    scope: view.entry.scope,
    getSnapshot: view.entry.getSnapshot,
    subscribe: view.entry.subscribe,
  };
  // @ts-expect-error Read capabilities cannot dispatch originals.
  read.submit({});
  // @ts-expect-error Residency belongs to the private workspace owner.
  view.entry.acquireView();
  // @ts-expect-error A borrowed entry cannot close the retained owner.
  view.entry.close();
  // @ts-expect-error Private view counts are not consumer API.
  void view.entry.viewCount;
  // @ts-expect-error A read-only transcript has no Send capability.
  transcript.submit({});
  // @ts-expect-error A transcript never fabricates a root draft/entry.
  void transcript.entry;
}
void capabilities;

test("public views and readers are structural capabilities with stable derived transcript snapshots", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope);
  const structural: SessionViewPort = {
    entry: view.entry,
    anchor: view.anchor,
    transcript: view.transcript,
    commit: () => view.commit(),
    submit: (value) => view.submit(value),
    submitDraft: (value) => view.submitDraft(value),
    baseline: () => view.baseline(),
    older: (cursor) => view.older(cursor),
    close: () => view.close(),
  };
  assert.equal(structural.entry.getSnapshot(), view.entry.getSnapshot());
  const before = structural.transcript.getSnapshot();
  assert.equal(
    structural.transcript.getSnapshot(),
    before,
    "External-store snapshots must be stable",
  );
  assert(!("state" in before));
  await structural.entry.setDraft("one retained draft");
  assert.notEqual(structural.transcript.getSnapshot(), before);
  assert.equal(structural.transcript.getSnapshot().history, structural.entry.getSnapshot().history);
  assert.equal(f.observations.opened + f.feed.dispatches.length, 0);
  await workspace.close();
});
