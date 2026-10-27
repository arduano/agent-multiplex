import { z } from "zod";
import { defineHost, hostProcedure, hostRouter, originalMutation } from "../../v8-plugins/src/index.js";
import { ViewerQueue } from "../../v8-gateway/src/contracts/queue.js";
import type { PublicHostContract } from "../../v8-plugins/src/index.js";
// The standalone qualification build follows the same closed Node graph as
// the integration build. Browser entry imports only PluginBrowserHosts above.
export { GatewayCoordinator } from "../../v8-gateway/src/gateway/coordinator.js";
export { createGatewayHttpHandler } from "../../v8-gateway/src/http/server.js";
export { createHmacHostProof, authenticateHostProof } from "../../v8-gateway/src/node/host-proof.js";
export { createInProcessHostRpcPort } from "../../v8-gateway/src/node/in-process-host.js";

function channel<T>(value: () => T) {
  let revision = 1, subscriptions = 0;
  const watchers = new Set<ViewerQueue<{ revision: number; data: T }>>();
  return {
    router: hostProcedure.subscription(async function* ({ signal }) {
      const queue = new ViewerQueue<{ revision: number; data: T }>(8, 65536);
      const abort = () => { void queue.return(); };
      signal?.addEventListener("abort", abort, { once: true }); watchers.add(queue); subscriptions++;
      try { queue.push({ revision, data: value() }); if (signal?.aborted) abort(); yield* queue; }
      finally { signal?.removeEventListener("abort", abort); watchers.delete(queue); await queue.return(); }
    }),
    emit() { revision++; for (const queue of watchers) queue.push({ revision, data: value() }); },
    close() { for (const queue of watchers) queue.finish(); },
    stats: () => ({ watchers: watchers.size, subscriptions }),
  };
}

/** Two scripted owners, actual schemas/routers and different public DTOs. */
export function pluginBrowserDomains() {
  let branch = "main", team = "engineering", effects = 0;
  const receipts = new Map<string, { id: string; branch: string }>();
  const localHost = channel(() => ({ lifecycle: { strategy: "existing" as const }, extensions: { workspace: { quota: 64 } } }));
  const localSession = channel(() => ({ lifecycle: { directory: "/owned/local" }, extensions: { workspace: { branch } } }));
  const workHost = channel(() => ({ lifecycle: { tenant: "business" }, extensions: { organization: { policy: { managed: true } } } }));
  const workSession = channel(() => ({ lifecycle: { mode: "interactive" as const }, extensions: { organization: { team } } }));
  const local = defineHost({ contract: { id: "browser.local", version: 1 },
    harness: { kind: "harness", nativeKind: "codex", identity: { id: "browser.codex", version: 1, recordVersion: 1 }, capabilities: [] } as const,
    lifecycle: () => ({ kind: "lifecycle" as const, identity: { id: "browser.existing", version: 1, recordVersion: 1 }, capabilities: [],
      createInput: z.object({ directory: z.string() }), public: { host: z.object({ strategy: z.literal("existing") }), session: z.object({ directory: z.string() }) },
      open: () => ({ sessions: {}, router: hostRouter({}), readiness: () => ({ ready: true as const }), close() {} }),
    }),
    harnessRouter: () => hostRouter({ controls: hostProcedure.query(() => ({ thinking: ["low", "high"] as const })) }),
    extensions: () => ({ workspace: { identity: { id: "browser.workspace", version: 1, recordVersion: 1 }, public: { host: z.object({ quota: z.number() }), session: z.object({ branch: z.string() }) },
      router: hostRouter({ hostWatch: localHost.router, sessionWatch: localSession.router,
        inspect: hostProcedure.query(() => ({ branch, directory: "/owned/local" })),
        claim: originalMutation({ input: z.object({ branch: z.string() }), output: z.object({ id: z.string(), branch: z.string() }), owner: {
          submit(_ctx, request) { const prior = receipts.get(request.id); if (prior) { if (prior.branch !== request.input.branch) throw new Error("Original meaning conflicts"); return prior; } effects++; branch = request.input.branch; const receipt = { id: request.id, branch }; receipts.set(request.id, receipt); localSession.emit(); return receipt; },
          original(_ctx, id) { return receipts.get(id) ?? null; },
        } }),
      }), readiness: () => ({ ready: true as const }), close() { localHost.close(); localSession.close(); },
    } }),
  });
  const work = defineHost({ contract: { id: "browser.work", version: 1 },
    harness: { kind: "harness", nativeKind: "copilot", identity: { id: "browser.copilot", version: 1, recordVersion: 1 }, capabilities: [] } as const,
    lifecycle: () => ({ kind: "lifecycle" as const, identity: { id: "browser.repository", version: 1, recordVersion: 1 }, capabilities: [],
      createInput: z.object({ repository: z.string() }), public: { host: z.object({ tenant: z.string() }), session: z.object({ mode: z.literal("interactive") }) },
      open: () => ({ sessions: {}, router: hostRouter({}), readiness: () => ({ ready: true as const }), close() {} }),
    }),
    harnessRouter: () => hostRouter({ modes: hostProcedure.query(() => ["interactive", "plan"] as const) }),
    extensions: () => ({ organization: { identity: { id: "browser.organization", version: 1, recordVersion: 1 }, public: { host: z.object({ policy: z.object({ managed: z.boolean() }) }), session: z.object({ team: z.string() }) },
      router: hostRouter({ hostWatch: workHost.router, sessionWatch: workSession.router, inspect: hostProcedure.query(() => ({ team })) }),
      readiness: () => ({ ready: true as const }), close() { workHost.close(); workSession.close(); },
    } }),
  });
  return { local, work, emit() { branch = "background-update"; team = "operations"; localSession.emit(); workSession.emit(); },
    stats: () => ({ effects, subscriptions: [localHost, localSession, workHost, workSession].reduce((sum, stream) => sum + stream.stats().subscriptions, 0), watchers: [localHost, localSession, workHost, workSession].reduce((sum, stream) => sum + stream.stats().watchers, 0) }),
  };
}
export type PluginBrowserHosts = {
  local: PublicHostContract<ReturnType<typeof pluginBrowserDomains>["local"]>;
  work: PublicHostContract<ReturnType<typeof pluginBrowserDomains>["work"]>;
};
