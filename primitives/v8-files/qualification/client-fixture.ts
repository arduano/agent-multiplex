import { digest } from "../src/contracts/content.js";
import { FileError, scopeKey, type ArtifactRef, type FileInputs, type FileMethod, type FileOutputs, type FilePort, type UploadStatus } from "../src/contracts/types.js";

/** Scripted server, deliberately not durable storage or native model evidence. */
export class ClientFixturePort implements FilePort {
  readonly uploads = new Map<string, { status: UploadStatus; data: Uint8Array }>();
  readonly leases = new Map<string, { key: string }>();
  readonly calls: string[] = []; readonly begins = new Set<string>();
  blockedRead: Promise<void> | undefined;
  async call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
    this.calls.push(method);
    const value = input as FileInputs["begin"] & FileInputs["read"] & FileInputs["write"];
    const key = `${scopeKey(value.scope)}:${value.id ?? value.manifest?.id}`;
    const prior = this.uploads.get(key);
    let result: unknown;
    switch (method) {
      case "status": result = prior?.status ?? { state: "missing" }; break;
      case "begin": {
        this.begins.add(value.manifest.id);
        if (!prior) this.uploads.set(key, { status: { state: "uploading", manifest: value.manifest, offset: 0 }, data: new Uint8Array(value.manifest.bytes) });
        result = this.uploads.get(key)!.status; break;
      }
      case "write": {
        if (prior?.status.state !== "uploading") throw new FileError("CONFLICT");
        if (value.offset < prior.status.offset) {
          if (value.data.some((v, i) => prior.data[value.offset + i] !== v)) throw new FileError("CONFLICT");
        } else if (value.offset === prior.status.offset) { prior.data.set(value.data, value.offset); prior.status = { ...prior.status, offset: value.offset + value.data.length }; }
        else throw new FileError("CONFLICT");
        result = prior.status; break;
      }
      case "commit": {
        if (prior?.status.state === "committed") { result = prior.status.artifact; break; }
        if (prior?.status.state !== "uploading" || prior.status.offset !== prior.data.length || await digest(prior.data) !== prior.status.manifest.sha256) throw new FileError("CORRUPT");
        const { id, name, mediaType, bytes, sha256 } = prior.status.manifest;
        const artifact: ArtifactRef = { kind: "artifact", owner: value.scope, id, name, mediaType, bytes, sha256, capturedAt: 1 };
        prior.status = { state: "committed", artifact }; result = artifact; break;
      }
      case "acquire": {
        if (prior?.status.state !== "committed") throw new FileError(prior?.status.state === "expired" ? "EXPIRED" : "NOT_FOUND");
        const leaseId = crypto.randomUUID(); this.leases.set(leaseId, { key }); result = { leaseId, artifact: prior.status.artifact }; break;
      }
      case "read": {
        await this.blockedRead;
        const lease = this.leases.get(value.leaseId); if (!lease || !lease.key.startsWith(`${scopeKey(value.scope)}:`)) throw new FileError("FENCED");
        result = this.uploads.get(lease.key)!.data.slice(value.offset, value.offset + value.length); break;
      }
      case "release": this.leases.delete(value.leaseId); break;
      case "abort": {
        if (prior?.status.state !== "uploading") throw new FileError("CONFLICT");
        prior.status = { state: "aborted", manifest: prior.status.manifest }; result = prior.status; break;
      }
      default: throw new FileError("UNSUPPORTED");
    }
    return result as FileOutputs[M];
  }
}
