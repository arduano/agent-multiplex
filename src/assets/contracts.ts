import { z } from "zod";
import type { FileSource, PeerFiles, SharedFileHandle } from "@arduano/p2prpc-core/files";
import type { FileReadPort, StoredFile } from "../files/contracts.js";
import type { Json, RunRef, SessionScope } from "../protocol/index.js";
import type { HistorySnapshot, Update } from "../history/contracts.js";
export const ASSET_CHUNK_BYTES = 256 * 1024;
export const ASSET_MAX_FILE_BYTES = 32 * 1024 * 1024;
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const uploadSpecSchema = z
  .object({
    id: identifier,
    name: identifier.regex(/^[^/\\]+$/),
    bytes: z.number().int().min(0).max(ASSET_MAX_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z
      .string()
      .max(128)
      .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
    retention: z.enum(["session", "cache"]).optional(),
  })
  .strict();
export type UploadSpec = z.infer<typeof uploadSpecSchema>;
export const assetTransferMetadataSchema = z
  .object({
    session: identifier,
    file: uploadSpecSchema,
    token: identifier,
  })
  .strict()
  .optional();
export type AssetTransferMetadata = z.infer<typeof assetTransferMetadataSchema>;
export type AssetUploadFiles = Pick<PeerFiles<AssetTransferMetadata>, "sendFile">;
export type AssetDownloadFiles = Pick<PeerFiles<AssetTransferMetadata>, "download">;
export type UploadStatus =
  | Readonly<{
      state: "receiving";
      id: string;
      token: string;
      received: number;
      bytes: number;
      expiresAt: number;
    }>
  | Readonly<{ state: "publishing"; id: string }>
  | Readonly<{ state: "complete"; file: StoredFile }>
  | Readonly<{ state: "unknown"; id: string }>;
export type AssetDownload = Readonly<{ file: StoredFile; handle: SharedFileHandle }>;
/** Business intents only. File bytes use the authenticated peer's actual files API. */
export interface AssetRemote {
  begin(input: { session: string; file: UploadSpec }): Promise<UploadStatus>;
  status(input: { session: string; id: string }): Promise<UploadStatus>;
  abort(input: { session: string; id: string; token: string }): Promise<void>;
  acquire(input: { session: string; file: StoredFile }): Promise<AssetDownload>;
}
export type NativeMediaInput = Readonly<{
  run: RunRef;
  attachment: string;
  stream: string;
  eventId: string;
  assetId: string;
  name: string;
  mediaType: string;
  source: Json;
  rowId?: string;
}>;
export interface NativeMediaMaterializer {
  capture(input: NativeMediaInput): Promise<StoredFile>;
}
export type AssetView = Readonly<{
  id: string;
  name: string;
  mediaType: string;
}> &
  (
    | Readonly<{
        state: "pending";
      }>
    | Readonly<{
        state: "ready";
        file: StoredFile;
      }>
    | Readonly<{
        state: "unavailable";
        reason: string;
      }>
  );
export type AssetOccurrence = Readonly<{
  run: RunRef;
  attachment: string;
  rowId: string;
  assetId: string;
}>;
export type AssetReadPort = FileReadPort;
/** Borrowed Host resource operations; no maintenance or store-close authority. */
export interface AssetTransferPort {
  begin(scope: SessionScope, file: UploadSpec): UploadStatus;
  status(scope: SessionScope, id: string): UploadStatus;
  abort(scope: SessionScope, id: string, token: string): void;
  source(scope: SessionScope, file: StoredFile): FileSource<AssetTransferMetadata>;
}
export interface AssetProjectionPort {
  getSnapshot(): HistorySnapshot;
  update(input: Update): unknown;
}
export class AssetError extends Error {
  constructor(
    readonly code:
      | "INVALID"
      | "FENCED"
      | "NOT_FOUND"
      | "CONFLICT"
      | "CAPACITY"
      | "BUSY"
      | "UNSUPPORTED"
      | "CLOSED"
      | "EXPIRED",
  ) {
    super(code);
    this.name = "AssetError";
  }
}
