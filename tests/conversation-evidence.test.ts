import { describe, expect, it } from "vitest";
import { boundedConversationEvidence, conversationEvidenceSchema, stampConversationObservation, type ConversationItemEvidence } from "../packages/protocol/src/conversation.js";
import { compareConversationItems, compareConversationRevisions, mergeConversationOrder } from "../packages/client/src/conversation.js";
import { copilotConversationEvidence } from "../packages/adapter-copilot/src/conversation.js";
import { codexConversationEvidence } from "../packages/adapter-codex/src/conversation.js";

const item = (revision: ConversationItemEvidence["revision"], completion: ConversationItemEvidence["completion"] = "open"): ConversationItemEvidence => ({
  itemId: "message", threadId: "thread", pointer: "", position: { kind: "unknown" }, revision, completion, persistence: "ephemeral",
});

describe("native conversation evidence", () => {
  it("compares observations only within their actual attachment generation", () => {
    expect(compareConversationRevisions({ kind: "observation", generation: "a", sequence: 100 }, { kind: "observation", generation: "b", sequence: 200 })).toBe("incomparable");
    expect(compareConversationRevisions({ kind: "incomparable" }, { kind: "observation", generation: "a", sequence: 200 })).toBe("incomparable");
    expect(compareConversationRevisions({ kind: "observation", generation: "a", sequence: 100 }, { kind: "observation", generation: "a", sequence: 99 })).toBe("older");
  });
  it("settles the exact native item without reopening it from a later replay", () => {
    const settled = item({ kind: "incomparable" }, "settled");
    expect(compareConversationItems(item({ kind: "observation", generation: "a", sequence: 3 }), settled)).toBe("newer");
    expect(compareConversationItems(settled, item({ kind: "observation", generation: "b", sequence: 100 }))).toBe("older");
    expect(compareConversationItems(settled, { ...settled, threadId: "unrelated" })).toBe("incomparable");
  });
  it("retains native identity while the effect owner stamps live update revisions", () => {
    const event = { id: "event", parentId: "chronological-parent", type: "assistant.message_delta", agentId: "child", data: { messageId: "message", deltaContent: "text" }, ephemeral: true };
    const evidence = copilotConversationEvidence(event, "root");
    const live = stampConversationObservation(evidence, "attachment", 7);
    expect(live.items[0]).toMatchObject({ threadId: "child", position: { kind: "nativeEvent", afterEventId: "chronological-parent" }, revision: { kind: "observation", generation: "attachment", sequence: 7, recordId: "event" } });
    expect(compareConversationRevisions(live.items[0]!.revision, evidence.items[0]!.revision)).toBe("same");
    expect(copilotConversationEvidence({ ...event, agentId: undefined }, "root").items[0]?.threadId).toBe("root");
  });
  it("does not fabricate Codex snapshot freshness or stream coverage from a history read", () => {
    const evidence = codexConversationEvidence({ data: [{ turnId: "turn", item: { id: "message", type: "agentMessage", text: "snapshot" } }] }, "thread", { history: true, sortDirection: "desc" });
    expect(evidence.items[0]).toMatchObject({ revision: { kind: "incomparable" }, completion: "unverified", pointer: "/data/0/item" });
    expect(evidence.coverage).toEqual({ kind: "unknown" });
    expect(conversationEvidenceSchema.safeParse(evidence).success).toBe(true);
  });
  it("preserves ephemeral placement, omitted middle rows and newer tails across page permutations", () => {
    for (const pages of [ [["old", "answer"], ["older", "old", "answer"]], [["older", "old", "answer"], ["old", "answer"]] ]) {
      let ids: readonly string[] = ["reasoning", "intent", "answer", "tail"];
      for (const page of pages) ids = mergeConversationOrder(ids, page).ids;
      expect(ids).toEqual(["older", "old", "reasoning", "intent", "answer", "tail"]);
    }
    expect(mergeConversationOrder(["a", "omitted", "b"], ["a", "inserted", "b"]).ids).toEqual(["a", "omitted", "inserted", "b"]);
  });
  it("reports contradictory anchors instead of inventing a causal order", () => {
    expect(mergeConversationOrder(["a", "b"], ["b", "a"])).toEqual({ ids: ["a", "b"], conflict: true });
  });
  it("keeps admitted native context before newly discovered context and an ephemeral prefix", () => {
    expect(mergeConversationOrder(["native-old", "reasoning", "answer", "tail"], ["next-old", "answer"], "after", new Set(["native-old", "answer"])).ids)
      .toEqual(["native-old", "next-old", "reasoning", "answer", "tail"]);
  });
  it("compares progressing live observations without declaring unrelated history fresher", () => {
    const evidence = codexConversationEvidence({ item: { id: "message", type: "agentMessage", text: "observed" } }, "thread");
    const first = stampConversationObservation(evidence, "attachment", 1), next = stampConversationObservation(evidence, "attachment", 2);
    expect(compareConversationItems(first.items[0]!, next.items[0]!)).toBe("newer");
    const snapshot = codexConversationEvidence({ data: [{ item: { id: "message", type: "agentMessage", text: "snapshot" } }] }, "thread", { history: true });
    expect(compareConversationRevisions(next.items[0]!.revision, snapshot.items[0]!.revision)).toBe("incomparable");
  });
  it("bounds metadata and stamped generations independently of the untouched native payload", () => {
    const native = Array.from({ length: 1_000 }, (_, index) => ({ id: `event-${index}`, type: "assistant.message", data: { messageId: `${index}-${"x".repeat(3_900)}`, content: "native content" } }));
    const original = JSON.stringify(native);
    const evidence = copilotConversationEvidence(native, "thread", { history: true });
    expect(evidence.items.length).toBeLessThan(native.length);
    expect(conversationEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(conversationEvidenceSchema.safeParse(stampConversationObservation(evidence, "generation".repeat(300), 10)).success).toBe(true);
    expect(boundedConversationEvidence(evidence).coverage).toEqual({ kind: "unknown" });
    expect(JSON.stringify(native)).toBe(original);
    expect(conversationEvidenceSchema.safeParse(copilotConversationEvidence({ id: "event", type: "assistant.reasoning", data: { reasoningId: "r".repeat(4_096) } }, "thread")).success).toBe(true);
    const escaped = codexConversationEvidence({ threadId: "\u0000".repeat(1_024), turnId: "\u0000".repeat(1_024), item: { id: "\u0000".repeat(1_024) } }, "thread");
    expect(escaped.items).toEqual([]);
    expect(conversationEvidenceSchema.safeParse(escaped).success).toBe(true);
  });
});
