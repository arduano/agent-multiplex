import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ControlNodeCatalog, ControlNodeService, createControlNodeIngressRouter,
  type RuntimeNodeConnection,
} from "@arduano/agent-multiplex-control-node-core";
import {
  newArchiveOperationId, newOperationId, newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  type Harness, type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import {
  RuntimeNodeService, RuntimeNodeStore, createRuntimeNodeRouter, type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it, vi } from "vitest";

import { refreshAndReconcile, type RuntimeNodeControlNodePeer } from "../apps/runtime-node/src/main.js";

async function fixture(harness: Harness) {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-retained-authority-"));
  const controlFilename = join(directory, "catalog.sqlite");
  let catalog = new ControlNodeCatalog({ filename: controlFilename });
  let control = new ControlNodeService({ catalog });
  const runtimeNodeId = newRuntimeNodeId();
  let boot = newRuntimeNodeBootId();
  const endpointId = "synthetic-retained-runtime";
  const context = { endpointId, authenticatedRuntimeNodeId: runtimeNodeId };
  const adapter: AgentAdapter = {
    harness, adapterScopeId: "retained-fixture" as AgentAdapter["adapterScopeId"],
    describe: async () => ({ harness, adapterScopeId: adapter.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: vi.fn(async () => []),
    spawn: async () => { throw new Error("no model calls in this fixture"); },
    resume: async () => { throw new Error("native omitted"); },
    releaseSession: vi.fn(async () => {}), close: async () => {},
  };
  catalog.registerRuntimeNode({ runtimeNodeId, runtimeNodeBootId: boot, name: "retained fixture",
    allowedRoots: [directory], harnesses: [], protocolVersion: 6 }, endpointId);
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const [canonical] = catalog.reconcileInventory({ runtimeNodeId, generation: "old-discovery", complete: true,
    capturedAt: timestamp, sessions: [{ harness, adapterScopeId: adapter.adapterScopeId,
      vendorSessionId: "old-native-binding", cwd: directory, availability: "resumable", runtimeStatus: "stopped",
      runtimeEpoch: null, lastActivityAt: timestamp }] });
  const { metadataAuthority: _authority, catalogState: _state, catalogRevision: _revision,
    archivedAt: _archivedAt, lifecycle: _lifecycle, ...oldBinding } = canonical!;
  const filename = join(directory, "runtime.sqlite");
  let store = new RuntimeNodeStore(filename);
  // Synthetic old persisted state: a retained native binding with no authority,
  // while native discovery has already lost the saved session. No vendor files.
  store.putSession(oldBinding);
  let runtime = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId: boot,
    name: "retained fixture", allowedRoots: [directory], adapters: [adapter] });
  let caller = createControlNodeIngressRouter(control).createCaller(context);
  const reconcile = vi.fn((input: Parameters<typeof caller.runtimeNodes.reconcile>[0]) => caller.runtimeNodes.reconcile(input));
  const peer = { rpc: { ingress: { runtimeNodes: { reconcile: { mutate: reconcile } } } } } as unknown as RuntimeNodeControlNodePeer;
  const restart = async () => {
    await runtime.close(); store.close();
    boot = newRuntimeNodeBootId();
    store = new RuntimeNodeStore(filename);
    runtime = new RuntimeNodeService({ store, runtimeNodeId, runtimeNodeBootId: boot,
      name: "retained fixture", allowedRoots: [directory], adapters: [adapter] });
    catalog.registerRuntimeNode(await runtime.describe(), endpointId);
  };
  const restartControl = async () => {
    control.close(); catalog.close();
    catalog = new ControlNodeCatalog({ filename: controlFilename });
    control = new ControlNodeService({ catalog });
    caller = createControlNodeIngressRouter(control).createCaller(context);
    catalog.registerRuntimeNode(await runtime.describe(), endpointId);
  };
  const connectArchive = () => {
    const reverse = createRuntimeNodeRouter(runtime).createCaller({});
    control.attachRuntimeNodeConnection({ runtimeNodeId, runtimeNodeBootId: boot, endpointId,
      archive: request => reverse.sessions.archive({ runtimeNodeBootId: boot, request }),
      getArchive: archiveOperationId => reverse.archives.get({ runtimeNodeBootId: boot, archiveOperationId }),
    } as RuntimeNodeConnection);
  };
  return { directory, runtimeNodeId, canonical: canonical!, adapter, context, peer, reconcile,
    get catalog() { return catalog; }, get control() { return control; },
    get runtime() { return runtime; }, get store() { return store; }, get boot() { return boot; }, restart, restartControl, connectArchive,
    close: async () => { await runtime.close(); store.close(); control.close(); catalog.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

describe("canonical authority bootstrap for retained omitted bindings", () => {
  it.each([
    ["codex", "resumable"], ["copilot", "resumable"],
    ["codex", "unavailable"], ["copilot", "unavailable"],
  ] as const)("bootstraps an old stopped %s/%s binding after restart without restoring native availability", async (harness, availability) => {
    const f = await fixture(harness);
    try {
      f.store.putSession({ ...f.store.getSession(f.canonical.sessionId)!, availability });
      await f.restartControl();
      await f.restart();
      const before = f.store.getSession(f.canonical.sessionId)!;
      expect(before.metadataAuthority).toBeUndefined();
      f.catalog.submitMetadataPatch({ operationId: newOperationId(), sessionId: before.sessionId,
        expectedAuthority: f.catalog.authority(), set: { "agent.title": "retained canonical title" } });
      await refreshAndReconcile(f.peer, f.runtime, f.boot);
      expect(f.runtime.inventorySnapshot().sessions).toEqual([]);
      expect(f.catalog.getSession(before.sessionId)).toMatchObject({ availability: "unavailable", runtimeStatus: "stopped" });
      expect(f.store.getSession(before.sessionId)).toEqual({ ...before,
        metadataAuthority: f.catalog.authority(), metadata: f.catalog.getMetadata(before.sessionId) });
      await f.restart();
      expect(f.store.getSession(before.sessionId)?.metadataAuthority).toEqual(f.catalog.authority());
      const references = f.runtime.retainedSessionBindings();
      f.connectArchive();
      const request = { archiveOperationId: newArchiveOperationId(), payloadHash: "retained-bootstrap-archive",
        sessionId: before.sessionId, runtimeNodeId: f.runtimeNodeId, bindingRevision: before.bindingRevision,
        expectedAuthority: f.catalog.authority() };
      await f.control.archive(request);
      await expect.poll(() => f.runtime.getArchive(request.archiveOperationId)?.state).toBe("succeeded");
      await expect.poll(async () => (await f.control.archive(request)).state).toBe("succeeded");
      expect(f.catalog.getSession(before.sessionId)).toMatchObject({ catalogState: "archived", vendorSessionId: before.vendorSessionId });
      expect(f.adapter.releaseSession).toHaveBeenCalledTimes(1);
      expect(f.store.getSession(before.sessionId)).toBeUndefined();
      expect(f.store.isNativeBindingArchived(before as RuntimeNodeSessionRecord)).toBe(true);
      const retired = await f.reconcile({ runtimeNodeId: f.runtimeNodeId, runtimeNodeBootId: f.boot,
        snapshot: await f.runtime.refreshInventory(), retainedBindings: references });
      expect(retired.sessions).toEqual([]);
      expect(f.catalog.getSession(before.sessionId)?.catalogState).toBe("archived");
    } finally { await f.close(); }
  });

  it.each(["codex", "copilot"] as const)("uses the attached Root authority for a retained %s binding and rejects the former authority", async harness => {
    const f = await fixture(harness);
    const root = new ControlNodeCatalog({ filename: join(f.directory, "root.sqlite") });
    try {
      const oldAuthority = f.catalog.authority();
      // Also cover retained bindings that knew the previous standalone epoch.
      f.store.putSession({ ...f.store.getSession(f.canonical.sessionId)!, metadataAuthority: oldAuthority });
      const child = f.catalog.localControlNode();
      const { attachment } = root.attachChild({ controlNodeId: child.controlNodeId, controlNodeBootId: child.controlNodeBootId,
        feedId: child.feedId, name: child.name, protocolVersion: 6, capabilities: child.capabilities,
        expectedParentControlNodeId: root.localControlNode().controlNodeId, childProof: f.catalog.attachmentProof() });
      f.catalog.applyParentAttachment(attachment, "synthetic-parent-endpoint");
      root.replaceChildSnapshot(child.controlNodeId, attachment.attachmentId, f.catalog.accessSnapshot());
      await refreshAndReconcile(f.peer, f.runtime, f.boot);
      expect(f.store.getSession(f.canonical.sessionId)?.metadataAuthority).toEqual(root.authority());
      const request = { archiveOperationId: newArchiveOperationId(), payloadHash: "retained-root-archive-fence",
        sessionId: f.canonical.sessionId, runtimeNodeId: f.runtimeNodeId, bindingRevision: f.canonical.bindingRevision,
        expectedAuthority: oldAuthority };
      expect(() => f.runtime.archive(request)).toThrow("stale or unknown metadata authority");
      expect(() => f.control.archive(request)).toThrow("stale authority epoch");
      expect(f.runtime.getArchive(request.archiveOperationId)).toBeNull();
      f.connectArchive();
      const current = { ...request, expectedAuthority: root.authority() };
      const cursor = f.catalog.controlCursor();
      await f.control.archive(current);
      await expect.poll(() => f.runtime.getArchive(current.archiveOperationId)?.state).toBe("succeeded");
      await expect.poll(async () => (await f.control.archive(current)).state).toBe("succeeded");
      // Import the real child feed; current Root authority remains canonical.
      const checkpoint = root.childCheckpoint(child.controlNodeId)!.controlCursor;
      expect(cursor).toBeGreaterThanOrEqual(checkpoint);
      for (const item of f.catalog.controlEventsAfter(checkpoint)) root.importChildControl(child.controlNodeId, attachment.attachmentId, item);
      expect(root.getSession(f.canonical.sessionId)).toMatchObject({ catalogState: "archived", metadataAuthority: root.authority() });
    } finally { root.close(); await f.close(); }
  });

  it("rejects stale retained identities and stale runtime admission before catalog mutation", async () => {
    const f = await fixture("codex");
    try {
      const snapshot = await f.runtime.refreshInventory();
      const binding = f.runtime.retainedSessionBindings()[0]!;
      const input = { runtimeNodeId: f.runtimeNodeId, runtimeNodeBootId: f.boot, snapshot, retainedBindings: [binding] };
      const cursor = f.catalog.controlCursor();
      for (const changed of [{ ...binding, bindingRevision: binding.bindingRevision + 1 },
        { ...binding, vendorSessionId: "different-native" }, { ...binding, harness: "copilot" as const }]) {
        await expect(f.reconcile({ ...input, retainedBindings: [changed] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      }
      await expect(f.reconcile({ ...input, runtimeNodeBootId: newRuntimeNodeBootId() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const wrongCaller = createControlNodeIngressRouter(f.control).createCaller({ ...f.context, endpointId: "wrong-endpoint" });
      await expect(wrongCaller.runtimeNodes.reconcile(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(f.reconcile({ ...input, retainedBindings: [binding, binding] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(f.reconcile({ ...input, retainedBindings: [{ ...binding, runtimeNodeId: newRuntimeNodeId() }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(() => f.control.reconcile({ ...input, snapshot: { ...snapshot, runtimeNodeId: newRuntimeNodeId() } }, f.context))
        .toThrowError(expect.objectContaining({ code: "FENCED" }));
      expect(f.catalog.controlCursor()).toBe(cursor);
      expect(f.store.getSession(binding.sessionId)?.metadataAuthority).toBeUndefined();
      const unknown = { ...binding, sessionId: newSessionId(), vendorSessionId: "unknown-binding" };
      const result = await f.reconcile({ ...input, retainedBindings: [unknown] });
      expect(result.sessions).toEqual([]);
      expect(f.catalog.getSession(unknown.sessionId)).toBeNull();
    } finally { await f.close(); }
  });

  it("does not recreate a binding removed while metadata bootstrap was pending", async () => {
    const f = await fixture("copilot");
    try {
      const references = f.runtime.retainedSessionBindings();
      const result = await f.reconcile({ runtimeNodeId: f.runtimeNodeId, runtimeNodeBootId: f.boot,
        snapshot: await f.runtime.refreshInventory(), retainedBindings: references });
      f.store.deleteSession(f.canonical.sessionId);
      expect(() => f.runtime.applyCanonicalSessions(result.sessions, references)).toThrow("no longer retained binding");
      expect(f.store.listSessions()).toEqual([]);
    } finally { await f.close(); }
  });

  it("does not overwrite advanced metadata with an unknown authority", async () => {
    const f = await fixture("codex");
    try {
      const before = { ...f.store.getSession(f.canonical.sessionId)!,
        metadata: { revision: 1, values: { "agent.title": "unowned advanced value" }, keyRevisions: { "agent.title": 1 } } };
      f.store.putSession(before);
      await expect(refreshAndReconcile(f.peer, f.runtime, f.boot)).rejects.toThrow("unowned revision advanced");
      expect(f.store.getSession(before.sessionId)).toEqual(before);
    } finally { await f.close(); }
  });

  it.each(["codex", "copilot"] as const)("bootstraps retained %s metadata when discovery fails without claiming native absence", async harness => {
    const f = await fixture(harness);
    try {
      const before = f.store.getSession(f.canonical.sessionId)!;
      f.adapter.listSessions = vi.fn(async () => { throw new Error("synthetic discovery failure"); });
      await refreshAndReconcile(f.peer, f.runtime, f.boot);
      expect(f.runtime.inventorySnapshot()).toMatchObject({ complete: false, sessions: [] });
      expect(f.catalog.getSession(before.sessionId)?.availability).toBe("resumable");
      expect(f.store.getSession(before.sessionId)).toEqual({ ...before, metadataAuthority: f.catalog.authority() });
    } finally { await f.close(); }
  });
});
