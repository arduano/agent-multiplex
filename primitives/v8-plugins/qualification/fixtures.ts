import { z } from "zod";
import { defineHost, hostProcedure, hostRouter, originalMutation } from "../src/index.js";
import type { HostContext, HostRoute, UpdateReadiness } from "../src/index.js";

export const route: HostRoute = { authority: "root", host: "host", owner: "durable-owner", routeEpoch: "route-1" };
export const context: HostContext = { identity: { connection: "connection", principal: "viewer", actions: ["read", "control"] }, route };
export function fixture() {
  let opens = 0, closes = 0, effects = 0, ready: UpdateReadiness = { ready: true };
  const originals = new Map<string, { id: string; label: string }>();
  const definition = defineHost({
    contract: { id: "fixture.codex", version: 1 },
    harness: { kind: "harness", identity: { id: "codex", version: 1, recordVersion: 1 }, capabilities: ["native-open"] } as const,
    lifecycle: () => ({
      kind: "lifecycle" as const,
      identity: { id: "fixture.lifecycle", version: 1, recordVersion: 1 },
      capabilities: ["create"], requires: ["native-open"],
      createInput: z.object({ workspace: z.object({ directory: z.string() }), initial: z.string().optional() }),
      public: { host: z.object({ allocation: z.literal("existing") }), session: z.object({ directory: z.string() }) },
      open() {
        opens++;
        return {
          sessions: { publicValue: "directory", setReady(value: UpdateReadiness) { ready = value; } },
          router: hostRouter({ snapshot: hostProcedure.query(() => ({ phase: "stopped" as const })) }),
          readiness: () => ready,
          close() { closes++; },
        };
      },
    }),
    harnessRouter: () => hostRouter({ thinking: hostProcedure.input(z.object({ effort: z.enum(["low", "high"]) })).mutation(({ input }) => input.effort) }),
    extensions: ({ sessions }) => ({
      workspace: {
        identity: { id: "fixture.workspace", version: 1, recordVersion: 1 },
        readiness: () => ({ ready: true as const }), close() {},
        public: { host: z.object({ quota: z.number() }), session: z.object({ branch: z.string() }) },
        router: hostRouter({
          inspect: hostProcedure.query(() => ({ directory: sessions.publicValue, bytes: 42 })),
          claim: originalMutation({
            input: z.object({ label: z.string() }), output: z.object({ id: z.string(), label: z.string() }),
            owner: {
              submit(_context, request) {
                const prior = originals.get(request.id);
                if (prior) { if (prior.label !== request.input.label) throw new Error("Original conflict"); return prior; }
                effects++;
                const value = { id: request.id, label: request.input.label };
                originals.set(request.id, value); return value;
              },
              original(_context, id) { return originals.get(id) ?? null; },
            },
          }),
          watch: hostProcedure.subscription(async function* () { yield { directory: sessions.publicValue, revision: 1 }; }),
        }),
      },
    }),
  });
  return { definition, state: () => ({ opens, closes, effects }), setReady(value: UpdateReadiness) { ready = value; } };
}
