import type { CodexObservedSelection, CodexSelection } from "../../codex/contracts.js";
import type { CodexNative, CodexNativeApi } from "../../codex/node-contracts.js";
import type { NativeObservation } from "../../host/contracts.js";
import type { OriginalJournalPort } from "../../storage/contracts.js";
import type { HostTarget, Viewer } from "../../gateway/contracts.js";
import type { CodexDemoGatewaySummary } from "./contracts.js";

export interface CodexDemoOptions {
  /** Borrowed single writer. The application process retains its close capability. */
  journal: OriginalJournalPort;
  selection: CodexSelection;
  /** Construct one inert actual adapter with explicit binary/provider/allocation
   * configuration. The selected lifecycle owns it after activation. */
  adapter(
    observe: (value: NativeObservation<CodexObservedSelection>) => void,
  ): (CodexNative & CodexNativeApi) | Promise<CodexNative & CodexNativeApi>;
}
export interface CodexDemoGatewayService {
  /** Gateway-owned work inventory, not a native Host query or proxy. */
  summary(
    input: Readonly<{ viewer: Viewer; target: HostTarget }>,
  ): Promise<CodexDemoGatewaySummary>;
}
