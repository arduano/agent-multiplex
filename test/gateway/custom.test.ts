import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { GatewayContract } from "../../src/host/contracts.js";
import {
  gatewayHostMiddleware,
  gatewayProcedure,
  gatewayRouter,
  gatewayTRPC,
} from "../../src/gateway/node.js";
import { fixture, viewer, route } from "./fixture.js";

test("creation-associated Gateway routes preserve actual types, Host scope and cleanup custody", async () => {
  // The contract module contains no handlers. Its annotation type-imports this
  // actual router; an application can keep the two runtime closures separate.
  const identity = { id: "fixture.work-gateway", version: 1 };
  const procedure = gatewayProcedure.use(gatewayHostMiddleware(identity));
  let allocations = 0,
    closed = 0,
    finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const custom = gatewayTRPC.router({
    allocate: procedure
      .input(z.object({ diskGiB: z.number().int().positive() }))
      .mutation(({ ctx, input }) => ({
        host: ctx.host.target.route.host,
        diskGiB: input.diskGiB,
        allocation: ++allocations,
      })),
    watch: procedure.subscription(() => {
      const source: AsyncIterableIterator<string> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => new Promise<IteratorResult<string>>(() => {}),
        async return() {
          closed++;
          await cleanup;
          return { done: true as const, value: undefined };
        },
      };
      return source;
    }),
  });
  const contract: GatewayContract<typeof custom> = identity;
  const f = await fixture(contract);
  const router = gatewayRouter(f.gateway, contract, custom);
  const caller = (identity = viewer) =>
    router.createCaller({ viewer: identity, target: f.target(), routes: f.gateway });
  try {
    assert.deepEqual(await caller().custom.allocate({ diskGiB: 32 }), {
      host: route.host,
      diskGiB: 32,
      allocation: 1,
    });
    await assert.rejects(
      caller({ ...viewer, actions: ["read"] }).custom.allocate({ diskGiB: 16 }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(caller({ ...viewer, hosts: [] }).custom.allocate({ diskGiB: 16 }), {
      code: "FORBIDDEN",
    });
    await assert.rejects(
      router.createCaller({ viewer, routes: f.gateway }).custom.allocate({ diskGiB: 16 }),
      { code: "BAD_REQUEST" },
    );
    const foreign = gatewayTRPC.router({
      read: gatewayProcedure
        .use(gatewayHostMiddleware({ id: "other-profile", version: 1 }))
        .query(() => true),
    });
    await assert.rejects(
      foreign.createCaller({ viewer, target: f.target(), routes: f.gateway }).read(),
      { code: "PRECONDITION_FAILED" },
    );
    assert.equal(allocations, 1);
    if (false as boolean) {
      // @ts-expect-error Actual custom procedure inputs survive composition.
      await caller().custom.allocate({ diskGiB: "32" });
      // @ts-expect-error Unknown custom routes are absent from the actual router.
      await caller().custom.windowsOnly();
      // @ts-expect-error The mounted router must match the creation-time contract.
      gatewayRouter(f.gateway, contract, foreign);
    }
    const watch = await caller().custom.watch();
    assert.equal(f.gateway.readiness(), false);
    f.gateway.registerHost({ route, manifest: f.host.manifest, transport: f.peer });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, 1, "Route replacement requests actual quiet producer cleanup");
    assert.equal(f.gateway.readiness(), false, "Revocation alone never releases custody");
    finish();
    await watch[Symbol.asyncIterator]().return?.();
    assert.equal(f.gateway.readiness(), true);
    assert.equal(f.effects(), 0, "Gateway-local routes do not invoke native Host effects");
  } finally {
    finish();
    await f.close();
  }
});
