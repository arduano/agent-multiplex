import { z } from "zod";

export const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const routeSchema = z
  .object({ authority: identifier, host: identifier, owner: identifier, routeEpoch: identifier })
  .strict();
const plugin = z
  .object({
    id: identifier,
    version: z.number().int().positive(),
    recordVersion: z.number().int().positive(),
  })
  .strict();
export const manifestSchema = z
  .object({
    contractId: identifier,
    contractVersion: z.number().int().positive(),
    nativeKind: identifier,
    compositionId: z.string().max(32768),
    gateway: z.object({ id: identifier, version: z.number().int().positive() }).strict().optional(),
    harness: plugin,
    lifecycle: plugin,
    extensions: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/), plugin)
      .refine((value) => Object.keys(value).length <= 64),
  })
  .strict();
