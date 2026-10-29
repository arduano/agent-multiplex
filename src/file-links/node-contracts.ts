import type { RunRef } from "../protocol/index.js";
import type { FileCapturePreviewPort } from "../files/node-contracts.js";
import type { HistorySnapshotSource, Row } from "../history/contracts.js";
import type { FileLink, FileLinkResolvePort } from "./contracts.js";

export type HostFileLinkOptions = Readonly<{
  /** Borrowed capture/preview capability; no store or asset-owner close authority. */
  files: FileCapturePreviewPort;
  current(scope: RunRef["scope"]): RunRef | null;
  history(run: RunRef, stream: string): HistorySnapshotSource;
  /** Authorizes this actual native row and href to an existing opaque source key. */
  source(input: Readonly<{ link: FileLink; row: Row }>): string | Promise<string>;
  maxEntries?: number;
  maxPending?: number;
}>;
export interface HostFileLinkOwner extends FileLinkResolvePort {
  readiness(): boolean;
  close(): Promise<void>;
}
