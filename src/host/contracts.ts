import type { AnyRouter } from "@trpc/server";
import type { z } from "zod";
import type { HostRouter } from "./server/composition.js";

export type MaybePromise<T> = T | Promise<T>;
export type PluginIdentity = Readonly<{
  id: string;
  version: number;
  recordVersion: number;
}>;
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
  identity: Readonly<{
    connection: string;
    principal: string;
    actions: readonly string[];
  }>;
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
export type HostCall = Readonly<{
  proof: unknown;
  expected: ExpectedHost;
  session?: HostSession;
}>;
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

/** Retained acquired resources after failed activation, owned by that definition. */
export type HostActivationRecovery<Owner> = Readonly<{
  sessions: Owner;
  extensions: ReadonlyMap<string, HostExtension>;
  readiness(): Promise<UpdateReadiness>;
  close(): Promise<void>;
}>;
