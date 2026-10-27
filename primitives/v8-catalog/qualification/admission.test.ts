import assert from "node:assert/strict";
import test from "node:test";
import {defer, fixture, request, scope, target, until} from "./fixtures.js";
import type {HostCreationStatus} from "../src/contracts/types.js";

for (const boundary of ["reservation", "watch"] as const) test(`Catalog seal refuses an original at the ${boundary} boundary without future Host dispatch`, async () => {
  const f = await fixture({observationMs: 5}), entered = defer<void>(), release = defer<void>();
  let mutations = 0, releases = 0, seal: Promise<void> | undefined;
  const unregister = f.authority.register({target,
    async create() { mutations++; return {state: "unknown"}; },
    async createAdmitted() { mutations++; return {state: "pending"}; },
    async read() { return {state: "unknown"}; },
    async watch() { entered.resolve(); await release.promise; return () => { releases++; }; },
  });
  const detach = f.authority.subscribe(scope, () => { if (boundary === "reservation") seal ??= f.authority.sealAdmissions(); });
  try {
    const creating = f.authority.create(request());
    if (boundary === "watch") { await entered.promise; seal = f.authority.sealAdmissions(); }
    else await until(() => !!seal);
    await seal;
    assert.equal((await creating).original.id, request().id); assert.equal(mutations, 0);
    assert.equal((await f.authority.creation(scope, request().id))?.state, "refused");
    assert.equal((await f.authority.create(request())).state, "refused");
    await assert.rejects(f.authority.create({...request(), metadata: {name: "different", cwd: null}}), {code: "CONFLICT"});
    await assert.rejects(f.authority.create(request("new", "new")), {code: "CLOSED"});
    assert.equal((await f.authority.list(scope)).length, 1);
    release.resolve(); if (boundary === "watch") await until(() => releases === 1);
    assert.equal(mutations, 0, "A late observer completion cannot cross sealed admission");
  } finally { release.resolve(); detach(); unregister(); await f.dispose(); }
});

test("a legacy pending/unknown Host is BUSY until positive exact-original read, without replay or invented refusal", async () => {
  const f = await fixture({observationMs: 5}), entered = defer<void>(), release = defer<HostCreationStatus>();
  let mutations = 0, reads = 0, status: HostCreationStatus = {state: "unknown"};
  f.authority.register({target, async create() { mutations++; entered.resolve(); return release.promise; }, async read() { reads++; return status; }});
  try {
    const creating = f.authority.create(request()); await entered.promise;
    await assert.rejects(f.authority.sealAdmissions(), {code: "BUSY"});
    release.resolve({state: "unknown"}); await creating;
    await until(async () => (await f.authority.creation(scope, request().id))?.state === "outcomeUnknown");
    await assert.rejects(f.authority.sealAdmissions(), {code: "BUSY"});
    status = {state: "created", binding: {nativeSession: "exact-native", generation: 1, kind: target.kind, placement: target.placement}};
    assert.equal((await f.authority.creation(scope, request().id))?.state, "nativeCreated");
    await f.authority.sealAdmissions(); assert.equal(mutations, 1); assert.ok(reads > 0);
    assert.equal((await f.authority.create(request())).native?.nativeSession, "exact-native");
  } finally { release.resolve({state: "refused"}); await f.dispose(); }
});
