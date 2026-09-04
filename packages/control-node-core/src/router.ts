import { initTRPC, TRPCError } from "@trpc/server";

import {
  accessContract,
  controlNodeIngressContract,
  controlNodeLinkContract,
  type ActionScope,
  type ControlNodeLinkFence,
  type TerminalAttachInput,
  type TerminalStreamItem,
} from "@arduano/agent-multiplex-protocol";

import { asTrpcError } from "./errors.js";
import { ControlNodeService } from "./service.js";
import type {
  AccessContext,
  CompositeControlNodeIngressContext,
} from "./types.js";

export type ControlNodeRouterContext = CompositeControlNodeIngressContext & AccessContext & {
  readonly trustedLocalAccess?: boolean | undefined;
};

const t = initTRPC.context<ControlNodeRouterContext>().create();

async function guarded<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) { throw asTrpcError(cause); }
}

function requireScope(context: ControlNodeRouterContext, scope: ActionScope): void {
  if (
    context.trustedLocalAccess === true ||
    context.grantedScopes?.includes(scope) ||
    scope === "terminal-view" && context.grantedScopes?.includes("terminal-control")
  ) return;
  throw new TRPCError({ code: "FORBIDDEN", message: `control-node access requires ${scope}` });
}

const scoped = (scope: ActionScope) => t.procedure.use(({ ctx, next }) => {
  requireScope(ctx, scope);
  return next();
});

export function createAccessRouter(service: ControlNodeService) {
  return t.router({
    system: t.router({
      describe: scoped("read")
        .input(accessContract.system.describe.input)
        .output(accessContract.system.describe.output)
        .query(() => service.describe()),
    }),
    sources: t.router({
      manifest: scoped("read")
        .input(accessContract.sources.manifest.input)
        .output(accessContract.sources.manifest.output)
        .query(() => service.sourceManifest()),
      snapshot: scoped("read")
        .input(accessContract.sources.snapshot.input)
        .output(accessContract.sources.snapshot.output)
        .query(() => service.sourceSnapshot()),
      list: scoped("read")
        .input(accessContract.sources.list.input)
        .output(accessContract.sources.list.output)
        .query(() => [{
          sourceId: "self",
          displayName: service.catalog.localControlNode().name,
          endpointId: service.catalog.localControlNode().endpointId ?? service.catalog.localControlNode().controlNodeId,
          state: "selected" as const,
          manifest: service.sourceManifest(),
          updatedAt: new Date().toISOString(),
        }]),
      watch: scoped("read")
        .input(accessContract.sources.watch.input)
        .subscription(({ signal }) => watchOwnSource(service, signal)),
    }),
    controlNodes: t.router({
      list: scoped("read")
        .input(accessContract.controlNodes.list.input)
        .output(accessContract.controlNodes.list.output)
        .query(() => service.listControlNodes()),
      get: scoped("read")
        .input(accessContract.controlNodes.get.input)
        .output(accessContract.controlNodes.get.output)
        .query(({ input }) => service.getControlNode(input)),
      watch: scoped("read")
        .input(accessContract.controlNodes.watch.input)
        .subscription(({ input, signal }) => service.watchControlNodes(input.cursor, signal)),
    }),
    topology: t.router({
      detach: scoped("topology-admin")
        .input(accessContract.topology.detach.input)
        .output(accessContract.topology.detach.output)
        .mutation(({ input }) => guarded(() => service.detachTopology(input))),
      forceDetach: scoped("topology-admin")
        .input(accessContract.topology.forceDetach.input)
        .output(accessContract.topology.forceDetach.output)
        .mutation(({ input }) => guarded(() => service.forceDetachTopology(input))),
    }),
    authority: t.router({
      promote: scoped("authority-admin")
        .input(accessContract.authority.promote.input)
        .output(accessContract.authority.promote.output)
        .mutation(({ input }) => guarded(() => service.promoteAuthority(input))),
    }),
    runtimeNodes: t.router({
      list: scoped("read")
        .input(accessContract.runtimeNodes.list.input)
        .output(accessContract.runtimeNodes.list.output)
        .query(() => service.listRuntimeNodes()),
      watch: scoped("read")
        .input(accessContract.runtimeNodes.watch.input)
        .subscription(({ input, signal }) => service.watchRuntimeNodes(input.cursor, signal)),
    }),
    harness: t.router({
      catalog: scoped("read")
        .input(accessContract.harness.catalog.input)
        .output(accessContract.harness.catalog.output)
        .query(({ input }) => service.harnessCatalog(input?.runtimeNodeId)),
      models: scoped("read")
        .input(accessContract.harness.models.input)
        .output(accessContract.harness.models.output)
        .query(({ input }) => guarded(() => service.listModels(input.runtimeNodeId, input.harness))),
    }),
    launchProfiles: t.router({
      list: scoped("read")
        .input(accessContract.launchProfiles.list.input)
        .output(accessContract.launchProfiles.list.output)
        .query(({ input }) => service.listLaunchProfiles({
          ...(input?.runtimeNodeId === undefined ? {} : { runtimeNodeId: input.runtimeNodeId }),
          ...(input?.providerId === undefined ? {} : { providerId: input.providerId }),
          ...(input?.harness === undefined ? {} : { harness: input.harness }),
        })),
      models: scoped("read")
        .input(accessContract.launchProfiles.models.input)
        .output(accessContract.launchProfiles.models.output)
        .query(({ input }) => guarded(() => service.listLaunchProfileModels(
          input.runtimeNodeId,
          input.profile,
          input.harness,
        ))),
    }),
    launches: t.router({
      create: scoped("agent-launch")
        .input(accessContract.launches.create.input)
        .output(accessContract.launches.create.output)
        .mutation(({ input }) => guarded(() => service.createLaunch(input))),
      get: scoped("read")
        .input(accessContract.launches.get.input)
        .output(accessContract.launches.get.output)
        .query(({ input }) => service.getLaunch(input)),
      list: scoped("read")
        .input(accessContract.launches.list.input)
        .output(accessContract.launches.list.output)
        .query(({ input }) => service.listLaunches(input)),
      watch: scoped("read")
        .input(accessContract.launches.watch.input)
        .subscription(({ input, signal }) => service.watchSessions({
          sessions: [],
          cursor: input.cursor,
          includeNative: false,
        }, signal)),
    }),
    sessions: t.router({
      search: scoped("read")
        .input(accessContract.sessions.search.input)
        .output(accessContract.sessions.search.output)
        .query(({ input }) => service.searchSessions(input)),
      get: scoped("read")
        .input(accessContract.sessions.get.input)
        .output(accessContract.sessions.get.output)
        .query(({ input }) => service.getSession(input)),
      refresh: scoped("agent-control")
        .input(accessContract.sessions.refresh.input)
        .output(accessContract.sessions.refresh.output)
        .mutation(({ input }) => guarded(() => service.refresh(input.runtimeNodeId))),
      resume: scoped("agent-control")
        .input(accessContract.sessions.resume.input)
        .output(accessContract.sessions.resume.output)
        .mutation(({ input }) => guarded(() => service.resume(input))),
      stop: scoped("agent-control")
        .input(accessContract.sessions.stop.input)
        .output(accessContract.sessions.stop.output)
        .mutation(({ input }) => guarded(() => service.stop(input))),
      archive: scoped("agent-archive")
        .input(accessContract.sessions.archive.input)
        .output(accessContract.sessions.archive.output)
        .mutation(({ input }) => guarded(() => service.archive(input))),
      execute: scoped("agent-control")
        .input(accessContract.sessions.execute.input)
        .output(accessContract.sessions.execute.output)
        .mutation(({ input }) => guarded(() => service.execute(input))),
      readNativeHistory: scoped("read")
        .input(accessContract.sessions.readNativeHistory.input)
        .output(accessContract.sessions.readNativeHistory.output)
        .query(({ input }) => guarded(() => service.readNativeHistory(input.sessionId, input.request))),
      watch: scoped("read")
        .input(accessContract.sessions.watch.input)
        .subscription(({ input, signal }) => service.watchSessions(input, signal)),
    }),
    archives: t.router({
      get: scoped("read")
        .input(accessContract.archives.get.input)
        .output(accessContract.archives.get.output)
        .query(({ input }) => service.getArchive(input)),
      watch: scoped("read")
        .input(accessContract.archives.watch.input)
        .subscription(({ input, signal }) => service.watchSessions({
          sessions: [],
          cursor: input.cursor,
          includeNative: false,
        }, signal)),
    }),
    terminals: t.router({
      get: scoped("terminal-view")
        .input(accessContract.terminals.get.input)
        .output(accessContract.terminals.get.output)
        .query(({ input }) => guarded(() => service.getTerminal(input))),
      open: scoped("terminal-control")
        .input(accessContract.terminals.open.input)
        .output(accessContract.terminals.open.output)
        .mutation(({ input }) => guarded(() => service.openTerminal(input))),
      attach: scoped("terminal-view")
        .input(accessContract.terminals.attach.input)
        .subscription(({ input, signal }) => accessTerminalStream(service, input, signal)),
      lease: t.router({
        acquire: scoped("terminal-control")
          .input(accessContract.terminals.lease.acquire.input)
          .output(accessContract.terminals.lease.acquire.output)
          .mutation(({ input }) => guarded(() => service.acquireTerminalLease(input))),
        renew: scoped("terminal-control")
          .input(accessContract.terminals.lease.renew.input)
          .output(accessContract.terminals.lease.renew.output)
          .mutation(({ input }) => guarded(() => service.renewTerminalLease(input))),
        release: scoped("terminal-control")
          .input(accessContract.terminals.lease.release.input)
          .output(accessContract.terminals.lease.release.output)
          .mutation(({ input }) => guarded(() => service.releaseTerminalLease(input))),
      }),
      input: scoped("terminal-control")
        .input(accessContract.terminals.input.input)
        .output(accessContract.terminals.input.output)
        .mutation(({ input }) => guarded(() => service.sendTerminalInput(input))),
      terminate: scoped("terminal-control")
        .input(accessContract.terminals.terminate.input)
        .output(accessContract.terminals.terminate.output)
        .mutation(({ input }) => guarded(() => service.terminateTerminal(input))),
    }),
    metadata: t.router({
      get: scoped("read")
        .input(accessContract.metadata.get.input)
        .output(accessContract.metadata.get.output)
        .query(({ input }) => guarded(() => service.getMetadata(input))),
      patch: scoped("metadata-propose")
        .input(accessContract.metadata.patch.input)
        .output(accessContract.metadata.patch.output)
        .mutation(({ input }) => guarded(() => service.patchMetadata(input))),
      operations: t.router({
        get: scoped("read")
          .input(accessContract.metadata.operations.get.input)
          .output(accessContract.metadata.operations.get.output)
          .query(({ input }) => service.getMetadataOperation(input)),
        list: scoped("read")
          .input(accessContract.metadata.operations.list.input)
          .output(accessContract.metadata.operations.list.output)
          .query(({ input }) => service.listMetadataOperations({
            ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input?.originControlNodeId ? { originControlNodeId: input.originControlNodeId } : {}),
            ...(input?.status ? { statuses: input.status } : {}),
            ...(input?.limit ? { limit: input.limit } : {}),
          })),
        watch: scoped("read")
          .input(accessContract.metadata.operations.watch.input)
          .subscription(({ input, signal }) => service.watchMetadataOperations(input.cursor, signal)),
      }),
    }),
    interactions: t.router({
      list: scoped("read")
        .input(accessContract.interactions.list.input)
        .output(accessContract.interactions.list.output)
        .query(({ input }) => service.listInteractions(input ?? {})),
      resolve: scoped("agent-control")
        .input(accessContract.interactions.resolve.input)
        .output(accessContract.interactions.resolve.output)
        .mutation(({ input }) => guarded(() => service.resolveInteraction(input))),
    }),
    commands: t.router({
      get: scoped("read")
        .input(accessContract.commands.get.input)
        .output(accessContract.commands.get.output)
        .query(({ input }) => service.recoverCommand(input)),
    }),
  });
}

export function createControlNodeIngressRouter(service: ControlNodeService) {
  return t.router({
    gateways: t.router({
      enroll: t.procedure
        .input(controlNodeIngressContract.gateways.enroll.input)
        .output(controlNodeIngressContract.gateways.enroll.output)
        .mutation(({ input, ctx }) => guarded(() => service.enrollGateway(input, ctx))),
    }),
    controlNodes: t.router({
      attach: t.procedure
        .input(controlNodeIngressContract.controlNodes.attach.input)
        .output(controlNodeIngressContract.controlNodes.attach.output)
        .mutation(({ input, ctx }) => guarded(() => service.attachChild(input, ctx))),
      heartbeat: t.procedure
        .input(controlNodeIngressContract.controlNodes.heartbeat.input)
        .output(controlNodeIngressContract.controlNodes.heartbeat.output)
        .mutation(({ input, ctx }) => guarded(() => service.heartbeatChild(input, ctx))),
      pushMetadataOutbox: t.procedure
        .input(controlNodeIngressContract.controlNodes.pushMetadataOutbox.input)
        .output(controlNodeIngressContract.controlNodes.pushMetadataOutbox.output)
        .mutation(({ input, ctx }) => guarded(() => service.pushChildMetadataOutbox(input, ctx))),
    }),
    runtimeNodes: t.router({
      register: t.procedure
        .input(controlNodeIngressContract.runtimeNodes.register.input)
        .output(controlNodeIngressContract.runtimeNodes.register.output)
        .mutation(({ input, ctx }) => guarded(() => service.registerRuntimeNode(input, ctx))),
      heartbeat: t.procedure
        .input(controlNodeIngressContract.runtimeNodes.heartbeat.input)
        .output(controlNodeIngressContract.runtimeNodes.heartbeat.output)
        .mutation(({ input, ctx }) => guarded(() => service.heartbeatRuntimeNode(input, ctx))),
      reconcile: t.procedure
        .input(controlNodeIngressContract.runtimeNodes.reconcile.input)
        .output(controlNodeIngressContract.runtimeNodes.reconcile.output)
        .mutation(({ input, ctx }) => guarded(() => service.reconcile(input, ctx))),
    }),
    metadata: t.router({
      pushOutbox: t.procedure
        .input(controlNodeIngressContract.metadata.pushOutbox.input)
        .output(controlNodeIngressContract.metadata.pushOutbox.output)
        .mutation(({ input, ctx }) => guarded(() => service.pushRuntimeMetadataOutbox(input, ctx))),
    }),
    events: t.router({
      publish: t.procedure
        .input(controlNodeIngressContract.events.publish.input)
        .output(controlNodeIngressContract.events.publish.output)
        .mutation(({ input, ctx }) => guarded(() => service.publishRuntimeEvent(input, ctx))),
    }),
    interactions: t.router({
      publish: t.procedure
        .input(controlNodeIngressContract.interactions.publish.input)
        .output(controlNodeIngressContract.interactions.publish.output)
        .mutation(({ input, ctx }) => guarded(() => service.publishInteraction(input, ctx))),
    }),
  });
}

export function createControlNodeLinkRouter(service: ControlNodeService) {
  const checked = <T>(ctx: ControlNodeRouterContext, fence: Parameters<ControlNodeService["assertParentLink"]>[0], operation: () => T | Promise<T>) =>
    guarded(() => { service.assertParentLink(fence, ctx); return operation(); });
  const terminalChecked = <T>(ctx: ControlNodeRouterContext, fence: Parameters<ControlNodeService["assertParentLink"]>[0], operation: () => T | Promise<T>) =>
    guarded(async () => {
      service.assertParentLink(fence, ctx);
      const result = await operation();
      service.assertParentLink(fence, ctx);
      return result;
    });
  return t.router({
    controlNode: t.router({
      describe: t.procedure
        .input(controlNodeLinkContract.controlNode.describe.input)
        .output(controlNodeLinkContract.controlNode.describe.output)
        .query(() => service.catalog.localControlNode()),
    }),
    topology: t.router({
      snapshot: t.procedure
        .input(controlNodeLinkContract.topology.snapshot.input)
        .output(controlNodeLinkContract.topology.snapshot.output)
        .query(({ input, ctx }) => guarded(() => service.readSubtreeSnapshot(input, ctx))),
      applyDetachment: t.procedure
        .input(controlNodeLinkContract.topology.applyDetachment.input)
        .output(controlNodeLinkContract.topology.applyDetachment.output)
        .mutation(({ input, ctx }) => guarded(() => service.applyDetachmentFromParent(input.receipt, input, ctx))),
    }),
    events: t.router({
      subscribe: t.procedure
        .input(controlNodeLinkContract.events.subscribe.input)
        .subscription(({ input, ctx, signal }) => service.subscribeAggregate(input.cursor, input, ctx, signal)),
    }),
    harness: t.router({
      models: t.procedure
        .input(controlNodeLinkContract.harness.models.input)
        .output(controlNodeLinkContract.harness.models.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.listModels(input.runtimeNodeId, input.harness))),
    }),
    launchProfiles: t.router({
      models: t.procedure
        .input(controlNodeLinkContract.launchProfiles.models.input)
        .output(controlNodeLinkContract.launchProfiles.models.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.listLaunchProfileModels(
          input.runtimeNodeId,
          input.profile,
          input.harness,
        ))),
    }),
    launches: t.router({
      create: t.procedure
        .input(controlNodeLinkContract.launches.create.input)
        .output(controlNodeLinkContract.launches.create.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.createLaunch(input.request))),
      get: t.procedure
        .input(controlNodeLinkContract.launches.get.input)
        .output(controlNodeLinkContract.launches.get.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.getLaunch(input.launchId))),
      list: t.procedure
        .input(controlNodeLinkContract.launches.list.input)
        .output(controlNodeLinkContract.launches.list.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.listLaunches(input.query))),
    }),
    sessions: t.router({
      search: t.procedure
        .input(controlNodeLinkContract.sessions.search.input)
        .output(controlNodeLinkContract.sessions.search.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.searchSessions(input.query))),
      get: t.procedure
        .input(controlNodeLinkContract.sessions.get.input)
        .output(controlNodeLinkContract.sessions.get.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.getSession(input.sessionId))),
      refresh: t.procedure
        .input(controlNodeLinkContract.sessions.refresh.input)
        .output(controlNodeLinkContract.sessions.refresh.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.refresh(input.runtimeNodeId))),
      resume: t.procedure
        .input(controlNodeLinkContract.sessions.resume.input)
        .output(controlNodeLinkContract.sessions.resume.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.resume(input.command))),
      stop: t.procedure
        .input(controlNodeLinkContract.sessions.stop.input)
        .output(controlNodeLinkContract.sessions.stop.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.stop(input.command))),
      archive: t.procedure
        .input(controlNodeLinkContract.sessions.archive.input)
        .output(controlNodeLinkContract.sessions.archive.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.archive(input.request))),
      readNativeHistory: t.procedure
        .input(controlNodeLinkContract.sessions.readNativeHistory.input)
        .output(controlNodeLinkContract.sessions.readNativeHistory.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.readNativeHistory(input.sessionId, input.request))),
    }),
    archives: t.router({
      get: t.procedure
        .input(controlNodeLinkContract.archives.get.input)
        .output(controlNodeLinkContract.archives.get.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.getArchive(input.archiveOperationId))),
    }),
    terminals: t.router({
      get: t.procedure
        .input(controlNodeLinkContract.terminals.get.input)
        .output(controlNodeLinkContract.terminals.get.output)
        .query(({ input, ctx }) => terminalChecked(ctx, input, () => service.getTerminal(input.request))),
      open: t.procedure
        .input(controlNodeLinkContract.terminals.open.input)
        .output(controlNodeLinkContract.terminals.open.output)
        .mutation(({ input, ctx }) => terminalChecked(ctx, input, () => service.openTerminal(input.request))),
      attach: t.procedure
        .input(controlNodeLinkContract.terminals.attach.input)
        .subscription(({ input, ctx, signal }) =>
          fencedTerminalLinkStream(service, input, ctx, signal)),
      lease: t.router({
        acquire: t.procedure
          .input(controlNodeLinkContract.terminals.lease.acquire.input)
          .output(controlNodeLinkContract.terminals.lease.acquire.output)
          .mutation(({ input, ctx }) => terminalChecked(ctx, input, () => service.acquireTerminalLease(input.request))),
        renew: t.procedure
          .input(controlNodeLinkContract.terminals.lease.renew.input)
          .output(controlNodeLinkContract.terminals.lease.renew.output)
          .mutation(({ input, ctx }) => terminalChecked(ctx, input, () => service.renewTerminalLease(input.request))),
        release: t.procedure
          .input(controlNodeLinkContract.terminals.lease.release.input)
          .output(controlNodeLinkContract.terminals.lease.release.output)
          .mutation(({ input, ctx }) => terminalChecked(ctx, input, () => service.releaseTerminalLease(input.request))),
      }),
      input: t.procedure
        .input(controlNodeLinkContract.terminals.input.input)
        .output(controlNodeLinkContract.terminals.input.output)
        .mutation(({ input, ctx }) => terminalChecked(ctx, input, () => service.sendTerminalInput(input.request))),
      terminate: t.procedure
        .input(controlNodeLinkContract.terminals.terminate.input)
        .output(controlNodeLinkContract.terminals.terminate.output)
        .mutation(({ input, ctx }) => terminalChecked(ctx, input, () => service.terminateTerminal(input.request))),
    }),
    commands: t.router({
      execute: t.procedure
        .input(controlNodeLinkContract.commands.execute.input)
        .output(controlNodeLinkContract.commands.execute.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.execute(input.command))),
      get: t.procedure
        .input(controlNodeLinkContract.commands.get.input)
        .output(controlNodeLinkContract.commands.get.output)
        .query(({ input, ctx }) => checked(ctx, input, () => service.recoverCommand(input.commandId))),
    }),
    interactions: t.router({
      resolve: t.procedure
        .input(controlNodeLinkContract.interactions.resolve.input)
        .output(controlNodeLinkContract.interactions.resolve.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.resolveInteraction(input.interaction))),
    }),
    metadata: t.router({
      settle: t.procedure
        .input(controlNodeLinkContract.metadata.settle.input)
        .output(controlNodeLinkContract.metadata.settle.output)
        .mutation(({ input, ctx }) => checked(ctx, input, () => service.applyMetadataFromParent(input.operation, input, ctx))),
    }),
  });
}

export function createCompositeControlNodeRouter(service: ControlNodeService) {
  return t.router({
    access: createAccessRouter(service),
    ingress: createControlNodeIngressRouter(service),
    link: createControlNodeLinkRouter(service),
  });
}

export type AccessRouter = ReturnType<typeof createAccessRouter>;
export type ControlNodeIngressRouter = ReturnType<typeof createControlNodeIngressRouter>;
export type ControlNodeLinkRouter = ReturnType<typeof createControlNodeLinkRouter>;
export type CompositeControlNodeRouter = ReturnType<typeof createCompositeControlNodeRouter>;

async function* accessTerminalStream(
  service: ControlNodeService,
  input: TerminalAttachInput,
  signal?: AbortSignal,
): AsyncGenerator<TerminalStreamItem> {
  try {
    for await (const item of service.attachTerminal(input, signal)) yield item;
  } catch (cause) {
    throw asTrpcError(cause);
  }
}

async function* fencedTerminalLinkStream(
  service: ControlNodeService,
  input: ControlNodeLinkFence & { request: TerminalAttachInput },
  context: ControlNodeRouterContext,
  signal?: AbortSignal,
): AsyncGenerator<TerminalStreamItem> {
  const controller = new AbortController();
  let linkInvalid = false;
  const abort = (): void => controller.abort();
  const checkLink = (): void => {
    try {
      service.assertParentLink(input, context);
    } catch {
      linkInvalid = true;
      controller.abort();
    }
  };
  try {
    service.assertParentLink(input, context);
    const unsubscribe = service.catalog.onControl(checkLink);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const item of service.attachTerminal(
        input.request,
        controller.signal,
      )) {
        if (controller.signal.aborted) break;
        service.assertParentLink(input, context);
        yield item;
      }
      if (linkInvalid) service.assertParentLink(input, context);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  } catch (cause) {
    throw asTrpcError(cause);
  }
}

async function* watchOwnSource(service: ControlNodeService, signal?: AbortSignal) {
  yield {
    sourceId: "self",
    displayName: service.catalog.localControlNode().name,
    endpointId: service.catalog.localControlNode().endpointId ?? service.catalog.localControlNode().controlNodeId,
    state: "selected" as const,
    manifest: service.sourceManifest(),
    updatedAt: new Date().toISOString(),
  };
  if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}
