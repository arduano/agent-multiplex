import { initTRPC } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ createP2PNode: vi.fn() }));

vi.mock("@arduano/p2prpc-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@arduano/p2prpc-core")>(),
  createP2PNode: core.createP2PNode,
}));

import {
  DEFAULT_MULTIPLEX_P2P_LIMITS,
  createControlNodeP2PNode,
  createMultiplexP2PNode,
} from "../src/node.js";

const emptyRouter = initTRPC.create().router({});
const target = {
  endpointId: "pinned-peer",
  locator: { kind: "ticket", ticket: "route-only" } as const,
};

describe("heterogeneous p2prpc nodes", () => {
  beforeEach(() => core.createP2PNode.mockReset());

  it("delegates role-specific connect, reconnect, lookup, and notifications", async () => {
    const peer = { rpc: {} };
    const raw = {
      id: "local-endpoint",
      connect: vi.fn().mockResolvedValue(peer),
      getPeer: vi.fn().mockReturnValue(peer),
      ticket: vi.fn(),
      createTicket: vi.fn(),
      peersSnapshot: vi.fn(),
      close: vi.fn(),
    };
    core.createP2PNode.mockResolvedValue(raw);
    const onPeer = vi.fn();
    const onAnyPeer = vi.fn();
    const node = await createMultiplexP2PNode({
      router: emptyRouter,
      sharedSecret: { secret: "x".repeat(32) },
      onPeer,
      onAnyPeer,
    });

    const configured = core.createP2PNode.mock.calls[0]?.[0];
    configured.onPeer(peer);
    expect(onPeer).toHaveBeenCalledWith(peer);
    expect(onAnyPeer).toHaveBeenCalledWith(peer);
    expect(configured.limits).toEqual(DEFAULT_MULTIPLEX_P2P_LIMITS);

    await node.connectAs(target);
    await node.ensureConnectedAs(target);
    expect(raw.connect).toHaveBeenCalledTimes(2);
    expect(raw.connect).toHaveBeenNthCalledWith(1, {
      expectedPeerId: target.endpointId,
      expectedPrincipal: {
        id: target.endpointId,
        subject: target.endpointId,
        issuer: null,
        clientId: null,
        tenantId: null,
      },
      locator: target.locator,
    });
    expect(node.getPeerAs(target.endpointId)).toBe(peer);
    expect(raw.getPeer).toHaveBeenCalledWith(target.endpointId);
  });

  it("merges bounded Fleet-concurrency limits with caller overrides", async () => {
    core.createP2PNode.mockResolvedValue({
      id: "local-endpoint",
      connect: vi.fn(),
      getPeer: vi.fn(),
      ticket: vi.fn(),
      createTicket: vi.fn(),
      peersSnapshot: vi.fn(),
      close: vi.fn(),
    });

    await createMultiplexP2PNode({
      router: emptyRouter,
      sharedSecret: { secret: "x".repeat(32) },
      limits: { maxInboundStreams: 384, streamIdleTimeoutMs: 45_000 },
    });

    expect(core.createP2PNode.mock.calls[0]?.[0].limits).toEqual({
      ...DEFAULT_MULTIPLEX_P2P_LIMITS,
      maxInboundStreams: 384,
      streamIdleTimeoutMs: 45_000,
    });
  });

  it("requires a control-node endpoint authorization callback", () => {
    expect(() => createControlNodeP2PNode({
      router: emptyRouter,
      sharedSecret: { secret: "x".repeat(32) },
    })).toThrow(/authorizePeerEndpoint is required/);
  });
});
