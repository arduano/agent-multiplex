import { z } from "zod";
import { canonicalJson, cloneJson, type Json, type Receipt } from "../../protocol/index.js";
import type { NativeOpening } from "../../runtime/contracts.js";
import type { NativePreparationRefusal } from "../contracts.js";

export const copy = (value: Json): Json => cloneJson(value, 262144);
export const json = z.custom<Json>((value) => {
  try {
    canonicalJson(value as Json, 262144);
    return true;
  } catch {
    return false;
  }
});
const scopeSchema = z.object({
  connection: z.string(),
  principal: z.string(),
  host: z.string(),
  session: z.string(),
});
const openingSchema = z.object({
  scope: scopeSchema,
  generation: z.number().int().positive(),
  operationId: z.string(),
});
const capsuleSchema = z.object({
  opening: openingSchema,
  identity: z.object({
    attachment: z.string(),
    process: z.string(),
    containment: z.string(),
    placement: z.enum(["shared", "dedicated"]),
  }),
});
export const preparationRefusalSchema = z
  .object({
    state: z.literal("refused"),
    noAllocation: z.literal(true),
    code: z.enum(["BUSY", "INVALID", "UNSUPPORTED"]),
  })
  .strict();
export const allocationSchema = z.object({
  cwd: z.string(),
  ownership: z.enum(["borrowed", "owned"]),
  data: json,
});
export const recordSchema = z.object({
  version: z.literal(2),
  scope: scopeSchema,
  custody: z.object({
    native: z.object({ id: z.string(), recordVersion: z.number().int().positive() }),
    workspace: z.object({ id: z.string(), recordVersion: z.number().int().positive() }),
  }),
  phase: z.enum([
    "preparing",
    "opening",
    "running",
    "stopping",
    "stopped",
    "archiving",
    "archived",
    "uncertain",
  ]),
  generation: z.number().int().nonnegative(),
  nativeSession: z.string().nullable(),
  selection: json,
  selectionSource: z.enum(["requested", "observed"]),
  activity: z.enum(["working", "idle", "unknown"]),
  workspace: allocationSchema.nullable(),
  opening: openingSchema.nullable(),
  capsule: capsuleSchema.nullable(),
  stopProof: json.nullable(),
  stopRequested: z.boolean(),
  workspaceAttempted: z.boolean(),
  nativeAttempted: z.boolean(),
});
export type RecordState = z.output<typeof recordSchema>;
export type Entry = {
  record: RecordState;
  revision: number;
  actual: Set<Promise<unknown>>;
  acquisition?: Promise<NativeOpening | NativePreparationRefusal | null>;
  prepared?: NativeOpening;
  openingTask?: Promise<Receipt>;
};

export const runSchema = z.object({
  scope: scopeSchema,
  generation: z.number().int().positive(),
  nativeSession: z.string().min(1),
});
