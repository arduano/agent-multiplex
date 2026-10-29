import assert from "node:assert/strict";
import test from "node:test";
import { Gateway, gatewayHttpHandler } from "../../src/gateway/node.js";
import { fixture, viewer, route } from "./fixture.js";

test("Gateway lends the exact borrowed transport with immutable grants and exact route/composition fences", async () => {
  const f = await fixture();
  const registration = { route: { ...route }, manifest: f.host.manifest, transport: f.peer };
  const registered = f.gateway.registerHost(registration);
  const bound = f.gateway.acquire(viewer, f.target());
  registration.transport = { ...f.peer };
  registration.route.host = "changed-after-admission";
  try {
    assert.equal(bound.transport, f.peer);
    assert.equal(registered.heartbeat(), true);
    const later = f.gateway.acquire(viewer, f.target());
    assert.equal(later.transport, f.peer);
    later.release();
    assert.equal("router" in bound, false, "Routing creates no RPC facade");
    assert.deepEqual(bound.viewer, viewer);
    assert.throws(() => {
      (bound.viewer.actions as string[]).push("control");
    });
    assert.throws(() => {
      bound.target.route.routeEpoch = "forged";
    });
    const readOnly = f.gateway.acquire({ ...viewer, actions: ["read"] }, f.target());
    assert.deepEqual(readOnly.viewer.actions, ["read"]);
    readOnly.release();
    assert.throws(
      () => f.gateway.acquire(viewer, { ...f.target(), route: { ...route, routeEpoch: "old" } }),
      { code: "FENCED" },
    );
    assert.throws(
      () =>
        f.gateway.acquire(viewer, {
          ...f.target(),
          expected: { ...f.target().expected, compositionId: "other" },
        }),
      { code: "FENCED" },
    );
    assert.throws(() => f.gateway.acquire({ ...viewer, hosts: [] }, f.target()), {
      code: "FORBIDDEN",
    });
    assert.throws(() => f.gateway.acquire({ ...viewer, actions: [] }, f.target()), {
      code: "FORBIDDEN",
    });
    assert.equal(f.effects(), 0);
  } finally {
    bound.release();
    await f.close();
  }
});

test("topology freshness and old disconnects cannot falsify replacement or native state", async () => {
  const f = await fixture();
  try {
    assert.equal(f.gateway.topology(viewer)[0]?.state, "online");
    f.setNow(111);
    assert.equal(f.gateway.topology(viewer)[0]?.state, "stale");
    assert.equal(f.lease.heartbeat(), true);
    assert.equal(f.gateway.topology(viewer)[0]?.state, "online");
    const replacement = f.gateway.registerHost({
      route,
      manifest: f.host.manifest,
      transport: f.peer,
    });
    f.lease.disconnect();
    assert.equal(f.lease.heartbeat(), false);
    assert.equal(f.gateway.topology(viewer)[0]?.state, "online");
    replacement.disconnect();
    assert.equal(f.gateway.topology(viewer)[0]?.state, "offline");
    assert.equal(f.effects(), 0);
    assert.deepEqual(f.gateway.topology({ ...viewer, hosts: [] }), []);
  } finally {
    await f.close();
  }
});

test("independent channel release never retires the shared Host or another viewer", async () => {
  const f = await fixture();
  const a = f.gateway.acquire(viewer, f.target()),
    b = f.gateway.acquire(viewer, f.target());
  try {
    a.release();
    a.release();
    assert.equal(b.signal.aborted, false);
    assert.equal(f.gateway.readiness(), false);
    assert.equal(f.gateway.topology(viewer)[0]?.state, "online");
    const caller = b.transport.router.createCaller(() => b.transport.context(b.viewer, b.target));
    assert.deepEqual(await caller.lifecycle.read(null), { effects: 0 });
    b.release();
    assert.equal(f.gateway.readiness(), true);
  } finally {
    a.release();
    b.release();
    await f.close();
  }
});

test("replacement and shutdown revoke exact leases but wait for their explicit cleanup proofs", async () => {
  const f = await fixture(),
    old = f.gateway.acquire(viewer, f.target());
  try {
    f.gateway.registerHost({ route, manifest: f.host.manifest, transport: f.peer });
    assert.equal(old.signal.aborted, true);
    old.release();
    const replacement = f.gateway.acquire(viewer, f.target());
    const closing = f.gateway.close();
    assert.equal(replacement.signal.aborted, true);
    assert.equal(f.gateway.readiness(), false, "Revocation is not channel cleanup proof");
    replacement.release();
    await closing;
    assert.equal(f.gateway.readiness(), true);
    assert.equal(f.effects(), 0);
  } finally {
    old.release();
    await f.close();
  }
});

test("channel capacity stays charged until the admitted lease is actually released", async () => {
  const f = await fixture();
  const gateway = new Gateway<typeof f.peer>({ authorizePeer: () => true, maxRequests: 1 });
  gateway.registerHost({ route, manifest: f.host.manifest, transport: f.peer });
  const first = gateway.acquire(viewer, f.target());
  try {
    assert.throws(() => gateway.acquire(viewer, f.target()), { code: "FULL" });
    first.release();
    const second = gateway.acquire(viewer, f.target());
    second.release();
  } finally {
    first.release();
    await gateway.close();
    await f.close();
  }
});

test("failed topology HTTP request construction acquires no Host routing lease", async () => {
  const f = await fixture();
  const handler = gatewayHttpHandler(f.gateway, {
    async authenticate(request) {
      await request.text();
      return viewer;
    },
  });
  try {
    await assert.rejects(
      handler(
        new Request("http://fixture.invalid/trpc/topology", { method: "POST", body: "consumed" }),
      ),
    );
    assert.equal(f.gateway.readiness(), true);
    assert.equal(f.effects(), 0);
  } finally {
    await f.close();
  }
});
