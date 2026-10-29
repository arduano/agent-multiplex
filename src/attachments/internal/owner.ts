import {
  uploadFile,
  type AssetRemote,
  type AssetUploadFiles,
  type UploadSpec,
} from "../../assets/index.js";
import type { DraftUploadPort } from "../../client/contracts.js";
import type {
  AttachmentSource,
  AttachmentSnapshot,
  UploadView,
  AttachmentController,
} from "../contracts.js";
import { mediaType, type StoredFile } from "../../files/index.js";
import { scopeKey } from "../../protocol/index.js";

type Job = { view: UploadView; spec?: UploadSpec; work?: Promise<void>; release(): void };
/** Transfer custody only. Confirmed draft descriptors belong to SessionEntry;
 * this owner never retains another draft or dispatches an agent command. */
export class AttachmentOwner implements AttachmentController {
  readonly #jobs = new Map<string, Job>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  #snapshot: AttachmentSnapshot = Object.freeze({ revision: 0, busy: false, uploads: [] });
  constructor(
    private readonly draft: DraftUploadPort,
    private readonly remote: AssetRemote,
    private readonly files: AssetUploadFiles,
  ) {}
  get owner(): DraftUploadPort["owner"] {
    return this.draft.owner;
  }
  getSnapshot = (): AttachmentSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.#listeners.size >= 64) throw Error("ATTACHMENT_CAPACITY");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  add(sources: readonly AttachmentSource[]): Promise<void> {
    if (this.#closed) throw Error("ATTACHMENTS_CLOSED");
    const confirmed = this.draft.getDraft().attachments,
      pending = [...this.#jobs.values()];
    if (
      !sources.length ||
      confirmed.length + pending.length + sources.length > this.draft.attachmentLimits.maxFiles ||
      confirmed.reduce((sum, file) => sum + file.bytes, 0) +
        pending.reduce((sum, job) => sum + job.view.bytes, 0) +
        sources.reduce((sum, file) => sum + file.size, 0) >
        this.draft.attachmentLimits.maxBytes
    )
      throw Error("ATTACHMENT_CAPACITY");
    for (const source of sources)
      if (
        !Number.isSafeInteger(source.size) ||
        source.size < 0 ||
        source.size > this.draft.attachmentLimits.maxBytes ||
        !source.name ||
        source.name.length > 256 ||
        /[\x00-\x1f\x7f]/.test(source.name) ||
        typeof source.type !== "string" ||
        source.type.length > 256 ||
        /[\x00-\x1f\x7f]/.test(source.type)
      )
        throw Error("INVALID_ATTACHMENT");
    const admitted: { source: AttachmentSource; job: Job }[] = [];
    try {
      for (const source of sources) {
        const release = this.draft.holdDraftPreparation(source.size),
          job: Job = {
            view: Object.freeze({
              id: crypto.randomUUID(),
              name: source.name,
              bytes: source.size,
              state: "uploading",
              removed: false,
            }),
            release,
          };
        admitted.push({ source, job });
      }
    } catch (error) {
      for (const { job } of admitted) job.release();
      throw error;
    }
    for (const { source, job } of admitted) {
      const previous = [...this.#jobs.values()].findLast((value) => !!value.work)?.work;
      this.#jobs.set(job.view.id, job);
      job.work = Promise.resolve(previous)
        .catch(() => {})
        .then(async () => {
          if (job.view.removed) return;
          const bytes = new Uint8Array(await source.arrayBuffer());
          if (bytes.length !== source.size) throw Error("INVALID_ATTACHMENT");
          const digest = await crypto.subtle.digest("SHA-256", bytes),
            sha256 = [...new Uint8Array(digest)]
              .map((value) => value.toString(16).padStart(2, "0"))
              .join("");
          if (job.view.removed) return;
          job.spec = {
            id: job.view.id,
            name: source.name,
            bytes: bytes.length,
            sha256,
            mediaType: mediaType(bytes, source.type || "application/octet-stream"),
            retention: "session",
          };
          const file = await uploadFile(
            this.remote,
            this.files,
            { session: this.draft.scope.session, file: job.spec },
            bytes,
          );
          await this.#confirm(job, file);
        })
        .catch((error) => {
          job.view = Object.freeze({ ...job.view, state: job.spec ? "unconfirmed" : "failed" });
          throw error;
        })
        .finally(() => {
          delete job.work;
          if (job.view.removed || !this.#jobs.has(job.view.id)) {
            job.release();
            this.#jobs.delete(job.view.id);
          }
          this.#publish();
        });
      void job.work.catch(() => {});
    }
    this.#publish();
    return Promise.all(admitted.map(({ job }) => job.work)).then(() => {});
  }
  /** Read the same upload identity after an uncertain reply; never admits or transfers the file again. Clearing intent does not claim in-flight I/O was cancelled. */
  async check(id: string): Promise<void> {
    if (this.#closed) throw Error("ATTACHMENTS_CLOSED");
    const job = this.#jobs.get(id);
    if (!job || !job.spec) throw Error("ATTACHMENT_NOT_CHECKABLE");
    if (job.work) return job.work;
    job.work = Promise.resolve()
      .then(async () => {
        const status = await this.remote.status({ session: this.draft.scope.session, id });
        if (status.state === "complete") await this.#confirm(job, status.file);
      })
      .finally(() => {
        delete job.work;
        if (job.view.removed) {
          job.release();
          this.#jobs.delete(id);
        }
        this.#publish();
      });
    this.#publish();
    return job.work;
  }
  clear(id: string): void {
    const job = this.#jobs.get(id);
    if (!job) return;
    if (job.work) job.view = Object.freeze({ ...job.view, removed: true });
    else {
      job.release();
      this.#jobs.delete(id);
    }
    this.#publish();
  }
  async #confirm(job: Job, file: StoredFile): Promise<void> {
    const spec = job.spec;
    if (
      !spec ||
      scopeKey(file.scope) !== scopeKey(this.draft.scope) ||
      file.id !== spec.id ||
      file.sha256 !== spec.sha256 ||
      file.bytes !== spec.bytes
    )
      throw Error("ATTACHMENT_FENCED");
    job.release();
    if (!job.view.removed && !this.draft.getDraft().archived) {
      const current = this.draft.getDraft().attachments,
        previous = current.find((value) => value.id === file.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(file))
        throw Error("ATTACHMENT_CONFLICT");
      if (!previous) await this.draft.setAttachments([...current, file]);
    }
    this.#jobs.delete(job.view.id);
  }
  #publish(): void {
    this.#snapshot = Object.freeze({
      revision: this.#snapshot.revision + 1,
      busy: [...this.#jobs.values()].some((job) => !!job.work),
      uploads: Object.freeze([...this.#jobs.values()].map((job) => job.view)),
    });
    for (const listener of this.#listeners)
      try {
        listener();
      } catch {}
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(
      [...this.#jobs.values()].flatMap((job) => (job.work ? [job.work] : [])),
    );
    for (const job of this.#jobs.values()) job.release();
    this.#jobs.clear();
    this.#listeners.clear();
    this.#publish();
  }
}
