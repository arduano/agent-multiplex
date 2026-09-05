import { describe, expect, it } from "vitest";

import { packNativePayload, type JsonValue, type NativeEvent, type NativeHistoryResult } from "@arduano/agent-multiplex-protocol";
import {
  applyNativeEvent,
  entriesFromHistory,
  mergeTimeline,
} from "../apps/web/src/client/transcript.js";

const codexHistory = (payload: unknown): NativeHistoryResult => ({
  harness: "codex",
  vendorSessionId: "thread-test",
  payload: packNativePayload(payload as JsonValue),
  complete: true,
});

const native = (
  harness: "codex" | "copilot",
  nativeType: string,
  payload: unknown,
  sequence: number,
): NativeEvent => ({
  kind: "native",
  sessionId: "00000000-0000-4000-8000-000000000001" as NativeEvent["sessionId"],
  harness,
  runtimeEpoch: "00000000-0000-4000-8000-000000000002" as NativeEvent["runtimeEpoch"],
  sequence,
  nativeType,
  payload: packNativePayload(payload as JsonValue),
  ephemeral: nativeType.endsWith("delta") || nativeType.endsWith("Delta"),
  provenance: {
    originControlNodeId: "00000000-0000-4000-8000-000000000003" as NativeEvent["provenance"]["originControlNodeId"],
    authority: {
      realmId: "00000000-0000-4000-8000-000000000004",
      controlNodeId: "00000000-0000-4000-8000-000000000003",
      epochId: "00000000-0000-4000-8000-000000000005",
    } as NativeEvent["provenance"]["authority"],
  },
});

describe("web native transcript projection", () => {
  it("projects Codex history without collapsing identical user messages", () => {
    const entries = entriesFromHistory(codexHistory({
      thread: {
        turns: [
          {
            startedAt: 1_700_000_000,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "same prompt" }] },
              { type: "agentMessage", id: "answer-1", text: "first", phase: "final_answer" },
            ],
          },
          {
            startedAt: 1_700_000_100,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "same prompt" }] },
              { type: "agentMessage", id: "answer-2", text: "second", phase: "final_answer" },
            ],
          },
        ],
      },
    }));

    expect(entries.map(({ kind, body }) => [kind, body])).toEqual([
      ["user", "same prompt"],
      ["assistant", "first"],
      ["user", "same prompt"],
      ["assistant", "second"],
    ]);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(4);
  });

  it("aggregates Codex deltas and replaces them with the completed native item", () => {
    let entries = applyNativeEvent([], native("codex", "item/started", {
      item: { type: "agentMessage", id: "message-1", text: "", phase: "commentary" },
      startedAtMs: 1_700_000_000_000,
    }, 1));
    entries = applyNativeEvent(entries, native("codex", "item/agentMessage/delta", {
      itemId: "message-1",
      delta: "hello ",
    }, 2));
    entries = applyNativeEvent(entries, native("codex", "item/agentMessage/delta", {
      itemId: "message-1",
      delta: "world",
    }, 3));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "assistant", body: "hello world", pending: true });

    entries = applyNativeEvent(entries, native("codex", "item/completed", {
      item: { type: "agentMessage", id: "message-1", text: "hello world", phase: "final_answer" },
      completedAtMs: 1_700_000_001_000,
    }, 4));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ body: "hello world", pending: false });
  });

  it("keeps live shell output visible and de-duplicates it against completed history", () => {
    let live = applyNativeEvent([], native("codex", "item/started", {
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "npm test",
        aggregatedOutput: "",
        status: "inProgress",
      },
    }, 10));
    live = applyNativeEvent(live, native("codex", "item/commandExecution/outputDelta", {
      itemId: "command-1",
      delta: "PASS transcript.test.ts\n",
    }, 11));
    expect(live[0]).toMatchObject({
      id: "codex:command-1",
      kind: "tool",
      title: "npm test",
      body: "PASS transcript.test.ts\n",
    });

    const history = entriesFromHistory(codexHistory({
      thread: {
        turns: [{
          items: [{
            type: "commandExecution",
            id: "command-1",
            command: "npm test",
            aggregatedOutput: "PASS transcript.test.ts\n",
            status: "completed",
          }],
        }],
      },
    }));
    const merged = mergeTimeline(live, history);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "tool", status: "completed", pending: false });
  });

  it("aggregates Copilot message deltas under the SDK message ID", () => {
    let entries = applyNativeEvent([], native("copilot", "assistant.message_delta", {
      type: "assistant.message_delta",
      id: "event-1",
      timestamp: "2026-09-03T00:00:00.000Z",
      data: { messageId: "copilot-message", deltaContent: "alpha " },
    }, 20));
    entries = applyNativeEvent(entries, native("copilot", "assistant.message_delta", {
      type: "assistant.message_delta",
      id: "event-2",
      timestamp: "2026-09-03T00:00:00.100Z",
      data: { messageId: "copilot-message", deltaContent: "beta" },
    }, 21));
    entries = applyNativeEvent(entries, native("copilot", "assistant.message", {
      type: "assistant.message",
      id: "event-3",
      timestamp: "2026-09-03T00:00:00.200Z",
      data: { messageId: "copilot-message", content: "alpha beta" },
    }, 22));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "copilot:copilot-message",
      kind: "assistant",
      body: "alpha beta",
    });
  });
});

describe("native transcript images", () => {
  const image = { imageId: "00000000-0000-4000-8000-000000000009", sessionId: "00000000-0000-4000-8000-000000000001", runtimeNodeId: "00000000-0000-4000-8000-000000000010", bindingRevision: 1, sha256: "a".repeat(64), byteLength: 42, mediaType: "image/png" as const };
  it("associates images with their exact Codex history item and preserves them across unrelated live events", () => {
    const event = native("codex", "item/completed", { item: { type: "userMessage", id: "image-user", content: [{ type: "image", url: null }] } }, 1);
    event.payload.images.push({ pointer: "/item/content/0/url", representation: "dataUrl", image: image as never });
    const first = applyNativeEvent([], event);
    expect(first[0]?.images).toEqual([{ image }]);
    const next = applyNativeEvent(first, native("codex", "item/completed", { item: { type: "agentMessage", id: "answer", text: "An image", phase: "final_answer" } }, 2));
    expect(next.find((entry) => entry.id === "codex:image-user")?.images).toEqual([{ image }]);
    expect(next.find((entry) => entry.id === "codex:answer")?.images).toBeUndefined();
    const history = codexHistory({ data: [{ turnId: "turn", item: event.payload.json && (event.payload.json as Record<string, unknown>).item }, { turnId: "turn", item: { type: "agentMessage", id: "answer", text: "An image", phase: "final_answer" } }] });
    history.payload.images.push({ pointer: "/data/0/item/content/0/url", representation: "dataUrl", image: image as never });
    expect(entriesFromHistory(history)[0]?.images).toEqual([{ image }]);
    expect(mergeTimeline(entriesFromHistory(history), next)).toHaveLength(2);
  });
  it("preserves Copilot user attachment sidecars", () => {
    const event = native("copilot", "user.message", { id: "image-user", type: "user.message", data: { content: "", attachments: [{ type: "blob", data: null, mimeType: "image/png" }] } }, 1);
    event.payload.images.push({ pointer: "/data/attachments/0/data", representation: "base64", image: image as never });
    expect(applyNativeEvent([], event)[0]).toMatchObject({ kind: "user", body: "", images: [{ image }] });
  });
  it("links Copilot assets to messages across separate pages and live events", () => {
    const reference = native("copilot", "user.message", { id: "user", type: "user.message", data: { content: "look", attachments: [{ type: "blob", assetId: "asset", data: null }] } }, 1);
    reference.payload.images.push({ pointer: "/data/attachments/0/data", representation: "base64", absent: true, image: { unavailable: true, reason: "missing" } });
    const asset = native("copilot", "session.binary_asset", { id: "asset-event", type: "session.binary_asset", data: { type: "image", assetId: "asset", data: null } }, 2);
    asset.payload.images.push({ pointer: "/data/data", representation: "base64", image: image as never });
    const first = applyNativeEvent([], reference);
    expect(first[0]?.images?.[0]?.image).toEqual({ unavailable: true, reason: "missing" });
    const linked = mergeTimeline(first, applyNativeEvent([], asset));
    expect(linked.find((entry) => entry.kind === "user")?.images?.[0]?.image).toEqual(image);
  });

});
