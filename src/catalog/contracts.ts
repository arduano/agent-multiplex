import type { Json, RunRef, SessionScope } from "../protocol/index.js";

/** Root owns logical metadata; these facts do not own or stop native work. */
export type CatalogEntry = Readonly<{
  scope: SessionScope;
  authority: string;
  revision: number;
  target: Readonly<{
    owner: string;
    nativeKind: string;
    contractId: string;
    contractVersion: number;
  }>;
  name: string;
  workspace: Json;
  data: Json;
  watched: boolean;
  creation: "reserved" | "unknown" | "created" | "refused";
  createId: string;
  binding: RunRef | null;
  archived: boolean;
}>;
export type CreateRequest = Readonly<{
  scope: SessionScope;
  id: string;
  target: CatalogEntry["target"];
  name: string;
  workspace: Json;
  selection: Json;
  data?: Json;
}>;
export type CreationEvidence =
  | Readonly<{ state: "pending" | "unknown" | "refused" }>
  | Readonly<{ state: "created"; binding: RunRef }>;
/** read and readArchive are observation-only, never fallback mutations. */
export interface HostCreationPort {
  create(original: CreateRequest): Promise<CreationEvidence>;
  read(original: CreateRequest): Promise<CreationEvidence>;
  readArchive(scope: SessionScope, originalId: string, generation: number): Promise<boolean>;
}
export type CatalogPatch = Readonly<{ name?: string; watched?: boolean; data?: Json }>;
export type CatalogQuery = Readonly<{
  text?: string;
  host?: string;
  nativeKind?: string;
  pinnedOnly?: boolean;
  includeArchived?: boolean;
  offset?: number;
  limit?: number;
}>;

/** Borrowed authority capability. No journal/configuration or lifetime control. */
export interface CatalogAuthorityPort {
  readonly authority: string;
  get(scope: SessionScope): CatalogEntry | null;
  list(identity: Pick<SessionScope, "connection" | "principal">): readonly CatalogEntry[];
  original(scope: SessionScope, id: string): import("../protocol/index.js").Receipt | null;
  subscribe(listener: () => void): () => void;
  create(request: CreateRequest): Promise<import("../protocol/index.js").Receipt>;
  reconcile(scope: SessionScope): Promise<import("../protocol/index.js").Receipt>;
  patch(
    scope: SessionScope,
    id: string,
    revision: number,
    patch: CatalogPatch,
  ): import("../protocol/index.js").Receipt;
  publishArchive(
    scope: SessionScope,
    id: string,
    hostOriginalId: string,
    generation: number,
  ): Promise<import("../protocol/index.js").Receipt>;
  reconcileArchive(
    scope: SessionScope,
    id: string,
  ): Promise<import("../protocol/index.js").Receipt>;
}
