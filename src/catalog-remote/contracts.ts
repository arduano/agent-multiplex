import type { ObservationConnector } from "../transport/contracts.js";
import type { CatalogEntry, CatalogQuery } from "../catalog/contracts.js";
import type { Receipt, Json } from "../protocol/index.js";
export type CatalogListing = Readonly<{
  authority: string;
  coverage: "snapshot";
  total: number;
  matching: number;
  rows: readonly CatalogEntry[];
  nextOffset: number | null;
  unobservedPinned: readonly string[];
}>;
export type CatalogSelection = Readonly<{ query?: CatalogQuery; pinned?: readonly string[] }>;
export type CatalogActor = Readonly<{
  connection: string;
  principal: string;
  actions: readonly ("read" | "control")[];
  hosts: readonly string[];
}>;
export type CatalogCreate = Readonly<{
  host: string;
  session: string;
  id: string;
  target: CatalogEntry["target"];
  name: string;
  workspace: Json;
  selection: Json;
  data?: Json;
}>;
export type CatalogSnapshot = Readonly<{
  freshness: "unobserved" | "current" | "stale";
  listing: CatalogListing | null;
}>;
export interface CatalogFeed {
  watch(
    selection: CatalogSelection,
    signal: AbortSignal,
    unavailable?: () => void,
  ): AsyncIterable<CatalogListing>;
}
export type CatalogOriginal = Receipt;

export interface RetainedCatalogOptions {
  feed: CatalogFeed;
  observations: ObservationConnector;
  key: string;
  identity: Readonly<{ connection: string; principal: string; authority: string }>;
  selection?: CatalogSelection;
  maxRows?: number;
  maxBytes?: number;
}
