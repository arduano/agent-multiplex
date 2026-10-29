import type { StoredFile } from "../../files/index.js";
import type { CodexAsset } from "../contracts.js";
import { createHash } from "node:crypto";
import { canonicalJson, scopeKey, type Json, type RunRef } from "../../protocol/index.js";
import type { HistoryWindow } from "../../history/index.js";
import { check, json, object, text } from "./validation.js";
import type { CodexMediaMaterializer } from "../node-contracts.js";
type Entry = {
  view: CodexAsset;
  fingerprint: string;
  pending?: Promise<void>;
  conflict: boolean;
};

/** Derived files only. Native ordering, text and lifetime facts stay with history. */
export class CodexMedia {
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Set<Promise<void>>();
  #sealed = false;
  constructor(
    readonly run: RunRef,
    readonly attachment: string,
    readonly materializer: CodexMediaMaterializer | undefined,
    readonly window: (stream: string) => HistoryWindow | undefined,
    readonly current: () => boolean,
  ) {}
  get busy(): boolean {
    return this.#pending.size > 0;
  }
  seal(): void {
    if (this.#sealed) return;
    for (const [id, entry] of this.#entries)
      if (entry.pending) {
        entry.view = {
          id,
          name: entry.view.name,
          mediaType: entry.view.mediaType,
          state: "unavailable",
          reason: "stopped",
        };
      }
    this.#sealed = true;
  }
  settled(): Promise<void> {
    return Promise.all([...this.#pending]).then(() => {});
  }
  #publish(stream: string, rowId: string, asset: CodexAsset): void {
    if (this.#sealed || !this.current()) return;
    const window = this.window(stream);
    if (!window) return;
    const row = window.getSnapshot().rows.find((row) => row.id === rowId);
    if (
      !row ||
      !Array.isArray(row.native.assets) ||
      !row.native.assets.some(
        (value) =>
          value && typeof value === "object" && !Array.isArray(value) && value.id === asset.id,
      )
    )
      return;
    const native = {
      ...row.native,
      assets: row.native.assets.map((value) =>
        value && typeof value === "object" && !Array.isArray(value) && value.id === asset.id
          ? asset
          : value,
      ),
    };
    try {
      canonicalJson(native as unknown as Json, 8192);
      window.update({
        rows: [
          {
            id: row.id,
            kind: row.kind,
            lifecycle: row.lifecycle,
            body: row.body,
            native: native as Record<string, Json>,
          },
        ],
      });
    } catch {
      /* Optional derived metadata cannot destroy transcript capture. */
    }
  }
  project(stream: string, turnId: string, raw: unknown): readonly CodexAsset[] {
    return this.#project(stream, turnId, raw, true);
  }
  /** Publication is a pure lookup; only owned intake/preparation may admit work. */
  view(stream: string, turnId: string, raw: unknown): readonly CodexAsset[] {
    return this.#project(stream, turnId, raw, false);
  }
  #project(stream: string, turnId: string, raw: unknown, admit: boolean): readonly CodexAsset[] {
    const item = object(raw),
      itemId = text(item.id),
      type = text(item.type),
      rowId = `${stream}:${itemId}`,
      sources: unknown[] = [];
    const result = item.result && typeof item.result === "object" ? object(item.result) : {};
    const parts =
      type === "mcpToolCall"
        ? result.content
        : type === "dynamicToolCall"
          ? item.contentItems
          : type === "functionCallOutput"
            ? item.output
            : item.content;
    if (Array.isArray(parts))
      for (const raw of parts.slice(0, 32)) {
        const part = object(raw);
        if (
          ["image", "image_url", "inputImage", "input_image", "localImage"].includes(
            String(part.type),
          )
        )
          sources.push(part);
      }
    if (type === "imageView" && typeof item.path === "string") sources.push({ path: item.path });
    if (type === "imageGeneration") {
      if (typeof item.savedPath === "string") sources.push({ path: item.savedPath });
      else if (typeof item.result === "string" && item.result)
        sources.push({ data: item.result, mimeType: "image/png" });
    }
    return sources.map((source, index) => {
      const id = `codex-media-${createHash("sha256")
          .update(JSON.stringify([stream, itemId, index]))
          .digest("hex")}`,
        name = `Image ${index + 1}`,
        base = { id, name, mediaType: "image/png" };
      let encoded: string;
      try {
        encoded = canonicalJson(source as Json, 48 * 1024 * 1024).json;
      } catch {
        return { ...base, state: "unavailable", reason: "capacity" };
      }
      const fingerprint = createHash("sha256").update(encoded).digest("hex"),
        known = this.#entries.get(id);
      if (known) {
        if (known.fingerprint !== fingerprint) {
          known.conflict = true;
          known.view = { ...base, state: "unavailable", reason: "identity" };
        }
        return known.view;
      }
      if (!admit)
        return {
          ...base,
          state: "unavailable",
          reason: this.#sealed ? "stopped" : this.materializer ? "capacity" : "noMaterializer",
        };
      if (this.#entries.size >= 128) {
        const victim = [...this.#entries].find(([, value]) => !value.pending);
        if (victim) this.#entries.delete(victim[0]);
      }
      if (!this.materializer || this.#sealed)
        return { ...base, state: "unavailable", reason: "noMaterializer" };
      if (this.#pending.size >= 4 || this.#entries.size >= 128)
        return { ...base, state: "unavailable", reason: "capacity" };
      const entry: Entry = { view: { ...base, state: "pending" }, fingerprint, conflict: false };
      this.#entries.set(id, entry);
      const pending = Promise.resolve()
        .then(() =>
          this.materializer!.capture({
            run: this.run,
            attachment: this.attachment,
            stream,
            eventId: JSON.stringify([turnId, itemId]),
            rowId,
            assetId: id,
            name,
            mediaType: base.mediaType,
            source: JSON.parse(encoded) as Json,
          }),
        )
        .then(
          (file) => {
            check(
              scopeKey(file.scope) === scopeKey(this.run.scope) &&
                file.kind === "stored" &&
                file.bytes >= 0 &&
                file.bytes <= 32 * 1024 * 1024 &&
                Number.isSafeInteger(file.bytes),
              "MEDIA_FILE_FENCED",
            );
            const safe: StoredFile = {
              kind: "stored",
              scope: {
                connection: this.run.scope.connection,
                principal: this.run.scope.principal,
                host: this.run.scope.host,
                session: this.run.scope.session,
              },
              id: text(file.id),
              name: text(file.name),
              bytes: file.bytes,
              sha256: text(file.sha256),
              mediaType: text(file.mediaType),
              origin: file.origin,
              retention: file.retention,
            };
            check(
              /^[a-f0-9]{64}$/.test(safe.sha256) &&
                ["capture", "upload"].includes(safe.origin) &&
                ["cache", "session"].includes(safe.retention),
              "MEDIA_FILE_FENCED",
            );
            if (!entry.conflict)
              entry.view = { ...base, mediaType: file.mediaType, state: "ready", file: safe };
          },
          () => {
            if (!entry.conflict)
              entry.view = { ...base, state: "unavailable", reason: "captureFailed" };
          },
        )
        .catch(() => {
          if (!entry.conflict)
            entry.view = { ...base, state: "unavailable", reason: "captureFailed" };
        })
        .finally(() => {
          this.#pending.delete(pending);
          delete entry.pending;
          this.#publish(stream, rowId, entry.view);
        });
      entry.pending = pending;
      this.#pending.add(pending);
      return entry.view;
    });
  }
  async preparePage(
    raw: unknown,
    current: () => void,
    stream = this.run.nativeSession,
  ): Promise<void> {
    const page = object(raw);
    check(Array.isArray(page.data) && page.data.length <= 128, "HISTORY_PAGE_BOUND");
    for (const raw of page.data) {
      const entry = object(raw);
      if (entry.type !== "item") continue;
      current();
      this.project(
        typeof entry.threadId === "string" ? entry.threadId : stream,
        text(entry.turnId),
        entry.item,
      );
      await this.settled();
      current();
    }
  }
}
/** Native metadata has a separate small budget; omission must remain local. */
export function withCodexAssets(
  native: Record<string, Json>,
  assets: readonly CodexAsset[],
): Record<string, Json> {
  if (!assets.length) return native;
  const values: Json[] = [];
  for (const asset of assets) {
    try {
      json({ ...native, assets: [...values, asset] }, 7000);
      values.push(asset as unknown as Json);
    } catch {
      try {
        const unavailable: Json = {
          id: asset.id,
          name: "Image",
          mediaType: "application/octet-stream",
          state: "unavailable",
          reason: "capacity",
        };
        json({ ...native, assets: [...values, unavailable] }, 7000);
        values.push(unavailable);
      } catch {
        /* bounded summary below */
      }
    }
  }
  return {
    ...native,
    assets: values,
    ...(values.length < assets.length ? { mediaOmitted: assets.length - values.length } : {}),
  };
}
