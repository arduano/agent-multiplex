import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newRuntimeNodeId, newRuntimeNodeBootId, newRuntimeEpoch, newOperationId, newCommandId, type AdapterScopeId, type FeedControlItem, type SessionRecord } from "@arduano/agent-multiplex-protocol";
import { ControlNodeCatalog, type ControlNodeCatalogOptions } from "../src/catalog.js";

const dirs: string[] = [], catalogs: ControlNodeCatalog[] = [];
let clockMs = Date.parse("2034-01-02T03:04:05.000Z");
const now = () => new Date(clockMs);
const reopen = (catalog: ControlNodeCatalog) => {
  const filename = catalog.diagnostics().filename;
  catalog.close(); catalogs.splice(catalogs.indexOf(catalog), 1);
  const restored = new ControlNodeCatalog({ filename, now }); catalogs.push(restored); return restored;
};
const create = (options: Partial<ControlNodeCatalogOptions> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "multiplex-storage-reliability-")); dirs.push(dir);
  const catalog = new ControlNodeCatalog({ filename: join(dir, "catalog.sqlite"), now, ...options }); catalogs.push(catalog); return catalog;
};
function runtime(catalog: ControlNodeCatalog) {
  return catalog.registerRuntimeNode({ runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), name: "fixture", allowedRoots: ["/work"], harnesses: [], protocolVersion: 5 });
}
function session(catalog: ControlNodeCatalog) {
  const node = runtime(catalog);
  const [record] = catalog.reconcileInventory({ runtimeNodeId: node.runtimeNodeId, generation: randomUUID(), complete: true, capturedAt: now().toISOString(), sessions: [{ harness: "codex", adapterScopeId: "fixture" as AdapterScopeId, vendorSessionId: "fixture-session", cwd: "/work", availability: "active", runtimeStatus: "idle", runtimeEpoch: newRuntimeEpoch(), lastActivityAt: now().toISOString() }] });
  return record!;
}
const runtimeRecord = ({ catalogState: _state, catalogRevision: _revision, archivedAt: _archivedAt, ...record }: SessionRecord) => record;
function attach(parent: ControlNodeCatalog, child: ControlNodeCatalog) {
  const descriptor = child.localControlNode();
  const { attachment } = parent.attachChild({ controlNodeId: descriptor.controlNodeId, controlNodeBootId: descriptor.controlNodeBootId, feedId: descriptor.feedId, name: descriptor.name, protocolVersion: 5, capabilities: descriptor.capabilities, expectedParentControlNodeId: parent.localControlNode().controlNodeId, childProof: child.attachmentProof() });
  child.applyParentAttachment(attachment, "fixture-parent");
  parent.replaceChildSnapshot(descriptor.controlNodeId, attachment.attachmentId, child.accessSnapshot());
  return attachment;
}
afterEach(() => { for (const catalog of catalogs.splice(0)) catalog.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); clockMs = Date.parse("2034-01-02T03:04:05.000Z"); });

describe("catalog storage reliability", () => {
  it("exact runtime replay preserves canonical metadata without commits or duplicate feed events", () => {
    const catalog = create(), original = session(catalog);
    catalog.submitMetadataPatch({ operationId: newOperationId(), sessionId: original.sessionId, expectedAuthority: catalog.authority(), set: { "ui.title": "Kept", "ui.labels": ["a", "b"] } });
    const current = catalog.getSession(original.sessionId)!;
    const before = catalog.storageMetrics(), cursor = catalog.controlCursor();
    for (let index = 0; index < 20; index++) expect(catalog.mergeRuntimeSession(runtimeRecord(current))).toEqual(current);
    expect(catalog.controlCursor()).toBe(cursor);
    expect(catalog.storageMetrics().timings.commit.count).toBe(before.timings.commit.count);
    expect(catalog.storageMetrics().counters.sessionNoop).toBe(before.counters.sessionNoop + 20);
    expect(catalog.diagnostics().synchronous).toBe("full");
  });

  it.each(["pending", "bound"] as const)("identical runtime replay settles %s lifecycle metadata exactly once", (bindingState) => {
    let catalog = create(); const record = session(catalog), commandId = newCommandId(), operationId = newOperationId();
    catalog.acceptCommand({ commandId, payloadHash: "fixture-lifecycle", sessionId: record.sessionId, runtimeNodeId: record.runtimeNodeId,
      state: "succeeded", request: {}, createdAt: now().toISOString(), updatedAt: now().toISOString() });
    const filename = catalog.diagnostics().filename;
    catalog.close(); catalogs.splice(catalogs.indexOf(catalog), 1);
    // Simulate recovery after the command completed but before its metadata
    // settled. Only this closed disposable catalog is seeded directly.
    const database = new DatabaseSync(filename);
    try {
      database.prepare(`INSERT INTO lifecycle_intents(command_id, runtime_node_id, session_id, harness,
        vendor_session_id, ready, binding_state, metadata_json, metadata_operation_id, metadata_applied, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?)`).run(commandId, record.runtimeNodeId, record.sessionId,
        record.harness, record.vendorSessionId, bindingState, JSON.stringify({ "ui.title": "Recovered" }), operationId, now().toISOString());
    } finally { database.close(); }
    catalog = new ControlNodeCatalog({ filename, now }); catalogs.push(catalog);
    const before = catalog.storageMetrics();
    const merged = catalog.mergeRuntimeSession(runtimeRecord(catalog.getSession(record.sessionId)!));
    expect(merged.metadata.values).toEqual({ "ui.title": "Recovered" });
    expect(merged.metadata.revision).toBe(1);
    expect(catalog.getMetadataOperation(operationId)?.status).toBe("accepted");
    expect(catalog.storageMetrics().counters.sessionUpserts).toBe(before.counters.sessionUpserts);
    expect(catalog.applyPendingLifecycleMetadata(record.runtimeNodeId)).toBe(0);
    const commits = catalog.storageMetrics().timings.commit.count;
    expect(catalog.mergeRuntimeSession(runtimeRecord(merged))).toEqual(merged);
    expect(catalog.storageMetrics().timings.commit.count).toBe(commits);
  });

  it("status changes keep metadata indexes intact and metadata changes remain searchable", () => {
    const catalog = create(), original = session(catalog);
    catalog.submitMetadataPatch({ operationId: newOperationId(), sessionId: original.sessionId, expectedAuthority: catalog.authority(), set: { "ui.title": "Before" } });
    const before = catalog.storageMetrics();
    catalog.mergeRuntimeSession({ ...runtimeRecord(catalog.getSession(original.sessionId)!), runtimeStatus: "running" });
    expect(catalog.storageMetrics().counters.metadataIndexRebuilt).toBe(before.counters.metadataIndexRebuilt);
    expect(catalog.storageMetrics().counters.metadataIndexSkipped).toBe(before.counters.metadataIndexSkipped + 1);
    expect(catalog.searchSessions({ metadata: [{ operator: "equals", key: "ui.title", value: "Before" }] }).sessions.map(item => item.sessionId)).toEqual([original.sessionId]);
    catalog.submitMetadataPatch({ operationId: newOperationId(), sessionId: original.sessionId, expectedAuthority: catalog.authority(), set: { "ui.title": "After" } });
    expect(catalog.getMetadata(original.sessionId).values).toEqual({ "ui.title": "After" });
    expect(catalog.storageMetrics().counters.metadataIndexRebuilt).toBe(before.counters.metadataIndexRebuilt + 1);
    expect(catalog.searchSessions({ metadata: [{ operator: "equals", key: "ui.title", value: "Before" }] }).sessions).toEqual([]);
    expect(catalog.searchSessions({ metadata: [{ operator: "equals", key: "ui.title", value: "After" }] }).sessions.map(item => item.sessionId)).toEqual([original.sessionId]);
  });

  it("suppresses identical imported session projections while durably advancing checkpoint and replay evidence", () => {
    let parent = create(); const child = create(), record = session(child), attachment = attach(parent, child);
    const descriptor = child.localControlNode(), checkpoint = parent.childCheckpoint(descriptor.controlNodeId)!;
    const item: FeedControlItem = { kind: "control", eventId: randomUUID(), feedId: checkpoint.feedId, cursor: checkpoint.controlCursor + 1, provenance: { originControlNodeId: descriptor.controlNodeId, authority: parent.authority() }, change: { type: "session.upsert", session: parent.getSession(record.sessionId)! } };
    const before = parent.storageMetrics(), cursor = parent.controlCursor();
    expect(parent.importChildControl(descriptor.controlNodeId, attachment.attachmentId, item)).toEqual({ accepted: true, deduplicated: false, localCursor: cursor });
    expect(parent.controlCursor()).toBe(cursor);
    expect(parent.childCheckpoint(descriptor.controlNodeId)?.controlCursor).toBe(item.cursor);
    expect(parent.storageMetrics().timings.commit.count).toBe(before.timings.commit.count + 1);
    expect(parent.storageMetrics().counters.metadataIndexRebuilt).toBe(before.counters.metadataIndexRebuilt);
    expect(parent.importChildControl(descriptor.controlNodeId, attachment.attachmentId, item).deduplicated).toBe(true);
    expect(() => parent.importChildControl(descriptor.controlNodeId, attachment.attachmentId, { ...item, change: { type: "session.upsert", session: { ...record, metadataAuthority: parent.authority(), runtimeStatus: "running" } } })).toThrow(expect.objectContaining({ code: "PAYLOAD_MISMATCH" }));
    parent = reopen(parent);
    expect(parent.childCheckpoint(descriptor.controlNodeId)?.controlCursor).toBe(item.cursor);
    expect(parent.importChildControl(descriptor.controlNodeId, attachment.attachmentId, item)).toEqual({ accepted: true, deduplicated: true, localCursor: cursor });
    expect(() => parent.importChildControl(descriptor.controlNodeId, attachment.attachmentId, { ...item, change: { type: "session.upsert", session: { ...record, metadataAuthority: parent.authority(), runtimeStatus: "running" } } })).toThrow(expect.objectContaining({ code: "PAYLOAD_MISMATCH" }));
  });

  it("groups adjacent imports atomically and rolls back a checkpoint gap without publication", () => {
    const parent = create(), child = create(), record = session(child), attachment = attach(parent, child);
    const id = child.localControlNode().controlNodeId, checkpoint = parent.childCheckpoint(id)!;
    const baseline = parent.getSession(record.sessionId)!;
    const items: FeedControlItem[] = Array.from({ length: 20 }, (_, index) => ({ kind: "control", eventId: randomUUID(),
      feedId: checkpoint.feedId, cursor: checkpoint.controlCursor + index + 1,
      provenance: { originControlNodeId: id, authority: parent.authority() },
      change: { type: "session.upsert", session: { ...baseline, runtimeStatus: index % 2 ? "idle" : "running" } } }));
    const commits = parent.storageMetrics().timings.commit.count, cursor = parent.controlCursor();
    expect(() => parent.importChildControls(id, attachment.attachmentId, [items[0]!, items[2]!])).toThrow(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    expect(parent.childCheckpoint(id)).toEqual(checkpoint);
    expect(parent.controlCursor()).toBe(cursor);
    expect(parent.getSession(record.sessionId)).toEqual(baseline);
    const result = parent.importChildControls(id, attachment.attachmentId, items);
    expect(result).toHaveLength(20);
    expect(parent.storageMetrics().timings.commit.count).toBe(commits + 1);
    expect(parent.childCheckpoint(id)?.controlCursor).toBe(items.at(-1)!.cursor);
    expect(parent.controlCursor()).toBe(cursor + 20);
    expect(parent.importChildControls(id, attachment.attachmentId, items).every(item => item.deduplicated)).toBe(true);
  });

  it("coalesces only running activity ticks and immediately persists settings and final state", () => {
    const catalog = create(), original = session(catalog);
    const running = catalog.mergeRuntimeSession({ ...runtimeRecord(original), runtimeStatus: "running" });
    const commits = catalog.storageMetrics().timings.commit.count;
    clockMs += 1_000;
    const tick = { ...runtimeRecord(running), lastActivityAt: now().toISOString(), updatedAt: now().toISOString() };
    expect(catalog.mergeRuntimeSession(tick).lastActivityAt).toBe(running.lastActivityAt);
    expect(catalog.storageMetrics().timings.commit.count).toBe(commits);
    const configured = catalog.mergeRuntimeSession({ ...tick, harnessSettings: { model: "fixture-model" } });
    expect(configured.lastActivityAt).toBe(tick.lastActivityAt);
    clockMs += 30_000;
    const next = { ...runtimeRecord(configured), lastActivityAt: now().toISOString(), updatedAt: now().toISOString() };
    expect(catalog.mergeRuntimeSession(next).lastActivityAt).toBe(next.lastActivityAt);
    clockMs += 1_000;
    const final = { ...next, runtimeStatus: "idle" as const, lastActivityAt: now().toISOString(), updatedAt: now().toISOString() };
    expect(catalog.mergeRuntimeSession(final).lastActivityAt).toBe(final.lastActivityAt);
  });

  it("coalesces unchanged heartbeats without causing false stale status, and persists real transitions", () => {
    const catalog = create(), node = runtime(catalog), start = clockMs;
    const before = catalog.storageMetrics().timings.commit.count;
    for (let step = 1; step < 30; step++) {
      clockMs = start + step * 1_000;
      expect(catalog.heartbeatRuntimeNode(node.runtimeNodeId, node.runtimeNodeBootId)).toBe(true);
      expect(catalog.markStaleRuntimeNodes(new Date(clockMs - 500))).toEqual([]);
    }
    expect(catalog.storageMetrics().timings.commit.count).toBe(before);
    clockMs = start + 30_000; catalog.heartbeatRuntimeNode(node.runtimeNodeId, node.runtimeNodeBootId);
    expect(catalog.storageMetrics().timings.commit.count).toBe(before + 1);
    expect(catalog.getRuntimeNode(node.runtimeNodeId)?.lastHeartbeatAt).toBe(now().toISOString());
    expect(catalog.markStaleRuntimeNodes(new Date(clockMs + 1))).toEqual([node.runtimeNodeId]);
    expect(catalog.getRuntimeNode(node.runtimeNodeId)?.presence).toBe("stale");
    catalog.heartbeatRuntimeNode(node.runtimeNodeId, node.runtimeNodeBootId);
    expect(catalog.getRuntimeNode(node.runtimeNodeId)?.presence).toBe("online");
    expect(catalog.heartbeatRuntimeNode(node.runtimeNodeId, newRuntimeNodeBootId())).toBe(false);
  });

  it("keeps live child heartbeat observations separate from durable timestamps", () => {
    const parent = create(), child = create(); attach(parent, child);
    const descriptor = child.localControlNode(), before = parent.storageMetrics().timings.commit.count;
    clockMs += 10_000;
    parent.heartbeatChild(descriptor.controlNodeId, descriptor.controlNodeBootId);
    expect(parent.markStaleChildren(new Date(clockMs - 1_000))).toEqual([]);
    expect(parent.storageMetrics().timings.commit.count).toBe(before);
    parent.markChildDisconnected(descriptor.controlNodeId, descriptor.controlNodeBootId);
    parent.heartbeatChild(descriptor.controlNodeId, descriptor.controlNodeBootId);
    expect(parent.getControlNode(descriptor.controlNodeId)?.presence).toBe("online");
  });

  it("uses newer durable registration observations and recovers liveness conservatively on restart", () => {
    let catalog = create(); const node = runtime(catalog), child = create(), attachment = attach(catalog, child);
    const descriptor = child.localControlNode();
    clockMs += 10_000; catalog.heartbeatRuntimeNode(node.runtimeNodeId, node.runtimeNodeBootId);
    catalog.heartbeatChild(descriptor.controlNodeId, descriptor.controlNodeBootId);
    clockMs += 10_000; catalog.registerRuntimeNode(node);
    catalog.attachChild({ controlNodeId: descriptor.controlNodeId, controlNodeBootId: descriptor.controlNodeBootId,
      feedId: descriptor.feedId, name: descriptor.name, protocolVersion: 5, capabilities: descriptor.capabilities,
      expectedParentControlNodeId: catalog.localControlNode().controlNodeId, childProof: child.attachmentProof(),
      resume: { attachmentId: attachment.attachmentId, lineageId: attachment.lineageId, authority: attachment.authority } });
    expect(catalog.markStaleRuntimeNodes(new Date(clockMs - 1_000))).toEqual([]);
    expect(catalog.markStaleChildren(new Date(clockMs - 1_000))).toEqual([]);
    const durableChildHeartbeat = catalog.getControlNode(descriptor.controlNodeId)?.lastHeartbeatAt;
    catalog = reopen(catalog);
    expect(catalog.getRuntimeNode(node.runtimeNodeId)?.presence).toBe("stale");
    expect(catalog.getControlNode(descriptor.controlNodeId)?.presence).toBe("stale");
    expect(catalog.getControlNode(descriptor.controlNodeId)?.lastHeartbeatAt).toBe(durableChildHeartbeat);
    catalog.heartbeatRuntimeNode(node.runtimeNodeId, node.runtimeNodeBootId);
    catalog.heartbeatChild(descriptor.controlNodeId, descriptor.controlNodeBootId);
    expect(catalog.getRuntimeNode(node.runtimeNodeId)?.presence).toBe("online");
    expect(catalog.getControlNode(descriptor.controlNodeId)?.presence).toBe("online");
  });

  it("runs bounded retention after successful acknowledgment and contains maintenance failures", async () => {
    vi.useFakeTimers(); let fail = true;
    const catalog = create({ filename: ":memory:", eventRetentionLimit: 1_000, failpoint: point => { if (point === "retention.beforeDelete" && fail) throw Error("fixture storage failure"); } });
    const node = runtime(catalog);
    for (let index = 0; index < 2_010; index++) catalog.registerRuntimeNode(node);
    const cursor = catalog.controlCursor();
    expect(catalog.minimumControlCursor()).toBe(0);
    expect(catalog.storageMetrics().retentionPending).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(catalog.minimumControlCursor()).toBe(0);
    expect(catalog.controlCursor()).toBe(cursor);
    expect(catalog.storageMetrics().counters.compactionFailures).toBe(1);
    fail = false; await vi.advanceTimersByTimeAsync(1_000);
    expect(catalog.minimumControlCursor()).toBe(1_000);
    expect(catalog.canReplayControlCursor(999)).toBe(false);
    expect(catalog.canReplayControlCursor(1_000)).toBe(true);
    expect(catalog.storageMetrics().timings.compaction.failures).toBe(1);
  });
  it("reopens a compacted catalog without replaying expired events or losing authority and receipts", () => {
    let catalog = create();
    const record = session(catalog), authority = catalog.authority();
    const operationId = newOperationId();
    const operation = catalog.submitMetadataPatch({ operationId, sessionId: record.sessionId,
      expectedAuthority: authority, set: { "ui.title": "Preserved" } });
    const feedId = catalog.feedCheckpoint().feedId, boundary = catalog.controlCursor();
    catalog.compactControlEvents(boundary);
    expect(catalog.canReplayControlCursor(0)).toBe(false);
    catalog = reopen(catalog);
    expect(catalog.authority()).toEqual(authority);
    expect(catalog.feedCheckpoint().feedId).toBe(feedId);
    expect(catalog.minimumControlCursor()).toBe(boundary);
    expect(catalog.getMetadataOperation(operationId)).toEqual(operation);
    expect(catalog.getSession(record.sessionId)?.vendorSessionId).toBe(record.vendorSessionId);
    expect(catalog.getMetadata(record.sessionId).values).toEqual({ "ui.title": "Preserved" });
    expect(() => catalog.controlEventsAfter(0)).toThrow("outside retained range");
    expect(catalog.controlEventsAfter(boundary).length).toBeGreaterThan(0);
    const observed: FeedControlItem[] = [];
    catalog.onControl(item => observed.push(item));
    catalog.registerRuntimeNode(catalog.getRuntimeNode(record.runtimeNodeId)!);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(item => item.cursor > boundary)).toBe(true);
  });

});
