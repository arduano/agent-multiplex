import { z } from "zod";
import { activateHost, defineHost, hostProcedure, hostRouter } from "../../src/host/index.js";
import { Gateway, hostEndpoint } from "../../src/gateway/node.js";
import type { HostTarget, Viewer } from "../../src/gateway/index.js";
import type { GatewayContract } from "../../src/host/contracts.js";
import { HistoryWindow } from "../../src/history/index.js";
export const route = { authority: "root", host: "host", owner: "owner", routeEpoch: "epoch-one" };
export const viewer: Viewer = {
  connection: "connection",
  principal: "principal",
  actions: ["read", "control"],
  hosts: ["host"],
};
export async function fixture(gatewayContract?: GatewayContract) {
  let effects = 0;
  const window = new HistoryWindow({
    run: {
      scope: { connection: "connection", principal: "principal", host: "host", session: "session" },
      generation: 1,
      nativeSession: "native",
    },
    attachment: "attachment",
    stream: "native",
  });
  const definition = defineHost({
    contract: { id: "fixture", version: 1 },
    ...(gatewayContract ? { gateway: gatewayContract } : {}),
    harness: {
      identity: { id: "fixture-native", version: 1, recordVersion: 1 },
      nativeKind: "future-family",
      capabilities: [],
    },
    lifecycle: () => ({
      identity: { id: "fixture-lifecycle", version: 1, recordVersion: 1 },
      createInput: z.null(),
      public: { host: z.null(), session: z.null() },
      open: () => ({
        sessions: null,
        router: hostRouter({
          read: hostProcedure.input(z.null()).query(() => ({ effects })),
          absent: hostProcedure.input(z.undefined()).query(() => "absent"),
          void: hostProcedure.input(z.null()).mutation(() => undefined),
          change: hostProcedure
            .input(z.object({ value: z.string() }).strict())
            .mutation(() => ({ effects: ++effects })),
          history: hostProcedure.input(z.null()).subscription(() => window.subscribe()),
        }),
        readiness: () => ({ ready: true as const }),
        close() {},
      }),
    }),
  });
  const host = await activateHost(definition, {
    route,

    authenticate(call) {
      const proof = call.proof as Viewer;
      return {
        identity: {
          connection: proof.connection,
          principal: proof.principal,
          actions: proof.actions,
        },
        route,
        ...(call.session ? { session: call.session } : {}),
      };
    },
  });
  const peer = hostEndpoint(host, {
    route,
    manifest: host.manifest,
    proof: (identity) => identity,
  });
  let now = 100;
  const gateway = new Gateway<typeof peer>({
    authorizePeer: (candidate) => candidate.route.owner === "owner",
    now: () => now,
    staleAfterMs: 10,
  });
  const lease = gateway.registerHost({ route, manifest: host.manifest, transport: peer });
  const target = (): HostTarget => ({
    route,
    expected: {
      contractId: host.manifest.contractId,
      contractVersion: host.manifest.contractVersion,
      compositionId: host.manifest.compositionId,
    },
  });
  return {
    gateway,
    host,
    window,
    peer,
    lease,
    target,
    setNow(value: number) {
      now = value;
    },
    effects: () => effects,
    async close() {
      window.close();
      await gateway.close();
      await host.close();
    },
  };
}
