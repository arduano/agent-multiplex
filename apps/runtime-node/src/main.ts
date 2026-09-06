#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createCodexRuntime } from "@arduano/agent-multiplex-adapter-codex";
import {
  CopilotAdapter,
  createExperimentalCopilotRuntime,
  type CopilotProviderConfig,
  type CopilotAdapterOptions,
} from "@arduano/agent-multiplex-adapter-copilot";
import { MockAgentAdapter } from "@arduano/agent-multiplex-adapter-mock";
import type { CompositeControlNodeRouter } from "@arduano/agent-multiplex-control-node-core";
import {
  metadataOperationRecordSchema,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  runtimeNodeIdSchema,
  type NativeInventoryItem,
  type RuntimeNodeBootId,
  type RuntimeNodeId,
  type SessionRecord,
} from "@arduano/agent-multiplex-protocol";
import {
  createMultiplexP2PNode,
  createRuntimeNodeRouterContext,
  type MultiplexP2PNode,
  type PinnedPeerTarget,
} from "@arduano/agent-multiplex-transport-p2prpc";
import {
  RuntimeNodeService,
  RuntimeNodeStore,
  AllowedPathPolicy,
  type RuntimePathPolicy,
  createRuntimeNodeRouter,
  type AgentAdapter,
  type TerminalProvider,
  type RuntimeNodeRouter,
  type RuntimeAgentBackend,
  type RuntimeLaunchProvider,
} from "@arduano/agent-multiplex-runtime-node-core";

import {
  PersistentControlNodeLocator,
  connectWithBootstrapFallback,
} from "./control-node-locator.js";

const IDENTITY_FILENAME = "identity.json";
const IDENTITY_VERSION = 4 as const;
const LEGACY_IDENTITY_VERSION = 3 as const;
const DATABASE_FILENAME = "runtime-node.sqlite";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_INVENTORY_REFRESH_MS = 60_000;
const DEFAULT_METADATA_FLUSH_MS = 5_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_RUNNING_TERMINALS = 32;
const VERSION = "0.2.1";

/** Embedded consumers can fail closed when their published daemon lacks this hook. */
export const runtimePathPolicyInjectionVersion = 1 as const;

type HarnessName = "codex" | "copilot";
type AdapterMode = "native" | "mock";

export interface RuntimeNodeAppConfig {
  readonly stateDirectory: string;
  readonly runtimeNodeName: string;
  readonly allowedRoots: readonly string[];
  readonly enabledHarnesses: ReadonlySet<HarnessName>;
  readonly adapterMode: AdapterMode;
  readonly sharedSecret: string;
  readonly controlNode: PinnedPeerTarget;
  readonly heartbeatMs: number;
  readonly inventoryRefreshMs: number;
  readonly metadataFlushMs: number;
  readonly reconnectMaxMs: number;
  readonly maxRunningTerminals: number;
  readonly imageOutputRoots?: readonly string[];
  readonly imageMaximumSessionBytes?: number;
  readonly imageMaximumRuntimeBytes?: number;
  readonly codexBinary?: string;
  readonly codexArgs?: readonly string[];
  readonly codexAdapterScopeId?: string;
  readonly copilotBaseDirectory?: string;
  readonly copilotAdapterScopeId?: string;
  readonly copilotExperimentalUiServer: boolean;
  readonly copilotBinary?: string;
  readonly copilotProvider?: CopilotProviderConfig;
  readonly copilotProviderDefaultModel?: string;
  readonly copilotProviderModels?: readonly string[];
  readonly copilotProviderModelCapabilities?: CopilotAdapterOptions["providerModelCapabilities"];
  readonly copilotLogLevel?:
    | "none"
    | "error"
    | "warning"
    | "info"
    | "debug"
    | "all";
  readonly mockStreamIntervalMs?: number;
  readonly mockChunkCount?: number;
}

interface PersistedRuntimeNodeIdentity {
  readonly runtimeNodeId: RuntimeNodeId;
  readonly irohSecretKey: Uint8Array;
}

type RuntimeNodeP2PNode = MultiplexP2PNode<RuntimeNodeRouter, CompositeControlNodeRouter>;
export type RuntimeNodeControlNodePeer = NonNullable<ReturnType<RuntimeNodeP2PNode["getPeer"]>>;
type ControlNodePeer = RuntimeNodeControlNodePeer;

/**
 * Start a runtime node and keep reconnecting until the signal is aborted.
 *
 * Native/control events deliberately do not use ingress.events.publish:
 * after registration the control node consumes RuntimeNodeRouter.events.subscribe over the
 * reverse side of this same connection. That is the sole event path, so an
 * event can never be duplicated by two independent pumps.
 */
export async function runRuntimeNode(
  config: RuntimeNodeAppConfig,
  signal: AbortSignal,
  options: RuntimeNodeAppOptions = {},
): Promise<void> {
  // Policy resolution has no durable or native ownership; fail before opening stores.
  const pathPolicy = options.pathPolicy ?? new AllowedPathPolicy(config.allowedRoots);
  const allowedRoots = await pathPolicy.roots();
  const identity = await loadOrCreateIdentity(config.stateDirectory);
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const store = new RuntimeNodeStore(join(config.stateDirectory, DATABASE_FILENAME));
  const controlNodeLocator = new PersistentControlNodeLocator(store, config.controlNode);
  // Canonicalize the roots before constructing a harness. Most adapters start
  // lazily, but the opt-in Copilot UI-server must be probed eagerly so a
  // broken hidden CLI can fall back without advertising terminal support.
  const runtimeConfig = { ...config, allowedRoots };
  let components: RuntimeComponents;
  try {
    components = await (options.createComponents ?? createRuntimeComponents)(runtimeConfig);
  } catch (error) {
    store.close();
    throw error;
  }
  const { adapters, terminalProviders, backends, launchProviders, includeDirectWorkspaceProvider } = components;
  let service: RuntimeNodeService;
  try {
    service = new RuntimeNodeService({
    store,
    runtimeNodeId: identity.runtimeNodeId,
    runtimeNodeBootId,
    name: config.runtimeNodeName,
    allowedRoots,
    pathPolicy,
    adapters,
    terminalProviders,
    ...(backends === undefined ? {} : { backends }),
    ...(launchProviders === undefined ? {} : { launchProviders }),
    ...(includeDirectWorkspaceProvider === undefined ? {} : { includeDirectWorkspaceProvider }),
    terminalBrokerOptions: { maxRunningTerminals: config.maxRunningTerminals },
    images: {
      directory: join(config.stateDirectory, "images"),
      outputRoots: config.imageOutputRoots ?? [],
      ...(config.imageMaximumSessionBytes === undefined ? {} : { maximumSessionBytes: config.imageMaximumSessionBytes }),
      ...(config.imageMaximumRuntimeBytes === undefined ? {} : { maximumRuntimeBytes: config.imageMaximumRuntimeBytes }),
    },
    });
  } catch (error) {
    // Registration can reject a conflicting static provider/backend. The service
    // has not taken ownership yet, so close every returned component ourselves.
    await Promise.allSettled([
      ...new Set([...adapters, ...(backends ?? []).map((backend) => backend.adapter)]),
      ...terminalProviders,
      ...(launchProviders ?? []),
    ].map(async (component) => component.close?.()));
    store.close();
    throw error;
  }
  const router = createRuntimeNodeRouter(service);
  let node: RuntimeNodeP2PNode | undefined;
  const closeTransport = (): void => {
    void node?.close().catch((error: unknown) => logError("closing p2prpc", error));
  };
  signal.addEventListener("abort", closeTransport, { once: true });

  try {
    // Resolve every configured root before opening the network listener. The
    // service repeats this policy for every spawn/resume path it accepts.
    const descriptor = await service.describe();
    node = await createMultiplexP2PNode<RuntimeNodeRouter, CompositeControlNodeRouter>({
      router,
      sharedSecret: {
        secret: config.sharedSecret,
        sessionTtlMs: 60 * 60_000,
      },
      preAuthorizePeer: (peer) => peer.id === controlNodeLocator.endpointId,
      createContext: createRuntimeNodeRouterContext,
      iroh: {
        secretKey: identity.irohSecretKey,
        relay: { mode: "default" },
        // The locator is explicitly provisioned configuration and the remote
        // endpoint key is pinned independently. Deployments with stricter
        // egress requirements should narrow these two policies.
        allowDirectAddress: () => true,
        allowRelayUrl: () => true,
      },
      onError: (error) => logError("p2prpc", error),
    });

    console.log(`Agent Multiplex runtime node ${descriptor.name}`);
    console.log(`Runtime node ID: ${identity.runtimeNodeId}`);
    console.log(`Endpoint:   ${node.id}`);
    console.log(`State:      ${config.stateDirectory}`);
    console.log(`Roots:      ${descriptor.allowedRoots.join(", ")}`);
    console.log(`Harnesses:  ${[...config.enabledHarnesses].join(", ")}`);
    console.log(`Adapters:   ${config.adapterMode}`);

    await superviseControlNodeConnection(
      node,
      service,
      runtimeNodeBootId,
      controlNodeLocator,
      config,
      signal,
    );
  } finally {
    signal.removeEventListener("abort", closeTransport);
    await node?.close().catch((error: unknown) => logError("closing p2prpc", error));
    try {
      await service.close();
    } finally {
      store.close();
    }
  }
}

async function superviseControlNodeConnection(
  node: RuntimeNodeP2PNode,
  service: RuntimeNodeService,
  runtimeNodeBootId: RuntimeNodeBootId,
  controlNodeLocator: PersistentControlNodeLocator,
  config: RuntimeNodeAppConfig,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const peer = await connectWithBootstrapFallback({
        locator: controlNodeLocator,
        connect: (target) => node.connect(target),
        onFallback: (error) => {
          logError(
            "persisted control-node ticket failed; trying configured bootstrap",
            error,
          );
        },
      });
      await register(peer, service);
      await refreshAndReconcile(peer, service, runtimeNodeBootId);
      await flushMetadataOutbox(peer, service, runtimeNodeBootId).catch((error: unknown) => {
        logError("initial metadata flush", error);
      });
      console.log(`Connected to control node ${controlNodeLocator.endpointId}`);
      attempt = 0;
      await maintainControlNodeConnection(
        peer,
        service,
        runtimeNodeBootId,
        node,
        controlNodeLocator,
        config,
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      const delayMs = reconnectDelay(attempt++, config.reconnectMaxMs);
      logError(`control-node connection lost; retrying in ${delayMs}ms`, error);
      await abortableDelay(delayMs, signal);
    }
  }
}

async function maintainControlNodeConnection(
  peer: ControlNodePeer,
  service: RuntimeNodeService,
  runtimeNodeBootId: RuntimeNodeBootId,
  node: RuntimeNodeP2PNode,
  controlNodeLocator: PersistentControlNodeLocator,
  config: RuntimeNodeAppConfig,
  signal: AbortSignal,
): Promise<void> {
  let heartbeatDue = Date.now() + config.heartbeatMs;
  let inventoryDue = Date.now() + config.inventoryRefreshMs;
  let metadataDue = Date.now() + config.metadataFlushMs;

  while (!signal.aborted) {
    const nextDue = Math.min(heartbeatDue, inventoryDue, metadataDue);
    await abortableDelay(Math.max(1, nextDue - Date.now()), signal);
    if (signal.aborted) return;

    const timestamp = Date.now();
    if (timestamp >= heartbeatDue) {
      heartbeatDue = timestamp + config.heartbeatMs;
      const heartbeat = await sendHeartbeat(peer, service, runtimeNodeBootId);
      if (!heartbeat.accepted) {
        throw new Error(
          "control node rejected this runtime-node boot; registration must be renewed",
        );
      }
      if (
        heartbeat.p2pTicket !== undefined &&
        controlNodeLocator.acceptRenewedTicket(heartbeat.p2pTicket)
      ) {
        // Update p2prpc's retained outbound target while this epoch is live so
        // its own subscription/RPC reconnections use the renewed locator too.
        await node.connect(controlNodeLocator.currentTarget());
      }
    }
    if (timestamp >= inventoryDue) {
      inventoryDue = timestamp + config.inventoryRefreshMs;
      await refreshAndReconcile(peer, service, runtimeNodeBootId);
    }
    if (timestamp >= metadataDue) {
      metadataDue = timestamp + config.metadataFlushMs;
      await flushMetadataOutbox(peer, service, runtimeNodeBootId).catch((error: unknown) => {
        // The outbox stays durable and will be retried after this error.
        logError("metadata outbox flush", error);
      });
    }
  }
}

export async function register(
  peer: ControlNodePeer,
  service: Pick<RuntimeNodeService, "describe">,
): Promise<void> {
  const registration = await service.describe();
  const result = await peer.rpc.ingress.runtimeNodes.register.mutate(registration);
  if (!result.accepted) {
    throw new Error("control node rejected runtime-node registration");
  }
}

export async function sendHeartbeat(
  peer: ControlNodePeer,
  service: Pick<RuntimeNodeService, "runtimeNodeId">,
  runtimeNodeBootId: RuntimeNodeBootId,
) {
  return peer.rpc.ingress.runtimeNodes.heartbeat.mutate({
    runtimeNodeId: service.runtimeNodeId,
    runtimeNodeBootId,
  });
}

export async function refreshAndReconcile(
  peer: ControlNodePeer,
  service: Pick<RuntimeNodeService, "refreshInventory" | "applyCanonicalSessions">,
  runtimeNodeBootId: RuntimeNodeBootId,
): Promise<void> {
  let inventory;
  try {
    inventory = await service.refreshInventory();
  } catch (error) {
    // A harness discovery failure is local and must not disconnect other
    // active runtimes. Control-node RPC failures below still escape and reconnect.
    logError("inventory refresh", error);
    return;
  }
  const result = await peer.rpc.ingress.runtimeNodes.reconcile.mutate({
    runtimeNodeId: inventory.runtimeNodeId,
    runtimeNodeBootId,
    snapshot: inventory,
  });
  assertReconciliationMatchesInventory(inventory.runtimeNodeId, inventory.sessions, result.sessions);
  service.applyCanonicalSessions(result.sessions);
}

function assertReconciliationMatchesInventory(
  runtimeNodeId: RuntimeNodeId,
  inventory: readonly NativeInventoryItem[],
  sessions: readonly SessionRecord[],
): void {
  const expected = new Set(inventory.map(nativeInventoryKey));
  if (expected.size !== inventory.length) {
    throw new Error("runtime-node inventory contains duplicate native session identities");
  }
  const observed = new Set<string>();
  for (const session of sessions) {
    if (session.runtimeNodeId !== runtimeNodeId) {
      throw new Error(
        `control node reconciled session ${session.sessionId} to another runtime node`,
      );
    }
    const key = nativeInventoryKey(session);
    if (!expected.has(key)) {
      throw new Error(
        `control node returned native session ${session.vendorSessionId} that was not submitted`,
      );
    }
    if (observed.has(key)) {
      throw new Error(
        `control node returned native session ${session.vendorSessionId} more than once`,
      );
    }
    observed.add(key);
  }
  // The authority may deliberately defer an unknown native binding while a
  // launch or legacy lifecycle operation is still resolving its preallocated
  // logical session ID. Returned records must be a valid subset of the
  // submitted inventory; a later event/reconciliation supplies the deferred
  // canonical binding without forcing the runtime connection to restart.
}

function nativeInventoryKey(
  item: Pick<NativeInventoryItem, "harness" | "adapterScopeId" | "vendorSessionId">,
): string {
  return [item.harness, item.adapterScopeId, item.vendorSessionId].join("\0");
}

export async function flushMetadataOutbox(
  peer: ControlNodePeer,
  service: Pick<
    RuntimeNodeService,
    "metadataOutbox" | "runtimeNodeId" | "settleMetadataOutbox"
  >,
  runtimeNodeBootId: RuntimeNodeBootId,
): Promise<void> {
  const patches = service.metadataOutbox();
  if (patches.length === 0) return;

  const results = metadataOperationRecordSchema.array().parse(
    await peer.rpc.ingress.metadata.pushOutbox.mutate({
      runtimeNodeId: service.runtimeNodeId,
      runtimeNodeBootId,
      patches,
    }),
  );
  service.settleMetadataOutbox(results);
}

export interface RuntimeComponents {
  adapters: readonly AgentAdapter[];
  terminalProviders: readonly TerminalProvider[];
  backends?: readonly RuntimeAgentBackend[];
  launchProviders?: readonly RuntimeLaunchProvider[];
  includeDirectWorkspaceProvider?: boolean;
}

/** Static application composition; reconnect, journal, and shutdown remain daemon-owned. */
export interface RuntimeNodeAppOptions {
  createComponents?: (config: RuntimeNodeAppConfig) => RuntimeComponents | Promise<RuntimeComponents>;
  /** Trusted static admission policy shared by startup, service and native path validation. */
  pathPolicy?: RuntimePathPolicy;
}

export async function createRuntimeComponents(
  config: RuntimeNodeAppConfig,
): Promise<RuntimeComponents> {
  if (config.adapterMode === "mock") {
    if (!config.enabledHarnesses.has("codex") || config.enabledHarnesses.size !== 1) {
      throw new Error("mock adapter mode currently requires AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex");
    }
    return {
      adapters: [new MockAgentAdapter({
        ...(config.codexAdapterScopeId
          ? { adapterScopeId: config.codexAdapterScopeId }
          : {}),
        ...(config.mockStreamIntervalMs === undefined
          ? {}
          : { streamIntervalMs: config.mockStreamIntervalMs }),
        ...(config.mockChunkCount === undefined
          ? {}
          : { chunkCount: config.mockChunkCount }),
      })],
      terminalProviders: [],
    };
  }
  const adapters: AgentAdapter[] = [];
  const terminalProviders: TerminalProvider[] = [];
  if (config.enabledHarnesses.has("codex")) {
    const runtime = createCodexRuntime({
      ...(config.codexBinary ? { binary: config.codexBinary } : {}),
      ...(config.codexArgs ? { args: config.codexArgs } : {}),
      ...(config.codexAdapterScopeId
        ? { adapterScopeId: config.codexAdapterScopeId }
        : {}),
    });
    adapters.push(runtime.adapter);
    terminalProviders.push(runtime.terminalProvider);
  }
  if (config.enabledHarnesses.has("copilot")) {
    const adapterOptions = {
      ...(config.copilotAdapterScopeId
        ? { adapterScopeId: config.copilotAdapterScopeId }
        : {}),
      clientOptions: {
        ...(config.copilotBaseDirectory
          ? { baseDirectory: config.copilotBaseDirectory }
          : {}),
        ...(config.copilotLogLevel ? { logLevel: config.copilotLogLevel } : {}),
      },
      ...(config.copilotProviderModelCapabilities ? { providerModelCapabilities: config.copilotProviderModelCapabilities } : {}),
      ...(config.copilotProvider ? { provider: config.copilotProvider } : {}),
      ...(config.copilotProviderDefaultModel
        ? { defaultModel: config.copilotProviderDefaultModel }
        : {}),
      ...(config.copilotProviderModels
        ? { providerModels: config.copilotProviderModels }
        : {}),
    };
    if (config.copilotExperimentalUiServer) {
      try {
        const runtime = await createExperimentalCopilotRuntime({
          ...adapterOptions,
          // The TUI needs a bootstrap directory before any session exists.
          // A custom policy may advertise no roots. Private runtime state is
          // already initialized and is only the TUI bootstrap, never session cwd.
          workingDirectory: config.allowedRoots[0] ?? config.stateDirectory,
          ...(config.copilotBinary ? { binary: config.copilotBinary } : {}),
        });
        adapters.push(runtime.adapter);
        terminalProviders.push(runtime.terminalProvider);
      } catch (error) {
        logError(
          "experimental Copilot UI-server unavailable; using structured adapter",
          error,
        );
        adapters.push(new CopilotAdapter(adapterOptions));
      }
    } else {
      adapters.push(new CopilotAdapter(adapterOptions));
    }
  }
  return { adapters, terminalProviders };
}

export function configFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeNodeAppConfig {
  rejectLegacyEnvironment(environment);
  const sharedSecret = requiredEnvironment(environment, "AGENT_MULTIPLEX_SHARED_SECRET");
  if (Buffer.byteLength(sharedSecret, "utf8") < 32) {
    throw new Error("AGENT_MULTIPLEX_SHARED_SECRET must contain at least 32 UTF-8 bytes");
  }
  const enabledHarnesses = parseHarnesses(
    environment.AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES ?? "codex,copilot",
  );
  const adapterMode = optionalEnum(
    environment.AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE,
    "AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE",
    ["native", "mock"] as const,
  ) ?? "native";
  const copilotLogLevel = optionalEnum(
    environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_LOG_LEVEL,
    "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_LOG_LEVEL",
    ["none", "error", "warning", "info", "debug", "all"] as const,
  );
  const copilotProvider = copilotProviderFromEnvironment(environment);
  const copilotExperimentalUiServer = booleanFlagEnvironment(
    environment,
    "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER",
    false,
  );
  return {
    stateDirectory: resolve(
      environment.AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR ?? ".agent-multiplex/runtime-node",
    ),
    runtimeNodeName: environment.AGENT_MULTIPLEX_RUNTIME_NODE_NAME ?? hostname(),
    allowedRoots: parseAllowedRoots(
      requiredEnvironment(environment, "AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS"),
    ),
    enabledHarnesses,
    imageOutputRoots: environment.AGENT_MULTIPLEX_RUNTIME_NODE_IMAGE_OUTPUT_ROOTS === undefined
      ? [] : parseAllowedRoots(environment.AGENT_MULTIPLEX_RUNTIME_NODE_IMAGE_OUTPUT_ROOTS),
    imageMaximumSessionBytes: positiveIntegerEnvironment(environment, "AGENT_MULTIPLEX_RUNTIME_NODE_IMAGE_SESSION_BYTES", 512 * 1_024 * 1_024),
    imageMaximumRuntimeBytes: positiveIntegerEnvironment(environment, "AGENT_MULTIPLEX_RUNTIME_NODE_IMAGE_RUNTIME_BYTES", 10 * 1_024 * 1_024 * 1_024),
    adapterMode,
    sharedSecret,
    controlNode: {
      endpointId: requiredEnvironment(
        environment,
        "AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID",
      ),
      locator: {
        kind: "ticket",
        ticket: requiredEnvironment(environment, "AGENT_MULTIPLEX_CONTROL_NODE_TICKET"),
      },
    },
    heartbeatMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS",
      DEFAULT_HEARTBEAT_MS,
    ),
    inventoryRefreshMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS",
      DEFAULT_INVENTORY_REFRESH_MS,
    ),
    metadataFlushMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS",
      DEFAULT_METADATA_FLUSH_MS,
    ),
    reconnectMaxMs: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS",
      DEFAULT_RECONNECT_MAX_MS,
    ),
    maxRunningTerminals: positiveIntegerEnvironment(
      environment,
      "AGENT_MULTIPLEX_RUNTIME_NODE_MAX_RUNNING_TERMINALS",
      DEFAULT_MAX_RUNNING_TERMINALS,
    ),
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_BINARY
      ? { codexBinary: environment.AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_BINARY }
      : {}),
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_ARGS
      ? {
          codexArgs: parseStringArray(
            environment.AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_ARGS,
            "AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_ARGS",
          ),
        }
      : {}),
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_SCOPE
      ? { codexAdapterScopeId: environment.AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_SCOPE }
      : {}),
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_HOME
      ? { copilotBaseDirectory: resolve(environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_HOME) }
      : {}),
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_SCOPE
      ? { copilotAdapterScopeId: environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_SCOPE }
      : {}),
    copilotExperimentalUiServer,
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY
      ? { copilotBinary: environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY }
      : {}),
    ...(copilotLogLevel ? { copilotLogLevel } : {}),
    ...copilotProvider,
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_STREAM_INTERVAL_MS === undefined
      ? {}
      : {
          mockStreamIntervalMs: nonnegativeIntegerEnvironment(
            environment,
            "AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_STREAM_INTERVAL_MS",
          ),
        }),
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_CHUNK_COUNT === undefined
      ? {}
      : {
          mockChunkCount: positiveIntegerEnvironment(
            environment,
            "AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_CHUNK_COUNT",
            8,
          ),
        }),
  };
}

function copilotProviderFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Pick<
  RuntimeNodeAppConfig,
  "copilotProvider" | "copilotProviderDefaultModel" | "copilotProviderModels" | "copilotProviderModelCapabilities"
> | Record<never, never> {
  const prefix = "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_";
  const relevant = Object.keys(environment).some((key) =>
    key.startsWith(prefix) && environment[key] !== undefined,
  );
  if (!relevant) return {};

  const baseUrl = requiredEnvironment(
    environment,
    "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL",
  );
  const model = requiredEnvironment(
    environment,
    "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL",
  );
  validateProviderUrl(baseUrl);
  const type = optionalEnum(
    environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE,
    "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE",
    ["openai", "azure", "anthropic"] as const,
  ) ?? "openai";
  const wireApi = optionalEnum(
    environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API,
    "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API",
    ["completions", "responses"] as const,
  );
  const transport = optionalEnum(
    environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT,
    "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT",
    ["http", "websockets"] as const,
  );
  const apiKeyFile = environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE;
  const bearerTokenFile =
    environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BEARER_TOKEN_FILE;
  if (apiKeyFile && bearerTokenFile) {
    throw new Error(
      "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE and " +
      "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BEARER_TOKEN_FILE are mutually exclusive",
    );
  }
  const models = environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS
    ? parseStringArray(
        environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS,
        "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS",
      )
    : [model];
  if (models.length === 0 || models.some((entry) => entry.trim().length === 0)) {
    throw new Error(
      "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS must contain non-empty model IDs",
    );
  }

  return {
    copilotProvider: {
      type,
      baseUrl,
      ...(wireApi ? { wireApi } : {}),
      ...(transport ? { transport } : {}),
      ...(apiKeyFile
        ? {
            apiKey: readSecretFile(
              apiKeyFile,
              "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE",
            ),
          }
        : {}),
      ...(bearerTokenFile
        ? {
            bearerToken: readSecretFile(
              bearerTokenFile,
              "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BEARER_TOKEN_FILE",
            ),
          }
        : {}),
    },
    ...(environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL_CAPABILITIES ? {
      copilotProviderModelCapabilities: parseProviderCapabilities(environment.AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL_CAPABILITIES),
    } : {}),
    copilotProviderDefaultModel: model,
    copilotProviderModels: models,
  };
}

function parseProviderCapabilities(encoded: string): NonNullable<CopilotAdapterOptions["providerModelCapabilities"]> {
  const fail = () => { throw new Error("AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL_CAPABILITIES must map model IDs to native model capabilities"); };
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  for (const [id, entry] of Object.entries(value)) {
    if (!id.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) return fail();
    const { supports, limits } = entry;
    if (!supports || typeof supports.vision !== "boolean" || typeof supports.reasoningEffort !== "boolean" ||
      !limits || !Number.isSafeInteger(limits.max_context_window_tokens) || limits.max_context_window_tokens < 1) return fail();
    if (limits.vision && (!Array.isArray(limits.vision.supported_media_types) ||
      !limits.vision.supported_media_types.every((type: unknown) => typeof type === "string" && type.length > 0) ||
      !Number.isSafeInteger(limits.vision.max_prompt_images) || limits.vision.max_prompt_images < 1 ||
      !Number.isSafeInteger(limits.vision.max_prompt_image_size) || limits.vision.max_prompt_image_size < 1)) return fail();
  }
  return value as NonNullable<CopilotAdapterOptions["providerModelCapabilities"]>;
}

function validateProviderUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL must be a URL", {
      cause,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL must use http or https",
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL must not contain credentials",
    );
  }
}

function readSecretFile(filename: string, environmentName: string): string {
  let value: string;
  try {
    value = readFileSync(resolve(filename), "utf8").trim();
  } catch (cause) {
    throw new Error(`${environmentName} could not be read`, { cause });
  }
  if (!value) throw new Error(`${environmentName} is empty`);
  return value;
}

async function loadOrCreateIdentity(stateDirectory: string): Promise<PersistedRuntimeNodeIdentity> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const identityPath = join(stateDirectory, IDENTITY_FILENAME);
  const existing = await readIdentity(identityPath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (existing) return existing;

  const generated = {
    runtimeNodeId: newRuntimeNodeId(),
    irohSecretKey: randomBytes(32),
  } satisfies PersistedRuntimeNodeIdentity;
  const temporaryPath = join(
    stateDirectory,
    `${IDENTITY_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await writeFile(
    temporaryPath,
    `${JSON.stringify({
      version: IDENTITY_VERSION,
      runtimeNodeId: generated.runtimeNodeId,
      irohSecretKey: Buffer.from(generated.irohSecretKey).toString("base64url"),
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  try {
    await link(temporaryPath, identityPath);
    await chmod(identityPath, 0o600);
    return generated;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // A concurrent first start won the atomic link. Both processes must use
    // the on-disk winner rather than temporarily exposing two runtime-node keys.
    return await readIdentity(identityPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readIdentity(filename: string): Promise<PersistedRuntimeNodeIdentity> {
  const value: unknown = JSON.parse(await readFile(filename, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} is not a runtime-node identity object`);
  }
  const version = Reflect.get(value, "version");
  if (version !== IDENTITY_VERSION && version !== LEGACY_IDENTITY_VERSION) {
    throw new Error(
      `${filename} is not a supported runtime-node identity`,
    );
  }
  const runtimeNodeId = runtimeNodeIdSchema.parse(Reflect.get(value, "runtimeNodeId"));
  const encodedKey = Reflect.get(value, "irohSecretKey");
  if (typeof encodedKey !== "string") {
    throw new Error(`${filename} has no encoded Iroh secret key`);
  }
  const irohSecretKey = Buffer.from(encodedKey, "base64url");
  if (irohSecretKey.byteLength !== 32) {
    throw new Error(`${filename} Iroh secret key must decode to exactly 32 bytes`);
  }
  await chmod(filename, 0o600);
  if (version === LEGACY_IDENTITY_VERSION) {
    const temporaryPath = `${filename}.${process.pid}.${randomBytes(8).toString("hex")}.v4.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      version: IDENTITY_VERSION,
      runtimeNodeId,
      irohSecretKey: Buffer.from(irohSecretKey).toString("base64url"),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await rename(temporaryPath, filename);
      await chmod(filename, 0o600);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
  return { runtimeNodeId, irohSecretKey };
}

function parseAllowedRoots(value: string): readonly string[] {
  const values = value.trimStart().startsWith("[")
    ? parseStringArray(value, "AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS")
    : value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error("AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS must contain at least one path");
  }
  return values.map((entry) => resolve(entry));
}

const LEGACY_EXACT_ENVIRONMENT_REPLACEMENTS: Readonly<Record<string, string>> =
Object.freeze({
  AGENT_MULTIPLEX_ALLOWED_ROOTS: "AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS",
  AGENT_MULTIPLEX_HARNESSES: "AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES",
  AGENT_MULTIPLEX_ADAPTER_MODE: "AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE",
  AGENT_MULTIPLEX_HEARTBEAT_MS: "AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS",
  AGENT_MULTIPLEX_INVENTORY_REFRESH_MS:
    "AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS",
  AGENT_MULTIPLEX_METADATA_FLUSH_MS:
    "AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS",
  AGENT_MULTIPLEX_RECONNECT_MAX_MS:
    "AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS",
});

function rejectLegacyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(environment).sort()) {
    if (environment[name] === undefined) continue;
    const exact = LEGACY_EXACT_ENVIRONMENT_REPLACEMENTS[name];
    if (exact) throw legacyEnvironmentError(name, exact);

    if (name.startsWith("AGENT_MULTIPLEX_WORKER_")) {
      throw legacyEnvironmentError(
        name,
        name.replace("AGENT_MULTIPLEX_WORKER_", "AGENT_MULTIPLEX_RUNTIME_NODE_"),
      );
    }
    if (name.startsWith("AGENT_MULTIPLEX_HOST_")) {
      throw legacyEnvironmentError(
        name,
        name.replace("AGENT_MULTIPLEX_HOST_", "AGENT_MULTIPLEX_CONTROL_NODE_"),
      );
    }
    if (
      name.startsWith("AGENT_MULTIPLEX_CODEX_") ||
      name.startsWith("AGENT_MULTIPLEX_COPILOT_") ||
      name.startsWith("AGENT_MULTIPLEX_MOCK_")
    ) {
      throw legacyEnvironmentError(
        name,
        name.replace("AGENT_MULTIPLEX_", "AGENT_MULTIPLEX_RUNTIME_NODE_"),
      );
    }
  }
}

function legacyEnvironmentError(name: string, replacement: string): Error {
  return new Error(
    `${name} is a removed protocol-v2 environment variable; use ${replacement}`,
  );
}

function parseHarnesses(value: string): ReadonlySet<HarnessName> {
  const harnesses = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (harnesses.length === 0) {
    throw new Error("AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES must enable codex and/or copilot");
  }
  for (const harness of harnesses) {
    if (harness !== "codex" && harness !== "copilot") {
      throw new Error(`unsupported harness in AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES: ${harness}`);
    }
  }
  return new Set(harnesses as HarnessName[]);
}

function parseStringArray(value: string, name: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON array of strings`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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

function nonnegativeIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): number {
  const value = environment[name];
  if (value === undefined) throw new Error(`${name} is required`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return parsed;
}

function booleanFlagEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${name} must be 0 or 1`);
}

function optionalEnum<const T extends readonly string[]>(
  value: string | undefined,
  name: string,
  choices: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (!choices.includes(value)) {
    throw new Error(`${name} must be one of ${choices.join(", ")}`);
  }
  return value as T[number];
}

function reconnectDelay(attempt: number, maximum: number): number {
  const exponential = Math.min(maximum, 250 * 2 ** Math.min(attempt, 16));
  return Math.max(1, Math.round(exponential * (0.8 + Math.random() * 0.4)));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

function logError(context: string, error: unknown): void {
  console.error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

async function main(): Promise<void> {
  const abort = new AbortController();
  let shutdownStarted = false;
  const requestShutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log("Shutting down runtime node...");
    abort.abort();
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  try {
    await runRuntimeNode(configFromEnvironment(), abort.signal);
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
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
    console.log(`Agent Multiplex runtime node ${VERSION}

Usage: agent-multiplex-runtime-node [--help | --version]

Configuration is supplied through AGENT_MULTIPLEX_* environment variables.
See https://github.com/arduano/agent-multiplex/blob/main/apps/runtime-node/README.md`);
  } else {
    await main().catch((error: unknown) => {
      logError("runtime node failed", error);
      process.exitCode = 1;
    });
  }
}
