import type { GatewayHttpOptions } from "../node-contracts.js";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError, type AnyRouter } from "@trpc/server";
import {
  GatewayError,
  hostTargetSchema,
  type GatewayRequests,
  type Viewer,
  type HostTarget,
} from "../contracts.js";
import { gatewayRouter, type GatewayRouter } from "./trpc.js";
import { publicTRPCError } from "./errors.js";

/** The official Fetch adapter exposes the Gateway's own actual router.
 * Actual Host RPC/files travel through an authorized bridge route lease. */
export function gatewayHttpHandler<Router extends GatewayRouter<AnyRouter>>(
  gateway: Pick<GatewayRequests, "topology"> & Partial<Pick<GatewayRequests, "acquire">>,
  options: GatewayHttpOptions,
  router: Router | GatewayRouter = gatewayRouter(gateway),
) {
  const max = options.maxBodyBytes ?? 2097152,
    endpoint = "/trpc";
  if (!Number.isSafeInteger(max) || max < 1 || max > 33554432) throw new GatewayError("INVALID");
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== endpoint && !url.pathname.startsWith(endpoint + "/"))
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    let viewer: Viewer | null = null,
      target: HostTarget | undefined,
      admission: unknown;
    try {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) throw new GatewayError("FORBIDDEN");
      const selected = url.searchParams.get("target");
      if (selected !== null) {
        if (new TextEncoder().encode(selected).byteLength > 65536)
          throw new GatewayError("INVALID");
        try {
          target = hostTargetSchema.parse(JSON.parse(selected));
        } catch {
          throw new GatewayError("INVALID");
        }
      }
      viewer = await options.authenticate(request);
      if (!viewer) throw new GatewayError("UNAUTHENTICATED");
      request.signal.throwIfAborted();
    } catch (error) {
      admission = publicTRPCError(error);
    }
    let bytes = 0;
    const guarded = new Request(request, {
      ...(request.body
        ? {
            body: request.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  bytes += chunk.byteLength;
                  if (bytes > max)
                    throw new TRPCError({
                      code: "PAYLOAD_TOO_LARGE",
                      message: "PAYLOAD_TOO_LARGE",
                    });
                  controller.enqueue(chunk);
                },
              }),
            ),
            duplex: "half",
          }
        : {}),
    } as RequestInit);
    return fetchRequestHandler({
      endpoint,
      req: guarded,
      router,
      allowMethodOverride: true,
      maxBatchSize: 1,
      async createContext() {
        if (admission) throw admission;
        if (!viewer) throw publicTRPCError(new GatewayError("UNAUTHENTICATED"));
        return {
          viewer,
          ...(target ? { target } : {}),
          ...(gateway.acquire ? { routes: gateway as GatewayRequests } : {}),
        };
      },
      responseMeta: () => ({ headers: { "cache-control": "no-store", "x-accel-buffering": "no" } }),
    });
  };
}
