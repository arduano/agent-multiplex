import type { AnyRouter } from "@trpc/server";
import { canonicalJson, cloneJson, type Json } from "../../protocol/index.js";
import {
  GatewayError,
  hostTargetSchema,
  type HostPeer,
  type HostTarget,
  type Viewer,
} from "../contracts.js";
import type { HostEndpointPort, HostEndpointOptions } from "../node-contracts.js";

/** Mount the actual Host router. Procedure parsing, middleware, result values and
 * streaming remain tRPC's responsibility; this seam authenticates routing only. */
export function hostEndpoint<Router extends AnyRouter>(
  host: HostEndpointPort<Router>,
  options: HostEndpointOptions,
): HostPeer<Router> {
  const route = cloneJson(options.route as unknown as Json, 4096) as HostPeer["route"];
  const manifest = cloneJson(options.manifest as unknown as Json, 65536) as HostPeer["manifest"];
  return Object.freeze({
    route,
    manifest,
    router: host.router,
    async context(viewer: Viewer, raw: HostTarget) {
      const target = hostTargetSchema.parse(raw);
      if (
        canonicalJson(target.route, 4096).json !==
        canonicalJson(route as unknown as Json, 4096).json
      )
        throw new GatewayError("FENCED");
      return host.context({
        proof: await options.proof(viewer, target),
        expected: target.expected,
        ...(target.session ? { session: target.session } : {}),
      });
    },
  });
}
