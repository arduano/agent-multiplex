import {
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
  it("uses the replacement child-control Peer for unary RPC and subscription restart after session expiry", {
    timeout: 30_000,
  }, async () => {
    const subscriptionSessionIds: string[] = [];
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
    let secondIterator: AsyncIterator<AccessStreamItem> | undefined;

    try {
      const sharedSecret = "child-reverse-binding-test-secret".padEnd(64, "x");
      const sessionTtlMs = 1_500;
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
        locator: { kind: "ticket", ticket: parent.ticket() },
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

      await expect.poll(
        () => parent?.getPeerAs<TestChildRouter>(child!.id),
        { timeout: 10_000 },
      ).toBeUndefined();
      await expect(
        firstInboundPeer.rpc.link.harness.models.query({
          ...binding,
          runtimeNodeId,
          harness: "codex",
        }),
      ).rejects.toMatchObject({ cause: { code: "DISCONNECTED" } });

      // The child owns the outbound route. Its next parent-directed RPC
      // performs a fresh handshake and publishes the replacement inbound Peer.
      const heartbeat = await outboundPeer.rpc.heartbeat.query();
      const secondInboundPeer = await waitForValue(
        () => parent?.getPeerAs<TestChildRouter>(child!.id),
      );
      expect(secondInboundPeer).not.toBe(firstInboundPeer);
      expect(secondInboundPeer.session.id).not.toBe(firstInboundPeer.session.id);
      expect(heartbeat.authenticatedSessionId).toBe(secondInboundPeer.session.id);

      const secondModels = await connection.listModels(runtimeNodeId, "copilot");
      expect(secondModels).toEqual([{
        harness: "copilot",
        id: secondInboundPeer.session.id,
      }]);
      secondIterator = connection.subscribeAggregate(cursor)[Symbol.asyncIterator]();
      await expect(secondIterator.next()).resolves.toMatchObject({
        done: false,
        value: { kind: "heartbeat" },
      });
      expect(subscriptionSessionIds).toEqual([
        firstInboundPeer.session.id,
        secondInboundPeer.session.id,
      ]);
    } finally {
      await Promise.allSettled([
        firstIterator?.return?.(),
        secondIterator?.return?.(),
      ]);
      await Promise.allSettled([child?.close(), parent?.close()]);
    }
  });

  it("uses the replacement inbound Peer for unary RPC and event-pump retry after session expiry", {
    timeout: 30_000,
  }, async () => {
    const subscriptionSessionIds: string[] = [];
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const sessionId = newSessionId();
    const historyInput = {
      runtimeNodeBootId,
      sessionId,
      request: { harness: "codex" as const, includeTurns: true },
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
      const sessionTtlMs = 1_500;
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
        locator: { kind: "ticket", ticket: control.ticket() },
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

      await expect.poll(
        () => control?.getPeerAs<TestRuntimeRouter>(runtime!.id),
        { timeout: 10_000 },
      ).toBeUndefined();
      await expect(
        firstInboundPeer.rpc.sessions.readNativeHistory.query(historyInput),
      ).rejects.toMatchObject({ cause: { code: "DISCONNECTED" } });

      // The runtime owns the outbound route, so this operation performs the
      // fresh handshake and publishes a new inbound Peer on the control node.
      const heartbeat = await outboundPeer.rpc.heartbeat.query();
      const secondInboundPeer = await waitForValue(
        () => control?.getPeerAs<TestRuntimeRouter>(runtime!.id),
      );
      expect(secondInboundPeer).not.toBe(firstInboundPeer);
      expect(secondInboundPeer.session.id).not.toBe(firstInboundPeer.session.id);
      expect(heartbeat.authenticatedSessionId).toBe(secondInboundPeer.session.id);

      const secondHistory = await connection.readNativeHistory(
        sessionId,
        historyInput.request,
      );
      expect(firstHistory.payload).toEqual({
        authenticatedSessionId: firstInboundPeer.session.id,
      });
      expect(secondHistory.payload).toEqual({
        authenticatedSessionId: secondInboundPeer.session.id,
      });
      await expect.poll(() => observed.length, { timeout: 5_000 }).toBe(2);
      expect(subscriptionSessionIds).toEqual([
        firstInboundPeer.session.id,
        secondInboundPeer.session.id,
      ]);
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
