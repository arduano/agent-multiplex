import { createElement as h, useEffect, useState } from 'react';
import { Button, IconButton, Input, Select, Popover, PopoverTrigger, PopoverContent } from './ui/index.js';
import type { AgentSnapshot, WorkspaceView } from '../../v8-workspace/src/contracts.js';
import type { CodexSelection, CopilotSelection, Selection } from '../../v8-session/src/contracts/types.js';
import { observedSettingsSummary } from './settings-summary.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
type Props = Readonly<{ view: WorkspaceView; snapshot: Ready; run(work: () => Promise<unknown>): void }>;
const field = (label: string, control: ReturnType<typeof h>) => h('label', {}, label, ' ', control);
const effortText = (value: string | null | undefined) => value === undefined ? 'not reported' : value === null ? 'native default' : value;
const key = (model: string, provider?: string) => JSON.stringify([model, provider ?? null]);
const needsCodexMode = (snapshot: Extract<Ready, { kind: 'codex' }>, draft: CodexSelection) => !draft.collaboration && (draft.model !== undefined || draft.effort !== undefined) && (snapshot.session.native?.selection.kind !== 'codex' || snapshot.session.native.selection.collaboration?.instructions === undefined);
const modeHint = () => h('p', { className: 'mpx-chat__sr-only', 'data-action': 'codex-mode-hint', role: 'status' }, 'Choose Agent or Plan to apply your model or reasoning change. Current mode instructions have not been reported.');
const permissionNames: Readonly<Record<string, string>> = { 'danger-full-access': 'Full access', 'workspace-write': 'Workspace write', 'read-only': 'Read only' };
const approvalNames: Readonly<Record<string, string>> = { 'on-request': 'On request', untrusted: 'Untrusted', never: 'Never' };
const permissionsLabel = (value: string) => permissionNames[value] ?? value;
const approvalLabel = (value: string) => approvalNames[value] ?? value;

/** Committed views acquire missing model metadata through the existing retained
 * catalog job. Native mutations remain explicit actions. */
export function AgentControls({ view, snapshot, run, compact = false, container = null }: Props & Readonly<{ compact?: boolean; container?: HTMLElement | null }>) {
  const [search, setSearch] = useState(''), [open, setOpen] = useState(false), [advanced, setAdvanced] = useState(false);
  useEffect(() => { setSearch(''); setOpen(false); setAdvanced(false); }, [view, compact]);
  useEffect(() => {
    const current = view.getSnapshot();
    if ((current.kind === 'codex' || current.kind === 'copilot') && current.modelCatalog.state === 'unobserved' && current.access.read && current.session.connected && !current.session.stale && !current.session.requiresRebind && current.session.native?.phase === 'running' && !current.session.native.archive)
      void view.refreshControls().catch(() => { /* The retained catalog exposes its unavailable state. */ });
  }, [view, snapshot.modelCatalog.state, snapshot.access.read, snapshot.session.connected, snapshot.session.stale, snapshot.session.requiresRebind, snapshot.session.native?.phase, snapshot.session.native?.generation]);
  if (!snapshot.session.native) return null;
  const summary = observedSettingsSummary(snapshot);
  const draft = snapshot.session.draft, pending = draft && Object.keys(draft).some(key => key !== 'kind');
  const advancedSettings = h(Popover, { open: advanced, onOpenChange: setAdvanced },
    h(PopoverTrigger, { asChild: true }, h(IconButton, { type: 'button', variant: 'ghost', label: 'Advanced agent settings' }, h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, h('path', { d: 'M4 7h16M4 17h16M9 4v6m6 4v6' })))),
    h(PopoverContent, { container, className: 'mpx-chat__agent-settings-panel', side: 'top', align: 'start', 'aria-label': 'Advanced agent settings' },
      h('header', { className: 'mpx-chat__panel-heading' }, h('h3', null, 'Agent settings'), h('p', null, 'Permissions and native controls')),
      h(AgentSettingsContent, { view, snapshot, run, surface: 'advanced' })));
  return h('div', { className: 'mpx-chat__inline-settings', 'data-layout': compact ? 'compact' : 'direct' },
    h(Popover, { open, onOpenChange: setOpen },
      h(PopoverTrigger, { asChild: true }, h(Button, { type: 'button', variant: 'ghost', 'data-action': 'session-controls', className: 'mpx-chat__settings-trigger',
        'aria-label': compact ? 'Agent settings' : 'Choose model', 'aria-description': summary, title: summary },
        h('span', null, compact ? 'Settings' : draft?.model ?? snapshot.session.native.selection.model ?? 'Choose model'),
        pending ? h('small', { className: 'mpx-chat__pending-settings' }, snapshot.session.native.activity === 'working' ? 'Next turn' : 'Next Send') : null)),
      h(PopoverContent, { container, className: 'mpx-chat__agent-settings-panel', side: 'top', align: 'start', 'aria-label': 'Agent settings' },
        h('header', { className: 'mpx-chat__panel-heading' }, h('h3', null, compact ? 'Agent settings' : 'Model')),
        h(AgentSettingsContent, { view, snapshot, run, search, onSearch: setSearch, surface: 'model' }),
        compact ? h(AgentSettingsContent, { view, snapshot, run, surface: 'inline' }) : null,
        compact ? h('details', { className: 'mpx-chat__advanced-settings' }, h('summary', null, 'Advanced settings'), h(AgentSettingsContent, { view, snapshot, run, surface: 'advanced' })) : null)),
    compact ? null : h(AgentSettingsContent, { view, snapshot, run, surface: 'inline' }),
    compact ? null : advancedSettings,
    snapshot.kind === 'codex' && draft?.kind === 'codex' && needsCodexMode(snapshot, draft) ? modeHint() : null);
}

/** One pure control tree; local search is presentation, all intent stays in the
 * supplied retained view. Exported here for the existing intent-owner oracle. */
export function AgentSettingsContent({ view, snapshot, run, search = '', onSearch, surface = 'all' }: Props & Readonly<{ search?: string; onSearch?(value: string): void; surface?: 'all' | 'model' | 'inline' | 'advanced' }>) {
  const native = snapshot.session.native;
  if (!native) return null;
  const observed = native.selection, draft: Selection = snapshot.session.draft ?? { kind: snapshot.kind };
  const next = native.activity === 'working' ? 'Next turn' : 'Next Send';
  const offered = snapshot.modelCatalog.value?.choices ?? [];
  const modelCounts = new Map<string, number>();
  if (snapshot.kind === 'codex') for (const choice of offered) modelCounts.set(choice.model, (modelCounts.get(choice.model) ?? 0) + 1);
  // Codex's Host already selects the provider. Its model-only writes require
  // exactly one choice, just like native preflight; never merge effort lists.
  const choices = snapshot.kind === 'codex' ? offered.filter(choice => modelCounts.get(choice.model) === 1) : offered;
  const query = search.trim().toLocaleLowerCase();
  const matching = choices.filter(choice => !query || [choice.model, choice.displayName, choice.description].some(value => value?.toLocaleLowerCase().includes(query)));
  const modelKey = (model: string, provider?: string) => key(model, snapshot.kind === 'codex' ? undefined : provider);
  const available = snapshot.modelCatalog.value?.available === true;
  const loading = snapshot.modelCatalog.state === 'loading';
  const offline = !snapshot.access.read || !snapshot.session.connected || snapshot.session.stale;
  const controlUnavailable = native.issue === 'ownershipUnconfirmed' || native.issue === 'storageUnavailable';
  const disabled = !snapshot.access.control || offline || controlUnavailable || native.phase !== 'running' || !native.interactionsComplete;
  const update = (selection: Selection) => {
    if (snapshot.kind === 'codex' && selection.kind === 'codex') snapshot.actions.setSelectionDraft(selection);
    else if (snapshot.kind === 'copilot' && selection.kind === 'copilot') snapshot.actions.setSelectionDraft(selection);
  };
  const chosen = choices.find(choice => choice.model === (draft.model ?? observed.model) && (snapshot.kind !== 'copilot' || choice.providerId === (draft.kind === 'copilot' ? draft.providerId : undefined) || draft.model === undefined && observed.kind === 'copilot' && choice.providerId === observed.providerId));
  const efforts = chosen?.efforts ?? [];
  const modelValue = draft.model === undefined ? '' : modelKey(draft.model, draft.kind === 'copilot' ? draft.providerId : undefined);
  const knownModel = choices.some(choice => modelKey(choice.model, choice.providerId) === modelValue);
  const model = field(`${next} model`, h(Select, { 'data-action': 'next-model', 'aria-label': `${next} model`, value: modelValue, disabled: !available, onValueChange: (value: string) => {
    if (!value) {
      if (draft.kind === 'codex') {
        if (draft.collaboration && !observed.model) return;
        const { model: _, ...rest } = draft;
        update({ ...rest, ...(draft.collaboration && observed.model ? { collaboration: { ...draft.collaboration, model: observed.model } } : {}) });
      } else { const { model: _, providerId: omittedProvider, ...rest } = draft; update(rest); }
      return;
    }
    const choice = choices.find(choice => modelKey(choice.model, choice.providerId) === value); if (!choice) return;
    const effort = draft.effort === undefined ? observed.effort : draft.effort;
    if (draft.kind === 'codex') {
      update({ ...draft, model: choice.model, ...(effort === undefined ? {} : { effort }), ...(draft.collaboration ? { collaboration: { ...draft.collaboration, model: choice.model } } : {}) });
    } else {
      const { providerId: omittedProvider, ...rest } = draft;
      update({ ...rest, model: choice.model, ...(effort === undefined ? {} : { effort }), ...(choice.providerId === undefined ? {} : { providerId: choice.providerId }) });
    }
  }, options: [{ value: '', label: `Keep native model (${observed.model ?? 'not reported'})`, disabled: draft.kind === 'codex' && !!draft.collaboration && !observed.model },
    ...(modelValue && !knownModel ? [{ value: modelValue, disabled: true, label: `${draft.model}${available ? ' (not offered)' : ''}` }] : []),
    ...choices.filter(choice => matching.includes(choice) || modelKey(choice.model, choice.providerId) === modelValue).map(choice => ({ value: modelKey(choice.model, choice.providerId),
      label: (choice.displayName ? `${choice.displayName} · ${choice.model}` : choice.model) + (choice.providerId ? ` (${choice.providerId})` : '') }))] }));
  const effortValue = draft.effort === undefined ? 'keep' : draft.effort === null ? 'default' : `effort:${efforts.indexOf(draft.effort)}`;
  const effort = field('Reasoning', h(Select, { 'data-action': 'next-effort', 'aria-label': `${next} reasoning`, 'aria-busy': loading, title: `${next} reasoning; current native value: ${effortText(observed.effort)}${loading ? '; loading choices' : !available ? '; choices unavailable' : ''}`, value: effortValue, disabled: !available || !chosen, onValueChange: (value: string) => {
    if (value === 'keep') {
      if (draft.kind === 'codex' && draft.collaboration) return;
      const { effort: _, ...rest } = draft;
      update(rest); return;
    }
    const effort = value === 'default' ? null : efforts[Number(value.slice(7))]; if (effort === undefined) return;
    update(draft.kind === 'codex' ? { ...draft, effort, ...(draft.collaboration ? { collaboration: { ...draft.collaboration, effort } } : {}) } : { ...draft, effort });
  }, options: [{ value: 'keep', disabled: draft.kind === 'codex' && !!draft.collaboration, label: observed.effort === undefined ? 'Reasoning unknown' : observed.effort === null ? 'Default' : observed.effort },
    { value: 'default', label: chosen?.defaultEffort ? `Native default (${chosen.defaultEffort})` : 'Native default' },
    ...(draft.effort !== undefined && draft.effort !== null && !efforts.includes(draft.effort) ? [{ value: effortValue, disabled: true, label: `${draft.effort}${available ? ' (not offered)' : ''}` }] : []),
    ...efforts.map((value, index) => ({ value: `effort:${index}`, label: value }))] }));
  const ambiguousModel = snapshot.kind === 'codex' && (modelCounts.get(draft.model ?? observed.model ?? '') ?? 0) > 1;
  const selectionUnavailable = draft.kind === 'codex' && (draft.model !== undefined || draft.effort !== undefined || draft.collaboration !== undefined) && !chosen;
  const concrete = snapshot.kind === 'codex' ? codexControls(snapshot, draft.kind === 'codex' ? draft : { kind: 'codex' }, disabled, run, selectionUnavailable) : copilotControls(snapshot, draft.kind === 'copilot' ? draft : { kind: 'copilot' }, disabled, run);
  if (surface === 'inline') return h('div', { className: 'mpx-chat__inline-fields' },
    snapshot.kind === 'codex' ? codexControls(snapshot, draft.kind === 'codex' ? draft : { kind: 'codex' }, disabled, run, selectionUnavailable, 'mode') : copilotControls(snapshot, draft.kind === 'copilot' ? draft : { kind: 'copilot' }, disabled, run, 'mode'),
    effort);
  if (surface === 'advanced') return h('div', { className: 'mpx-chat__settings-content' }, snapshot.kind === 'codex' ? codexControls(snapshot, draft.kind === 'codex' ? draft : { kind: 'codex' }, disabled, run, selectionUnavailable, 'advanced') : copilotControls(snapshot, draft.kind === 'copilot' ? draft : { kind: 'copilot' }, disabled, run, 'advanced'), h('footer', { className: 'mpx-chat__panel-actions' }, h(Button, { variant: 'ghost', 'data-action': 'reset-selection', onClick: () => snapshot.actions.setSelectionDraft(null) }, 'Keep native settings')));
  return h('div', { className: 'mpx-chat__settings-content' },
    h('dl', { className: 'mpx-chat__settings-facts', 'data-action': 'observed-controls' }, h('dt', null, 'Current model'), h('dd', null, observed.model ?? 'Not reported'), h('dt', null, 'Reasoning'), h('dd', null, effortText(observed.effort))),
    ...(controlUnavailable ? [h('p', { key: 'control-loss', 'data-action': 'host-control-state', role: 'status' }, 'Host control is unavailable. The agent has not been proved stopped.')] : []),
    h('p', { className: 'mpx-chat__muted' }, native.activity === 'working' ? 'Changes apply to your next turn. Steering and queued messages keep the current native settings.' : 'Changes apply to your next Send. Observed settings update only when the native agent reports them.'),
    loading ? h('p', { role: 'status' }, 'Loading the Host’s model and reasoning choices…') : snapshot.modelCatalog.state === 'unavailable' ? h('div', null, h('p', { role: 'status' }, available ? 'Refresh unavailable. Last configured choices remain available for editing your draft.' : 'Model choices are unavailable. The observed value and your draft remain saved.'), h(Button, { variant: 'outline', 'data-action': 'retry-models', disabled: offline, onClick: () => run(() => view.refreshControls()) }, 'Retry model choices')) : offline ? h('p', { role: 'status' }, 'Reconnect to load the Host’s model and reasoning choices.') : null,
    ambiguousModel ? h('p', { 'data-action': 'codex-model-ambiguous', role: 'status' }, 'This Codex Host reports more than one choice for the same model. Choose another offered model or keep native settings.') : null,
    field('Find a model', h(Input, { type: 'search', 'data-action': 'find-model', value: search, maxLength: 256, placeholder: 'Name, model ID or description', onChange: (event: { currentTarget: HTMLInputElement }) => onSearch?.(event.currentTarget.value) })),
    query && !matching.length ? h('p', { role: 'status', 'data-action': 'model-search-empty' }, 'No matching models. Your selected intent is retained.') : null,
    model,
    chosen?.description ? h('p', { className: 'mpx-chat__agent-settings-description', 'data-action': 'model-description' }, chosen.description) : null,
    chosen?.inputModalities ? h('p', { 'data-action': 'model-modalities' }, `Native input types: ${chosen.inputModalities.length ? chosen.inputModalities.join(', ') : 'none reported'}. This does not confirm attachment delivery or interpretation.`) : null,
    surface === 'all' ? effort : null, surface === 'all' ? concrete : null,
    h('footer', { className: 'mpx-chat__panel-actions' }, h(Button, { variant: 'ghost', 'data-action': 'reset-selection', onClick: () => snapshot.actions.setSelectionDraft(null) }, 'Keep native settings')));
}

function codexControls(snapshot: Extract<Ready, { kind: 'codex' }>, draft: CodexSelection, disabled: boolean, run: Props['run'], selectionUnavailable: boolean, part: 'all' | 'mode' | 'advanced' = 'all') {
  const observed = snapshot.session.native!.selection;
  const access = draft.access ?? (observed.kind === 'codex' ? observed.access : undefined);
  const set = (value: CodexSelection) => snapshot.actions.setSelectionDraft(value);
  const mode = draft.collaboration?.mode ?? 'keep';
  const model = draft.model ?? observed.model;
  const needsMode = needsCodexMode(snapshot, draft);
  const observedAccess = observed.kind === 'codex' ? observed.access : undefined;
  const profileIds = [...new Set([observedAccess?.profile, draft.access?.profile].filter((value): value is string => value !== undefined))];
  const accessValue = draft.access === undefined ? 'keep' : draft.access.profile === undefined ? draft.access.sandbox : `profile:${draft.access.profile}`;
  const turnId = snapshot.session.native?.activity === 'working' || snapshot.session.native?.activity === 'waiting' ? snapshot.history.current?.activity.turnId : undefined;
  const turnSelection: CodexSelection = { kind: 'codex', ...(draft.model ? { model: draft.model } : {}),
    ...(typeof draft.effort === 'string' ? { effort: draft.effort } : {}) };
  const hasTurnSelection = turnSelection.model !== undefined || turnSelection.effort !== undefined;
  const modeControl = field(needsMode ? 'Choose Agent / Plan' : 'Mode', h(Select, { 'data-action': 'next-mode', 'aria-label': snapshot.session.native?.activity === 'working' ? 'Next turn mode' : 'Next Send mode', 'aria-description': needsMode ? 'Choose Agent or Plan to apply model or reasoning changes. Native mode instructions are not reported.' : undefined, value: mode, disabled: !model, onValueChange: (value: string) => {
      if (value === 'keep') { const { collaboration: _, ...rest } = draft; set(rest); }
      else if (model && (value === 'default' || value === 'plan')) { const effort = draft.effort === undefined ? observed.effort ?? null : draft.effort; set({ ...draft, effort, collaboration: { mode: value, model, effort } }); }
    }, options: [{ value: 'keep', label: observed.kind === 'codex' && observed.collaboration ? observed.collaboration.mode === 'default' ? 'Agent (current)' : 'Plan (current)' : 'Mode unknown' }, { value: 'default', label: 'Agent' }, { value: 'plan', label: 'Plan' }] }));
  if (part === 'mode') return modeControl;
  return h('div', { className: 'mpx-chat__settings-content', 'aria-label': 'Codex controls' },
    part === 'all' ? modeControl : null,
    h('dl', { className: 'mpx-chat__settings-facts', 'data-action': 'observed-codex-access' },
      h('dt', null, 'Current permissions'), h('dd', null, observedAccess ? observedAccess.profile === undefined ? permissionsLabel(observedAccess.sandbox) : `profile ${observedAccess.profile}` : 'Not reported'),
      h('dt', null, 'Approval requests'), h('dd', null, observedAccess ? approvalLabel(observedAccess.approval) : 'Not reported')),
    needsMode && part === 'all' ? modeHint() : null,
    field('Next Send permissions', h(Select, { 'data-action': 'next-sandbox', 'aria-label': 'Next Send permissions', value: accessValue, onValueChange: (value: string) => {
      if (value === 'keep') { const { access: _, ...rest } = draft; set(rest); }
      else if (value === 'danger-full-access' || value === 'workspace-write' || value === 'read-only') set({ ...draft, access: { approval: access?.approval ?? 'on-request', sandbox: value } });
      else if (observedAccess?.profile !== undefined && value === `profile:${observedAccess.profile}`) set({ ...draft, access: { approval: access?.approval ?? observedAccess.approval, profile: observedAccess.profile } });
    }, options: [{ value: 'keep', label: 'Keep native permissions' }, { value: 'danger-full-access', label: 'Full access' }, { value: 'workspace-write', label: 'Workspace write' }, { value: 'read-only', label: 'Read only' },
      ...profileIds.map(profile => ({ value: `profile:${profile}`, disabled: profile !== observedAccess?.profile, label: `Native profile: ${profile}${profile !== observedAccess?.profile ? ' (retained intent)' : ''}` }))] })),
    field('Next Send approval policy', h(Select, { 'data-action': 'next-approval', 'aria-label': 'Next Send approval policy', value: access?.approval ?? 'unknown', disabled: access === undefined, onValueChange: (approval: string) => {
      if (access && (approval === 'on-request' || approval === 'untrusted' || approval === 'never')) set({ ...draft, access: access.profile !== undefined ? { profile: access.profile, approval } : { sandbox: access.sandbox, approval } });
    }, options: [...(access === undefined ? [{ value: 'unknown', disabled: true, label: 'Native policy not reported; choose permissions first' }] : []), { value: 'on-request', label: 'On request' }, { value: 'untrusted', label: 'Untrusted' }, { value: 'never', label: 'Never' }] })),
    snapshot.actions.setDefaults ? h('div', { className: 'mpx-chat__panel-actions' }, h(Button, { 'data-action': 'apply-defaults', disabled: disabled || needsMode || selectionUnavailable, onClick: () => run(() => snapshot.actions.setDefaults!(draft).result) }, 'Apply Codex defaults')) : null,
    turnId && (snapshot.actions.updateTurn || snapshot.actions.interrupt) ? h('section', { className: 'mpx-chat__settings-turn' }, h('h4', null, 'Current turn'),
      h('div', { className: 'mpx-chat__panel-actions' },
        snapshot.actions.updateTurn ? h(Button, { variant: 'outline', 'data-action': 'update-turn', disabled: disabled || !hasTurnSelection || selectionUnavailable, onClick: () => run(() => snapshot.actions.updateTurn!(turnId, turnSelection).result) }, 'Update this running turn') : null,
        snapshot.actions.interrupt ? h(Button, { variant: 'destructive', 'data-action': 'interrupt-turn', disabled, onClick: () => run(() => snapshot.actions.interrupt!(turnId).result) }, 'Interrupt current turn') : null)) : null);
}

function copilotControls(snapshot: Extract<Ready, { kind: 'copilot' }>, draft: CopilotSelection, disabled: boolean, run: Props['run'], part: 'all' | 'mode' | 'advanced' = 'all') {
  const observed = snapshot.session.native!.selection;
  const set = (value: CopilotSelection) => snapshot.actions.setSelectionDraft(value);
  const modeControl = field('Mode', h(Select, { 'data-action': 'next-mode', 'aria-label': snapshot.session.native?.activity === 'working' ? 'Next turn mode' : 'Next Send mode', value: draft.mode ?? 'keep', onValueChange: (value: string) => {
      if (value === 'keep') { const { mode: _, ...rest } = draft; set(rest); }
      else if (value === 'interactive' || value === 'plan' || value === 'autopilot') set({ ...draft, mode: value });
    }, options: [{ value: 'keep', label: observed.kind === 'copilot' ? observed.mode ?? 'Mode unknown' : 'Mode unknown' }, ...['interactive', 'plan', 'autopilot'].map(value => ({ value, label: value }))] }));
  if (part === 'mode') return modeControl;
  return h('div', { className: 'mpx-chat__settings-content', 'aria-label': 'Copilot controls' }, part === 'all' ? modeControl : null,
    field('Next Send permissions', h(Select, { 'data-action': 'next-permissions', 'aria-label': 'Next Send permissions', value: draft.permissions ?? 'keep', onValueChange: (value: string) => {
      if (value === 'keep') { const { permissions: _, ...rest } = draft; set(rest); }
      else if (value === 'manual' || value === 'allow-all') set({ ...draft, permissions: value });
    }, options: [{ value: 'keep', label: `Keep native permissions (${observed.kind === 'copilot' ? observed.permissions ?? 'not reported' : 'not reported'})` }, { value: 'manual', label: 'Manual' }, { value: 'allow-all', label: 'Allow all' }] })),
    h('div', { className: 'mpx-chat__panel-actions' },
      snapshot.actions.setModel && draft.model ? h(Button, { variant: 'outline', 'data-action': 'apply-model', disabled, onClick: () => run(() => snapshot.actions.setModel!(draft.model!, { ...(draft.providerId ? { providerId: draft.providerId } : {}), ...(draft.effort === undefined ? {} : { effort: draft.effort }) }).result) }, 'Apply model now') : null,
      snapshot.actions.setMode && draft.mode ? h(Button, { variant: 'outline', 'data-action': 'apply-mode', disabled, onClick: () => run(() => snapshot.actions.setMode!(draft.mode!).result) }, 'Apply mode now') : null,
      snapshot.actions.setPermissions && (draft.permissions === 'manual' || draft.permissions === 'allow-all') ? h(Button, { variant: 'outline', 'data-action': 'apply-permissions', disabled, onClick: () => run(() => snapshot.actions.setPermissions!(draft.permissions as 'manual' | 'allow-all').result) }, 'Apply permissions now') : null),
    snapshot.actions.abort && (snapshot.session.native?.activity === 'working' || snapshot.session.native?.activity === 'waiting') ? h('section', { className: 'mpx-chat__settings-turn' }, h('h4', null, 'Current request'), h('div', { className: 'mpx-chat__panel-actions' }, h(Button, { variant: 'destructive', 'data-action': 'abort-request', disabled, onClick: () => run(() => snapshot.actions.abort!().result) }, 'Abort current request'))) : null);
}
