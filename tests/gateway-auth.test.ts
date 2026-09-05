import type { AddressInfo } from "node:net";

import {
  GatewayRoutingError,
  type ControlNodeSourceClient,
  type GatewaySourceSnapshot,
} from "@arduano/agent-multiplex-gateway-core";
import {
  emptyMetadataSnapshot,
  newAttachmentId,
  newAuthorityEpochId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLineageId,
  newOperationId,
  newRealmId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTopologyTransitionId,
  type AccessStreamItem,
  type SourceId,
} from "@arduano/agent-multiplex-protocol";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { createAccessClient } from "../packages/client/src/client.js";
import {
  createGatewayAuthenticator,
  createGatewayHttpSurface,
  isLoopbackBindAddress,
  requireGatewayActionScope,
  validateGatewayBindAddress,
  type GatewayBearerAuthConfig,
} from "../apps/gateway/src/http.js";
import { createAccessGatewayRouter } from "../apps/gateway/src/router.js";
import {
  AccessGatewayProjection,
} from "../packages/gateway-core/src/projection.js";

const TEST_TOKEN = "gateway-test-token.0123456789";

describe("gateway edge authentication", () => {
  it("preserves trusted loopback mode when bearer auth is omitted", () => {
    const authenticator = createGatewayAuthenticator(undefined);

    expect(authenticator.mode).toBe("loopback");
    expect(authenticator.authenticateHttp(undefined)).toEqual({
      gatewayAccess: {
        authentication: "loopback",
        subject: "local-loopback",
        scopes: [
          "read",
          "agent-launch",
          "agent-archive",
          "agent-control",
          "terminal-view",
          "terminal-control",
          "metadata-propose",
          "topology-admin",
          "authority-admin",
        ],
      },
    });
  });

  it("authenticates HTTP and WebSocket bearers and exposes canonical scopes", () => {
    const authenticator = createGatewayAuthenticator({
      bearerToken: TEST_TOKEN,
      subject: "dashboard-user",
      scopes: ["metadata-propose", "read", "read"],
    });

    const http = authenticator.authenticateHttp(`Bearer ${TEST_TOKEN}`);
    const socket = authenticator.authenticateWebSocket({
      authorization: `bearer ${TEST_TOKEN}`,
    });
    expect(http).toBe(socket);
    expect(http).toEqual({
      gatewayAccess: {
        authentication: "bearer",
        subject: "dashboard-user",
        scopes: ["read", "metadata-propose"],
      },
    });
    expect(Object.isFrozen(http)).toBe(true);
    expect(Object.isFrozen(http.gatewayAccess)).toBe(true);
    expect(Object.isFrozen(http.gatewayAccess.scopes)).toBe(true);
  });

  it("attributes distinct scopes to each configured bearer", () => {
    const authenticator = createGatewayAuthenticator({
      credentials: [
        { bearerToken: TEST_TOKEN, subject: "viewer", scopes: ["read"] },
        {
          bearerToken: "operator-token.0123456789",
          subject: "operator",
          scopes: ["read", "agent-control"],
        },
      ],
    });

    expect(
      authenticator.authenticateHttp(`Bearer ${TEST_TOKEN}`).gatewayAccess,
    ).toMatchObject({ subject: "viewer", scopes: ["read"] });
    expect(
      authenticator.authenticateHttp("Bearer operator-token.0123456789")
        .gatewayAccess,
    ).toMatchObject({ subject: "operator", scopes: ["read", "agent-control"] });
  });

  it("rejects missing, malformed, duplicate, URL-like, and wrong credentials", () => {
    const authenticator = createGatewayAuthenticator(authConfig());

    for (const authorization of [
      undefined,
      "",
      TEST_TOKEN,
      `Basic ${TEST_TOKEN}`,
      `Bearer ${TEST_TOKEN}, Bearer duplicate`,
      "Bearer wrong-token",
      [`Bearer ${TEST_TOKEN}`, "Bearer duplicate"],
    ]) {
      expect(() => authenticator.authenticateHttp(authorization)).toThrow(
        expect.objectContaining({ code: "UNAUTHORIZED" }),
      );
    }
    expect(() =>
      authenticator.authenticateWebSocket({ token: TEST_TOKEN }),
    ).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => authenticator.authenticateWebSocket(null)).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });

  it("enforces action scopes without treating them as data authority", () => {
    const context = createGatewayAuthenticator({
      bearerToken: TEST_TOKEN,
      scopes: ["read", "agent-control"],
    }).authenticateHttp(`Bearer ${TEST_TOKEN}`);

    expect(() => requireGatewayActionScope(context, "read")).not.toThrow();
    expect(() =>
      requireGatewayActionScope(context, "metadata-propose"),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("enforces the action category at every v3 mutation boundary", async () => {
    const projection = emptyProjection();
    const caller = createAccessGatewayRouter(projection, {
      instanceId: "scope-test",
    }).createCaller(createGatewayAuthenticator({
      bearerToken: TEST_TOKEN,
      scopes: ["read"],
    }).authenticateHttp(`Bearer ${TEST_TOKEN}`));
    const controlNodeId = newControlNodeId();
    const expectedAuthority = {
      realmId: newRealmId(),
      controlNodeId,
      epochId: newAuthorityEpochId(),
    };

    const imageTarget = {
      sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), bindingRevision: 1,
      runtimeNodeBootId: newRuntimeNodeBootId(), imageId: newSessionId(),
    };
    await expect(caller.images.beginUpload({
      ...imageTarget, byteLength: 4, sha256: "a".repeat(64), mediaType: "image/png",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.images.writeUpload({
      ...imageTarget, offset: 0, dataBase64: "AAAAAA==",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.images.commitUpload(imageTarget)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.images.abortUpload(imageTarget)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.sessions.refresh({
      runtimeNodeId: newRuntimeNodeId(),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.metadata.patch({
      operationId: newOperationId(),
      sessionId: newSessionId(),
      expectedAuthority,
      set: { "agent.title": "blocked" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.topology.detach({
      childControlNodeId: newControlNodeId(),
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      expectedAuthority,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.authority.promote({
      controlNodeId,
      expectedAuthority,
      detachmentTransitionId: newTopologyTransitionId(),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("exposes retryable source history failure without leaking source details", async () => {
    const secret = "private upstream transport and endpoint details";
    const source = gatewaySourceWithSession(
      new GatewayRoutingError("UNAVAILABLE", secret, { privateDetail: secret }),
    );
    const projection = new AccessGatewayProjection([source.definition]);
    await projection.refreshAll();
    const surface = createGatewayHttpSurface(projection, {
      auth: authConfig(),
      instanceId: "error-envelope-test",
    });
    await listen(surface);
    const access = createAccessClient({
      httpUrl: `${httpUrl(surface)}/trpc`,
      bearerToken: TEST_TOKEN,
    });

    try {
      const failure = await access.client.sessions.readNativeHistory.query({
        sessionId: source.sessionId,
        request: { harness: "codex", includeTurns: true },
      }).catch((cause: unknown) => cause as Error & {
        data?: { code?: string; httpStatus?: number };
      });

      expect(failure).toMatchObject({
        message: "gateway source is unavailable",
        data: { code: "SERVICE_UNAVAILABLE", httpStatus: 503 },
      });
      expect(JSON.stringify(failure)).not.toContain(secret);
    } finally {
      access.close();
      await surface.close();
    }
  });

  it("allows explicit loopback IPs but refuses unauthenticated public binds", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.0.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackBindAddress(address)).toBe(true);
      expect(() => validateGatewayBindAddress(address, undefined)).not.toThrow();
    }
    for (const address of [
      undefined,
      "",
      "localhost",
      "0.0.0.0",
      "192.168.1.10",
      "::",
      "example.internal",
    ]) {
      expect(isLoopbackBindAddress(address)).toBe(false);
      expect(() => validateGatewayBindAddress(address, undefined)).toThrow(
        /only to an explicit loopback IP address/,
      );
    }

    expect(() => validateGatewayBindAddress("0.0.0.0", authConfig())).not.toThrow();
  });

  it("rejects unusable bearer configuration before opening a listener", () => {
    for (const bearerToken of ["", "contains whitespace", "x".repeat(4_097)]) {
      expect(() =>
        createGatewayAuthenticator({
          bearerToken,
          scopes: ["read"],
        }),
      ).toThrow(/gateway bearer token/);
    }
    expect(() =>
      createGatewayAuthenticator({
        bearerToken: TEST_TOKEN,
        subject: " padded ",
        scopes: ["read"],
      }),
    ).toThrow(/gateway bearer subject/);
  });

  it("protects HTTP tRPC without putting credentials in URLs", async () => {
    const surface = createGatewayHttpSurface(
      emptyProjection(),
      { auth: authConfig(), instanceId: "test-gateway" },
    );
    await listen(surface);

    try {
      const endpoint = `${httpUrl(surface)}/trpc/system.describe`;
      const missing = await fetch(endpoint);
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe(
        'Bearer realm="agent-multiplex-gateway"',
      );

      const urlCredential = await fetch(
        `${endpoint}?token=${encodeURIComponent(TEST_TOKEN)}`,
      );
      expect(urlCredential.status).toBe(401);

      const wrong = await fetch(endpoint, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(wrong.status).toBe(401);

      const authenticated = await fetch(endpoint, {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(authenticated.status).toBe(200);
      await expect(authenticated.json()).resolves.toMatchObject({
        result: {
          data: {
            instanceId: "test-gateway",
            protocolVersion: 5,
            componentKind: "access-gateway",
            dataAuthority: "none",
          },
        },
      });

      const dashboard = await fetch(httpUrl(surface));
      expect(dashboard.status).toBe(200);
    } finally {
      await surface.close();
    }
  });

  it("applies browser security headers to dashboard, errors, and tRPC", async () => {
    const surface = createGatewayHttpSurface(
      emptyProjection(),
      { auth: authConfig(), instanceId: "header-test-gateway" },
    );
    await listen(surface);

    try {
      const requests = await Promise.all([
        fetch(httpUrl(surface), {
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        }),
        fetch(`${httpUrl(surface)}/missing`),
        fetch(`${httpUrl(surface)}/trpc/system.describe`, {
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        }),
      ]);
      for (const response of requests) {
        expect(response.headers.get("content-security-policy")).toContain(
          "frame-ancestors 'none'",
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      }
    } finally {
      await surface.close();
    }
  });

  it("authenticates WebSockets only through tRPC connectionParams", async () => {
    const surface = createGatewayHttpSurface(
      emptyProjection(),
      { auth: authConfig(), instanceId: "socket-gateway" },
    );
    await listen(surface);

    try {
      const wrong = new WebSocket(
        `${webSocketUrl(surface)}?connectionParams=1`,
      );
      try {
        await opened(wrong);
        const unauthorized = nextFrame(wrong);
        wrong.send(JSON.stringify({
          method: "connectionParams",
          data: { authorization: "Bearer wrong-token" },
        }));
        await expect(unauthorized).resolves.toMatchObject({
          error: { data: { code: "UNAUTHORIZED" } },
        });
      } finally {
        wrong.terminate();
      }

      const authenticated = new WebSocket(
        `${webSocketUrl(surface)}?connectionParams=1`,
      );
      try {
        await opened(authenticated);
        authenticated.send(JSON.stringify({
          method: "connectionParams",
          data: { authorization: `Bearer ${TEST_TOKEN}` },
        }));
        const response = nextFrame(authenticated);
        authenticated.send(JSON.stringify({
          id: 1,
          method: "query",
          params: { path: "system.describe" },
        }));
        await expect(response).resolves.toMatchObject({
          result: {
            data: {
              instanceId: "socket-gateway",
              componentKind: "access-gateway",
            },
          },
        });
      } finally {
        authenticated.terminate();
      }
    } finally {
      await surface.close();
    }
  });
});

function authConfig(): GatewayBearerAuthConfig {
  return {
    bearerToken: TEST_TOKEN,
    scopes: ["read"],
  };
}

function emptyProjection(): AccessGatewayProjection {
  return new AccessGatewayProjection([]);
}

function gatewaySourceWithSession(historyError: Error) {
  const at = "2026-09-03T02:00:00.000Z";
  const controlNodeId = newControlNodeId();
  const authority = {
    realmId: newRealmId(),
    controlNodeId,
    epochId: newAuthorityEpochId(),
  };
  const runtimeNodeId = newRuntimeNodeId();
  const sessionId = newSessionId();
  const controlNodeBootId = newControlNodeBootId();
  const feedId = newFeedId();
  const snapshot: GatewaySourceSnapshot = {
    manifest: {
      componentKind: "control-node",
      protocolVersion: 5,
      sourceControlNodeId: controlNodeId,
      sourceControlNodeBootId: controlNodeBootId,
      authority,
      projectionRootControlNodeId: controlNodeId,
      coveredControlNodeIds: [controlNodeId],
      feedId,
      controlCursor: 0,
      generatedAt: at,
      capabilities: [],
    },
    parentByControlNodeId: { [controlNodeId]: null },
    controlNodes: [{
      controlNodeId,
      controlNodeBootId,
      feedId,
      name: "source",
      endpointId: "pinned-source",
      presence: "online",
      dataRole: { role: "authority", authority },
      connectedAt: at,
      lastHeartbeatAt: at,
      protocolVersion: 5,
      capabilities: [],
    }],
    runtimeNodes: [{
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      ownerControlNodeId: controlNodeId,
      name: "runtime",
      presence: "online",
      reachability: "reachable",
      connectedAt: at,
      lastHeartbeatAt: at,
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 5,
    }],
    sessions: [{
      sessionId,
      runtimeNodeId,
      harness: "codex",
      adapterScopeId: "codex-error-test",
      vendorSessionId: "native-error-test",
      bindingRevision: 1,
      runtimeEpoch: null,
      cwd: "/work",
      availability: "active",
      runtimeStatus: "idle",
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: authority,
      createdAt: at,
      updatedAt: at,
      lastSeenAt: at,
    }],
    interactions: [],
    metadataOperations: [],
  };
  const client: ControlNodeSourceClient = {
    loadSnapshot: () => Promise.resolve(snapshot),
    watch: async function* (): AsyncIterable<AccessStreamItem> {},
    listModels: () => Promise.resolve([]),
    listLaunchProfiles: () => Promise.resolve([]),
    listLaunchModels: () => Promise.resolve([]),
    createLaunch: () => Promise.reject(new Error("unused")),
    getLaunch: () => Promise.reject(new Error("unused")),
    listLaunches: () => Promise.reject(new Error("unused")),
    searchSessions: () => Promise.reject(new Error("unused")),
    getSession: () => Promise.reject(new Error("unused")),
    refresh: () => Promise.reject(new Error("unused")),
    resume: () => Promise.reject(new Error("unused")),
    stop: () => Promise.reject(new Error("unused")),
    archive: () => Promise.reject(new Error("unused")),
    getArchive: () => Promise.reject(new Error("unused")),
    execute: () => Promise.reject(new Error("unused")),
    readNativeHistory: () => Promise.reject(historyError),
    patchMetadata: () => Promise.reject(new Error("unused")),
    resolveInteraction: () => Promise.reject(new Error("unused")),
    getCommand: () => Promise.resolve(null),
    detach: () => Promise.reject(new Error("unused")),
    forceDetach: () => Promise.reject(new Error("unused")),
    promote: () => Promise.reject(new Error("unused")),
  };
  return {
    sessionId,
    definition: {
      sourceId: "error-source" as SourceId,
      displayName: "error-source",
      endpointId: "pinned-source",
      client,
    },
  };
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

interface WireFrame {
  readonly result?: { readonly data?: unknown };
  readonly error?: {
    readonly data?: { readonly code?: string };
  };
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
