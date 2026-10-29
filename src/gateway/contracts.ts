/// <reference lib="esnext.disposable" preserve="true" />
import type { AnyRouter, inferRouterContext } from "@trpc/server";
import { z } from "zod";
import type { HostManifest, HostRoute } from "../host/contracts.js";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const hostTargetSchema = z
  .object({
    route: z
      .object({
        authority: identifier,
        host: identifier,
        owner: identifier,
        routeEpoch: identifier,
      })
      .strict(),
    expected: z
      .object({
        contractId: identifier,
        contractVersion: z.number().int().positive(),
        compositionId: z.string().max(32768),
      })
      .strict(),
    session: z
      .object({ id: identifier, generation: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();
/** Routing metadata, separate from the actual tRPC procedure's input. */
export type HostTarget = z.output<typeof hostTargetSchema>;
export const viewerSchema = z
  .object({
    connection: identifier,
    principal: identifier,
    actions: z.array(z.enum(["read", "control"])).max(2),
    hosts: z.array(identifier).max(512),
  })
  .strict();
export type Viewer = Readonly<{
  connection: string;
  principal: string;
  actions: readonly ("read" | "control")[];
  hosts: readonly string[];
}>;
export type TopologyEntry = Readonly<{
  route: HostRoute;
  manifest: HostManifest;
  state: "online" | "stale" | "offline";
  lastSeen: number;
}>;
/** Borrowed actual tRPC endpoint. Authentication produces this router's own
 * context; neither a procedure envelope nor a universal native API is declared. */
export interface HostPeer<Router extends AnyRouter = AnyRouter> {
  readonly route: HostRoute;
  readonly manifest: HostManifest;
  readonly router: Router;
  context(viewer: Viewer, target: HostTarget): Promise<inferRouterContext<Router>>;
}
export type GatewayCode =
  "UNAUTHENTICATED" | "FORBIDDEN" | "FENCED" | "UNAVAILABLE" | "INVALID" | "FULL" | "INTERNAL";
export class GatewayError extends Error {
  constructor(readonly code: GatewayCode) {
    super(code);
    this.name = "GatewayError";
  }
}
/** Registered metadata and a borrowed transport. No procedure schema or native
 * lifetime is copied into the routing owner. */
export interface HostRegistration<Transport> {
  readonly route: HostRoute;
  readonly manifest: HostManifest;
  readonly transport: Transport;
}
/** One authorized channel's route lease. Release after actual channel cleanup;
 * cancelling this observation never cancels an admitted native effect. */
export interface GatewayRouteLease<Transport> {
  readonly transport: Transport;
  readonly manifest: HostManifest;
  readonly viewer: Viewer;
  readonly target: HostTarget;
  readonly signal: AbortSignal;
  release(): void;
}
export interface GatewayRequests<Transport = unknown> {
  topology(viewer: Viewer): readonly TopologyEntry[];
  acquire(viewer: Viewer, target: HostTarget): GatewayRouteLease<Transport>;
}
