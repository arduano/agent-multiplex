import { imageType } from '../../v8-files/src/contracts/content.js';
import { FileError, type ArtifactRef, type FileErrorCode, type FileScope } from '../../v8-files/src/contracts/types.js';
import type { DraftRecord } from '../../v8-files/src/client/persistence.js';
import type { OperationHandle, OriginalReceiptReference } from '../../v8-session/src/client/workspace.js';
import { sendInputLimits } from '../../v8-session/src/contracts/send-inputs.js';
import { sameRun, scopeKey, type Harness, type RunRef, type Selection, type MessageCommandFor } from '../../v8-session/src/contracts/types.js';
import type { ComposerCapture, RetainedComposer } from './composer.js';

export type DraftAction = 'send' | 'steer' | 'queue';
export type SendPreparationSnapshot = Readonly<{ state: 'idle' }> |
  Readonly<{ state: 'preparing'; edit: number; action: DraftAction }> |
  Readonly<{ state: 'failed'; edit: number; action: DraftAction; code: FileErrorCode }>;
export type SendContext = Readonly<{ run: RunRef; epoch: number; owner: string; kind: Harness; selection: Selection | null; expectedTurnId?: string }>;
type Options = Readonly<{
  composer: RetainedComposer;
  context(action: DraftAction): SendContext;
  files(): readonly DraftRecord[];
  upload(id: string): Promise<ArtifactRef>;
  reference(id: string, type: MessageCommandFor<Harness>['type']): OriginalReceiptReference;
  submit(reference: OriginalReceiptReference, command: MessageCommandFor<Harness>): OperationHandle;
  changed(): void;
}>;
type Job = { action: DraftAction; capture: ComposerCapture; context: SendContext; invalidated: boolean; admitted?: () => void; result: Promise<OperationHandle> };
const idle: SendPreparationSnapshot = Object.freeze({ state: 'idle' });

/** One retained authoring slot. SessionWorkspace owns the one handoff and all
 * receipts. An async race cannot change a captured Send/Steer/Queue intent. */
export class SendPreparation {
  readonly #options: Options; #job: Job | undefined; #snapshot: SendPreparationSnapshot = idle; #closed = false;
  constructor(options: Options) { this.#options = options; }
  getSnapshot(): SendPreparationSnapshot { return this.#snapshot; }
  #publish(value: SendPreparationSnapshot): void { this.#snapshot = Object.freeze(value); if (!this.#closed) this.#options.changed(); }
  invalidate(): void { if (this.#job) this.#job.invalidated = true; }
  close(): Promise<void> | undefined {
    this.#closed = true; this.invalidate(); this.#snapshot = idle;
    return this.#job?.result.then(() => {}, () => {});
  }
  start(action: DraftAction = 'send', admitted?: () => void): Promise<OperationHandle> {
    if (this.#closed) throw new FileError('CLOSED');
    if (!['send', 'steer', 'queue'].includes(action)) throw new FileError('INVALID');
    const capture = this.#options.composer.capture();
    if (this.#job) {
      if (this.#job.action !== action || this.#job.capture.edit !== capture.edit || this.#job.capture.value !== capture.value) throw new FileError('BUSY');
      return this.#job.result;
    }
    const context = this.#options.context(action);
    // A crash after protection/handoff but before consume must not mint a new
    // original for the same retained edit. Restored references are read-only.
    if (this.#options.composer.getSnapshot().originals.some(value => value.edit === capture.edit)) throw new FileError('BUSY', 'Check the saved original before submitting this draft again');
    if ((!capture.value.text.trim() && !capture.value.fileIds.length) || capture.value.text.length > 8192) throw new FileError('INVALID');
    const job: Job = { action, capture, context, invalidated: false, ...(admitted ? { admitted } : {}), result: Promise.resolve().then(() => this.#prepare(job)) };
    this.#job = job; this.#publish({ state: 'preparing', edit: capture.edit, action });
    void job.result.then(() => this.#finish(job, idle), error => this.#finish(job, { state: 'failed', edit: capture.edit, action, code: error instanceof FileError ? error.code : 'IO' }));
    return job.result;
  }
  #finish(job: Job, state: SendPreparationSnapshot): void { if (this.#job === job) { this.#job = undefined; if (!this.#closed) this.#publish(state); } }
  #current(job: Job): void {
    if (this.#closed) throw new FileError('CLOSED');
    if (this.#job !== job || job.invalidated) throw new FileError('FENCED');
    const current = this.#options.context(job.action);
    if (!sameRun(current.run, job.context.run) || current.epoch !== job.context.epoch || current.owner !== job.context.owner || current.kind !== job.context.kind || current.expectedTurnId !== job.context.expectedTurnId) throw new FileError('FENCED');
  }
  #command(job: Job, artifacts: readonly ArtifactRef[]): MessageCommandFor<Harness> {
    const { action, context, capture } = job, text = capture.value.text;
    if (context.kind === 'codex') {
      const inputs = artifacts.length ? { inputs: { kind: 'codex' as const, items: artifacts.map(artifact => ({ type: 'image' as const, artifact })) } } : {};
      if (action === 'steer') { if (!context.expectedTurnId) throw new FileError('FENCED'); return { type: 'codex.steer', expectedTurnId: context.expectedTurnId, text, ...inputs }; }
      if (action === 'queue') return { type: 'codex.queue.add', text, ...inputs };
      return { type: 'send', text, ...inputs, ...(context.selection?.kind === 'codex' ? { selection: context.selection } : {}) };
    }
    const inputs = artifacts.length ? { inputs: { kind: 'copilot' as const, items: artifacts.map(artifact => ({ type: 'blob' as const, artifact })) } } : {};
    return action === 'steer' ? { type: 'copilot.steer', text, ...inputs } : { type: 'send', text, ...inputs, ...(action === 'send' && context.selection?.kind === 'copilot' ? { selection: context.selection } : {}) };
  }
  async #prepare(job: Job): Promise<OperationHandle> {
    const { composer } = this.#options, { capture, context } = job;
    this.#current(job); await composer.flush(); this.#current(job);
    if (capture.value.fileIds.length > sendInputLimits.items) throw new FileError('INVALID');
    const artifacts: ArtifactRef[] = []; let bytes = 0;
    for (const id of capture.value.fileIds) {
      const record = this.#options.files().find(value => value.manifest.id === id);
      if (!record) throw new FileError('NOT_FOUND');
      bytes += record.blob.size;
      if (record.blob.size > sendInputLimits.artifactBytes || bytes > sendInputLimits.totalBytes) throw new FileError('INVALID');
      if (context.kind === 'codex') { const type = imageType(new Uint8Array(await record.blob.arrayBuffer())); this.#current(job); if (!type || type === 'image/svg+xml') throw new FileError('UNSUPPORTED'); }
      artifacts.push(await this.#options.upload(id)); this.#current(job);
    }
    await composer.flush(); this.#current(job);
    const command = this.#command(job, artifacts), reference = this.#options.reference(crypto.randomUUID(), command.type);
    if (reference.type !== command.type || reference.generation !== context.run.generation || reference.owner !== context.owner || scopeKey(reference.scope) !== scopeKey(context.run.scope)) throw new FileError('FENCED');
    const original = { ...reference, type: command.type, edit: capture.edit }, fileScope: FileScope = { ...context.run.scope, session: context.run.nativeSession };
    let operation: OperationHandle;
    try { await composer.protect(original, fileScope, capture.value.fileIds); this.#current(job); operation = this.#options.submit(reference, command); }
    catch (error) { await composer.forgetUnsent(original); throw error; }
    // Presentation retirement cannot reject or replay an admitted original.
    if (!this.#closed) try { job.admitted?.(); } catch { /* The original remains owned. */ }
    if (!this.#closed) composer.consume(capture);
    void operation.result.catch(() => {}); return operation;
  }
}
