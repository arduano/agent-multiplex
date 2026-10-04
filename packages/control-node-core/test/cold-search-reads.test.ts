import { afterEach, describe, expect, it, vi } from "vitest";

import { ColdSearchReads } from "../src/cold-search-reads.js";

afterEach(() => { vi.useRealTimers(); });

describe("cold archive search admission", () => {
  it("bounds pending reads across queries and replaced sources until real settlement", async () => {
    vi.useFakeTimers();
    const reads = new ColdSearchReads();
    let release!: (value: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    const action = vi.fn(() => held);
    // Distinct source objects model connection generations. Each unresolved
    // query consumes one retained slot even after its caller deadline expires.
    const results = Array.from({ length: 64 }, (_, index) =>
      reads.read({}, `query-${index}`, action).catch(error => error));
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(64);
    await expect(reads.read({}, "capacity-overflow", action)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await Promise.all(results)).every(error => error.code === "UNAVAILABLE")).toBe(true);
    await expect(reads.read({}, "after-expiry", action)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(action).toHaveBeenCalledTimes(64);
    release("late discarded result");
    await vi.advanceTimersByTimeAsync(0);
    await expect(reads.read({}, "after-settlement", async () => "fresh complete page")).resolves.toBe("fresh complete page");
    reads.close();
  });

  it("does not dispatch a cancelled request and retires admitted callers on close", async () => {
    const reads = new ColdSearchReads();
    const controller = new AbortController();
    controller.abort();
    const action = vi.fn(() => new Promise<string>(() => {}));
    await expect(reads.read({}, "already-cancelled", action, controller.signal))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(action).not.toHaveBeenCalled();
    const pending = reads.read({}, "held-on-close", action);
    const rejected = expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await Promise.resolve();
    reads.close();
    await rejected;
    await expect(reads.read({}, "after-close", action)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(action).toHaveBeenCalledTimes(1);
  });
});
