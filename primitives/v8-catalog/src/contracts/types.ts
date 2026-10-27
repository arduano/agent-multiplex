import type { Harness, Placement, Selection, SessionScope } from "../../../v8-session/src/contracts/types.js";
export type CatalogScope = Readonly<{ connection: string; principal: string; authority: string }>;
/** Owner is authenticated Host custody, not socket/boot freshness. */
export type HostTarget = Readonly<{ host: string; owner: string; kind: Harness; placement: Placement }>;
export type Metadata = Readonly<{ name: string | null; cwd: string | null; watched?: boolean }>;
export type CreateRequest = Readonly<{ scope: CatalogScope; id: string; session: string; target: HostTarget; metadata: Pick<Metadata, "name" | "cwd">; selection?: Selection }>;
export type NativeBinding = Readonly<{ nativeSession: string; generation: number; kind: Harness; placement: Placement }>;
/** nativeCreated means positive native identity, independent of Host Starting/Running or original Create ACK. */
export type CreationState = "reserved" | "dispatching" | "nativeCreated" | "refused" | "outcomeUnknown";
export type CatalogEntry = Readonly<{ scope: CatalogScope; session: string; target: HostTarget; createId: string; version: number; revision: number; metadata: Metadata; binding: NativeBinding | null; archive?: Readonly<{ id: string; generation: number }> }>;
export type Creation = Readonly<{ original: CreateRequest; entry: CatalogEntry; state: CreationState; native: NativeBinding | null; publication: "committed" | "pending" }>;
export type RenameRequest = Readonly<{ scope: CatalogScope; id: string; session: string; revision: number; name: string | null }>;
export type WatchRequest = Readonly<{ scope: CatalogScope; id: string; session: string; revision: number; watched: boolean }>;
/** Two closed CAS intents. Existing Create/Rename canonical payloads stay unchanged. */
export type MetadataRequest = RenameRequest | WatchRequest;
export type MetadataOriginal = Readonly<{ request: MetadataRequest; entry: CatalogEntry }>;
export type ArchivePublication = Readonly<{ scope: CatalogScope; session: string; id: string; generation: number }>;
/** Host read must inspect only the exact original. It cannot create/resume/attach. */
export type HostCreationStatus = Readonly<{ state: "created"; binding: NativeBinding }> | Readonly<{ state: "pending" | "unknown" | "refused" }>;
export interface HostCreationPort {
  readonly target: HostTarget;
  create(original: CreateRequest): Promise<HostCreationStatus>;
  /** Same original mutation, returning after exact durable Host admission (or
   * positive refusal), before workspace/native completion. Never a second call
   * after create. Absence retains the legacy actual-call completion boundary. */
  createAdmitted?(original: CreateRequest): Promise<HostCreationStatus>;
  read(original: CreateRequest): Promise<HostCreationStatus>;
  /** Exact existing archive receipt/proof only. This can never dispatch archive. */
  readArchive?(original: CreateRequest, id: string, generation: number): Promise<boolean>;
  watch?(original: CreateRequest, listener: (status: HostCreationStatus) => void): Promise<() => void>;
}
export interface CatalogPort {
  list(scope: CatalogScope): Promise<readonly CatalogEntry[]>;
  get(scope: CatalogScope, session: string): Promise<CatalogEntry | null>;
  create(request: CreateRequest): Promise<Creation>;
  creation(scope: CatalogScope, id: string): Promise<Creation | null>;
  rename(request: RenameRequest): Promise<CatalogEntry>;
  setWatched(request: WatchRequest): Promise<CatalogEntry>;
  /** Exact committed original only; a missing row cannot prove nonexecution. */
  metadataOriginal(scope: CatalogScope, id: string): Promise<MetadataOriginal | null>;
  /** Publish a separately completed Host original; never invokes Host mutation. */
  publishArchive?(request: ArchivePublication): Promise<CatalogEntry>;
  subscribe(scope: CatalogScope, listener: (entry: CatalogEntry) => void): () => void;
}
export type CatalogErrorCode = "INVALID" | "FENCED" | "CONFLICT" | "FULL" | "BUSY" | "CLOSED" | "IO";
export class CatalogError extends Error { constructor(readonly code: CatalogErrorCode, message: string = code) { super(message); this.name = "CatalogError"; } }
export const catalogKey = (s: CatalogScope): string => JSON.stringify([s.connection, s.principal, s.authority]);
export const logicalKey = (s: CatalogScope, session: string): string => JSON.stringify([catalogKey(s), session]);
export const sessionScope = (r: CreateRequest): SessionScope => ({ connection: r.scope.connection, principal: r.scope.principal, host: r.target.host, session: r.session });
