import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFrame,
  HistoryWindow,
  type Frame,
  type HistoryRecord,
} from "../../src/history/index.js";
import { full, scope } from "./fixture.js";

test("absolute contiguous commits replay and duplicate exactly; missed revisions require a snapshot", async () => {
  const owner = new HistoryWindow(scope),
    stream = owner.subscribe();
  const initial = (await stream.next()).value!;
  let view = applyFrame(undefined, initial).snapshot!;
  owner.update({ rows: [full("a")] });
  const first = (await stream.next()).value!;
  owner.update({ rows: [full("b")] });
  const second = (await stream.next()).value!;
  assert.equal(applyFrame(view, second).status, "needsSnapshot");
  view = applyFrame(view, first).snapshot!;
  assert.equal(applyFrame(view, first).status, "duplicate");
  view = applyFrame(view, second).snapshot!;
  assert.deepEqual(view, owner.getSnapshot());
  assert(Object.isFrozen(view.rows[0]!.body));
  const replay = owner.subscribe({ generation: 1, revision: 0 });
  assert.deepEqual((await replay.next()).value, first);
  assert.deepEqual((await replay.next()).value, second);
  const altered = structuredClone(second) as Extract<Frame, { kind: "commit" }>;
  assert.throws(
    () =>
      applyFrame(view, {
        ...altered,
        rows: [
          {
            ...altered.rows[0]!,
            body: { kind: "complete", text: "different", evidence: "native" },
          },
        ],
      }),
    /CONFLICT/,
  );
  await replay.return();
  await stream.return();
  owner.close();
});

test("current residency evicts only prior settled rows; new batches and actual running work remain atomic", () => {
  const owner = new HistoryWindow(scope, { maxRows: 2 });
  const running: HistoryRecord = {
    ...full("work"),
    lifecycle: "running",
    body: { kind: "partial", text: "working", missing: ["final"] },
  };
  owner.update({ rows: [full("old"), running] });
  owner.update({ rows: [full("new")] });
  assert.deepEqual(
    owner.getSnapshot().rows.map((row) => row.id),
    ["work", "new"],
  );
  const before = owner.getSnapshot();
  assert.throws(() => owner.update({ rows: [full("one"), full("two")] }), /WINDOW_FULL/);
  assert.equal(owner.getSnapshot(), before);
  owner.update({ rows: [full("work", "completed")] });
  owner.update({ rows: [full("next")] });
  assert.deepEqual(
    owner.getSnapshot().rows.map((row) => row.id),
    ["new", "next"],
  );
});

test("UTF8 body truncation and bounded loss details never invent completion or a known start", () => {
  const owner = new HistoryWindow(scope, { maxBodyBytes: 5, maxGaps: 2 });
  owner.update({ rows: [full("utf8", "🙂🙂")] });
  assert.deepEqual(owner.getSnapshot().rows[0]!.body, {
    kind: "partial",
    text: "🙂",
    missing: ["truncated"],
  });
  owner.update({ gaps: [0, 1, 2, 3].map((value) => ({ id: String(value), kind: "captureLost" })) });
  assert.equal(owner.getSnapshot().gaps.length, 2);
  assert(owner.getSnapshot().gaps.some((value) => value.id === "history:gap-details-omitted"));
  assert.equal(owner.getSnapshot().olderEdge.state, "unknown");
  assert.equal(owner.getSnapshot().activity.state, "unknown");
});

test("read joins preserve newer live rows and terminal complete evidence; conflicts fail before publication", () => {
  const owner = new HistoryWindow(scope);
  owner.update({ rows: [full("a")] });
  const fence = owner.beginRead();
  assert.equal(
    owner.readIsCurrent({ ...fence }),
    false,
    "A structural copy is not an issued read capability",
  );
  assert.equal(
    owner.publishRead(
      { ...fence },
      [full("forged")],
      { state: "end", evidence: "nativeBoundary" },
      "before",
    ),
    false,
  );
  owner.update({ rows: [full("live")] });
  owner.publishRead(
    fence,
    [
      full("older"),
      { ...full("live"), body: { kind: "partial", text: "old", missing: ["final"] } },
    ],
    { state: "end", evidence: "nativeBoundary" },
    "before",
  );
  assert.deepEqual(
    owner.getSnapshot().rows.map((value) => value.id),
    ["a", "older", "live"],
  );
  assert.deepEqual(
    owner.getSnapshot().rows.find((value) => value.id === "live")!.body,
    full("live").body,
  );
  const terminal = owner.getSnapshot().rows.find((value) => value.id === "a")!;
  owner.update({ rows: [{ ...full("a"), lifecycle: "running" }] });
  assert.equal(
    owner.getSnapshot().rows.find((value) => value.id === "a"),
    terminal,
  );
  assert.throws(
    () => owner.update({ rows: [{ ...full("a"), kind: "tool" }] }),
    /IDENTITY_CONFLICT/,
  );
  const prior = owner.getSnapshot();
  assert.throws(() => owner.update({ rows: [full("a", "conflict")] }), /IDENTITY_CONFLICT/);
  assert.equal(owner.getSnapshot(), prior);
  assert.throws(
    () =>
      owner.publishRead(
        fence,
        [full("live"), full("a")],
        { state: "end", evidence: "nativeBoundary" },
        "before",
      ),
    /ORDER_CONFLICT/,
  );
  assert.equal(owner.getSnapshot(), prior);
  owner.endRead(fence);
});

test("native read-boundary changes preserve rows and fence late pages; generation reset rejects old frames", () => {
  const owner = new HistoryWindow(scope);
  owner.update({ rows: [full("a")] });
  const old = owner.frame(),
    fence = owner.beginRead();
  owner.invalidateReads("Native reader changed");
  assert.equal(
    owner.publishRead(
      fence,
      [full("late")],
      { state: "end", evidence: "nativeBoundary" },
      "before",
    ),
    false,
  );
  assert.equal(owner.getSnapshot().rows[0]!.id, "a");
  assert.equal(owner.getSnapshot().olderEdge.state, "unknown");
  owner.reset("Native history edited");
  assert.equal(owner.getSnapshot().generation, 2);
  assert.equal(applyFrame(owner.getSnapshot(), old).status, "stale");
  owner.endRead(fence);
});

test("slow readers reset coherently and quiet return settles both pending next and subscriber ownership", async () => {
  const owner = new HistoryWindow(scope, {
    maxQueuedFrames: 1,
    maxReplayFrames: 1,
    maxSubscribers: 1,
  });
  const stream = owner.subscribe();
  assert.throws(() => owner.subscribe(), /SUBSCRIBER_FULL/);
  owner.update({ rows: [full("a")] });
  owner.update({ rows: [full("b")] });
  const reset = (await stream.next()).value!;
  assert.equal(reset.kind, "snapshot");
  assert.deepEqual(applyFrame(undefined, reset).snapshot, owner.getSnapshot());
  const pending = stream.next();
  assert.throws(() => stream.next(), /CONCURRENT_NEXT/);
  await stream.return();
  assert.equal((await pending).done, true);
  assert.equal(owner.subscriberCount, 0);
  const missed = owner.subscribe({ generation: 1, revision: 0 });
  assert.equal((await missed.next()).value!.kind, "snapshot");
  owner.close();
  assert.equal(owner.subscriberCount, 0);
  assert.equal((await missed.next()).done, true);
});

test("older insertion trims only the recent edge and keeps residency omission explicit through later live append", () => {
  const owner = new HistoryWindow(scope),
    recent = Array.from({ length: 100 }, (_, index) => full(String(index + 100)));
  owner.update({ rows: recent });
  const fence = owner.beginRead();
  owner.publishRead(
    fence,
    Array.from({ length: 100 }, (_, index) => full(String(index))),
    { state: "available", cursor: "native-older-boundary" },
    "before",
  );
  assert.deepEqual(
    owner.getSnapshot().rows.map((row) => row.id),
    Array.from({ length: 128 }, (_, index) => String(index)),
  );
  assert.equal(owner.getSnapshot().residencyOmitted, true);
  assert.equal(owner.getSnapshot().olderEdge.state, "available");
  owner.update({ rows: [full("200")] });
  assert.deepEqual(
    owner.getSnapshot().rows.map((row) => row.id),
    [...Array.from({ length: 127 }, (_, index) => String(index + 1)), "200"],
  );
  assert.equal(owner.getSnapshot().residencyOmitted, true);
  assert.equal(owner.getSnapshot().olderEdge.state, "unknown");
  owner.update({ clearGaps: ["anything"] });
  assert.equal(owner.getSnapshot().residencyOmitted, true);
  owner.endRead(fence);
});
