import { APPLICATION_ID, PROTOCOL_VERSION } from "@arduano/agent-multiplex-protocol";
import type { ProtocolIdentity } from "@arduano/p2prpc-core";

/** The p2prpc application/ALPN identity shared by every multiplexer node. */
export const AGENT_MULTIPLEX_P2P_PROTOCOL: ProtocolIdentity = Object.freeze({
  applicationId: APPLICATION_ID,
  contractVersion: String(PROTOCOL_VERSION),
});

/** Local p2prpc source revision used for the v1 transport integration. */
export const P2PRPC_TESTED_REVISION = "6220c97" as const;
