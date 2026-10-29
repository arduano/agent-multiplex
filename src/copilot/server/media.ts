import type { StoredFile } from "../../files/index.js";
import { createHash } from "node:crypto";
import { canonicalJson, scopeKey, type Json, type RunRef } from "../../protocol/index.js";
import type { CopilotAsset } from "../contracts.js";
import type { Event } from "../sdk-contracts.js";
import { check, json, object, text } from "./validation.js";
import type { CopilotMediaMaterializer } from "../node-contracts.js";
type Asset = {
  view: CopilotAsset;
  fingerprint: string | null;
  pending?: Promise<void>;
};
/** Derived immutable asset projection only; never a transcript or native owner. */
export class CopilotMedia {
  private readonly assets = new Map<string, Asset>();
  private pendingBytes = 0;
  private pendingCount = 0;
  constructor(
    private readonly run: RunRef,
    private readonly attachment: string,
    private readonly materializer: CopilotMediaMaterializer | undefined,
    private readonly own: <T>(work: Promise<T>) => Promise<T>,
    private readonly changed: (asset: CopilotAsset) => void,
  ) {}
  project(input: Event): Event {
    const data = { ...input.data };
    const descriptors: CopilotAsset[] = [];
    let serial = 0;
    const asset = (raw: unknown): CopilotAsset => {
      let source: Record<string, unknown>;
      try {
        source = object(raw);
      } catch {
        return {
          id: `${input.id}:invalid:${serial++}`,
          name: "Attachment",
          mediaType: "application/octet-stream",
          state: "unavailable",
          reason: "nativeOmitted",
        };
      }
      const id =
        typeof source.assetId === "string" ? text(source.assetId, 1024) : `${input.id}:${serial++}`;
      const name =
        typeof source.displayName === "string"
          ? text(source.displayName.split(/[/\\]/).at(-1), 256)
          : "Attachment";
      const type =
        typeof source.mimeType === "string"
          ? text(source.mimeType, 128)
          : "application/octet-stream";
      const base = { id, name, mediaType: type };
      const known = this.assets.get(id);
      let encoded:
        | {
            json: string;
            bytes: number;
          }
        | undefined;
      let fingerprint: string | null = null;
      try {
        encoded = canonicalJson(source as Json, 8 * 1024 * 1024);
        if (typeof source.data === "string")
          fingerprint = createHash("sha256")
            .update(type + "\n" + source.data)
            .digest("hex");
      } catch {
        return { ...base, state: "unavailable", reason: "capacity" };
      }
      if (known) {
        if (fingerprint && known.fingerprint && fingerprint !== known.fingerprint)
          return { ...base, state: "unavailable", reason: "identity" };
        return known.view;
      }
      if (this.assets.size >= 128) return { ...base, state: "unavailable", reason: "capacity" };
      if (!this.materializer || source.omittedReason !== undefined) {
        const view: CopilotAsset = {
          ...base,
          state: "unavailable",
          reason: source.omittedReason !== undefined ? "nativeOmitted" : "noMaterializer",
        };
        this.assets.set(id, { view, fingerprint });
        return view;
      }
      if (this.pendingCount >= 4 || this.pendingBytes + encoded.bytes > 16 * 1024 * 1024)
        return { ...base, state: "unavailable", reason: "capacity" };
      const entry: Asset = { view: { ...base, state: "pending" }, fingerprint };
      this.assets.set(id, entry);
      this.pendingCount++;
      this.pendingBytes += encoded.bytes;
      const bytes = encoded.bytes;
      const sourceCopy = JSON.parse(encoded.json) as Json;
      entry.pending = this.own(
        Promise.resolve()
          .then(() =>
            this.materializer!.capture({
              run: this.run,
              attachment: this.attachment,
              eventId: input.id,
              stream: input.agentId ?? "root",
              assetId: id,
              name,
              mediaType: type,
              source: sourceCopy,
            }),
          )
          .then(
            (file) => {
              check(
                file.kind === "stored" &&
                  scopeKey(file.scope) === scopeKey(this.run.scope) &&
                  Number.isSafeInteger(file.bytes) &&
                  file.bytes >= 0 &&
                  /^[a-f0-9]{64}$/.test(file.sha256),
                "MEDIA_SCOPE_FENCED",
              );
              const { connection, principal, host, session } = this.run.scope;
              const safe: StoredFile = {
                kind: "stored",
                scope: { connection, principal, host, session },
                id: text(file.id),
                name: text(file.name),
                bytes: file.bytes,
                sha256: file.sha256,
                mediaType: text(file.mediaType, 128),
                origin: file.origin,
                retention: file.retention,
              };
              check(
                ["upload", "capture"].includes(safe.origin) &&
                  ["session", "cache"].includes(safe.retention),
                "MEDIA_FILE_FENCED",
              );
              json(safe, 16384);
              entry.view = { ...base, state: "ready", file: safe };
            },
            () => {
              entry.view = { ...base, state: "unavailable", reason: "captureFailed" };
            },
          )
          .catch(() => {
            entry.view = { ...base, state: "unavailable", reason: "captureFailed" };
          })
          .finally(() => {
            this.pendingCount--;
            this.pendingBytes -= bytes;
            this.changed(entry.view);
          }),
      );
      return entry.view;
    };
    if (input.type === "session.binary_asset") {
      descriptors.push(asset(data));
      delete data.data;
      delete data.metadata;
    }
    if (Array.isArray(data.attachments)) {
      if (data.attachments.length > 32)
        descriptors.push({
          id: `${input.id}:omitted`,
          name: "Additional attachments",
          mediaType: "application/octet-stream",
          state: "unavailable",
          reason: "capacity",
        });
      data.attachments = data.attachments.slice(0, 32).map((raw) => {
        const view = asset(raw);
        descriptors.push(view);
        return { assetId: view.id };
      });
    }
    if (data.result && typeof data.result === "object") {
      const result = { ...object(data.result) };
      for (const key of ["binaryResultsForLlm", "contents"]) {
        if (!Array.isArray(result[key])) continue;
        const values = result[key] as unknown[];
        if (values.length > 32)
          descriptors.push({
            id: `${input.id}:omitted:${key}`,
            name: "Additional attachments",
            mediaType: "application/octet-stream",
            state: "unavailable",
            reason: "capacity",
          });
        result[key] = values.slice(0, 32).map((raw) => {
          const item = object(raw);
          if (
            typeof item.data === "string" ||
            typeof item.assetId === "string" ||
            item.type === "resource_link" ||
            item.type === "resource"
          ) {
            const view = asset(item);
            descriptors.push(view);
            return {
              type: typeof item.type === "string" ? item.type : "unknown",
              assetId: view.id,
            };
          }
          return json(item, 16384);
        });
      }
      data.result = result;
    }
    if (descriptors.length) data._assets = descriptors;
    return { ...input, data };
  }
  async settled(input: Event): Promise<Event> {
    const assets = Array.isArray(input.data._assets) ? (input.data._assets as CopilotAsset[]) : [];
    await Promise.all(assets.map((asset) => this.assets.get(asset.id)?.pending));
    return {
      ...input,
      data: {
        ...input.data,
        ...(assets.length
          ? { _assets: assets.map((asset) => this.assets.get(asset.id)?.view ?? asset) }
          : {}),
      },
    };
  }
}
