import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { ControlNodeCatalog, ControlNodeService, type ChildControlNodeConnection } from "@arduano/agent-multiplex-control-node-core";
import { newRuntimeNodeId, newRuntimeNodeBootId, newRuntimeEpoch, newCommandId, packNativePayload, type CommandRecord } from "@arduano/agent-multiplex-protocol";
import { describe, it, expect } from "vitest";
import { IsolatedControlOwner, waitForIsolatedStorage } from "../apps/control-node/src/isolated-control.js";
import { createIsolatedAccessRouter, createIsolatedControlRouter } from "../apps/control-node/src/isolated-router.js";
import { createControlNodeHttpSurfaceFromRouter } from "../apps/control-node/src/http.js";

const enrollment = { runtimeNodes: false, childControlNodes: true, accessGateways: true, accessGatewayScopes: ["read"] as const };
describe("isolated authority control", () => {
  it("keeps slow startup in one lane, serves health and rejects domain work before admission", async () => {
    const memory = new SharedArrayBuffer(4);
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); parentPort.on('message', m => { if(m.kind !== 'request')return; Atomics.wait(new Int32Array(workerData),0,0); parentPort.postMessage({kind:'response',id:m.id,result:null}); });`, { eval: true, workerData: memory });
    const owner = new IsolatedControlOwner({ statePath: "unused", name: "fixture", enrollment, childControlNodeStaleMs: 30_000 }, "fixture", () => { throw Error("unused"); }, { worker });
    const controller = new AbortController();
    const http = createControlNodeHttpSurfaceFromRouter(createIsolatedAccessRouter(owner.rpc, () => false), () => owner.health());
    let settled = false;
    const startup = waitForIsolatedStorage(owner.rpc, controller.signal).finally(() => { settled = true; });
    try {
      http.server.listen(0, "127.0.0.1"); await once(http.server, "listening");
      const address = http.server.address(); if (!address || typeof address === "string") throw Error("missing port");
      const url = `http://127.0.0.1:${address.port}`;
      expect((await fetch(url + "/health")).status).toBe(503);
      expect((await fetch(url + "/trpc/system.describe")).status).toBe(503);
      expect(owner.health().queue.pending).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 11_000));
      expect(settled).toBe(false);
      expect(owner.health().queue).toMatchObject({ pending: 1, expired: 0 });
      controller.abort(); await expect(startup).rejects.toThrow();
      expect(owner.health().queue.pending).toBe(1);
    } finally { Atomics.store(new Int32Array(memory), 0, 1); Atomics.notify(new Int32Array(memory), 0); await worker.terminate(); await http.close(); await owner.close().catch(() => {}); }
  }, 20_000);
  it("runs original authorization and durable catalog in a worker with unchanged identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-isolated-authority-"));
    const statePath = join(directory, "catalog.sqlite");
    const config = { statePath, name: "fixture", enrollment, childControlNodeStaleMs: 30_000 };
    const owner = new IsolatedControlOwner(config, "fixture-instance", () => { throw new Error("unexpected reverse call"); });
    const http = createControlNodeHttpSurfaceFromRouter(createIsolatedAccessRouter(owner.rpc), () => owner.health());
    try {
      const identity = await owner.rpc.call<{ controlNodeId: string }>("identity");
      const caller = createIsolatedAccessRouter(owner.rpc).createCaller({ trustedLocalAccess: true });
      expect(await caller.system.describe()).toMatchObject({ protocolVersion: 5, instanceId: "fixture-instance" });
      expect(await caller.sources.snapshot()).toMatchObject({ source: { manifest: { sourceControlNodeId: identity.controlNodeId } } });
      await expect(createIsolatedAccessRouter(owner.rpc).createCaller({}).sessions.search({} as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
      const endpoint = "a".repeat(64);
      const ingress = createIsolatedControlRouter(owner.rpc).createCaller({ authenticatedActorId: endpoint, endpointId: endpoint });
      const enrolled = await ingress.ingress.gateways.enroll({ name: "fixture-gateway", protocolVersion: 5, requestedScopes: ["read"] });
      expect(enrolled.accepted).toBe(true);
      expect(await owner.rpc.call("enrollment", [endpoint])).toMatchObject({ role: "access-gateway", scopes: ["read"] });
      http.server.listen(0, "127.0.0.1"); await once(http.server, "listening");
      const address = http.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: true, storage: "responsive" });
      await owner.close();
      const restarted = new IsolatedControlOwner(config, "fixture-instance-2", () => { throw new Error("unexpected reverse call"); });
      try {
        expect(await restarted.rpc.call("identity")).toMatchObject({ controlNodeId: identity.controlNodeId });
        expect(await restarted.rpc.call("enrollment", [endpoint])).toMatchObject({ role: "access-gateway", scopes: ["read"] });
      } finally { await restarted.close(); }
    } finally { await http.close(); await owner.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("attaches a child through the original router and imports its reverse snapshot and stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-owner-child-"));
    const child = new ControlNodeCatalog({ filename: join(directory, "child.sqlite") });
    const service = new ControlNodeService({ catalog: child });
    const endpoint = "b".repeat(64);
    const config = { statePath: join(directory, "root.sqlite"), name: "root", enrollment, childControlNodeStaleMs: 30_000 };
    let snapshotCalls = 0, streamCalls = 0, dispatched = 0;
    let receipt: CommandRecord | null = null;
    const owner = new IsolatedControlOwner(config, "fixture-root", descriptor => {
      expect(descriptor.endpointId).toBe(endpoint);
      return {
        controlNodeId: child.localControlNode().controlNodeId,
        controlNodeBootId: child.localControlNode().controlNodeBootId, endpointId: endpoint,
        readSubtreeSnapshot: async () => {
          snapshotCalls++;
          const snapshot = child.accessSnapshot();
          return { ...snapshot, attachmentId: descriptor.attachmentId, lineageId: descriptor.lineageId,
            checkpoint: child.feedCheckpoint(), nextPageToken: null };
        },
        subscribeAggregate: (cursor, signal) => { streamCalls++; return service.events.attach({ sessions: "all", cursor, includeNative: true }, signal); },
        getSession: id => service.getSession(id),
        execute: async command => {
          dispatched++;
          receipt = { commandId: command.commandId, payloadHash: command.payloadHash, sessionId: command.sessionId,
            runtimeNodeId: command.runtimeNodeId, state: "succeeded", request: command,
            result: packNativePayload({ accepted: true }), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as CommandRecord;
          throw new Error("fixture lost reply after native dispatch");
        },
        getCommand: async () => receipt,
      } as ChildControlNodeConnection;
    });
    try {
      const root = await owner.rpc.call<{ controlNodeId: string }>("identity");
      const ingress = createIsolatedControlRouter(owner.rpc).createCaller({ endpointId: endpoint, authenticatedActorId: endpoint });
      const local = child.localControlNode();
      const admitted = await ingress.ingress.controlNodes.attach({ controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
        feedId: local.feedId, name: local.name, protocolVersion: 5, capabilities: local.capabilities,
        expectedParentControlNodeId: root.controlNodeId as never, childProof: child.attachmentProof() });
      child.applyParentAttachment(admitted.attachment, "root-endpoint");
      await ingress.ingress.controlNodes.heartbeat({ controlNodeId: local.controlNodeId, controlNodeBootId: local.controlNodeBootId,
        attachmentId: admitted.attachment.attachmentId, lineageId: admitted.attachment.lineageId,
        authority: admitted.attachment.authority, checkpoint: child.feedCheckpoint() });
      const runtime = child.registerRuntimeNode({ runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), name: "child-runtime", allowedRoots: ["/work"], harnesses: [], protocolVersion: 5 });
      const access = createIsolatedAccessRouter(owner.rpc).createCaller({ trustedLocalAccess: true });
      await expect.poll(async () => (await access.runtimeNodes.list()).map(item => item.runtimeNodeId)).toContain(runtime.runtimeNodeId);
      expect(snapshotCalls).toBe(1); expect(streamCalls).toBe(1);
      const [session] = child.reconcileInventory({ runtimeNodeId: runtime.runtimeNodeId, generation: "fixture-one", complete: true,
        capturedAt: new Date().toISOString(), sessions: [{ harness: "codex", adapterScopeId: "fixture", vendorSessionId: "fixture", cwd: "/work",
          availability: "active", runtimeStatus: "idle", runtimeEpoch: newRuntimeEpoch(), lastActivityAt: new Date().toISOString() }] });
      await expect.poll(async () => (await access.sessions.search({})).sessions.map(item => item.sessionId)).toContain(session!.sessionId);
      const command = { commandId: newCommandId(), payloadHash: "fixture-stable-operation-hash", sessionId: session!.sessionId,
        runtimeNodeId: runtime.runtimeNodeId, bindingRevision: session!.bindingRevision,
        request: { harness: "codex" as const, command: { type: "setModel" as const, model: "fixture-model" } } };
      await expect(access.sessions.execute(command)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
      expect(await access.commands.get(command.commandId)).toMatchObject({ state: "succeeded", commandId: command.commandId });
      expect(await access.commands.get(command.commandId)).toMatchObject({ state: "succeeded" });
      expect(dispatched).toBe(1);
    } finally { await owner.close(); service.close(); child.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps transport health responsive across a sixty-second storage stall", async () => {
    const memory = new SharedArrayBuffer(4);
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); parentPort.postMessage({kind:'storage.progress',metrics:{}}); parentPort.on('message', () => Atomics.wait(new Int32Array(workerData),0,0));`, { eval: true, workerData: memory });
    const owner = new IsolatedControlOwner({ statePath: "unused", name: "fixture", enrollment, childControlNodeStaleMs: 30_000 }, "fixture", () => { throw new Error("unused"); }, { worker });
    const http = createControlNodeHttpSurfaceFromRouter(createIsolatedAccessRouter(owner.rpc), () => owner.health());
    try {
      await once(worker, "online");
      const pending = owner.rpc.call("identity", [], { timeoutMs: 50 }).catch(error => error);
      http.server.listen(0, "127.0.0.1"); await once(http.server, "listening");
      const address = http.server.address(); if (!address || typeof address === "string") throw new Error("missing port");
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(500) });
      expect([200, 503]).toContain(response.status);
      expect(await pending).toMatchObject({ code: "UNAVAILABLE" });
      expect(owner.health().queue).toMatchObject({ pending: 1, expired: 1 });
      await new Promise(resolve => setTimeout(resolve, 60_000));
      const stalled = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(500) });
      expect(stalled.status).toBe(503);
      expect(await stalled.json()).toMatchObject({ ready: false, storage: "stalled", queue: { pending: 1, expired: 1 } });
    } finally { Atomics.store(new Int32Array(memory), 0, 1); Atomics.notify(new Int32Array(memory), 0); await worker.terminate(); await http.close(); await owner.close().catch(() => {}); }
  }, 70_000);
});
