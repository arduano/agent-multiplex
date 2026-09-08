import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotReadBusyError, CopilotReadRequests } from "../src/reads.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Copilot bounded read-only requests", () => {
  it("shares a single request budget across native page-size reductions", async () => {
    vi.useFakeTimers();
    const reads = new CopilotReadRequests();
    const deadlineAt = Date.now() + 15_000;
    const first = deferred<string>();
    const initial = reads.read("history", "large-page", () => first.promise, deadlineAt);
    await vi.advanceTimersByTimeAsync(14_000);
    first.resolve("oversized");
    await initial;
    const second = deferred<string>();
    const reduced = reads.read("history", "small-page", () => second.promise, deadlineAt).catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await reduced).toMatchObject({ message: expect.stringContaining("timed out") });
    second.resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    const action = vi.fn(async () => "unnecessary retry");
    await expect(reads.read("history", "smallest-page", action, deadlineAt)).rejects.toThrow("timed out");
    expect(action).not.toHaveBeenCalled();
  });

  it("bounds the caller wait while retaining and coalescing the unresolved native call", async () => {
    vi.useFakeTimers();
    const reads = new CopilotReadRequests();
    const native = deferred<string>();
    const action = vi.fn(() => native.promise);
    const first = reads.read("history", "cursor-1", action);
    const caught = first.catch(error => error);
    expect(reads.read("history", "cursor-1", action)).toBe(first);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await caught).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(reads.read("history", "cursor-1", action)).toBe(first);
    await expect(reads.read("history", "cursor-1", action)).rejects.toThrow("remains pending");
    expect(action).toHaveBeenCalledOnce();
    native.resolve("obsolete");
    await vi.advanceTimersByTimeAsync(0);
    await expect(reads.read("history", "cursor-1", async () => "fresh")).resolves.toBe("fresh");
  });

  it("never shares a response with another cursor/revision, before or after timeout", async () => {
    vi.useFakeTimers();
    const reads = new CopilotReadRequests();
    const native = deferred<string>();
    const first = reads.read("history", "cursor-1", () => native.promise).catch(error => error);
    const replacement = vi.fn(async () => "incorrect page");
    await expect(reads.read("history", "cursor-2", replacement)).rejects.toBeInstanceOf(CopilotReadBusyError);
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    await expect(reads.read("history", "cursor-2", replacement)).rejects.toBeInstanceOf(CopilotReadBusyError);
    expect(replacement).not.toHaveBeenCalled();
    native.reject(new Error("late rejection"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(reads.read("history", "cursor-2", async () => "fresh page")).resolves.toBe("fresh page");
  });

  it("keeps other methods and sessions usable while a read lane is stalled", async () => {
    vi.useFakeTimers();
    const reads = new CopilotReadRequests();
    const stalled = deferred<string>();
    const first = reads.read("session-1:history", "", () => stalled.promise);
    await expect(reads.read("session-1:queue", "", async () => "queue")).resolves.toBe("queue");
    await expect(reads.read("session-2:history", "", async () => "history")).resolves.toBe("history");
    stalled.resolve("recovered");
    await expect(first).resolves.toBe("recovered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds retained native requests across session churn and reclaims only settled capacity", async () => {
    vi.useFakeTimers();
    const reads = new CopilotReadRequests();
    const stalled = deferred<null>();
    const requests = Array.from({ length: 256 }, (_, i) =>
      reads.read(`session-${i}`, "", () => stalled.promise).catch(error => error));
    const extra = vi.fn(async () => null);
    await expect(reads.read("extra", "", extra)).rejects.toBeInstanceOf(CopilotReadBusyError);
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(requests);
    await expect(reads.read("extra", "", extra)).rejects.toBeInstanceOf(CopilotReadBusyError);
    expect(extra).not.toHaveBeenCalled();
    stalled.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    await expect(reads.read("extra", "", extra)).resolves.toBeNull();
  });

  it("releases failed native calls and synchronous errors without caching stale failures", async () => {
    const reads = new CopilotReadRequests();
    await expect(reads.read("lane", "", () => { throw new Error("unsupported"); })).rejects.toThrow("unsupported");
    await expect(reads.read("lane", "", async () => 2)).resolves.toBe(2);
  });
});
