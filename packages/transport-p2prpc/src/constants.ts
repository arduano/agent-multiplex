import { APPLICATION_ID, PROTOCOL_VERSION } from "@arduano/agent-multiplex-protocol";
import type { ProtocolIdentity } from "@arduano/p2prpc-core";

/** The p2prpc application/ALPN identity shared by every multiplexer node. */
export const AGENT_MULTIPLEX_P2P_PROTOCOL: ProtocolIdentity = Object.freeze({
  applicationId: APPLICATION_ID,
  contractVersion: `${PROTOCOL_VERSION}.renewal.1`,
});

/** Independent upstream base; the candidate patch identity is recorded at build time. */
export const P2PRPC_TESTED_REVISION = "6f0bac7" as const;
