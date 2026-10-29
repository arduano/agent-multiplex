import type { AnyRouter } from "@trpc/server";
import { z } from "zod";
import type { Json, Original, RunRef, SessionScope, Settlement } from "../protocol/index.js";
import type {
  NativeOpening,
  OpeningCapsule,
  OpeningRef,
  OpeningStopProof,
} from "../runtime/contracts.js";
import type { HostRouter } from "./server/composition.js";

export type MaybePromise<T> = T | Promise<T>;
export type PluginIdentity = Readonly<{ id: string; version: number; recordVersion: number }>;
export type ContractIdentity = Readonly<{ id: string; version: number }>;
declare const gatewayRouterType: unique symbol;
/** Inert identity plus inference from an actual Gateway router. The Host imports
 * this value without importing the Gateway's executable handlers. */
export type GatewayContract<Router extends AnyRouter = AnyRouter> = ContractIdentity &
  Readonly<{ [gatewayRouterType]?: Router }>;
export type HostRoute = Readonly<{
  authority: string;
  host: string;
  owner: string;
  routeEpoch: string;
}>;
export type HostSession = Readonly<{ id: string; generation: number }>;
export type UpdateReadiness =
  Readonly<{ ready: true }> | Readonly<{ ready: false; reasons: readonly string[] }>;

/** Authentication is supplied by the selected transport/application. A route
 * epoch is replaceable connection freshness, never a native generation. */
export type HostContext = Readonly<{
  identity: Readonly<{ connection: string; principal: string; actions: readonly string[] }>;
  route: HostRoute;
  session?: HostSession;
  /** Added by the active kernel. Consumers cannot serialize this capability. */
  admit?: (procedure: { path: string; type: "query" | "mutation" | "subscription" }) => () => void;
}>;
export type HostActivationContext = Readonly<{ route: HostRoute }>;
export type PublicSchemas<
  H extends z.ZodType = z.ZodType,
  S extends z.ZodType = z.ZodType,
> = Readonly<{ host: H; session: S }>;

/** Metadata and startup contributions are inert. Concrete adapters may add
 * their own structural ports; there is no closed native-family registry. */
export interface HarnessDefinition {
  readonly identity: PluginIdentity;
  readonly nativeKind: string;
  readonly capabilities: readonly string[];
}
export interface OwnedResource {
  readiness(): MaybePromise<UpdateReadiness>;
  close(): MaybePromise<void>;
}
export interface LifecycleRuntime<Owner, Router extends AnyRouter> extends OwnedResource {
  readonly sessions: Owner;
  readonly router: Router;
}
export interface LifecyclePlugin<
  Owner,
  Router extends AnyRouter,
  Input extends z.ZodType = z.ZodType,
  Host extends z.ZodType = z.ZodType,
  Session extends z.ZodType = z.ZodType,
> {
  readonly identity: PluginIdentity;
  readonly requires?: readonly string[];
  readonly createInput: Input;
  readonly public: PublicSchemas<Host, Session>;
  /** Before returning, the factory owns cleanup of partial acquisition. After
   * returning, the kernel retains this exact owner even if validation fails. */
  open(context: HostActivationContext): MaybePromise<LifecycleRuntime<Owner, Router>>;
}
export interface HostExtension<
  Router extends AnyRouter = AnyRouter,
  Host extends z.ZodType = z.ZodType,
  Session extends z.ZodType = z.ZodType,
> extends OwnedResource {
  readonly identity: PluginIdentity;
  readonly requires?: readonly string[];
  readonly router: Router;
  readonly public: PublicSchemas<Host, Session>;
}

export type AnyLifecycle = LifecyclePlugin<unknown, AnyRouter>;
export type Extensions = Readonly<Record<string, HostExtension>>;
export type SessionsOf<L extends AnyLifecycle> = Awaited<ReturnType<L["open"]>>["sessions"];
export type LifecycleRouter<L extends AnyLifecycle> = Awaited<ReturnType<L["open"]>>["router"];
export interface HostDefinition<
  H extends HarnessDefinition,
  L extends AnyLifecycle,
  E extends Extensions,
  NativeRouter extends AnyRouter,
  GatewayRouter extends AnyRouter = AnyRouter,
> {
  readonly contract: ContractIdentity;
  readonly harness: H;
  readonly lifecycle: (context: { harness: H }) => L;
  readonly native?: (context: { sessions: SessionsOf<L>; harness: H }) => NativeRouter;
  readonly extensions?: (context: { sessions: SessionsOf<L> }) => E;
  readonly gateway?: GatewayContract<GatewayRouter>;
}
export type HostManifest = Readonly<{
  contractId: string;
  contractVersion: number;
  nativeKind: string;
  /** Only public plugin identities; never a digest of private configuration. */
  compositionId: string;
  harness: PluginIdentity;
  lifecycle: PluginIdentity;
  extensions: Readonly<Record<string, PluginIdentity>>;
  gateway?: ContractIdentity;
}>;
export type ExpectedHost = Pick<HostManifest, "contractId" | "contractVersion" | "compositionId">;
export type HostCall = Readonly<{ proof: unknown; expected: ExpectedHost; session?: HostSession }>;
export type HostActivationOptions = HostActivationContext &
  Readonly<{
    authenticate(call: HostCall): MaybePromise<HostContext | null>;
    records?: readonly StoredPluginRecord[];
  }>;
export type StoredPluginRecord = Readonly<{
  kind: "harness" | "lifecycle" | "extension";
  namespace?: string;
  identity: PluginIdentity;
}>;

/** Type-only consumer projection. It imports no Node owner or factory and
 * exposes neither activation storage nor adapter configuration. */
export type PublicHostContract<D> =
  D extends HostDefinition<infer H, infer L, infer E, infer NR, infer GR>
    ? {
        router: HostRouter<D>;
        nativeKind: H["nativeKind"];
        lifecycleRouter: LifecycleRouter<L>;
        nativeRouter: NR;
        gatewayRouter: GR;
        createInput: z.input<L["createInput"]>;
        hostData: z.output<L["public"]["host"]>;
        sessionData: z.output<L["public"]["session"]>;
        extensions: {
          [K in keyof E]: {
            router: E[K]["router"];
            hostData: z.output<E[K]["public"]["host"]>;
            sessionData: z.output<E[K]["public"]["session"]>;
          };
        };
      }
    : never;

const sessionScopeSchema = z.object({
  connection: z.string(),
  principal: z.string(),
  host: z.string(),
  session: z.string(),
});
const sessionBaseSchema = z.object({
  scope: sessionScopeSchema,
  generation: z.number().int().nonnegative(),
  nativeSession: z.string().nullable(),
  workspace: z
    .object({
      cwd: z.string(),
      ownership: z.enum(["borrowed", "owned"]),
      data: z.json() as z.ZodType<Json>,
    })
    .nullable(),
});
const sessionRunSchema = z.object({
  scope: sessionScopeSchema,
  generation: z.number().int().positive(),
  nativeSession: z.string().min(1),
});
const sessionPhaseSchema = z.discriminatedUnion("phase", [
  sessionBaseSchema.extend({
    phase: z.literal("running"),
    run: sessionRunSchema,
    activity: z.enum(["working", "idle", "unknown"]),
    mayRun: z.literal(true),
  }),
  sessionBaseSchema.extend({
    phase: z.enum(["preparing", "opening", "stopping", "archiving", "uncertain"]),
    activity: z.literal("unknown"),
    mayRun: z.boolean(),
  }),
  sessionBaseSchema.extend({
    phase: z.enum(["stopped", "archived"]),
    activity: z.literal("idle"),
    mayRun: z.literal(false),
  }),
]);

/** Requested settings are intent; observed settings are facts and may be partial.
 * A retained observed selection is passed back only for explicit native Reopen. */
export type RunSelection<Requested = Json, Observed = Json> =
  | Readonly<{ selectionSource: "requested"; selection: Requested }>
  | Readonly<{ selectionSource: "observed"; selection: Observed }>;
export type NativeObservation<Observed = Json> = Readonly<{
  run: RunRef;
  activity: "working" | "idle" | "unknown";
  selection: Observed;
}>;
export type NativeOpenResult<Observed = Json> = NativeObservation<Observed> &
  (Readonly<{ kind: "created"; quiescent: true }> | Readonly<{ kind: "reopened" }>);
export type NativeResult = Exclude<Settlement, { state: "unknown" }>;
export type NativePreparationInput<Requested = Json, Observed = Json> = RunSelection<
  Requested,
  Observed
> &
  Readonly<{
    opening: OpeningRef;
    cwd: string;
    mode: "create" | "reopen";
    previousSelection?: Requested | Observed;
    previousSelectionSource?: "requested" | "observed";
  }>;
/** Positive proof before allocation starts. A thrown acquisition is unknown. */
export type NativePreparationRefusal = Readonly<{
  state: "refused";
  noAllocation: true;
  code: "BUSY" | "INVALID" | "UNSUPPORTED";
}>;
/** One adapter owns all native resources. Pure schema validation precedes
 * durable admission; close/Stop custody cannot be narrowed to observer state. */
export interface NativePort<
  Command extends z.ZodType = z.ZodType,
  Message extends z.ZodType = z.ZodType<Json>,
  Requested extends z.ZodType = z.ZodType<Json>,
  Observed extends z.ZodType = z.ZodType<Json>,
> {
  readonly identity: PluginIdentity;
  readonly commandInput: Command;
  readonly messageInput: Message;
  readonly selectionInput: Requested;
  readonly selectionOutput: Observed;
  readiness(): UpdateReadiness;
  close(): void | Promise<void>;
  prepare(
    input: NativePreparationInput<z.output<Requested>, z.output<Observed>>,
  ): Promise<NativeOpening | NativePreparationRefusal>;
  open(
    input: RunSelection<z.output<Requested>, z.output<Observed>> & {
      capsule: OpeningCapsule;
      cwd: string;
      mode: "create" | "reopen";
      nativeSession: string | null;
      commitBinding(run: RunRef): void;
    },
  ): Promise<NativeOpenResult<z.output<Observed>>>;
  inspect(
    capsule: OpeningCapsule,
  ): Promise<NativeObservation<z.output<Observed>> | OpeningStopProof | null>;
  stop(capsule: OpeningCapsule): Promise<OpeningStopProof>;
  send(input: {
    capsule: OpeningCapsule;
    run: RunRef;
    originalId: string;
    message: z.output<Message>;
  }): Promise<NativeResult>;
  command(input: {
    capsule: OpeningCapsule;
    run: RunRef;
    originalId: string;
    original: Original;
    command: z.output<Command>;
  }): Promise<NativeResult>;
}
export type WorkspaceAllocation<Data extends Json = Json> = Readonly<{
  cwd: string;
  ownership: "borrowed" | "owned";
  data: Data;
}>;
export type WorkspaceRefusal = Readonly<{ state: "refused"; noAllocation: true }>;
export interface WorkspaceStrategy<
  Input extends z.ZodType = z.ZodType,
  Data extends z.ZodType<Json> = z.ZodType<Json>,
> {
  readonly identity: PluginIdentity;
  readonly input: Input;
  readonly data: Data;
  allocate(input: {
    scope: SessionScope;
    originalId: string;
    input: z.output<Input>;
  }): Promise<WorkspaceAllocation<z.output<Data>> | WorkspaceRefusal>;
  /** Borrowed workspaces are never deleted. An owned strategy owns its release. */
  release?(
    allocation: WorkspaceAllocation<z.output<Data>>,
    original: { scope: SessionScope; originalId: string },
  ): Promise<void>;
}
export type SessionState<Requested = Json, Observed = Json> = Readonly<{
  scope: SessionScope;
  generation: number;
  nativeSession: string | null;
  workspace: WorkspaceAllocation | null;
}> &
  RunSelection<Requested, Observed> &
  (
    | Readonly<{
        phase: "running";
        run: RunRef;
        activity: "working" | "idle" | "unknown";
        mayRun: true;
      }>
    | Readonly<{
        phase: "preparing" | "opening" | "stopping" | "archiving" | "uncertain";
        activity: "unknown";
        mayRun: boolean;
      }>
    | Readonly<{ phase: "stopped" | "archived"; activity: "idle"; mayRun: false }>
  );
export function sessionStateSchema<Requested extends z.ZodType, Observed extends z.ZodType>(
  requested: Requested,
  observed: Observed,
): z.ZodType<
  SessionState<z.output<Requested>, z.output<Observed>>,
  SessionState<z.output<Requested>, z.output<Observed>>
> {
  return z.intersection(
    sessionPhaseSchema,
    z.discriminatedUnion("selectionSource", [
      z.object({ selectionSource: z.literal("requested"), selection: requested }),
      z.object({ selectionSource: z.literal("observed"), selection: observed }),
    ]),
  ) as unknown as z.ZodType<
    SessionState<z.output<Requested>, z.output<Observed>>,
    SessionState<z.output<Requested>, z.output<Observed>>
  >;
}
/** Retained acquired resources after failed activation, owned by that definition. */
export type HostActivationRecovery<Owner> = Readonly<{
  sessions: Owner;
  extensions: ReadonlyMap<string, HostExtension>;
  readiness(): Promise<UpdateReadiness>;
  close(): Promise<void>;
}>;
