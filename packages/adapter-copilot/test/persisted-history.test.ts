import { describe, expect, it, vi } from "vitest";
import { readCopilotPersistedHistory } from "../src/persisted-history.js";

const event = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, timestamp: "2026-10-10T00:00:00Z", data });
const request = { harness: "copilot" as const, limit: 100, native: { view: "primary" } };
const page = (events: unknown[], hasMore = false, cursorStatus = "ok", cursor = "native-next") => ({ events, hasMore, cursorStatus, cursor }) as any;
describe("Copilot persisted native history", () => {
  it("reads a stopped journal without Resume and keeps primary/child ownership", async () => {
    const events = [event("root", "assistant.message", { content: "primary" }),
      { ...event("child", "assistant.message", { content: "child" }), agentId: "native-child" }];
    const read = vi.fn(async () => page([events[0]], true));
    const result = await readCopilotPersistedHistory("native-session", request, read);
    expect(read).toHaveBeenCalledExactlyOnceWith({ sessionId: "native-session", max: 1, direction: "forward" });
    expect(result.payload).toEqual([events[0]]); expect(result.complete).toBe(false); expect(result.conversation?.view).toBe("primary");
    read.mockImplementationOnce(async () => page([events[1]], true));
    const child = await readCopilotPersistedHistory("native-session", { ...request, native: { view: "subagent", agentId: "native-child" } }, read);
    expect(child.payload).toEqual([events[1]]); expect(child.conversation?.view).toBe("child");
    await expect(readCopilotPersistedHistory("native-session", { ...request, cursor: child.nextCursor }, read)).rejects.toThrow("another native view");
  });
  it("uses one exact native continuation and never retries an expired cursor", async () => {
    const read = vi.fn(async () => page([], true));
    const first = await readCopilotPersistedHistory("native-session", request, read);
    read.mockImplementationOnce(async () => page([], false, "expired"));
    await expect(readCopilotPersistedHistory("native-session", { ...request, cursor: first.nextCursor }, read)).rejects.toThrow("cursor expired");
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls[1]?.[0]).toMatchObject({ cursor: "native-next" });
  });
  it("rejects a malformed batch without replaying the single-use cursor", async () => {
    const read = vi.fn(async () => page([event("large", "assistant.message", { content: "x".repeat(1024 * 1024) }), event("small", "assistant.message", { content: "small" })], true));
    await expect(readCopilotPersistedHistory("native-session", { ...request, native: { view: "primary", omitOversizedItems: true } }, read)).rejects.toThrow("Invalid persisted");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not accept a repeated native continuation", async () => {
    const read = vi.fn(async () => page([], true));
    const first = await readCopilotPersistedHistory("native-session", request, read);
    await expect(readCopilotPersistedHistory("native-session", { ...request, cursor: first.nextCursor }, read)).rejects.toThrow("did not advance");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("reports an explicit single-event omission with the native next cursor", async () => {
    const read = vi.fn(async () => page([event("large", "assistant.message", { content: "x".repeat(1024 * 1024) })], true));
    const result = await readCopilotPersistedHistory("native-session", { ...request, limit: 1, native: { view: "primary", omitOversizedItems: true } }, read);
    expect(result.payload).toEqual([]); expect(result.unavailableItem).toMatchObject({ nativeItemId: "large", reason: "exceedsWireLimit" }); expect(result.complete).toBe(false);
    expect(result.nextCursor).toContain("native-next"); expect(read).toHaveBeenCalledTimes(1);
  });
});
