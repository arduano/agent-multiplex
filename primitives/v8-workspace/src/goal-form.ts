import { SessionError, type Goal } from '../../v8-session/src/contracts/types.js';
import type { OperationHandle } from '../../v8-session/src/client/workspace.js';

export type GoalFormFields = Readonly<{ objective: string; budget: string }>;
export type GoalFormSnapshot = GoalFormFields & Readonly<{ editing: boolean; saving: boolean }>;
export type GoalEditor = Readonly<{ open(): void; edit(value: Partial<GoalFormFields>): void; cancel(): void; save(): OperationHandle }>;
export function goalBudget(value: string): number | null {
  const input = value.trim(); if (!input) return null;
  const number = Number(input);
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(number) || number <= 0) throw new SessionError('INVALID', 'Enter a positive whole token budget, or leave it empty for the native default');
  return number;
}

/** Retained editor intent only. Native goals and action outcomes stay with the
 * existing SessionWorkspace; updates never overwrite a form being edited. */
export class GoalForm {
  #snapshot: GoalFormSnapshot = Object.freeze({ objective: '', budget: '', editing: false, saving: false });
  #pending: OperationHandle | undefined; #closed = false;
  constructor(readonly changed: () => void) {}
  getSnapshot(): GoalFormSnapshot { return this.#snapshot; }
  #publish(value: GoalFormSnapshot): void { this.#snapshot = Object.freeze(value); if (!this.#closed) this.changed(); }
  open(goal: Goal | null): void {
    if (this.#closed) throw new SessionError('CLOSED');
    if (this.#snapshot.editing) return;
    this.#publish({ objective: goal?.objective ?? '', budget: goal?.tokenBudget?.toString() ?? '', editing: true, saving: !!this.#pending });
  }
  edit(value: Partial<GoalFormFields>): void {
    if (this.#closed) throw new SessionError('CLOSED');
    if (!this.#snapshot.editing || Object.keys(value).some(key => key !== 'objective' && key !== 'budget')) throw new SessionError('INVALID');
    const next = { ...this.#snapshot, ...value };
    if (typeof next.objective !== 'string' || next.objective.length > 4000 || typeof next.budget !== 'string' || next.budget.length > 32) throw new SessionError('INVALID');
    this.#publish(next);
  }
  cancel(): void {
    if (this.#closed) throw new SessionError('CLOSED');
    if (this.#pending) throw new SessionError('BUSY');
    this.#publish({ objective: '', budget: '', editing: false, saving: false });
  }
  save(submit: (patch: Readonly<{ objective: string; tokenBudget: number | null }>) => OperationHandle, current: () => boolean): OperationHandle {
    if (this.#closed) throw new SessionError('CLOSED');
    if (this.#pending) return this.#pending;
    const capture = this.#snapshot;
    if (!capture.editing || !capture.objective.trim()) throw new SessionError('INVALID');
    const operation = submit({ objective: capture.objective.trim(), tokenBudget: goalBudget(capture.budget) });
    this.#pending = operation; this.#publish({ ...capture, saving: true });
    void operation.result.then(receipt => {
      if (!this.#closed && current() && receipt.state === 'acknowledged' && ['applied', 'acknowledged'].includes(receipt.outcome?.status ?? 'acknowledged') && this.#snapshot.objective === capture.objective && this.#snapshot.budget === capture.budget)
        this.#publish({ ...this.#snapshot, editing: false });
    }, () => {}).finally(() => { if (this.#pending === operation) { this.#pending = undefined; if (!this.#closed) this.#publish({ ...this.#snapshot, saving: false }); } });
    return operation;
  }
  close(): void { this.#closed = true; this.#snapshot = Object.freeze({ objective: '', budget: '', editing: false, saving: false }); }
}
