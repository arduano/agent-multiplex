import { blobSource, memoryDestination } from "@arduano/p2prpc-core/files";
import type { FileReadPort, StoredFile } from "../files/contracts.js";
import { scopeKey } from "../protocol/index.js";
import {
  ASSET_CHUNK_BYTES,
  ASSET_MAX_FILE_BYTES,
  AssetError,
  type AssetRemote,
  type AssetUploadFiles,
  type AssetDownloadFiles,
  type UploadSpec,
} from "./contracts.js";
function exact(actual: StoredFile, expected: Pick<StoredFile, "id" | "bytes" | "sha256">): void {
  if (
    actual.id !== expected.id ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  )
    throw new AssetError("FENCED");
}
export function assetFileReadPort(
  remote: Pick<AssetRemote, "acquire">,
  files: AssetDownloadFiles,
): FileReadPort {
  let leases = 0,
    reservedBytes = 0;
  return {
    async acquire(scope, file) {
      if (scopeKey(scope) !== scopeKey(file.scope) || file.bytes > ASSET_MAX_FILE_BYTES)
        throw new AssetError("FENCED");
      if (leases >= 4 || reservedBytes + file.bytes > 64 * 1024 * 1024)
        throw new AssetError("CAPACITY");
      leases++;
      reservedBytes += file.bytes;
      let reserved = true;
      const release = () => {
        if (!reserved) return;
        reserved = false;
        leases--;
        reservedBytes -= file.bytes;
      };
      try {
        const capability = await remote.acquire({ session: scope.session, file });
        exact(capability.file, file);
        if (scopeKey(capability.file.scope) !== scopeKey(scope)) throw new AssetError("FENCED");
        const destination = memoryDestination({ maxBytes: Math.max(1, file.bytes) });
        const transfer = await files.download(capability.handle, destination);
        await transfer.result;
        let blob = destination.blob();
        if (!blob || blob.size !== file.bytes) throw new AssetError("CONFLICT");
        const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        if (
          [...new Uint8Array(digest)]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("") !== file.sha256
        )
          throw new AssetError("CONFLICT");
        return {
          file: capability.file,
          async read(offset, length) {
            if (!blob) throw new AssetError("CLOSED");
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(length) ||
              length < 0 ||
              length > ASSET_CHUNK_BYTES ||
              offset + length > blob.size
            )
              throw new AssetError("INVALID");
            return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
          },
          async release() {
            blob = null;
            release();
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
/** Admission is issued once. The library owns transfer resumption; only an exact
 * read of the business identity reconciles a lost publication reply. */
export async function uploadFile(
  remote: Pick<AssetRemote, "begin" | "status">,
  files: AssetUploadFiles,
  input: { session: string; file: UploadSpec },
  data: Blob | Uint8Array,
  signal?: AbortSignal,
): Promise<StoredFile> {
  const { session, file } = input;
  const blob = data instanceof Uint8Array ? new Blob([data.slice()]) : data;
  if (blob.size !== file.bytes || blob.size > ASSET_MAX_FILE_BYTES) throw new AssetError("INVALID");
  signal?.throwIfAborted();
  const admitted = await remote.begin(input);
  if (admitted.state === "complete") {
    exact(admitted.file, file);
    return admitted.file;
  }
  if (admitted.state !== "receiving") throw new AssetError("BUSY");
  const transfer = await files.sendFile(
    blobSource(blob, {
      name: file.name,
      metadata: { session, file, token: admitted.token },
    }),
    signal ? { signal } : {},
  );
  await transfer.result;
  const status = await remote.status({ session, id: file.id });
  if (status.state !== "complete") throw new AssetError("BUSY");
  exact(status.file, file);
  return status.file;
}
