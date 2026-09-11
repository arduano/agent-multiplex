import { initTRPC, TRPCError, type AnyTRPCProcedure, type AnyTRPCRouter } from "@trpc/server";
import {
  createCompositeControlNodeRouter, asTrpcError, isolatedStream,
  type CompositeControlNodeRouter, type AccessRouter, type ControlNodeService, type ControlNodeRouterContext, type IsolatedRpc,
} from "@arduano/agent-multiplex-control-node-core";

/** The worker executes the original router, including all input/output schemas
 * and scope/fence checks. This transport facade has no catalog or mutation logic. */
export function createIsolatedControlRouter(rpc: IsolatedRpc): CompositeControlNodeRouter {
  return forwardedControlRouter(rpc) as CompositeControlNodeRouter;
}

export function createIsolatedAccessRouter(rpc: IsolatedRpc): AccessRouter {
  return forwardedControlRouter(rpc, "access.") as AccessRouter;
}

function forwardedControlRouter(rpc: IsolatedRpc, prefix = ""): AnyTRPCRouter {
  // Router construction only registers closures. No service method runs here.
  const template = createCompositeControlNodeRouter(undefined as unknown as ControlNodeService);
  const t = initTRPC.context<ControlNodeRouterContext>().create();
  const tree: Record<string, unknown> = {};
  for (const [path, original] of Object.entries(template._def.procedures as unknown as Record<string, AnyTRPCProcedure>)) {
    if (!path.startsWith(prefix)) continue;
    const procedure = t.procedure.input((value: unknown) => value);
    const invoke = async (input: unknown, ctx: ControlNodeRouterContext) => {
      try { return await rpc.call("router", [path, input, context(ctx)], { mutation: original._def.type === "mutation" }); }
      catch (error) { throw error instanceof TRPCError ? error : asTrpcError(error); }
    };
    const forwarded = original._def.type === "query" ? procedure.query(({ input, ctx }) => invoke(input, ctx))
      : original._def.type === "mutation" ? procedure.mutation(({ input, ctx }) => invoke(input, ctx))
      : procedure.subscription(async function* ({ input, ctx, signal }) {
        try { yield* isolatedStream(rpc, "router", [path, input, context(ctx)], signal); }
        catch (error) { throw error instanceof TRPCError ? error : asTrpcError(error); }
      });
    const parts = path.slice(prefix.length).split("."); let target = tree;
    for (const part of parts.slice(0, -1)) { target[part] ??= {}; target = target[part] as Record<string, unknown>; }
    target[parts.at(-1)!] = forwarded;
  }
  function build(record: Record<string, unknown>): AnyTRPCRouter {
    return t.router(Object.fromEntries(Object.entries(record).map(([key, value]) => [key,
      typeof value === "function" ? value : build(value as Record<string, unknown>)])) as Parameters<typeof t.router>[0]);
  }
  return build(tree);
}
function context(ctx: ControlNodeRouterContext) {
  return {
    ...(ctx.authenticatedActorId === undefined ? {} : { authenticatedActorId: ctx.authenticatedActorId }),
    ...(ctx.endpointId === undefined ? {} : { endpointId: ctx.endpointId }),
    ...(ctx.trustedLocalAccess === undefined ? {} : { trustedLocalAccess: ctx.trustedLocalAccess }),
  };
}
