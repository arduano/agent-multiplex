import { createCopilotCodec } from "../../v8-history/src/native/copilot/index.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import type { HostHistoryFacet } from "../../v8-host/src/contracts.js";

/** Harness owns scope identity and codec selection; lifecycle owns acquisition. */
export const copilotHistory: HostHistoryFacet = Object.freeze<HostHistoryFacet>({
  scope(run, attachment) {
    const origin = { connection: run.scope.connection, principal: run.scope.principal, host: run.scope.host, nativeSession: run.nativeSession, attachment };
    return { kind: "copilot", origin, agentId: null };
  },
  codec(scope, capture, knownStart, media) {
    requireThat(scope.kind === "copilot");
    return createCopilotCodec({ origin: scope.origin, capture, knownStart, ...(media ? { media } : {}) });
  },
});
