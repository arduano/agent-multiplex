import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { dashboardHtml } from "@agent-multiplex/web";

import {
  createFleetRouter,
  type FleetContext,
  type FleetRouter,
  type HostService,
} from "@agent-multiplex/host-core";

export interface HostHttpSurface {
  readonly server: Server;
  readonly webSockets: WebSocketServer;
  readonly router: FleetRouter;
  close(): Promise<void>;
}
/** Standard HTTP/WebSocket edge for browsers, CLIs, and embedded dashboards. */
export function createHostHttpSurface(service: HostService): HostHttpSurface {
  const router = createFleetRouter(service);
  const trpcHandler = createHTTPHandler({
    router,
    basePath: "/trpc/",
    createContext: (): FleetContext => ({}),
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/trpc/")) {
      trpcHandler(request, response);
      return;
    }
    serveWeb(request, response);
  });
  const webSockets = new WebSocketServer({ server, path: "/trpc" });
  applyWSSHandler({
    wss: webSockets,
    router,
    createContext: (): FleetContext => ({}),
    keepAlive: { enabled: true, pingMs: 15_000, pongWaitMs: 5_000 },
  });

  let closing: Promise<void> | undefined;
  return {
    server,
    webSockets,
    router,
    close: () => {
      closing ??= closeSurface(server, webSockets);
      return closing;
    },
  };
}

async function closeSurface(server: Server, webSockets: WebSocketServer): Promise<void> {
  for (const client of webSockets.clients) client.terminate();
  await new Promise<void>((resolveClose) => webSockets.close(() => resolveClose()));
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function serveWeb(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET" || (request.url !== "/" && request.url !== "/index.html")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(dashboardHtml());
}
