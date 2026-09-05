import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { accessStreamItemSchema } from "@arduano/agent-multiplex-protocol";
import {
  TRPC_HTTP_BODY_LIMIT_BYTES,
  WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES,
  WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES,
} from "@arduano/agent-multiplex-web";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { createGatewayHttpSurface } from "../apps/gateway/src/http.js";
import {
  gatewayConfigFromEnvironment,
  loadOrCreateGatewaySecretKey,
} from "../apps/gateway/src/main.js";

describe("edge gateway", () => {
  it("uses loopback defaults and persists a private observer identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-multiplex-gateway-"));
    const identityPath = join(directory, "observer.identity");
    try {
      const config = gatewayConfigFromEnvironment({
        AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
        AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES: JSON.stringify({
          version: 1,
          sources: [{
            sourceId: "root",
            displayName: "Root",
            endpointId: "pinned-control-node",
            locator: { kind: "ticket", ticket: "reachability-only" },
          }],
        }),
        AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY: identityPath,
      });
      expect(config).toMatchObject({
        bindAddress: "127.0.0.1",
        port: 4318,
        identityPath,
        sources: [{
          sourceId: "root",
          displayName: "Root",
          endpointId: "pinned-control-node",
          priority: 0,
          enabled: true,
          requestedScopes: ["read"],
        }],
      });

      const first = await loadOrCreateGatewaySecretKey(identityPath);
      const second = await loadOrCreateGatewaySecretKey(identityPath);
      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
      expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects v2 singular sources and requires auth for public binds", async () => {
    expect(() => gatewayConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
      AGENT_MULTIPLEX_HOST_ENDPOINT_ID: "legacy",
      AGENT_MULTIPLEX_HOST_TICKET: "legacy",
    })).toThrow(/removed protocol-v2 environment variable/);

    expect(() => gatewayConfigFromEnvironment({
      AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
      AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES: JSON.stringify({
        version: 1,
        sources: [{
          sourceId: "root",
          endpointId: "pinned",
          locator: { kind: "ticket", ticket: "locator" },
        }],
      }),
      AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND: "0.0.0.0",
    })).toThrow(/only to an explicit loopback IP address/);

    const directory = await mkdtemp(join(tmpdir(), "agent-multiplex-gateway-auth-"));
    try {
      const tokenPath = join(directory, "gateway.token");
      await writeFile(tokenPath, "public-gateway-test-token\n", { mode: 0o600 });
      expect(gatewayConfigFromEnvironment({
        AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
        AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES: JSON.stringify({
          version: 1,
          sources: [{
            sourceId: "root",
            endpointId: "pinned",
            locator: { kind: "ticket", ticket: "locator" },
          }],
        }),
        AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND: "0.0.0.0",
        AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE: tokenPath,
      })).toMatchObject({
        bindAddress: "0.0.0.0",
        auth: { bearerToken: "public-gateway-test-token", scopes: ["read"] },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards HTTP queries and serves the reference dashboard", async () => {
    const surface = createGatewayHttpSurface(new AccessGatewayProjection([]), {
      instanceId: "test-access-gateway",
    });
    await listen(surface);

    try {
      const baseUrl = httpUrl(surface);
      const response = await fetch(`${baseUrl}/trpc/system.describe`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: { data: {
          instanceId: "test-access-gateway",
          protocolVersion: 5,
          componentKind: "access-gateway",
          dataAuthority: "none",
        } },
      });

      const dashboard = await fetch(baseUrl);
      expect(dashboard.headers.get("content-type")).toContain("text/html");
      expect(dashboard.headers.get("cache-control")).toBe("no-store");
      const dashboardPolicy = dashboard.headers.get("content-security-policy");
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
      const asset = await fetch(`${baseUrl}${assetPath}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect(asset.headers.get("content-type")).toMatch(
        /(?:javascript|text\/css)/,
      );
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);

      const head = await fetch(`${baseUrl}${assetPath}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
      expect((await head.arrayBuffer()).byteLength).toBe(0);

      const missing = await fetch(`${baseUrl}/assets/not-a-build-artifact.js`);
      expect(missing.status).toBe(404);
      const traversal = await fetch(`${baseUrl}/assets/%2e%2e%2fpackage.json`);
      expect(traversal.status).toBe(404);
    } finally {
      await surface.close();
    }
  });

  it("forwards WebSocket subscription data and unsubscribe", async () => {
    const projection = new AccessGatewayProjection([]);
    const surface = createGatewayHttpSurface(projection);
    await listen(surface);
    const socket = new WebSocket(webSocketUrl(surface));

    try {
      await opened(socket);
      const dataFrame = messageMatching(
        socket,
        (frame) => frame.result?.type === "data",
      );
      socket.send(JSON.stringify({
        id: 1,
        method: "subscription",
        params: {
          path: "sessions.watch",
          input: { sessions: "all", includeNative: true },
        },
      }));
      const data = await dataFrame;
      expect(accessStreamItemSchema.parse(data.result?.data)).toMatchObject({
        kind: "heartbeat",
        controlCursor: 0,
        authorityRefs: [],
      });

      socket.send(JSON.stringify({ id: 1, method: "subscription.stop" }));
    } finally {
      socket.terminate();
      await surface.close();
    }
  });

  it("bounds HTTP and WebSocket ingress and WebSocket egress without harming peers", async () => {
    const surface = createGatewayHttpSurface(new AccessGatewayProjection([]));
    await listen(surface);

    try {
      const oversizedHttp = await fetch(`${httpUrl(surface)}/trpc/sessions.refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.alloc(TRPC_HTTP_BODY_LIMIT_BYTES + 1),
      });
      expect(oversizedHttp.status).toBe(413);

      const healthyHttp = await fetch(`${httpUrl(surface)}/trpc/system.describe`);
      expect(healthyHttp.status).toBe(200);
      await expect(healthyHttp.json()).resolves.toMatchObject({
        result: { data: { componentKind: "access-gateway" } },
      });

      const oversized = new WebSocket(webSocketUrl(surface));
      await opened(oversized);
      const oversizedServerSocket = onlyOpenServerSocket(surface);
      const oversizedClosed = closed(oversized);
      const sendError = new Promise<Error | undefined>((resolve) => {
        oversizedServerSocket.send(
          Buffer.alloc(WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES),
          (error) => resolve(error),
        );
      });
      expect((await sendError)?.message).toMatch(
        /WebSocket egress buffer exceeded/,
      );
      await expect(oversizedClosed).resolves.toBe(1006);

      const fragmented = new WebSocket(webSocketUrl(surface));
      await opened(fragmented);
      const fragmentedServerSocket = onlyOpenServerSocket(surface);
      const fragmentedClosed = closed(fragmented);
      const fragmentedError = new Promise<Error | undefined>((resolve) => {
        fragmentedServerSocket.send(
          [
            Buffer.alloc(WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES / 2),
            Buffer.alloc(WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES / 2),
          ],
          (error) => resolve(error),
        );
      });
      expect((await fragmentedError)?.message).toMatch(
        /WebSocket egress buffer exceeded/,
      );
      await expect(fragmentedClosed).resolves.toBe(1006);

      const slow = new WebSocket(webSocketUrl(surface));
      await opened(slow);
      const slowServerSocket = onlyOpenServerSocket(surface);
      Object.defineProperty(slowServerSocket, "bufferedAmount", {
        configurable: true,
        value: WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES,
      });
      const slowClosed = closed(slow);
      slow.send(JSON.stringify({
        id: 1,
        method: "query",
        params: { path: "system.describe" },
      }));
      await expect(slowClosed).resolves.toBe(1006);

      const oversizedInbound = new WebSocket(webSocketUrl(surface));
      await opened(oversizedInbound);
      const oversizedInboundClosed = closed(oversizedInbound);
      oversizedInbound.send(
        Buffer.alloc(WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES + 1),
      );
      await expect(oversizedInboundClosed).resolves.toBe(1009);

      const healthy = new WebSocket(webSocketUrl(surface));
      try {
        await opened(healthy);
        const response = messageMatching(
          healthy,
          (frame) => frame.result?.type === "data",
        );
        healthy.send(JSON.stringify({
          id: 2,
          method: "query",
          params: { path: "system.describe" },
        }));
        await expect(response).resolves.toMatchObject({
          result: { data: { componentKind: "access-gateway" } },
        });
      } finally {
        healthy.terminate();
      }
    } finally {
      await surface.close();
    }
  });
});

interface WireFrame {
  readonly result?: {
    readonly type?: string;
    readonly data?: unknown;
  };
  readonly error?: unknown;
}

async function listen(
  surface: ReturnType<typeof createGatewayHttpSurface>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    surface.server.once("error", reject);
    surface.server.listen(0, "127.0.0.1", resolve);
  });
}

function httpUrl(surface: ReturnType<typeof createGatewayHttpSurface>): string {
  const address = surface.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function webSocketUrl(
  surface: ReturnType<typeof createGatewayHttpSurface>,
): string {
  return `${httpUrl(surface).replace("http:", "ws:")}/trpc`;
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

function onlyOpenServerSocket(
  surface: ReturnType<typeof createGatewayHttpSurface>,
): WebSocket {
  const sockets = [...surface.webSockets.clients].filter(
    (socket) => socket.readyState === WebSocket.OPEN,
  );
  expect(sockets).toHaveLength(1);
  return sockets[0]!;
}

function messageMatching(
  socket: WebSocket,
  predicate: (frame: WireFrame) => boolean,
): Promise<WireFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      if (data.toString() === "PING") {
        socket.send("PONG");
        return;
      }
      let frame: WireFrame;
      try {
        frame = JSON.parse(data.toString()) as WireFrame;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
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
