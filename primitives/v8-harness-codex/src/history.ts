import { createCodexCodec } from "../../v8-history/src/native/codex/index.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import type { HostHistoryFacet } from "../../v8-host/src/contracts.js";

/** Harness owns scope identity and codec selection; lifecycle owns acquisition. */
export const codexHistory: HostHistoryFacet = Object.freeze<HostHistoryFacet>({
  scope(run, attachment) {
    const origin = { connection: run.scope.connection, principal: run.scope.principal, host: run.scope.host, nativeSession: run.nativeSession, attachment };
    return { kind: "codex", origin, threadId: run.nativeSession };
  },
  codec(scope, capture, knownStart, media) {
    requireThat(scope.kind === "codex");
    return createCodexCodec({ origin: scope.origin, rootThreadId: scope.origin.nativeSession, capture, knownStart, ...(media ? { media } : {}) });
  },
});
