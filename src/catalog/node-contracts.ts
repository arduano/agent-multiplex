import type { OriginalJournalPort } from "../storage/contracts.js";
import type { CreateRequest, HostCreationPort } from "./contracts.js";
/** Borrowed journal; the caller retains its one close authority. */
export interface CatalogOptions {
  readonly authority: string;
  readonly journal: OriginalJournalPort;
  host(original: CreateRequest): HostCreationPort;
  readonly maxEntries?: number;
}
