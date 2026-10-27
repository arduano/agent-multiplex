import type { CodexScope, CopilotScope, Scope } from "../src/contracts/types.js";
import type { AcquisitionPort, HistoryRecord } from "../src/acquisition/types.js";
function nativeNarrowing(scope: Scope): void {
  if (scope.kind === "codex") {
    const thread: string = scope.threadId; void thread;
    // @ts-expect-error Copilot agent identity cannot be used as a Codex identity.
    scope.agentId;
  } else {
    const agent: string | null = scope.agentId; void agent;
    // @ts-expect-error A Copilot child scope is not a Codex thread.
    scope.threadId;
  }
}
void nativeNarrowing;
declare const codex: CodexScope, copilot: CopilotScope;
// @ts-expect-error Cross-host identities are not interchangeable.
const wrongCodex: CodexScope = copilot;
// @ts-expect-error A real legacy tool owner must not impersonate an agent identity.
const wrongLegacy: CopilotScope = { kind: "copilot", origin: codex.origin, agentId: "invented", legacyParentToolCallId: "task" };
void wrongCodex; void wrongLegacy;
function acquisitionTypes(codexPort: AcquisitionPort<CodexScope>, copilotPort: AcquisitionPort<CopilotScope>, record: HistoryRecord): void {
  // @ts-expect-error A native Codex reader cannot receive a Copilot target.
  void codexPort.read({ scope: copilot, cursor: null, count: 1 });
  // @ts-expect-error Native adapters never provide a Host version.
  record.version;
  // @ts-expect-error Concrete native page bindings remain different types.
  const wrongPort: AcquisitionPort<CodexScope> = copilotPort;
  void wrongPort;
}
void acquisitionTypes;
