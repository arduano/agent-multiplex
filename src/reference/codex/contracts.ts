import type { GatewayContract, PublicHostContract } from "../../host/contracts.js";
import type { createCodexDemoDefinition } from "./server/host.js";
import type { codexDemoGatewayRouter } from "./server/gateway.js";

/** Runtime-safe identity; importing this module never imports Gateway handlers. */
export const codexDemoGatewayIdentity = Object.freeze({
  id: "multiplex.reference.codex-gateway",
  version: 1,
});
export const codexDemoGatewayContract: GatewayContract<ReturnType<typeof codexDemoGatewayRouter>> =
  codexDemoGatewayIdentity;
export type CodexDemoHostContract = PublicHostContract<
  Awaited<ReturnType<typeof createCodexDemoDefinition>>
>;
export type CodexDemoHostRouter = CodexDemoHostContract["router"];
export type CodexDemoGatewayRouter = ReturnType<typeof codexDemoGatewayRouter>;
export type CodexDemoGatewaySummary = Readonly<{ label: string; availableWorkspaces: number }>;
