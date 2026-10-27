import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type { HostContext, MaybePromise } from "./contracts.js";

const t = initTRPC.context<HostContext>().create();
export const hostRouter = t.router;
/** Query/subscription are observational. Owners enforce finer domain permission. */
export const hostProcedure = t.procedure.use(async ({ ctx, path, type, next }) => {
  const action = type === "mutation" ? "control" : "read";
  if (!ctx.identity?.principal || !ctx.identity.connection || !ctx.identity.actions.includes(action)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Host action denied" });
  }
  const release = ctx.admit?.({ path, type });
  try { return await next(); }
  finally { release?.(); }
});

export const originalId = z.string().min(1).max(256);
/** Wire shape only. The supplied owner retains durable admission and dispatch. */
export function originalMutation<Input extends z.ZodType, Output>(options: {
  input: Input;
  output: z.ZodType<Output>;
  owner: {
    submit(context: HostContext, request: { id: string; input: z.output<Input> }): MaybePromise<Output>;
    original(context: HostContext, id: string): MaybePromise<Output | null>;
  };
}) {
  return hostRouter({
    submit: hostProcedure.input(z.object({ id: originalId, input: options.input })).output(options.output)
      .mutation(({ ctx, input }) => options.owner.submit(ctx, input as { id: string; input: z.output<Input> })),
    original: hostProcedure.input(z.object({ id: originalId })).output(options.output.nullable())
      .query(({ ctx, input }) => options.owner.original(ctx, input.id)),
  });
}
