import type { BridgeContext } from "@arduano/p2prpc-core/browser";
import { initTRPC, TRPCError } from "@trpc/server";
import { FileError } from "../../files/index.js";
import { AssetError } from "../contracts.js";
import { z } from "zod";
import { hostMiddleware, type HostContext } from "../../host/index.js";
import type { SessionScope } from "../../protocol/index.js";
import { uploadSpecSchema, ASSET_MAX_FILE_BYTES } from "../contracts.js";
import type { AssetTransferMetadata, AssetTransferPort } from "../contracts.js";
import { check } from "../validation.js";
const domainCodes = {
  INVALID: "BAD_REQUEST",
  FENCED: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  CAPACITY: "TOO_MANY_REQUESTS",
  BUSY: "PRECONDITION_FAILED",
  UNSUPPORTED: "METHOD_NOT_SUPPORTED",
  CLOSED: "PRECONDITION_FAILED",
  EXPIRED: "PRECONDITION_FAILED",
  CORRUPT: "PRECONDITION_FAILED",
} as const;
const assetTRPC = initTRPC
  .context<HostContext & Partial<BridgeContext<AssetTransferMetadata>>>()
  .create({ isDev: false });
const assetProcedure = assetTRPC.procedure.use(hostMiddleware).use(async ({ ctx, next }) => {
  if (!ctx.bridge?.files)
    throw new TRPCError({ code: "FORBIDDEN", message: "ASSET_BRIDGE_REQUIRED" });
  const result = await next({ ctx: { bridge: ctx.bridge } });
  if (result.ok) return result;
  const cause = result.error.cause;
  const code = cause instanceof AssetError || cause instanceof FileError ? cause.code : null;
  return {
    ...result,
    error: new TRPCError({
      code: code ? domainCodes[code] : "INTERNAL_SERVER_ERROR",
      message: code ? `ASSET_${code}` : "ASSET_FAILED",
    }),
  };
});
const id = z.string().min(1).max(256),
  session = z.object({ session: id });
const scopeSchema = z.object({ connection: id, principal: id, host: id, session: id }).strict();
const fileSchema = z
  .object({
    kind: z.literal("stored"),
    scope: scopeSchema,
    id,
    name: id,
    bytes: z.number().int().min(0).max(ASSET_MAX_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.string().min(1).max(128),
    origin: z.enum(["upload", "capture"]),
    retention: z.enum(["session", "cache"]),
  })
  .strict();
function scope(
  context: Pick<HostContext, "identity" | "route"> & {
    session?: HostContext["session"] | undefined;
  },
  session: string,
): SessionScope {
  check(!context.session || context.session.id === session, "FENCED");
  return {
    connection: context.identity.connection,
    principal: context.identity.principal,
    host: context.route.host,
    session,
  };
}
/** Uses Host's existing auth/route admission. Resource transfers are not agent originals. */
export function assetRouter(owner: AssetTransferPort) {
  return assetTRPC.router({
    begin: assetProcedure
      .input(session.extend({ file: uploadSpecSchema }).strict())
      .mutation(({ ctx, input }) => owner.begin(scope(ctx, input.session), input.file)),
    status: assetProcedure
      .input(session.extend({ id }).strict())
      .query(({ ctx, input }) => owner.status(scope(ctx, input.session), input.id)),
    abort: assetProcedure
      .input(session.extend({ id, token: id }).strict())
      .mutation(({ ctx, input }) => owner.abort(scope(ctx, input.session), input.id, input.token)),
    acquire: assetProcedure
      .input(session.extend({ file: fileSchema }).strict())
      .query(({ ctx, input }) => ({
        file: input.file,
        handle: ctx.bridge.files.share(owner.source(scope(ctx, input.session), input.file)),
      })),
  });
}
