import type { SessionPrincipal } from "@arduano/p2prpc-core/browser";
import { blake3 } from "@noble/hashes/blake3";
import { randomUUID } from "node:crypto";
import type {
  FileDestination,
  FileManifest,
  FileSource,
  FileTransfer,
  PeerFiles,
} from "@arduano/p2prpc-core/files";
import type { HostAssetOwner } from "../../src/assets/node.js";
import type { AssetTransferMetadata } from "../../src/assets/contracts.js";
import type { SessionScope } from "../../src/protocol/index.js";
/** Scripted transfer driver, not a transport qualification. It invokes the
 * actual destination/source contracts and real FileStore publication boundary. */
export function transferFixture(
  owner: HostAssetOwner,
  scope: SessionScope,
  hooks: { beforeFinalize?: () => Promise<void>; afterFinalize?: () => void } = {},
) {
  const shares = new Map<string, FileSource<AssetTransferMetadata>>();
  const principal: SessionPrincipal = {
    id: scope.principal,
    subject: scope.principal,
    expiresAt: Date.now() + 60000,
    scopes: new Set(),
    claims: {
      viewer: {
        connection: scope.connection,
        principal: scope.principal,
        actions: ["read", "control"],
        hosts: [scope.host],
      },
      target: {
        route: { authority: "root", host: scope.host, owner: "owner", routeEpoch: "e" },
        expected: { contractId: "test", contractVersion: 1, compositionId: "test" },
      },
    },
  };
  let sends = 0;
  const drive = async (
    source: FileSource<AssetTransferMetadata>,
    destination?: FileDestination<AssetTransferMetadata>,
    signal?: AbortSignal,
  ): Promise<FileTransfer<AssetTransferMetadata>> => {
    const prepared = await source.prepare?.(signal),
      current = prepared ?? source;
    const chunkSize = 256 * 1024,
      chunkCount = Math.ceil(current.size / chunkSize),
      chunks: Uint8Array[] = [];
    try {
      for (let index = 0; index < chunkCount; index++)
        chunks.push(await current.readChunk(index, chunkSize, signal));
      const data = new Uint8Array(current.size);
      for (let index = 0; index < chunks.length; index++)
        data.set(chunks[index]!, index * chunkSize);
      const manifest: FileManifest<AssetTransferMetadata> = {
        transferId: randomUUID(),
        name: current.name,
        size: current.size,
        digest: Buffer.from(blake3(data)).toString("hex"),
        chunkSize,
        chunkCount,
        ...(current.metadata ? { metadata: current.metadata } : {}),
      };
      const target =
        destination ??
        (
          await owner.incoming({
            peerId: "fixture",
            principal,
            sessionId: "fixture",
            signal: new AbortController().signal,
            manifest,
          })
        ).accept;
      if (!target) throw Error("Rejected file");
      const result = (async () => {
        try {
          const retained = await target.prepare(manifest, signal);
          for (let index = 0; index < chunks.length; index++)
            if (!retained.has(index))
              await target.writeChunk(manifest, index, chunks[index]!, signal);
          await hooks.beforeFinalize?.();
          let committed = false;
          await target.finalize(manifest, {
            ...(signal ? { signal } : {}),
            markCommitted() {
              committed = true;
            },
          });
          if (!committed) throw Error("Missing publication witness");
          hooks.afterFinalize?.();
          return { manifest, resumed: false, durationMs: 0 };
        } catch (error) {
          await target.abort(manifest, { discard: true });
          throw error;
        } finally {
          await prepared?.close();
        }
      })();
      return { manifest, result, cancel() {}, async *progress() {} };
    } catch (error) {
      await prepared?.close();
      throw error;
    }
  };
  const files: PeerFiles<AssetTransferMetadata> = {
    sendFile(source, options) {
      sends++;
      return drive(source, undefined, options?.signal);
    },
    async download(handle, destination, options) {
      const source = shares.get(handle.token);
      if (!source) throw Error("Unknown capability");
      shares.delete(handle.token);
      return drive(source, destination, options?.signal);
    },
    share(source) {
      const token = randomUUID();
      shares.set(token, source);
      return { token };
    },
    revoke(handle) {
      return shares.delete(handle.token);
    },
  };
  return {
    files,
    principal,
    counts: () => ({ sends }),
    bridge: {
      peerId: "fixture",
      principal,
      via: { peerId: "gateway", principal },
      request: {
        id: 1,
        path: "assets",
        type: "query" as const,
        headers: {},
        signal: new AbortController().signal,
      },
      files,
    },
  };
}
