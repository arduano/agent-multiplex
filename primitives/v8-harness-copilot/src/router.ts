import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { hostProcedure, hostRouter } from "../../v8-plugins/src/router.js";
import type { HostContext } from "../../v8-plugins/src/contracts.js";
import type { ControlFor, NativeReadFor, NativeReadResult, SessionPort, SessionScope } from "../../v8-session/src/contracts/types.js";
import { validateCommand } from "../../v8-harness-defaults/src/validation.js";
import { scopeKey } from "../../v8-session/src/contracts/types.js";

export type CopilotControl = ControlFor<"copilot">;
export type CopilotReadResult = Extract<NativeReadResult, { type: "copilot.queue" | "copilot.tasks" | "copilot.task.progress" | "copilot.task.promotable" }>;
export type CopilotRouterSessions = Readonly<{ session(scope: SessionScope): Promise<SessionPort> }>;
const id = z.string().min(1).max(256), generation = z.number().int().nonnegative();
const commands = z.custom<CopilotControl>().transform(value => {
  const command = validateCommand("copilot", value);
  if (command.type === "create" || command.type === "resume" || command.type === "stop") throw new TRPCError({ code: "BAD_REQUEST", message: "Unsupported harness command" });
  return command as CopilotControl;
});
const reads = z.custom<NativeReadFor<"copilot">>().superRefine((value, context) => {
  if (!value || !["copilot.queue", "copilot.tasks", "copilot.task.progress", "copilot.task.promotable"].includes(value.type) || Object.keys(value).some(key => key !== "type" && !(value.type === "copilot.task.progress" && key === "id")) || value.type === "copilot.task.progress" && !id.safeParse(value.id).success) context.addIssue({ code: "custom", message: "Unsupported native read" });
});
function scope(context: HostContext): SessionScope {
  if (!context.session) throw new TRPCError({ code: "BAD_REQUEST", message: "Session route required" });
  return { connection: context.identity.connection, principal: context.identity.principal, host: context.route.host, session: context.session.id };
}
/** Actual inferred tRPC contract. Effect admission stays with the lifecycle journal. */
export function copilotHarnessRouter({ sessions }: { sessions: CopilotRouterSessions }) {
  return hostRouter({
    loginLink: hostProcedure.input(z.object({ generation, nativeSession: id, originalId: id }).strict()).query(async ({ ctx, input }) => {
      if (!ctx.identity.actions.includes('read') || !ctx.identity.actions.includes('control')) throw new TRPCError({ code: 'FORBIDDEN' });
      const target = scope(ctx);
      if (ctx.session!.generation !== input.generation) throw new TRPCError({ code: 'CONFLICT' });
      const port = await sessions.session(target); if (!port.mcpLoginLink) throw new TRPCError({ code: 'METHOD_NOT_SUPPORTED' });
      return port.mcpLoginLink({ scope: target, generation: input.generation, nativeSession: input.nativeSession }, input.originalId);
    }),
    submit: hostProcedure.input(z.object({ id, generation, command: commands }).strict()).mutation(async ({ ctx, input }) => {
      const target = scope(ctx);
      if (ctx.session!.generation !== input.generation) throw new TRPCError({ code: "CONFLICT", message: "Run generation differs" });
      return (await sessions.session(target)).submit({ ...input, scope: target });
    }),
    original: hostProcedure.input(z.object({ id }).strict()).query(async ({ ctx, input }) => (await sessions.session(scope(ctx))).receipt(scope(ctx), input.id)),
    read: hostProcedure.input(z.object({ generation, nativeSession: id, request: reads }).strict()).query(async ({ ctx, input }): Promise<CopilotReadResult> => {
      const target = scope(ctx);
      if (ctx.session!.generation !== input.generation) throw new TRPCError({ code: "CONFLICT", message: "Run generation differs" });
      const port = await sessions.session(target); if (!port.read) throw new TRPCError({ code: "METHOD_NOT_SUPPORTED" });
      const result = await port.read({ scope: target, generation: input.generation, nativeSession: input.nativeSession }, input.request);
      if (scopeKey(result.run.scope) !== scopeKey(target) || result.type !== input.request.type) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Native result differs" });
      return result as CopilotReadResult;
    }),
  });
}
export type CopilotHarnessRouter = ReturnType<typeof copilotHarnessRouter>;
