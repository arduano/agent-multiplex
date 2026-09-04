import { initTRPC, TRPCError } from "@trpc/server";

import { runtimeNodeContract } from "@arduano/agent-multiplex-protocol";

import { RuntimeNodeProtocolError, RuntimeNodeService } from "./service.js";
import { LaunchProviderError } from "./launch-provider.js";
import { TerminalBrokerError } from "./terminal.js";

export interface RuntimeNodeRouterContext {
  authenticatedPeerId?: string;
}

const t = initTRPC.context<RuntimeNodeRouterContext>().create();

function toTRPC(error: unknown): never {
  if (
    error instanceof RuntimeNodeProtocolError ||
    error instanceof TerminalBrokerError ||
    error instanceof LaunchProviderError
  ) {
    const code =
      error.code === "NOT_FOUND"
        ? "NOT_FOUND"
        : error.code === "PAYLOAD_MISMATCH" || error.code === "CONFLICT"
          ? "CONFLICT"
          : error.code === "UNSUPPORTED"
            ? "METHOD_NOT_SUPPORTED"
            : error.code === "RESOURCE_EXHAUSTED"
              ? "TOO_MANY_REQUESTS"
            : "PRECONDITION_FAILED";
    throw new TRPCError({ code, message: error.message, cause: error });
  }
  throw error;
}

function assertRuntimeNodeBootId(
  service: RuntimeNodeService,
  runtimeNodeBootId: Parameters<RuntimeNodeService["assertRuntimeNodeBootId"]>[0],
): void {
  try {
    service.assertRuntimeNodeBootId(runtimeNodeBootId);
  } catch (error) {
    toTRPC(error);
  }
}

export function createRuntimeNodeRouter(service: RuntimeNodeService) {
  return t.router({
    runtimeNode: t.router({
      describe: t.procedure
        .input(runtimeNodeContract.runtimeNode.describe.input)
        .output(runtimeNodeContract.runtimeNode.describe.output)
        .query(() => service.describe()),
    }),
    inventory: t.router({
      snapshot: t.procedure
        .input(runtimeNodeContract.inventory.snapshot.input)
        .output(runtimeNodeContract.inventory.snapshot.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.inventorySnapshot();
        }),
      refresh: t.procedure
        .input(runtimeNodeContract.inventory.refresh.input)
        .output(runtimeNodeContract.inventory.refresh.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.refreshInventory();
        }),
    }),
    harness: t.router({
      catalog: t.procedure
        .input(runtimeNodeContract.harness.catalog.input)
        .output(runtimeNodeContract.harness.catalog.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.catalog();
        }),
      models: t.procedure
        .input(runtimeNodeContract.harness.models.input)
        .output(runtimeNodeContract.harness.models.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.models(input.harness);
        }),
    }),
    launchProfiles: t.router({
      list: t.procedure
        .input(runtimeNodeContract.launchProfiles.list.input)
        .output(runtimeNodeContract.launchProfiles.list.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.launchProfiles();
        }),
      models: t.procedure
        .input(runtimeNodeContract.launchProfiles.models.input)
        .output(runtimeNodeContract.launchProfiles.models.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.launchProfileModels(input.profile, input.harness).catch(toTRPC);
        }),
    }),
    launches: t.router({
      create: t.procedure
        .input(runtimeNodeContract.launches.create.input)
        .output(runtimeNodeContract.launches.create.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.createLaunch(input.request);
          } catch (error) {
            toTRPC(error);
          }
        }),
      get: t.procedure
        .input(runtimeNodeContract.launches.get.input)
        .output(runtimeNodeContract.launches.get.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.getLaunch(input.launchId);
        }),
      list: t.procedure
        .input(runtimeNodeContract.launches.list.input)
        .output(runtimeNodeContract.launches.list.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.listLaunches(input.query);
          } catch (error) {
            toTRPC(error);
          }
        }),
    }),
    sessions: t.router({
      resume: t.procedure
        .input(runtimeNodeContract.sessions.resume.input)
        .output(runtimeNodeContract.sessions.resume.output)
        .mutation(async ({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.resume(input.command).catch(toTRPC);
        }),
      stop: t.procedure
        .input(runtimeNodeContract.sessions.stop.input)
        .output(runtimeNodeContract.sessions.stop.output)
        .mutation(async ({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.stop(input.command).catch(toTRPC);
        }),
      archive: t.procedure
        .input(runtimeNodeContract.sessions.archive.input)
        .output(runtimeNodeContract.sessions.archive.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.archive(input.request);
          } catch (error) {
            toTRPC(error);
          }
        }),
      readNativeHistory: t.procedure
        .input(runtimeNodeContract.sessions.readNativeHistory.input)
        .output(runtimeNodeContract.sessions.readNativeHistory.output)
        .query(async ({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.readNativeHistory(input.sessionId, input.request).catch(toTRPC);
        }),
    }),
    archives: t.router({
      get: t.procedure
        .input(runtimeNodeContract.archives.get.input)
        .output(runtimeNodeContract.archives.get.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.getArchive(input.archiveOperationId);
        }),
    }),
    terminals: t.router({
      get: t.procedure
        .input(runtimeNodeContract.terminals.get.input)
        .output(runtimeNodeContract.terminals.get.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.terminalGet(input.request);
          } catch (error) {
            toTRPC(error);
          }
        }),
      open: t.procedure
        .input(runtimeNodeContract.terminals.open.input)
        .output(runtimeNodeContract.terminals.open.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.terminalOpen(input.request).catch(toTRPC);
        }),
      attach: t.procedure
        .input(runtimeNodeContract.terminals.attach.input)
        .subscription(async function* ({ input, signal }) {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            for await (const item of service.terminalAttach(input.request, signal)) {
              yield item;
            }
          } catch (error) {
            toTRPC(error);
          }
        }),
      lease: t.router({
        acquire: t.procedure
          .input(runtimeNodeContract.terminals.lease.acquire.input)
          .output(runtimeNodeContract.terminals.lease.acquire.output)
          .mutation(({ input }) => {
            assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
            try {
              return service.terminalLeaseAcquire(input.request);
            } catch (error) {
              toTRPC(error);
            }
          }),
        renew: t.procedure
          .input(runtimeNodeContract.terminals.lease.renew.input)
          .output(runtimeNodeContract.terminals.lease.renew.output)
          .mutation(({ input }) => {
            assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
            try {
              return service.terminalLeaseRenew(input.request);
            } catch (error) {
              toTRPC(error);
            }
          }),
        release: t.procedure
          .input(runtimeNodeContract.terminals.lease.release.input)
          .output(runtimeNodeContract.terminals.lease.release.output)
          .mutation(({ input }) => {
            assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
            try {
              return service.terminalLeaseRelease(input.request);
            } catch (error) {
              toTRPC(error);
            }
          }),
      }),
      input: t.procedure
        .input(runtimeNodeContract.terminals.input.input)
        .output(runtimeNodeContract.terminals.input.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.terminalInput(input.request);
          } catch (error) {
            toTRPC(error);
          }
        }),
      terminate: t.procedure
        .input(runtimeNodeContract.terminals.terminate.input)
        .output(runtimeNodeContract.terminals.terminate.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.terminalTerminate(input.request);
          } catch (error) {
            toTRPC(error);
          }
        }),
    }),
    commands: t.router({
      execute: t.procedure
        .input(runtimeNodeContract.commands.execute.input)
        .output(runtimeNodeContract.commands.execute.output)
        .mutation(async ({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.execute(input.command).catch(toTRPC);
        }),
      get: t.procedure
        .input(runtimeNodeContract.commands.get.input)
        .output(runtimeNodeContract.commands.get.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.getCommand(input.commandId);
        }),
    }),
    metadata: t.router({
      get: t.procedure
        .input(runtimeNodeContract.metadata.get.input)
        .output(runtimeNodeContract.metadata.get.output)
        .query(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.getMetadata(input.sessionId);
          } catch (error) {
            toTRPC(error);
          }
        }),
      enqueue: t.procedure
        .input(runtimeNodeContract.metadata.enqueue.input)
        .output(runtimeNodeContract.metadata.enqueue.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.enqueueMetadata(input.patch);
          } catch (error) {
            toTRPC(error);
          }
        }),
      settle: t.procedure
        .input(runtimeNodeContract.metadata.settle.input)
        .output(runtimeNodeContract.metadata.settle.output)
        .mutation(({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          try {
            return service.applyMetadataSettlement(input.operation);
          } catch (error) {
            toTRPC(error);
          }
        }),
    }),
    interactions: t.router({
      resolve: t.procedure
        .input(runtimeNodeContract.interactions.resolve.input)
        .output(runtimeNodeContract.interactions.resolve.output)
        .mutation(async ({ input }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.resolveInteraction(input.interaction).catch(toTRPC);
        }),
    }),
    events: t.router({
      subscribe: t.procedure
        .input(runtimeNodeContract.events.subscribe.input)
        .subscription(({ input, signal }) => {
          assertRuntimeNodeBootId(service, input.runtimeNodeBootId);
          return service.events(input.cursor, signal);
        }),
    }),
  });
}

export type RuntimeNodeRouter = ReturnType<typeof createRuntimeNodeRouter>;
