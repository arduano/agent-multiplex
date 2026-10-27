import { TRPCError, type AnyRouter } from "@trpc/server";
import { z } from "zod";
import type { AuthenticateHostCall, ContractIdentity, HarnessDefinition, HostActivationContext, HostCall, HostContext, HostExtension, HostManifest, LifecyclePlugin, LifecycleRuntime, PluginIdentity, StoredPluginRecord, UpdateReadiness } from "./contracts.js";
import { hostProcedure, hostRouter } from "./router.js";

type AnyLifecycle = LifecyclePlugin<unknown, AnyRouter>;
type OwnerOf<L extends AnyLifecycle> = Awaited<ReturnType<L["open"]>>["sessions"];
type RouterOf<L extends AnyLifecycle> = Awaited<ReturnType<L["open"]>>["router"];
type Extensions = Readonly<Record<string, HostExtension>>;
type ExtensionRouters<E extends Extensions> = { [K in keyof E]: E[K]["router"] };
const emptyRouter = hostRouter({});
type EmptyRouter = typeof emptyRouter;

export interface HostDefinition<H extends HarnessDefinition, L extends AnyLifecycle, E extends Extensions, HR extends AnyRouter> {
  readonly contract: ContractIdentity;
  readonly harness: H;
  readonly lifecycle: (context: { harness: H; storage: unknown }) => L;
  readonly extensions?: (context: { sessions: OwnerOf<L> }) => E;
  readonly harnessRouter?: (context: { sessions: OwnerOf<L>; harness: H }) => HR;
}

/** Inert composition. No storage, native process or plugin factory is opened. */
export function defineHost<H extends HarnessDefinition, L extends AnyLifecycle, E extends Extensions = {}, HR extends AnyRouter = EmptyRouter>(definition: HostDefinition<H, L, E, HR>): HostDefinition<H, L, E, HR> {
  validateContract(definition.contract);
  validateHarness(definition.harness);
  if (typeof definition.lifecycle !== "function") throw new Error("Exactly one lifecycle plugin is required");
  return Object.freeze({ ...definition });
}

const identitySchema = z.object({ id: z.string(), version: z.number().int(), recordVersion: z.number().int() }).strict();
const manifestSchema = z.object({ contractId: z.string(), contractVersion: z.number().int(), compositionId: z.string(), harness: identitySchema, lifecycle: identitySchema, extensions: z.record(z.string(), identitySchema) }).strict();
function composeRouter<LR extends AnyRouter, HR extends AnyRouter, E extends Extensions>(manifest: HostManifest, lifecycle: LR, harness: HR, extensions: E, readiness: () => Promise<UpdateReadiness>) {
  const routers = Object.fromEntries(Object.entries(extensions).map(([key, value]) => [key, value.router])) as ExtensionRouters<E>;
  return hostRouter({
    system: hostRouter({
      manifest: hostProcedure.output(manifestSchema).query(() => manifest),
      updateReadiness: hostProcedure.query(readiness),
    }),
    lifecycle,
    harness,
    extensions: hostRouter(routers),
  });
}

export type HostRouter<D> = D extends HostDefinition<infer _H, infer L, infer E, infer HR>
  ? ReturnType<typeof composeRouter<RouterOf<L>, HR, E>> : never;
/** Type-only projection: no private configuration, native runtime or checkpoint. */
export type PublicHostContract<D> = D extends HostDefinition<infer H, infer L, infer E, infer HR> ? {
  router: ReturnType<typeof composeRouter<RouterOf<L>, HR, E>>;
  harness: H extends { nativeKind: infer K extends string } ? K : H["identity"]["id"];
  createInput: z.input<L["createInput"]>;
  hostData: z.output<L["public"]["host"]>;
  sessionData: z.output<L["public"]["session"]>;
  extensions: { [K in keyof E]: { hostData: z.output<E[K]["public"]["host"]>; sessionData: z.output<E[K]["public"]["session"]> } };
} : never;

export type HostActivationOptions = HostActivationContext & {
  authenticate: AuthenticateHostCall;
  records?: readonly StoredPluginRecord[];
};

/** Server-side custody only. The selected lifecycle owns any native controls;
 * the kernel exposes no invented Stop, Resume or adoption capability. */
export type HostActivationRecovery<Owner> = Readonly<{
  sessions: Owner;
  extensions: ReadonlyMap<string, HostExtension>;
  readiness(): Promise<UpdateReadiness>;
  close(): Promise<void>;
}>;
export class HostActivationError extends AggregateError {
  readonly #definition: unknown;
  readonly #recovery: HostActivationRecovery<unknown>;
  constructor(definition: unknown, recovery: HostActivationRecovery<unknown>, errors: unknown[]) {
    super(errors, "Host activation failed; retained owner cleanup unproved");
    this.#definition = definition; this.#recovery = recovery;
  }
  /** The exact static definition restores its actual lifecycle owner type.
   * Similar public manifests or routes cannot adopt another activation. */
  recoveryFor<H extends HarnessDefinition, L extends AnyLifecycle, E extends Extensions, HR extends AnyRouter>(definition: HostDefinition<H, L, E, HR>): HostActivationRecovery<OwnerOf<L>> | null {
    return definition === this.#definition ? this.#recovery as HostActivationRecovery<OwnerOf<L>> : null;
  }
}

function activationCustody<Owner>(runtime: LifecycleRuntime<Owner, AnyRouter>) {
  const extensions = new Map<string, HostExtension>();
  let lifecycleClosed = false, closing: Promise<void> | undefined, failed = false, failure: unknown;
  const readiness = async (): Promise<UpdateReadiness> => {
    if (failed) return { ready: false, reasons: ["Host owner cleanup unproved"] };
    const owners = [...new Set(extensions.values()), ...(lifecycleClosed ? [] : [runtime])];
    if (owners.some(owner => typeof owner.readiness !== "function" || typeof owner.close !== "function")) return { ready: false, reasons: ["Host owner lacks readiness/close contract"] };
    const results = await Promise.all(owners.map(owner => owner.readiness()));
    const reasons = results.flatMap(result => result.ready ? [] : result.reasons);
    return reasons.length ? { ready: false, reasons } : { ready: true };
  };
  const recovery: HostActivationRecovery<Owner> = Object.freeze({
    sessions: runtime.sessions,
    get extensions() { return new Map(extensions); },
    readiness,
    async close() {
      if (failed) throw failure;
      if (closing) return closing;
      closing = (async () => {
        if (!(await readiness()).ready) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Host still owns unsettled work" });
        try {
          // Close each actual owner once, even if its router has several names.
          // A dependent extension remains alive until its own close succeeds.
          for (const extension of [...new Set(extensions.values())].reverse()) {
            await extension.close();
            for (const [key, value] of extensions) if (value === extension) extensions.delete(key);
          }
          if (!lifecycleClosed) { await runtime.close(); lifecycleClosed = true; }
        } catch (error) { failed = true; failure = error; throw error; }
      })();
      try { await closing; } finally { closing = undefined; }
    },
  });
  return { recovery, get failed() { return failed; }, capture(values: Extensions) { for (const [key, owner] of Object.entries(values)) extensions.set(key, owner); } };
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value)) throw new Error("Invalid public plugin identity");
}
function validateContract(value: ContractIdentity): void {
  identifier(value?.id);
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error("Invalid contract version");
}
function validateIdentity(value: PluginIdentity): void {
  validateContract(value);
  if (!Number.isSafeInteger(value.recordVersion) || value.recordVersion < 1) throw new Error("Invalid plugin record version");
}
function validateHarness(harness: HarnessDefinition): void {
  if (!harness || harness.kind !== "harness") throw new Error("Exactly one harness plugin is required");
  validateIdentity(harness.identity);
  const occupied = new Set<string>();
  for (const contribution of harness.contributions ?? []) {
    identifier(contribution.namespace); identifier(contribution.key);
    const key = `${contribution.namespace}\0${contribution.key}`;
    if (occupied.has(key)) throw new Error("Duplicate harness contribution");
    occupied.add(key);
  }
}
function requireCapabilities(requires: readonly string[] | undefined, available: readonly string[]): void {
  for (const capability of requires ?? []) if (!available.includes(capability)) throw new Error(`Missing harness capability: ${capability}`);
}
function identityCopy(identity: PluginIdentity): PluginIdentity {
  return Object.freeze({ id: identity.id, version: identity.version, recordVersion: identity.recordVersion });
}
function manifestOf(contract: ContractIdentity, harness: HarnessDefinition, lifecycle: AnyLifecycle, extensions: Extensions): HostManifest {
  const publicPlugins = {
    harness: identityCopy(harness.identity),
    lifecycle: identityCopy(lifecycle.identity),
    extensions: Object.fromEntries(Object.keys(extensions).sort().map(key => [key, identityCopy(extensions[key]!.identity)])),
  };
  return Object.freeze({ contractId: contract.id, contractVersion: contract.version, compositionId: JSON.stringify(publicPlugins), ...publicPlugins });
}
function checkRecords(records: readonly StoredPluginRecord[], manifest: HostManifest): void {
  for (const record of records) {
    const selected = record.kind === "extension" ? manifest.extensions[record.namespace ?? ""] : manifest[record.kind];
    if (!selected || selected.id !== record.identity.id || selected.recordVersion !== record.identity.recordVersion) {
      throw new Error("Stored plugin record is incompatible with selected composition");
    }
  }
}
function sameRoute(left: HostContext["route"], right: HostContext["route"]): boolean {
  return left.authority === right.authority && left.host === right.host && left.owner === right.owner && left.routeEpoch === right.routeEpoch;
}
function sameContract(expected: HostCall["expected"], actual: HostManifest): boolean {
  return expected.contractId === actual.contractId && expected.contractVersion === actual.contractVersion && expected.compositionId === actual.compositionId;
}

/** Kernel opens selected owners; it never creates/resumes/stops a session itself. */
export async function activateHost<H extends HarnessDefinition, L extends AnyLifecycle, E extends Extensions, HR extends AnyRouter>(definition: HostDefinition<H, L, E, HR>, options: HostActivationOptions) {
  validateHarness(definition.harness);
  const lifecycle = definition.lifecycle({ harness: definition.harness, storage: options.storage });
  if (!lifecycle || lifecycle.kind !== "lifecycle") throw new Error("Exactly one lifecycle plugin is required");
  validateIdentity(lifecycle.identity);
  requireCapabilities(lifecycle.requires, definition.harness.capabilities);
  // Refuse incompatible lifecycle/native custody records before opening storage.
  const baseManifest = manifestOf(definition.contract, definition.harness, lifecycle, {});
  checkRecords((options.records ?? []).filter(record => record.kind !== "extension"), baseManifest);
  const runtime = await lifecycle.open({ route: options.route, storage: options.storage });
  const custody = activationCustody(runtime);
  let extensions: E | undefined;
  let phase: "active" | "closing" | "closed" | "failed" = "active";
  let closeFailure: unknown;
  let admitted = 0;
  try {
    extensions = definition.extensions?.({ sessions: runtime.sessions as OwnerOf<L> }) ?? {} as E;
    // The factory has transferred all returned owners before validation starts.
    // Rejecting the first key cannot discard resources under a later key.
    custody.capture(extensions);
    for (const [key, extension] of Object.entries(extensions)) {
      identifier(key);
      if (["system", "lifecycle", "harness", "extensions", "then", "__proto__", "prototype", "constructor"].includes(key)) throw new Error("Reserved plugin namespace");
      validateIdentity(extension.identity);
      requireCapabilities(extension.requires, definition.harness.capabilities);
      if (typeof extension.readiness !== "function" || typeof extension.close !== "function") throw new Error("Extension must declare update readiness and close ownership");
    }
    const manifest = manifestOf(definition.contract, definition.harness, lifecycle, extensions);
    checkRecords(options.records ?? [], manifest);
    const inspectReadiness = custody.recovery.readiness;
    const readiness = async (): Promise<UpdateReadiness> => {
      if (phase !== "active") return { ready: false, reasons: [`Host is ${phase}`] };
      if (admitted) return { ready: false, reasons: ["Host procedures still admitted"] };
      const state = await inspectReadiness();
      if (phase !== "active" || admitted) return { ready: false, reasons: ["Host admission changed during readiness observation"] };
      return state;
    };
    const admit: NonNullable<HostContext["admit"]> = ({ path }) => {
      if (phase !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Host admission is closed" });
      // System observations own no plugin resources. Excluding them avoids
      // counting the readiness observation against its own result.
      if (path.startsWith("system.")) return () => {};
      admitted++;
      let released = false;
      return () => { if (!released) { released = true; admitted--; } };
    };
    const harness = definition.harnessRouter?.({ sessions: runtime.sessions as OwnerOf<L>, harness: definition.harness }) ?? emptyRouter as HR;
    const router = composeRouter(manifest, runtime.router as RouterOf<L>, harness, extensions, readiness);
    return {
      manifest, router,
      sessions: runtime.sessions as OwnerOf<L>,
      public: { lifecycle: lifecycle.public, extensions: Object.fromEntries(Object.entries(extensions).map(([key, extension]) => [key, extension.public])) },
      async context(call: HostCall): Promise<HostContext> {
        if (phase !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Host is closed" });
        if (call.session && (!call.session.id || !Number.isSafeInteger(call.session.generation) || call.session.generation < 1)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid session scope" });
        if (!sameContract(call.expected, manifest)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Host composition mismatch" });
        const context = await options.authenticate(call);
        if (phase !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Host is closed" });
        if (!context || !sameRoute(context.route, options.route) || !context.identity.connection || !context.identity.principal) throw new TRPCError({ code: "UNAUTHORIZED", message: "Host scope denied" });
        if (call.session && (!context.session || context.session.id !== call.session.id || context.session.generation !== call.session.generation)) throw new TRPCError({ code: "FORBIDDEN", message: "Session scope denied" });
        if (!call.session && context.session) throw new TRPCError({ code: "FORBIDDEN", message: "Unexpected session scope" });
        return { ...context, admit };
      },
      readiness,
      async close(): Promise<void> {
        if (phase === "closed") return;
        if (phase === "failed") throw closeFailure;
        if (phase === "closing") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Host close already in progress" });
        phase = "closing";
        try {
          if (admitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Host procedures still admitted" });
          await custody.recovery.close();
          phase = "closed";
        } catch (error) {
          if (custody.failed) { phase = "failed"; closeFailure = error; }
          else phase = "active"; // A readiness refusal attempted no owner close.
          throw error;
        }
      },
    };
  } catch (error) {
    try { await custody.recovery.close(); }
    catch (cleanup) { throw new HostActivationError(definition, custody.recovery, [error, cleanup]); }
    throw error;
  }
}

/** Restart-only update: no admission or implicit Resume in the generic kernel. */
export async function updateHost<H extends HarnessDefinition, L extends AnyLifecycle, E extends Extensions, HR extends AnyRouter>(current: { readiness(): Promise<UpdateReadiness>; close(): Promise<void> }, definition: HostDefinition<H, L, E, HR>, options: HostActivationOptions) {
  const readiness = await current.readiness();
  if (!readiness.ready) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Stop sessions and settle custody before update" });
  await current.close();
  return activateHost(definition, options);
}
