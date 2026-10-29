import { initTRPC, TRPCError, type AnyRouter } from "@trpc/server";
import { z } from "zod";
import { isAsyncIterable } from "@trpc/server/unstable-core-do-not-import";
import { closeOnAbort } from "../../protocol/index.js";
import type {
  HostActivationRecovery,
  AnyLifecycle,
  Extensions,
  HarnessDefinition,
  HostActivationOptions,
  HostCall,
  HostContext,
  HostDefinition,
  HostExtension,
  HostManifest,
  LifecycleRouter,
  LifecycleRuntime,
  PluginIdentity,
  SessionsOf,
  StoredPluginRecord,
  UpdateReadiness,
} from "../contracts.js";

const trpc = initTRPC.context<HostContext>().create({
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
export const hostRouter = trpc.router;
/** Extension and lifecycle procedures use this builder. Domain owners retain
 * finer authorization and durable original admission; this gate owns activation. */
export const hostMiddleware = trpc.middleware(async ({ ctx, path, type, signal, next }) => {
  if (signal?.aborted) throw new TRPCError({ code: "CLIENT_CLOSED_REQUEST" });
  const action = type === "mutation" ? "control" : "read";
  if (
    !ctx.identity?.connection ||
    !ctx.identity.principal ||
    !ctx.identity.actions.includes(action) ||
    !ctx.admit
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Host action denied" });
  }
  const release = ctx.admit({ path, type });
  try {
    const result = await next();
    if (result.ok && type === "subscription" && isAsyncIterable(result.data))
      return { ...result, data: closeOnAbort(result.data, signal) };
    return result;
  } finally {
    release();
  }
});
export const hostProcedure = trpc.procedure.use(hostMiddleware);
const emptyRouter = hostRouter({});
type EmptyRouter = typeof emptyRouter;

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value))
    throw new TypeError("Invalid public identity");
}
function identity(value: PluginIdentity): void {
  identifier(value?.id);
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Number.isSafeInteger(value.recordVersion) ||
    value.recordVersion < 1
  )
    throw new TypeError("Invalid plugin version");
}
function harness(value: HarnessDefinition): void {
  identity(value?.identity);
  identifier(value.nativeKind);
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((capability) => typeof capability !== "string" || !capability)
  )
    throw new TypeError("Invalid harness capabilities");
}
function requireCapabilities(
  requires: readonly string[] | undefined,
  available: readonly string[],
): void {
  for (const capability of requires ?? [])
    if (!available.includes(capability))
      throw new TypeError(`Missing harness capability: ${capability}`);
}
function sameRoute(left: HostContext["route"], right: HostContext["route"]): boolean {
  return (
    left.authority === right.authority &&
    left.host === right.host &&
    left.owner === right.owner &&
    left.routeEpoch === right.routeEpoch
  );
}
function sameContract(expected: HostCall["expected"], actual: HostManifest): boolean {
  return (
    expected.contractId === actual.contractId &&
    expected.contractVersion === actual.contractVersion &&
    expected.compositionId === actual.compositionId
  );
}
function publicIdentity(value: PluginIdentity): PluginIdentity {
  return Object.freeze({
    id: value.id,
    version: value.version,
    recordVersion: value.recordVersion,
  });
}
function manifestOf<H extends HarnessDefinition>(
  definition: {
    contract: { id: string; version: number };
    harness: H;
    gateway?: { id: string; version: number };
  },
  lifecycle: AnyLifecycle,
  extensions: Extensions,
): HostManifest {
  const plugins = {
    harness: publicIdentity(definition.harness.identity),
    lifecycle: publicIdentity(lifecycle.identity),
    extensions: Object.freeze(
      Object.fromEntries(
        Object.keys(extensions)
          .sort()
          .map((key) => [key, publicIdentity(extensions[key]!.identity)]),
      ),
    ),
    ...(definition.gateway
      ? {
          gateway: Object.freeze({
            id: definition.gateway.id,
            version: definition.gateway.version,
          }),
        }
      : {}),
  };
  return Object.freeze({
    contractId: definition.contract.id,
    contractVersion: definition.contract.version,
    nativeKind: definition.harness.nativeKind,
    compositionId: JSON.stringify({
      nativeKind: definition.harness.nativeKind,
      ...plugins,
    }),
    ...plugins,
  });
}
function checkRecords(records: readonly StoredPluginRecord[], manifest: HostManifest): void {
  for (const record of records) {
    const selected =
      record.kind === "extension"
        ? manifest.extensions[record.namespace ?? ""]
        : manifest[record.kind];
    if (
      !selected ||
      selected.id !== record.identity.id ||
      selected.recordVersion !== record.identity.recordVersion
    )
      throw new TypeError("Stored plugin record is incompatible with composition");
  }
}

/** This function acquires nothing and does not invoke the lifecycle factory. */
export function defineHost<
  H extends HarnessDefinition,
  L extends AnyLifecycle,
  E extends Extensions = Record<never, never>,
  NR extends AnyRouter = EmptyRouter,
  GR extends AnyRouter = EmptyRouter,
>(definition: HostDefinition<H, L, E, NR, GR>): HostDefinition<H, L, E, NR, GR> {
  identifier(definition.contract?.id);
  if (!Number.isSafeInteger(definition.contract.version) || definition.contract.version < 1)
    throw new TypeError("Invalid contract version");
  harness(definition.harness);
  if (definition.gateway) {
    identifier(definition.gateway.id);
    if (!Number.isSafeInteger(definition.gateway.version) || definition.gateway.version < 1)
      throw new TypeError("Invalid Gateway contract version");
  }
  if (typeof definition.lifecycle !== "function")
    throw new TypeError("Exactly one lifecycle is required");
  return Object.freeze({ ...definition });
}

export class HostActivationError extends AggregateError {
  readonly #definition: unknown;
  readonly #recovery: HostActivationRecovery<unknown>;
  constructor(definition: unknown, recovery: HostActivationRecovery<unknown>, errors: unknown[]) {
    super(errors, "Host activation failed; returned owner cleanup remains unproved");
    this.#definition = definition;
    this.#recovery = recovery;
  }
  recoveryFor<
    H extends HarnessDefinition,
    L extends AnyLifecycle,
    E extends Extensions,
    NR extends AnyRouter,
    GR extends AnyRouter,
  >(definition: HostDefinition<H, L, E, NR, GR>): HostActivationRecovery<SessionsOf<L>> | null {
    return definition === this.#definition
      ? (this.#recovery as HostActivationRecovery<SessionsOf<L>>)
      : null;
  }
}

/** Custody begins immediately when open returns. Validation cannot drop owners
 * returned under a later extension name. Failure never licenses an automatic retry. */
function own<Owner>(runtime: LifecycleRuntime<Owner, AnyRouter>) {
  const extensions = new Map<string, HostExtension>();
  let lifecycleClosed = false,
    closing: Promise<void> | undefined,
    failed = false,
    failure: unknown;
  const readiness = async (): Promise<UpdateReadiness> => {
    if (failed) return { ready: false, reasons: ["Owner cleanup remains unproved"] };
    const owners = [...new Set(extensions.values()), ...(lifecycleClosed ? [] : [runtime])];
    if (
      owners.some(
        (owner) => typeof owner.readiness !== "function" || typeof owner.close !== "function",
      )
    )
      return {
        ready: false,
        reasons: ["Returned owner lacks readiness/close"],
      };
    const states = await Promise.all(owners.map((owner) => owner.readiness()));
    const reasons = states.flatMap((state) => (state.ready ? [] : state.reasons));
    return states.every((state) => state.ready) ? { ready: true } : { ready: false, reasons };
  };
  const recovery: HostActivationRecovery<Owner> = Object.freeze({
    sessions: runtime.sessions,
    get extensions() {
      return new Map(extensions);
    },
    readiness,
    async close() {
      if (failed) throw failure;
      if (closing) return closing;
      closing = (async () => {
        if (!(await readiness()).ready)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Host still owns unsettled work",
          });
        try {
          for (const extension of [...new Set(extensions.values())].reverse()) {
            await extension.close();
            for (const [key, owner] of extensions) if (owner === extension) extensions.delete(key);
          }
          if (!lifecycleClosed) {
            await runtime.close();
            lifecycleClosed = true;
          }
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        }
      })();
      try {
        await closing;
      } finally {
        closing = undefined;
      }
    },
  });
  return {
    recovery,
    get failed() {
      return failed;
    },
    capture(values: Extensions) {
      for (const [key, value] of Object.entries(values)) extensions.set(key, value);
    },
  };
}

const identitySchema = z.object({
  id: z.string(),
  version: z.number().int(),
  recordVersion: z.number().int(),
});
const manifestSchema = z.object({
  contractId: z.string(),
  contractVersion: z.number().int(),
  nativeKind: z.string(),
  compositionId: z.string(),
  harness: identitySchema,
  lifecycle: identitySchema,
  extensions: z.record(z.string(), identitySchema),
  gateway: z.object({ id: z.string(), version: z.number().int().positive() }).optional(),
});
function compose<LR extends AnyRouter, NR extends AnyRouter, E extends Extensions>(
  manifest: HostManifest,
  lifecycle: LR,
  native: NR,
  extensions: E,
  readiness: () => Promise<UpdateReadiness>,
) {
  const routers = Object.fromEntries(
    Object.entries(extensions).map(([key, value]) => [key, value.router]),
  ) as { [K in keyof E]: E[K]["router"] };
  return hostRouter({
    system: hostRouter({
      manifest: hostProcedure.output(manifestSchema).query(() => manifest),
      readiness: hostProcedure.query(readiness),
    }),
    lifecycle,
    native,
    extensions: hostRouter(routers),
  });
}
export type HostRouter<D> =
  D extends HostDefinition<infer _H, infer L, infer E, infer NR, infer _GR>
    ? ReturnType<typeof compose<LifecycleRouter<L>, NR, E>>
    : never;

/** No native fallback exists. Only the selected lifecycle may create, Stop,
 * reopen or release a native lifetime. Activation opens the selected owners. */
export async function activateHost<
  H extends HarnessDefinition,
  L extends AnyLifecycle,
  E extends Extensions,
  NR extends AnyRouter,
  GR extends AnyRouter,
>(definition: HostDefinition<H, L, E, NR, GR>, options: HostActivationOptions) {
  harness(definition.harness);
  const route = Object.freeze({ ...options.route });
  for (const value of [route.authority, route.host, route.owner, route.routeEpoch])
    identifier(value);
  const lifecycle = definition.lifecycle({ harness: definition.harness });
  identity(lifecycle.identity);
  requireCapabilities(lifecycle.requires, definition.harness.capabilities);
  checkRecords(
    (options.records ?? []).filter((record) => record.kind !== "extension"),
    manifestOf(definition, lifecycle, {}),
  );
  const runtime = await lifecycle.open({ route });
  const custody = own(runtime);
  let phase: "active" | "closing" | "closed" | "failed" = "active",
    failure: unknown,
    admitted = 0;
  try {
    if (typeof runtime.readiness !== "function" || typeof runtime.close !== "function")
      throw new TypeError("Lifecycle must return readiness and close ownership");
    const extensions =
      definition.extensions?.({
        sessions: runtime.sessions as SessionsOf<L>,
      }) ?? ({} as E);
    custody.capture(extensions);
    for (const [key, extension] of Object.entries(extensions)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(key))
        throw new TypeError("Invalid extension name");
      if (
        [
          "system",
          "lifecycle",
          "native",
          "extensions",
          "then",
          "__proto__",
          "prototype",
          "constructor",
        ].includes(key)
      )
        throw new TypeError("Reserved extension name");
      identity(extension.identity);
      requireCapabilities(extension.requires, definition.harness.capabilities);
      if (typeof extension.readiness !== "function" || typeof extension.close !== "function")
        throw new TypeError("Extension must declare readiness and close");
    }
    const manifest = manifestOf(definition, lifecycle, extensions);
    checkRecords(options.records ?? [], manifest);
    const readiness = async (): Promise<UpdateReadiness> => {
      if (phase !== "active" || admitted)
        return { ready: false, reasons: ["Host admission is not idle"] };
      const state = await custody.recovery.readiness();
      return phase === "active" && !admitted
        ? state
        : {
            ready: false,
            reasons: ["Host admission changed during observation"],
          };
    };
    const admit: NonNullable<HostContext["admit"]> = ({ path }) => {
      if (phase !== "active")
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Host admission is closed",
        });
      if (path.startsWith("system.")) return () => {};
      admitted++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          admitted--;
        }
      };
    };
    const native =
      definition.native?.({
        sessions: runtime.sessions as SessionsOf<L>,
        harness: definition.harness,
      }) ?? (emptyRouter as NR);
    return {
      manifest,
      router: compose(
        manifest,
        runtime.router as LifecycleRouter<L>,
        native,
        extensions,
        readiness,
      ),
      sessions: runtime.sessions as SessionsOf<L>,
      async context(call: HostCall): Promise<HostContext> {
        if (phase !== "active")
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Host is not active",
          });
        if (!sameContract(call.expected, manifest))
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Host contract mismatch",
          });
        if (
          call.session &&
          (!call.session.id ||
            !Number.isSafeInteger(call.session.generation) ||
            call.session.generation < 1)
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid session scope",
          });
        const context = await options.authenticate(call);
        if (phase !== "active")
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Host is not active",
          });
        if (
          !context ||
          !sameRoute(context.route, route) ||
          !context.identity.connection ||
          !context.identity.principal
        )
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Host scope denied",
          });
        if (
          call.session
            ? !context.session ||
              context.session.id !== call.session.id ||
              context.session.generation !== call.session.generation
            : !!context.session
        )
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Session scope denied",
          });
        return Object.freeze({
          identity: Object.freeze({
            connection: context.identity.connection,
            principal: context.identity.principal,
            actions: Object.freeze([...context.identity.actions]),
          }),
          route,
          ...(context.session ? { session: Object.freeze({ ...context.session }) } : {}),
          admit,
        });
      },
      readiness,
      async close(): Promise<void> {
        if (phase === "closed") return;
        if (phase === "failed") throw failure;
        if (phase === "closing")
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Host close is already in progress",
          });
        phase = "closing";
        try {
          if (admitted)
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Host procedures are admitted",
            });
          await custody.recovery.close();
          phase = "closed";
        } catch (error) {
          if (custody.failed) {
            phase = "failed";
            failure = error;
          } else phase = "active";
          throw error;
        }
      },
    };
  } catch (error) {
    try {
      await custody.recovery.close();
    } catch (cleanup) {
      throw new HostActivationError(definition, custody.recovery, [error, cleanup]);
    }
    throw error;
  }
}
