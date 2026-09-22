import {
  initialLifecycle,
  newAuthorityEpochId,
  newControlNodeId,
  newFeedId,
  newRealmId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  packNativePayload,
  type AccessStreamItem,
  type LifecycleSnapshot,
  type NativeEvent,
  type RuntimeNodeDescriptor,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";
import { LifecycleNativeHandoff } from "../src/index.js";

const sessionId = newSessionId();
const runtimeNodeId = newRuntimeNodeId();
const runtimeNodeBootId = newRuntimeNodeBootId();
const runtimeEpoch = newRuntimeEpoch();
const authority = { realmId: newRealmId(), controlNodeId: newControlNodeId(), epochId: newAuthorityEpochId() };
const provenance = { originControlNodeId: authority.controlNodeId, authority };

function snapshot(nextNativeSequence = 2): LifecycleSnapshot {
  return {
    state: initialLifecycle({ sessionId, runtimeNodeId, runtimeNodeBootId, bindingRevision: 3, runtimeEpoch }),
    nextNativeSequence,
  };
}
function native(sequence: number, epoch = runtimeEpoch): NativeEvent {
  return { kind: "native", sessionId, harness: "copilot", runtimeEpoch: epoch, sequence,
    nativeType: "test.event", payload: packNativePayload({ sequence }), ephemeral: false, provenance };
}
function control(change: Extract<AccessStreamItem, { kind: "control" }>["change"]): AccessStreamItem {
  return {
    kind: "control", eventId: crypto.randomUUID(), feedId: newFeedId(), cursor: 1,
    provenance, change,
  };
}
function runtime(overrides: Partial<RuntimeNodeDescriptor> = {}): RuntimeNodeDescriptor {
  return {
    runtimeNodeId, runtimeNodeBootId, ownerControlNodeId: authority.controlNodeId,
    name: "handoff runtime", presence: "online", reachability: "reachable",
    connectedAt: "2026-09-22T00:00:00.000Z", lastHeartbeatAt: "2026-09-22T00:00:00.000Z",
    allowedRoots: [], harnesses: [], launchProfiles: [], protocolVersion: 6,
    ...overrides,
  };
}

describe("subscribe-first lifecycle snapshot/native cursor handoff", () => {
  it("discards pre-snapshot overlap and releases the exact contiguous suffix", () => {
    const handoff = new LifecycleNativeHandoff(sessionId);
    expect(handoff.observe(native(1))).toEqual([]);
    expect(handoff.observe(native(2))).toEqual([]);
    expect(handoff.observe(native(3))).toEqual([]);
    expect(handoff.install(snapshot(2)).map(item => item.sequence)).toEqual([2, 3]);
    expect(handoff.state).toBe("continuous");
    expect(handoff.nextNativeSequence).toBe(4);
    expect(handoff.observe(native(3))).toEqual([]);
    expect(handoff.observe(native(4)).map(item => item.sequence)).toEqual([4]);
  });

  it.each([
    ["requested-ahead sequence", (handoff: LifecycleNativeHandoff) => handoff.observe(native(4))],
    ["runtime epoch replacement", (handoff: LifecycleNativeHandoff) => handoff.observe(native(2, newRuntimeEpoch()))],
    ["explicit native gap", (handoff: LifecycleNativeHandoff) => handoff.observe({ kind: "nativeGap", sessionId, reason: "expired", recovery: "readNativeHistory", provenance })],
    ["source reset", (handoff: LifecycleNativeHandoff) => handoff.observe({ kind: "streamReset", previousFeedId: newFeedId(), feedId: newFeedId(), controlCursor: 0, authorityRefs: [authority], reason: "sourceSelectionChanged", recovery: "snapshot" })],
  ] as const)("fails closed for a %s", (_name, trigger) => {
    const handoff = new LifecycleNativeHandoff(sessionId);
    trigger(handoff);
    expect(handoff.install(snapshot(2))).toEqual([]);
    expect(handoff.state).toBe("gap");
    expect(handoff.reason).toBeTruthy();
  });

  it("fences a binding update buffered between subscription and snapshot", () => {
    const handoff = new LifecycleNativeHandoff(sessionId);
    const state = snapshot().state;
    const item = control({ type: "session.upsert", session: {
        sessionId, runtimeNodeId, harness: "copilot", adapterScopeId: "handoff-test", vendorSessionId: "native",
        bindingRevision: 4, runtimeEpoch: newRuntimeEpoch(), cwd: null, availability: "active", runtimeStatus: "idle",
        launchProvenance: null, metadata: { revision: 0, values: {}, keyRevisions: {} }, metadataAuthority: authority,
        catalogState: "open", catalogRevision: 1, archivedAt: null,
        createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", lastSeenAt: null, lastActivityAt: null,
      } });
    expect(state.fence.bindingRevision).toBe(3);
    handoff.observe(item);
    expect(handoff.install(snapshot())).toEqual([]);
    expect(handoff.state).toBe("gap");
  });

  it.each([
    ["runtime boot replacement", control({ type: "runtimeNode.upsert", runtimeNode: runtime({ runtimeNodeBootId: newRuntimeNodeBootId() }) })],
    ["runtime offline descriptor", control({ type: "runtimeNode.upsert", runtimeNode: runtime({ presence: "offline" }) })],
    ["runtime unreachable descriptor", control({ type: "runtimeNode.upsert", runtimeNode: runtime({ reachability: "unreachable" }) })],
    ["runtime stale presence", control({ type: "runtimeNode.presence", runtimeNodeId, presence: "stale" })],
    ["session unavailable", control({ type: "session.unavailable", sessionId })],
  ] as const)("fences a buffered %s", (_name, item) => {
    const handoff = new LifecycleNativeHandoff(sessionId);
    handoff.observe(item);
    expect(handoff.install(snapshot())).toEqual([]);
    expect(handoff.state).toBe("gap");
  });

  it("ignores other runtimes and accepts matching online runtime evidence", () => {
    const handoff = new LifecycleNativeHandoff(sessionId);
    handoff.observe(control({
      type: "runtimeNode.upsert",
      runtimeNode: runtime({ runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), presence: "offline" }),
    }));
    handoff.observe(control({ type: "runtimeNode.upsert", runtimeNode: runtime() }));
    expect(handoff.install(snapshot())).toEqual([]);
    expect(handoff.state).toBe("continuous");

    expect(handoff.observe(control({ type: "runtimeNode.presence", runtimeNodeId, presence: "offline" }))).toEqual([]);
    expect(handoff.state).toBe("gap");
  });

  it("bounds pre-snapshot buffering and ignores unrelated sessions", () => {
    const handoff = new LifecycleNativeHandoff(sessionId, 1);
    expect(handoff.observe({ ...native(0), sessionId: newSessionId() })).toEqual([]);
    handoff.observe(native(0));
    handoff.observe(native(1));
    expect(handoff.state).toBe("gap");
    expect(handoff.install(snapshot(0))).toEqual([]);
  });
});
