import { NATIVE_PAYLOAD_MAX_BYTES, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";
import { copilotHistoryEventBytes } from "../src/images.js";
import { readPrimaryHistory, type CopilotEventLogReadRequest } from "../src/primary-history.js";

const request = { harness: "copilot" as const, limit: 100, native: { view: "primary", sortDirection: "desc" } };
const event = (id: string, type = "assistant.message", data: JsonValue = { content: id }) => ({
  id, type, data, parentId: null, timestamp: "2026-09-07T00:00:00.000Z",
});
const page = (events: unknown[], cursor = "native-older", hasMore = true) => ({ events, cursor, hasMore, cursorStatus: "ok" });

describe("Copilot primary native history", () => {
  it("delegates ownership filtering and keeps native messages and child lifecycle unchanged", async () => {
    const events = [event("user", "user.message", { content: "Question" }),
      { ...event("child-start", "subagent.started", { agentName: "explore" }), agentId: "child-agent" },
      event("assistant", "assistant.message", { content: "Answer", toolRequests: [{ toolCallId: "call", name: "task", arguments: {} }] })];
    const original = structuredClone(events);
    const read = vi.fn(async () => page(events));
    const result = await readPrimaryHistory("native-session", request, read);
    expect(read).toHaveBeenCalledExactlyOnceWith({ max: 100, direction: "backward", agentScope: "primary", includeEphemeral: false });
    expect(result).toEqual({ harness: "copilot", vendorSessionId: "native-session", payload: [...original].reverse(),
      sortDirection: "desc", complete: false, nextCursor: "copilot:primary:v1:desc:native-older" });
    expect(events).toEqual(original);
  });

  it("passes opaque continuation unchanged and preserves ascending order when requested", async () => {
    const read = vi.fn(async () => page([event("older"), event("newer")], "opaque/+=:", false));
    const result = await readPrimaryHistory("native-session", { ...request, cursor: "copilot:primary:v1:asc:opaque/+=:", native: { view: "primary" } }, read);
    expect(read).toHaveBeenCalledExactlyOnceWith({ cursor: "opaque/+=:", max: 100, direction: "forward", agentScope: "primary", includeEphemeral: false });
    expect(result).toMatchObject({ payload: [event("older"), event("newer")], sortDirection: "asc", complete: true });
    expect(result.nextCursor).toBeUndefined();
  });

  it.each(["copilot:event-before:10", "copilot:primary:v1:asc:native-older", "copilot:primary:v1:desc:"])("rejects incompatible cursor %s before dispatch", async cursor => {
    const read = vi.fn();
    await expect(readPrimaryHistory("native-session", { ...request, cursor }, read)).rejects.toThrow("Invalid Copilot primary history cursor");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["text", "numbers"] as const)("reduces a large %s batch at the same input cursor without skipping untransferred items", async kind => {
    const events = [0, 1].map(index => event(`large-${index}`, "assistant.message", kind === "text"
      ? { content: "x".repeat(600_000) } : { numbers: Array(45_000).fill(0.1) }));
    const read = vi.fn(async (input: CopilotEventLogReadRequest) => input.cursor === "before-newest"
      ? page(events.slice(0, 1), "beginning", false)
      : input.max > 1 ? page(events, "beginning", false) : page(events.slice(-1), "before-newest"));
    const first = await readPrimaryHistory("native-session", { ...request, limit: 2 }, read);
    expect(read.mock.calls.map(([value]) => ({ cursor: value.cursor, max: value.max }))).toEqual([{ cursor: undefined, max: 2 }, { cursor: undefined, max: 1 }]);
    expect(first).toMatchObject({ payload: [events[1]], nextCursor: "copilot:primary:v1:desc:before-newest", complete: false });
    expect(copilotHistoryEventBytes((first.payload as JsonValue[])[0]!)).toBeLessThan(NATIVE_PAYLOAD_MAX_BYTES);
    const second = await readPrimaryHistory("native-session", { ...request, cursor: first.nextCursor! }, read);
    expect(second).toMatchObject({ payload: [events[0]], complete: true });
  });

  it("shows an explicit oversized gap and continues at the exact next native cursor", async () => {
    const oldest = event("oldest"); const newest = event("newest");
    const oversized = event("oversized", "assistant.message", { content: "x".repeat(2_000_000) });
    const read = vi.fn(async (input: CopilotEventLogReadRequest) => {
      if (input.cursor === "before-oversized") return page([oldest], "beginning", false);
      if (input.cursor === "before-newest") return input.max > 1 ? page([oldest, oversized], "beginning", false) : page([oversized], "before-oversized");
      return input.max > 1 ? page([oversized, newest], "before-oversized") : page([newest], "before-newest");
    });
    const bounded = { ...request, limit: 2, native: { ...request.native, omitOversizedItems: true } };
    const first = await readPrimaryHistory("native-session", bounded, read);
    const second = await readPrimaryHistory("native-session", { ...bounded, cursor: first.nextCursor! }, read);
    const third = await readPrimaryHistory("native-session", { ...bounded, cursor: second.nextCursor! }, read);
    expect(first.payload).toEqual([newest]);
    expect(second).toMatchObject({ payload: [], complete: false, nextCursor: "copilot:primary:v1:desc:before-oversized",
      unavailableItem: { reason: "exceedsWireLimit", nativeItemId: "oversized", nativeType: "assistant.message" } });
    expect(third).toMatchObject({ payload: [oldest], complete: true });
    await expect(readPrimaryHistory("native-session", { ...request, limit: 1, cursor: first.nextCursor! }, read)).rejects.toThrow("exceeds the bounded wire envelope");
  });

  it("respects the image sidecar limit while preserving all raw native attachments", async () => {
    const attachments = Array.from({ length: 130 }, (_, index) => ({ type: "file", path: `/workspace/image-${index}.png` }));
    const events = [event("first", "user.message", { content: "One", attachments }), event("second", "user.message", { content: "Two", attachments })];
    const read = vi.fn(async (input: CopilotEventLogReadRequest) => input.max > 1 ? page(events, "beginning", false) : page(events.slice(-1), "before-second"));
    const result = await readPrimaryHistory("native-session", { ...request, limit: 2 }, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ payload: [events[1]], complete: false, nextCursor: "copilot:primary:v1:desc:before-second" });
  });

  it("reports expired native cursors instead of returning their fresh tail as older history", async () => {
    const read = vi.fn(async () => ({ ...page([event("repeated-newest")]), cursorStatus: "expired" }));
    await expect(readPrimaryHistory("native-session", { ...request, cursor: "copilot:primary:v1:desc:expired" }, read)).rejects.toThrow("Copilot history cursor expired; reload the conversation");
    expect(read).toHaveBeenCalledOnce();
  });

  it("fails unavailable native reads explicitly without falling back or retrying", async () => {
    const read = vi.fn(async () => { throw new Error("Method not found: session.eventLog.read"); });
    await expect(readPrimaryHistory("native-session", request, read)).rejects.toThrow("Method not found");
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    { events: [], cursor: "native", hasMore: true },
    { events: [null], cursor: "native", hasMore: true, cursorStatus: "ok" },
    { events: [event("one"), event("two")], cursor: "native", hasMore: true, cursorStatus: "ok" },
  ])("rejects malformed or over-limit native replies", async value => {
    await expect(readPrimaryHistory("native-session", { ...request, limit: 1 }, async () => value)).rejects.toThrow("Unrecognized Copilot primary history page");
  });

  it("rejects a nonadvancing continuation instead of allowing repeated pagination", async () => {
    await expect(readPrimaryHistory("native-session", { ...request, cursor: "copilot:primary:v1:desc:native-older" },
      async () => page([], "native-older"))).rejects.toThrow("cursor did not advance");
  });
});
