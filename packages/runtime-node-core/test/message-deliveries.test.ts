import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandObservationView,
  initialLifecycle,
  newCommandId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  packNativePayload,
  type CommandRecord,
  type Harness,
  type LifecycleCommand,
  type LifecycleState,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";
import { RuntimeLifecycleJournal } from "../src/lifecycle.js";
import { projectMessageDeliveries, type MessageDeliveryCandidate } from "../src/message-deliveries.js";
import { RuntimeNodeStore } from "../src/store.js";

const receiptAt = "2026-10-03T00:00:00.000Z";
const receiptMs = Date.parse(receiptAt);

function state(): LifecycleState {
  return initialLifecycle({ sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(),
    bindingRevision: 1, runtimeEpoch: newRuntimeEpoch() });
}

function candidate(s: LifecycleState, harness: Harness, overrides: Partial<LifecycleCommand> = {}, receiptOverrides: Partial<CommandRecord> = {}): MessageDeliveryCandidate {
  const command: LifecycleCommand = { commandId: newCommandId(), payloadHash: "delivery-fixture-payload", kind: "send",
    admission: "accepted", messageId: "fixture-message-id", displayed: false, consumed: false, settled: false, ...overrides };
  const request = harness === "codex"
    ? { harness, command: { type: command.kind, input: "fixture prompt", ...(command.messageId ? { native: { clientUserMessageId: command.messageId } } : {}) } }
    : { harness, command: { type: command.kind, prompt: "fixture prompt", mode: command.kind === "send" ? "enqueue" : "immediate" } };
  const receipt: CommandRecord = { commandId: command.commandId, payloadHash: command.payloadHash, sessionId: s.fence.sessionId,
    runtimeNodeId: s.fence.runtimeNodeId, state: "succeeded", request: { bindingRevision: 1, request },
    result: packNativePayload(command.messageId ? { messageId: command.messageId } : {}),
    createdAt: receiptAt, updatedAt: receiptAt, ...receiptOverrides };
  s.commands.push(command);
  return { command, receipt, text: "fixture prompt", imageCount: 1 };
}

describe.each(["codex", "copilot"] as const)("Host-owned %s delivery warnings", harness => {
  it.each(["send", "steer"] as const)("moves an old %s admission to a warning without changing its receipt or outcome", kind => {
    const s = state(), entry = candidate(s, harness, { kind });
    const before = structuredClone({ s, entry }), observation = commandObservationView(entry.receipt, s);
    expect(projectMessageDeliveries(s, [entry], receiptMs + 119_999)).toMatchObject({
      items: [{ commandId: entry.command.commandId, state: "accepted" }], warnings: [],
    });
    const result = projectMessageDeliveries(s, [entry], receiptMs + 120_000);
    expect(result).toEqual({ items: [], omitted: 0, warningsOmitted: 0, warnings: [{
      commandId: entry.command.commandId, kind, state: "accepted", messageId: "fixture-message-id",
      text: "fixture prompt", imageCount: 1, createdAt: receiptAt, reason: "deliveryUnconfirmed",
    }] });
    expect(projectMessageDeliveries(s, [entry], receiptMs + 120_000)).toEqual(result);
    expect({ s, entry }).toEqual(before);
    expect(commandObservationView(entry.receipt, s)).toEqual(observation);
    expect(observation).toMatchObject({ delivery: "accepted", continuation: "observeDelivery" });
  });

  it("uses the final receipt time rather than prompt age and retains malformed/future clocks", () => {
    const s = state(), oldCreated = "2026-09-01T00:00:00.000Z";
    const entries = [
      candidate(s, harness, {}, { createdAt: oldCreated, updatedAt: new Date(receiptMs + 100_000).toISOString() }),
      candidate(s, harness, {}, { updatedAt: "not-a-date" }),
      candidate(s, harness, {}, { updatedAt: "2026-10-03" }),
      candidate(s, harness, {}, { updatedAt: new Date(receiptMs + 240_001).toISOString() }),
    ];
    expect(projectMessageDeliveries(s, entries, receiptMs + 120_000)).toMatchObject({ items: entries.map(entry => ({ commandId: entry.command.commandId })), warnings: [] });
    expect(projectMessageDeliveries(s, entries, Number.NaN).warnings).toEqual([]);
    expect(projectMessageDeliveries(s, entries, Number.POSITIVE_INFINITY).warnings).toEqual([]);
  });

  it("keeps an exact fresh native queue member pending for days, even after display", () => {
    const s = state(), entries = [candidate(s, harness), candidate(s, harness, { messageId: "displayed-in-queue", displayed: true })];
    s.queue.observation.state = "observed";
    s.queue.items = entries.map(entry => ({ id: `queue-${entry.command.messageId}`, messageId: entry.command.messageId!, kind: "queued" }));
    expect(projectMessageDeliveries(s, entries, receiptMs + 3 * 86_400_000)).toMatchObject({
      items: [{ state: "queued", messageId: "fixture-message-id" }, { state: "displayed", messageId: "displayed-in-queue" }], warnings: [],
    });
    s.queue.observation.state = "pending";
    expect(projectMessageDeliveries(s, entries, receiptMs + 3 * 86_400_000)).toMatchObject({ items: [], warnings: [
      { state: "accepted", reason: "deliveryUnconfirmed" }, { state: "displayed", reason: "consumptionUnconfirmed" },
    ] });
  });

  it.each(["pending", "retrying", "observed"] as const)("does not interpret a %s queue without the exact ID as consumption", observation => {
    const s = state(), entry = candidate(s, harness);
    s.queue.observation.state = observation;
    s.queue.items = [{ id: "other-queue-id", messageId: "other-logical-id", kind: "queued" }];
    s.queue.unidentifiedSteering = 5;
    const result = projectMessageDeliveries(s, [entry], receiptMs + 120_000);
    expect(result).toMatchObject({ items: [], warnings: [{ state: "accepted", reason: "deliveryUnconfirmed" }] });
    expect(commandObservationView(entry.receipt, s)).toMatchObject({ delivery: "accepted", continuation: "observeDelivery" });
    expect(entry.command).toMatchObject({ consumed: false, settled: false });
  });

  it("preserves uncertain admission as a warning and does not assume failure or replay safety", () => {
    const s = state(), identified = candidate(s, harness, { admission: "outcomeUnknown" }, { state: "outcomeUnknown" });
    const anonymous = candidate(s, harness, { admission: "outcomeUnknown", messageId: undefined }, { state: "outcomeUnknown" });
    expect(projectMessageDeliveries(s, [identified, anonymous], receiptMs + 120_000)).toMatchObject({
      items: [], warnings: [
        { commandId: identified.command.commandId, state: "unknown", messageId: "fixture-message-id", reason: "admissionUncertain" },
        { commandId: anonymous.command.commandId, state: "unknown", reason: "admissionUncertain" },
      ],
    });
    expect(commandObservationView(identified.receipt, s)).toMatchObject({ delivery: "unknown", continuation: "reviewRequired" });
  });

  it("keeps prepared, dispatched and nonterminal receipts pending regardless of age", () => {
    const s = state();
    const entries = [
      candidate(s, harness, { admission: "prepared" }, { state: "received" }),
      candidate(s, harness, { admission: "dispatched" }, { state: "started" }),
      candidate(s, harness, { admission: "accepted" }, { state: "started" }),
      candidate(s, harness, { admission: "dispatched" }, { state: "succeeded" }),
    ];
    expect(projectMessageDeliveries(s, entries, receiptMs + 86_400_000)).toMatchObject({ items: entries.map(entry => ({ commandId: entry.command.commandId })), warnings: [] });
  });

  it("retains the B18 complete identity-less omission and excludes only exact terminal evidence", () => {
    const s = state();
    const entries = [
      candidate(s, harness, { messageId: undefined }),
      candidate(s, harness, { consumed: true }),
      candidate(s, harness, { settled: true }),
      candidate(s, harness, { admission: "failed" }, { state: "failed" }),
      candidate(s, harness, { kind: "compact" }),
    ];
    expect(projectMessageDeliveries(s, entries, receiptMs + 86_400_000)).toEqual({ items: [], omitted: 0, warnings: [], warningsOmitted: 0 });
    expect(commandObservationView(entries[0]!.receipt, s)).toMatchObject({ delivery: "accepted", continuation: "complete" });
  });

  it("bounds pending and warnings independently after classification and receipt validation", () => {
    const s = state(), entries: MessageDeliveryCandidate[] = [];
    for (let index = 0; index < 35; index++) {
      entries.push(candidate(s, harness, { messageId: `warning-${index}` }));
      entries.push(candidate(s, harness, { messageId: `pending-${index}` }, { updatedAt: new Date(receiptMs + 60_000).toISOString() }));
    }
    const invalid = candidate(s, harness, {}, { sessionId: newSessionId() });
    const result = projectMessageDeliveries(s, [...entries, invalid], receiptMs + 120_000);
    expect(result.items).toHaveLength(32);
    expect(result.warnings).toHaveLength(32);
    expect(result).toMatchObject({ omitted: 3, warningsOmitted: 3 });
    expect(result.items[0]?.messageId).toBe("pending-3");
    expect(result.warnings[0]?.messageId).toBe("warning-3");
  });

  it("reprojects stable warnings after a real journal reopen and lets later exact consumption win", () => {
    const directory = mkdtempSync(join(tmpdir(), "multiplex-delivery-warnings-")), filename = join(directory, "runtime.sqlite");
    let store = new RuntimeNodeStore(filename);
    try {
      const s = state(), entry = candidate(s, harness);
      store.putCommand(entry.receipt);
      const journal = new RuntimeLifecycleJournal(store);
      journal.append(s.fence, { type: "commandPrepared", commandId: entry.command.commandId, payloadHash: entry.command.payloadHash, kind: "send" });
      const before = projectMessageDeliveries(journal.read(s.fence), [entry], receiptMs + 120_000);
      expect(before.warnings).toHaveLength(1);
      store.close();
      store = new RuntimeNodeStore(filename);
      const reopened = new RuntimeLifecycleJournal(store), newFence = { ...s.fence, runtimeNodeBootId: newRuntimeNodeBootId() };
      const after = projectMessageDeliveries(reopened.read(newFence), [entry], receiptMs + 120_000);
      expect(after).toEqual(before);
      const original = store.getCommand(entry.command.commandId);
      reopened.append(newFence, { type: "messageConsumed", messageId: "different-message", owner: "root" });
      expect(projectMessageDeliveries(reopened.read(newFence), [entry], receiptMs + 120_000)).toEqual(before);
      reopened.append(newFence, { type: "messageConsumed", messageId: "fixture-message-id", owner: "root" });
      const consumed = reopened.read(newFence), currentEntry = { ...entry, command: consumed.commands[0]! };
      expect(projectMessageDeliveries(consumed, [currentEntry], receiptMs + 120_000)).toMatchObject({ items: [], warnings: [] });
      expect(reopened.command(entry.command.commandId, newFence)).toMatchObject({ delivery: "consumed", continuation: "complete" });
      expect(store.getCommand(entry.command.commandId)).toEqual(original);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
