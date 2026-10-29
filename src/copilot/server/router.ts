import { z } from "zod";
import { hostProcedure, hostRouter, type HostContext } from "../../host/index.js";
import { scopeKey, type SessionScope } from "../../protocol/index.js";
import { copilotCommandSchema } from "../contracts.js";
import type { CopilotLifecycle, CopilotControlReads } from "../node-contracts.js";
import { check } from "./validation.js";
const scopeSchema = z
  .object({ connection: z.string(), principal: z.string(), host: z.string(), session: z.string() })
  .strict();
const runSchema = z
  .object({
    scope: scopeSchema,
    generation: z.number().int().positive(),
    nativeSession: z.string().min(1),
  })
  .strict();
function scope(
  ctx: Pick<HostContext, "identity" | "route"> & {
    session?: HostContext["session"] | undefined;
  },
  session: string,
): SessionScope {
  check(!ctx.session || ctx.session.id === session, "SESSION_FENCED");
  return {
    connection: ctx.identity.connection,
    principal: ctx.identity.principal,
    host: ctx.route.host,
    session,
  };
}
const readSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.enum(["selection", "models", "queue", "tasks", "task.promotable", "mcp"]) })
    .strict(),
  z.object({ type: z.literal("task.progress"), id: z.string().min(1).max(256) }).strict(),
]);
export function copilotRouter(
  sessions: CopilotLifecycle,
  read: CopilotControlReads["readForScope"],
) {
  return hostRouter({
    command: hostProcedure
      .input(
        z
          .object({
            session: z.string().min(1).max(256),
            id: z.string().min(1).max(256),
            run: runSchema,
            command: copilotCommandSchema,
          })
          .strict(),
      )
      .mutation(({ ctx, input }) => {
        const owner = scope(ctx, input.session);
        check(scopeKey(owner) === scopeKey(input.run.scope), "RUN_SCOPE_FENCED");
        check(!ctx.session || ctx.session.generation === input.run.generation, "SESSION_FENCED");
        return sessions.command(owner, input.id, input.command, input.run);
      }),
    read: hostProcedure
      .input(
        z
          .object({ session: z.string().min(1).max(256), run: runSchema, request: readSchema })
          .strict(),
      )
      .query(({ ctx, input }) => {
        const owner = scope(ctx, input.session);
        check(scopeKey(owner) === scopeKey(input.run.scope), "RUN_SCOPE_FENCED");
        check(!ctx.session || ctx.session.generation === input.run.generation, "SESSION_FENCED");
        return read(owner, input.run, input.request);
      }),
  });
}
