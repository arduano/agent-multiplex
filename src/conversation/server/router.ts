import { z } from "zod";
import { canonicalJson, type Json, type RunRef, type SessionScope } from "../../protocol/index.js";
import { hostProcedure, hostRouter, type HostContext } from "../../host/index.js";
import type { Answer } from "../../interactions/contracts.js";
import type { ConversationService } from "../contracts.js";
const id = z.string().min(1).max(256);
const run = z
  .object({
    scope: z.object({ connection: id, principal: id, host: id, session: id }).strict(),
    generation: z.number().int().positive(),
    nativeSession: id,
  })
  .strict();
const reference = z
  .object({ run, attachment: id, incarnation: z.number().int().positive() })
  .strict();
type Actor = Pick<HostContext, "identity" | "route"> & {
  session?: HostContext["session"] | undefined;
};
function authorize(ctx: Actor, scope: SessionScope, generation?: number): void {
  if (
    scope.connection !== ctx.identity.connection ||
    scope.principal !== ctx.identity.principal ||
    scope.host !== ctx.route.host ||
    (ctx.session &&
      (ctx.session.id !== scope.session ||
        (generation !== undefined && ctx.session.generation !== generation)))
  )
    throw new Error("Conversation actor fenced");
}
function scope(ctx: Actor, session: string): SessionScope {
  const selected = {
    connection: ctx.identity.connection,
    principal: ctx.identity.principal,
    host: ctx.route.host,
    session,
  };
  authorize(ctx, selected);
  return selected;
}
/** Attach as one static Host extension. hostProcedure retains its real route,
 * action and close-admission gates; the lifecycle retains every admitted reply. */
export function conversationRouter<Reply extends Answer>(feature: ConversationService<Reply>) {
  const selected = z.object({ run }).strict();
  const answer = z.custom<Reply>((value) => {
    try {
      canonicalJson(value as Json, 16384);
      return (
        !!value && typeof value === "object" && "type" in value && typeof value.type === "string"
      );
    } catch {
      return false;
    }
  });
  const checked = (ctx: Actor, selected: RunRef) => {
    authorize(ctx, selected.scope, selected.generation);
  };
  return hostRouter({
    state: hostProcedure
      .input(z.object({ session: id }).strict())
      .query(({ ctx, input }) => feature.state(scope(ctx, input.session))),
    stateWatch: hostProcedure
      .input(z.object({ session: id }).strict())
      .subscription(({ ctx, input }) => feature.stateWatch(scope(ctx, input.session))),
    historyWatch: hostProcedure.input(selected).subscription(({ ctx, input }) => {
      checked(ctx, input.run);
      return feature.historyWatch(input.run);
    }),
    interactionsWatch: hostProcedure.input(selected).subscription(({ ctx, input }) => {
      checked(ctx, input.run);
      return feature.interactionsWatch(input.run);
    }),
    baseline: hostProcedure.input(selected).query(({ ctx, input }) => {
      checked(ctx, input.run);
      return feature.baseline(input.run);
    }),
    older: hostProcedure
      .input(selected.extend({ cursor: z.string().min(1).max(16384) }))
      .query(({ ctx, input }) => {
        checked(ctx, input.run);
        return feature.older(input.run, input.cursor);
      }),
    readState: hostProcedure.input(selected).query(({ ctx, input }) => {
      checked(ctx, input.run);
      return feature.readState(input.run);
    }),
    original: hostProcedure
      .input(z.object({ session: id, id }).strict())
      .query(({ ctx, input }) => feature.original(scope(ctx, input.session), input.id)),
    answer: hostProcedure
      .input(z.object({ id, reference, answer }).strict())
      .mutation(({ ctx, input }) => {
        checked(ctx, input.reference.run);
        return feature.answer(input);
      }),
  });
}
export type ConversationRouter<Reply extends Answer = Answer> = ReturnType<
  typeof conversationRouter<Reply>
>;
