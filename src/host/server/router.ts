import { z } from "zod";
import type { Json, SessionScope } from "../../protocol/index.js";
import type { HostActivationContext, HostContext } from "../contracts.js";
import type { LifecycleOptions } from "../node-contracts.js";
import { sessionStateSchema } from "../contracts.js";
import { hostProcedure, hostRouter } from "./composition.js";
import { DefaultLifecycle } from "./lifecycle.js";

/** Static shipped lifecycle plugin. Journal lifetime is supplied by the Host
 * process; the plugin never owns another writer or closes an injected writer. */
export function defaultLifecycle<
  Input extends z.ZodType,
  Data extends z.ZodType<Json>,
  Command extends z.ZodType,
  Message extends z.ZodType,
  Requested extends z.ZodType,
  Observed extends z.ZodType,
>(options: LifecycleOptions<Input, Data, Command, Message, Requested, Observed>) {
  const stateSchema = sessionStateSchema(
    options.native.selectionInput,
    options.native.selectionOutput,
  );
  return {
    identity: { id: "multiplex.default-lifecycle", version: 1, recordVersion: 2 },
    createInput: options.workspace.input,
    public: { host: z.object({ sessionCount: z.number() }), session: stateSchema },
    open(context: HostActivationContext) {
      const sessions = new DefaultLifecycle(options, context);
      const input = z.object({
        session: z.string().min(1).max(256),
        id: z.string().min(1).max(256),
      });
      const scope = (
        ctx: Pick<HostContext, "identity" | "route"> & {
          session?: HostContext["session"] | undefined;
        },
        session: string,
      ): SessionScope => {
        if (
          ctx.route.host !== context.route.host ||
          ctx.route.owner !== context.route.owner ||
          ctx.route.authority !== context.route.authority ||
          ctx.route.routeEpoch !== context.route.routeEpoch ||
          (ctx.session && ctx.session.id !== session)
        )
          throw new Error("Lifecycle route fenced");
        return {
          connection: ctx.identity.connection,
          principal: ctx.identity.principal,
          host: ctx.route.host,
          session,
        };
      };
      const router = hostRouter({
        list: hostProcedure
          .output(z.array(stateSchema).readonly())
          .query(({ ctx }) => sessions.list(ctx)),
        state: hostProcedure
          .input(z.object({ session: z.string() }))
          .output(stateSchema)
          .query(({ ctx, input }) => sessions.state(scope(ctx, input.session))),
        original: hostProcedure
          .input(input)
          .query(({ ctx, input }) => sessions.original(scope(ctx, input.session), input.id)),
        create: hostProcedure
          .input(
            input.extend({
              workspace: z.custom<z.input<Input>>(),
              selection: z.custom<z.input<Requested>>().optional(),
            }) as z.ZodType<
              {
                session: string;
                id: string;
                workspace: z.input<Input>;
                selection?: z.input<Requested> | undefined;
              },
              {
                session: string;
                id: string;
                workspace: z.input<Input>;
                selection?: z.input<Requested> | undefined;
              }
            >,
          )
          .mutation(({ ctx, input }) =>
            sessions.create(
              scope(ctx, input.session),
              input.id,
              input.workspace as z.input<Input>,
              input.selection,
            ),
          ),
        stop: hostProcedure
          .input(input.extend({ generation: z.number().int().nonnegative() }))
          .mutation(({ ctx, input }) =>
            sessions.stop(scope(ctx, input.session), input.id, input.generation),
          ),
        reopen: hostProcedure
          .input(
            input.extend({
              generation: z.number().int().nonnegative(),
              selection: z.custom<z.input<Requested>>().optional(),
            }),
          )
          .mutation(({ ctx, input }) =>
            sessions.reopen(
              scope(ctx, input.session),
              input.id,
              input.generation,
              input.selection as z.input<Requested> | undefined,
            ),
          ),
        archive: hostProcedure
          .input(input.extend({ generation: z.number().int().nonnegative() }))
          .mutation(({ ctx, input }) =>
            sessions.archive(scope(ctx, input.session), input.id, input.generation),
          ),
      });
      return {
        sessions,
        router,
        readiness: () => sessions.readiness(),
        close: () => sessions.close(),
      };
    },
  };
}
