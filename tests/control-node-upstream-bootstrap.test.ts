import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlNodeCatalog, type ControlNodeService } from "@arduano/agent-multiplex-control-node-core";
import type { ControlNodeAttachmentRequest } from "@arduano/agent-multiplex-protocol";
import { ReconnectableMetadataUpstream } from "@arduano/agent-multiplex-transport-p2prpc";
import { afterEach, expect, it, vi } from "vitest";
import type { DesiredControlNodeUpstream } from "../apps/control-node/src/config.js";
import { superviseUpstreamControlNode, type UpstreamSupervisorOptions } from "../apps/control-node/src/upstream.js";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-same-parent-bootstrap-"));
  const parent = new ControlNodeCatalog({ filename: join(directory, "parent.sqlite") });
  const child = new ControlNodeCatalog({ filename: join(directory, "child.sqlite") });
  child.setLocalEndpointId("fixture-child-endpoint");
  disposals.push(() => { child.close(); parent.close(); rmSync(directory, { recursive: true, force: true }); });
  const desired: DesiredControlNodeUpstream = { version: 1, controlNodeId: parent.localControlNode().controlNodeId,
    endpointId: "fixture-parent-endpoint", locator: { kind: "ticket", ticket: "stored-old-policy-ticket" } };
  const bootstrap: DesiredControlNodeUpstream = { ...desired, locator: { kind: "ticket", ticket: "configured-private-ticket" } };
  child.bootstrapDesiredUpstream(desired);
  const attach = vi.fn(async (request: ControlNodeAttachmentRequest) => {
    const result = parent.attachChild(request);
    return { accepted: true, canonical: result.child, attachment: result.attachment, parentCheckpoint: parent.feedCheckpoint() };
  });
  const heartbeat = vi.fn(async () => ({ accepted: true, parentCheckpoint: parent.feedCheckpoint(),
    p2pTicket: "authenticated-parent-renewed-ticket" }));
  const peer = { identity: { id: desired.endpointId }, rpc: { ingress: { controlNodes: {
    attach: { mutate: attach }, heartbeat: { mutate: heartbeat }, pushMetadataOutbox: { mutate: vi.fn(async () => []) },
  } } } };
  const node = { connectAs: vi.fn(async (_target: { endpointId: string; locator: DesiredControlNodeUpstream["locator"] }) => peer) };
  const service = { flushMetadataOutbox: vi.fn(async () => undefined), flushMetadataDeliveries: vi.fn(async () => undefined) };
  const controller = new AbortController(), metadataUpstream = new ReconnectableMetadataUpstream();
  const connected = vi.fn(() => controller.abort());
  const disconnected = vi.fn(() => controller.abort());
  const start = (overrides: Partial<UpstreamSupervisorOptions> = {}) => superviseUpstreamControlNode({
    node: node as unknown as UpstreamSupervisorOptions["node"], initialUpstream: desired,
    bootstrapUpstream: bootstrap, catalog: child, service: service as unknown as ControlNodeService,
    metadataUpstream, heartbeatMs: 1, reconnectMaxMs: 1, signal: controller.signal,
    onConnected: connected, onDisconnected: disconnected, ...overrides,
  });
  const forceDetach = () => {
    const local = child.localControlNode();
    const role = child.dataRole();
    if (role.role !== "branch" || role.branch.lifecycle !== "attached") throw new Error("fixture must attach first");
    child.forceDetach({ controlNodeId: local.controlNodeId, expectedAuthority: role.authority,
      attachmentId: role.branch.attachmentId, lineageId: role.branch.lineageId,
      acknowledgedUnknownMetadataOutcomes: true,
      audit: { actorId: "fixture", reason: "disposable parent lost", requestedAt: new Date().toISOString(), evidence: [] } });
  };
  const attachBeforeStart = () => {
    const local = child.localControlNode();
    const result = parent.attachChild({ controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
      feedId: local.feedId, name: local.name, endpointId: local.endpointId, protocolVersion: 6,
      capabilities: local.capabilities, expectedParentControlNodeId: desired.controlNodeId, childProof: child.attachmentProof() });
    child.applyParentAttachment(result.attachment, desired.endpointId);
  };
  return { child, parent, desired, bootstrap, peer, node, attach, heartbeat, service, controller,
    connected, disconnected, metadataUpstream, start, attachBeforeStart, forceDetach };
}

it("uses durable desired first and never dials configured fallback when the saved locator works", async () => {
  const f = fixture(); await f.start();
  expect(f.node.connectAs.mock.calls.map(([target]) => target)).toEqual([{ endpointId: f.desired.endpointId, locator: f.desired.locator }]);
  expect(f.connected).toHaveBeenCalledOnce();
  expect(f.child.desiredUpstream()).toEqual({ ...f.desired, locator: { kind: "ticket", ticket: "authenticated-parent-renewed-ticket" } });
  expect(f.metadataUpstream.connected).toBe(false);
});

it("reaches the same pinned parent through configured fallback and persists only its accepted heartbeat refresh", async () => {
  const f = fixture(); f.node.connectAs.mockRejectedValueOnce(new Error("saved ticket denied by custom policy"));
  f.attach.mockImplementationOnce(async request => {
    expect(f.child.desiredUpstream()).toEqual(f.desired); // Dialing config alone never rewrites durable state.
    const result = f.parent.attachChild(request);
    return { accepted: true, canonical: result.child, attachment: result.attachment, parentCheckpoint: f.parent.feedCheckpoint() };
  });
  await f.start();
  expect(f.node.connectAs.mock.calls.map(([target]) => target.locator)).toEqual([f.desired.locator, f.bootstrap.locator]);
  expect(f.attach.mock.calls[0]?.[0].expectedParentControlNodeId).toBe(f.desired.controlNodeId);
  expect(f.connected).toHaveBeenCalledOnce();
  expect(f.child.desiredUpstream()).toEqual({ ...f.desired, locator: { kind: "ticket", ticket: "authenticated-parent-renewed-ticket" } });
});

for (const changed of ["logical parent", "endpoint", "same locator", "absent bootstrap"] as const) {
  it(`ignores fallback with ${changed} and retains the durable parent`, async () => {
    const f = fixture(); f.node.connectAs.mockRejectedValue(new Error("saved locator unavailable"));
    const alternate = changed === "logical parent" ? { ...f.bootstrap, controlNodeId: f.child.localControlNode().controlNodeId }
      : changed === "endpoint" ? { ...f.bootstrap, endpointId: "another-parent-endpoint" }
      : changed === "same locator" ? f.desired : undefined;
    await f.start({ bootstrapUpstream: alternate });
    expect(f.node.connectAs).toHaveBeenCalledOnce(); expect(f.attach).not.toHaveBeenCalled();
    expect(f.child.desiredUpstream()).toEqual(f.desired);
  });
}

it("does not persist failed fallback or rejected attachment and makes no metadata connection", async () => {
  const f = fixture(); f.node.connectAs.mockRejectedValueOnce(new Error("old locator unavailable"));
  f.attach.mockResolvedValueOnce({ accepted: false } as never);
  await f.start();
  expect(f.node.connectAs).toHaveBeenCalledTimes(2);
  expect(f.child.desiredUpstream()).toEqual(f.desired);
  expect(f.heartbeat).not.toHaveBeenCalled(); expect(f.connected).not.toHaveBeenCalled();
  expect(f.metadataUpstream.connected).toBe(false);
});

it("retains the original locator after a failed fallback connection", async () => {
  const f = fixture(); f.node.connectAs.mockRejectedValue(new Error("both locators unavailable"));
  await f.start(); expect(f.node.connectAs).toHaveBeenCalledTimes(2);
  expect(f.child.desiredUpstream()).toEqual(f.desired); expect(f.attach).not.toHaveBeenCalled();
});

for (const stage of ["primary rejection", "fallback connection", "attachment", "heartbeat"] as const) {
  it(`cannot resurrect an explicit force-detach during ${stage}`, async () => {
    const f = fixture(); f.attachBeforeStart();
    if (stage === "primary rejection") f.node.connectAs.mockImplementationOnce(async () => { f.forceDetach(); throw new Error("retired primary"); });
    else if (stage === "fallback connection") {
      f.node.connectAs.mockRejectedValueOnce(new Error("primary unavailable"));
      f.node.connectAs.mockImplementationOnce(async () => { f.forceDetach(); return f.peer; });
    } else if (stage === "attachment") f.attach.mockImplementationOnce(async request => {
      const result = f.parent.attachChild(request); f.forceDetach();
      return { accepted: true, canonical: result.child, attachment: result.attachment, parentCheckpoint: f.parent.feedCheckpoint() };
    });
    else f.heartbeat.mockImplementationOnce(async () => { f.forceDetach(); return { accepted: true,
      parentCheckpoint: f.parent.feedCheckpoint(), p2pTicket: "late-after-detach-ticket" }; });
    await f.start();
    expect(f.child.desiredUpstream()).toBeNull();
    expect(f.child.dataRole()).toMatchObject({ role: "branch", branch: { lifecycle: "detached" } });
    expect(f.connected).not.toHaveBeenCalled();
    if (stage === "primary rejection") expect(f.node.connectAs).toHaveBeenCalledOnce();
  });
}

for (const stage of ["primary rejection", "fallback connection", "attachment", "heartbeat"] as const) {
  it(`retries a concurrently refreshed same-parent locator after ${stage} without overwriting it`, async () => {
    const f = fixture(), fresh = { ...f.desired, locator: { kind: "ticket" as const, ticket: "concurrent-new-selection" } };
    const refresh = () => f.child.setDesiredUpstream(fresh);
    if (stage === "primary rejection") f.node.connectAs.mockImplementationOnce(async () => { refresh(); throw new Error("old primary failed"); });
    else if (stage === "fallback connection") {
      f.node.connectAs.mockRejectedValueOnce(new Error("old primary failed"));
      f.node.connectAs.mockImplementationOnce(async () => { refresh(); return f.peer; });
    } else if (stage === "attachment") f.attach.mockImplementationOnce(async request => {
      const result = f.parent.attachChild(request); refresh();
      return { accepted: true, canonical: result.child, attachment: result.attachment, parentCheckpoint: f.parent.feedCheckpoint() };
    });
    else f.heartbeat.mockImplementationOnce(async () => { refresh(); return { accepted: true,
      parentCheckpoint: f.parent.feedCheckpoint(), p2pTicket: "stale-in-flight-renewal" }; });
    f.node.connectAs.mockImplementation(async target => {
      if (target.locator.kind === "ticket" && target.locator.ticket === "concurrent-new-selection") expect(f.child.desiredUpstream()).toEqual(fresh);
      return f.peer;
    });
    await f.start();
    expect(f.node.connectAs.mock.calls.at(-1)?.[0].locator).toEqual(fresh.locator);
    expect(f.connected).toHaveBeenCalledOnce();
    expect(f.child.desiredUpstream()).toEqual({ ...fresh, locator: { kind: "ticket", ticket: "authenticated-parent-renewed-ticket" } });
  });
}

it("never bootstraps a cleared desired parent or reconnects an already detached branch", async () => {
  const cleared = fixture(); cleared.child.setDesiredUpstream(null); await cleared.start();
  expect(cleared.node.connectAs).not.toHaveBeenCalled();
  const detached = fixture(); detached.attachBeforeStart(); detached.forceDetach();
  // Even an explicitly retained same-parent environment cannot revive detach.
  await detached.start(); expect(detached.node.connectAs).not.toHaveBeenCalled();
});

it("normal supervisor restart prefers authenticated durable renewal over older configured fallback", async () => {
  const f = fixture(); f.node.connectAs.mockRejectedValueOnce(new Error("old ticket unavailable")); await f.start();
  const renewed = f.child.desiredUpstream() as DesiredControlNodeUpstream;
  const next = new AbortController(); f.node.connectAs.mockClear();
  await f.start({ initialUpstream: renewed, signal: next.signal, onConnected: () => next.abort() });
  expect(f.node.connectAs).toHaveBeenCalledOnce();
  expect(f.node.connectAs.mock.calls[0]?.[0].locator).toEqual(renewed.locator);
  expect(f.child.listRoleTransitions()).toHaveLength(1);
});

it("retries a newer durable locator after primary rejection even without a configured fallback", async () => {
  const f = fixture(), fresh = { ...f.desired, locator: { kind: "ticket" as const, ticket: "concurrent-new-selection" } };
  f.node.connectAs.mockImplementationOnce(async () => { f.child.setDesiredUpstream(fresh); throw new Error("retired primary"); });
  await f.start({ bootstrapUpstream: undefined });
  expect(f.node.connectAs.mock.calls.map(([target]) => target.locator)).toEqual([f.desired.locator, fresh.locator]);
  expect(f.disconnected).not.toHaveBeenCalled();
  expect(f.connected).toHaveBeenCalledOnce();
});

for (const stage of ["before heartbeat", "during heartbeat"] as const) {
  it(`redials a newer same-parent selection ${stage} on an established connection`, async () => {
    const f = fixture(), fresh = { ...f.desired, locator: { kind: "ticket" as const, ticket: "steady-state-new-selection" } };
    let connected = 0;
    if (stage === "during heartbeat") {
      f.heartbeat.mockImplementationOnce(async () => ({ accepted: true, parentCheckpoint: f.parent.feedCheckpoint(),
        p2pTicket: "authenticated-parent-renewed-ticket" }));
      f.heartbeat.mockImplementationOnce(async () => {
        f.child.setDesiredUpstream(fresh);
        return { accepted: true, parentCheckpoint: f.parent.feedCheckpoint(), p2pTicket: "stale-steady-renewal" };
      });
    }
    await f.start({ onConnected: () => {
      if (++connected === 1 && stage === "before heartbeat") f.child.setDesiredUpstream(fresh);
      else if (connected === 2) f.controller.abort();
    } });
    expect(f.node.connectAs.mock.calls.map(([target]) => target.locator)).toEqual([f.desired.locator, fresh.locator]);
    expect(f.disconnected).not.toHaveBeenCalled();
    expect(f.child.desiredUpstream()).toEqual({ ...fresh, locator: { kind: "ticket", ticket: "authenticated-parent-renewed-ticket" } });
  });
}
