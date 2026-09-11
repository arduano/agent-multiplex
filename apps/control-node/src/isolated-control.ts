import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  ControlNodeCoreError, IsolatedRpc, IsolatedStreams,
  type ControlNodeCatalog, type ControlNodeRouterContext, type CompositeControlNodeRouter,
  type ChildControlNodeConnection,
} from "@arduano/agent-multiplex-control-node-core";
import { actionScopesSchema, type ActionScope, type ControlNodeDescriptor } from "@arduano/agent-multiplex-protocol";
import {
  createControlNodeP2PNode, createMultiplexRoleAuthorization, childControlNodeConnectionFromPeerResolver,
  type MultiplexP2PNode, type MultiplexPeerAuthorization, type ChildControlNodePeerBinding,
} from "@arduano/agent-multiplex-transport-p2prpc";
import type { AnyTRPCRouter } from "@trpc/server";
import type { ControlNodeAppConfig } from "./config.js";
import { validateTrustedLocalBindAddress } from "./config.js";
import type { ControlNodeAppOptions } from "./main.js";
import { loadOrCreateControlNodeSecretKey } from "./identity.js";
import { createControlNodeHttpSurfaceFromRouter } from "./http.js";
import { createIsolatedControlRouter, createIsolatedAccessRouter } from "./isolated-router.js";

type ReverseDescriptor = ChildControlNodePeerBinding & { endpointId: string };
type Enrollment = ReturnType<ControlNodeCatalog["activePeerEnrollment"]>;
const reverseMethods = new Set<string>([
  "readSubtreeSnapshot", "listModels", "listLaunchProfileModels", "refreshInventory", "createLaunch", "getLaunch", "listLaunches", "searchSessions", "getSession", "resume", "stop", "archive", "getArchive", "execute", "readNativeState", "readNativeHistory", "beginImageUpload", "writeImageUpload", "commitImageUpload", "abortImageUpload", "resolveImagePath", "readImage", "imageLimits", "getTerminal", "openTerminal", "acquireTerminalLease", "renewTerminalLease", "releaseTerminalLease", "sendTerminalInput", "terminateTerminal", "resolveInteraction", "getCommand", "applyMetadata", "applyDetachment",
] satisfies Array<keyof ChildControlNodeConnection>);

/** Single storage owner. A timeout retires response acceptance, never ownership.
 * No replacement worker is started automatically, even if shutdown cannot drain. */
export class IsolatedControlOwner {
  readonly rpc: IsolatedRpc;
  readonly #worker: Worker;
  readonly #streams = new IsolatedStreams();
  #progressAt = 0;
  #metrics: unknown;
  #failed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  readonly #loop = monitorEventLoopDelay({ resolution: 20 });
  #childFeedFailures = 0;
  constructor(config: Pick<ControlNodeAppConfig, "statePath" | "name" | "childControlNodeStaleMs" | "enrollment">, instanceId: string,
    connection: (descriptor: ReverseDescriptor) => ChildControlNodeConnection, options: { worker?: Worker } = {}) {
    this.#worker = options.worker ?? new Worker(new URL(import.meta.url.endsWith(".ts") ? "./isolated-control-worker.ts" : "./isolated-control-worker.js", import.meta.url), {
      workerData: { statePath: config.statePath, name: config.name, instanceId, scopes: [...config.enrollment.accessGatewayScopes], childStaleMs: config.childControlNodeStaleMs },
    });
    this.#loop.enable();
    this.rpc = new IsolatedRpc(this.#worker, async (method, args) => {
      if (method === "reverse.call") {
        const [descriptor, operation, input] = args as [ReverseDescriptor, keyof ChildControlNodeConnection, unknown[]];
        if (!reverseMethods.has(operation)) throw new ControlNodeCoreError("UNSUPPORTED", "unknown isolated reverse operation");
        const peer = connection(descriptor); const call = peer[operation];
        if (typeof call !== "function") throw new ControlNodeCoreError("UNSUPPORTED", "reverse operation unavailable");
        return await (call as (...values: unknown[]) => unknown).apply(peer, input);
      }
      if (method === "stream.open") {
        if (args[0] !== "reverse") throw new ControlNodeCoreError("UNSUPPORTED", "unknown isolated reverse stream");
        const [descriptor, operation, input] = args[1] as [ReverseDescriptor, string, unknown[]];
        const peer = connection(descriptor);
        if (operation === "subscribeAggregate") return this.#streams.open(signal => peer.subscribeAggregate(input[0] as Parameters<ChildControlNodeConnection["subscribeAggregate"]>[0], signal));
        if (operation === "attachTerminal" && peer.attachTerminal) return this.#streams.open(signal => peer.attachTerminal!(input[0] as Parameters<NonNullable<ChildControlNodeConnection["attachTerminal"]>>[0], signal));
        throw new ControlNodeCoreError("UNSUPPORTED", "reverse stream unavailable");
      }
      if (method === "stream.next") return this.#streams.next(Number(args[0]));
      if (method === "stream.close") return this.#streams.close(Number(args[0]));
      throw new ControlNodeCoreError("UNSUPPORTED", "unknown isolated transport operation");
    });
    this.#worker.on("message", message => {
      if (message.kind === "storage.progress") { this.#progressAt = Date.now(); this.#metrics = message.metrics; }
      if (message.kind === "storage.failed") this.#failed = true;
      if (message.kind === "storage.event" && message.event === "child-feed-failed") this.#childFeedFailures++;
    });
    this.#worker.on("error", () => { this.#failed = true; this.rpc.close(); });
    this.#worker.on("exit", () => { if (!this.#closing) this.#failed = true; this.rpc.close(); });
  }
  health() {
    const progressAgeMs = this.#progressAt ? Date.now() - this.#progressAt : null;
    return { ready: !this.#failed && !this.#closing && progressAgeMs !== null && progressAgeMs < 10_000,
      storage: this.#failed ? "unavailable" : progressAgeMs === null ? "starting" : progressAgeMs >= 10_000 ? "stalled" : "responsive",
      progressAgeMs, queue: this.rpc.diagnostics(), metrics: this.#metrics, childFeedFailures: this.#childFeedFailures,
      transportEventLoop: { meanMs: Number.isFinite(this.#loop.mean) ? this.#loop.mean / 1e6 : 0, maximumMs: this.#loop.max / 1e6 } };
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true; this.#streams.closeAll(); this.#loop.disable();
    this.#closePromise = this.rpc.call<void>("close", [], { timeoutMs: 15_000 }).finally(() => {
      this.rpc.close();
      // Termination may remain pending in kernel I/O. Do not await it forever,
      // clear writer locks or launch another writer behind it.
      void this.#worker.terminate().catch(() => {});
      this.#worker.unref();
    });
    return this.#closePromise;
  }
}

/** Authority-only composition: catalog and domain service run in one worker;
 * HTTP, QUIC, authentication and bounded reverse transport run on this thread. */
export async function runIsolatedAuthorityControlNode(config: ControlNodeAppConfig, signal: AbortSignal, options: ControlNodeAppOptions = {}): Promise<void> {
  validateTrustedLocalBindAddress(config.bindAddress);
  if (config.bootstrapUpstream || config.enrollment.runtimeNodes) throw new Error("isolated authority does not enroll runtimes or attach to a parent");
  const instanceId = config.instanceId ?? randomUUID();
  const secretKey = await loadOrCreateControlNodeSecretKey(config.identityPath);
  let node: MultiplexP2PNode<CompositeControlNodeRouter, AnyTRPCRouter> | undefined;
  const owner = new IsolatedControlOwner(config, instanceId, descriptor => childControlNodeConnectionFromPeerResolver(
    descriptor.endpointId, () => node?.getPeerAs<AnyTRPCRouter>(descriptor.endpointId), descriptor, descriptor.endpointId,
  ));
  let http: ReturnType<typeof createControlNodeHttpSurfaceFromRouter> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let closing = false;
  let initialized = false;
  let lastLogAt = 0;
  const diagnostic = () => {
    if (Date.now() - lastLogAt < 60_000 || process.stderr.writableLength > 64 * 1024) return;
    lastLogAt = Date.now();
    process.stderr.write("Control transport or locator operation failed; inspect loopback /health for storage progress.\n");
  };
  const enrollment = (endpoint: string) => owner.rpc.call<Enrollment>("enrollment", [endpoint], { timeoutMs: 5_000 });
  try {
    // SQLite open/integrity checks may spend minutes in the filesystem. Keep
    // health responsive without turning a slow opener into a restart loop.
    // Reject domain requests before admission until initialization completes.
    http = createControlNodeHttpSurfaceFromRouter(createIsolatedAccessRouter(owner.rpc, () => initialized), () => ({ ...owner.health(), ready: initialized && owner.health().ready }));
    await new Promise<void>((resolve, reject) => { http!.server.once("error", reject); http!.server.listen(config.port, config.bindAddress, () => { http!.server.off("error", reject); resolve(); }); });
    await waitForIsolatedStorage(owner.rpc, signal);
    const router = createIsolatedControlRouter(owner.rpc);
    node = await createControlNodeP2PNode<CompositeControlNodeRouter, AnyTRPCRouter>({
      router,
      sharedSecret: { secret: config.sharedSecret, sessionTtlMs: 60 * 60_000, authorize: async context => {
        const stored = await enrollment(context.remotePeerId);
        const role = stored?.role;
        const authorization: MultiplexPeerAuthorization | undefined = role === "child-control-node" || role === "access-gateway"
          ? { role, scopes: new Set<ActionScope>(actionScopesSchema.parse(stored!.scopes)) } : undefined;
        return createMultiplexRoleAuthorization({
          authorizationForPrincipal: (principal, endpoint) => principal === endpoint ? authorization : undefined,
          allowChildControlNodeEnrollment: config.enrollment.childControlNodes,
          allowAccessGatewayEnrollment: config.enrollment.accessGateways,
        })(context);
      } },
      authorizePeerEndpoint: async endpoint => !!(await enrollment(endpoint)) || config.enrollment.childControlNodes || config.enrollment.accessGateways,
      createContext: (context): ControlNodeRouterContext => ({ authenticatedActorId: context.p2p.peer.id, endpointId: context.p2p.peer.id }),
      iroh: { secretKey, ...(config.p2pBindAddress ? { bindAddress: config.p2pBindAddress } : {}), ticketTtlMs: 30 * 24 * 60 * 60_000,
        relay: { mode: "default" }, allowAdvertisedAddress: () => true, allowDirectAddress: () => true, allowRelayUrl: () => true },
      onError: diagnostic,
    });
    const createTicket = async () => {
      if (closing || signal.aborted || !node) throw new Error("control node is closing");
      const ticket = await node.createTicket();
      await owner.rpc.call("ticket", [ticket]); return ticket;
    };
    const ticket = await node.createTicket();
    const local = await owner.rpc.call<ControlNodeDescriptor>("initialize", [node.id, ticket], { mutation: true });
    const address = http.server.address(); const port = address && typeof address === "object" ? address.port : config.port;
    await options.onReady?.({ controlNodeId: local.controlNodeId, endpointId: node.id, ticket, httpUrl: `http://${config.bindAddress}:${port}`, createTicket });
    initialized = true;
    refresh = setInterval(() => {
      if (closing || refreshing || signal.aborted) return;
      refreshing = true;
      void createTicket().catch(diagnostic).finally(() => { refreshing = false; });
    }, 10 * 60_000); refresh.unref();
    console.log(`Agent Multiplex control node ${instanceId} (isolated authority)`);
    console.log(`Control node ID: ${local.controlNodeId}`);
    console.log(`P2P endpoint:    ${node.id}`);
    if (options.printTicket ?? true) console.log(`P2P ticket (reachability locator; not a credential):\n${ticket}`);
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    closing = true; clearInterval(refresh);
    try { await http?.close(); }
    finally { try { await node?.close(); } finally { await owner.close(); } }
  }
}

/** Startup has one retained read, no storage deadline and explicit shutdown. */
export async function waitForIsolatedStorage(rpc: IsolatedRpc, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason ?? new Error("control startup cancelled"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { await Promise.race([rpc.call("identity", [], { timeoutMs: 0 }), aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}
