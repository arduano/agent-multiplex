import { gatewayHostMiddleware, gatewayTRPC } from "../../../gateway/node.js";
import { codexDemoGatewayIdentity } from "../contracts.js";
import type { CodexDemoGatewayService } from "../node-contracts.js";

/** Runs only on the Gateway. The service and its resource lifetime belong to
 * application composition; this router does not construct a Host client. */
export function codexDemoGatewayRouter(service: CodexDemoGatewayService) {
  const scoped = gatewayTRPC.procedure.use(gatewayHostMiddleware(codexDemoGatewayIdentity));
  return gatewayTRPC.router({
    summary: scoped.query(({ ctx }) =>
      service.summary({ viewer: ctx.viewer, target: ctx.host.target }),
    ),
  });
}
