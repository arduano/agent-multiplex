import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
/** Observations only. A retained next-Send choice never becomes this label. */
export function observedSettingsSummary(snapshot: Ready): string {
  const observed = snapshot.session.native?.selection;
  if (!observed) return 'Settings not reported';
  const choices = snapshot.modelCatalog.value?.choices.filter(choice => choice.model === observed.model &&
    (observed.kind !== 'copilot' || choice.providerId === observed.providerId)) ?? [];
  const model = (choices.length === 1 ? choices[0]?.displayName : undefined) ?? observed.model ?? 'Model not reported';
  const mode = observed.kind === 'codex' ? observed.collaboration?.mode : observed.mode;
  const modeText = mode === 'default' ? 'Agent' : mode === 'plan' ? 'Plan' : mode ?? 'Mode not reported';
  const effort = observed.effort === undefined ? 'Reasoning not reported' : observed.effort === null ? 'Native default reasoning' : observed.effort;
  return `${snapshot.session.stale ? 'Last observed: ' : ''}${model} · ${modeText} · ${effort}`;
}
