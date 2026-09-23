import {
  TERMINAL_MAX_SCREEN_BYTES,
  controlNodeLinkContract,
  newAttachmentId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLineageId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  runtimeNodeContract,
  type AccessStreamItem,
  type RuntimeNodeEventItem,
} from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeRouter } from "@arduano/agent-multiplex-runtime-node-core";
import type { PeerContext } from "@arduano/p2prpc-core";
import { initTRPC } from "@trpc/server";
import { describe, expect, it } from "vitest";

import {
  childControlNodeConnectionFromPeerResolver,
} from "../src/bindings.js";
import {
  P2PRuntimeNodeConnection,
  RuntimeNodeEventPump,
} from "../src/runtime-node-bridge.js";
import {
  createMultiplexP2PNode,
  type MultiplexP2PNode,
} from "../src/node.js";

const t = initTRPC.context<PeerContext>().create();

describe("real-Iroh dynamic reverse bindings", () => {
  it("carries a maximum synthesized terminal reset through a real p2prpc frame", {
    timeout: 30_000,
  }, async () => {
    const screenBase64 = Buffer.alloc(TERMINAL_MAX_SCREEN_BYTES, 0x78)
      .toString("base64");
    const sourceRouter = t.router({
      maximumReset: t.procedure.query(() => ({
        kind: "reset" as const,
        fidelity: "synthesized" as const,
        screenBase64,
      })),
    });
    const observerRouter = t.router({});
    type SourceRouter = typeof sourceRouter;
    type ObserverRouter = typeof observerRouter;
    let source: MultiplexP2PNode<SourceRouter, ObserverRouter> | undefined;
    let observer: MultiplexP2PNode<ObserverRouter, SourceRouter> | undefined;

    try {
      const sharedSecret = "maximum-terminal-reset-frame-test".padEnd(64, "x");
      const iroh = {
        relay: { mode: "disabled" as const },
        allowAdvertisedAddress: () => true,
        allowDirectAddress: () => true,
      };
      source = await createMultiplexP2PNode({
        router: sourceRouter,
        sharedSecret: { secret: sharedSecret },
        createContext: (context) => context,
        iroh,
      });
      observer = await createMultiplexP2PNode({
        router: observerRouter,
        sharedSecret: { secret: sharedSecret },
        createContext: (context) => context,
        iroh,
      });
      const peer = await observer.connect({
        endpointId: source.id,
        locator: { kind: "ticket", ticket: await source.createTicket() },
      });

      const reset = await peer.rpc.maximumReset.query();
      expect(reset.kind).toBe("reset");
      expect(reset.fidelity).toBe("synthesized");
      expect(reset.screenBase64).toBe(screenBase64);
    } finally {
      await Promise.allSettled([observer?.close(), source?.close()]);
    }
  });

  it("retains one child-control feed and live unary routing across three auth renewals", {
    timeout: 30_000,
  }, async () => {
    const subscriptionSessionIds: string[] = [];
    let cancelledSubscriptions = 0;
    const childRouter = t.router({
      link: t.router({
        harness: t.router({
          models: t.procedure
            .input(controlNodeLinkContract.harness.models.input)
            .query(({ ctx, input }) => [{
              harness: input.harness,
              id: ctx.p2p.auth.id,
            }]),
        }),
        events: t.router({
          subscribe: t.procedure
            .input(controlNodeLinkContract.events.subscribe.input)
            .subscription(async function* ({ ctx, input, signal }) {
              subscriptionSessionIds.push(ctx.p2p.auth.id);
              yield {
                kind: "heartbeat" as const,
                feedId: input.cursor.feedId,
                controlCursor: input.cursor.controlCursor,
                authorityRefs: [],
              } satisfies AccessStreamItem;
              if (signal?.aborted) return;
              await new Promise<void>((resolve) => {
                const finish = (): void => resolve();
                signal?.addEventListener("abort", finish, { once: true });
              });
              cancelledSubscriptions += 1;
            }),
        }),
      }),
    });
    const parentRouter = t.router({
      heartbeat: t.procedure.query(({ ctx }) => ({
        authenticatedSessionId: ctx.p2p.auth.id,
      })),
    });
    type TestChildRouter = typeof childRouter;
    type TestParentRouter = typeof parentRouter;
    let parent:
      | MultiplexP2PNode<TestParentRouter, TestChildRouter>
      | undefined;
    let child:
      | MultiplexP2PNode<TestChildRouter, TestParentRouter>
      | undefined;
    let firstIterator: AsyncIterator<AccessStreamItem> | undefined;

    try {
      const sharedSecret = "child-reverse-binding-test-secret".padEnd(64, "x");
      const sessionTtlMs = 800;
      const iroh = {
        relay: { mode: "disabled" as const },
        allowAdvertisedAddress: () => true,
        allowDirectAddress: () => true,
      };
      parent = await createMultiplexP2PNode({
        router: parentRouter,
        sharedSecret: { secret: sharedSecret, sessionTtlMs },
        createContext: (context) => context,
        iroh,
      });
      child = await createMultiplexP2PNode({
        router: childRouter,
        sharedSecret: { secret: sharedSecret, sessionTtlMs },
        createContext: (context) => context,
        iroh,
      });
      const outboundPeer = await child.connect({
        endpointId: parent.id,
        locator: { kind: "ticket", ticket: await parent.createTicket() },
      });
      const firstInboundPeer = await waitForValue(
        () => parent?.getPeerAs<TestChildRouter>(child!.id),
      );
      const binding = {
        controlNodeId: newControlNodeId(),
        controlNodeBootId: newControlNodeBootId(),
        attachmentId: newAttachmentId(),
        lineageId: newLineageId(),
      };
      const connection = childControlNodeConnectionFromPeerResolver(
        child.id,
        () => parent?.getPeerAs<TestChildRouter>(child!.id),
        binding,
        child.id,
      );
      const runtimeNodeId = newRuntimeNodeId();
      const cursor = {
        feedId: newFeedId(),
        controlCursor: 0,
        native: {},
      };

      const firstModels = await connection.listModels(runtimeNodeId, "codex");
      expect(firstModels).toEqual([{
        harness: "codex",
        id: firstInboundPeer.session.id,
      }]);
      firstIterator = connection.subscribeAggregate(cursor)[Symbol.asyncIterator]();
      await expect(firstIterator.next()).resolves.toMatchObject({
        done: false,
        value: { kind: "heartbeat" },
      });
      expect(subscriptionSessionIds).toEqual([firstInboundPeer.session.id]);

      const firstSessionId = firstInboundPeer.session.id;
      for (let generation = 0; generation < 3; generation += 1) {
        const previousSessionId = firstInboundPeer.session.id;
        await expect.poll(() => firstInboundPeer.session.id, {
          timeout: 5_000,
        }).not.toBe(previousSessionId);
        expect(parent.getPeerAs<TestChildRouter>(child.id)?.session).toBe(firstInboundPeer.session);
        const heartbeat = await outboundPeer.rpc.heartbeat.query();
        expect(heartbeat.authenticatedSessionId).toBe(firstInboundPeer.session.id);
        await expect(connection.listModels(runtimeNodeId, "copilot")).resolves.toEqual([{
          harness: "copilot",
          id: firstInboundPeer.session.id,
        }]);
        expect(subscriptionSessionIds).toEqual([firstSessionId]);
      }
      // Cancellation still reaches the original retained subscription.
      await firstIterator.return?.();
      await expect.poll(() => cancelledSubscriptions).toBe(1);
    } finally {
      await Promise.allSettled([
        firstIterator?.return?.(),
      ]);
      await Promise.allSettled([child?.close(), parent?.close()]);
    }
  });

  it("retains one runtime event pump across three auth renewals", {
    timeout: 30_000,
  }, async () => {
    const subscriptionSessionIds: string[] = [];
    let cancelledSubscriptions = 0;
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const sessionId = newSessionId();
    const historyInput = {
      runtimeNodeBootId,
      sessionId,
      request: { harness: "codex" as const, includeTurns: true, limit: 100 },
    };
    const runtimeRouter = t.router({
      sessions: t.router({
        readNativeHistory: t.procedure
          .input(runtimeNodeContract.sessions.readNativeHistory.input)
          .query(({ ctx }) => ({
            harness: "codex" as const,
            vendorSessionId: "native-session",
            payload: { authenticatedSessionId: ctx.p2p.auth.id },
            complete: true,
          })),
      }),
      events: t.router({
        subscribe: t.procedure
          .input(runtimeNodeContract.events.subscribe.input)
          .subscription(async function* ({ ctx, signal }) {
            subscriptionSessionIds.push(ctx.p2p.auth.id);
            yield { kind: "heartbeat" as const };
            if (signal?.aborted) return;
            await new Promise<void>((resolve) => {
              const finish = (): void => resolve();
              signal?.addEventListener("abort", finish, { once: true });
            });
            cancelledSubscriptions += 1;
          }),
      }),
    });
    const controlRouter = t.router({
      heartbeat: t.procedure.query(({ ctx }) => ({
        authenticatedSessionId: ctx.p2p.auth.id,
      })),
    });
    type TestRuntimeRouter = typeof runtimeRouter;
    type TestControlRouter = typeof controlRouter;
    let control:
      | MultiplexP2PNode<TestControlRouter, TestRuntimeRouter>
      | undefined;
    let runtime:
      | MultiplexP2PNode<TestRuntimeRouter, TestControlRouter>
      | undefined;
    let pump: RuntimeNodeEventPump | undefined;

    try {
      const sharedSecret = "dynamic-reverse-binding-test-secret".padEnd(64, "x");
      const sessionTtlMs = 800;
      const iroh = {
        relay: { mode: "disabled" as const },
        allowAdvertisedAddress: () => true,
        allowDirectAddress: () => true,
      };
      control = await createMultiplexP2PNode({
        router: controlRouter,
        sharedSecret: { secret: sharedSecret, sessionTtlMs },
        createContext: (context) => context,
        iroh,
      });
      runtime = await createMultiplexP2PNode({
        router: runtimeRouter,
        sharedSecret: { secret: sharedSecret, sessionTtlMs },
        createContext: (context) => context,
        iroh,
      });
      const outboundPeer = await runtime.connect({
        endpointId: control.id,
        locator: { kind: "ticket", ticket: await control.createTicket() },
      });
      const firstInboundPeer = await waitForValue(
        () => control?.getPeerAs<TestRuntimeRouter>(runtime!.id),
      );
      const connection = new P2PRuntimeNodeConnection(
        newRuntimeNodeId(),
        runtimeNodeBootId,
        runtime.id,
        () =>
          control?.getPeerAs<RuntimeNodeRouter>(runtime!.id),
        runtime.id,
      );
      const firstHistory = await connection.readNativeHistory(
        sessionId,
        historyInput.request,
      );
      const observed: RuntimeNodeEventItem[] = [];
      pump = new RuntimeNodeEventPump({
        connection,
        retryDelayMs: () => 20,
        onItem: (item) => { observed.push(item); },
      });
      pump.start();
      await expect.poll(() => observed.length, { timeout: 5_000 }).toBe(1);
      expect(subscriptionSessionIds).toEqual([firstInboundPeer.session.id]);

      const firstSessionId = firstInboundPeer.session.id;
      expect(firstHistory.payload).toEqual({ authenticatedSessionId: firstSessionId });
      for (let generation = 0; generation < 3; generation += 1) {
        const previousSessionId = firstInboundPeer.session.id;
        await expect.poll(() => firstInboundPeer.session.id, {
          timeout: 5_000,
        }).not.toBe(previousSessionId);
        expect(control.getPeerAs<TestRuntimeRouter>(runtime.id)?.session).toBe(firstInboundPeer.session);
        const heartbeat = await outboundPeer.rpc.heartbeat.query();
        expect(heartbeat.authenticatedSessionId).toBe(firstInboundPeer.session.id);
        await expect(connection.readNativeHistory(sessionId, historyInput.request))
          .resolves.toMatchObject({
            payload: { authenticatedSessionId: firstInboundPeer.session.id },
          });
        expect(observed).toEqual([{ kind: "heartbeat" }]);
        expect(subscriptionSessionIds).toEqual([firstSessionId]);
      }
      pump.stop();
      await expect.poll(() => cancelledSubscriptions).toBe(1);
    } finally {
      pump?.stop();
      await Promise.allSettled([runtime?.close(), control?.close()]);
    }
  });
});

async function waitForValue<T>(
  read: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for live authenticated peer");
}
