import type { CapturedScope, Json, Row, Scope } from '../../v8-history/src/contracts/types.js';
import type { ViewSnapshot } from '../../v8-history/src/client/history-client.js';
import { canonical } from '../../v8-history/src/contracts/validation.js';

export type AgentModelFact = Readonly<{
  source: 'requested' | 'configured' | 'resolvedAtStart' | 'firstDispatched' | 'reportedUsed'; model: string;
}>;
export type AgentSummary = Readonly<{
  scope: Scope; id: string; name?: string; role?: string; path?: string;
  status: 'unknown' | 'running' | 'idle' | 'completed' | 'failed' | 'interrupted' | 'stopped';
  /** A disconnected stream or retained old inventory is display evidence only. */
  lastObserved: boolean; models: readonly AgentModelFact[];
}>;
const string = (value: Json | undefined): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : undefined;
const object = (value: Json | undefined): Readonly<Record<string, Json>> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, Json>> : undefined;
const child = (scope: Scope): boolean => scope.kind === 'codex' ? scope.threadId !== scope.origin.nativeSession : scope.agentId !== null || scope.legacyParentToolCallId !== undefined;
function refers(row: Row, scope: Scope): boolean {
  if (row.kind !== 'delegation' && !(row.kind === 'tool' && (row.native.type === 'subAgentActivity' || row.native.type === 'collabAgentToolCall'))) return false;
  if (scope.kind === 'copilot') return scope.agentId !== null ? row.native.agentId === scope.agentId : row.native.toolCallId === scope.legacyParentToolCallId;
  return row.native.agentThreadId === scope.threadId || (Array.isArray(row.native.receiverThreadIds) && row.native.receiverThreadIds.includes(scope.threadId));
}
function status(row: Row | undefined, scope: Scope): AgentSummary['status'] {
  if (!row) return 'unknown';
  if (scope.kind === 'codex') {
    const activity = row.native.activityKind;
    if (activity === 'started') return 'running'; // Parent item completion is not child completion.
    if (activity === 'completed') return 'completed';
    if (activity === 'interrupted') return 'interrupted';
    const state = object(object(row.native.agentsStates)?.[scope.threadId]);
    const native = state?.status;
    if (native === 'running' || native === 'pendingInit') return 'running';
    if (native === 'completed') return 'completed';
    if (native === 'errored') return 'failed';
    if (native === 'interrupted') return 'interrupted';
    if (native === 'shutdown') return 'stopped';
    return 'unknown';
  }
  return row.lifecycle === 'unknown' ? 'unknown' : row.lifecycle;
}

/** No inventory, row or model authority is created here. Select the most recent
 * invocation in retained native order: an old reused-agent completion cannot
 * supply the newer invocation's state/model. No body reads or parent defaults. */
export function agentSummaries(inventory: readonly CapturedScope[], history: ViewSnapshot, observation: Readonly<{ current: boolean; stopped: boolean; live: boolean }>): readonly AgentSummary[] {
  return Object.freeze(inventory.filter(value => child(value.scope)).map(entry => {
    const scope = entry.scope, origin = canonical(scope.origin);
    const row = history.rows.filter(row => refers(row, scope) && history.origins[row.id] && canonical(history.origins[row.id]!.scope.origin) === origin).at(-1);
    const facts = entry.native;
    // Live Copilot facts project the exact current task even for nested agents.
    // Retained rows remain a fallback for a metadata-only exception inventory.
    const native: Readonly<Record<string, Json>> = facts?.invocation ? facts : row?.native ?? {}, models: AgentModelFact[] = [];
    const model = (source: AgentModelFact['source'], value: Json | undefined) => { const name = string(value); if (name) models.push(Object.freeze({ source, model: name })); };
    if (scope.kind === 'codex') {
      model('configured', facts?.configuredModel);
      model(native.type === 'subAgentActivity' ? 'resolvedAtStart' : 'requested', native.model);
    } else {
      model('requested', native.requestedModel); model('configured', native.configuredModel ?? facts?.configuredModel);
      model('resolvedAtStart', native.startedModel); model('firstDispatched', native.firstDispatchedModel); model('reportedUsed', native.reportedUsedModel);
    }
    const name = facts?.nickname ?? facts?.name ?? string(native.agentDisplayName) ?? string(native.agentName);
    const role = facts?.role, path = facts?.path ?? string(native.agentPath);
    let state = facts?.lifecycle ?? status(row, scope);
    if (state === 'unknown' && facts?.status === 'active') state = 'running';
    if (state === 'unknown' && facts?.status === 'idle') state = 'idle';
    if (facts?.status === 'systemError') state = 'failed';
    if (observation.stopped && (state === 'running' || state === 'idle' || state === 'unknown')) state = 'stopped';
    const prior = !facts?.invocation && row ? history.origins[row.id]?.generation !== history.current?.generation : false;
    return Object.freeze({ scope, id: scope.kind === 'codex' ? scope.threadId : scope.agentId ?? scope.legacyParentToolCallId!,
      ...(name ? { name } : {}), ...(role ? { role } : {}), ...(path ? { path } : {}), status: state,
      lastObserved: !observation.current || !observation.live || prior, models: Object.freeze(models) });
  }));
}
