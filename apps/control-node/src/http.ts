import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";

import {
  createAccessRouter,
  type AccessRouter,
  type ControlNodeService,
} from "@arduano/agent-multiplex-control-node-core";
import { webAsset } from "@arduano/agent-multiplex-web";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";

export interface ControlNodeHttpSurface {
  readonly server: Server;
  readonly webSockets: WebSocketServer;
  readonly router: AccessRouter;
  close(): Promise<void>;
}

/**
 * Trusted-local access surface. The daemon enforces an explicit loopback bind;
 * remote and multi-source clients belong behind an access gateway.
 */
export function createControlNodeHttpSurface(
  service: ControlNodeService,
): ControlNodeHttpSurface {
  const router = createAccessRouter(service);
  const trpcHandler = createHTTPHandler({
    router,
    basePath: "/trpc/",
    createContext: () => ({ trustedLocalAccess: true as const }),
  });
  const server = createServer((request, response) => {
    const styleNonce = newStyleNonce();
    applyControlNodeSecurityHeaders(response, styleNonce);
    if (request.url?.startsWith("/trpc/")) {
      trpcHandler(request, response);
      return;
    }
    serveWeb(request, response, styleNonce);
  });
  const webSockets = new WebSocketServer({ server, path: "/trpc" });
  applyWSSHandler({
    wss: webSockets,
    router,
    createContext: () => ({ trustedLocalAccess: true as const }),
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

async function closeSurface(
  server: Server,
  webSockets: WebSocketServer,
): Promise<void> {
  for (const client of webSockets.clients) client.terminate();
  await new Promise<void>((resolveClose) =>
    webSockets.close(() => resolveClose()),
  );
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function serveWeb(
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

function applyControlNodeSecurityHeaders(
  response: ServerResponse,
  styleNonce: string,
): void {
  // Runtime styles from Radix and xterm carry this per-response nonce.
  // Positioned primitives and xterm layout still require style attributes,
  // while scripts and authored stylesheet elements remain same-origin only.
  response.setHeader(
    "content-security-policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-${styleNonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function newStyleNonce(): string {
  return randomBytes(18).toString("base64url");
}
