import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexCapture } from "../../src/codex/capture.js";
import { CodexObservation } from "../../src/codex/server/observation.js";
import { message, run } from "./fixture.js";

test("a fresh browser receives an assembled native active item after the Host replay ring rolls over", async () => {
  const host = new CodexObservation(run, "capture"),
    browser = new CodexCapture(run);
  const params = { threadId: "root", turnId: "turn", itemId: "message" };
  host.observe({
    method: "item/started",
    params: { threadId: "root", turnId: "turn", item: message(""), startedAtMs: 1 },
  });
  for (let index = 0; index < 150; index++)
    host.observe({ method: "item/agentMessage/delta", params: { ...params, delta: `${index},` } });
  const watch = host.watch();
  try {
    const initial = await watch.next();
    assert.equal(initial.done, false);
    if (initial.done) throw Error("missing native snapshot");
    assert.equal(initial.value.kind, "snapshot");
    browser.apply(initial.value);
    const full = Array.from({ length: 150 }, (_, index) => `${index},`).join("");
    const item = browser.snapshot().items[0]!.item;
    assert.equal(item.type === "agentMessage" && item.text, full);
    assert.equal(
      browser.capture?.coverage.earlierOmitted,
      true,
      "raw replay omission is distinct from assembled item content",
    );
    host.observe({ method: "item/agentMessage/delta", params: { ...params, delta: "new" } });
    const next = await watch.next();
    assert.equal(next.done, false);
    if (next.done) throw Error("missing native delta");
    browser.apply(next.value);
    const updated = browser.snapshot().items[0]!.item;
    assert.equal(updated.type === "agentMessage" && updated.text, `${full}new`);
    host.observe({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        startedAtMs: 1,
        item: { type: "reasoning", id: "reasoning", summary: [], content: [] },
      },
    });
    host.observe({
      method: "item/reasoning/summaryPartAdded",
      params: { threadId: "root", turnId: "turn", itemId: "reasoning", summaryIndex: 1 },
    });
    host.observe({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "root",
        turnId: "turn",
        itemId: "reasoning",
        summaryIndex: 1,
        delta: "second native part",
      },
    });
    for (let index = 0; index < 3; index++) {
      const frame = await watch.next();
      if (frame.done) throw Error("missing native part");
      browser.apply(frame.value);
    }
    const reasoning = browser.snapshot().items.find((entry) => entry.item.id === "reasoning")!.item;
    assert.deepEqual(reasoning.type === "reasoning" && reasoning.summary, [
      "",
      "second native part",
    ]);
  } finally {
    await watch.return?.();
    host.close();
  }
});
