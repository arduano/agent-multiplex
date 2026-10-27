import { createHash } from "node:crypto";
import type { ArtifactRef, FileScope } from "../../v8-files/src/contracts/types.js";
import { FileError, scopeKey as fileKey } from "../../v8-files/src/contracts/types.js";
import { imageType } from "../../v8-files/src/contracts/content.js";
import type { FileHost } from "../../v8-files/src/host/index.js";
import type { Harness, NativeInputFor, PreparedSend, Receipt, RunRef, SendSubmit, SessionPort, SessionScope } from "../../v8-session/src/contracts/types.js";
import { isMessageCommand, scopeKey } from "../../v8-session/src/contracts/types.js";
import { canonical } from "../../v8-session/src/contracts/validation.js";
import { validateSendInputs } from "../../v8-session/src/contracts/send-inputs.js";
import { validateNativeCommand } from "../../v8-harness-defaults/src/prepared-send.js";

type Watch = { detach(): void; terminal: boolean; work: Promise<void> };
/** FileHost already owns protection and SessionHost already owns original
 * receipts. This join owns only private buffers and bounded receipt listeners. */
export class SendPreparation {
  readonly #watches = new Map<string, Watch>();
  #reconciliation: Promise<void> | undefined; #failure: unknown; #closed = false;
  constructor(private readonly options: Readonly<{
    scope: SessionScope; kind: Harness; epoch: number; session: SessionPort;
    files(run: RunRef): Promise<FileHost>; nativeInputRoots: readonly string[]; chunkBytes: number;
  }>) {}
  #scope(run: RunRef): FileScope { return { ...run.scope, session: run.nativeSession }; }
  #exact(receipt: Receipt | null, id: string, generation: number): receipt is Receipt {
    return !!receipt && receipt.id === id && ["send", "codex.steer", "copilot.steer", "codex.queue.add"].includes(receipt.type) && receipt.generation === generation && scopeKey(receipt.scope) === scopeKey(this.options.scope);
  }
  #terminal(receipt: Receipt): boolean { return receipt.state === "acknowledged" || receipt.state === "refused"; }
  #remember(error: unknown): void { this.#failure ??= error; }
  reconcile(run: RunRef): Promise<void> {
    if (!this.#reconciliation) this.#reconciliation = this.#reconcile(run).catch(error => { this.#remember(error); throw error; });
    return this.#reconciliation;
  }
  async #reconcile(run: RunRef): Promise<void> {
    const files = await this.options.files(run), scope = this.#scope(run); let after: string | undefined, count = 0;
    do {
      if (this.#closed) throw new FileError("CLOSED");
      const page = await files.protectedOperations(scope, after === undefined ? {} : { after });
      count += page.operations.length; if (count > 4096) throw new FileError("BUSY", "Protected input reconciliation bound reached");
      for (const row of page.operations) {
        const consumers = row.consumers.flatMap(consumer => {
          const match = /^send-input-v1\.e([1-9][0-9]*)\.g([1-9][0-9]*)$/.exec(consumer.id);
          if (!match || consumer.released) return [];
          const epoch = Number(match[1]), generation = Number(match[2]);
          return Number.isSafeInteger(epoch) && epoch < this.options.epoch && Number.isSafeInteger(generation) ? [{ id: consumer.id, generation }] : [];
        });
        if (!consumers.length) continue;
        const receipt = await this.options.session.receipt(this.options.scope, row.id);
        for (const consumer of consumers) if (this.#exact(receipt, row.id, consumer.generation) && this.#terminal(receipt)) {
          await files.call("settle", { scope, operationId: row.id });
          await files.call("releaseConsumer", { scope, operationId: row.id, consumer: consumer.id });
        }
      }
      after = page.next ?? undefined;
    } while (after !== undefined);
  }
  async #watch(files: FileHost, scope: FileScope, request: SendSubmit): Promise<void> {
    if (this.#watches.size >= 128 || !this.options.session.subscribeReceipt) throw new FileError("BUSY", "Original receipt observation is unavailable");
    const watch: Watch = { detach() {}, terminal: false, work: Promise.resolve() };
    const observe = (receipt: Receipt | null): void => {
      if (this.#closed || watch.terminal || !this.#exact(receipt, request.id, request.generation) || receipt.type !== request.command.type || !this.#terminal(receipt)) return;
      watch.terminal = true; watch.detach();
      watch.work = files.call("settle", { scope, operationId: request.id }).catch(error => { this.#remember(error); throw error; }).finally(() => this.#watches.delete(request.id));
      void watch.work.catch(() => {});
    };
    this.#watches.set(request.id, watch);
    try {
      watch.detach = this.options.session.subscribeReceipt(this.options.scope, request.id, observe);
      // A structural receipt port may publish its exact initial value before
      // subscribe returns its release function.
      if (watch.terminal) watch.detach();
      observe(await this.options.session.receipt(this.options.scope, request.id));
    } catch (error) { watch.detach(); this.#watches.delete(request.id); this.#remember(error); throw error; }
  }
  async #bytes(files: FileHost, scope: FileScope, artifact: ArtifactRef, assertCurrent: () => void): Promise<Uint8Array> {
    assertCurrent(); const acquired = await files.call("acquire", { scope, id: artifact.id });
    try {
      assertCurrent(); if (canonical(acquired.artifact) !== canonical(artifact)) throw new FileError("CORRUPT", "Original artifact metadata differs");
      const bytes = new Uint8Array(artifact.bytes);
      for (let offset = 0; offset < bytes.length;) {
        assertCurrent(); const length = Math.min(this.options.chunkBytes, bytes.length - offset), part = await files.call("read", { scope, leaseId: acquired.leaseId, offset, length });
        assertCurrent(); if (part.byteLength !== length) throw new FileError("CORRUPT"); bytes.set(part, offset); offset += length;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new FileError("CORRUPT");
      if (this.options.kind === "codex" || artifact.mediaType.startsWith("image/")) {
        const actual = imageType(bytes); if (!actual || actual !== artifact.mediaType || actual === "image/svg+xml") throw new FileError("UNSUPPORTED", "Native input requires verified raster bytes");
      }
      return bytes;
    } finally {
      try { await files.call("release", { scope, leaseId: acquired.leaseId }); }
      catch (error) { this.#remember(error); throw error; }
    }
  }
  async prepare(request: SendSubmit, run: RunRef, assertCurrent: () => void): Promise<PreparedSend> {
    if (this.#closed) throw new FileError("CLOSED"); if (this.#failure) throw this.#failure;
    assertCurrent(); const manifest = validateSendInputs(this.options.kind, request.command.inputs), scope = this.#scope(run);
    if (scopeKey(request.scope) !== scopeKey(this.options.scope) || scopeKey(run.scope) !== scopeKey(request.scope) || run.generation !== request.generation) throw new FileError("FENCED");
    for (const item of manifest.items) if (fileKey("artifact" in item ? item.artifact.owner : item.file.owner) !== fileKey(scope)) throw new FileError("FENCED");
    await this.reconcile(run); assertCurrent(); if (this.#failure) throw this.#failure;
    const files = await this.options.files(run), artifacts = manifest.items.flatMap(item => "artifact" in item ? [item.artifact.id] : []);
    const consumer = `send-input-v1.e${this.options.epoch}.g${run.generation}`; let protectedInput = false, released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      try { if (protectedInput) await files.call("releaseConsumer", { scope, operationId: request.id, consumer }); released = true; }
      catch (error) { this.#remember(error); throw error; }
    };
    try {
      assertCurrent();
      if (artifacts.length) {
        await files.call("protect", { scope, operationId: request.id, artifactIds: artifacts, consumers: [consumer] }); protectedInput = true;
        await this.#watch(files, scope, request);
      }
      const inputs: NativeInputFor<Harness>[] = [];
      for (const item of manifest.items) {
        assertCurrent();
        if ("artifact" in item) inputs.push({ type: item.type, artifact: item.artifact, bytes: await this.#bytes(files, scope, item.artifact, assertCurrent) });
        else {
          const path = await files.resolveNativePath(scope, item.file, this.options.nativeInputRoots); assertCurrent();
          inputs.push({ type: item.type, path, ...("name" in item ? { name: item.name } : {}), ...("displayName" in item && item.displayName !== undefined ? { displayName: item.displayName } : {}) } as NativeInputFor<Harness>);
        }
      }
      if (!isMessageCommand(request.command)) throw new FileError("FENCED");
      const { inputs: _manifest, ...header } = request.command;
      const command = validateNativeCommand(this.options.kind, { ...header, nativeInputs: { kind: this.options.kind, items: inputs } });
      if (!("nativeInputs" in command)) throw new FileError("FENCED");
      return Object.freeze({ command, release });
    } catch (error) { await release(); throw error; }
  }
  async #eachProtected(run: RunRef, visit: (row: Awaited<ReturnType<FileHost["protectedOperations"]>>["operations"][number], files: FileHost, scope: FileScope) => Promise<boolean>): Promise<boolean> {
    const files = await this.options.files(run), scope = this.#scope(run); let after: string | undefined, count = 0;
    do {
      const page = await files.protectedOperations(scope, after === undefined ? {} : { after });
      count += page.operations.length; if (count > 4096) return false;
      for (const row of page.operations) if (!await visit(row, files, scope)) return false;
      after = page.next ?? undefined;
    } while (after !== undefined);
    return true;
  }
  #retirableConsumer(value: string, run: RunRef): boolean {
    const match = /^send-input-v1\.e([1-9][0-9]*)\.g([1-9][0-9]*)$/.exec(value);
    const epoch = Number(match?.[1]), generation = Number(match?.[2]);
    return !!match && Number.isSafeInteger(epoch) && epoch <= this.options.epoch && Number.isSafeInteger(generation) && generation <= run.generation;
  }
  /** Only after positive native Stop. Audit uncertainty is not an active native
   * consumer, and remains unsettled/protected after the consumer is released. */
  async archiveReady(run: RunRef): Promise<boolean> {
    if (this.#failure || this.#closed) return false;
    return this.#eachProtected(run, async row => row.consumers.every(consumer => consumer.released || this.#retirableConsumer(consumer.id, run)));
  }
  async retire(run: RunRef): Promise<void> {
    if (!await this.archiveReady(run)) throw new FileError("BUSY", "Unknown native file consumer remains");
    await this.close();
    if (this.#failure || !await this.#eachProtected(run, async (row, files, scope) => {
      for (const consumer of row.consumers) if (!consumer.released) await files.call("releaseConsumer", { scope, operationId: row.id, consumer: consumer.id });
      return true;
    })) throw new FileError("BUSY", "Native input retirement remains unconfirmed");
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const watch of this.#watches.values()) watch.detach();
    await Promise.allSettled([...this.#watches.values()].map(watch => watch.work)); this.#watches.clear();
    if (this.#reconciliation) await this.#reconciliation.catch(() => {});
  }
}
