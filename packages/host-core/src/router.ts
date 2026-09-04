import { initTRPC } from "@trpc/server";

import {
  fleetContract,
  hostIngressContract,
  hostLinkContract,
} from "@agent-multiplex/protocol";

import { asTrpcError } from "./errors.js";
import { HostService } from "./service.js";
import type { CompositeHostIngressContext } from "./types.js";

/** One transport context carries observer, worker, child, or parent identity. */
const hostTrpc = initTRPC.context<CompositeHostIngressContext>().create();

async function guarded<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asTrpcError(error);
  }
}

export function createFleetRouter(service: HostService) {
  return hostTrpc.router({
    system: hostTrpc.router({
      describe: hostTrpc.procedure
        .input(fleetContract.system.describe.input)
        .output(fleetContract.system.describe.output)
        .query(() => service.describe()),
    }),
    hosts: hostTrpc.router({
      list: hostTrpc.procedure
        .input(fleetContract.hosts.list.input)
        .output(fleetContract.hosts.list.output)
        .query(() => service.listHosts()),
      get: hostTrpc.procedure
        .input(fleetContract.hosts.get.input)
        .output(fleetContract.hosts.get.output)
        .query(({ input }) => service.getHost(input)),
      watch: hostTrpc.procedure
        .input(fleetContract.hosts.watch.input)
        .subscription(({ input, signal }) => service.watchHosts(input.cursor, signal)),
    }),
    authority: hostTrpc.router({
      offerHandoff: hostTrpc.procedure
        .input(fleetContract.authority.offerHandoff.input)
        .output(fleetContract.authority.offerHandoff.output)
        .mutation(({ input }) => guarded(() => service.offerAuthorityHandoff(input))),
      acceptHandoff: hostTrpc.procedure
        .input(fleetContract.authority.acceptHandoff.input)
        .output(fleetContract.authority.acceptHandoff.output)
        .mutation(({ input }) => guarded(() => service.acceptAuthorityHandoff(input))),
      consumeHandoff: hostTrpc.procedure
        .input(fleetContract.authority.consumeHandoff.input)
        .output(fleetContract.authority.consumeHandoff.output)
        .mutation(({ input }) => guarded(() => service.consumeAuthorityHandoff(input))),
      forceAdopt: hostTrpc.procedure
        .input(fleetContract.authority.forceAdopt.input)
        .output(fleetContract.authority.forceAdopt.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.forceAdoptAuthority(input, ctx)),
        ),
    }),
    workers: hostTrpc.router({
      list: hostTrpc.procedure
        .input(fleetContract.workers.list.input)
        .output(fleetContract.workers.list.output)
        .query(() => service.listWorkers()),
      watch: hostTrpc.procedure
        .input(fleetContract.workers.watch.input)
        .subscription(({ input, signal }) => service.watchWorkers(input.cursor, signal)),
    }),
    harness: hostTrpc.router({
      catalog: hostTrpc.procedure
        .input(fleetContract.harness.catalog.input)
        .output(fleetContract.harness.catalog.output)
        .query(({ input }) => guarded(() => service.harnessCatalog(input?.workerId))),
      models: hostTrpc.procedure
        .input(fleetContract.harness.models.input)
        .output(fleetContract.harness.models.output)
        .query(({ input }) => guarded(() => service.listModels(input.workerId, input.harness))),
    }),
    sessions: hostTrpc.router({
      list: hostTrpc.procedure
        .input(fleetContract.sessions.list.input)
        .output(fleetContract.sessions.list.output)
        .query(({ input }) => service.listSessions(input ?? {})),
      get: hostTrpc.procedure
        .input(fleetContract.sessions.get.input)
        .output(fleetContract.sessions.get.output)
        .query(({ input }) => service.getSession(input)),
      refresh: hostTrpc.procedure
        .input(fleetContract.sessions.refresh.input)
        .output(fleetContract.sessions.refresh.output)
        .mutation(({ input }) => guarded(() => service.refresh(input.workerId))),
      spawn: hostTrpc.procedure
        .input(fleetContract.sessions.spawn.input)
        .output(fleetContract.sessions.spawn.output)
        .mutation(({ input }) => guarded(() => service.spawn(input))),
      resume: hostTrpc.procedure
        .input(fleetContract.sessions.resume.input)
        .output(fleetContract.sessions.resume.output)
        .mutation(({ input }) => guarded(() => service.resume(input))),
      execute: hostTrpc.procedure
        .input(fleetContract.sessions.execute.input)
        .output(fleetContract.sessions.execute.output)
        .mutation(({ input }) => guarded(() => service.execute(input))),
      readNativeHistory: hostTrpc.procedure
        .input(fleetContract.sessions.readNativeHistory.input)
        .output(fleetContract.sessions.readNativeHistory.output)
        .query(({ input }) =>
          guarded(() => service.readNativeHistory(input.sessionId, input.request)),
        ),
      watch: hostTrpc.procedure
        .input(fleetContract.sessions.watch.input)
        .subscription(({ input, signal }) => service.watchSessions(input, signal)),
    }),
    metadata: hostTrpc.router({
      get: hostTrpc.procedure
        .input(fleetContract.metadata.get.input)
        .output(fleetContract.metadata.get.output)
        .query(({ input }) => guarded(() => service.getMetadata(input))),
      patch: hostTrpc.procedure
        .input(fleetContract.metadata.patch.input)
        .output(fleetContract.metadata.patch.output)
        .mutation(({ input }) => guarded(() => service.patchMetadata(input))),
      operations: hostTrpc.router({
        get: hostTrpc.procedure
          .input(fleetContract.metadata.operations.get.input)
          .output(fleetContract.metadata.operations.get.output)
          .query(({ input }) => service.getMetadataOperation(input)),
        list: hostTrpc.procedure
          .input(fleetContract.metadata.operations.list.input)
          .output(fleetContract.metadata.operations.list.output)
          .query(({ input }) =>
            service.listMetadataOperations({
              ...(input?.sessionId === undefined ? {} : { sessionId: input.sessionId }),
              ...(input?.originHostId === undefined
                ? {}
                : { originHostId: input.originHostId }),
              ...(input?.status === undefined ? {} : { statuses: input.status }),
              ...(input?.limit === undefined ? {} : { limit: input.limit }),
            }),
          ),
        watch: hostTrpc.procedure
          .input(fleetContract.metadata.operations.watch.input)
          .subscription(({ input, signal }) =>
            service.watchMetadataOperations(input.cursor, signal),
          ),
      }),
    }),
    interactions: hostTrpc.router({
      list: hostTrpc.procedure
        .input(fleetContract.interactions.list.input)
        .output(fleetContract.interactions.list.output)
        .query(({ input }) => service.listInteractions(input ?? {})),
      resolve: hostTrpc.procedure
        .input(fleetContract.interactions.resolve.input)
        .output(fleetContract.interactions.resolve.output)
        .mutation(({ input }) => guarded(() => service.resolveInteraction(input))),
    }),
    commands: hostTrpc.router({
      get: hostTrpc.procedure
        .input(fleetContract.commands.get.input)
        .output(fleetContract.commands.get.output)
        .query(({ input }) => guarded(() => service.recoverCommand(input))),
    }),
  });
}

export function createHostIngressRouter(service: HostService) {
  return hostTrpc.router({
    observers: hostTrpc.router({
      enroll: hostTrpc.procedure
        .input(hostIngressContract.observers.enroll.input)
        .output(hostIngressContract.observers.enroll.output)
        .mutation(({ input, ctx }) => guarded(() => service.enrollObserver(input, ctx))),
    }),
    hosts: hostTrpc.router({
      attach: hostTrpc.procedure
        .input(hostIngressContract.hosts.attach.input)
        .output(hostIngressContract.hosts.attach.output)
        .mutation(({ input, ctx }) => guarded(() => service.attachChild(input, ctx))),
      heartbeat: hostTrpc.procedure
        .input(hostIngressContract.hosts.heartbeat.input)
        .output(hostIngressContract.hosts.heartbeat.output)
        .mutation(({ input, ctx }) => guarded(() => service.heartbeatChild(input, ctx))),
      pushMetadataOutbox: hostTrpc.procedure
        .input(hostIngressContract.hosts.pushMetadataOutbox.input)
        .output(hostIngressContract.hosts.pushMetadataOutbox.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.pushChildMetadataOutbox(input, ctx)),
        ),
    }),
    authority: hostTrpc.router({
      offerHandoff: hostTrpc.procedure
        .input(hostIngressContract.authority.offerHandoff.input)
        .output(hostIngressContract.authority.offerHandoff.output)
        .mutation(({ input }) => guarded(() => service.offerAuthorityHandoff(input))),
      acceptHandoff: hostTrpc.procedure
        .input(hostIngressContract.authority.acceptHandoff.input)
        .output(hostIngressContract.authority.acceptHandoff.output)
        .mutation(({ input }) => guarded(() => service.acceptAuthorityHandoff(input))),
      consumeHandoff: hostTrpc.procedure
        .input(hostIngressContract.authority.consumeHandoff.input)
        .output(hostIngressContract.authority.consumeHandoff.output)
        .mutation(({ input }) => guarded(() => service.consumeAuthorityHandoff(input))),
      forceAdopt: hostTrpc.procedure
        .input(hostIngressContract.authority.forceAdopt.input)
        .output(hostIngressContract.authority.forceAdopt.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.forceAdoptAuthority(input, ctx)),
        ),
    }),
    workers: hostTrpc.router({
      register: hostTrpc.procedure
        .input(hostIngressContract.workers.register.input)
        .output(hostIngressContract.workers.register.output)
        .mutation(({ input, ctx }) => guarded(() => service.registerWorker(input, ctx))),
      heartbeat: hostTrpc.procedure
        .input(hostIngressContract.workers.heartbeat.input)
        .output(hostIngressContract.workers.heartbeat.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.heartbeat(input.workerId, input.workerBootId, ctx)),
        ),
      reconcile: hostTrpc.procedure
        .input(hostIngressContract.workers.reconcile.input)
        .output(hostIngressContract.workers.reconcile.output)
        .mutation(({ input, ctx }) => guarded(() => service.reconcile(input, ctx))),
    }),
    metadata: hostTrpc.router({
      pushOutbox: hostTrpc.procedure
        .input(hostIngressContract.metadata.pushOutbox.input)
        .output(hostIngressContract.metadata.pushOutbox.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.pushMetadataOutbox(input.workerId, input.patches, ctx)),
        ),
    }),
    events: hostTrpc.router({
      publish: hostTrpc.procedure
        .input(hostIngressContract.events.publish.input)
        .output(hostIngressContract.events.publish.output)
        .mutation(({ input, ctx }) => guarded(() => service.publishWorkerEvent(input, ctx))),
    }),
    interactions: hostTrpc.router({
      publish: hostTrpc.procedure
        .input(hostIngressContract.interactions.publish.input)
        .output(hostIngressContract.interactions.publish.output)
        .mutation(({ input, ctx }) => guarded(() => service.publishInteraction(input, ctx))),
    }),
  });
}

export function createHostLinkRouter(service: HostService) {
  return hostTrpc.router({
    host: hostTrpc.router({
      describe: hostTrpc.procedure
        .input(hostLinkContract.host.describe.input)
        .output(hostLinkContract.host.describe.output)
        .query(({ ctx }) => guarded(() => service.describeHost(ctx))),
    }),
    topology: hostTrpc.router({
      snapshot: hostTrpc.procedure
        .input(hostLinkContract.topology.snapshot.input)
        .output(hostLinkContract.topology.snapshot.output)
        .query(({ input, ctx }) => guarded(() => service.readSubtreeSnapshot(input, ctx))),
    }),
    events: hostTrpc.router({
      subscribe: hostTrpc.procedure
        .input(hostLinkContract.events.subscribe.input)
        .subscription(({ input, ctx, signal }) =>
          service.subscribeAggregate(input, ctx, signal),
        ),
    }),
    harness: hostTrpc.router({
      models: hostTrpc.procedure
        .input(hostLinkContract.harness.models.input)
        .output(hostLinkContract.harness.models.output)
        .query(({ input, ctx }) => guarded(() => service.listModelsFromParent(input, ctx))),
    }),
    sessions: hostTrpc.router({
      refresh: hostTrpc.procedure
        .input(hostLinkContract.sessions.refresh.input)
        .output(hostLinkContract.sessions.refresh.output)
        .mutation(({ input, ctx }) => guarded(() => service.refreshFromParent(input, ctx))),
      spawn: hostTrpc.procedure
        .input(hostLinkContract.sessions.spawn.input)
        .output(hostLinkContract.sessions.spawn.output)
        .mutation(({ input, ctx }) => guarded(() => service.spawnFromParent(input, ctx))),
      resume: hostTrpc.procedure
        .input(hostLinkContract.sessions.resume.input)
        .output(hostLinkContract.sessions.resume.output)
        .mutation(({ input, ctx }) => guarded(() => service.resumeFromParent(input, ctx))),
      readNativeHistory: hostTrpc.procedure
        .input(hostLinkContract.sessions.readNativeHistory.input)
        .output(hostLinkContract.sessions.readNativeHistory.output)
        .query(({ input, ctx }) =>
          guarded(() => service.readNativeHistoryFromParent(input, ctx)),
        ),
    }),
    commands: hostTrpc.router({
      execute: hostTrpc.procedure
        .input(hostLinkContract.commands.execute.input)
        .output(hostLinkContract.commands.execute.output)
        .mutation(({ input, ctx }) => guarded(() => service.executeFromParent(input, ctx))),
      get: hostTrpc.procedure
        .input(hostLinkContract.commands.get.input)
        .output(hostLinkContract.commands.get.output)
        .query(({ input, ctx }) => guarded(() => service.getCommandFromParent(input, ctx))),
    }),
    interactions: hostTrpc.router({
      resolve: hostTrpc.procedure
        .input(hostLinkContract.interactions.resolve.input)
        .output(hostLinkContract.interactions.resolve.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.resolveInteractionFromParent(input, ctx)),
        ),
    }),
    metadata: hostTrpc.router({
      settle: hostTrpc.procedure
        .input(hostLinkContract.metadata.settle.input)
        .output(hostLinkContract.metadata.settle.output)
        .mutation(({ input, ctx }) => guarded(() => service.applyMetadataFromParent(input, ctx))),
    }),
    authority: hostTrpc.router({
      offerHandoff: hostTrpc.procedure
        .input(hostLinkContract.authority.offerHandoff.input)
        .output(hostLinkContract.authority.offerHandoff.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.offerAuthorityHandoffFromParent(input, ctx)),
        ),
      acceptHandoff: hostTrpc.procedure
        .input(hostLinkContract.authority.acceptHandoff.input)
        .output(hostLinkContract.authority.acceptHandoff.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.acceptAuthorityHandoffFromParent(input, ctx)),
        ),
      consumeHandoff: hostTrpc.procedure
        .input(hostLinkContract.authority.consumeHandoff.input)
        .output(hostLinkContract.authority.consumeHandoff.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.consumeAuthorityHandoffFromParent(input, ctx)),
        ),
      forceAdopt: hostTrpc.procedure
        .input(hostLinkContract.authority.forceAdopt.input)
        .output(hostLinkContract.authority.forceAdopt.output)
        .mutation(({ input, ctx }) =>
          guarded(() => service.forceAdoptAuthorityFromParent(input, ctx)),
        ),
    }),
  });
}

export function createCompositeHostRouter(service: HostService) {
  return hostTrpc.router({
    fleet: createFleetRouter(service),
    ingress: createHostIngressRouter(service),
    link: createHostLinkRouter(service),
  });
}

export type FleetRouter = ReturnType<typeof createFleetRouter>;
export type HostIngressRouter = ReturnType<typeof createHostIngressRouter>;
export type HostLinkRouter = ReturnType<typeof createHostLinkRouter>;
export type CompositeHostRouter = ReturnType<typeof createCompositeHostRouter>;
