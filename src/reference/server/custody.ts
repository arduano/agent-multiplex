import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson, scopeKey, type Json, type RunRef } from "../../protocol/index.js";
import type { CheckpointPort } from "../../storage/contracts.js";
import {
  openingCapsule,
  openingProof,
  type OpeningCapsule,
  type OpeningRef,
  type OpeningStopProof,
  type ReaderCustody,
  type ReaderCustodyPort,
} from "../../runtime/index.js";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const scopeSchema = z.object({ connection: id, principal: id, host: id, session: id }).strict();
const runSchema = z
  .object({ scope: scopeSchema, generation: z.number().int().positive(), nativeSession: id })
  .strict();
const openingSchema = z
  .object({ scope: scopeSchema, generation: z.number().int().positive(), operationId: id })
  .strict();
const token = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\x00]+$/);
const capsuleSchema = z
  .object({
    opening: openingSchema,
    identity: z
      .object({
        attachment: token,
        process: token,
        containment: token,
        placement: z.enum(["shared", "dedicated"]),
      })
      .strict(),
  })
  .strict();
const stateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("unconfirmed") }).strict(),
  z.object({ state: z.literal("allocating"), run: runSchema, opening: openingSchema }).strict(),
  z.object({ state: z.literal("owned"), run: runSchema, capsule: capsuleSchema }).strict(),
]);
const recordSchema = z
  .object({ version: z.literal(1), run: runSchema, state: stateSchema })
  .strict();
const same = (left: RunRef | OpeningRef, right: RunRef | OpeningRef) =>
  canonicalJson(left as unknown as Json, 8192).json ===
  canonicalJson(right as unknown as Json, 8192).json;
function exactOpening(run: RunRef, opening: OpeningRef): void {
  if (scopeKey(opening.scope) !== scopeKey(run.scope) || opening.generation !== run.generation)
    throw Error("Reader opening fenced");
}

/** Durable auxiliary-resource records, using one dedicated checkpoint writer.
 * The consuming adapter exclusively owns each helper until actual close; this
 * persistence bridge neither allocates helpers nor admits agent originals. */
export class AuxiliaryCustody {
  constructor(readonly journal: Pick<CheckpointPort, "checkpoint" | "saveCheckpoint">) {}
  forRun(input: RunRef): ReaderCustodyPort {
    const run = runSchema.parse(input);
    const read = (): ReaderCustody => {
      const value = this.journal.checkpoint(run.scope);
      if (value === null) return { state: "none" };
      const record = recordSchema.parse(value),
        state = record.state;
      if (scopeKey(record.run.scope) !== scopeKey(run.scope))
        throw Error("Auxiliary custody scope fenced");
      // Validate even an empty record's run. Only proved absence of custody may
      // move to another generation; unknown or retained ownership never can.
      if (state.state === "none") return state;
      if (!same(record.run, run)) throw Error("Auxiliary custody generation fenced");
      if (state.state === "allocating" || state.state === "owned") {
        if (!same(state.run, record.run)) throw Error("Auxiliary custody run fenced");
        exactOpening(
          run,
          state.state === "allocating" ? state.opening : openingCapsule(state.capsule).opening,
        );
      }
      return state;
    };
    const save = (state: ReaderCustody) =>
      this.journal.saveCheckpoint(run.scope, {
        version: 1,
        run: run as unknown as Json,
        state: state as unknown as Json,
      });
    return {
      async read() {
        return read();
      },
      async begin(selected, inputOpening) {
        const opening = openingSchema.parse(inputOpening);
        if (!same(runSchema.parse(selected), run)) throw Error("Reader run fenced");
        exactOpening(run, opening);
        if (read().state !== "none") throw Error("Reader already owned");
        save({ state: "allocating", run, opening });
      },
      async owned(selected, inputCapsule) {
        const capsule = openingCapsule(capsuleSchema.parse(inputCapsule)),
          prior = read();
        if (
          prior.state !== "allocating" ||
          !same(prior.opening, capsule.opening) ||
          !same(runSchema.parse(selected), run)
        )
          throw Error("Reader ownership fenced");
        save({ state: "owned", run, capsule });
      },
      async released(proof) {
        const prior = read();
        if (prior.state !== "owned") throw Error("Reader Stop proof has no exact custody");
        openingProof(prior.capsule, proof);
        save({ state: "none" });
      },
    };
  }
  /** Persisted prior custody is recovery input only. The adapter's existing
   * same-scope reader admission prevents taking a capsule from a live helper. */
  async codexLease(input: RunRef) {
    const run = runSchema.parse(input),
      custody = this.forRun(run),
      prior = await custody.read();
    if (prior.state !== "none" && prior.state !== "owned")
      throw Error("Reader allocation remains uncertain");
    const opening: OpeningRef = {
      scope: run.scope,
      generation: run.generation,
      operationId: `history:${randomUUID()}`,
    };
    return {
      opening: structuredClone(opening),
      ...(prior.state === "owned" ? { prior: prior.capsule } : {}),
      begin: (selected: OpeningRef) => {
        if (!same(openingSchema.parse(selected), opening)) throw Error("Reader opening fenced");
        return custody.begin(run, opening);
      },
      owned: (capsule: OpeningCapsule) => custody.owned(run, capsule),
      released: (proof: OpeningStopProof) => custody.released(proof),
    };
  }
}
