import type { SessionScope } from "../protocol/index.js";
export type Retention = "session" | "cache";
export type StoredFile = Readonly<{
  kind: "stored";
  scope: SessionScope;
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  origin: "upload" | "capture";
  retention: Retention;
}>;
/** Minted by the Host. Its opaque id never grants authority to a caller path. */
export type HostFile = Readonly<{
  kind: "host";
  scope: SessionScope;
  id: string;
  name: string;
}>;
export type FileReference = StoredFile | HostFile;
export interface FileLease {
  readonly file: StoredFile;
  read(offset: number, length: number): Promise<Uint8Array>;
  release(): Promise<void>;
}
export interface FileReadPort {
  acquire(scope: SessionScope, file: StoredFile): Promise<FileLease>;
}
export type Preview =
  | Readonly<{
      kind: "image" | "pdf";
      file: StoredFile;
    }>
  | Readonly<{
      kind: "html";
      file: StoredFile;
      text: string;
      sandbox: "";
      csp: string;
    }>
  | Readonly<{
      kind: "text";
      file: StoredFile;
      text: string;
    }>
  | Readonly<{
      kind: "mermaid";
      file: StoredFile;
      text: string;
      securityLevel: "strict";
    }>
  | Readonly<{
      kind: "download";
      file: StoredFile;
      reason: "unsupported" | "too-large";
    }>;
export class FileError extends Error {
  constructor(
    readonly code:
      | "INVALID"
      | "FENCED"
      | "NOT_FOUND"
      | "CONFLICT"
      | "CAPACITY"
      | "BUSY"
      | "CORRUPT"
      | "UNSUPPORTED"
      | "CLOSED",
    message: string = code,
  ) {
    super(message);
    this.name = "FileError";
  }
}
