import type { CatalogEndpointOptions } from "../node-contracts.js";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  canonicalJson,
  cloneJson,
  closeOnAbort,
  type Json,
  type SessionScope,
} from "../../protocol/index.js";
import {
  queryCatalog,
  type CatalogEntry,
  type CatalogQuery,
  type CatalogPatch,
} from "../../catalog/index.js";
import type { CatalogAuthorityPort } from "../../catalog/index.js";
import { GatewayError, type HostPeer } from "../../gateway/index.js";
import type { HostRoute, HostManifest } from "../../host/contracts.js";
import type { CatalogActor, CatalogListing } from "../contracts.js";
export type * from "../contracts.js";
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const json = z.custom<Json>((value) => {
  try {
    canonicalJson(value as Json, 65536);
    return true;
  } catch {
    return false;
  }
});
const selection = z
  .object({
    query: z
      .object({
        text: z.string().max(256).optional(),
        host: id.optional(),
        nativeKind: id.optional(),
        pinnedOnly: z.boolean().optional(),
        includeArchived: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    pinned: z.array(z.string().max(1024)).max(256).optional(),
  })
  .strict();
const original = z.object({ host: id, session: id, id }).strict();
const t = initTRPC.context<CatalogActor>().create({
  isDev: false,
  sse: {
    ping: { enabled: true, intervalMs: 15000 },
    client: { reconnectAfterInactivityMs: 45000 },
  },
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message: error.code,
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        ...(shape.data.path ? { path: shape.data.path } : {}),
      },
    };
  },
});
const authorized = t.procedure.use(({ ctx, type, next }) => {
  if (
    !ctx.connection ||
    !ctx.principal ||
    !ctx.actions.includes(type === "mutation" ? "control" : "read")
  )
    throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
function scope(ctx: CatalogActor, input: { host: string; session: string }): SessionScope {
  if (!ctx.hosts.includes(input.host)) throw new TRPCError({ code: "FORBIDDEN" });
  return {
    connection: ctx.connection,
    principal: ctx.principal,
    host: input.host,
    session: input.session,
  };
}
/** Root router owns authentication-derived scope, not native lifetimes. */
function catalogService(
  catalog: CatalogAuthorityPort,
  options: {
    authorizeCreate(actor: CatalogActor, host: string, target: CatalogEntry["target"]): boolean;
    maxSnapshotBytes?: number;
    maxObservers?: number;
  },
) {
  const watches = new Set<AsyncIterableIterator<CatalogListing>>();
  const calls = new Set<Promise<unknown>>();
  let closed = false;
  const procedure = authorized.use(async ({ next, signal }) => {
    if (signal?.aborted) throw new TRPCError({ code: "CLIENT_CLOSED_REQUEST" });
    if (closed) throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
    const pending = next();
    calls.add(pending);
    try {
      return await pending;
    } finally {
      calls.delete(pending);
    }
  });
  const list = (ctx: CatalogActor, input: z.output<typeof selection>): CatalogListing => {
    const entries = catalog.list(ctx).filter((entry) => ctx.hosts.includes(entry.scope.host));
    const result = {
      authority: catalog.authority,
      ...queryCatalog(entries, input.query as CatalogQuery | undefined, input.pinned),
    };
    return cloneJson(
      result as unknown as Json,
      options.maxSnapshotBytes ?? 1048576,
    ) as unknown as CatalogListing;
  };
  const router = t.router({
    list: procedure.input(selection).query(({ ctx, input }) => list(ctx, input)),
    watch: procedure.input(selection).subscription(({ ctx, input, signal }) => {
      if (closed) throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
      if (watches.size >= (options.maxObservers ?? 64))
        throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
      let ended = false,
        latest: CatalogListing | undefined,
        failed: unknown,
        waiting:
          | { resolve(value: IteratorResult<CatalogListing>): void; reject(error: unknown): void }
          | undefined;
      const publish = () => {
        if (ended) return;
        try {
          latest = list(ctx, input);
          if (waiting) {
            const held = waiting;
            waiting = undefined;
            const value = latest;
            latest = undefined;
            held.resolve({ done: false, value });
          }
        } catch (error) {
          failed = error;
          waiting?.reject(error);
          waiting = undefined;
        }
      };
      const release = catalog.subscribe(publish);
      publish();
      const iterator: AsyncIterableIterator<CatalogListing> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          if (failed) throw failed;
          if (ended) return { done: true, value: undefined };
          if (latest) {
            const value = latest;
            latest = undefined;
            return { done: false, value };
          }
          if (waiting) throw Error("Concurrent catalog observation");
          return new Promise((resolve, reject) => {
            waiting = { resolve, reject };
          });
        },
        async return() {
          if (!ended) {
            ended = true;
            release();
            watches.delete(iterator);
            waiting?.resolve({ done: true, value: undefined });
            waiting = undefined;
            latest = undefined;
          }
          return { done: true, value: undefined };
        },
      };
      watches.add(iterator);
      return closeOnAbort(iterator, signal);
    }),
    get: procedure
      .input(original.omit({ id: true }))
      .query(({ ctx, input }) => catalog.get(scope(ctx, input))),
    original: procedure
      .input(original)
      .query(({ ctx, input }) => catalog.original(scope(ctx, input), input.id)),
    create: procedure
      .input(
        original.extend({
          target: z
            .object({
              owner: id,
              nativeKind: id,
              contractId: id,
              contractVersion: z.number().int().positive(),
            })
            .strict(),
          name: z.string().max(512),
          workspace: json,
          selection: json,
          data: json.optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        const selected = scope(ctx, input);
        if (!options.authorizeCreate(ctx, input.host, input.target))
          throw new TRPCError({ code: "FORBIDDEN" });
        return catalog.create({
          scope: selected,
          id: input.id,
          target: input.target,
          name: input.name,
          workspace: input.workspace,
          selection: input.selection,
          ...(input.data === undefined ? {} : { data: input.data }),
        });
      }),
    patch: procedure
      .input(
        original.extend({
          revision: z.number().int().positive(),
          patch: z
            .object({
              name: z.string().max(512).optional(),
              watched: z.boolean().optional(),
              data: json.optional(),
            })
            .strict(),
        }),
      )
      .mutation(({ ctx, input }) =>
        catalog.patch(
          scope(ctx, input),
          input.id,
          input.revision,
          Object.fromEntries(
            Object.entries(input.patch).filter(([, value]) => value !== undefined),
          ) as CatalogPatch,
        ),
      ),
    reconcile: procedure
      .input(original.omit({ id: true }))
      .query(({ ctx, input }) => catalog.reconcile(scope(ctx, input))),
    publishArchive: procedure
      .input(original.extend({ hostOriginalId: id, generation: z.number().int().positive() }))
      .mutation(({ ctx, input }) =>
        catalog.publishArchive(scope(ctx, input), input.id, input.hostOriginalId, input.generation),
      ),
    reconcileArchive: procedure
      .input(original)
      .query(({ ctx, input }) => catalog.reconcileArchive(scope(ctx, input), input.id)),
  });
  return {
    router,
    async close() {
      closed = true;
      // Quiet observers retire immediately; admitted effects retain their settlement.
      await Promise.all([...watches].map((watch) => watch.return?.()));
      await Promise.allSettled([...calls]);
    },
  };
}
export function catalogRouter(...input: Parameters<typeof catalogService>) {
  return catalogService(...input).router;
}
export type CatalogRouter = ReturnType<typeof catalogRouter>;
/** A routed RPC authority. No fake harness, lifecycle or native session exists.
 * authenticate must derive delegated actor rights from verified transport state. */
export function catalogEndpoint(options: CatalogEndpointOptions) {
  if (options.route.authority !== options.catalog.authority) throw Error("Root authority fenced");
  const service = catalogService(options.catalog, options),
    router = service.router,
    route = cloneJson(options.route as unknown as Json, 4096) as unknown as HostRoute,
    manifest = cloneJson(options.manifest as unknown as Json, 65536) as unknown as HostManifest;
  let closed = false;
  const peer: HostPeer<CatalogRouter> = {
    route,
    manifest,
    router,
    async context(viewer, target) {
      if (closed) throw new GatewayError("UNAVAILABLE");
      if (
        target.session ||
        canonicalJson(target.route as unknown as Json, 4096).json !==
          canonicalJson(route as unknown as Json, 4096).json ||
        target.expected.contractId !== manifest.contractId ||
        target.expected.contractVersion !== manifest.contractVersion ||
        target.expected.compositionId !== manifest.compositionId
      )
        throw new GatewayError("FENCED");
      const actor = await options.authenticate(viewer, target);
      if (closed) throw new GatewayError("UNAVAILABLE");
      if (!actor) throw new GatewayError("FORBIDDEN");
      return actor;
    },
  };
  return {
    router,
    peer,
    async close() {
      closed = true;
      await service.close();
    },
  };
}
