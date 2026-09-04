import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
  type CreateTRPCClient,
  type TRPCWebSocketClient,
  type WebSocketClientOptions,
} from "@trpc/client";
import type { AccessRouter } from "@arduano/agent-multiplex-control-node-core";

import {
  bearerAuthorizationHeaders,
  bearerConnectionParams,
  type BearerTokenProvider,
} from "./http.js";

/** tRPC client for the authority-neutral protocol-v4 access contract. */
export type AccessClient = CreateTRPCClient<AccessRouter>;

export interface AccessClientOptions {
  readonly httpUrl: string;
  readonly wsUrl?: string;
  readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Authenticates HTTP calls and WebSocket connectionParams. Mutually
   * exclusive with custom headers.
   */
  readonly bearerToken?: BearerTokenProvider;
  readonly WebSocket?: WebSocketClientOptions["WebSocket"];
  readonly onWebSocketOpen?: () => void;
  readonly onWebSocketClose?: (cause?: { code?: number }) => void;
}

export interface AccessClientHandle {
  readonly client: AccessClient;
  readonly wsClient: TRPCWebSocketClient | undefined;
  close(): void;
}

/** Creates an HTTP/WebSocket client for a control node or access gateway. */
export function createAccessClient(options: AccessClientOptions): AccessClientHandle {
  if (options.bearerToken !== undefined && options.headers !== undefined) {
    throw new TypeError("bearerToken and custom headers are mutually exclusive");
  }
  const websocketUrl = options.wsUrl;
  const wsClient = websocketUrl
    ? createWSClient({
        url: websocketUrl,
        ...(options.bearerToken !== undefined
          ? { connectionParams: bearerConnectionParams(options.bearerToken) }
          : {}),
        ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
        ...(options.onWebSocketOpen ? { onOpen: options.onWebSocketOpen } : {}),
        ...(options.onWebSocketClose ? { onClose: options.onWebSocketClose } : {}),
        keepAlive: { enabled: true, intervalMs: 10_000, pongTimeoutMs: 3_000 },
      })
    : undefined;
  const http = httpBatchLink<AccessRouter>({
    url: options.httpUrl,
    ...(options.bearerToken !== undefined
      ? { headers: bearerAuthorizationHeaders(options.bearerToken) }
      : options.headers
        ? { headers: options.headers }
        : {}),
  });
  const client = createTRPCClient<AccessRouter>({
    links: wsClient
      ? [
          splitLink({
            condition: (operation) => operation.type === "subscription",
            true: wsLink({ client: wsClient }),
            false: http,
          }),
        ]
      : [http],
  });
  return Object.freeze({
    client,
    wsClient,
    close: () => wsClient?.close(),
  });
}
