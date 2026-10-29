import assert from "node:assert/strict";
import { test } from "node:test";
import { RetainedWorkspace } from "../../src/client/index.js";
import { HistoryWindow } from "../../src/history/index.js";
import { fixture, row, runFor, runKey, scope, until } from "./fixture.js";

test("one retained entry joins disjoint older commits by positive placement and drops an unanchored replacement snapshot", async () => {
  const f = fixture(),
    run = runFor(),
    window = new HistoryWindow(
      { run, attachment: "capture-1", stream: run.nativeSession },
      { maxRows: 2 },
    );
  window.update({ rows: [row("2"), row("3")] });
  f.feed.windows.set(runKey(run), window);
  const workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().history.rows.length === 2);
  const fence = window.beginRead();
  window.publishRead(
    fence,
    [row("0"), row("1")],
    { state: "end", evidence: "nativeBoundary" },
    "before",
  );
  window.endRead(fence);
  await until(() => view.entry.getSnapshot().history.rows.length === 4);
  assert.deepEqual(
    view.entry.getSnapshot().history.rows.map((value) => value.id),
    ["0", "1", "2", "3"],
  );
  assert.equal(view.entry.getSnapshot().history.residencyOmitted, true);
  window.reset("Explicit native reader cut");
  window.update({ rows: [row("fresh")] });
  await until(() => view.entry.getSnapshot().history.rows[0]?.id === "fresh");
  assert.deepEqual(
    view.entry.getSnapshot().history.rows.map((value) => value.id),
    ["fresh"],
  );
  assert.equal(view.entry.getSnapshot().history.residencyOmitted, false);
  const replacement = new HistoryWindow({
    run,
    attachment: "new-authorized-capture",
    stream: run.nativeSession,
  });
  replacement.update({ rows: [row("new-capture")] });
  await f.observations.offline();
  f.feed.windows.set(runKey(run), replacement);
  f.observations.online();
  await until(() => view.entry.getSnapshot().history.rows[0]?.id === "new-capture");
  assert.deepEqual(
    view.entry.getSnapshot().history.rows.map((value) => value.id),
    ["new-capture"],
  );
  assert.equal(view.entry.getSnapshot().history.residencyOmitted, false);
  release();
  await workspace.settled();
  await workspace.close();
});

test("overlarge protected history frames leave the last valid retained projection intact", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace({ ...f, limits: { maxHistoryRows: 2 } }),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().historyFreshness === "current");
  f.feed.window().update({ rows: [row("a")] });
  await until(() => view.entry.getSnapshot().history.rows.length === 1);
  const before = view.entry.getSnapshot().history;
  f.feed.window().update({ rows: [row("b"), row("c")] });
  await until(() => view.entry.getSnapshot().historyFreshness === "unavailable");
  assert.equal(view.entry.getSnapshot().history, before);
  assert.deepEqual(
    view.entry.getSnapshot().history.rows.map((value) => value.id),
    ["a"],
  );
  release();
  await workspace.settled();
  await workspace.close();
});

test("new empty attachment keeps same-native history visible as stale until an authoritative baseline arrives", async () => {
  const f = fixture(),
    run = runFor(),
    window = new HistoryWindow({ run, attachment: "first", stream: "root" });
  window.update({ rows: [row("known")], olderEdge: { state: "end", evidence: "nativeBoundary" } });
  f.feed.windows.set(runKey(run), window);
  const workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().history.rows.length === 1);
  await f.observations.offline();
  const replacement = new HistoryWindow({ run, attachment: "second", stream: "root" });
  f.feed.windows.set(runKey(run), replacement);
  f.observations.online();
  await until(() => view.entry.getSnapshot().history.current?.scope.attachment === "second");
  assert.equal(view.entry.getSnapshot().historyFreshness, "unobserved");
  assert.equal(view.entry.getSnapshot().history.rows[0]?.id, "known");
  assert.equal(view.entry.getSnapshot().history.origins.known?.scope.attachment, "first");
  replacement.update({
    rows: [
      {
        ...row("known"),
        body: { kind: "complete", text: "native final replacement", evidence: "native" },
      },
    ],
    olderEdge: { state: "end", evidence: "nativeBoundary" },
  });
  await until(() => view.entry.getSnapshot().historyFreshness === "current");
  const body = view.entry.getSnapshot().history.rows[0]!.body;
  assert.equal(body.kind, "complete");
  assert.equal(body.text, "native final replacement");
  assert.equal(view.entry.getSnapshot().history.origins.known?.scope.attachment, "second");
  release();
  await workspace.settled();
  await workspace.close();
});
