import type { SessionOwnerIdentity } from "../client/contracts.js";
export type { DraftUploadPort } from "../client/contracts.js";
/** File and clipboard Blob adapters supply only bytes/metadata, never paths. */
export type AttachmentSource = Readonly<{
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
export type UploadView = Readonly<{
  id: string;
  name: string;
  bytes: number;
  state: "uploading" | "failed" | "unconfirmed";
  removed: boolean;
}>;
export type AttachmentSnapshot = Readonly<{
  revision: number;
  busy: boolean;
  uploads: readonly UploadView[];
}>;
export interface AttachmentController {
  readonly owner: SessionOwnerIdentity;
  getSnapshot(): AttachmentSnapshot;
  subscribe(listener: () => void): () => void;
  add(sources: readonly AttachmentSource[]): Promise<void>;
  check(id: string): Promise<void>;
  clear(id: string): void;
}
