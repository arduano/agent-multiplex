import assert from "node:assert/strict";
import test from "node:test";
import { AuxiliaryCustody } from "../../src/reference/server/custody.js";
import type { Json, RunRef } from "../../src/protocol/index.js";
import type { OpeningCapsule, OpeningStopProof } from "../../src/runtime/index.js";

const scope = { connection: "connection", principal: "owner", host: "host", session: "session" };
const run: RunRef = { scope, generation: 1, nativeSession: "native" };
const capsule: OpeningCapsule = {
  opening: { scope, generation: 1, operationId: "reader" },
  identity: {
    attachment: "attachment",
    process: "process",
    containment: "containment",
    placement: "dedicated",
  },
};
const proof = (value: OpeningCapsule): OpeningStopProof => ({
  ...value,
  state: "stopped",
  scope: "nativeTree",
  acquisitionSealed: true,
  noAutomaticContinuation: true,
});
function fixture(initial: Json | null = null) {
  let checkpoint = initial,
    writes = 0;
  return {
    owner: new AuxiliaryCustody({
      checkpoint() {
        return structuredClone(checkpoint);
      },
      saveCheckpoint(actualScope, value) {
        assert.deepEqual(actualScope, scope);
        checkpoint = structuredClone(value);
        writes++;
      },
    }),
    get writes() {
      return writes;
    },
    get checkpoint() {
      return checkpoint;
    },
  };
}

test("auxiliary checkpoint parsing fails closed before writes for invalid versions, phases, runs and capsules", async () => {
  const valid = { version: 1, run, state: { state: "none" } };
  const values: unknown[] = [
    null,
    { ...valid, version: 2 },
    { ...valid, extra: true },
    { ...valid, state: { state: "invented" } },
    { ...valid, state: { state: "none", capsule } },
    { ...valid, run: { ...run, generation: -1 } },
    { ...valid, run: { ...run, nativeSession: "" } },
    { ...valid, run: { ...run, scope: { ...scope, principal: "foreign" } } },
    {
      ...valid,
      state: {
        state: "allocating",
        run: { ...run, nativeSession: "foreign" },
        opening: capsule.opening,
      },
    },
    {
      ...valid,
      state: { state: "allocating", run, opening: { ...capsule.opening, generation: 2 } },
    },
    {
      ...valid,
      state: {
        state: "owned",
        run,
        capsule: { ...capsule, identity: { ...capsule.identity, placement: "unproved" } },
      },
    },
    {
      ...valid,
      state: {
        state: "owned",
        run,
        capsule: {
          ...capsule,
          opening: { ...capsule.opening, scope: { ...scope, host: "foreign" } },
        },
      },
    },
  ];
  for (const value of values) {
    // A JSON null checkpoint means absence; null nested state must not mean it.
    const malformed = value === null ? { ...valid, state: null } : value;
    const f = fixture(malformed as Json),
      port = f.owner.forRun(run);
    await assert.rejects(port.read());
    await assert.rejects(port.begin(run, capsule.opening));
    assert.equal(f.writes, 0);
    assert.deepEqual(f.checkpoint, malformed);
  }
});

test("only exact positive release permits a validated empty record to move generation", async () => {
  const f = fixture(),
    originalInput = { ...run, scope: { ...run.scope } },
    first = f.owner.forRun(originalInput);
  originalInput.scope.session = "mutated-caller";
  assert.deepEqual(await first.read(), { state: "none" });
  await first.begin(run, capsule.opening);
  await first.owned(run, capsule);
  const nextRun = { ...run, generation: 2 },
    next = f.owner.forRun(nextRun);
  await assert.rejects(next.read(), /generation fenced/);
  await assert.rejects(
    first.released(proof({ ...capsule, identity: { ...capsule.identity, process: "foreign" } })),
    { code: "FENCED" },
  );
  assert.equal((await first.read()).state, "owned");
  const recovered = await f.owner.codexLease(run);
  assert.deepEqual(recovered.prior, capsule);
  await first.released(proof(capsule));
  assert.deepEqual(await next.read(), { state: "none" });
  const lease = await f.owner.codexLease(nextRun);
  await assert.rejects(
    async () => lease.begin({ ...lease.opening, generation: 3 }),
    /opening fenced/,
  );
  await lease.begin(lease.opening);
  const nextCapsule = { ...capsule, opening: lease.opening };
  await lease.owned(nextCapsule);
  assert.equal((await next.read()).state, "owned");
  await lease.released(proof(nextCapsule));
  assert.deepEqual(await next.read(), { state: "none" });
  assert.equal(f.writes, 6);
});
