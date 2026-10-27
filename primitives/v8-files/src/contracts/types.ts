import type { Scope as HistoryScope } from "../../../v8-history/src/contracts/types.js";
/** Browser-safe, reference-only file contracts. Authentication is an injected boundary. */
export type FileScope = Readonly<{ connection: string; principal: string; host: string; session: string }>;
export type FileManifest = Readonly<{ id: string; name: string; mediaType: string; bytes: number; sha256: string }>;
export type ArtifactRef = Readonly<{ kind: "artifact"; owner: FileScope; id: string; name: string; mediaType: string; bytes: number; sha256: string; capturedAt: number }>;
export type DiskRef = Readonly<{ kind: "disk"; owner: FileScope; sourceKey: string; path: string }>;
export type NativeRef = Readonly<{ kind: "native"; owner: FileScope; harness: "codex" | "copilot"; occurrence: string; assetId: string; omittedReason?: string }>;
export type FileRef = ArtifactRef | DiskRef | NativeRef;
export type UploadStatus =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "uploading"; manifest: FileManifest; offset: number }>
  | Readonly<{ state: "committed"; artifact: ArtifactRef }>
  | Readonly<{ state: "aborted" | "expired"; manifest: FileManifest }>;
export type FileUsage = Readonly<{
  hostBytes: number; sessionBytes: number; reservedBytes: number; stagingBytes: number;
  trashBytes: number; entries: number; metadataBytes: number; activeReads: number;
  activeWrites: number; dbBytes: number; walBytes: number;
}>;
type Scoped = Readonly<{ scope: FileScope }>;
export interface FileInputs {
  begin: Scoped & Readonly<{ manifest: FileManifest }>;
  status: Scoped & Readonly<{ id: string }>;
  write: Scoped & Readonly<{ id: string; offset: number; data: Uint8Array }>;
  commit: Scoped & Readonly<{ id: string }>;
  abort: Scoped & Readonly<{ id: string }>;
  abandon: Scoped & Readonly<{ id: string }>;
  protect: Scoped & Readonly<{ operationId: string; artifactIds: readonly string[]; consumers: readonly string[] }>;
  settle: Scoped & Readonly<{ operationId: string }>;
  releaseConsumer: Scoped & Readonly<{ operationId: string; consumer: string }>;
  acquire: Scoped & Readonly<{ id: string }>;
  read: Scoped & Readonly<{ leaseId: string; offset: number; length: number }>;
  release: Scoped & Readonly<{ leaseId: string }>;
  /** The Host alone resolves a proved native scope's relative path context. */
  capture: Scoped & Readonly<{ sourceKey: string; path: string; current?: boolean; historyScope?: HistoryScope }>;
  usage: Scoped;
  collect: Scoped & Readonly<{ requiredBytes: number; requiredEntries?: number }>;
  sweep: Scoped;
}
export interface FileOutputs {
  begin: UploadStatus; status: UploadStatus; write: UploadStatus; commit: ArtifactRef;
  abort: UploadStatus; abandon: void; protect: void; settle: void; releaseConsumer: void;
  acquire: Readonly<{ leaseId: string; artifact: ArtifactRef }>;
  read: Uint8Array; release: void; capture: ArtifactRef; usage: FileUsage;
  collect: Readonly<{ expired: readonly string[]; reclaimedBytes: number }>;
  sweep: Readonly<{ expired: readonly string[]; reclaimedBytes: number }>;
}
export type FileMethod = keyof FileInputs;
export interface FilePort {
  call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]>;
}
export type FileErrorCode = "INVALID" | "CONFLICT" | "FENCED" | "NOT_FOUND" | "EXPIRED" | "CORRUPT" | "STORAGE_FULL" | "BUSY" | "CLOSED" | "UNSUPPORTED" | "IO";
export class FileError extends Error {
  constructor(readonly code: FileErrorCode, message: string = code) { super(message); this.name = "FileError"; }
}
export const scopeKey = (scope: FileScope): string => JSON.stringify([scope.connection, scope.principal, scope.host, scope.session]);
export function assertScope(scope: FileScope): void {
  if (!scope || [scope.connection, scope.principal, scope.host, scope.session].some(v => typeof v !== "string" || !v || v.length > 256)) throw new FileError("FENCED");
}
export function assertId(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_.-]{1,256}$/.test(id) || id === "." || id === "..") throw new FileError("INVALID");
}
