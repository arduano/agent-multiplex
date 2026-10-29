import type { IncomingFileHandler } from "@arduano/p2prpc-core/files";
import type { Json, RunRef, SessionScope } from "../protocol/index.js";
import type {
  NativeInputPort,
  OwnedFileStore,
  FileCapturePreviewPort,
} from "../files/node-contracts.js";
import type {
  AssetTransferPort,
  AssetTransferMetadata,
  NativeMediaInput,
  NativeMediaMaterializer,
} from "./contracts.js";

/** Construction transfers ownership of this exact store, including its final close. */
export type AssetOptions = Readonly<{
  store: OwnedFileStore;
  now?: () => number;
  uploadTtlMs?: number;
  leaseTtlMs?: number;
  maxUploadBytes?: number;
  trustedSourceKey?: (input: NativeMediaInput) => Promise<string> | string;
  assertCurrent?: (run: RunRef) => void;
}>;
export type PreparedAssets<T> = Readonly<{ inputs: readonly T[]; release(): Promise<void> }>;
export type PreparedCodexAsset =
  | Readonly<{ type: "localImage"; path: string }>
  | Readonly<{ type: "mention"; name: string; path: string }>;
export type AssetReadiness =
  Readonly<{ ready: true }> | Readonly<{ ready: false; reasons: readonly string[] }>;
export interface HostAssets
  extends AssetTransferPort, NativeMediaMaterializer, FileCapturePreviewPort {
  readonly incoming: IncomingFileHandler<AssetTransferMetadata>;
  prepare<T>(
    run: RunRef,
    ids: readonly string[],
    port: NativeInputPort<T>,
  ): Promise<PreparedAssets<T>>;
  prepareCodexInputs(
    input: Readonly<{
      run: RunRef;
      originalId: string;
      attachments: readonly Readonly<{ id: string }>[];
    }>,
  ): Promise<PreparedAssets<PreparedCodexAsset>>;
  prepareCopilotInputs(
    run: RunRef,
    ids: readonly string[],
  ): Promise<Readonly<{ attachments: readonly Json[]; release(): Promise<void> }>>;
  retireSession(scope: SessionScope): Promise<void>;
  collect(): Promise<void>;
  readiness(): AssetReadiness;
  close(): Promise<void>;
}
