import type { AnyRouter } from "@trpc/server";
import type { z } from "zod";

export type MaybePromise<T> = T | Promise<T>;
export type PluginIdentity = Readonly<{ id: string; version: number; recordVersion: number }>;
export type ContractIdentity = Readonly<{ id: string; version: number }>;
/** All values are authenticated by the deployment's forwarding verifier. */
export type HostRoute = Readonly<{ authority: string; host: string; owner: string; routeEpoch: string }>;
export type HostSession = Readonly<{ id: string; generation: number }>;
export type HostContext = Readonly<{
  identity: Readonly<{ connection: string; principal: string; actions: readonly string[] }>;
  route: HostRoute;
  session?: HostSession | undefined;
  /** Local activation fence; never serialized into forwarding proof or DTOs. */
  admit?: ((procedure: { path: string; type: "query" | "mutation" | "subscription" }) => () => void) | undefined;
}>;
export type HostActivationContext = Readonly<{ route: HostRoute; storage: unknown }>;
export type UpdateReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reasons: readonly string[] }>;
export type Contribution = Readonly<{ namespace: string; key: string }>;
export interface HarnessDefinition {
  readonly kind: "harness";
  readonly identity: PluginIdentity;
  readonly capabilities: readonly string[];
  readonly contributions?: readonly Contribution[];
}
export type PublicSchemas<H extends z.ZodType = z.ZodType, S extends z.ZodType = z.ZodType> = Readonly<{ host: H; session: S }>;
export interface LifecycleRuntime<Owner, Router extends AnyRouter> {
  readonly sessions: Owner;
  readonly router: Router;
  readiness(): MaybePromise<UpdateReadiness>;
  close(): MaybePromise<void>;
}
export interface LifecyclePlugin<Owner, Router extends AnyRouter, Create extends z.ZodType = z.ZodType, Host extends z.ZodType = z.ZodType, Session extends z.ZodType = z.ZodType> {
  readonly kind: "lifecycle";
  readonly identity: PluginIdentity;
  readonly capabilities: readonly string[];
  readonly requires?: readonly string[];
  readonly createInput: Create;
  readonly public: PublicSchemas<Host, Session>;
  open(context: HostActivationContext): MaybePromise<LifecycleRuntime<Owner, Router>>;
}
export interface HostExtension<Router extends AnyRouter = AnyRouter, Host extends z.ZodType = z.ZodType, Session extends z.ZodType = z.ZodType> {
  readonly identity: PluginIdentity;
  readonly router: Router;
  readonly public: PublicSchemas<Host, Session>;
  readonly requires?: readonly string[];
  readiness(): MaybePromise<UpdateReadiness>;
  /** Seal owner admission, recheck actual custody, then release resources. */
  close(): MaybePromise<void>;
}
export type HostManifest = Readonly<{
  contractId: string;
  contractVersion: number;
  /** Canonical public plugin/version identity; never derived from private config. */
  compositionId: string;
  harness: PluginIdentity;
  lifecycle: PluginIdentity;
  extensions: Readonly<Record<string, PluginIdentity>>;
}>;
export type HostCall = Readonly<{
  proof: unknown;
  expected: Pick<HostManifest, "contractId" | "contractVersion" | "compositionId">;
  session?: HostSession;
}>;
export type AuthenticateHostCall = (call: HostCall) => MaybePromise<HostContext | null>;
export type StoredPluginRecord = Readonly<{ kind: "harness" | "lifecycle" | "extension"; namespace?: string; identity: PluginIdentity }>;
