import type { AnchorSnapshot, EntrySnapshot } from "../../src/client/contracts.js";
import type { connectReferenceUi } from "../../src/reference/ui/index.js";
type Connection = Awaited<ReturnType<typeof connectReferenceUi>>;
export interface BrowserReference {
  ready: boolean;
  snapshots(): { id: string; snapshot: EntrySnapshot; anchor: AnchorSnapshot }[];
  diagnostics(): {
    entries: number;
    observations: ReturnType<Connection["observations"]["diagnostics"]>;
  };
  close(): Promise<void>;
}
declare global {
  interface Window {
    __reference: BrowserReference;
    __multiplex_pwned?: unknown;
  }
}
