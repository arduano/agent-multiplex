import { createElement as h } from 'react';
import type { AgentSnapshot, WorkspaceView } from '../../v8-workspace/src/contracts.js';
import type { CodexSelection, CopilotSelection, Selection } from '../../v8-session/src/contracts/types.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
type Props = Readonly<{ view: WorkspaceView; snapshot: Ready; run(work: () => Promise<unknown>): void }>;
const field = (label: string, control: ReturnType<typeof h>) => h('label', {}, label, ' ', control);
const effortText = (value: string | null | undefined) => value === undefined ? 'not reported' : value === null ? 'native default' : value;
const key = (model: string, provider?: string) => JSON.stringify([model, provider ?? null]);

/** Pure renderer of retained intent and observed facts. Catalog reads and
 * native mutations occur only in explicit event handlers. */
export function AgentControls({ view, snapshot, run }: Props) {
  const native = snapshot.session.native;
  if (!native) return null;
  const observed = native.selection, draft: Selection = snapshot.session.draft ?? { kind: snapshot.kind };
  const choices = snapshot.modelCatalog.value?.choices ?? [];
  const available = snapshot.modelCatalog.value?.available === true;
  const offline = !snapshot.session.connected || snapshot.session.stale;
  const controlUnavailable = native.issue === 'ownershipUnconfirmed' || native.issue === 'storageUnavailable';
  const disabled = offline || controlUnavailable || native.phase !== 'running' || !native.interactionsComplete;
  const update = (selection: Selection) => {
    if (snapshot.kind === 'codex' && selection.kind === 'codex') snapshot.actions.setSelectionDraft(selection);
    else if (snapshot.kind === 'copilot' && selection.kind === 'copilot') snapshot.actions.setSelectionDraft(selection);
  };
  const chosen = choices.find(choice => choice.model === (draft.model ?? observed.model) && (snapshot.kind !== 'copilot' || choice.providerId === (draft.kind === 'copilot' ? draft.providerId : undefined) || draft.model === undefined && observed.kind === 'copilot' && choice.providerId === observed.providerId));
  const efforts = chosen?.efforts ?? [];
  const modelValue = draft.model === undefined ? '' : key(draft.model, draft.kind === 'copilot' ? draft.providerId : undefined);
  const knownModel = choices.some(choice => key(choice.model, choice.providerId) === modelValue);
  const model = field('Next Send model', h('select', { id: 'next-model', value: modelValue, disabled: !available, onChange: (event: { currentTarget: HTMLSelectElement }) => {
    const value = event.currentTarget.value;
    if (!value) {
      if (draft.kind === 'codex') { const { model: _, effort: omittedEffort, collaboration: omittedMode, ...rest } = draft; update(rest); }
      else { const { model: _, providerId: omittedProvider, effort: omittedEffort, ...rest } = draft; update(rest); }
      return;
    }
    const choice = choices.find(choice => key(choice.model, choice.providerId) === value); if (!choice) return;
    if (draft.kind === 'codex') {
      const { effort: _, ...rest } = draft;
      update({ ...rest, model: choice.model, ...(draft.collaboration ? { effort: null, collaboration: { ...draft.collaboration, model: choice.model, effort: null } } : {}) });
    } else {
      const { effort: _, providerId: omittedProvider, ...rest } = draft;
      update({ ...rest, model: choice.model, ...(choice.providerId === undefined ? {} : { providerId: choice.providerId }) });
    }
  } }, h('option', { value: '' }, `Keep native model (${observed.model ?? 'not reported'})`),
  ...(modelValue && !knownModel ? [h('option', { key: 'unavailable', value: modelValue, disabled: true }, `${draft.model} (not offered)`)] : []),
  ...choices.map(choice => h('option', { key: key(choice.model, choice.providerId), value: key(choice.model, choice.providerId) }, choice.model + (choice.providerId ? ` (${choice.providerId})` : '')))));
  const effortValue = draft.effort === undefined ? 'keep' : draft.effort === null ? 'default' : `effort:${efforts.indexOf(draft.effort)}`;
  const effort = field('Next Send reasoning', h('select', { id: 'next-effort', value: effortValue, disabled: !available || !chosen, onChange: (event: { currentTarget: HTMLSelectElement }) => {
    const value = event.currentTarget.value;
    if (value === 'keep') {
      if (draft.kind === 'codex' && draft.collaboration) return;
      const { effort: _, ...rest } = draft;
      update(rest); return;
    }
    const effort = value === 'default' ? null : efforts[Number(value.slice(7))]; if (effort === undefined) return;
    update(draft.kind === 'codex' ? { ...draft, effort, ...(draft.collaboration ? { collaboration: { ...draft.collaboration, effort } } : {}) } : { ...draft, effort });
  } }, h('option', { value: 'keep', disabled: draft.kind === 'codex' && !!draft.collaboration }, 'Keep native reasoning'), h('option', { value: 'default' }, 'Native default'),
  ...(draft.effort !== undefined && draft.effort !== null && !efforts.includes(draft.effort) ? [h('option', { key: 'unavailable', value: effortValue, disabled: true }, `${draft.effort} (not offered)`)] : []),
  ...efforts.map((value, index) => h('option', { key: value, value: `effort:${index}` }, value))));
  const concrete = snapshot.kind === 'codex' ? codexControls(snapshot, draft.kind === 'codex' ? draft : { kind: 'codex' }, disabled, run) : copilotControls(snapshot, draft.kind === 'copilot' ? draft : { kind: 'copilot' }, disabled, run);
  return h('details', { id: 'session-controls' }, h('summary', {}, 'Session controls'),
    h('p', { id: 'observed-controls' }, `Observed model: ${observed.model ?? 'not reported'}; reasoning: ${effortText(observed.effort)}. Native activity: ${native.activity}.`),
    ...(controlUnavailable ? [h('p', { key: 'control-loss', id: 'host-control-state', role: 'status' }, 'Host control is unavailable. The agent has not been proved stopped.')] : []),
    h('p', {}, 'Choices below are intent for the next Send. Acknowledgements and observed native settings remain separate.'),
    h('button', { id: 'load-models', disabled: offline || snapshot.modelCatalog.state === 'loading', onClick: () => run(() => view.refreshControls()) }, snapshot.modelCatalog.state === 'loading' ? 'Loading choices…' : 'Load configured model choices'),
    snapshot.modelCatalog.state === 'unavailable' ? h('p', { role: 'status' }, available ? 'Refresh unavailable. Last configured choices remain available for editing your draft.' : 'Model choices are unavailable. The observed value and your draft remain saved.') : null,
    model, effort, concrete,
    h('button', { id: 'reset-selection', onClick: () => snapshot.actions.setSelectionDraft(null) }, 'Keep native settings'));
}

function codexControls(snapshot: Extract<Ready, { kind: 'codex' }>, draft: CodexSelection, disabled: boolean, run: Props['run']) {
  const observed = snapshot.session.native!.selection;
  const access = draft.access ?? (observed.kind === 'codex' ? observed.access : undefined);
  const set = (value: CodexSelection) => snapshot.actions.setSelectionDraft(value);
  const mode = draft.collaboration?.mode ?? 'keep';
  const model = draft.model ?? observed.model;
  const needsMode = !draft.collaboration && (draft.model !== undefined || draft.effort !== undefined) && (observed.kind !== 'codex' || observed.collaboration?.instructions === undefined);
  const unavailableSandbox = access !== undefined && (access.profile !== undefined || access.sandbox !== 'danger-full-access');
  const turnId = snapshot.history.current?.activity.turnId;
  return h('div', { 'aria-label': 'Codex controls' },
    field('Next Send collaboration', h('select', { id: 'next-mode', value: mode, disabled: !model, onChange: (event: { currentTarget: HTMLSelectElement }) => {
      const value = event.currentTarget.value;
      if (value === 'keep') { const { collaboration: _, ...rest } = draft; set(rest); }
      else if (model && (value === 'default' || value === 'plan')) { const effort = draft.effort === undefined ? observed.effort ?? null : draft.effort; set({ ...draft, effort, collaboration: { mode: value, model, effort } }); }
    } }, h('option', { value: 'keep' }, 'Keep native mode'), h('option', { value: 'default' }, 'Default'), h('option', { value: 'plan' }, 'Plan'))),
    needsMode ? h('p', { id: 'codex-mode-hint', role: 'status' }, 'Choose Default or Plan to send your model or reasoning change. The current mode instructions have not been reported.') : null,
    field('Next Send sandbox', h('select', { id: 'next-sandbox', value: access?.profile !== undefined ? 'profile' : access?.sandbox ?? 'danger-full-access', onChange: (event: { currentTarget: HTMLSelectElement }) => {
      const value = event.currentTarget.value;
      if (value === 'danger-full-access') set({ ...draft, access: { approval: access?.approval ?? 'on-request', sandbox: value } });
    } }, ...(access?.profile === undefined ? [] : [h('option', { key: 'profile', value: 'profile', disabled: true }, `Native profile: ${access.profile} (unavailable for Next Send)`)]), h('option', { value: 'danger-full-access' }, 'Full access'), h('option', { value: 'workspace-write', disabled: true }, 'Workspace write (unavailable for Next Send)'), h('option', { value: 'read-only', disabled: true }, 'Read only (unavailable for Next Send)'))),
    unavailableSandbox ? h('p', { id: 'codex-sandbox-unavailable', role: 'status' }, 'This value is preserved. It is unavailable as a new override; keep native settings or choose an available option.') : null,
    field('Next Send approval policy', h('select', { id: 'next-approval', value: access?.approval ?? 'on-request', onChange: (event: { currentTarget: HTMLSelectElement }) => {
      const approval = event.currentTarget.value;
      if (approval === 'on-request' || approval === 'untrusted' || approval === 'never') set({ ...draft, access: access?.profile !== undefined ? { profile: access.profile, approval } : { sandbox: access?.sandbox ?? 'danger-full-access', approval } });
    } }, h('option', { value: 'on-request' }, 'On request'), h('option', { value: 'untrusted' }, 'Untrusted'), h('option', { value: 'never' }, 'Never'))),
    snapshot.actions.setDefaults ? h('button', { disabled, onClick: () => run(() => snapshot.actions.setDefaults!(draft).result) }, 'Apply Codex defaults') : null,
    snapshot.actions.updateTurn && turnId ? h('button', { disabled, onClick: () => run(() => snapshot.actions.updateTurn!(turnId, draft).result) }, 'Update this running turn') : null,
    snapshot.actions.interrupt && turnId ? h('button', { id: 'interrupt-turn', disabled, onClick: () => run(() => snapshot.actions.interrupt!(turnId).result) }, 'Interrupt current turn') : null);
}

function copilotControls(snapshot: Extract<Ready, { kind: 'copilot' }>, draft: CopilotSelection, disabled: boolean, run: Props['run']) {
  const observed = snapshot.session.native!.selection;
  const set = (value: CopilotSelection) => snapshot.actions.setSelectionDraft(value);
  return h('div', { 'aria-label': 'Copilot controls' },
    field('Next Send mode', h('select', { id: 'next-mode', value: draft.mode ?? 'keep', onChange: (event: { currentTarget: HTMLSelectElement }) => {
      const value = event.currentTarget.value;
      if (value === 'keep') { const { mode: _, ...rest } = draft; set(rest); }
      else if (value === 'interactive' || value === 'plan' || value === 'autopilot') set({ ...draft, mode: value });
    } }, h('option', { value: 'keep' }, `Keep native mode (${observed.kind === 'copilot' ? observed.mode ?? 'not reported' : 'not reported'})`), ...['interactive', 'plan', 'autopilot'].map(value => h('option', { key: value, value }, value)))),
    field('Next Send permissions', h('select', { id: 'next-permissions', value: draft.permissions ?? 'keep', onChange: (event: { currentTarget: HTMLSelectElement }) => {
      const value = event.currentTarget.value;
      if (value === 'keep') { const { permissions: _, ...rest } = draft; set(rest); }
      else if (value === 'manual' || value === 'allow-all') set({ ...draft, permissions: value });
    } }, h('option', { value: 'keep' }, `Keep native permissions (${observed.kind === 'copilot' ? observed.permissions ?? 'not reported' : 'not reported'})`), h('option', { value: 'manual' }, 'Manual'), h('option', { value: 'allow-all' }, 'Allow all'))),
    snapshot.actions.setModel && draft.model ? h('button', { id: 'apply-model', disabled, onClick: () => run(() => snapshot.actions.setModel!(draft.model!, { ...(draft.providerId ? { providerId: draft.providerId } : {}), ...(draft.effort === undefined ? {} : { effort: draft.effort }) }).result) }, 'Apply model now') : null,
    snapshot.actions.setMode && draft.mode ? h('button', { id: 'apply-mode', disabled, onClick: () => run(() => snapshot.actions.setMode!(draft.mode!).result) }, 'Apply mode now') : null,
    snapshot.actions.setPermissions && (draft.permissions === 'manual' || draft.permissions === 'allow-all') ? h('button', { id: 'apply-permissions', disabled, onClick: () => run(() => snapshot.actions.setPermissions!(draft.permissions as 'manual' | 'allow-all').result) }, 'Apply permissions now') : null,
    snapshot.actions.abort ? h('button', { id: 'abort-request', disabled, onClick: () => run(() => snapshot.actions.abort!().result) }, 'Abort current request') : null);
}
