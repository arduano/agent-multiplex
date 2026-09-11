import { parentPort, workerData } from "node:worker_threads";
import {
  ControlNodeCatalog, ControlNodeService, ControlNodeCoreError, createCompositeControlNodeRouter,
  IsolatedRpc, IsolatedStreams, isolatedStream,
  type ChildControlNodeConnection, type ControlNodeRouterContext,
} from "@arduano/agent-multiplex-control-node-core";
import type { ActionScope, ControlNodeId, ControlNodeBootId } from "@arduano/agent-multiplex-protocol";

const port = parentPort!;
const data = workerData as { statePath: string; name: string; instanceId: string; scopes: ActionScope[]; childStaleMs: number };
const streams = new IsolatedStreams();
let catalog: ControlNodeCatalog;
let service: ControlNodeService;
let ticket: string | undefined;
let router: ReturnType<typeof createCompositeControlNodeRouter>;
let staleSweep: ReturnType<typeof setInterval> | undefined;
let progress: ReturnType<typeof setInterval> | undefined;
let closing = false;
const invocations = new Set<Promise<unknown>>();
const connectionMethods = new Set<string>([
  "readSubtreeSnapshot", "subscribeAggregate", "listModels", "listLaunchProfileModels", "refreshInventory", "createLaunch", "getLaunch", "listLaunches", "searchSessions", "getSession", "resume", "stop", "archive", "getArchive", "execute", "readNativeState", "readNativeHistory", "beginImageUpload", "writeImageUpload", "commitImageUpload", "abortImageUpload", "resolveImagePath", "readImage", "imageLimits", "getTerminal", "openTerminal", "attachTerminal", "acquireTerminalLease", "renewTerminalLease", "releaseTerminalLease", "sendTerminalInput", "terminateTerminal", "resolveInteraction", "getCommand", "applyMetadata", "applyDetachment",
] satisfies Array<keyof ChildControlNodeConnection>);
const rpc = new IsolatedRpc(port, async (method, args) => {
  await ready;
  if (closing && method !== "stream.close") throw new ControlNodeCoreError("UNAVAILABLE", "control storage owner is closing");
  if (method === "identity") return catalog.localControlNode();
  if (method === "enrollment") return catalog.activePeerEnrollment(String(args[0]));
  if (method === "initialize") { catalog.setLocalEndpointId(String(args[0])); ticket = String(args[1]); return catalog.localControlNode(); }
  if (method === "ticket") { ticket = String(args[0]); return; }
  if (method === "storage.metrics") return catalog.storageMetrics();
  if (method === "router") return invoke(String(args[0]), args[1], args[2] as Context);
  if (method === "stream.open") {
    if (args[0] !== "router") throw new ControlNodeCoreError("UNSUPPORTED", "unknown isolated stream operation");
    const [path, input, context] = args[1] as [string, unknown, Context];
    return streams.openAsync(async signal => await invoke(path, input, context, signal) as AsyncIterable<unknown>);
  }
  if (method === "stream.next") return streams.next(Number(args[0]));
  if (method === "stream.close") return streams.close(Number(args[0]));
  if (method === "close") {
    closing = true;
    clearInterval(staleSweep); clearInterval(progress); streams.closeAll(); service.close();
    // Stop accepting work, then allow admitted domain operations to settle.
    // A blocked dependency keeps this pending; the owner reports shutdown
    // failure instead of acknowledging a drain which never happened.
    await Promise.allSettled([...invocations]);
    catalog.close();
    setImmediate(() => { rpc.close(); port.close(); }); return;
  }
  throw new ControlNodeCoreError("UNSUPPORTED", "unknown isolated control operation");
});
const ready = Promise.resolve().then(() => {
  catalog = new ControlNodeCatalog({ filename: data.statePath, controlNodeName: data.name });
  // This composition deliberately isolates an authority with child controls.
  // It never adopts a branch or moves runtime ownership as an upgrade shortcut.
  if (catalog.dataRole().role !== "authority" || catalog.desiredUpstream() !== null ||
      catalog.listRuntimeNodes().some(node => node.ownerControlNodeId === catalog.localControlNode().controlNodeId)) {
    catalog.close(); throw new Error("isolated authority requires no parent or local runtimes");
  }
  service = new ControlNodeService({ catalog, instanceId: data.instanceId, p2pTicket: () => ticket,
    grantedGatewayScopes: request => data.scopes.filter(scope => request.requestedScopes.includes(scope)),
    onChildControlNodePumpError: () => port.postMessage({ kind: "storage.event", event: "child-feed-failed" }),
  });
  router = createCompositeControlNodeRouter(service);
  staleSweep = setInterval(() => { catalog.markStaleChildren(new Date(Date.now() - data.childStaleMs)); catalog.expireInteractions(); }, Math.max(1_000, Math.min(15_000, data.childStaleMs / 2)));
  staleSweep.unref();
  progress = setInterval(() => port.postMessage({ kind: "storage.progress", at: Date.now(), metrics: catalog.storageMetrics() }), 1_000);
  progress.unref();
  port.postMessage({ kind: "storage.progress", at: Date.now(), metrics: catalog.storageMetrics() });
});
void ready.catch(() => { port.postMessage({ kind: "storage.failed" }); });

type Context = Pick<ControlNodeRouterContext, "authenticatedActorId" | "endpointId" | "trustedLocalAccess">;
async function invoke(path: string, input: unknown, plain: Context, signal?: AbortSignal): Promise<unknown> {
  if (!Object.hasOwn(router._def.procedures, path)) throw new ControlNodeCoreError("UNSUPPORTED", "unknown isolated control procedure");
  if (path === "ingress.runtimeNodes.register") throw new ControlNodeCoreError("UNSUPPORTED", "isolated authority does not own runtimes");
  const enrollment = plain.endpointId ? catalog.activePeerEnrollment(plain.endpointId) : null;
  const context: ControlNodeRouterContext = { ...plain,
    ...(enrollment?.role === "access-gateway" ? { grantedScopes: enrollment.scopes as ActionScope[] } : {}),
    ...(enrollment?.role === "child-control-node" ? { authenticatedControlNodeId: enrollment.principalId as ControlNodeId } : {}),
    createChildControlNodeConnection: identity => childConnection(identity.controlNodeId, identity.controlNodeBootId, plain.endpointId!),
  };
  const caller = router.createCaller(context, { ...(signal ? { signal } : {}) });
  let procedure: unknown = caller;
  for (const part of path.split(".")) procedure = Reflect.get(procedure as object, part);
  const result = (procedure as (value: unknown) => Promise<unknown>)(input);
  invocations.add(result);
  try { return await result; } finally { invocations.delete(result); }
}
function childConnection(controlNodeId: ControlNodeId, controlNodeBootId: ControlNodeBootId, endpointId: string): ChildControlNodeConnection {
  const properties = { controlNodeId, controlNodeBootId, endpointId };
  // First attachment constructs its reverse port before the catalog admits the
  // edge. Capture the immutable edge only when that port is first used, after
  // the child's first fenced heartbeat. Subsequent reattachments cannot rebind it.
  let original = catalog.getAttachment(controlNodeId);
  const descriptor = () => {
    const attachment = catalog.getAttachment(controlNodeId);
    original ??= attachment;
    if (!attachment || !original || attachment.attachmentId !== original.attachmentId || attachment.lineageId !== original.lineageId) throw new ControlNodeCoreError("FENCED", "child attachment is no longer current");
    return { ...properties, attachmentId: attachment.attachmentId, lineageId: attachment.lineageId };
  };
  return new Proxy(properties, { get(target, key) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key);
    if (typeof key !== "string" || !connectionMethods.has(key as keyof ChildControlNodeConnection)) return undefined;
    if (key === "subscribeAggregate" || key === "attachTerminal") return (input: unknown, signal?: AbortSignal) => isolatedStream(rpc, "reverse", [descriptor(), key, [input]], signal);
    return (...args: unknown[]) => rpc.call("reverse.call", [descriptor(), key, args], { mutation: !["readSubtreeSnapshot", "listModels", "listLaunchProfileModels", "refreshInventory", "getLaunch", "listLaunches", "searchSessions", "getSession", "getArchive", "readNativeState", "readNativeHistory", "readImage", "imageLimits", "getTerminal", "getCommand"].includes(key) });
  } }) as ChildControlNodeConnection;
}
