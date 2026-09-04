import {
  launchListInputSchema,
  launchRequestSchema,
  type RuntimeNodeDescriptor,
  type Harness,
  type LaunchId,
  type LaunchListInput,
  type LaunchListPage,
  type LaunchProfileDescriptor,
  type LaunchProfileIdentity,
  type LaunchProviderId,
  type LaunchRecord,
  type LaunchRequest,
  type NativeModel,
  type RuntimeNodeId,
  type SessionId,
  type SessionRecord,
} from "@arduano/agent-multiplex-protocol";

import type { AccessGatewayProjection } from "./projection.js";

/**
 * The deliberately narrow capability passed to trusted gateway launch
 * plugins. A plugin can validate domain input and suggest placement, but it
 * cannot mutate the gateway projection or author catalog state.
 */
export interface GatewayLaunchPort {
  listRuntimeNodes(): readonly RuntimeNodeDescriptor[];
  listProfiles(filter?: {
    readonly runtimeNodeId?: RuntimeNodeId;
    readonly providerId?: LaunchProviderId;
    readonly harness?: Harness;
  }): Promise<readonly LaunchProfileDescriptor[]>;
  listModels(
    runtimeNodeId: RuntimeNodeId,
    profile: LaunchProfileIdentity,
    harness: Harness,
  ): Promise<readonly NativeModel[]>;
  create(request: LaunchRequest): Promise<LaunchRecord>;
  get(launchId: LaunchId): Promise<LaunchRecord | null>;
  list(input?: LaunchListInput): Promise<LaunchListPage>;
  getSession(sessionId: SessionId): Promise<SessionRecord | null>;
}

/** Create a frozen capability view without leaking the projection object. */
export function createGatewayLaunchPort(
  projection: AccessGatewayProjection,
): GatewayLaunchPort {
  return Object.freeze({
    listRuntimeNodes: () => immutableProtocolCopy(projection.listRuntimeNodes()),
    listProfiles: async (
      filter?: Parameters<GatewayLaunchPort["listProfiles"]>[0],
    ) => immutableProtocolCopy(await projection.listLaunchProfiles(
      filter === undefined
        ? undefined
        : {
            ...(filter.runtimeNodeId === undefined
              ? {}
              : { runtimeNodeId: filter.runtimeNodeId }),
            ...(filter.providerId === undefined
              ? {}
              : { providerId: filter.providerId }),
            ...(filter.harness === undefined
              ? {}
              : { harness: filter.harness }),
          },
    )),
    listModels: async (
      runtimeNodeId: RuntimeNodeId,
      profile: LaunchProfileIdentity,
      harness: Harness,
    ) => immutableProtocolCopy(
      await projection.listLaunchModels(runtimeNodeId, profile, harness),
    ),
    create: async (request: LaunchRequest) => immutableProtocolCopy(
      await projection.createLaunch(launchRequestSchema.parse(request)),
    ),
    get: async (launchId: LaunchId) => immutableProtocolCopy(
      await projection.getLaunch(launchId),
    ),
    list: async (input?: LaunchListInput) => immutableProtocolCopy(
      await projection.listLaunches(launchListInputSchema.parse(input ?? {})),
    ),
    getSession: async (sessionId: SessionId) => immutableProtocolCopy(
      await projection.getSession(sessionId),
    ),
  });
}

export const gatewayPluginIdPattern =
  /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;

/**
 * A statically imported gateway facet. `Router` is normally a tRPC router,
 * but gateway-core stays transport-neutral so bespoke applications can embed
 * the same domain module behind another in-process composition boundary.
 */
export interface GatewayPlugin<Router = unknown> {
  readonly pluginId: string;
  readonly implementationVersion: string;
  createRouter(port: GatewayLaunchPort): Router;
}

/**
 * Instantiate trusted plugins once at startup and reject ambiguous namespaces.
 * Dynamic package loading is intentionally outside the protocol-v4 surface.
 */
export function instantiateGatewayPlugins<Router>(
  plugins: readonly GatewayPlugin<Router>[],
  port: GatewayLaunchPort,
): Readonly<Record<string, Router>> {
  const pluginIds = new Set<string>();
  for (const plugin of plugins) {
    if (
      plugin.pluginId.length > 256 ||
      !gatewayPluginIdPattern.test(plugin.pluginId)
    ) {
      throw new TypeError(
        `gateway plugin IDs must be namespaced lowercase identifiers: ${plugin.pluginId}`,
      );
    }
    if (plugin.implementationVersion.trim().length === 0) {
      throw new TypeError(
        `gateway plugin ${plugin.pluginId} has no implementation version`,
      );
    }
    if (
      plugin.implementationVersion.length > 256 ||
      plugin.implementationVersion.trim() !== plugin.implementationVersion ||
      /[\u0000-\u001f\u007f]/.test(plugin.implementationVersion)
    ) {
      throw new TypeError(
        `gateway plugin ${plugin.pluginId} has an invalid implementation version`,
      );
    }
    if (pluginIds.has(plugin.pluginId)) {
      throw new TypeError(`duplicate gateway plugin ID ${plugin.pluginId}`);
    }
    pluginIds.add(plugin.pluginId);
  }

  // Complete validation before invoking extension code. A malformed registry
  // therefore cannot partially instantiate plugins with startup side effects.
  const routers: Record<string, Router> = {};
  for (const plugin of plugins) {
    routers[plugin.pluginId] = plugin.createRouter(port);
  }
  return Object.freeze(routers);
}

/**
 * The port is a capability boundary, not merely a TypeScript interface.
 * Protocol records are plain structured data, so clone and recursively freeze
 * every value before trusted extension code receives it. This prevents a
 * plugin from mutating the gateway's selected in-memory projection by alias.
 */
function immutableProtocolCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
