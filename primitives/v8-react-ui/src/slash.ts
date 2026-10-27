import type { AgentSnapshot } from '../../v8-workspace/src/contracts.js';
import type { CodexSelection, CopilotSelection, Selection } from '../../v8-session/src/contracts/types.js';

type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
export type LocalShortcut = 'new' | 'status' | 'help' | 'controls' | 'native' | 'mcp' | 'goal';
export type ChatShortcut =
  | Readonly<{ kind: 'message'; text: string }>
  | Readonly<{ kind: 'send'; text: string; selection: Selection }>
  | Readonly<{ kind: 'selection'; selection: Selection; message: string }>
  | Readonly<{ kind: 'local'; action: LocalShortcut }>
  | Readonly<{ kind: 'native'; run(): Promise<unknown> }>
  | Readonly<{ kind: 'error'; message: string }>;
const commands = ['goal', 'plan', 'compact', 'mcp', 'yolo', 'model', 'effort', 'mode', 'default', 'interrupt', 'new', 'status', 'help'] as const;
const error = (message: string): ChatShortcut => ({ kind: 'error', message });
const local = (action: LocalShortcut): ChatShortcut => ({ kind: 'local', action });
const selected = (selection: Selection, message: string): ChatShortcut => ({ kind: 'selection', selection, message });

/** The legacy escape/path grammar is intentional: only a standalone leading
 * token is a command. Unknown commands are errors; // sends a literal slash. */
export function shortcutSuggestions(text: string, kind: 'codex' | 'copilot'): readonly string[] {
  if (!/^\/[a-z]*$/i.test(text.trimStart())) return [];
  return commands.filter(command => (kind === 'codex' ? command !== 'yolo' : command !== 'goal') && command.startsWith(text.trimStart().slice(1).toLowerCase()));
}
export function resolveChatShortcut(text: string, snapshot: Ready): ChatShortcut {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('//')) return { kind: 'message', text: text.slice(0, text.length - trimmed.length) + trimmed.slice(1) };
  if (trimmed === '/') return local('help');
  const token = /^\/([a-z][a-z0-9_-]*)(?=\s|$)/i.exec(trimmed);
  if (!token) return { kind: 'message', text };
  const name = token[1]!.toLowerCase(), argument = trimmed.slice(token[0].length).trim();
  if (!(commands as readonly string[]).includes(name)) return error(`/${name} is unavailable. Use /help, or //${name} to send it as text.`);
  if (['new', 'status', 'help', 'mcp'].includes(name)) return argument ? error(`Use /${name} without an argument.`) : local(name as LocalShortcut);
  const native = snapshot.session.native;
  const draft: Selection = snapshot.session.draft ?? { kind: snapshot.kind };
  const observed = native?.selection;
  if (!native || !observed) return error('Native settings have not been observed. Your draft is retained.');
  if (name === 'model' || name === 'effort' || name === 'mode') {
    if (!argument) return local('controls');
  }
  if (name === 'model') {
    const choices = snapshot.modelCatalog.value?.choices.filter(choice => choice.model === argument) ?? [];
    if (choices.length !== 1) return error('Choose an exact model from the configured choices in Session controls.');
    const choice = choices[0]!;
    if (draft.kind === 'codex') {
      const { effort: _, ...rest } = draft;
      return selected({ ...rest, model: choice.model, ...(rest.collaboration ? { effort: null, collaboration: { ...rest.collaboration, model: choice.model, effort: null } } : {}) }, 'Model selected for the next Send.');
    }
    const { effort: _, providerId: omitted, ...rest } = draft;
    return selected({ ...rest, model: choice.model, ...(choice.providerId ? { providerId: choice.providerId } : {}) }, 'Model selected for the next Send.');
  }
  if (name === 'effort') {
    const choice = snapshot.modelCatalog.value?.choices.find(choice => choice.model === (draft.model ?? observed.model) &&
      (draft.kind !== 'copilot' || choice.providerId === (draft.providerId ?? (observed.kind === 'copilot' ? observed.providerId : undefined))));
    if (!choice?.efforts.includes(argument)) return error('Choose a reasoning level offered for the selected model in Session controls.');
    return selected(draft.kind === 'codex' ? { ...draft, effort: argument, ...(draft.collaboration ? { collaboration: { ...draft.collaboration, effort: argument } } : {}) } : { ...draft, effort: argument }, 'Reasoning selected for the next Send.');
  }
  const mode = name === 'default' || name === 'plan' && argument === 'off' ? (snapshot.kind === 'codex' ? 'default' : 'interactive') : name === 'plan' ? 'plan' : argument;
  if (name === 'mode' || name === 'plan' || name === 'default') {
    if (name === 'default' && argument) return error('Use /default without an argument.');
    let selection: CodexSelection | CopilotSelection;
    if (draft.kind === 'codex') {
      if (mode !== 'default' && mode !== 'plan') return error('Choose /mode default or /mode plan.');
      const model = draft.model ?? observed.model;
      if (!model) return error('Select a model before choosing Codex collaboration mode.');
      const effort = draft.effort === undefined ? observed.effort ?? null : draft.effort;
      selection = { ...draft, effort, collaboration: { mode, model, effort } };
    } else {
      if (mode !== 'interactive' && mode !== 'plan' && mode !== 'autopilot') return error('Choose /mode interactive, plan or autopilot.');
      selection = { ...draft, mode };
    }
    return name === 'plan' && argument && argument !== 'on' && argument !== 'off' ? { kind: 'send', text: argument, selection } : selected(selection, 'Mode selected for the next Send.');
  }
  if (name === 'yolo') {
    if (draft.kind !== 'copilot' || observed.kind !== 'copilot') return error('/yolo is a Copilot control. Use Codex Session controls for access settings.');
    if (argument && argument !== 'on' && argument !== 'off') return error('Use /yolo on or /yolo off.');
    if (!argument && observed.permissions === undefined && draft.permissions === undefined) return error('Permissions have not been reported. Choose /yolo on or /yolo off explicitly.');
    const permissions = argument ? argument === 'on' ? 'allow-all' : 'manual' : (draft.permissions ?? observed.permissions) === 'allow-all' ? 'manual' : 'allow-all';
    return selected({ ...draft, permissions }, 'Permissions selected for the next Send.');
  }
  if (name === 'goal' && (!argument || argument === 'edit')) return snapshot.kind === 'codex' ? local('goal') : error('/goal is a Codex control.');
  if (!snapshot.session.connected || snapshot.session.stale || native.issue || native.phase !== 'running') return error('Native controls are unavailable. Your draft is retained; no command was sent.');
  if (name === 'compact') {
    if (argument) return error('Use /compact without an argument.');
    return snapshot.actions.compact ? { kind: 'native', run: () => snapshot.actions.compact!().result } : error('This Host does not offer context compaction.');
  }
  if (name === 'interrupt') {
    if (argument) return error('Use /interrupt without an argument.');
    if (native.activity !== 'working') return error('No currently working turn has been observed.');
    if (snapshot.kind === 'codex') {
      const turn = snapshot.history.current?.activity.turnId;
      return turn && snapshot.actions.interrupt ? { kind: 'native', run: () => snapshot.actions.interrupt!(turn).result } : error('An exact interruptible Codex turn has not been observed.');
    }
    return snapshot.actions.abort ? { kind: 'native', run: () => snapshot.actions.abort!().result } : error('This Host does not offer request interruption.');
  }
  if (name === 'goal') {
    if (snapshot.kind !== 'codex') return error('/goal is a Codex control.');
    const actions = snapshot.actions;
    if (argument === 'clear') return actions.clearGoal ? { kind: 'native', run: () => actions.clearGoal!().result } : error('Goal controls are unavailable.');
    if (argument === 'pause' || argument === 'resume') return actions.setGoal ? { kind: 'native', run: () => actions.setGoal!({ status: argument === 'pause' ? 'paused' : 'active' }).result } : error('Goal controls are unavailable.');
    if (/^(?:clear|pause|resume)\s/.test(argument)) return error('Use /goal clear, pause or resume without another argument.');
    const objective = argument.startsWith('edit ') ? argument.slice(5).trim() : argument;
    return objective.length > 0 && objective.length <= 4000 && actions.setGoal ? { kind: 'native', run: () => actions.setGoal!({ objective }).result } : error('Enter an objective of 1–4,000 characters on a Host with goal controls.');
  }
  return error(`/${name} is unavailable here.`);
}
