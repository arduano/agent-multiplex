import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newInteractionId, newRuntimeEpoch, newRuntimeNodeBootId, newRuntimeNodeId, packNativePayload, type AdapterScopeId, type InteractionRecord } from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ControlNodeCatalog } from "../src/index.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-interaction-projection-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = new ControlNodeCatalog({ filename: join(directory, "root.sqlite"), controlNodeName: "root" });
  const child = new ControlNodeCatalog({ filename: join(directory, "child.sqlite"), controlNodeName: "work-windows" });
  cleanup.push(() => root.close(), () => child.close());
  const local = child.localControlNode();
  const admission = root.attachChild({ controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId, feedId: local.feedId,
    name: local.name, protocolVersion: 5, capabilities: local.capabilities, expectedParentControlNodeId: root.localControlNode().controlNodeId, childProof: child.attachmentProof() });
  child.applyParentAttachment(admission.attachment, "fixture-parent");
  const runtimeNodeId = newRuntimeNodeId(), now = new Date().toISOString();
  child.registerRuntimeNode({ runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), name: "runtime", allowedRoots: [], harnesses: [], protocolVersion: 5 });
  const [session] = child.reconcileInventory({ runtimeNodeId, generation: "fixture", complete: true, capturedAt: now, sessions: [{ harness: "copilot", adapterScopeId: "fixture" as AdapterScopeId,
    vendorSessionId: "native", cwd: "/work", availability: "active", runtimeStatus: "waitingForInput", runtimeEpoch: newRuntimeEpoch(), lastActivityAt: now }] });
  const pending: InteractionRecord = { interactionId: newInteractionId(), sessionId: session!.sessionId, harness: "copilot", runtimeEpoch: session!.runtimeEpoch!, requestType: "userInput",
    payload: packNativePayload({ question: "Continue?" }), ephemeral: false, state: "pending", createdAt: now, expiresAt: null, resolvedAt: null };
  child.publishInteraction(pending);
  const refresh = () => root.replaceChildSnapshot(local.controlNodeId, admission.attachment.attachmentId, child.accessSnapshot());
  refresh();
  return { root, child, pending, refresh, local, admission, now };
}

describe("interaction projection ownership", () => {
  it.each(["resolved", "expired"] as const)("preserves the child projection after an authority %s update and reconnect", state => {
    const f = fixture();
    const terminal = { ...f.pending, state, resolvedAt: f.now, ...(state === "resolved" ? { resolution: packNativePayload({ answer: "yes" }) } : {}) };
    f.root.updateInteraction(terminal);
    f.child.updateInteraction(terminal);
    f.root.markChildDisconnected(f.local.controlNodeId);
    expect(() => f.refresh()).not.toThrow();
    expect(f.root.getInteraction(f.pending.interactionId)).toEqual(terminal);
    expect(f.root.listRuntimeNodes()[0]?.reachability).toBe("reachable");
    expect(() => f.refresh()).not.toThrow();
  });

  it("preserves imported ownership when a native interaction is republished", () => {
    const f = fixture();
    const terminal = { ...f.pending, state: "resolved" as const, resolution: packNativePayload({ answer: "yes" }), resolvedAt: f.now };
    f.root.publishInteraction(terminal); f.child.publishInteraction(terminal);
    expect(() => f.refresh()).not.toThrow();
    expect(f.root.getInteraction(f.pending.interactionId)).toEqual(terminal);
  });

  it("retains ownership when stopping a session retires its pending prompt", () => {
    const f = fixture();
    const session = f.root.getSession(f.pending.sessionId)!;
    f.root.markSessionStopped(session.sessionId, session.bindingRevision);
    f.child.updateInteraction(f.root.getInteraction(f.pending.interactionId)!);
    f.child.markSessionStopped(session.sessionId, session.bindingRevision);
    expect(() => f.refresh()).not.toThrow();
    expect(f.root.getInteraction(f.pending.interactionId)?.state).toBe("stale");
    expect(f.root.getSession(session.sessionId)?.availability).toBe("resumable");
  });

  it("continues to reject a child snapshot claiming another projection's interaction", () => {
    const f = fixture();
    const directory = mkdtempSync(join(tmpdir(), "multiplex-foreign-interaction-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const other = new ControlNodeCatalog({ filename: join(directory, "other.sqlite") });
    cleanup.push(() => other.close());
    const n = other.localControlNode();
    const a = f.root.attachChild({ controlNodeId: n.controlNodeId, controlNodeBootId: n.controlNodeBootId, feedId: n.feedId, name: n.name,
      protocolVersion: 5, capabilities: n.capabilities, expectedParentControlNodeId: f.root.localControlNode().controlNodeId, childProof: other.attachmentProof() });
    other.applyParentAttachment(a.attachment, "fixture-parent");
    const snapshot = other.accessSnapshot();
    expect(() => f.root.replaceChildSnapshot(n.controlNodeId, a.attachment.attachmentId, { ...snapshot, interactions: [f.pending] })).toThrow();
    expect(f.root.getInteraction(f.pending.interactionId)).toEqual(f.pending);
  });
});
