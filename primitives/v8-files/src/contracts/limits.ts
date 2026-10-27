export const MiB = 1024 * 1024;
export interface FileLimits {
  maxFileBytes: number; textBytes: number; sessionBytes: number; hostBytes: number;
  sessionEntries: number; hostEntries: number; maxUploads: number; stagingBytes: number;
  stagingTtlMs: number; sessionMetadataBytes: number; hostMetadataBytes: number;
  databaseBytes: number; walBytes: number; chunkBytes: number; maxReads: number;
  maxWrites: number; maxQueued: number; cleanupBatch: number;
}
export const defaultLimits: Readonly<FileLimits> = Object.freeze({
  maxFileBytes: 10 * MiB, textBytes: 2 * MiB, sessionBytes: 100 * MiB, hostBytes: 512 * MiB,
  sessionEntries: 4096, hostEntries: 65536, maxUploads: 10, stagingBytes: 50 * MiB,
  stagingTtlMs: 24 * 60 * 60 * 1000, sessionMetadataBytes: 4 * MiB, hostMetadataBytes: 32 * MiB,
  databaseBytes: 64 * MiB, walBytes: 16 * MiB, chunkBytes: 64 * 1024,
  maxReads: 4, maxWrites: 2, maxQueued: 64, cleanupBatch: 16,
});
export function fileLimits(input: Partial<FileLimits> = {}): Readonly<FileLimits> {
  const result = { ...defaultLimits, ...input };
  for (const value of Object.values(result)) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("File limits must be positive safe integers");
  return Object.freeze(result);
}
