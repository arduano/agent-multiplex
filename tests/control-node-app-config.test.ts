import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlNodeCatalog } from "@arduano/agent-multiplex-control-node-core";
import {
  newControlNodeId,
} from "@arduano/agent-multiplex-protocol";
import {
  TRPC_HTTP_BODY_LIMIT_BYTES,
  WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES,
  WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES,
} from "@arduano/agent-multiplex-web";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  controlNodeConfigFromEnvironment,
  parseDesiredControlNodeUpstream,
} from "../apps/control-node/src/config.js";
import { createControlNodeHttpSurface } from "../apps/control-node/src/http.js";

const secret = "control-node-test-secret-that-is-long-enough";

describe("protocol-v4 control-node application configuration", () => {
  it("uses role-specific names and rejects every removed v2 variable", () => {
    const configured = controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_CONTROL_NODE_NAME: "local-authority",
      AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND: "127.0.0.2",
      AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND: "0.0.0.0:49117",
      AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT: "1",
    });
    expect(configured).toMatchObject({
      name: "local-authority",
      bindAddress: "127.0.0.2",
      p2pBindAddress: "0.0.0.0:49117",
      enrollment: {
        runtimeNodes: true,
        childControlNodes: false,
        accessGateways: false,
        accessGatewayScopes: ["read"],
      },
    });

    const scoped = controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES:
        '["read","agent-control","metadata-propose"]',
    });
    expect(scoped.enrollment.accessGatewayScopes).toEqual([
      "read",
      "agent-control",
      "metadata-propose",
    ]);
    expect(() => controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES: '["root"]',
    })).toThrow();

    expect(() => controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_HOST_STATE: "legacy.sqlite",
    })).toThrow(
      "AGENT_MULTIPLEX_HOST_STATE is a removed protocol-v2 environment variable",
    );
    expect(() => controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_ALLOW_ENROLLMENT: "1",
    })).toThrow(
      "AGENT_MULTIPLEX_ALLOW_ENROLLMENT is a removed protocol-v2 environment variable",
    );
  });

  it("rejects unauthenticated non-loopback HTTP listeners", () => {
    for (const bind of ["0.0.0.0", "::", "localhost", "192.168.1.10"]) {
      expect(() => controlNodeConfigFromEnvironment({
        AGENT_MULTIPLEX_SHARED_SECRET: secret,
        AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND: bind,
      })).toThrow("may bind only to an explicit loopback IP address");
    }
    expect(() => controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND: "::1",
    })).not.toThrow();
  });

  it("validates the optional stable p2p listener as an explicit IP and port", () => {
    for (const bind of [
      "localhost:49117",
      "0.0.0.0",
      "0.0.0.0:0",
      "0.0.0.0:65536",
      "::1:49117",
    ]) {
      expect(() => controlNodeConfigFromEnvironment({
        AGENT_MULTIPLEX_SHARED_SECRET: secret,
        AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND: bind,
      })).toThrow("must be an explicit IP:port");
    }
    expect(controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND: "[::]:49117",
    }).p2pBindAddress).toBe("[::]:49117");
  });

  it("requires independently pinned logical and transport upstream identities", () => {
    expect(() => controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ENDPOINT_ID: "endpoint-only",
      AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_TICKET: "ticket-only",
    })).toThrow("_UPSTREAM_ID, _ENDPOINT_ID, and _TICKET must be set together");

    const parentId = newControlNodeId();
    expect(controlNodeConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: secret,
      AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ID: parentId,
      AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ENDPOINT_ID: "pinned-endpoint",
      AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_TICKET: "reachability-ticket",
    }).bootstrapUpstream).toEqual({
      version: 1,
      controlNodeId: parentId,
      endpointId: "pinned-endpoint",
      locator: { kind: "ticket", ticket: "reachability-ticket" },
    });
  });

  it("keeps the durable desired upstream authoritative over stale environment bootstrap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-multiplex-control-app-"));
    const filename = join(directory, "catalog.sqlite");
    const parentA = newControlNodeId();
    const parentB = newControlNodeId();
    const first = {
      version: 1 as const,
      controlNodeId: parentA,
      endpointId: "parent-a-endpoint",
      locator: { kind: "ticket" as const, ticket: "parent-a-ticket" },
    };
    const staleEnvironment = {
      version: 1 as const,
      controlNodeId: parentB,
      endpointId: "stale-parent-endpoint",
      locator: { kind: "ticket" as const, ticket: "stale-parent-ticket" },
    };
    try {
      const catalog = new ControlNodeCatalog({ filename });
      expect(catalog.bootstrapDesiredUpstream(first)).toBe(true);
      expect(parseDesiredControlNodeUpstream(catalog.desiredUpstream()!))
        .toEqual(first);

      // Explicit topology actions clear the value but retain the initialized
      // marker. A process restart with an old environment cannot resurrect it.
      catalog.setDesiredUpstream(null);
      catalog.close();

      const restarted = new ControlNodeCatalog({ filename });
      expect(restarted.bootstrapDesiredUpstream(staleEnvironment)).toBe(false);
      expect(restarted.desiredUpstream()).toBeNull();
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed persisted upstream settings before dialing", () => {
    expect(() => parseDesiredControlNodeUpstream({
      version: 1,
      controlNodeId: newControlNodeId(),
      endpointId: "endpoint",
      locator: { kind: "ticket", ticket: "" },
    })).toThrow("ticket must not be empty");
    expect(() => parseDesiredControlNodeUpstream({
      version: 1,
      controlNodeId: newControlNodeId(),
      endpointId: "endpoint",
      locator: { kind: "proxy" },
    })).toThrow("locator kind is invalid");
  });

  it("serves the v4 access API on its explicit trusted-local edge", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-multiplex-control-http-"));
    const catalog = new ControlNodeCatalog({ filename: join(directory, "catalog.sqlite") });
    const { ControlNodeService } = await import("@arduano/agent-multiplex-control-node-core");
    const service = new ControlNodeService({ catalog, instanceId: "http-test" });
    const surface = createControlNodeHttpSurface(service);
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        surface.server.once("error", rejectListen);
        surface.server.listen(0, "127.0.0.1", resolveListen);
      });
      const { port } = surface.server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/trpc/system.describe`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      await expect(response.json()).resolves.toMatchObject({
        result: { data: {
          protocolVersion: 5,
          componentKind: "control-node",
          dataAuthority: "control-node",
        } },
      });
      const dashboard = await fetch(`http://127.0.0.1:${port}/`);
      const dashboardPolicy = dashboard.headers.get("content-security-policy");
      expect(dashboardPolicy).toContain("default-src 'self'");
      expect(dashboardPolicy).toContain("script-src 'self'");
      expect(dashboardPolicy).toContain("style-src-elem 'self'");
      expect(dashboardPolicy).not.toContain("sha256-");
      expect(dashboardPolicy).toContain("style-src-attr 'unsafe-inline'");
      expect(dashboardPolicy).not.toContain("script-src 'unsafe-inline'");
      const dashboardBody = await dashboard.text();
      expect(dashboardBody).toContain("Agent Multiplex");
      const styleNonce = dashboardBody.match(
        /<meta name="agent-multiplex-style-nonce" content="([A-Za-z0-9_-]+)"/,
      )?.[1];
      expect(styleNonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
      expect(dashboardPolicy).toContain(`'nonce-${styleNonce}'`);
      const assetPath = dashboardBody.match(
        /(?:src|href)="(\/assets\/[^"]+)"/,
      )?.[1];
      expect(assetPath).toBeDefined();
      const asset = await fetch(`http://127.0.0.1:${port}${assetPath}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");

      const oversizedHttp = await fetch(
        `http://127.0.0.1:${port}/trpc/sessions.refresh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.alloc(TRPC_HTTP_BODY_LIMIT_BYTES + 1),
        },
      );
      expect(oversizedHttp.status).toBe(413);

      const healthyHttp = await fetch(
        `http://127.0.0.1:${port}/trpc/system.describe`,
      );
      expect(healthyHttp.status).toBe(200);
      await expect(healthyHttp.json()).resolves.toMatchObject({
        result: { data: { componentKind: "control-node" } },
      });

      const websocketUrl = `ws://127.0.0.1:${port}/trpc`;
      const healthy = new WebSocket(websocketUrl);
      await opened(healthy);
      const healthyResponse = nextFrame(healthy);
      healthy.send(JSON.stringify({
        id: 1,
        method: "query",
        params: { path: "system.describe" },
      }));
      await expect(healthyResponse).resolves.toMatchObject({
        result: { data: { componentKind: "control-node" } },
      });
      const healthyClosed = closed(healthy);
      healthy.terminate();
      await healthyClosed;

      const slow = new WebSocket(websocketUrl);
      await opened(slow);
      const slowServerSocket = onlyOpenServerSocket(surface);
      Object.defineProperty(slowServerSocket, "bufferedAmount", {
        configurable: true,
        value: WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES,
      });
      const slowClosed = closed(slow);
      slow.send(JSON.stringify({
        id: 2,
        method: "query",
        params: { path: "system.describe" },
      }));
      await expect(slowClosed).resolves.toBe(1006);

      const oversizedInbound = new WebSocket(websocketUrl);
      await opened(oversizedInbound);
      const oversizedInboundClosed = closed(oversizedInbound);
      oversizedInbound.send(
        Buffer.alloc(WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES + 1),
      );
      await expect(oversizedInboundClosed).resolves.toBe(1009);

      const healthyAfterOverflow = new WebSocket(websocketUrl);
      await opened(healthyAfterOverflow);
      const healthyAfterOverflowResponse = nextFrame(healthyAfterOverflow);
      healthyAfterOverflow.send(JSON.stringify({
        id: 3,
        method: "query",
        params: { path: "system.describe" },
      }));
      await expect(healthyAfterOverflowResponse).resolves.toMatchObject({
        result: { data: { componentKind: "control-node" } },
      });
      const healthyAfterOverflowClosed = closed(healthyAfterOverflow);
      healthyAfterOverflow.terminate();
      await healthyAfterOverflowClosed;
    } finally {
      await surface.close();
      service.close();
      catalog.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

interface WireFrame {
  readonly result?: { readonly data?: unknown };
  readonly error?: unknown;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("close", resolve);
    socket.once("error", reject);
  });
}

function nextFrame(socket: WebSocket): Promise<WireFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      if (data.toString() === "PING") {
        socket.send("PONG");
        return;
      }
      cleanup();
      try {
        resolve(JSON.parse(data.toString()) as WireFrame);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function onlyOpenServerSocket(
  surface: ReturnType<typeof createControlNodeHttpSurface>,
): WebSocket {
  const sockets = [...surface.webSockets.clients].filter(
    (socket) => socket.readyState === WebSocket.OPEN,
  );
  expect(sockets).toHaveLength(1);
  return sockets[0]!;
}
