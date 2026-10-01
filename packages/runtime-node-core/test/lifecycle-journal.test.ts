import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newCommandId, newOperationId, newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId, packNativePayload } from "@arduano/agent-multiplex-protocol";
import { RuntimeNodeStore } from "../src/store.js";
import { RuntimeLifecycleJournal } from "../src/lifecycle.js";

it("repairs the receipt/ledger crash window by exact identity without dispatch and fences old generations", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-journal-"));
  const filename = join(root, "runtime.sqlite");
  const fence = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1, runtimeEpoch: newRuntimeEpoch() };
  const commandId = newCommandId();
  let store = new RuntimeNodeStore(filename);
  try {
    const journal = new RuntimeLifecycleJournal(store);
    journal.append(fence, { type: "commandPrepared", commandId, payloadHash: "fixed-payload", kind: "send" });
    journal.append(fence, { type: "commandReceipt", commandId, payloadHash: "fixed-payload", admission: "dispatched" });
    journal.append(fence, { type: "messageDisplayed", owner: "root", messageId: "native-logical" });
    // Simulate commit of terminal native acknowledgement, then crash before
    // lifecycle correlation was persisted. No native content enters the ledger.
    store.putCommand({ commandId, payloadHash: "fixed-payload", sessionId: fence.sessionId, runtimeNodeId: fence.runtimeNodeId,
      state: "succeeded", request: { bindingRevision: 1 }, result: packNativePayload({ messageId: "native-logical" }),
      createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" });
    store.close();
    store = new RuntimeNodeStore(filename);
    const recovered = new RuntimeLifecycleJournal(store);
    const state = recovered.read(fence);
    expect(state.commands[0]).toMatchObject({ admission: "accepted", displayed: true, consumed: false, settled: false });
    expect(recovered.read(fence)).toEqual(state);
    const rebooted = recovered.read({ ...fence, runtimeNodeBootId: newRuntimeNodeBootId() });
    expect(rebooted.commands[0]).toMatchObject({ commandId, admission: "accepted", displayed: true });
    expect(rebooted.queue.observation.state).toBe("pending");
    expect(recovered.read({ ...fence, runtimeEpoch: newRuntimeEpoch() }).root.phase).toBe("unknown");
    expect(recovered.read({ ...fence, bindingRevision: 2 }).root.phase).toBe("unknown");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("recovers a Codex client message ID from the durable request after a receipt-first crash", () => {
  const store = new RuntimeNodeStore(":memory:");
  try {
    const fence = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1, runtimeEpoch: newRuntimeEpoch() };
    const journal = new RuntimeLifecycleJournal(store), commandId = newCommandId(), payloadHash = "codex-crash-window";
    journal.append(fence, { type: "commandPrepared", commandId, payloadHash, kind: "steer" });
    journal.append(fence, { type: "commandReceipt", commandId, payloadHash, admission: "dispatched" });
    journal.append(fence, { type: "messageConsumed", owner: "root", messageId: "client-exact" });
    store.putCommand({ commandId, payloadHash, sessionId: fence.sessionId, runtimeNodeId: fence.runtimeNodeId, state: "succeeded",
      request: { bindingRevision: 1, request: { harness: "codex", command: { type: "steer", input: "fixture", native: { clientUserMessageId: "client-exact" } } } },
      createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z" });
    expect(journal.read(fence).commands[0]).toMatchObject({ admission: "accepted", messageId: "client-exact", consumed: true });
    expect(journal.command(commandId, fence)).toMatchObject({ delivery: "consumed", continuation: "complete" });
  } finally { store.close(); }
});

describe("durable bounded correlation window", () => {
  it("retains uncertainty through gap and reopen and rejects payload reuse", () => {
    const store = new RuntimeNodeStore(":memory:");
    try {
      const journal = new RuntimeLifecycleJournal(store);
      const fence = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1, runtimeEpoch: newRuntimeEpoch() };
      const commandId = newCommandId();
      journal.append(fence, { type: "commandPrepared", commandId, payloadHash: "one", kind: "compact" });
      journal.append(fence, { type: "commandReceipt", commandId, payloadHash: "one", admission: "outcomeUnknown" });
      journal.append(fence, { type: "gap" });
      journal.append(fence, { type: "compaction", phase: "observedComplete" });
      expect(journal.read(fence).commands[0]!.admission).toBe("outcomeUnknown");
      expect(() => journal.append(fence, { type: "commandPrepared", commandId, payloadHash: "two", kind: "compact" })).toThrow("identity conflict");
      expect(journal.read(fence).commands[0]!.payloadHash).toBe("one");
    } finally { store.close(); }
  });
});

it("retains a payload-free native gap diagnostic after idle and store reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-gap-"));
  const filename = join(root, "runtime.sqlite");
  const fence = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), bindingRevision: 1, runtimeEpoch: newRuntimeEpoch() };
  const diagnostic = { diagnosticId: newOperationId(), at: "2026-09-29T00:38:42.809Z", code: "eventHandling" as const,
    eventKind: "native" as const, pendingEvents: 1, pendingEventBytes: 2048, eventBytes: 512, errorClass: "schema" as const };
  let store = new RuntimeNodeStore(filename);
  try {
    const journal = new RuntimeLifecycleJournal(store);
    journal.append(fence, { type: "gap", diagnostic });
    journal.append(fence, { type: "rootIdle", aborted: false });
    store.close();
    store = new RuntimeNodeStore(filename);
    const recovered = new RuntimeLifecycleJournal(store);
    expect(recovered.read(fence).lastGap).toEqual(diagnostic);
    expect(recovered.projection(fence).view.health.issues).toContainEqual({ scope: "lifecycle", code: "incompleteNativeState", diagnosticId: diagnostic.diagnosticId });
    expect(() => recovered.append(fence, { type: "gap", diagnostic: { ...diagnostic, payload: "not allowed" } } as never)).toThrow();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("persists only certified cold-resume state and starts a replacement epoch uncertified", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-cold-resume-"));
  const filename = join(root, "runtime.sqlite");
  const fence = { sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(),
    bindingRevision: 1, runtimeEpoch: newRuntimeEpoch() };
  const commandId = newCommandId();
  let store = new RuntimeNodeStore(filename);
  try {
    const journal = new RuntimeLifecycleJournal(store);
    journal.append(fence, { type: "commandPrepared", commandId, payloadHash: "old-admission", kind: "send" });
    journal.append(fence, { type: "commandReceipt", commandId, payloadHash: "old-admission", admission: "outcomeUnknown" });
    journal.append(fence, { type: "childrenHydrated", items: [], complete: true });
    journal.append(fence, { type: "interactionsHydrated", items: [], complete: true });
    journal.append(fence, { type: "coldResumeQuiescent" });
    expect(journal.projection(fence).view.status).toBe("unknown");
    journal.append(fence, { type: "tasksObserved", revision: 0, items: [] });
    journal.append(fence, { type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
    expect(journal.projection(fence).view.status).toBe("ready");
    const certified = journal.read(fence);
    expect(certified.root).toEqual({ phase: "idle", cycle: null, outcome: "none" });
    expect(certified.commands[0]).toMatchObject({ admission: "outcomeUnknown", displayed: false, consumed: false, settled: false });
    store.close();
    store = new RuntimeNodeStore(filename);
    const reopened = new RuntimeLifecycleJournal(store);
    expect(reopened.read(fence)).toEqual(certified);
    const replacementFence = { ...fence, runtimeEpoch: newRuntimeEpoch() };
    const replacement = reopened.read(replacementFence);
    expect(replacement).toMatchObject({
      root: { phase: "unknown", cycle: null, outcome: "none" },
      children: { completeness: "partial" }, interactions: { completeness: "partial" },
    });
    reopened.append(replacementFence, { type: "coldResumeQuiescent" });
    expect(reopened.read(replacementFence).root.phase).toBe("unknown");
    expect(reopened.read(replacementFence).commands).toEqual(certified.commands);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
