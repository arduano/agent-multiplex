import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { codexRouter, type CodexObservedSelection } from "../../../codex/node.js";
import {
  defaultLifecycle,
  defineHost,
  existingDirectoryWorkspace,
  hostProcedure,
  hostRouter,
} from "../../../host/index.js";
import type { HostActivationContext, NativeObservation } from "../../../host/contracts.js";
import type { SessionScope } from "../../../protocol/index.js";
import { codexDemoGatewayContract } from "../contracts.js";
import type { CodexDemoOptions } from "../node-contracts.js";

/** A copyable concrete composition, not another lifecycle or provider default.
 * Definition construction starts no native process. Activate with activateHost;
 * retain that exact definition for the kernel's normal failure recovery. */
export async function createCodexDemoDefinition(options: CodexDemoOptions) {
  let observer:
    | { observe(scope: SessionScope, value: NativeObservation<CodexObservedSelection>): void }
    | undefined;
  const adapter = await options.adapter((value) => {
    if (!observer) throw new Error("Codex demo lifecycle has not opened");
    observer.observe(value.run.scope, value);
  });
  const lifecycle = defaultLifecycle({
    journal: options.journal,
    workspace: existingDirectoryWorkspace(),
    native: adapter,
    selection: options.selection,
  });
  return defineHost({
    contract: { id: "multiplex.reference.codex-host", version: 1 },
    harness: {
      identity: adapter.identity,
      nativeKind: "codex" as const,
      capabilities: ["history.streaming", "lifecycle.full-stop", "native.codex"],
    },
    gateway: codexDemoGatewayContract,
    lifecycle: () => ({
      ...lifecycle,
      open(context: HostActivationContext) {
        const runtime = lifecycle.open(context);
        observer = runtime.sessions;
        return runtime;
      },
    }),
    native: ({ sessions }) => codexRouter(sessions, adapter),
    extensions: ({ sessions }) => ({
      workspace: {
        identity: { id: "multiplex.reference.workspace", version: 1, recordVersion: 1 },
        public: { host: z.null(), session: z.null() },
        router: hostRouter({
          inspect: hostProcedure
            .input(z.object({ session: z.string().min(1).max(256) }).strict())
            .query(({ ctx, input }) => {
              if (ctx.session && ctx.session.id !== input.session)
                throw new TRPCError({ code: "FORBIDDEN" });
              const state = sessions.state({
                connection: ctx.identity.connection,
                principal: ctx.identity.principal,
                host: ctx.route.host,
                session: input.session,
              });
              return {
                session: input.session,
                generation: state.generation,
                workspace: state.workspace
                  ? { cwd: state.workspace.cwd, ownership: state.workspace.ownership }
                  : null,
              };
            }),
        }),
        // This extension only borrows the lifecycle's read port; it owns no resource.
        readiness: () => ({ ready: true as const }),
        close() {},
      },
    }),
  });
}
