import { FileError, scopeKey, type FileScope } from '../../v8-files/src/contracts/types.js';
import { composerKey, composerScope, composerValue, composerOriginal, type ComposerOriginal, type ComposerRecord, type ComposerScope, type ComposerValue, type DraftPersistence } from '../../v8-files/src/client/persistence.js';

export type ComposerCapture = Readonly<{ edit: number; value: ComposerValue }>;
export type ComposerSnapshot = Readonly<{
  value: ComposerValue; edit: number; revision: number;
  state: 'loading' | 'saved' | 'saving' | 'dirty' | 'unavailable' | 'disposed';
  originals: readonly ComposerOriginal[]; error: string | null;
}>;
/** One retained composer, stored in the existing bounded Blob database. It owns
 * no Submit capability; original protection and lookup are inert metadata. */
export class RetainedComposer {
  readonly #scope: ComposerScope; readonly #persistence: DraftPersistence;
  readonly #restore: ((references: readonly ComposerOriginal[]) => void) | undefined;
  readonly #listeners = new Set<() => void>();
  #record: ComposerRecord; #value: ComposerValue = composerValue({ text: '', fileIds: [] });
  #edit = 0; #loaded = false; #closed = false; #dirty = false; #mutation = false;
  #loading: Promise<void> | undefined; #writing: Promise<void> | undefined; #error: string | null = null;
  #snapshot: ComposerSnapshot;
  constructor(options: Readonly<{ scope: ComposerScope; persistence: DraftPersistence; restoreOriginals?: (references: readonly ComposerOriginal[]) => void }>) {
    this.#scope = composerScope(options.scope); this.#persistence = options.persistence; this.#restore = options.restoreOriginals;
    this.#record = Object.freeze({ key: composerKey(this.#scope), scope: this.#scope, value: this.#value, revision: 0, edit: 0, originals: Object.freeze([]) });
    this.#snapshot = this.#view();
  }
  #open(): void { if (this.#closed) throw new FileError('CLOSED'); }
  #view(): ComposerSnapshot {
    return Object.freeze({ value: this.#closed ? composerValue({ text: '', fileIds: [] }) : this.#value, edit: this.#edit, revision: this.#record.revision,
      state: this.#closed ? 'disposed' : this.#error ? 'unavailable' : !this.#loaded ? 'loading' : this.#writing || this.#mutation ? 'saving' : this.#dirty ? 'dirty' : 'saved',
      originals: Object.freeze(this.#closed ? [] : this.#record.originals.map(value => value.reference)), error: this.#closed ? null : this.#error });
  }
  #changed(): void { this.#snapshot = this.#view(); for (const listener of [...this.#listeners]) try { listener(); } catch { /* Observation cannot reject a committed browser write. */ } }
  getSnapshot = (): ComposerSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => { if (this.#closed) return () => {}; this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  load(): Promise<void> {
    this.#open(); return this.#loading ??= (async () => {
      try {
        if (!this.#persistence.getComposer || !this.#persistence.putComposer || !this.#persistence.original) throw new FileError('UNSUPPORTED', 'This browser store does not retain composers');
        const record = await this.#persistence.getComposer(this.#scope); this.#open();
        if (record) { this.#record = record; this.#value = record.value; this.#edit = record.edit; this.#restore?.(record.originals.map(value => { const { edit: _capturedEdit, ...reference } = value.reference; return reference; })); }
        this.#loaded = true; this.#changed();
      } catch (error) { if (!this.#closed) { this.#error = error instanceof FileError ? error.code : 'IO'; this.#changed(); } throw error; }
    })();
  }
  edit(value: ComposerValue): void {
    this.#open(); if (!this.#loaded) throw new FileError('BUSY', 'The retained composer is loading');
    this.#value = composerValue(value); this.#edit++; this.#dirty = true; this.#error = null; this.#changed(); this.#start();
  }
  capture(): ComposerCapture { this.#open(); if (!this.#loaded) throw new FileError('BUSY'); return Object.freeze({ edit: this.#edit, value: this.#value }); }
  consume(captured: ComposerCapture): boolean {
    this.#open(); if (captured.edit !== this.#edit || captured.value !== this.#value) return false;
    this.edit({ text: '', fileIds: [] }); return true;
  }
  #start(force = false): void {
    if (this.#closed || this.#writing || !this.#dirty || this.#error || this.#mutation && !force) return;
    const job = this.#save(); this.#writing = job; this.#changed();
    void job.catch(() => {}).finally(() => { if (this.#writing === job) this.#writing = undefined; this.#changed(); this.#start(); });
  }
  async #save(): Promise<void> {
    try {
      // Edits during this write replace the one latest value. They never append
      // another save promise or overwrite the captured original's edit token.
      while (this.#dirty) {
        this.#open(); const edit = this.#edit, value = this.#value;
        const saved = await this.#persistence.putComposer!({ ...this.#record, edit, value }, this.#record.revision); this.#open();
        this.#record = saved; this.#dirty = this.#edit !== edit; this.#error = null; this.#changed();
      }
    } catch (error) { if (!this.#closed) { this.#error = error instanceof FileError ? error.code : 'IO'; this.#changed(); } throw error; }
  }
  async flush(): Promise<void> {
    this.#open(); await this.load(); this.#open();
    // Persist even an untouched empty draft before its first inert original.
    if (this.#record.revision === 0) this.#dirty = true;
    this.#error = null; this.#start(true);
    while (this.#writing) { await this.#writing; this.#open(); }
    if (this.#dirty || this.#error) throw new FileError('IO', 'The composer has not been durably saved');
  }
  async #original(reference: ComposerOriginal, change: 'protect' | 'settle' | 'forget', files?: Readonly<{ scope: FileScope; ids: readonly string[] }>): Promise<void> {
    this.#open(); reference = composerOriginal(reference);
    if (this.#mutation) throw new FileError('BUSY', 'Another exact original persistence operation is pending');
    this.#mutation = true; this.#changed();
    try {
      await this.flush(); this.#open();
      const previous = this.#record;
      const saved = await this.#persistence.original!(this.#scope, previous.revision, reference, change, files); this.#open(); this.#record = saved;
      if (saved.edit !== previous.edit && this.#edit === previous.edit) { this.#edit = saved.edit; this.#value = saved.value; this.#dirty = false; }
    } catch (error) { if (!this.#closed) this.#error = error instanceof FileError ? error.code : 'IO'; throw error; }
    finally { this.#mutation = false; this.#changed(); this.#start(); }
  }
  protect(reference: ComposerOriginal, fileScope: FileScope, fileIds: readonly string[]): Promise<void> { return this.#original(reference, 'protect', { scope: fileScope, ids: fileIds }); }
  /** Only an exact validated terminal receipt (or proven no-dispatch refusal)
   * licenses removal. No timeout, absent receipt or last-seen age does. */
  settle(reference: ComposerOriginal): Promise<void> { return this.#original(reference, 'settle'); }
  async forgetUnsent(reference: ComposerOriginal): Promise<void> {
    if (!this.#closed) return this.#original(reference, 'forget');
    // Only the preparation owner may use this after proving no handover occurred.
    // Closure can race a committed protection whose reply has not arrived. Read
    // its authoritative revision without restoring any private observer state.
    reference = composerOriginal(reference);
    if (scopeKey(reference.scope) !== scopeKey(this.#scope)) throw new FileError('FENCED');
    if (!this.#persistence.getComposer || !this.#persistence.original) throw new FileError('UNSUPPORTED');
    const record = await this.#persistence.getComposer(this.#scope);
    const held = record?.originals.find(value => value.reference.id === reference.id);
    if (!held) return;
    if (JSON.stringify(composerOriginal(held.reference)) !== JSON.stringify(reference)) throw new FileError('CONFLICT');
    await this.#persistence.original(this.#scope, record!.revision, reference, 'forget');
  }
  close(): void { this.#closed = true; this.#value = composerValue({ text: '', fileIds: [] }); this.#record = { ...this.#record, originals: [] }; this.#changed(); this.#listeners.clear(); }
}
