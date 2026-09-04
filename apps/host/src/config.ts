import { hostname } from "node:os";
import { resolve } from "node:path";

import type { PinnedPeerTarget } from "@agent-multiplex/transport-p2prpc";

const DEFAULT_PARENT_HEARTBEAT_MS = 10_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_STALE_MS = 30_000;

export interface HostEnrollmentConfig {
  readonly workers: boolean;
  readonly childHosts: boolean;
  readonly observers: boolean;
}

export interface HostAppConfig {
  readonly sharedSecret: string;
  readonly statePath: string;
  readonly identityPath: string;
  readonly name: string;
  readonly instanceId?: string;
  readonly bindAddress: string;
  readonly port: number;
  readonly workerStaleMs: number;
  readonly childStaleMs: number;
  readonly maxHostDepth: number;
  readonly enrollment: HostEnrollmentConfig;
  readonly parent?: PinnedPeerTarget;
  readonly parentHeartbeatMs: number;
  readonly reconnectMaxMs: number;
}

/** Parse root and subordinate host configuration without performing I/O. */
export function hostConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): HostAppConfig {
  const sharedSecret = requiredEnvironment(environment, "AGENT_MULTIPLEX_SHARED_SECRET");
  if (Buffer.byteLength(sharedSecret, "utf8") < 32) {
    throw new Error(
      "AGENT_MULTIPLEX_SHARED_SECRET must contain at least 32 UTF-8 bytes",
    );
  }

  const statePath = resolve(
    environment.AGENT_MULTIPLEX_HOST_STATE ?? ".agent-multiplex/host.sqlite",
  );
  const identityPath = resolve(
    environment.AGENT_MULTIPLEX_HOST_IDENTITY ?? `${statePath}.identity`,
  );
  if (identityPath === statePath) {
    throw new Error(
      "AGENT_MULTIPLEX_HOST_IDENTITY must differ from AGENT_MULTIPLEX_HOST_STATE",
    );
  }

  const parentEndpointId = environment.AGENT_MULTIPLEX_PARENT_ENDPOINT_ID;
  const parentTicket = environment.AGENT_MULTIPLEX_PARENT_TICKET;
  if ((parentEndpointId === undefined) !== (parentTicket === undefined)) {
    throw new Error(
      "AGENT_MULTIPLEX_PARENT_ENDPOINT_ID and AGENT_MULTIPLEX_PARENT_TICKET must be set together",
    );
  }

  const legacyEnrollment = flagEnvironment(
    environment,
    "AGENT_MULTIPLEX_ALLOW_ENROLLMENT",
  );

  return {
    sharedSecret,
    statePath,
    identityPath,
    name: environment.AGENT_MULTIPLEX_HOST_NAME ?? hostname(),
    ...(environment.AGENT_MULTIPLEX_HOST_INSTANCE_ID
      ? { instanceId: environment.AGENT_MULTIPLEX_HOST_INSTANCE_ID }
      : {}),
    bindAddress: environment.AGENT_MULTIPLEX_HTTP_BIND ?? "127.0.0.1",
    port: portEnvironment(environment, "AGENT_MULTIPLEX_HTTP_PORT", 4317),
    workerStaleMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_WORKER_STALE_MS",
      DEFAULT_STALE_MS,
    ),
    childStaleMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_CHILD_STALE_MS",
      DEFAULT_STALE_MS,
    ),
    maxHostDepth: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_MAX_HOST_DEPTH",
      32,
    ),
    enrollment: {
      workers:
        legacyEnrollment ||
        flagEnvironment(environment, "AGENT_MULTIPLEX_ALLOW_WORKER_ENROLLMENT"),
      childHosts:
        legacyEnrollment ||
        flagEnvironment(environment, "AGENT_MULTIPLEX_ALLOW_HOST_ENROLLMENT"),
      observers:
        legacyEnrollment ||
        flagEnvironment(environment, "AGENT_MULTIPLEX_ALLOW_OBSERVER_ENROLLMENT"),
    },
    ...(parentEndpointId !== undefined && parentTicket !== undefined
      ? {
          parent: {
            endpointId: nonempty(parentEndpointId, "AGENT_MULTIPLEX_PARENT_ENDPOINT_ID"),
            locator: {
              kind: "ticket" as const,
              ticket: nonempty(parentTicket, "AGENT_MULTIPLEX_PARENT_TICKET"),
            },
          },
        }
      : {}),
    parentHeartbeatMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_PARENT_HEARTBEAT_MS",
      DEFAULT_PARENT_HEARTBEAT_MS,
    ),
    reconnectMaxMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_RECONNECT_MAX_MS",
      DEFAULT_RECONNECT_MAX_MS,
    ),
  };
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
