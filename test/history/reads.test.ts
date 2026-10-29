import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HistoryAcquisition,
  HistoryError,
  HistoryWindow,
  ReadBudget,
  type HistoryReadPort,
  type HistoryReadWindow,
  type ReadBudgetPort,
  type NativePage,
} from "../../src/history/index.js";
import { deferred, full, page, scope } from "./fixture.js";

test("observer expiry and abort retain one actual read, and the same baseline coalesces through settlement", async () => {
  const held = deferred<NativePage>(),
    budget = new ReadBudget(1),
    window = new HistoryWindow(scope);
  let calls = 0;
  const borrowedWindow: HistoryReadWindow = {
    scope: window.scope,
    getSnapshot: window.getSnapshot.bind(window),
    beginRead: window.beginRead.bind(window),
    readIsCurrent: window.readIsCurrent.bind(window),
    endRead: window.endRead.bind(window),
    publishRead: window.publishRead.bind(window),
  };
  const borrowedBudget: ReadBudgetPort = {
    get active() {
      return budget.active;
    },
    get maximum() {
      return budget.maximum;
    },
    run: budget.run.bind(budget),
  };
  const owner = new HistoryAcquisition(
    borrowedWindow,
    {
      scope,
      mode: "repeatable",
      async read() {
        calls++;
        return held.promise;
      },
    },
    borrowedBudget,
  );
  const handle = owner.baseline();
  assert.equal(owner.baseline(), handle);
  assert.equal(budget.active, 1);
  assert.deepEqual(await handle.wait(0), { state: "waitingExpired" });
  assert.equal(handle.active, true);
  assert.equal(calls, 1);
  const observer = new AbortController(),
    waiting = handle.wait(1000, observer.signal);
  observer.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(owner.baseline(), handle);
  assert.equal(budget.active, 1);
  held.resolve(page([full("answer")]));
  assert.deepEqual(await handle.settled, { state: "ready" });
  assert.equal(budget.active, 0);
  assert.equal(calls, 1);
  assert.equal(window.getSnapshot().rows[0]!.id, "answer");
  owner.retire();
  window.close();
});

test("retiring an attachment cannot free a hung read slot for its replacement or publish its late result", async () => {
  const held = deferred<NativePage>(),
    budget = new ReadBudget(1),
    first = new HistoryWindow(scope);
  const owner = new HistoryAcquisition(
    first,
    { scope, mode: "repeatable", read: async () => held.promise },
    budget,
  );
  const handle = owner.baseline();
  await Promise.resolve();
  owner.retire();
  assert.equal(handle.outcome?.state, "retired");
  assert.equal(budget.active, 1);
  const nextScope = { ...scope, attachment: "capture-two" },
    second = new HistoryWindow(nextScope);
  const replacement = new HistoryAcquisition(
    second,
    {
      scope: nextScope,
      mode: "repeatable",
      async read() {
        return { ...page([]), scope: nextScope } as NativePage;
      },
    },
    budget,
  );
  assert.throws(() => replacement.baseline(), /READ_BUSY/);
  held.resolve(page([full("late")]));
  assert.deepEqual(await handle.settled, { state: "retired" });
  assert.equal(first.getSnapshot().rows.length, 0);
  assert.equal(budget.active, 0);
  assert.deepEqual(await replacement.baseline().settled, { state: "ready" });
  owner.retire();
  replacement.retire();
  first.close();
  second.close();
});

test("oversized protected baselines shrink the same cursor; all records remain reachable through the older frontier", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => full(String(index + 1), "x".repeat(1000))),
    calls: { cursor: string | null; count: number }[] = [];
  const window = new HistoryWindow(scope, { maxBytes: 9000 }),
    port: HistoryReadPort = {
      scope,
      mode: "repeatable",
      async read(input) {
        calls.push(input);
        return input.cursor === null
          ? page(rows.slice(-input.count), input.count < rows.length ? "first-six" : null)
          : page(rows.slice(0, 6));
      },
    };
  const owner = new HistoryAcquisition(window, port, undefined, { count: 12 });
  assert.deepEqual(await owner.baseline().settled, { state: "ready" });
  assert.deepEqual(calls, [
    { cursor: null, count: 12 },
    { cursor: null, count: 6 },
  ]);
  const latest = window.getSnapshot().rows.map((value) => value.id);
  assert.deepEqual(latest, ["7", "8", "9", "10", "11", "12"]);
  const edge = window.getSnapshot().olderEdge;
  assert.equal(edge.state, "available");
  if (edge.state !== "available") throw Error("missing frontier");
  assert.deepEqual(await owner.older(edge.cursor).settled, { state: "ready" });
  const retained = window.getSnapshot().rows.map((value) => value.id);
  assert.deepEqual(retained.slice(0, 6), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(
    [...new Set([...retained, ...latest])].sort((a, b) => Number(a) - Number(b)),
    rows.map((value) => value.id),
  );
  assert(Buffer.byteLength(JSON.stringify(window.getSnapshot())) <= 9000);
  assert.equal(window.getSnapshot().olderEdge.state, "end");
  assert.equal(calls[2]!.cursor, "first-six");
  owner.retire();
  window.close();
});

test("single-use input is consumed before await and never retried after failure, timeout or new read epoch", async () => {
  const window = new HistoryWindow(scope);
  let calls = 0;
  const owner = new HistoryAcquisition(window, {
    scope,
    mode: "singleUse",
    async read(input) {
      calls++;
      if (input.cursor === null) return page([full("latest")], "next");
      throw Error("native cursor failed");
    },
  });
  await owner.baseline().settled;
  const edge = window.getSnapshot().olderEdge;
  if (edge.state !== "available") throw Error("missing frontier");
  const older = owner.older(edge.cursor);
  assert.deepEqual(await older.settled, { state: "failed", code: "READ_FAILED" });
  assert.equal(owner.older(edge.cursor), older);
  assert.throws(() => owner.retry(older), /RETRY_NOT_ADMITTED/);
  assert.equal(calls, 2);
  window.invalidateReads("New reader required");
  assert.throws(() => owner.baseline(), /SINGLE_USE_READER_CONSUMED/);
  assert.throws(() => owner.older(edge.cursor), /STALE_CURSOR/);
  owner.retire();
  window.close();
});

test("repeatable failure exposes one explicit retry; waits and repeated baseline observations never retry", async () => {
  const window = new HistoryWindow(scope);
  let calls = 0;
  const owner = new HistoryAcquisition(window, {
    scope,
    mode: "repeatable",
    async read() {
      calls++;
      if (calls === 1) throw new HistoryError("UNAVAILABLE");
      return page([full("ok")]);
    },
  });
  const first = owner.baseline();
  assert.deepEqual(await first.settled, { state: "failed", code: "UNAVAILABLE" });
  assert.equal(owner.baseline(), first);
  assert.deepEqual(await first.wait(0), { state: "failed", code: "UNAVAILABLE" });
  assert.equal(calls, 1);
  const retry = owner.retry(first);
  assert.equal(owner.baseline(), retry);
  assert.deepEqual(await retry.settled, { state: "ready" });
  assert.equal(calls, 2);
  assert.deepEqual(first.outcome, { state: "failed", code: "UNAVAILABLE" });
  assert.throws(() => owner.retry(first), /STALE_READ/);
  owner.retire();
  window.close();
});

test("late native edit fences publication; empty intermediate pages and expired pages never invent a start", async () => {
  const held = deferred<NativePage>(),
    window = new HistoryWindow(scope);
  const owner = new HistoryAcquisition(window, {
    scope,
    mode: "repeatable",
    read: async () => held.promise,
  });
  const handle = owner.baseline();
  await Promise.resolve();
  window.reset("Native history edited");
  held.resolve(page([full("stale")]));
  assert.deepEqual(await handle.settled, { state: "stale" });
  assert.equal(window.getSnapshot().rows.length, 0);
  owner.retire();
  const empty = new HistoryAcquisition(window, {
    scope,
    mode: "repeatable",
    async read(input) {
      return input.cursor === null ? page([], "more") : { status: "expired" };
    },
  });
  await empty.baseline().settled;
  const edge = window.getSnapshot().olderEdge;
  assert.equal(edge.state, "available");
  if (edge.state !== "available") throw Error("missing frontier");
  assert.deepEqual(await empty.older(edge.cursor).settled, { state: "expired" });
  assert.equal(window.getSnapshot().olderEdge.state, "available");
  empty.retire();
  window.close();
});

test("a cyclic single-use native frontier is refused before a consumed cursor can be dispatched again", async () => {
  const window = new HistoryWindow(scope),
    calls: (string | null)[] = [];
  const owner = new HistoryAcquisition(window, {
    scope,
    mode: "singleUse",
    async read(input) {
      calls.push(input.cursor);
      return page([], input.cursor === null ? "A" : input.cursor === "A" ? "B" : "A");
    },
  });
  await owner.baseline().settled;
  const first = window.getSnapshot().olderEdge;
  if (first.state !== "available") throw Error("missing frontier");
  await owner.older(first.cursor).settled;
  const second = window.getSnapshot().olderEdge;
  if (second.state !== "available") throw Error("missing frontier");
  const last = owner.older(second.cursor);
  assert.deepEqual(await last.settled, { state: "failed", code: "CURSOR_REPLAY" });
  assert.equal(owner.older(second.cursor), last);
  assert.deepEqual(calls, [null, "A", "B"]);
  assert.equal(window.getSnapshot().olderEdge.state, "available");
  owner.retire();
  window.close();
});

test("protected eviction boundary refuses an older read atomically; explicit baseline reset restores an honest cut", async () => {
  const window = new HistoryWindow(scope, { maxRows: 2 });
  let refreshed = false;
  const running = {
    ...full("work"),
    lifecycle: "running" as const,
    body: { kind: "partial" as const, text: "work", missing: ["final" as const] },
  };
  const owner = new HistoryAcquisition(window, {
    scope,
    mode: "repeatable",
    async read(input) {
      return input.cursor !== null
        ? page([full("older")], "still-older")
        : refreshed
          ? page([full("fresh")])
          : page([full("prior"), running], "older");
    },
  });
  await owner.baseline().settled;
  const before = window.getSnapshot(),
    edge = before.olderEdge;
  if (edge.state !== "available") throw Error("missing frontier");
  assert.deepEqual(await owner.older(edge.cursor).settled, {
    state: "failed",
    code: "WINDOW_FULL",
  });
  assert.equal(window.getSnapshot(), before);
  assert.equal(window.getSnapshot().residencyOmitted, false);
  refreshed = true;
  window.reset("Explicit authorized baseline refresh");
  assert.deepEqual(await owner.baseline().settled, { state: "ready" });
  assert.deepEqual(
    window.getSnapshot().rows.map((row) => row.id),
    ["fresh"],
  );
  assert.equal(window.getSnapshot().residencyOmitted, false);
  assert.equal(window.getSnapshot().olderEdge.state, "end");
  owner.retire();
  window.close();
});
