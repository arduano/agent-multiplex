import type { SessionPrincipal } from "@arduano/p2prpc-core";
import { z } from "zod";
import { GatewayError, hostTargetSchema, viewerSchema } from "../gateway/contracts.js";
import { canonicalJson, type Json } from "../protocol/index.js";
import type { BridgeDelegation } from "./node-contracts.js";

/** Decode only claims from an already-authenticated BridgeContext/FileOffer.
 * Parsing this value is not authentication of arbitrary browser JSON. */
export const bridgeDelegationSchema = z
  .object({
    viewer: viewerSchema,
    target: hostTargetSchema,
  })
  .strict();

export function delegationJson(value: BridgeDelegation): Json {
  const { viewer, target } = value;
  return {
    viewer: {
      connection: viewer.connection,
      principal: viewer.principal,
      actions: [...viewer.actions],
      hosts: [...viewer.hosts],
    },
    target: {
      route: { ...target.route },
      expected: { ...target.expected },
      ...(target.session ? { session: { ...target.session } } : {}),
    },
  };
}

export function readBridgeDelegation(
  principal: Pick<SessionPrincipal, "claims">,
): BridgeDelegation {
  try {
    const delegation = bridgeDelegationSchema.parse(principal.claims);
    canonicalJson(delegationJson(delegation), 8192);
    if (
      !delegation.viewer.hosts.includes(delegation.target.route.host) ||
      delegation.viewer.actions.length === 0
    )
      throw new GatewayError("FORBIDDEN");
    return delegation;
  } catch {
    throw new GatewayError("FORBIDDEN");
  }
}
