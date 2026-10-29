import type { AnyRouter, inferRouterContext } from "@trpc/server";
import type { HostCall, HostManifest, HostRoute } from "../host/contracts.js";
import type { HostRegistration, HostTarget, Viewer } from "./contracts.js";
export interface GatewayOptions {
  authorizePeer(peer: Pick<HostRegistration<unknown>, "route" | "manifest">): boolean;
  readonly now?: () => number;
  readonly staleAfterMs?: number;
  readonly maxHosts?: number;
  /** Bounds all outstanding routed channels, including opening and cleanup. */
  readonly maxRequests?: number;
}
export interface HostEndpointPort<Router extends AnyRouter> {
  readonly router: Router;
  context(call: HostCall): Promise<inferRouterContext<Router>>;
}
export interface HostEndpointOptions {
  readonly route: HostRoute;
  readonly manifest: HostManifest;
  /** Must derive authenticated proof, never trust unsigned browser JSON. */
  proof(viewer: Viewer, target: HostTarget): Promise<unknown> | unknown;
}
export interface GatewayHttpOptions {
  authenticate(request: Request): Promise<Viewer | null>;
  readonly maxBodyBytes?: number;
}
