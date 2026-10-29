import { z } from "zod";
import { hostProcedure, hostRouter, type HostContext } from "../../host/index.js";
import { closeOnAbort, cloneJson, type Json, type RunRef } from "../../protocol/index.js";
import type { CodexSessionCommands, CodexNativeApi } from "../node-contracts.js";
import type * as Native from "../protocol/index.js";
import {
  codexRunSchema,
  codexCallbackRefSchema,
  codexNativeCallbackResponseSchema,
  codexNativeSchemas,
  codexNativeEffectSchema,
  codexNativeAnswerSchema,
  codexReceipt,
} from "../native-contracts.js";
import { nativeResults } from "./native-validation.js";
import { check } from "./validation.js";

function authorize(
  ctx: Pick<HostContext, "identity" | "route"> & { session?: HostContext["session"] | undefined },
  run: RunRef,
): void {
  check(
    run.scope.connection === ctx.identity.connection &&
      run.scope.principal === ctx.identity.principal &&
      run.scope.host === ctx.route.host &&
      (!ctx.session ||
        (ctx.session.id === run.scope.session && ctx.session.generation === run.generation)),
    "NATIVE_ACTOR_FENCED",
  );
}
/** Native DTOs cross the tRPC boundary intact. Effects use the lifecycle's sole
 * original journal; the router has no dispatch retry or native lifetime. */
export function codexRouter(sessions: CodexSessionCommands, adapter: CodexNativeApi) {
  function read<Params, Result>(
    method: string,
    params: z.ZodType<Params, Params>,
    output: z.ZodType<Result>,
  ) {
    return hostProcedure
      .input(z.object({ run: codexRunSchema, params }).strict())
      .query(async ({ ctx, input }) => {
        authorize(ctx, input.run);
        return cloneJson(
          output.parse(
            await adapter.nativeRead(input.run, method, input.params),
          ) as unknown as Json,
          262_144,
        ) as Result & Json;
      });
  }
  function effect<Params, Result>(
    method: string,
    params: z.ZodType<Params, Params>,
    output: z.ZodType<Result>,
  ) {
    return hostProcedure
      .input(
        z.object({ originalId: z.string().min(1).max(256), run: codexRunSchema, params }).strict(),
      )
      .mutation(async ({ ctx, input }) => {
        authorize(ctx, input.run);
        // Native optional fields have JSON omission semantics. Remove explicit
        // undefined only after Zod has validated the selected native DTO.
        const command = codexNativeEffectSchema.parse(
          JSON.parse(JSON.stringify({ type: "native", method, params: input.params })),
        );
        const receipt = await sessions.command(
          input.run.scope,
          input.originalId,
          command,
          input.run,
        );
        return codexReceipt(
          receipt,
          output.transform(
            (value) => cloneJson(value as unknown as Json, 262_144) as Result & Json,
          ),
        );
      });
  }
  const selected = z.object({ run: codexRunSchema }).strict();
  return hostRouter({
    thread: hostRouter({
      read: read(
        "thread/read",
        codexNativeSchemas.threadRead,
        nativeResults.threadRead as z.ZodType<Native.ThreadReadResponse>,
      ),
      turns: read(
        "thread/turns/list",
        codexNativeSchemas.turnsList,
        nativeResults.turnsList as z.ZodType<Native.ThreadTurnsListResponse>,
      ),
      items: read(
        "thread/items/list",
        codexNativeSchemas.itemsList,
        nativeResults.itemsList as z.ZodType<Native.ThreadItemsListResponse>,
      ),
      settings: hostRouter({
        update: effect(
          "thread/settings/update",
          codexNativeSchemas.settingsUpdate,
          nativeResults.settingsUpdate as z.ZodType<Native.ThreadSettingsUpdateResponse>,
        ),
      }),
      queue: hostRouter({
        list: read(
          "thread/queue/list",
          codexNativeSchemas.queueList,
          nativeResults.queueList as z.ZodType<Native.ThreadQueueListResponse>,
        ),
        add: effect(
          "thread/queue/add",
          codexNativeSchemas.queueAdd,
          nativeResults.queueAdd as z.ZodType<Native.ThreadQueueAddResponse>,
        ),
        start: effect(
          "thread/queue/start",
          codexNativeSchemas.queueStart,
          nativeResults.queueStart as z.ZodType<Native.ThreadQueueStartResponse>,
        ),
        update: effect(
          "thread/queue/update",
          codexNativeSchemas.queueUpdate,
          nativeResults.queueUpdate as z.ZodType<Native.ThreadQueueUpdateResponse>,
        ),
        delete: effect(
          "thread/queue/delete",
          codexNativeSchemas.queueDelete,
          nativeResults.queueDelete as z.ZodType<Native.ThreadQueueDeleteResponse>,
        ),
        reorder: effect(
          "thread/queue/reorder",
          codexNativeSchemas.queueReorder,
          nativeResults.queueReorder as z.ZodType<Native.ThreadQueueReorderResponse>,
        ),
      }),
      goal: hostRouter({
        get: read(
          "thread/goal/get",
          codexNativeSchemas.goalGet,
          nativeResults.goalGet as z.ZodType<Native.ThreadGoalGetResponse>,
        ),
        set: effect(
          "thread/goal/set",
          codexNativeSchemas.goalSet,
          nativeResults.goalSet as z.ZodType<Native.ThreadGoalSetResponse>,
        ),
        clear: effect(
          "thread/goal/clear",
          codexNativeSchemas.goalClear,
          nativeResults.goalClear as z.ZodType<Native.ThreadGoalClearResponse>,
        ),
      }),
      backgroundTerminals: hostRouter({
        list: read(
          "thread/backgroundTerminals/list",
          codexNativeSchemas.terminalsList,
          nativeResults.terminalsList as z.ZodType<Native.ThreadBackgroundTerminalsListResponse>,
        ),
        terminate: effect(
          "thread/backgroundTerminals/terminate",
          codexNativeSchemas.terminalTerminate,
          nativeResults.terminalTerminate as z.ZodType<Native.ThreadBackgroundTerminalsTerminateResponse>,
        ),
        clean: effect(
          "thread/backgroundTerminals/clean",
          codexNativeSchemas.terminalsClean,
          nativeResults.terminalsClean as z.ZodType<Native.ThreadBackgroundTerminalsCleanResponse>,
        ),
      }),
      compact: hostRouter({
        start: effect(
          "thread/compact/start",
          codexNativeSchemas.compactStart,
          nativeResults.compactStart as z.ZodType<Native.ThreadCompactStartResponse>,
        ),
      }),
    }),
    turn: hostRouter({
      start: effect(
        "turn/start",
        codexNativeSchemas.turnStart,
        nativeResults.turnStart as z.ZodType<Native.TurnStartResponse>,
      ),
      steer: effect(
        "turn/steer",
        codexNativeSchemas.turnSteer,
        nativeResults.turnSteer as z.ZodType<Native.TurnSteerResponse>,
      ),
      interrupt: effect(
        "turn/interrupt",
        codexNativeSchemas.turnInterrupt,
        nativeResults.turnInterrupt as z.ZodType<Native.TurnInterruptResponse>,
      ),
      settings: hostRouter({
        update: effect(
          "turn/settings/update",
          codexNativeSchemas.turnSettingsUpdate,
          nativeResults.turnSettingsUpdate as z.ZodType<Native.TurnSettingsUpdateResponse>,
        ),
      }),
    }),
    model: hostRouter({
      list: read(
        "model/list",
        codexNativeSchemas.modelList,
        nativeResults.modelList as z.ZodType<Native.ModelListResponse>,
      ),
    }),
    mcpServerStatus: hostRouter({
      list: read(
        "mcpServerStatus/list",
        codexNativeSchemas.mcpList,
        nativeResults.mcpList as z.ZodType<Native.ListMcpServerStatusResponse>,
      ),
    }),
    observation: hostRouter({
      snapshot: hostProcedure.input(selected).query(({ ctx, input }) => {
        authorize(ctx, input.run);
        return adapter.observation(input.run);
      }),
      watch: hostProcedure
        .input(
          selected.extend({
            after: z
              .object({ attachment: z.string(), revision: z.number().int().nonnegative() })
              .strict()
              .optional(),
          }),
        )
        .subscription(({ ctx, input, signal }) => {
          authorize(ctx, input.run);
          return closeOnAbort(adapter.watchObservation(input.run, input.after), signal);
        }),
    }),
    callbacks: hostRouter({
      pending: hostProcedure.input(selected).query(({ ctx, input }) => {
        authorize(ctx, input.run);
        check(ctx.identity.actions.includes("control"), "PRIVATE_CALLBACK_DENIED");
        return adapter.pendingCallbacks(input.run);
      }),
      watch: hostProcedure.input(selected).subscription(({ ctx, input, signal }) => {
        authorize(ctx, input.run);
        check(ctx.identity.actions.includes("control"), "PRIVATE_CALLBACK_DENIED");
        return closeOnAbort(adapter.watchCallbacks(input.run), signal);
      }),
      respond: hostProcedure
        .input(
          z
            .object({
              originalId: z.string().min(1).max(256),
              run: codexRunSchema,
              reference: codexCallbackRefSchema,
              params: codexNativeCallbackResponseSchema,
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) => {
          authorize(ctx, input.run);
          const command = codexNativeAnswerSchema.parse(
            JSON.parse(
              JSON.stringify({
                type: "nativeAnswer",
                reference: input.reference,
                answer: input.params,
              }),
            ),
          );
          return codexReceipt(
            await sessions.command(input.run.scope, input.originalId, command, input.run),
            z.object({ submitted: z.literal(true) }).strict(),
          );
        }),
    }),
  });
}
export type CodexRouter = ReturnType<typeof codexRouter>;
