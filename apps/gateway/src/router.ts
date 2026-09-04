import { initTRPC, TRPCError } from "@trpc/server";
import { observable, type Observable } from "@trpc/server/observable";

import {
  AccessGatewayProjection,
  GatewayRoutingError,
} from "@arduano/agent-multiplex-gateway-core";
import {
  accessContract,
  accessStreamItemSchema,
  sourceDiagnosticSchema,
  type AccessAttachInput,
  type AccessStreamItem,
  type ActionScope,
  type StreamCursor,
} from "@arduano/agent-multiplex-protocol";

import {
  requireGatewayActionScope,
  type GatewayAuthContext,
} from "./auth.js";

const gatewayTrpc = initTRPC.context<GatewayAuthContext>().create();

const scoped = (scope: ActionScope) =>
  gatewayTrpc.procedure.use(({ ctx, next }) => {
    requireGatewayActionScope(ctx, scope);
    return next();
  });

const read = scoped("read");
const agentLaunch = scoped("agent-launch");
const agentArchive = scoped("agent-archive");
const agentControl = scoped("agent-control");
const terminalView = scoped("terminal-view");
const terminalControl = scoped("terminal-control");
const metadataPropose = scoped("metadata-propose");
const topologyAdmin = scoped("topology-admin");
const authorityAdmin = scoped("authority-admin");

export interface AccessGatewayRouterOptions {
  readonly instanceId: string;
}

/**
 * Browser-facing protocol-v4 access surface. Every read comes from the
 * gateway's selected projection and every mutation is dispatched exactly once
 * by that projection to the one selected control-node source.
 */
export function createAccessGatewayRouter(
  projection: AccessGatewayProjection,
  options: AccessGatewayRouterOptions,
) {
  if (options.instanceId.length === 0) {
    throw new TypeError("access gateway instanceId must not be empty");
  }

  return gatewayTrpc.router({
    system: gatewayTrpc.router({
      describe: read
        .input(accessContract.system.describe.input)
        .output(accessContract.system.describe.output)
        .query(() => ({
          application: "agent-multiplex" as const,
          protocolVersion: 4 as const,
          instanceId: options.instanceId,
          componentKind: "access-gateway" as const,
          dataAuthority: "none" as const,
          capabilities: [
            "sources.multi-control-node",
            "sources.ancestor-wins",
            "stream.synthetic-bounded",
            "auth.scoped-actions",
            "launch.profiles.v1",
            "sessions.catalog-lifecycle.v1",
            "terminal.side-channel.v1",
          ],
        })),
    }),
    sources: gatewayTrpc.router({
      manifest: read
        .input(accessContract.sources.manifest.input)
        .output(accessContract.sources.manifest.output)
        .query(() => null),
      snapshot: read
        .input(accessContract.sources.snapshot.input)
        .output(accessContract.sources.snapshot.output)
        .query(() => null),
      list: read
        .input(accessContract.sources.list.input)
        .output(accessContract.sources.list.output)
        .query(() => projection.diagnostics()),
      watch: read
        .input(accessContract.sources.watch.input)
        .subscription(({ signal }) =>
          fromAsyncIterable(
            (subscriptionSignal) => projection.watchSources(subscriptionSignal),
            signal,
            sourceDiagnosticSchema.parse,
          ),
        ),
    }),
    controlNodes: gatewayTrpc.router({
      list: read
        .input(accessContract.controlNodes.list.input)
        .output(accessContract.controlNodes.list.output)
        .query(() => projection.listControlNodes()),
      get: read
        .input(accessContract.controlNodes.get.input)
        .output(accessContract.controlNodes.get.output)
        .query(({ input }) => projection.getControlNode(input)),
      watch: read
        .input(accessContract.controlNodes.watch.input)
        .subscription(({ input, signal }) =>
          accessStream(
            projection,
            input.cursor,
            signal,
            (item) =>
              item.kind !== "control" ||
              item.change.type.startsWith("controlNode.") ||
              item.change.type.startsWith("authority."),
          ),
        ),
    }),
    topology: gatewayTrpc.router({
      detach: topologyAdmin
        .input(accessContract.topology.detach.input)
        .output(accessContract.topology.detach.output)
        .mutation(({ input }) => guarded(() => projection.detach(input))),
      forceDetach: topologyAdmin
        .input(accessContract.topology.forceDetach.input)
        .output(accessContract.topology.forceDetach.output)
        .mutation(({ input }) => guarded(() => projection.forceDetach(input))),
    }),
    authority: gatewayTrpc.router({
      promote: authorityAdmin
        .input(accessContract.authority.promote.input)
        .output(accessContract.authority.promote.output)
        .mutation(({ input }) => guarded(() => projection.promote(input))),
    }),
    runtimeNodes: gatewayTrpc.router({
      list: read
        .input(accessContract.runtimeNodes.list.input)
        .output(accessContract.runtimeNodes.list.output)
        .query(() => projection.listRuntimeNodes()),
      watch: read
        .input(accessContract.runtimeNodes.watch.input)
        .subscription(({ input, signal }) =>
          accessStream(
            projection,
            input.cursor,
            signal,
            (item) =>
              item.kind !== "control" ||
              item.change.type.startsWith("runtimeNode.") ||
              item.change.type === "inventory.completed",
          ),
        ),
    }),
    harness: gatewayTrpc.router({
      catalog: read
        .input(accessContract.harness.catalog.input)
        .output(accessContract.harness.catalog.output)
        .query(({ input }) =>
          guarded(() => projection.listHarnessCatalog(input?.runtimeNodeId)),
        ),
      models: read
        .input(accessContract.harness.models.input)
        .output(accessContract.harness.models.output)
        .query(({ input }) =>
          guarded(() => projection.listModels(input.runtimeNodeId, input.harness)),
        ),
    }),
    launchProfiles: gatewayTrpc.router({
      list: read
        .input(accessContract.launchProfiles.list.input)
        .output(accessContract.launchProfiles.list.output)
        .query(({ input }) => guarded(() => projection.listLaunchProfiles(
          input === undefined
            ? undefined
            : {
                ...(input.runtimeNodeId === undefined
                  ? {}
                  : { runtimeNodeId: input.runtimeNodeId }),
                ...(input.providerId === undefined
                  ? {}
                  : { providerId: input.providerId }),
                ...(input.harness === undefined
                  ? {}
                  : { harness: input.harness }),
              },
        ))),
      models: read
        .input(accessContract.launchProfiles.models.input)
        .output(accessContract.launchProfiles.models.output)
        .query(({ input }) => guarded(() => projection.listLaunchModels(
          input.runtimeNodeId,
          input.profile,
          input.harness,
        ))),
    }),
    launches: gatewayTrpc.router({
      create: agentLaunch
        .input(accessContract.launches.create.input)
        .output(accessContract.launches.create.output)
        .mutation(({ input }) => guarded(() => projection.createLaunch(input))),
      get: read
        .input(accessContract.launches.get.input)
        .output(accessContract.launches.get.output)
        .query(({ input }) => guarded(() => projection.getLaunch(input))),
      list: read
        .input(accessContract.launches.list.input)
        .output(accessContract.launches.list.output)
        .query(({ input }) => guarded(() => projection.listLaunches(input))),
      watch: read
        .input(accessContract.launches.watch.input)
        .subscription(({ input, signal }) =>
          accessStream(
            projection,
            input.cursor,
            signal,
            (item) =>
              item.kind !== "control" || item.change.type === "launch.changed",
          ),
        ),
    }),
    sessions: gatewayTrpc.router({
      search: read
        .input(accessContract.sessions.search.input)
        .output(accessContract.sessions.search.output)
        .query(({ input }) => guarded(() => projection.searchSessions(input))),
      get: read
        .input(accessContract.sessions.get.input)
        .output(accessContract.sessions.get.output)
        .query(({ input }) => guarded(() => projection.getSession(input))),
      refresh: agentControl
        .input(accessContract.sessions.refresh.input)
        .output(accessContract.sessions.refresh.output)
        .mutation(({ input }) => guarded(() => projection.refresh(input.runtimeNodeId))),
      resume: agentControl
        .input(accessContract.sessions.resume.input)
        .output(accessContract.sessions.resume.output)
        .mutation(({ input }) => guarded(() => projection.resume(input))),
      stop: agentControl
        .input(accessContract.sessions.stop.input)
        .output(accessContract.sessions.stop.output)
        .mutation(({ input }) => guarded(() => projection.stop(input))),
      archive: agentArchive
        .input(accessContract.sessions.archive.input)
        .output(accessContract.sessions.archive.output)
        .mutation(({ input }) => guarded(() => projection.archive(input))),
      execute: agentControl
        .input(accessContract.sessions.execute.input)
        .output(accessContract.sessions.execute.output)
        .mutation(({ input }) => guarded(() => projection.execute(input))),
      readNativeHistory: read
        .input(accessContract.sessions.readNativeHistory.input)
        .output(accessContract.sessions.readNativeHistory.output)
        .query(({ input }) =>
          guarded(() => projection.readNativeHistory(input.sessionId, input.request)),
        ),
      watch: read
        .input(accessContract.sessions.watch.input)
        .subscription(({ input, signal }) => sessionStream(projection, input, signal)),
    }),
    archives: gatewayTrpc.router({
      get: read
        .input(accessContract.archives.get.input)
        .output(accessContract.archives.get.output)
        .query(({ input }) => guarded(() => projection.getArchive(input))),
      watch: read
        .input(accessContract.archives.watch.input)
        .subscription(({ input, signal }) =>
          accessStream(
            projection,
            input.cursor,
            signal,
            (item) =>
              item.kind !== "control" || item.change.type === "archive.changed",
          ),
        ),
    }),
    terminals: gatewayTrpc.router({
      get: terminalView
        .input(accessContract.terminals.get.input)
        .output(accessContract.terminals.get.output)
        .query(({ input }) => guarded(() => projection.getTerminal(input))),
      open: terminalControl
        .input(accessContract.terminals.open.input)
        .output(accessContract.terminals.open.output)
        .mutation(({ input }) => guarded(() => projection.openTerminal(input))),
      attach: terminalView
        .input(accessContract.terminals.attach.input)
        .subscription(({ input, signal }) =>
          fromAsyncIterable(
            (subscriptionSignal) => projection.attachTerminal(input, subscriptionSignal),
            signal,
            (value) => accessContract.terminals.attach.output.parse(value),
          ),
        ),
      lease: gatewayTrpc.router({
        acquire: terminalControl
          .input(accessContract.terminals.lease.acquire.input)
          .output(accessContract.terminals.lease.acquire.output)
          .mutation(({ input }) => guarded(() => projection.acquireTerminalLease(input))),
        renew: terminalControl
          .input(accessContract.terminals.lease.renew.input)
          .output(accessContract.terminals.lease.renew.output)
          .mutation(({ input }) => guarded(() => projection.renewTerminalLease(input))),
        release: terminalControl
          .input(accessContract.terminals.lease.release.input)
          .output(accessContract.terminals.lease.release.output)
          .mutation(({ input }) => guarded(() => projection.releaseTerminalLease(input))),
      }),
      input: terminalControl
        .input(accessContract.terminals.input.input)
        .output(accessContract.terminals.input.output)
        .mutation(({ input }) => guarded(() => projection.sendTerminalInput(input))),
      terminate: terminalControl
        .input(accessContract.terminals.terminate.input)
        .output(accessContract.terminals.terminate.output)
        .mutation(({ input }) => guarded(() => projection.terminateTerminal(input))),
    }),
    metadata: gatewayTrpc.router({
      get: read
        .input(accessContract.metadata.get.input)
        .output(accessContract.metadata.get.output)
        .query(({ input }) => guarded(async () => {
          const session = await projection.getSession(input);
          if (!session) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `session ${input} was not found`,
            });
          }
          return session.metadata;
        })),
      patch: metadataPropose
        .input(accessContract.metadata.patch.input)
        .output(accessContract.metadata.patch.output)
        .mutation(({ input }) => guarded(() => projection.patchMetadata(input))),
      operations: gatewayTrpc.router({
        get: read
          .input(accessContract.metadata.operations.get.input)
          .output(accessContract.metadata.operations.get.output)
          .query(({ input }) => projection.getMetadataOperation(input)),
        list: read
          .input(accessContract.metadata.operations.list.input)
          .output(accessContract.metadata.operations.list.output)
          .query(({ input }) => projection.listMetadataOperations()
            .filter((operation) =>
              (input?.sessionId === undefined ||
                operation.sessionId === input.sessionId) &&
              (input?.originControlNodeId === undefined ||
                operation.originControlNodeId === input.originControlNodeId) &&
              (input?.status === undefined || input.status.includes(operation.status)),
            )
            .slice(0, input?.limit ?? 100)),
        watch: read
          .input(accessContract.metadata.operations.watch.input)
          .subscription(({ input, signal }) =>
            accessStream(
              projection,
              input.cursor,
              signal,
              (item) =>
                item.kind !== "control" ||
                item.change.type.startsWith("metadata."),
            ),
          ),
      }),
    }),
    interactions: gatewayTrpc.router({
      list: read
        .input(accessContract.interactions.list.input)
        .output(accessContract.interactions.list.output)
        .query(({ input }) => projection.listInteractions().filter((interaction) =>
          (input?.sessionId === undefined ||
            interaction.sessionId === input.sessionId) &&
          (input?.pendingOnly === false || interaction.state === "pending"),
        )),
      resolve: agentControl
        .input(accessContract.interactions.resolve.input)
        .output(accessContract.interactions.resolve.output)
        .mutation(({ input }) => guarded(() => projection.resolveInteraction(input))),
    }),
    commands: gatewayTrpc.router({
      get: read
        .input(accessContract.commands.get.input)
        .output(accessContract.commands.get.output)
        .query(({ input }) => guarded(() => projection.getCommand(input))),
    }),
  });
}

export type AccessGatewayRouter = ReturnType<typeof createAccessGatewayRouter>;

async function guarded<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw asGatewayError(cause);
  }
}

function accessStream(
  projection: AccessGatewayProjection,
  cursor: StreamCursor | undefined,
  signal: AbortSignal | undefined,
  include: (item: AccessStreamItem) => boolean,
): Observable<AccessStreamItem, unknown> {
  return fromAsyncIterable(
    (subscriptionSignal) => projection.watchControl(cursor, subscriptionSignal),
    signal,
    (value) => accessStreamItemSchema.parse(value),
    include,
  );
}

function sessionStream(
  projection: AccessGatewayProjection,
  input: AccessAttachInput,
  signal: AbortSignal | undefined,
): Observable<AccessStreamItem, unknown> {
  return fromAsyncIterable(
    (subscriptionSignal) => projection.attach(input, subscriptionSignal),
    signal,
    (value) => accessStreamItemSchema.parse(value),
  );
}

function fromAsyncIterable<TInput, TOutput>(
  createIterable: (signal: AbortSignal) => AsyncIterable<TInput>,
  signal: AbortSignal | undefined,
  parse: (input: TInput) => TOutput,
  include: (item: TOutput) => boolean = () => true,
): Observable<TOutput, unknown> {
  return observable((observer) => {
    const controller = new AbortController();
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      signal?.removeEventListener("abort", stop);
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    void (async () => {
      try {
        for await (const value of createIterable(controller.signal)) {
          if (stopped) break;
          const item = parse(value);
          if (include(item)) observer.next(item);
        }
        if (!stopped) observer.complete();
      } catch (cause) {
        if (!stopped) observer.error(asGatewayError(cause));
      } finally {
        stop();
      }
    })();
    return stop;
  });
}

function asGatewayError(cause: unknown): TRPCError {
  if (cause instanceof TRPCError) return cause;
  if (cause instanceof GatewayRoutingError) {
    const code = cause.code === "NOT_FOUND"
      ? "NOT_FOUND"
      : cause.code === "CONFLICT"
        ? "CONFLICT"
        : cause.code === "UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : cause.code === "UNAUTHORIZED"
            ? "BAD_GATEWAY"
            : cause.code === "UNSUPPORTED"
              ? "METHOD_NOT_SUPPORTED"
              : cause.code === "INTERNAL"
                ? "INTERNAL_SERVER_ERROR"
                : "BAD_GATEWAY";
    const message = cause.code === "NOT_FOUND"
      ? "gateway source did not find the requested resource"
      : cause.code === "CONFLICT"
        ? "gateway source rejected conflicting state"
        : cause.code === "UNAVAILABLE"
          ? "gateway source is unavailable"
          : cause.code === "OUTCOME_UNKNOWN"
            ? "gateway source request outcome is unknown"
            : cause.code === "UNAUTHORIZED"
              ? "gateway source rejected the request"
              : cause.code === "UNSUPPORTED"
                ? "gateway source does not support the request"
                : "gateway source request failed";
    return new TRPCError({ code, message, cause });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "access gateway failed",
    cause,
  });
}
