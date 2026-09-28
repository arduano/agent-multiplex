import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newCommandId, newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId, packNativePayload } from "@arduano/agent-multiplex-protocol";
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
    expect(recovered.read({ ...fence, runtimeNodeBootId: newRuntimeNodeBootId() }).commands).toEqual([]);
    expect(recovered.read({ ...fence, runtimeEpoch: newRuntimeEpoch() }).root.phase).toBe("unknown");
    expect(recovered.read({ ...fence, bindingRevision: 2 }).root.phase).toBe("unknown");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
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
