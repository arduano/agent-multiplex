import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  newAuthorityEpochId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newRealmId,
} from "@arduano/agent-multiplex-protocol";

const transport = vi.hoisted(() => ({ createNode: vi.fn() }));

vi.mock("@arduano/agent-multiplex-transport-p2prpc", () => ({
  createMultiplexP2PNode: transport.createNode,
}));

import { P2PControlNodeSourceClient } from "../src/control-node-source.js";
import {
  createP2PAccessGatewayNode,
  p2pAccessGatewayRouter,
} from "../src/p2p.js";

const targets = [
  {
    endpointId: "pinned-control-node-a",
    locator: { kind: "ticket", ticket: "untrusted-a" } as const,
  },
  {
    endpointId: "pinned-control-node-b",
    locator: { kind: "ticket", ticket: "untrusted-b" } as const,
  },
] as const;

describe("p2prpc access-gateway node", () => {
  beforeEach(() => transport.createNode.mockReset());

  it("uses one empty local router for independently pinned control-node sources", async () => {
    const peers = new Map(targets.map((target) => [target.endpointId, fakePeer(target.endpointId)]));
    const node = fakeNode(peers);
    transport.createNode.mockResolvedValue(node);

    const handle = await createP2PAccessGatewayNode({
      sources: targets.map((target, index) => ({
        sourceId: `source-${index}`,
        target,
        requestedScopes: ["read", "agent-control"],
      })),
      sharedSecret: { secret: "x".repeat(32) },
    });

    const options = transport.createNode.mock.calls[0]?.[0];
    expect(options.router).toBe(p2pAccessGatewayRouter);
    expect(Object.keys(p2pAccessGatewayRouter._def.procedures)).toEqual([]);
    expect(options.preAuthorizePeer({ id: targets[0].endpointId })).toBe(true);
    expect(options.preAuthorizePeer({ id: targets[1].endpointId })).toBe(true);
    expect(options.preAuthorizePeer({ id: "unconfigured" })).toBe(false);

    const connected = await handle.connectAll();
    expect([...connected.values()].map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(node.ensureConnectedAs).toHaveBeenCalledTimes(2);
    for (const peer of peers.values()) {
      expect(peer.enroll).toHaveBeenCalledWith({
        name: expect.stringMatching(/^agent-multiplex-gateway:source-/),
        protocolVersion: 4,
        requestedScopes: ["read", "agent-control"],
      });
    }
    expect(handle.localEndpointId).toBe("stable-access-gateway-endpoint");
    await handle.close();
    expect(node.close).toHaveBeenCalledOnce();
  });

  it("rejects a pinned peer that describes itself as an access gateway", async () => {
    const peer = fakePeer(targets[0].endpointId, "access-gateway");
    const node = fakeNode(new Map([[targets[0].endpointId, peer]]));
    transport.createNode.mockResolvedValue(node);
    const handle = await createP2PAccessGatewayNode({
      sources: [{
        sourceId: "bad-source",
        target: targets[0],
        requestedScopes: ["read"],
      }],
      sharedSecret: { secret: "x".repeat(32) },
    });

    await expect(handle.sources.get("bad-source")!.connect()).rejects.toThrow(
      /not a protocol-v4 control-node source/,
    );
    await handle.close();
  });

  it("falls back from a stale renewal to bootstrap reachability for the same pin", async () => {
    const peer = fakePeer(targets[0].endpointId);
    const node = fakeNode(new Map([[targets[0].endpointId, peer]]));
    node.ensureConnectedAs.mockImplementation(
      (target: { endpointId: string; locator: { kind: string; ticket?: string } }) => {
        if (target.locator.ticket === "expired-renewal") {
          return Promise.reject(new Error("dial failed"));
        }
        return Promise.resolve(peer);
      },
    );
    transport.createNode.mockResolvedValue(node);
    const handle = await createP2PAccessGatewayNode({
      sources: [{
        sourceId: "fallback-source",
        target: {
          endpointId: targets[0].endpointId,
          locator: { kind: "ticket", ticket: "expired-renewal" },
        },
        fallbackLocator: { kind: "ticket", ticket: "bootstrap" },
        requestedScopes: ["read"],
      }],
      sharedSecret: { secret: "x".repeat(32) },
    });

    const connected = await handle.sources.get("fallback-source")!.connect();
    expect(node.ensureConnectedAs.mock.calls.map(([target]) => target.locator.ticket))
      .toEqual(["expired-renewal", "bootstrap"]);
    expect(connected.target).toEqual({
      endpointId: targets[0].endpointId,
      locator: { kind: "ticket", ticket: "bootstrap" },
    });
    expect(handle.sources.get("fallback-source")!.target).toEqual(connected.target);
    await handle.close();
  });

  it("uses only a replacement peer after one source fails without disturbing its sibling", async () => {
    const firstPeer = fakePeer(targets[0].endpointId, "control-node", 3);
    const replacementPeer = fakePeer(targets[0].endpointId, "control-node", 9);
    const siblingPeer = fakePeer(targets[1].endpointId, "control-node", 4);
    const firstFailure = new Error("first source stream failed");
    firstPeer.accessMocks.watchSubscribe.mockImplementation((
      _input: unknown,
      observer: { onError(cause: unknown): void },
    ) => {
      observer.onError(firstFailure);
      return { unsubscribe: vi.fn() };
    });
    replacementPeer.accessMocks.watchSubscribe.mockImplementation((
      _input: unknown,
      observer: { onData(item: unknown): void },
    ) => {
      observer.onData({
        kind: "heartbeat",
        feedId: replacementPeer.snapshot.source.manifest.feedId,
        controlCursor: replacementPeer.snapshot.source.manifest.controlCursor,
        authorityRefs: [replacementPeer.snapshot.source.manifest.authority],
      });
      return { unsubscribe: vi.fn() };
    });
    let primaryConnections = 0;
    const node = fakeNode(new Map([[targets[1].endpointId, siblingPeer]]));
    node.ensureConnectedAs.mockImplementation((target: { endpointId: string }) => {
      if (target.endpointId === targets[0].endpointId) {
        primaryConnections += 1;
        return Promise.resolve(primaryConnections === 1 ? firstPeer : replacementPeer);
      }
      if (target.endpointId === targets[1].endpointId) return Promise.resolve(siblingPeer);
      return Promise.reject(new Error("dial failed"));
    });
    transport.createNode.mockResolvedValue(node);
    const handle = await createP2PAccessGatewayNode({
      sources: [
        {
          sourceId: "reconnecting-source",
          target: targets[0],
          requestedScopes: ["read"],
        },
        {
          sourceId: "sibling-source",
          target: targets[1],
          requestedScopes: ["read"],
        },
      ],
      sharedSecret: { secret: "x".repeat(32) },
    });
    const source = handle.sources.get("reconnecting-source")!;
    const sibling = handle.sources.get("sibling-source")!;
    const client = new P2PControlNodeSourceClient(source);

    const first = await source.connect();
    const siblingConnection = await sibling.connect();
    await expect(client.loadSnapshot()).resolves.toMatchObject({
      manifest: { controlCursor: 3 },
    });
    const failedWatch = client.watch({
      feedId: firstPeer.snapshot.source.manifest.feedId,
      controlCursor: firstPeer.snapshot.source.manifest.controlCursor,
      native: {},
    })[Symbol.asyncIterator]();
    await expect(failedWatch.next()).rejects.toBe(firstFailure);

    const second = await source.reconnect();

    expect(first.sourceId).toBe(second.sourceId);
    expect(first).not.toBe(second);
    expect(firstPeer).not.toBe(replacementPeer);
    expect(firstPeer.rpc).not.toBe(replacementPeer.rpc);
    expect(first.access).toBe(firstPeer.rpc.access);
    expect(second.access).toBe(replacementPeer.rpc.access);
    expect(first.access).not.toBe(second.access);

    await expect(client.loadSnapshot()).resolves.toMatchObject({
      manifest: { controlCursor: 9 },
    });
    await expect(client.listHarnessCatalog()).resolves.toEqual([]);
    const replacementWatch = client.watch({
      feedId: replacementPeer.snapshot.source.manifest.feedId,
      controlCursor: replacementPeer.snapshot.source.manifest.controlCursor,
      native: {},
    })[Symbol.asyncIterator]();
    await expect(replacementWatch.next()).resolves.toMatchObject({
      value: {
        kind: "heartbeat",
        feedId: replacementPeer.snapshot.source.manifest.feedId,
        controlCursor: 9,
      },
      done: false,
    });
    await replacementWatch.return?.();

    expect(firstPeer.accessMocks.snapshotQuery).toHaveBeenCalledTimes(1);
    expect(firstPeer.accessMocks.watchSubscribe).toHaveBeenCalledTimes(1);
    expect(firstPeer.accessMocks.harnessCatalogQuery).not.toHaveBeenCalled();
    expect(replacementPeer.accessMocks.snapshotQuery).toHaveBeenCalledTimes(1);
    expect(replacementPeer.accessMocks.watchSubscribe).toHaveBeenCalledTimes(1);
    expect(replacementPeer.accessMocks.harnessCatalogQuery).toHaveBeenCalledTimes(1);
    expect(source.connected).toBe(second);
    expect(sibling.connected).toBe(siblingConnection);
    expect(siblingPeer.enroll).toHaveBeenCalledOnce();
    expect(siblingPeer.accessMocks.snapshotQuery).not.toHaveBeenCalled();
    expect(node.ensureConnectedAs).toHaveBeenCalledTimes(3);
    await handle.close();
  });

  it("does not use bootstrap after a connected peer fails role validation", async () => {
    const peer = fakePeer(targets[0].endpointId, "access-gateway");
    const node = fakeNode(new Map([[targets[0].endpointId, peer]]));
    transport.createNode.mockResolvedValue(node);
    const handle = await createP2PAccessGatewayNode({
      sources: [{
        sourceId: "wrong-role",
        target: targets[0],
        fallbackLocator: { kind: "ticket", ticket: "bootstrap" },
        requestedScopes: ["read"],
      }],
      sharedSecret: { secret: "x".repeat(32) },
    });

    await expect(handle.sources.get("wrong-role")!.connect()).rejects.toThrow(
      /not a protocol-v4 control-node source/,
    );
    expect(node.ensureConnectedAs).toHaveBeenCalledOnce();
    await handle.close();
  });

  it("rejects duplicate source and pinned endpoint identities", async () => {
    transport.createNode.mockResolvedValue(fakeNode(new Map()));
    await expect(createP2PAccessGatewayNode({
      sources: [
        { sourceId: "same", target: targets[0], requestedScopes: ["read"] },
        { sourceId: "same", target: targets[1], requestedScopes: ["read"] },
      ],
      sharedSecret: { secret: "x".repeat(32) },
    })).rejects.toThrow(/duplicate or empty gateway source ID/);
    expect(transport.createNode).not.toHaveBeenCalled();

    await expect(createP2PAccessGatewayNode({
      sources: [
        { sourceId: "a", target: targets[0], requestedScopes: ["read"] },
        { sourceId: "b", target: targets[0], requestedScopes: ["read"] },
      ],
      sharedSecret: { secret: "x".repeat(32) },
    })).rejects.toThrow(/duplicate pinned control-node endpoint/);
    expect(transport.createNode).not.toHaveBeenCalled();
  });
});

function fakePeer(
  endpointId: string,
  componentKind: "control-node" | "access-gateway" = "control-node",
  controlCursor = 0,
) {
  const controlNodeId = newControlNodeId();
  const authority = {
    realmId: newRealmId(),
    controlNodeId,
    epochId: newAuthorityEpochId(),
  };
  const canonical = {
    controlNodeId,
    controlNodeBootId: newControlNodeBootId(),
    feedId: newFeedId(),
    name: endpointId,
    endpointId,
    presence: "online",
    dataRole: { role: "authority", authority },
    connectedAt: null,
    lastHeartbeatAt: null,
    protocolVersion: 4,
    capabilities: [],
  };
  const enroll = vi.fn().mockResolvedValue({
    accepted: true,
    canonical,
    grantedScopes: ["read", "agent-control"],
  });
  const snapshot = {
    source: {
      manifest: {
        componentKind: "control-node" as const,
        protocolVersion: 4 as const,
        sourceControlNodeId: controlNodeId,
        sourceControlNodeBootId: canonical.controlNodeBootId,
        authority,
        projectionRootControlNodeId: controlNodeId,
        coveredControlNodeIds: [controlNodeId],
        feedId: canonical.feedId,
        controlCursor,
        generatedAt: "2026-09-03T00:00:00.000Z",
        capabilities: [],
      },
      parentByControlNodeId: { [controlNodeId]: null },
    },
    capturedAt: "2026-09-03T00:00:00.000Z",
    controlNodes: [canonical],
    runtimeNodes: [],
    sessions: [],
    interactions: [],
    metadataOperations: [],
  };
  const snapshotQuery = vi.fn().mockResolvedValue(snapshot);
  const watchSubscribe = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
  const harnessCatalogQuery = vi.fn().mockResolvedValue([]);
  return {
    enroll,
    snapshot,
    accessMocks: {
      snapshotQuery,
      watchSubscribe,
      harnessCatalogQuery,
    },
    rpc: {
      ingress: { gateways: { enroll: { mutate: enroll } } },
      access: {
        system: {
          describe: {
            query: vi.fn().mockResolvedValue({
              application: "agent-multiplex",
              protocolVersion: 4,
              instanceId: endpointId,
              componentKind,
              dataAuthority: componentKind === "control-node" ? "control-node" : "none",
              capabilities: [],
            }),
          },
        },
        sources: { snapshot: { query: snapshotQuery } },
        sessions: { watch: { subscribe: watchSubscribe } },
        harness: { catalog: { query: harnessCatalogQuery } },
      },
    },
  };
}

function fakeNode(peers: ReadonlyMap<string, unknown>) {
  return {
    id: "stable-access-gateway-endpoint",
    ensureConnectedAs: vi.fn((target: { endpointId: string }) => {
      const peer = peers.get(target.endpointId);
      return peer ? Promise.resolve(peer) : Promise.reject(new Error("dial failed"));
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
