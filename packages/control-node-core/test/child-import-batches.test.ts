import { describe, it, expect } from "vitest";
import type { AccessStreamItem, FeedControlItem } from "@arduano/agent-multiplex-protocol";
import { childImportBatches } from "../src/child-import-batches.js";

const control = (cursor: number) => ({ kind: "control", cursor }) as FeedControlItem;
describe("bounded adjacent child imports", () => {
  it("preserves native ordering and ends a batch exactly at a resnapshot barrier", async () => {
    const native = { kind: "native", sequence: 1 } as AccessStreamItem;
    const input = [control(1), control(2), native, control(3), control(4), control(5)];
    const groups = [];
    for await (const group of childImportBatches((async function* () { yield* input; })(), item => item.cursor === 4)) groups.push(group);
    expect(groups).toEqual([[input[0], input[1]], native, [input[3], input[4]], [input[5]]]);
  });
  it("flushes a partial batch while retaining just one slow lookahead", async () => {
    let pulls = 0, release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const source = { [Symbol.asyncIterator]: () => ({ next: async () => {
      pulls++;
      if (pulls === 1) return { done: false, value: control(1) };
      await wait; return { done: true, value: undefined };
    } }) };
    const iterator = childImportBatches(source, () => false);
    expect(await iterator.next()).toEqual({ done: false, value: [control(1)] });
    expect(pulls).toBe(2);
    const next = iterator.next();
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(pulls).toBe(2);
    release(); expect((await next).done).toBe(true);
  });
  it("bounds contiguous bursts by count and bytes without dropping items", async () => {
    const items = Array.from({ length: 130 }, (_, i) => ({ ...control(i), fixture: "x".repeat(40_000) }));
    const groups: FeedControlItem[][] = [];
    for await (const group of childImportBatches((async function* () { yield* items; })(), () => false)) {
      expect(Array.isArray(group)).toBe(true);
      groups.push(group as FeedControlItem[]);
      expect((group as FeedControlItem[]).length).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(JSON.stringify(group))).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(groups.flat()).toEqual(items);
  });
});
