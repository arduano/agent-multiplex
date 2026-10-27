import { SessionError, sameRun, type McpLoginLink, type McpLoginStatus, type RunRef } from '../../v8-session/src/contracts/types.js';
import { copy, id } from '../../v8-session/src/contracts/validation.js';
import { loginLimits, validateLoginLink } from '../../v8-session/src/contracts/mcp-login.js';

export { loginLimits };
type Completion = Readonly<{ loginId: string; success: boolean }>;
export type LoginAttempt = {
  readonly run: RunRef; readonly originalId: string; readonly serverName: string; readonly displayUntil: number;
  status: McpLoginStatus; url?: string; nativeId?: string; early?: Completion;
};
const terminal = (state: McpLoginStatus) => state === 'succeeded' || state === 'failed' || state === 'reused';

/** One controller's finite transient slots, never a mutation/receipt store.
 * Expiry hides a URL; it never cancels native work or makes a slot replayable. */
export class LoginLinks {
  readonly #slots = new Map<string, LoginAttempt>(); #run: RunRef | undefined;
  constructor(readonly now: () => number = Date.now) {}
  reset(run: RunRef): void { this.retire(); this.#run = copy(run); }
  retire(): void { for (const slot of this.#slots.values()) delete slot.url; this.#slots.clear(); this.#run = undefined; }
  begin(run: RunRef, originalId: string, serverName: string): LoginAttempt {
    id(originalId); id(serverName);
    if (!this.#run || !sameRun(this.#run, run)) throw new SessionError('FENCED');
    const previous = this.#slots.get(serverName);
    if (previous && (previous.originalId === originalId || !terminal(previous.status))) throw new SessionError('BUSY');
    if (!previous && this.#slots.size >= loginLimits.servers) throw new SessionError('FULL');
    const slot: LoginAttempt = { run: copy(run), originalId, serverName, status: 'starting', displayUntil: this.now() + loginLimits.displayMs };
    this.#slots.set(serverName, slot); return slot;
  }
  #current(slot: LoginAttempt): boolean { return !!this.#run && sameRun(this.#run, slot.run) && this.#slots.get(slot.serverName) === slot; }
  ready(slot: LoginAttempt, url: unknown, nativeId?: string): void {
    if (!this.#current(slot)) return;
    if (url === undefined) { slot.status = 'reused'; return; }
    validateLoginLink({ state: 'available', status: 'initiated', authorizationUrl: url, expiresInMs: loginLimits.displayMs });
    if (typeof url !== 'string') throw new SessionError('INVALID');
    slot.status = 'initiated'; slot.url = url;
    if (nativeId !== undefined) { id(nativeId); slot.nativeId = nativeId; }
    if (slot.early && slot.early.loginId === nativeId) { const completion = slot.early; delete slot.early; this.complete(slot.run, slot.serverName, completion.loginId, completion.success); }
    if (this.now() >= slot.displayUntil) delete slot.url;
  }
  unknown(slot: LoginAttempt): void { if (this.#current(slot)) { slot.status = 'outcomeUnknown'; delete slot.url; delete slot.early; } }
  complete(run: RunRef, serverName: string, nativeId: string, success: boolean): void {
    id(serverName); id(nativeId);
    const slot = this.#slots.get(serverName);
    if (!slot || !this.#current(slot) || !sameRun(slot.run, run) || terminal(slot.status)) return;
    if (slot.status === 'starting' && !slot.nativeId) { if (!slot.early) slot.early = { loginId: nativeId, success }; return; }
    if (slot.nativeId !== nativeId) return;
    slot.status = success ? 'succeeded' : 'failed'; delete slot.url; delete slot.early;
  }
  lookup(run: RunRef, originalId: string): McpLoginLink {
    if (!this.#run || !sameRun(this.#run, run)) return { state: 'unavailable', reason: 'nativeRetired' };
    const slot = [...this.#slots.values()].find(value => value.originalId === originalId);
    if (!slot) return { state: 'unavailable', reason: 'notRetained' };
    if (this.now() >= slot.displayUntil) { delete slot.url; return { state: 'unavailable', reason: 'displayExpired', status: slot.status }; }
    return slot.status === 'initiated' && slot.url ? { state: 'available', status: 'initiated', authorizationUrl: slot.url, expiresInMs: Math.min(loginLimits.displayMs, Math.max(1, Math.ceil(slot.displayUntil - this.now()))) } : { state: 'unavailable', reason: 'notRetained', status: slot.status };
  }
}
