import { initTRPC, TRPCError, type AnyRouter } from "@trpc/server";
import { isAsyncIterable } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import type { ContractIdentity, GatewayContract } from "../../host/contracts.js";
import { closeOnAbort } from "../../protocol/index.js";
import type { Viewer, GatewayRequests, HostTarget } from "../contracts.js";
import { viewerSchema } from "../contracts.js";
import { publicCall, publicTRPCError } from "./errors.js";
export type GatewayContext = Readonly<{
  viewer: Viewer;
  /** Selection metadata; authentication and exact registration checks remain server-owned. */
  target?: HostTarget;
  routes?: GatewayRequests;
}>;
/** Actual tRPC builder shared by Gateway-owned routes. Imports acquire nothing. */
export const gatewayTRPC = initTRPC.context<GatewayContext>().create({
  isDev: false,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message: publicTRPCError(error).message,
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        ...(shape.data.path ? { path: shape.data.path } : {}),
      },
    };
  },
});
function permitted(identity: Viewer, action: "read" | "control"): Viewer {
  const viewer = viewerSchema.safeParse(identity);
  if (!viewer.success) throw new TRPCError({ code: "UNAUTHORIZED" });
  if (!viewer.data.actions.includes(action)) throw new TRPCError({ code: "FORBIDDEN" });
  return Object.freeze({
    ...viewer.data,
    actions: Object.freeze(viewer.data.actions),
    hosts: Object.freeze(viewer.data.hosts),
  });
}
export const gatewayProcedure = gatewayTRPC.procedure.use(async ({ ctx, type, next }) => {
  return next({ ctx: { viewer: permitted(ctx.viewer, type === "mutation" ? "control" : "read") } });
});
const contractSchema = z
  .object({ id: z.string().min(1).max(256), version: z.number().int().positive() })
  .strict();
/** Scope one Gateway-local procedure to a registered Host customization. This
 * borrows a route only; it creates no native RPC router or lifetime. */
export function gatewayHostMiddleware(contract: ContractIdentity) {
  const expected = Object.freeze(contractSchema.parse(contract));
  return gatewayTRPC.middleware(async ({ ctx, signal, type, next }) => {
    const viewer = permitted(ctx.viewer, type === "mutation" ? "control" : "read");
    if (!ctx.routes || !ctx.target) throw new TRPCError({ code: "BAD_REQUEST" });
    const lease = await publicCall(() => ctx.routes!.acquire(viewer, ctx.target!));
    let retained = false;
    try {
      if (
        lease.manifest.gateway?.id !== expected.id ||
        lease.manifest.gateway.version !== expected.version
      )
        throw new TRPCError({ code: "PRECONDITION_FAILED" });
      const revoked = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
      revoked.throwIfAborted();
      const result = await next({
        ctx: { viewer: lease.viewer, host: { target: lease.target, signal: revoked } },
      });
      if (result.ok && type === "subscription" && isAsyncIterable(result.data)) {
        const iterator = result.data[Symbol.asyncIterator]();
        const owned = {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => iterator.next(),
          async return() {
            await iterator.return?.();
            lease.release();
            return { done: true as const, value: undefined };
          },
        };
        retained = true;
        return { ...result, data: closeOnAbort(owned, revoked) };
      }
      return result;
    } finally {
      if (!retained) lease.release();
    }
  });
}
const empty = gatewayTRPC.router({});
function compose<Custom extends AnyRouter>(
  gateway: Pick<GatewayRequests, "topology">,
  custom: Custom,
) {
  return gatewayTRPC.router({
    topology: gatewayProcedure.query(({ ctx }) => publicCall(() => gateway.topology(ctx.viewer))),
    custom,
  });
}
export function gatewayRouter(
  gateway: Pick<GatewayRequests, "topology">,
): ReturnType<typeof compose<typeof empty>>;
export function gatewayRouter<Custom extends AnyRouter>(
  gateway: Pick<GatewayRequests, "topology">,
  contract: GatewayContract<Custom>,
  custom: NoInfer<Custom>,
): ReturnType<typeof compose<Custom>>;
export function gatewayRouter(
  gateway: Pick<GatewayRequests, "topology">,
  contract?: GatewayContract,
  custom: AnyRouter = empty,
) {
  if (contract) contractSchema.parse(contract);
  return compose(gateway, custom);
}
export type GatewayRouter<Custom extends AnyRouter = typeof empty> = ReturnType<
  typeof compose<Custom>
>;
