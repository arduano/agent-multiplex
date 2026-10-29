import type { SessionScope } from "../protocol/index.js";
import type { FileReadPort, HostFile, Preview, Retention, StoredFile } from "./contracts.js";

export type FileLimits = Readonly<{
  maxFileBytes: number;
  maxBytes: number;
  maxSessionBytes: number;
  maxEntries: number;
  maxScopes: number;
  maxStagingBytes: number;
  maxStaging: number;
  maxLeases: number;
  maxReferences: number;
  maxReadBytes: number;
  cacheTtlMs: number;
}>;
export interface HostPathAuthority {
  /** This trusted Host policy checks its native occurrence/workspace and private
   * roots, and returns an authorized canonical absolute path. */
  resolve(
    scope: SessionScope,
    sourceKey: string,
  ): Promise<
    Readonly<{
      path: string;
      name?: string;
      mediaType?: string;
    }>
  >;
}
export interface NativeInputPort<T> {
  accepts(file: StoredFile): boolean;
  prepare(
    input: Readonly<{
      file: StoredFile;
      path: string;
      read(offset: number, length: number): Promise<Uint8Array>;
    }>,
  ): Promise<T>;
}

export type FileStoreOptions = Readonly<{
  directory: string;
  limits?: Partial<FileLimits>;
  paths?: HostPathAuthority;
  now?: () => number;
}>;
export type FileUsage = Readonly<{
  bytes: number;
  entries: number;
  reservedBytes: number;
  trashBytes: number;
  staging: number;
  leases: number;
  references: number;
}>;
export type FilePut = Readonly<{
  id: string;
  name: string;
  mediaType?: string;
  retention?: Retention;
}>;
/** Borrowed facets retain the exact resource token and never gain close authority. */
export interface FileLookupPort {
  readonly resourceIdentity: object;
  file(scope: SessionScope, id: string): StoredFile | null;
  isRetired(scope: SessionScope): boolean;
}
export interface FileCapturePort extends FileLookupPort {
  reference(scope: SessionScope, sourceKey: string): Promise<HostFile>;
  capture(
    scope: SessionScope,
    reference: HostFile,
    input: Readonly<{ id: string; retention?: Retention }>,
  ): Promise<StoredFile>;
}
export interface FileAccessPort extends FileCapturePort, FileReadPort {
  put(
    scope: SessionScope,
    input: FilePut,
    data: Uint8Array,
    origin?: "upload" | "capture",
    publication?: Readonly<{ signal?: AbortSignal; onCommitted(file: StoredFile): void }>,
  ): Promise<StoredFile>;
  prepareInput<T>(
    scope: SessionScope,
    file: StoredFile,
    port: NativeInputPort<T>,
  ): Promise<Readonly<{ input: T; release(): Promise<void> }>>;
}
/** Explicit ownership transfer includes maintenance and final close of this resource. */
export interface OwnedFileStore extends FileAccessPort {
  usage(): FileUsage;
  retireSession(scope: SessionScope): Promise<void>;
  collect(): Promise<Readonly<{ files: number; bytes: number }>>;
  close(): void;
}
/** One borrowed capability captures and previews through its actual store owner. */
export interface FileCapturePreviewPort {
  readonly resourceIdentity: object;
  capturePreview(
    input: Readonly<{ scope: SessionScope; sourceKey: string; id: string }>,
    assertCurrent: () => void,
  ): Promise<Preview>;
}
