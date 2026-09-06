#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  P2PControlNodeSourceClient,
  createP2PAccessGatewayNode,
  type P2PAccessGatewayNodeHandle,
} from "@arduano/agent-multiplex-client-p2prpc";
import {
  AccessGatewayProjection,
  GatewayOperationalStore,
  type GatewaySourceDefinition,
} from "@arduano/agent-multiplex-gateway-core";
import {
  actionScopesSchema,
  sourceIdSchema,
  type AccessStreamItem,
  type ActionScope,
  type SourceId,
  type StreamCursor,
} from "@arduano/agent-multiplex-protocol";
import type { PinnedPeerTarget } from "@arduano/agent-multiplex-transport-p2prpc";

import {
  createGatewayHttpSurface,
  validateGatewayBindAddress,
  type GatewayBearerAuthConfig,
  type GatewayHttpSurface,
} from "./http.js";

export { createAccessGatewayRouter } from "./router.js";
export type { GatewayAuthContext, GatewayAccessIdentity } from "./auth.js";
export type { GatewayHttpSurface } from "./http.js";

/** A trusted static application edge must authenticate both HTTP and WebSockets. */
export interface GatewayComposition {
  readonly httpSurface?: {
    readonly authentication: "external";
    create(projection: AccessGatewayProjection, instanceId: string): GatewayHttpSurface;
  };
}

const DEFAULT_IDENTITY_PATH = ".agent-multiplex/access-gateway.identity";
const DEFAULT_STATE_PATH = ".agent-multiplex/access-gateway.sqlite";
const DEFAULT_HTTP_PORT = 4318;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const SOURCE_CONFIG_VERSION = 1 as const;
const VERSION = "0.2.3";
const DEFAULT_SOURCE_SCOPES = Object.freeze([
  "read",
] satisfies readonly ActionScope[]);

export interface GatewaySourceConfig {
  readonly sourceId: SourceId;
  readonly displayName: string;
  readonly endpointId: string;
  readonly locator: PinnedPeerTarget["locator"];
  readonly priority: number;
  readonly enabled: boolean;
  readonly requestedScopes: readonly ActionScope[];
}

export interface GatewayAppConfig {
  readonly sharedSecret: string;
  readonly identityPath: string;
  readonly statePath: string;
  readonly sources: readonly GatewaySourceConfig[];
  readonly bindAddress: string;
  readonly port: number;
  readonly reconnectMaxMs: number;
  readonly auth?: GatewayBearerAuthConfig;
}

export function gatewayConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayAppConfig {
  rejectLegacyEnvironment(environment);
  const sharedSecret = requiredEnvironment(
    environment,
    "AGENT_MULTIPLEX_SHARED_SECRET",
  );
  if (Buffer.byteLength(sharedSecret, "utf8") < 32) {
    throw new Error(
      "AGENT_MULTIPLEX_SHARED_SECRET must contain at least 32 UTF-8 bytes",
    );
  }
  const auth = bearerAuthFromEnvironment(environment);
  const bindAddress =
    environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND ?? "127.0.0.1";
  validateGatewayBindAddress(bindAddress, auth);
  return {
    sharedSecret,
    identityPath: resolve(
      environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY ?? DEFAULT_IDENTITY_PATH,
    ),
    statePath: resolve(
      environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_STATE ?? DEFAULT_STATE_PATH,
    ),
    sources: parseSources(requiredEnvironment(
      environment,
      "AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES",
    )),
    bindAddress,
    port: portEnvironment(
      environment,
      "AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_PORT",
      DEFAULT_HTTP_PORT,
    ),
    reconnectMaxMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_ACCESS_GATEWAY_RECONNECT_MAX_MS",
      DEFAULT_RECONNECT_MAX_MS,
    ),
    ...(auth === undefined ? {} : { auth }),
  };
}

export async function runGateway(
  config: GatewayAppConfig,
  signal: AbortSignal,
  composition: GatewayComposition = {},
): Promise<void> {
  if (composition.httpSurface === undefined) {
    validateGatewayBindAddress(config.bindAddress, config.auth);
  } else if (composition.httpSurface.authentication !== "external" ||
    typeof composition.httpSurface.create !== "function" || config.auth !== undefined) {
    throw new TypeError("a custom gateway edge requires explicit external authentication and cannot combine bearer configuration");
  }
  const secretKey = await loadOrCreateGatewaySecretKey(config.identityPath);
  const store = new GatewayOperationalStore(config.statePath);
  const persisted = new Map(store.listSources().map((source) => [source.sourceId, source]));
  let p2p: P2PAccessGatewayNodeHandle | undefined;
  let http: ReturnType<typeof createGatewayHttpSurface> | undefined;
  const supervisors: Promise<void>[] = [];
  const closeTransport = (): void => {
    void p2p?.close().catch((error: unknown) => logError("closing p2prpc", error));
  };
  signal.addEventListener("abort", closeTransport, { once: true });

  try {
    p2p = await createP2PAccessGatewayNode({
      sources: config.sources.map((source) => {
        const preferred = preferredLocator(
          source,
          persisted.get(source.sourceId),
        );
        return {
          sourceId: source.sourceId,
          name: `agent-multiplex-access-gateway:${source.sourceId}`,
          requestedScopes: source.requestedScopes,
          target: {
            endpointId: source.endpointId,
            locator: preferred,
          },
          // A persisted renewal is a reachability optimization, not the only
          // route to the pinned control-node identity. Keep provisioned
          // bootstrap reachability available when that renewal expires.
          ...(preferred === source.locator
            ? {}
            : { fallbackLocator: source.locator }),
        };
      }),
      sharedSecret: {
        secret: config.sharedSecret,
        sessionTtlMs: 60 * 60_000,
      },
      iroh: {
        secretKey,
        relay: { mode: "default" },
        allowDirectAddress: () => true,
        allowRelayUrl: () => true,
      },
      onError: (error) => logError("p2prpc", error),
    });

    const clients = new Map<SourceId, P2PControlNodeSourceClient>();
    const renewedTickets = new Map<SourceId, string>();
    const definitions: GatewaySourceDefinition[] = config.sources.map((source) => {
      const handle = p2p!.sources.get(source.sourceId);
      if (!handle) throw new Error(`p2prpc source ${source.sourceId} was not created`);
      const client = new P2PControlNodeSourceClient(handle, (ticket) => {
        renewedTickets.set(source.sourceId, ticket);
      });
      clients.set(source.sourceId, client);
      return {
        sourceId: source.sourceId,
        displayName: source.displayName,
        endpointId: source.endpointId,
        priority: source.priority,
        enabled: source.enabled,
        client,
      };
    });
    const projection = new AccessGatewayProjection(definitions);

    // The HTTP edge remains useful when all sources are temporarily offline.
    await Promise.allSettled(config.sources
      .filter((source) => source.enabled)
      .map((source) => projection.refreshSource(source.sourceId)));

    http = composition.httpSurface?.create(projection, p2p.localEndpointId) ?? createGatewayHttpSurface(projection, {
      instanceId: p2p.localEndpointId,
      ...(config.auth === undefined ? {} : { auth: config.auth }),
    });
    await listen(http.server, config.port, config.bindAddress);
    const address = http.server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    console.log("Agent Multiplex access gateway");
    console.log(`Gateway endpoint: ${p2p.localEndpointId}`);
    console.log(`Sources:          ${config.sources.length}`);
    console.log(`Dashboard:        http://${config.bindAddress}:${port}`);
    console.log(`tRPC:             http://${config.bindAddress}:${port}/trpc`);

    for (const source of config.sources) {
      persistSource(
        store,
        source,
        projection,
        renewedTickets.get(source.sourceId) ??
          persisted.get(source.sourceId)?.renewedTicket,
      );
      if (!source.enabled) continue;
      supervisors.push(superviseSource(
        source,
        clients.get(source.sourceId)!,
        projection,
        store,
        renewedTickets,
        config.reconnectMaxMs,
        signal,
      ));
    }
    await aborted(signal);
  } finally {
    signal.removeEventListener("abort", closeTransport);
    await http?.close().catch((error: unknown) => logError("closing HTTP edge", error));
    await p2p?.close().catch((error: unknown) => logError("closing p2prpc", error));
    await Promise.allSettled(supervisors);
    store.close();
  }
}

async function superviseSource(
  source: GatewaySourceConfig,
  client: P2PControlNodeSourceClient,
  projection: AccessGatewayProjection,
  store: GatewayOperationalStore,
  renewedTickets: ReadonlyMap<SourceId, string>,
  reconnectMaxMs: number,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await projection.refreshSource(source.sourceId);
      const diagnostic = projection.diagnostics().find(
        (candidate) => candidate.sourceId === source.sourceId,
      );
      const manifest = diagnostic?.manifest;
      if (!manifest) throw new Error("source synchronized without a manifest");
      let cursor: StreamCursor = {
        feedId: manifest.feedId,
        controlCursor: manifest.controlCursor,
        native: {},
      };
      persistSource(
        store,
        source,
        projection,
        renewedTickets.get(source.sourceId),
        cursor,
      );
      attempt = 0;
      let resynchronize = false;
      for await (const item of client.watch(cursor, signal)) {
        if (item.kind === "streamReset") {
          // The gateway never invents missing control-node history.
          resynchronize = true;
          break;
        }
        projection.ingest(source.sourceId, item);
        cursor = advanceCursor(cursor, item);
        // Native output can be extremely chatty and remains app-server-owned;
        // do not force a FULL-sync SQLite write for every token/chunk.
        if (item.kind === "control" || item.kind === "heartbeat") {
          persistSource(
            store,
            source,
            projection,
            renewedTickets.get(source.sourceId),
            cursor,
          );
        }
        if (
          item.kind === "control" &&
          (item.change.type === "controlNode.attached" ||
            item.change.type === "controlNode.detached" ||
            item.change.type === "authority.promoted")
        ) {
          resynchronize = true;
          break;
        }
      }
      if (resynchronize) continue;
      if (!signal.aborted) throw new Error("control-node source requested resynchronization");
    } catch (error) {
      if (signal.aborted) return;
      projection.markUnavailable(source.sourceId, error);
      persistSource(
        store,
        source,
        projection,
        renewedTickets.get(source.sourceId),
      );
      const delayMs = reconnectDelay(attempt++, reconnectMaxMs);
      logError(`source ${source.sourceId} unavailable; retrying in ${delayMs}ms`, error);
      await abortableDelay(delayMs, signal);
      if (!signal.aborted) await client.reconnect().catch(() => undefined);
    }
  }
}

function advanceCursor(cursor: StreamCursor, item: AccessStreamItem): StreamCursor {
  if (item.kind === "control" || item.kind === "heartbeat") {
    return {
      ...cursor,
      feedId: item.feedId,
      controlCursor: item.kind === "control" ? item.cursor : item.controlCursor,
      native: { ...cursor.native },
    };
  }
  if (item.kind === "native") {
    return {
      ...cursor,
      native: {
        ...cursor.native,
        [item.sessionId]: {
          runtimeEpoch: item.runtimeEpoch,
          sequence: item.sequence,
        },
      },
    };
  }
  return cursor;
}

function persistSource(
  store: GatewayOperationalStore,
  source: GatewaySourceConfig,
  projection: AccessGatewayProjection,
  renewedTicket?: string,
  cursor?: Pick<StreamCursor, "feedId" | "controlCursor">,
): void {
  const diagnostic = projection.diagnostics().find(
    (candidate) => candidate.sourceId === source.sourceId,
  );
  store.putSource({
    sourceId: source.sourceId,
    displayName: source.displayName,
    endpointId: source.endpointId,
    locator: source.locator as Readonly<Record<string, unknown>>,
    priority: source.priority,
    enabled: source.enabled,
    ...(renewedTicket === undefined ? {} : { renewedTicket }),
    ...(cursor?.feedId === undefined ? {} : { feedId: cursor.feedId }),
    controlCursor: cursor?.controlCursor ?? diagnostic?.manifest?.controlCursor ?? 0,
    ...(diagnostic === undefined ? {} : { health: diagnostic }),
    updatedAt: new Date().toISOString(),
  });
}

function preferredLocator(
  configured: GatewaySourceConfig,
  persisted: ReturnType<GatewayOperationalStore["listSources"]>[number] | undefined,
): PinnedPeerTarget["locator"] {
  if (persisted?.endpointId === configured.endpointId && persisted.renewedTicket) {
    return { kind: "ticket", ticket: persisted.renewedTicket };
  }
  return configured.locator;
}

export async function loadOrCreateGatewaySecretKey(
  filename: string,
): Promise<Uint8Array> {
  try {
    const encoded = (await readFile(filename, "utf8")).trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32) {
      throw new Error(
        `${filename} must contain one base64url-encoded 32-byte Iroh key`,
      );
    }
    await chmod(filename, 0o600);
    return key;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${Buffer.from(key).toString("base64url")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporary, filename);
    await chmod(filename, 0o600);
    return key;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const encoded = (await readFile(filename, "utf8")).trim();
    const winner = Buffer.from(encoded, "base64url");
    if (winner.byteLength !== 32) {
      throw new Error(`${filename} contains an invalid Iroh key`);
    }
    await chmod(filename, 0o600);
    return winner;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function parseSources(encoded: string): readonly GatewaySourceConfig[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw new Error("AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES must be JSON", { cause });
  }
  if (!isRecord(value) || value.version !== SOURCE_CONFIG_VERSION || !Array.isArray(value.sources)) {
    throw new Error(
      "AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES must be {\"version\":1,\"sources\":[...]}",
    );
  }
  if (value.sources.length === 0) {
    throw new Error("AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES must contain at least one source");
  }
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  return Object.freeze(value.sources.map((candidate, index) => {
    if (!isRecord(candidate)) throw sourceConfigError(index, "must be an object");
    const sourceId = sourceIdSchema.parse(candidate.sourceId);
    const endpointId = requiredString(candidate.endpointId, `sources[${index}].endpointId`);
    if (ids.has(sourceId)) throw sourceConfigError(index, `duplicates sourceId ${sourceId}`);
    if (endpoints.has(endpointId)) {
      throw sourceConfigError(index, `duplicates endpointId ${endpointId}`);
    }
    ids.add(sourceId);
    endpoints.add(endpointId);
    return Object.freeze({
      sourceId,
      displayName: candidate.displayName === undefined
        ? sourceId
        : requiredString(candidate.displayName, `sources[${index}].displayName`),
      endpointId,
      locator: parseLocator(candidate.locator, index),
      priority: candidate.priority === undefined
        ? 0
        : safeInteger(candidate.priority, `sources[${index}].priority`),
      enabled: candidate.enabled === undefined
        ? true
        : requiredBoolean(candidate.enabled, `sources[${index}].enabled`),
      requestedScopes: candidate.requestedScopes === undefined
        ? DEFAULT_SOURCE_SCOPES
        : Object.freeze(actionScopesSchema.parse(candidate.requestedScopes)),
    });
  }));
}

function parseLocator(value: unknown, index: number): PinnedPeerTarget["locator"] {
  if (!isRecord(value)) throw sourceConfigError(index, "locator must be an object");
  if (value.kind === "ticket") {
    return Object.freeze({
      kind: "ticket" as const,
      ticket: requiredString(value.ticket, `sources[${index}].locator.ticket`),
    });
  }
  if (value.kind === "dns") return Object.freeze({ kind: "dns" as const });
  if (value.kind === "mdns") {
    return Object.freeze({
      kind: "mdns" as const,
      ...(value.serviceName === undefined
        ? {}
        : { serviceName: requiredString(value.serviceName, `sources[${index}].locator.serviceName`) }),
    });
  }
  throw sourceConfigError(index, "locator.kind must be ticket, dns, or mdns");
}

function bearerAuthFromEnvironment(
  environment: NodeJS.ProcessEnv,
): GatewayBearerAuthConfig | undefined {
  const authFilename = environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_FILE;
  const filename = environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE;
  if (authFilename !== undefined && filename !== undefined) {
    throw new Error(
      "AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_FILE and " +
      "AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE are mutually exclusive",
    );
  }
  if (authFilename !== undefined) {
    if (
      environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES !== undefined ||
      environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT !== undefined
    ) {
      throw new Error(
        "gateway scopes/subject are encoded in AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_FILE",
      );
    }
    let value: unknown;
    const authPath = resolve(authFilename);
    try {
      value = JSON.parse(readFileSync(authPath, "utf8"));
    } catch (cause) {
      throw new Error("AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_FILE could not be read as JSON", {
        cause,
      });
    }
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.credentials)) {
      throw new Error(
        "AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_FILE must be " +
        "{\"version\":1,\"credentials\":[...]}",
      );
    }
    return {
      credentials: value.credentials.map((candidate, index) => {
        if (!isRecord(candidate)) {
          throw new Error(`gateway auth credentials[${index}] must be an object`);
        }
        const tokenFilename = requiredString(
          candidate.bearerTokenFile,
          `credentials[${index}].bearerTokenFile`,
        );
        const bearerToken = readFileSync(
          resolve(dirname(authPath), tokenFilename),
          "utf8",
        ).trim();
        if (!bearerToken) {
          throw new Error(`gateway auth credentials[${index}] token file is empty`);
        }
        return {
          bearerToken,
          subject: requiredString(candidate.subject, `credentials[${index}].subject`),
          scopes: actionScopesSchema.parse(candidate.scopes),
        };
      }),
    };
  }
  if (filename === undefined) {
    if (
      environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES !== undefined ||
      environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT !== undefined
    ) {
      throw new Error(
        "gateway scopes/subject require AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE",
      );
    }
    return undefined;
  }
  const bearerToken = readFileSync(resolve(filename), "utf8").trim();
  if (!bearerToken) {
    throw new Error("AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE is empty");
  }
  const scopes = environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES === undefined
    ? (["read"] satisfies ActionScope[])
    : actionScopesSchema.parse(
        JSON.parse(environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES),
      );
  return {
    bearerToken,
    scopes,
    ...(environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT === undefined
      ? {}
      : { subject: environment.AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT }),
  };
}

function rejectLegacyEnvironment(environment: NodeJS.ProcessEnv): void {
  const replacements = {
    AGENT_MULTIPLEX_HOST_ENDPOINT_ID: "AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES",
    AGENT_MULTIPLEX_HOST_TICKET: "AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES",
    AGENT_MULTIPLEX_GATEWAY_IDENTITY: "AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY",
    AGENT_MULTIPLEX_GATEWAY_HTTP_BIND: "AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND",
    AGENT_MULTIPLEX_GATEWAY_HTTP_PORT: "AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_PORT",
  } satisfies Record<string, string>;
  for (const [legacy, replacement] of Object.entries(replacements)) {
    if (environment[legacy] !== undefined) {
      throw new Error(
        `${legacy} is a removed protocol-v2 environment variable; use ${replacement}`,
      );
    }
  }
}

function listen(
  server: import("node:http").Server,
  port: number,
  bindAddress: string,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindAddress);
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => {
    signal.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveDelay();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function reconnectDelay(attempt: number, maximum: number): number {
  return Math.min(maximum, 250 * 2 ** Math.min(attempt, 16));
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function portEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return parsed;
}

function positiveIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value as number;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function sourceConfigError(index: number, message: string): Error {
  return new Error(`AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES sources[${index}] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

function logError(label: string, error: unknown): void {
  console.error(`${label}:`, error instanceof Error ? error.message : error);
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let shutdownStarted = false;
  const stop = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log("Shutting down access gateway...");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runGateway(gatewayConfigFromEnvironment(), controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  : undefined;
if (entrypoint === import.meta.url) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--version") || arguments_.includes("-V")) {
    console.log(VERSION);
  } else if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log(`Agent Multiplex access gateway ${VERSION}

Usage: agent-multiplex-gateway [--help | --version]

Configuration is supplied through AGENT_MULTIPLEX_* environment variables.
See https://github.com/arduano/agent-multiplex/blob/main/apps/gateway/README.md`);
  } else {
    await main().catch((error: unknown) => {
      logError("access gateway failed", error);
      process.exitCode = 1;
    });
  }
}
