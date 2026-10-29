import { z } from "zod";
import { hostProcedure, hostRouter, type HostContext } from "../../host/index.js";
import type { RunRef } from "../../protocol/index.js";
import type { ChildStreamService } from "../node-contracts.js";
const check = (value: unknown, code: string): void => {
  if (!value) throw Error(code);
};

const id = z.string().min(1).max(1024),
  logical = z.object({ connection: id, principal: id, host: id, session: id }).strict();
const run = z
  .object({ scope: logical, generation: z.number().int().positive(), nativeSession: id })
  .strict();
const scope = z.object({ run, attachment: id, stream: id }).strict();
function authorize(
  ctx: Pick<HostContext, "identity" | "route"> & { session?: HostContext["session"] | undefined },
  value: RunRef,
): void {
  check(
    value.scope.connection === ctx.identity.connection &&
      value.scope.principal === ctx.identity.principal &&
      value.scope.host === ctx.route.host &&
      (!ctx.session ||
        (ctx.session.id === value.scope.session && ctx.session.generation === value.generation)),
    "CHILD_ACTOR_FENCED",
  );
}
export function childStreamRouter(owner: ChildStreamService) {
  return hostRouter({
    inventory: hostProcedure.input(z.object({ run }).strict()).query(({ ctx, input }) => {
      authorize(ctx, input.run);
      return owner.inventory(input.run);
    }),
    watch: hostProcedure
      .input(
        z
          .object({
            scope,
            cursor: z
              .object({
                generation: z.number().int().positive(),
                revision: z.number().int().nonnegative(),
              })
              .optional(),
          })
          .strict(),
      )
      .subscription(({ ctx, input }) => {
        authorize(ctx, input.scope.run);
        return owner.watch(input.scope, input.cursor);
      }),
    baseline: hostProcedure.input(z.object({ scope }).strict()).query(({ ctx, input }) => {
      authorize(ctx, input.scope.run);
      return owner.baseline(input.scope);
    }),
    older: hostProcedure
      .input(z.object({ scope, cursor: z.string().min(1).max(16384) }).strict())
      .query(({ ctx, input }) => {
        authorize(ctx, input.scope.run);
        return owner.older(input.scope, input.cursor);
      }),
  });
}
export type ChildStreamRouter = ReturnType<typeof childStreamRouter>;
