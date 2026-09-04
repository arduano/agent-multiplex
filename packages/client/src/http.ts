import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
  wsLink,
  type CreateTRPCClient,
  type HTTPHeaders,
  type Operation,
  type TRPCFetch,
  type TRPCWebSocketClient,
  type WebSocketClientOptions,
} from "@trpc/client";
import type {
  AnyTRPCRouter,
  TRPCDataTransformer,
} from "@trpc/server";

type HeaderProvider =
  | HTTPHeaders
  | ((options: {
      opList: [Operation, ...Operation[]];
    }) => HTTPHeaders | Promise<HTTPHeaders>);

type ConnectionParams =
  | Record<string, unknown>
  | (() => Record<string, unknown> | Promise<Record<string, unknown>>);

export type BearerTokenProvider =
  | string
  | (() => string | Promise<string>);

export interface HttpSubscriptionOptions {
  /** Defaults to the query/mutation URL. */
  readonly url?: string | URL;
  /** Required outside browsers/runtimes that do not provide global EventSource. */
  readonly EventSource?: typeof EventSource;
  readonly eventSourceOptions?:
    | EventSourceInit
    | ((options: { op: Operation }) => EventSourceInit | Promise<EventSourceInit>);
  readonly connectionParams?: ConnectionParams;
}

export interface HttpTRPCClientOptions {
  /** Full tRPC endpoint, for example http://127.0.0.1:8787/trpc. */
  readonly url: string | URL;
  readonly headers?: HeaderProvider;
  readonly fetch?: TRPCFetch;
  readonly methodOverride?: "POST";
  readonly maxURLLength?: number;
  readonly maxItems?: number;
  /** Set false for a query/mutation-only client. Defaults to HTTP SSE. */
  readonly subscription?: HttpSubscriptionOptions | false;
  /** Must match the access router. Omit for the default JSON transformer. */
  readonly transformer?: TRPCDataTransformer;
}

/**
 * Standard browser/Node tRPC client. Queries and mutations use HTTP batching;
 * subscriptions use tRPC's HTTP SSE link unless explicitly disabled.
 */
export function createHttpTRPCClient<TRouter extends AnyTRPCRouter>(
  options: HttpTRPCClientOptions,
): CreateTRPCClient<TRouter> {
  const batchOptions = {
    url: options.url,
    ...(options.transformer !== undefined
      ? { transformer: options.transformer }
      : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.methodOverride !== undefined
      ? { methodOverride: options.methodOverride }
      : {}),
    ...(options.maxURLLength !== undefined
      ? { maxURLLength: options.maxURLLength }
      : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  } as unknown as Parameters<typeof httpBatchLink<TRouter>>[0];
  const batch = httpBatchLink<TRouter>(batchOptions);

  if (options.subscription === false) {
    return createTRPCClient<TRouter>({ links: [batch] });
  }

  const subscription = options.subscription ?? {};
  const sse = httpSubscriptionLink<TRouter, typeof EventSource>({
    url: subscription.url ?? options.url,
    ...(options.transformer !== undefined
      ? { transformer: options.transformer }
      : {}),
    ...(subscription.EventSource !== undefined
      ? { EventSource: subscription.EventSource }
      : {}),
    ...(subscription.eventSourceOptions !== undefined
      ? { eventSourceOptions: subscription.eventSourceOptions }
      : {}),
    ...(subscription.connectionParams !== undefined
      ? { connectionParams: subscription.connectionParams }
      : {}),
  } as Parameters<typeof httpSubscriptionLink<TRouter, typeof EventSource>>[0]);

  return createTRPCClient<TRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === "subscription",
        true: sse,
        false: batch,
      }),
    ],
  });
}

export interface WebSocketSubscriptionOptions
  extends Omit<WebSocketClientOptions, "url"> {
  /** Defaults to the HTTP URL with its scheme changed to ws/wss. */
  readonly url?: string | URL | (() => string | Promise<string>);
}

export interface WebSocketTRPCClientOptions
  extends Omit<HttpTRPCClientOptions, "subscription"> {
  readonly subscription?: WebSocketSubscriptionOptions;
  /**
   * Adds an Authorization header to HTTP operations and sends the same value
   * in WebSocket connectionParams. Mutually exclusive with custom HTTP
   * headers and custom WebSocket connectionParams.
   */
  readonly bearerToken?: BearerTokenProvider;
}

export interface ManagedWebSocketTRPCClient<TRouter extends AnyTRPCRouter> {
  readonly client: CreateTRPCClient<TRouter>;
  readonly webSocket: TRPCWebSocketClient;
  close(): Promise<void>;
}

/** HTTP query/mutation transport with a reconnecting WebSocket subscription. */
export function createWebSocketTRPCClient<TRouter extends AnyTRPCRouter>(
  options: WebSocketTRPCClientOptions,
): ManagedWebSocketTRPCClient<TRouter> {
  const wsOptions = options.subscription ?? {};
  if (options.bearerToken !== undefined && options.headers !== undefined) {
    throw new TypeError("bearerToken and custom headers are mutually exclusive");
  }
  if (
    options.bearerToken !== undefined &&
    wsOptions.connectionParams !== undefined
  ) {
    throw new TypeError(
      "bearerToken and custom WebSocket connectionParams are mutually exclusive",
    );
  }
  const configuredSocketUrl = wsOptions.url;
  const webSocket = createWSClient({
    ...wsOptions,
    url:
      configuredSocketUrl === undefined
        ? toWebSocketUrl(options.url)
        : typeof configuredSocketUrl === "function"
          ? configuredSocketUrl
          : configuredSocketUrl.toString(),
    ...(options.bearerToken !== undefined
      ? { connectionParams: bearerConnectionParams(options.bearerToken) }
      : {}),
  });
  const batch = httpBatchLink<TRouter>({
    url: options.url,
    ...(options.transformer !== undefined
      ? { transformer: options.transformer }
      : {}),
    ...(options.bearerToken !== undefined
      ? { headers: bearerAuthorizationHeaders(options.bearerToken) }
      : options.headers !== undefined
        ? { headers: options.headers }
        : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.methodOverride !== undefined
      ? { methodOverride: options.methodOverride }
      : {}),
    ...(options.maxURLLength !== undefined
      ? { maxURLLength: options.maxURLLength }
      : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  } as unknown as Parameters<typeof httpBatchLink<TRouter>>[0]);
  const socket = wsLink<TRouter>({
    client: webSocket,
    ...(options.transformer !== undefined
      ? { transformer: options.transformer }
      : {}),
  } as Parameters<typeof wsLink<TRouter>>[0]);
  const client = createTRPCClient<TRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === "subscription",
        true: socket,
        false: batch,
      }),
    ],
  });

  return Object.freeze({
    client,
    webSocket,
    close: () => webSocket.close(),
  });
}

/** Formats a raw token for HTTP Authorization or WebSocket connectionParams. */
export function bearerAuthorization(token: string): string {
  if (token.length === 0 || /\s/.test(token)) {
    throw new TypeError("bearer token must be non-empty and contain no whitespace");
  }
  return `Bearer ${token}`;
}

/** A reconnect-safe provider for tRPC WebSocket authentication. */
export function bearerConnectionParams(
  provider: BearerTokenProvider,
): () => Promise<Record<string, string>> {
  return async () => ({
    authorization: bearerAuthorization(await resolveBearerToken(provider)),
  });
}

/** A refresh-safe HTTP Authorization header provider. */
export function bearerAuthorizationHeaders(
  provider: BearerTokenProvider,
): () => Promise<Record<string, string>> {
  return async () => ({
    authorization: bearerAuthorization(await resolveBearerToken(provider)),
  });
}

async function resolveBearerToken(provider: BearerTokenProvider): Promise<string> {
  return typeof provider === "function" ? provider() : provider;
}

function toWebSocketUrl(value: string | URL): string {
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError(`Cannot derive a WebSocket URL from ${url.protocol}`);
  }
  return url.toString();
}
