import { hostname } from "node:os";
import { isIP } from "node:net";
import { resolve } from "node:path";

import {
  actionScopesSchema,
  controlNodeIdSchema,
  type ActionScope,
  type ControlNodeId,
} from "@arduano/agent-multiplex-protocol";
import type { PinnedPeerTarget } from "@arduano/agent-multiplex-transport-p2prpc";

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_STALE_MS = 30_000;

const REMOVED_V2_ENVIRONMENT = Object.freeze({
  AGENT_MULTIPLEX_HOST_STATE: "AGENT_MULTIPLEX_CONTROL_NODE_STATE",
  AGENT_MULTIPLEX_HOST_IDENTITY: "AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY",
  AGENT_MULTIPLEX_HOST_NAME: "AGENT_MULTIPLEX_CONTROL_NODE_NAME",
  AGENT_MULTIPLEX_HOST_INSTANCE_ID: "AGENT_MULTIPLEX_CONTROL_NODE_INSTANCE_ID",
  AGENT_MULTIPLEX_HTTP_BIND: "AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND",
  AGENT_MULTIPLEX_HTTP_PORT: "AGENT_MULTIPLEX_CONTROL_NODE_HTTP_PORT",
  AGENT_MULTIPLEX_WORKER_STALE_MS: "AGENT_MULTIPLEX_CONTROL_NODE_RUNTIME_STALE_MS",
  AGENT_MULTIPLEX_CHILD_STALE_MS: "AGENT_MULTIPLEX_CONTROL_NODE_CHILD_STALE_MS",
  AGENT_MULTIPLEX_MAX_HOST_DEPTH: "AGENT_MULTIPLEX_CONTROL_NODE_MAX_DEPTH",
  AGENT_MULTIPLEX_ALLOW_ENROLLMENT: "the three role-specific control-node enrollment variables",
  AGENT_MULTIPLEX_ALLOW_WORKER_ENROLLMENT:
    "AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT",
  AGENT_MULTIPLEX_ALLOW_HOST_ENROLLMENT:
    "AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_CHILD_CONTROL_NODE_ENROLLMENT",
  AGENT_MULTIPLEX_ALLOW_OBSERVER_ENROLLMENT:
    "AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT",
  AGENT_MULTIPLEX_PARENT_ENDPOINT_ID:
    "AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ENDPOINT_ID",
  AGENT_MULTIPLEX_PARENT_TICKET:
    "AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_TICKET",
  AGENT_MULTIPLEX_PARENT_HEARTBEAT_MS:
    "AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_HEARTBEAT_MS",
} as const);

export interface ControlNodeEnrollmentConfig {
  readonly runtimeNodes: boolean;
  readonly childControlNodes: boolean;
  readonly accessGateways: boolean;
  /** Least-privilege ceiling applied even when a gateway requests more. */
  readonly accessGatewayScopes: readonly ActionScope[];
}

/** Durable desired parent. The logical and transport identities are separate pins. */
export interface DesiredControlNodeUpstream extends Readonly<Record<string, unknown>> {
  readonly version: 1;
  readonly controlNodeId: ControlNodeId;
  readonly endpointId: string;
  readonly locator: PinnedPeerTarget["locator"];
}

export interface ControlNodeAppConfig {
  readonly sharedSecret: string;
  readonly statePath: string;
  readonly identityPath: string;
  readonly name: string;
  readonly instanceId?: string;
  readonly bindAddress: string;
  readonly port: number;
  /** Stable UDP listener address used when old signed locators must survive restarts. */
  readonly p2pBindAddress?: string;
  readonly runtimeNodeStaleMs: number;
  readonly childControlNodeStaleMs: number;
  readonly enrollment: ControlNodeEnrollmentConfig;
  /** Environment bootstrap only; the catalog remains the source of truth. */
  readonly bootstrapUpstream?: DesiredControlNodeUpstream;
  readonly upstreamHeartbeatMs: number;
  readonly reconnectMaxMs: number;
}

/** Parse protocol-v4 control-node configuration without performing I/O. */
export function controlNodeConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ControlNodeAppConfig {
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

  const statePath = resolve(
    environment.AGENT_MULTIPLEX_CONTROL_NODE_STATE ??
      ".agent-multiplex/control-node.sqlite",
  );
  const identityPath = resolve(
    environment.AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY ?? `${statePath}.identity`,
  );
  if (identityPath === statePath) {
    throw new Error(
      "AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY must differ from AGENT_MULTIPLEX_CONTROL_NODE_STATE",
    );
  }

  const upstreamControlNodeId =
    environment.AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ID;
  const upstreamEndpointId =
    environment.AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ENDPOINT_ID;
  const upstreamTicket =
    environment.AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_TICKET;
  const upstreamValues = [
    upstreamControlNodeId,
    upstreamEndpointId,
    upstreamTicket,
  ];
  if (
    upstreamValues.some((value) => value !== undefined) &&
    upstreamValues.some((value) => value === undefined)
  ) {
    throw new Error(
      "AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ID, _ENDPOINT_ID, and _TICKET must be set together",
    );
  }

  const bootstrapUpstream =
    upstreamControlNodeId !== undefined &&
    upstreamEndpointId !== undefined &&
    upstreamTicket !== undefined
      ? Object.freeze({
          version: 1 as const,
          controlNodeId: controlNodeIdSchema.parse(upstreamControlNodeId),
          endpointId: nonempty(
            upstreamEndpointId,
            "AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ENDPOINT_ID",
          ),
          locator: Object.freeze({
            kind: "ticket" as const,
            ticket: nonempty(
              upstreamTicket,
              "AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_TICKET",
            ),
          }),
        })
      : undefined;

  const bindAddress =
    environment.AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND ?? "127.0.0.1";
  validateTrustedLocalBindAddress(bindAddress);
  return {
    sharedSecret,
    statePath,
    identityPath,
    name: environment.AGENT_MULTIPLEX_CONTROL_NODE_NAME ?? hostname(),
    ...(environment.AGENT_MULTIPLEX_CONTROL_NODE_INSTANCE_ID
      ? { instanceId: environment.AGENT_MULTIPLEX_CONTROL_NODE_INSTANCE_ID }
      : {}),
    bindAddress,
    port: portEnvironment(
      environment,
      "AGENT_MULTIPLEX_CONTROL_NODE_HTTP_PORT",
      4317,
    ),
    ...(environment.AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND === undefined
      ? {}
      : {
          p2pBindAddress: validatedP2PBindAddress(
            environment.AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND,
          ),
        }),
    runtimeNodeStaleMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_CONTROL_NODE_RUNTIME_STALE_MS",
      DEFAULT_STALE_MS,
    ),
    childControlNodeStaleMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_CONTROL_NODE_CHILD_STALE_MS",
      DEFAULT_STALE_MS,
    ),
    enrollment: Object.freeze({
      runtimeNodes: flagEnvironment(
        environment,
        "AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT",
      ),
      childControlNodes: flagEnvironment(
        environment,
        "AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_CHILD_CONTROL_NODE_ENROLLMENT",
      ),
      accessGateways: flagEnvironment(
        environment,
        "AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT",
      ),
      accessGatewayScopes: parseActionScopesEnvironment(
        environment,
        "AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES",
        ["read"],
      ),
    }),
    ...(bootstrapUpstream === undefined ? {} : { bootstrapUpstream }),
    upstreamHeartbeatMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_HEARTBEAT_MS",
      DEFAULT_HEARTBEAT_MS,
    ),
    reconnectMaxMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_CONTROL_NODE_RECONNECT_MAX_MS",
      DEFAULT_RECONNECT_MAX_MS,
    ),
  };
}

function parseActionScopesEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: readonly ActionScope[],
): readonly ActionScope[] {
  const value = environment[name];
  if (value === undefined) return Object.freeze([...fallback]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`${name} must be a JSON array of action scopes`, { cause });
  }
  return Object.freeze(actionScopesSchema.parse(parsed));
}

/** Validate a catalog setting before it is ever used as a dial target. */
export function parseDesiredControlNodeUpstream(
  value: Readonly<Record<string, unknown>>,
): DesiredControlNodeUpstream {
  if (value.version !== 1) {
    throw new Error("persisted desired upstream has an unsupported version");
  }
  const controlNodeId = controlNodeIdSchema.parse(value.controlNodeId);
  const endpointId = requiredString(
    value.endpointId,
    "persisted desired upstream endpointId",
  );
  const locatorValue = value.locator;
  if (!isRecord(locatorValue)) {
    throw new Error("persisted desired upstream locator must be an object");
  }
  let locator: PinnedPeerTarget["locator"];
  if (locatorValue.kind === "ticket") {
    locator = Object.freeze({
      kind: "ticket",
      ticket: requiredString(
        locatorValue.ticket,
        "persisted desired upstream ticket",
      ),
    });
  } else if (locatorValue.kind === "dns") {
    locator = Object.freeze({ kind: "dns" });
  } else if (locatorValue.kind === "mdns") {
    locator = Object.freeze({
      kind: "mdns",
      ...(locatorValue.serviceName === undefined
        ? {}
        : {
            serviceName: requiredString(
              locatorValue.serviceName,
              "persisted desired upstream mDNS serviceName",
            ),
          }),
    });
  } else {
    throw new Error("persisted desired upstream locator kind is invalid");
  }
  return Object.freeze({ version: 1, controlNodeId, endpointId, locator });
}

/** The direct control-node HTTP surface is intentionally trusted-local only. */
export function validateTrustedLocalBindAddress(bindAddress: string): void {
  const address = bindAddress.startsWith("[") && bindAddress.endsWith("]")
    ? bindAddress.slice(1, -1)
    : bindAddress;
  if (
    (isIP(address) === 4 && address.startsWith("127.")) ||
    (isIP(address) === 6 && address.toLowerCase() === "::1")
  ) return;
  throw new Error(
    "control-node HTTP is unauthenticated and may bind only to an explicit loopback IP address; use an access gateway for remote clients",
  );
}

/** Require an explicit IP and nonzero UDP port; native Iroh does no DNS here. */
export function validatedP2PBindAddress(value: string): string {
  const match = value.match(/^\[([^\]]+)]:(\d+)$/) ??
    value.match(/^([^:]+):(\d+)$/);
  const address = match?.[1];
  const portText = match?.[2];
  const port = Number(portText);
  if (
    address === undefined ||
    portText === undefined ||
    isIP(address) === 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      "AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND must be an explicit IP:port with port 1..65535",
    );
  }
  return value;
}

function rejectLegacyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const [legacy, replacement] of Object.entries(REMOVED_V2_ENVIRONMENT)) {
    if (environment[legacy] !== undefined) {
      throw new Error(
        `${legacy} is a removed protocol-v2 environment variable; use ${replacement}`,
      );
    }
  }
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return nonempty(value, name);
}

function nonempty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return nonempty(value, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flagEnvironment(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name];
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${name} must be 0, 1, false, or true`);
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
