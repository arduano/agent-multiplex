import assert from "node:assert/strict";
import test from "node:test";
import { ObservationSupervisor, relayConfiguration } from "../../src/transport/index.js";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("quiet cancellation returns actual iterator, shares no native owner and opens no replacement", async () => {
  const owner = new ObservationSupervisor({ retryMinMs: 1, retryMaxMs: 1 });
  let opened = 0,
    returned = 0;
  const stop = owner.connect({
    key: "quiet",
    open() {
      opened++;
      let done!: (value: IteratorResult<number>) => void;
      const iterator: AsyncIterableIterator<number> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        next() {
          return new Promise((resolve) => {
            done = resolve;
          });
        },
        async return() {
          returned++;
          done({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
    receive() {
      assert.fail("quiet source");
    },
    unavailable() {},
  });
  await stop();
  assert.equal(opened, 1);
  assert.equal(returned, 1);
  assert.equal(owner.diagnostics().retained, 0);
  await owner.close();
});
test("replacement waits actual old cleanup; failed cleanup keeps its occupied slot", async () => {
  let release!: () => void,
    opens = 0;
  const owner = new ObservationSupervisor({ retryMinMs: 1, retryMaxMs: 1 });
  const stop = owner.connect({
    key: "feed",
    open() {
      opens++;
      const iterator: AsyncIterableIterator<number> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          throw Error("network");
        },
        return() {
          return new Promise((resolve) => {
            release = () => resolve({ done: true, value: undefined });
          });
        },
      };
      return iterator;
    },
    receive() {},
    unavailable() {},
  });
  await tick();
  assert.equal(opens, 1);
  assert.equal(owner.diagnostics().stopping, 1);
  const stopping = stop();
  release();
  await stopping;
  await owner.close();
  const failed = new ObservationSupervisor({ maxFeeds: 1 });
  failed.connect({
    key: "bad",
    open() {
      const iterator: AsyncIterableIterator<number> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          throw Error("network");
        },
        async return() {
          throw Error("cleanup");
        },
      };
      return iterator;
    },
    receive() {},
    unavailable() {},
  });
  await tick();
  assert.equal(failed.diagnostics().retained, 1);
  assert.throws(() =>
    failed.connect({
      key: "bad",
      open() {
        throw Error();
      },
      receive() {},
      unavailable() {},
    }),
  );
  await assert.rejects(failed.close(), /cleanup/);
});
test("observation outage retries only observations after actual iterator retirement", async () => {
  let opens = 0,
    returns = 0,
    unavailable = 0;
  const values: number[] = [];
  const owner = new ObservationSupervisor({ retryMinMs: 1, retryMaxMs: 1 });
  const stop = owner.connect({
    key: "recover",
    open(signal) {
      const attempt = ++opens;
      let n = 0,
        end: ((value: IteratorResult<number>) => void) | undefined;
      const iterator: AsyncIterableIterator<number> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          if (attempt === 1) throw Error("offline");
          if (n++ === 0) return { done: false, value: 42 };
          return new Promise((resolve) => {
            end = resolve;
            signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
              once: true,
            });
          });
        },
        async return() {
          returns++;
          end?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
    receive(value) {
      values.push(value);
    },
    unavailable() {
      unavailable++;
    },
  });
  for (let n = 0; n < 30 && !values.length; n++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(values, [42]);
  assert.equal(opens, 2);
  assert.equal(unavailable, 1);
  await stop();
  assert.equal(returns, 2);
  await owner.close();
});
test("relay origins are bounded routes, distinct from authenticated identity", () => {
  assert.deepEqual(
    relayConfiguration({ mode: "custom", urls: ["https://one.example", "https://two.example/"] }),
    { mode: "custom", urls: ["https://one.example", "https://two.example"] },
  );
  for (const url of [
    "http://one.example/",
    "https://secret@one.example/",
    "https://one.example/?secret=x",
  ])
    assert.throws(() => relayConfiguration({ mode: "custom", urls: [url] }));
});
