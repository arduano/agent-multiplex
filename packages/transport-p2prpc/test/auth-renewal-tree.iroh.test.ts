import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ControlNodeCatalog,
  ControlNodeEventHub,
  ControlNodeService,
  createCompositeControlNodeRouter,
  type CompositeControlNodeRouter,
} from "@arduano/agent-multiplex-control-node-core";
import {
  newCommandId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  packNativePayload,
  runtimeNodeContract,
  runtimeNodeSessionRecordSchema,
  toJsonValue,
  type AccessStreamItem,
  type AdapterScopeId,
  type CommandEnvelope,
  type CommandRecord,
  type RuntimeNodeEventItem,
} from "@arduano/agent-multiplex-protocol";
import {
  RuntimeNodeEventHub,
  RuntimeNodeStore,
  type RuntimeNodeRouter,
} from "@arduano/agent-multiplex-runtime-node-core";
import { ensurePrivateDirectorySync } from "@arduano/agent-multiplex-storage-sqlite";
import type { PeerContext } from "@arduano/p2prpc-core";
import { initTRPC } from "@trpc/server";
import { expect, it, vi } from "vitest";

import { childControlNodeConnectionFromPeerResolver } from "../src/bindings.js";
import { createMultiplexP2PNode, type MultiplexP2PNode } from "../src/node.js";
import { P2PRuntimeNodeConnection, RuntimeNodeEventPump } from "../src/runtime-node-bridge.js";

const t = initTRPC.context<PeerContext>().create();

it("keeps a real root/child/runtime tree reachable with durable cursor continuity through three auth generations", {
  timeout: 30_000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "multiplex-auth-renewal-tree-"));
  const directory = join(temporary, "private");
  ensurePrivateDirectorySync(directory);
  const rootFile = join(directory, "root.sqlite");
  const rootCatalog = new ControlNodeCatalog({ filename: rootFile });
  const childCatalog = new ControlNodeCatalog({ filename: join(directory, "child.sqlite") });
  const rootEvents = new ControlNodeEventHub({ catalog: rootCatalog, heartbeatMs: 40 });
  const childEvents = new ControlNodeEventHub({ catalog: childCatalog, heartbeatMs: 40 });
  const runtimeStore = new RuntimeNodeStore(join(directory, "runtime.sqlite"));
  const runtimeEvents = new RuntimeNodeEventHub({ heartbeatMs: 40 });
  const childPumpErrors: unknown[] = [];
  const runtimePumpErrors: unknown[] = [];
  const rootService = new ControlNodeService({
    catalog: rootCatalog,
    events: rootEvents,
    onChildControlNodePumpError: (_id, error) => childPumpErrors.push(error),
  });
  const childService = new ControlNodeService({ catalog: childCatalog, events: childEvents });
  const snapshotReads = vi.spyOn(childService, "readSubtreeSnapshot");
  const runtimeSubscriptions = vi.fn();
  const modelReadEntered = deferred<void>();
  const releaseModelRead = deferred<void>();
  const commandEntered = deferred<void>();
  const releaseCommand = deferred<void>();
  const commandDispatches = vi.fn();
  const runtimeRouter = t.router({
    commands: t.router({
      execute: t.procedure.input(runtimeNodeContract.commands.execute.input)
        .mutation(async ({ input }) => {
          commandDispatches();
          const now = new Date().toISOString();
          const record: CommandRecord = {
            commandId: input.command.commandId, payloadHash: input.command.payloadHash,
            sessionId: input.command.sessionId, runtimeNodeId: input.command.runtimeNodeId,
            state: "started", request: toJsonValue(input.command), createdAt: now, updatedAt: now,
          };
          runtimeStore.putCommand(record);
          commandEntered.resolve();
          await releaseCommand.promise;
          const settled: CommandRecord = { ...record, state: "succeeded", updatedAt: new Date().toISOString() };
          runtimeStore.putCommand(settled);
          return settled;
        }),
      get: t.procedure.input(runtimeNodeContract.commands.get.input)
        .query(({ input }) => runtimeStore.getCommand(input.commandId) ?? null),
    }),
    harness: t.router({
      models: t.procedure.input(runtimeNodeContract.harness.models.input)
        .query(async () => {
          modelReadEntered.resolve();
          await releaseModelRead.promise;
          return [{ harness: "codex" as const, id: "retained-read" }];
        }),
    }),
    events: t.router({
      subscribe: t.procedure.input(runtimeNodeContract.events.subscribe.input)
        .subscription(({ input, signal }) => {
          runtimeSubscriptions();
          return runtimeEvents.subscribe(input.cursor, signal);
        }),
    }),
  });
  const rootRouter = createCompositeControlNodeRouter(rootService);
  const childRouter = createCompositeControlNodeRouter(childService);
  let root: MultiplexP2PNode<CompositeControlNodeRouter, CompositeControlNodeRouter> | undefined;
  let child: MultiplexP2PNode<CompositeControlNodeRouter, CompositeControlNodeRouter> | undefined;
  let runtime: MultiplexP2PNode<typeof runtimeRouter, CompositeControlNodeRouter> | undefined;
  let pump: RuntimeNodeEventPump | undefined;
  const observer = new AbortController();
  let observation: Promise<void> | undefined;
  const observed: AccessStreamItem[] = [];
  let rootCatalogClosed = false;

  try {
    const sharedSecret = { secret: "disposable-auth-renewal-tree-fixture".padEnd(64, "x"), sessionTtlMs: 800 };
    const iroh = {
      relay: { mode: "disabled" as const },
      allowAdvertisedAddress: () => true,
      allowDirectAddress: () => true,
    };
    root = await createMultiplexP2PNode({
      router: rootRouter, sharedSecret, iroh,
      createContext: (ctx) => ({ endpointId: ctx.p2p.peer.id }),
    });
    rootCatalog.setLocalEndpointId(root.id);
    child = await createMultiplexP2PNode({
      router: childRouter, sharedSecret, iroh,
      createContext: (ctx) => ({
        endpointId: ctx.p2p.peer.id,
        authenticatedControlNodeId: rootCatalog.localControlNode().controlNodeId,
      }),
    });
    childCatalog.setLocalEndpointId(child.id);
    runtime = await createMultiplexP2PNode({
      router: runtimeRouter, sharedSecret, iroh,
      limits: { shutdownTimeoutMs: 100 },
      createContext: (ctx) => ctx,
    });
    await child.connect({ endpointId: root.id, locator: { kind: "ticket", ticket: await root.createTicket() } });
    await runtime.connect({ endpointId: child.id, locator: { kind: "ticket", ticket: await child.createTicket() } });
    await expect.poll(() => root?.getPeer(child!.id)).toBeDefined();
    await expect.poll(() => child?.getPeerAs<RuntimeNodeRouter>(runtime!.id)).toBeDefined();
    const childPeer = root.getPeer(child.id)!;
    const runtimePeer = child.getPeerAs<RuntimeNodeRouter>(runtime.id)!;

    const childDescriptor = childCatalog.localControlNode();
    const { attachment } = rootCatalog.attachChild({
      controlNodeId: childDescriptor.controlNodeId,
      controlNodeBootId: childDescriptor.controlNodeBootId,
      feedId: childDescriptor.feedId,
      name: childDescriptor.name,
      protocolVersion: 6,
      capabilities: childDescriptor.capabilities,
      endpointId: child.id,
      expectedParentControlNodeId: rootCatalog.localControlNode().controlNodeId,
      childProof: childCatalog.attachmentProof(),
    });
    childCatalog.applyParentAttachment(attachment, root.id);
    const runtimeRegistration = {
      runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "renewal-runtime", allowedRoots: ["/work"], harnesses: [], launchProfiles: [], protocolVersion: 6 as const,
    };
    childCatalog.registerRuntimeNode(runtimeRegistration, runtime.id);
    const timestamp = new Date().toISOString();
    const session = childCatalog.reconcileInventory({
      runtimeNodeId: runtimeRegistration.runtimeNodeId,
      generation: "initial-inventory", complete: true, capturedAt: timestamp,
      sessions: [{
        harness: "codex", adapterScopeId: "renewal-fixture" as AdapterScopeId,
        vendorSessionId: "renewal-native", cwd: "/work/project", availability: "active",
        runtimeStatus: "idle", runtimeEpoch: newRuntimeEpoch(), lastActivityAt: timestamp,
      }],
    })[0]!;
    const runtimeSession = runtimeNodeSessionRecordSchema.strip().parse(session);
    const runtimeConnection = new P2PRuntimeNodeConnection(
      runtimeRegistration.runtimeNodeId, runtimeRegistration.runtimeNodeBootId, runtime.id,
      () => child?.getPeerAs<RuntimeNodeRouter>(runtime!.id), runtime.id,
    );
    childService.attachRuntimeNodeConnection(runtimeConnection);
    pump = new RuntimeNodeEventPump({
      connection: runtimeConnection,
      retryDelayMs: () => 10,
      onError: (error) => runtimePumpErrors.push(error),
      onItem: (event) => childService.publishRuntimeEvent({ ...runtimeRegistration, event }, {
        authenticatedRuntimeNodeId: runtimeRegistration.runtimeNodeId,
        endpointId: runtime!.id,
      }).accepted,
    });
    pump.start();
    const childConnection = childControlNodeConnectionFromPeerResolver(child.id,
      () => root?.getPeer(child!.id), {
        controlNodeId: childDescriptor.controlNodeId,
        controlNodeBootId: childDescriptor.controlNodeBootId,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
      }, child.id);
    await rootService.attachChildConnection(childConnection);
    const initialCheckpoint = rootCatalog.childCheckpoint(childDescriptor.controlNodeId)!;
    observation = (async () => {
      for await (const item of rootEvents.attach({
        sessions: "all", includeNative: true,
        cursor: { ...rootCatalog.feedCheckpoint(), native: {} },
      }, observer.signal)) observed.push(item);
    })();
    const activeRead = rootService.listModels(runtimeRegistration.runtimeNodeId, "codex");
    void activeRead.catch(() => undefined);
    await modelReadEntered.promise;
    const command: CommandEnvelope = {
      commandId: newCommandId(), payloadHash: "a".repeat(64),
      sessionId: session.sessionId, runtimeNodeId: runtimeRegistration.runtimeNodeId,
      bindingRevision: session.bindingRevision,
      request: { harness: "codex", command: { type: "interrupt" } },
    };
    const mutation = rootService.execute(command);
    const mutationOutcome = mutation.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await commandEntered.promise;

    // Observe one entirely idle boundary, then busy control and native streams.
    // A read dispatched before the first boundary stays on its original stream.
    for (let boundary = 0; boundary < 3; boundary += 1) {
      const priorChildSession = childPeer.session.id;
      const priorRuntimeSession = runtimePeer.session.id;
      if (boundary > 0) {
        const sequence = boundary - 1;
        const event: RuntimeNodeEventItem = {
          kind: "native", sessionId: session.sessionId, harness: "codex",
          runtimeEpoch: session.runtimeEpoch!, sequence, nativeType: "renewal/tick",
          payload: packNativePayload({ sequence }), ephemeral: false,
        };
        runtimeEvents.publish(event);
        runtimeEvents.publish(event); // Duplicate native identity is suppressed.
        runtimeEvents.publish({ kind: "control", change: {
          type: "session.upsert", session: {
            ...runtimeSession, runtimeStatus: boundary === 1 ? "running" : "idle",
            updatedAt: new Date().toISOString(),
          },
        } });
      }
      await expect.poll(() => childPeer.session.id, { timeout: 5_000 }).not.toBe(priorChildSession);
      await expect.poll(() => runtimePeer.session.id, { timeout: 5_000 }).not.toBe(priorRuntimeSession);
      expect(root.getPeer(child.id)?.session).toBe(childPeer.session);
      expect(child.getPeerAs<RuntimeNodeRouter>(runtime.id)?.session).toBe(runtimePeer.session);
      expect(rootCatalog.getControlNode(childDescriptor.controlNodeId)?.presence).toBe("online");
      expect(rootCatalog.getRuntimeNode(runtimeRegistration.runtimeNodeId)?.reachability).toBe("reachable");
      expect(childPumpErrors).toEqual([]);
      expect(runtimePumpErrors).toEqual([]);
      expect(snapshotReads).toHaveBeenCalledTimes(1);
      expect(runtimeSubscriptions).toHaveBeenCalledTimes(1);
      expect(commandDispatches).toHaveBeenCalledTimes(1);
      expect(runtimeStore.getCommand(command.commandId)?.state).toBe("started");
    }
    releaseModelRead.resolve();
    await expect(activeRead).resolves.toEqual([{ harness: "codex", id: "retained-read" }]);
    await expect.poll(() => observed.filter((item) => item.kind === "native").length).toBe(2);
    expect(observed.filter((item) => item.kind === "native").map((item) => item.sequence)).toEqual([0, 1]);
    expect(pump.cursor.native[session.sessionId]?.sequence).toBe(1);
    await expect.poll(() => rootCatalog.childCheckpoint(childDescriptor.controlNodeId))
      .toEqual(childCatalog.feedCheckpoint());
    const committedCheckpoint = rootCatalog.childCheckpoint(childDescriptor.controlNodeId)!;
    expect(committedCheckpoint.controlCursor).toBeGreaterThan(initialCheckpoint.controlCursor);
    const imports = rootCatalog.controlEventsAfter(0).filter((item) =>
      item.provenance.originControlNodeId === childDescriptor.controlNodeId);
    expect(new Set(imports.map((item) => item.eventId)).size).toBe(imports.length);
    expect(observed.some((item) => item.kind === "streamReset" || item.kind === "nativeGap")).toBe(false);
    expect(observed.some((item) => item.kind === "control" && (
      item.change.type === "controlNode.presence" ||
      item.change.type === "runtimeNode.presence" ||
      item.change.type === "runtimeNode.upsert" && item.change.runtimeNode.reachability !== "reachable"
    ))).toBe(false);
    expect(childPumpErrors).toEqual([]);
    expect(runtimePumpErrors).toEqual([]);

    // A genuine network loss after dispatch remains ambiguous. Renewal never
    // replays the mutation; recovery asks for the same durable command receipt.
    const disconnection = runtimePeer.close("disposable network-loss test");
    expect((await mutationOutcome).error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(rootService.getCommand(command.commandId)?.state).toBe("outcomeUnknown");
    releaseCommand.resolve();
    await disconnection;
    await expect.poll(() => runtimeStore.getCommand(command.commandId)?.state).toBe("succeeded");
    await runtime.connect({ endpointId: child.id, locator: { kind: "ticket", ticket: await child.createTicket() } });
    await expect.poll(() => child?.getPeerAs<RuntimeNodeRouter>(runtime!.id)).toBeDefined();
    await expect(rootService.recoverCommand(command.commandId)).resolves.toMatchObject({ state: "succeeded" });
    expect(commandDispatches).toHaveBeenCalledTimes(1);
    await expect.poll(() => runtimeSubscriptions.mock.calls.length).toBe(2);
    runtimeEvents.publish({
      kind: "native", sessionId: session.sessionId, harness: "codex",
      runtimeEpoch: session.runtimeEpoch!, sequence: 2, nativeType: "renewal/tick",
      payload: packNativePayload({ sequence: 2 }), ephemeral: false,
    });
    await expect.poll(
      () => pump?.cursor.native[session.sessionId]?.sequence,
      { timeout: 5_000 },
    ).toBe(2);
    expect(childPumpErrors).toEqual([]);
    expect(runtimePumpErrors.length).toBeGreaterThan(0);
    expect(runtimePumpErrors.every((error) =>
      errorCodeChain(error).some((code) => code === "OUTCOME_UNKNOWN" || code === "DISCONNECTED")
    )).toBe(true);
    await expect.poll(
      () => observed.filter((item) => item.kind === "native").length,
      { timeout: 5_000 },
    ).toBe(3);
    expect(observed.filter((item) => item.kind === "native").map((item) => item.sequence)).toEqual([0, 1, 2]);
    expect(commandDispatches).toHaveBeenCalledTimes(1);

    // Actual loss of the child feed still fences the projected subtree at once;
    // no liveness grace was added to disguise transport failures.
    await childPeer.close("disposable child network-loss test");
    await expect.poll(() => rootCatalog.getControlNode(childDescriptor.controlNodeId)?.presence).toBe("stale");
    expect(rootCatalog.getRuntimeNode(runtimeRegistration.runtimeNodeId)?.reachability).toBe("unreachable");
    await child.connect({ endpointId: root.id, locator: { kind: "ticket", ticket: await root.createTicket() } });
    await expect.poll(() => root?.getPeer(child!.id)).toBeDefined();
    await rootService.heartbeatChild({
      controlNodeId: childDescriptor.controlNodeId,
      controlNodeBootId: childDescriptor.controlNodeBootId,
      attachmentId: attachment.attachmentId, lineageId: attachment.lineageId,
      checkpoint: childCatalog.feedCheckpoint(),
    }, { endpointId: child.id, authenticatedControlNodeId: childDescriptor.controlNodeId });
    expect(rootCatalog.getRuntimeNode(runtimeRegistration.runtimeNodeId)?.reachability).toBe("reachable");
    expect(snapshotReads).toHaveBeenCalledTimes(2);
    expect(commandDispatches).toHaveBeenCalledTimes(1);

    await expect.poll(() => rootCatalog.childCheckpoint(childDescriptor.controlNodeId))
      .toEqual(childCatalog.feedCheckpoint());
    const finalCheckpoint = rootCatalog.childCheckpoint(childDescriptor.controlNodeId);
    observer.abort();
    await observation;
    rootService.close();
    rootEvents.close();
    rootCatalog.close();
    rootCatalogClosed = true;
    const reopened = new ControlNodeCatalog({ filename: rootFile });
    try {
      expect(reopened.childCheckpoint(childDescriptor.controlNodeId)).toEqual(finalCheckpoint);
      expect(reopened.getCommand(command.commandId)?.state).toBe("succeeded");
    } finally {
      reopened.close();
    }
  } finally {
    releaseModelRead.resolve();
    releaseCommand.resolve();
    observer.abort();
    await observation;
    pump?.stop();
    rootService.close();
    childService.close();
    rootEvents.close();
    childEvents.close();
    await Promise.allSettled([runtime?.close(), child?.close(), root?.close()]);
    if (!rootCatalogClosed) rootCatalog.close();
    childCatalog.close();
    runtimeStore.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function errorCodeChain(error: unknown): unknown[] {
  const codes: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    codes.push(Object.getOwnPropertyDescriptor(current, "code")?.value);
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return codes;
}
