import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import {
  createHTTPHandler,
  type CreateHTTPContextOptions,
} from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";

import type { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import {
  installBoundedWebSocketEgress,
  TRPC_HTTP_BODY_LIMIT_BYTES,
  WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES,
  webAsset,
} from "@arduano/agent-multiplex-web";

import {
  createAccessGatewayRouter,
  type AccessGatewayRouter,
} from "./router.js";
import {
  createGatewayAuthenticator,
  type GatewayBearerAuthConfig,
} from "./auth.js";

export {
  createGatewayAuthenticator,
  isLoopbackBindAddress,
  requireGatewayActionScope,
  validateGatewayBindAddress,
  type GatewayAccessIdentity,
  type GatewayAuthenticator,
  type GatewayAuthContext,
  type GatewayBearerAuthConfig,
  type GatewayBearerCredential,
} from "./auth.js";

export interface GatewayHttpSurface {
  readonly server: Server;
  readonly webSockets: WebSocketServer;
  readonly router: AccessGatewayRouter;
  close(): Promise<void>;
}

export interface GatewayHttpSurfaceOptions {
  /** Omit only for a loopback-bound, locally trusted gateway. */
  readonly auth?: GatewayBearerAuthConfig;
  /** Stable local instance identity advertised by system.describe. */
  readonly instanceId?: string;
}

/** Browser-facing edge that exposes only the protocol-v4 access API. */
export function createGatewayHttpSurface(
  projection: AccessGatewayProjection,
  options: GatewayHttpSurfaceOptions = {},
): GatewayHttpSurface {
  const authenticator = createGatewayAuthenticator(options.auth);
  const router = createAccessGatewayRouter(projection, {
    instanceId: options.instanceId ?? "access-gateway",
  });
  const trpcHandler = createHTTPHandler({
    router,
    basePath: "/trpc/",
    maxBodySize: TRPC_HTTP_BODY_LIMIT_BYTES,
    createContext: ({ req, res }: CreateHTTPContextOptions) => {
      try {
        return authenticator.authenticateHttp(readAuthorizationHeaders(req));
      } catch (error) {
        if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
          res.setHeader(
            "www-authenticate",
            'Bearer realm="agent-multiplex-gateway"',
          );
        }
        throw error;
      }
    },
  });
  const server = createServer((request, response) => {
    const styleNonce = newStyleNonce();
    applyGatewaySecurityHeaders(response, styleNonce);
    if (request.url?.startsWith("/trpc/")) {
      trpcHandler(request, response);
      return;
    }
    serveDashboard(request, response, styleNonce);
  });
  const webSockets = new WebSocketServer({
    server,
    path: "/trpc",
    maxPayload: WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES,
  });
  installBoundedWebSocketEgress(webSockets);
  applyWSSHandler({
    wss: webSockets,
    router,
    createContext: ({ info }) =>
      authenticator.authenticateWebSocket(info.connectionParams),
    keepAlive: { enabled: true, pingMs: 15_000, pongWaitMs: 5_000 },
  });

  let closing: Promise<void> | undefined;
  return Object.freeze({
    server,
    webSockets,
    router,
    close: () => {
      closing ??= closeSurface(server, webSockets);
      return closing;
    },
  });
}

function readAuthorizationHeaders(
  request: IncomingMessage,
): string | readonly string[] | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== "authorization") continue;
    const value = request.rawHeaders[index + 1];
    if (value !== undefined) values.push(value);
  }
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

async function closeSurface(
  server: Server,
  webSockets: WebSocketServer,
): Promise<void> {
  for (const client of webSockets.clients) client.terminate();
  await new Promise<void>((resolveClose) => webSockets.close(() => resolveClose()));
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function serveDashboard(
  request: IncomingMessage,
  response: ServerResponse,
  styleNonce: string,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  const asset = webAsset(request.url ?? "/", { styleNonce });
  if (asset === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  response.writeHead(200, {
    "content-type": asset.contentType,
    "cache-control": asset.cacheControl,
    "content-length": asset.body.byteLength,
  });
  response.end(request.method === "HEAD" ? undefined : asset.body);
}

/** Apply the browser-facing policy uniformly, including errors and tRPC JSON. */
function applyGatewaySecurityHeaders(
  response: ServerResponse,
  styleNonce: string,
): void {
  // Runtime styles from Radix and xterm carry this per-response nonce.
  // Positioned primitives and xterm layout still require style attributes,
  // while scripts and authored stylesheet elements remain same-origin only.
  response.setHeader(
    "content-security-policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-${styleNonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function newStyleNonce(): string {
  return randomBytes(18).toString("base64url");
}
