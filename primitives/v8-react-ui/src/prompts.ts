import { createElement as h, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AnswerFor, Field, NativeAnswer, Prompt } from '../../v8-interactions/src/contracts.js';
import type { FormHandle, FormValues } from '../../v8-interactions/src/client.js';
import { encodeAnswer, formErrors } from '../../v8-interactions/src/native.js';
import { canonical } from '../../v8-session/src/contracts/validation.js';
import { ChatMarkdown } from './markdown.js';
import { Button, Input, Textarea, Select, Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from './ui/index.js';
import type { AgentSnapshot, ConfirmationResponse, WorkspaceView } from '../../v8-workspace/src/contracts.js';

type Props = Readonly<{
  prompt: Prompt; form: FormHandle; disabled: boolean; respond: WorkspaceView['respond'];
  onLater(): void; onResult(capability: string, result: Promise<unknown>): void; disabledReason?: string;
}>;
const text = (values: FormValues, key: string): string => Object.hasOwn(values, key) && typeof values[key] === 'string' ? values[key] : '';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const detail = (value: unknown): ReactNode => h('details', { className: 'mpx-requests__technical' }, h('summary', null, 'Technical details'), h('pre', null, JSON.stringify(value, null, 2)));
function unreachable(value: never): never { throw Error('Unsupported native prompt'); }
function link(value: string | null): string | null {
  try { const url = new URL(value ?? ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

/** All native answers share one validation/dispatch boundary. Field values are
 * read explicitly from the private retained handle, never a composite snapshot. */
function PromptFields({ prompt, form, disabled, disabledReason, respond, onLater, onResult }: Props) {
  const values = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot), groupId = useId();
  const [error, setError] = useState(''), [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({}), [sending, setSending] = useState(false), dispatching = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!Object.keys(fieldErrors).length) return;
    const invalid = editor.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = invalid?.matches('button,input,textarea,select') ? invalid : invalid?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)');
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
  }, [fieldErrors]);
  const busy = disabled || sending;
  const update = (key: string, value: string | boolean | readonly string[] | undefined) => {
    try { const next = Object.assign(Object.create(null), form.getSnapshot()) as Record<string, string | boolean | readonly string[]>; if (value === undefined) delete next[key]; else next[key] = value; form.update(next); setError(''); setFieldErrors({}); }
    catch { setError('This request is no longer editable, or its private draft is full.'); }
  };
  function submit<P extends Prompt>(exact: P, answer: AnswerFor<NoInfer<P>>) {
    if (busy || dispatching.current) return;
    try {
      const nativeAnswer = answer as NativeAnswer, errors: Record<string, string> = Object.create(null) as Record<string, string>;
      if ((exact.type === 'codex.elicitation' || exact.type === 'copilot.elicitation') && nativeAnswer.type === exact.type && nativeAnswer.action === 'accept' && exact.mode === 'form' && exact.form) Object.assign(errors, formErrors(exact.form, nativeAnswer.content));
      if (exact.type === 'codex.question' && nativeAnswer.type === 'codex.question') for (const question of exact.questions) if (!nativeAnswer.answers[question.id]?.length) errors[question.id] = 'Choose an answer or enter your response.';
      if (exact.type === 'copilot.question' && nativeAnswer.type === 'copilot.question') {
        if (nativeAnswer.wasFreeform && nativeAnswer.answer.length === 0) errors.answer = 'Enter your response.';
        else if (!nativeAnswer.wasFreeform && !exact.options.includes(nativeAnswer.answer)) errors.answer = 'Choose an offered answer.';
      }
      if (exact.type === 'copilot.plan' && nativeAnswer.type === 'copilot.plan' && nativeAnswer.approved && !exact.actions.includes(nativeAnswer.selectedAction ?? '')) errors.action = 'Choose an offered action.';
      setFieldErrors(errors); if (Object.keys(errors).length) return;
      encodeAnswer(exact, nativeAnswer);
      const original = respond(exact, answer); dispatching.current = true; setSending(true); setError('');
      onResult(exact.id, original.result);
    } catch { setError('Check the required fields and offered choices before responding.'); }
  }
  type Decision = Readonly<{ primary: boolean; node: ReactNode }>;
  const button = <P extends Prompt>(exact: P, label: string, answer: () => AnswerFor<NoInfer<P>>, primary = false, unavailable = false): Decision => ({ primary,
    node: h(Button, { key: label, type: 'button', variant: primary ? 'default' : /^(Decline|Reject|Deny)/.test(label) ? 'destructive' : 'outline', 'data-action': primary ? 'confirm-request' : undefined, disabled: busy || unavailable, onClick: () => { try { submit(exact, answer()); } catch { setError('Check the required fields and offered choices before responding.'); } } }, label) });
  const fieldMessage = (key: string): string | undefined => Object.hasOwn(fieldErrors, key) ? fieldErrors[key] : undefined;
  const errorId = (key: string) => `${groupId}:${encodeURIComponent(key)}:error`;
  const errorProps = (key: string) => ({ 'aria-invalid': !!fieldMessage(key), 'aria-describedby': fieldMessage(key) ? errorId(key) : undefined });
  const fieldError = (key: string): ReactNode => fieldMessage(key) ? h('p', { id: errorId(key), role: 'alert' }, fieldMessage(key)) : null;
  const input = (key: string, label: string, secret = false, errorKey = key, accessibleLabel = label): ReactNode => h('label', { key }, label, secret
    ? h(Input, { 'aria-label': accessibleLabel, ...errorProps(errorKey), type: 'password', autoComplete: 'off', value: text(values, key), disabled: busy, onChange: (event: { currentTarget: HTMLInputElement }) => update(key, event.currentTarget.value) })
    : h(Textarea, { 'aria-label': accessibleLabel, ...errorProps(errorKey), rows: 2, autoComplete: 'off', value: text(values, key), disabled: busy, onChange: (event: { currentTarget: HTMLTextAreaElement }) => update(key, event.currentTarget.value) }));
  let body: ReactNode, actions: Decision[];
  switch (prompt.type) {
    case 'codex.command': case 'codex.file':
      body = h('div', null, approvalSummary(prompt), detail(prompt.detail));
      actions = prompt.decisions.map(decision => { const action = button(prompt, decisionLabel(decision.decision), () => ({ type: prompt.type, decisionId: decision.id }), decision.decision === 'accept'); return { ...action, node: h('div', { key: decision.id }, action.node, typeof decision.decision === 'string' ? null : detail(decision.decision)) }; });
      break;
    case 'codex.permission':
      body = h('div', null, h('p', null, 'Review the exact additional access requested. Denied paths remain denied.'), permissionSummary(prompt.requested), detail(prompt.requested));
      actions = [button(prompt, 'Deny additional access', () => ({ type: prompt.type, grant: 'deny' })), button(prompt, 'Grant for this turn', () => ({ type: prompt.type, grant: 'turn' }), true), button(prompt, 'Grant for this session', () => ({ type: prompt.type, grant: 'session' }))];
      break;
    case 'codex.question':
      body = h('div', null, ...prompt.questions.map(question => {
        const selected = `question:${question.id}:choice`, other = `question:${question.id}:text`, context = `question:${question.id}:context`;
        return h('fieldset', { key: question.id, disabled: busy, ...errorProps(question.id) }, h('legend', null, question.header), h('p', null, question.question),
          question.options.length ? h('div', { className: 'mpx-requests__choices' }, ...question.options.map((option, index) => h('label', { key: option, className: 'mpx-ui-choice' }, h('input', { type: 'radio', name: `${groupId}:${question.id}`, value: `option:${index}`, checked: text(values, selected) === `option:${index}`, onChange: () => update(selected, `option:${index}`) }), h('span', null, option, question.optionDescriptions && Object.hasOwn(question.optionDescriptions, option) ? h('small', null, question.optionDescriptions[option]) : null))), question.other ? h('label', { className: 'mpx-ui-choice' }, h('input', { type: 'radio', name: `${groupId}:${question.id}`, checked: text(values, selected) === 'other', onChange: () => update(selected, 'other') }), 'Other') : null) : null,
          !question.options.length || question.other && text(values, selected) === 'other' ? input(other, `Answer for ${question.header}`, question.secret, question.id) : input(context, 'Extra info (optional)', question.secret, context, `Extra info for ${question.header}`), fieldError(question.id));
      }));
      actions = [button(prompt, 'Send answers', () => ({ type: prompt.type, answers: Object.fromEntries(prompt.questions.map(question => {
        const selected = text(values, `question:${question.id}:choice`), raw = text(values, `question:${question.id}:text`).trim(), context = text(values, `question:${question.id}:context`).trim();
        const index = /^option:\d+$/.test(selected) ? Number(selected.slice(7)) : -1;
        if (!question.options.length || question.other && selected === 'other') return [question.id, raw ? [raw] : []];
        const answer = question.options[index];
        return [question.id, answer === undefined ? [] : context ? [answer, context] : [answer]];
      })) }), true)];
      break;
    case 'copilot.permission': {
      const request = object(prompt.request), known = ['shell', 'read', 'write', 'mcp', 'url'].includes(String(request.kind));
      body = h('div', null, prompt.managedApprovalRequired ? h('p', null, 'Managed policy requires your explicit decision.') : null,
        request.requestSandboxBypass === true ? h('p', null, 'This request asks to run outside the sandbox.') : null,
        !known ? h('p', null, 'This permission format needs a dedicated review surface. You can reject it or report that you are unavailable.') : null,
        requestSummary(prompt.request), detail(prompt.request), input('feedback', 'Reason for rejecting (optional)'));
      actions = [...(known ? [button(prompt, 'Approve once', () => ({ type: prompt.type, kind: 'approve-once' }), true)] : []),
        button(prompt, 'Reject request', () => ({ type: prompt.type, kind: 'reject', ...(text(values, 'feedback') ? { feedback: text(values, 'feedback') } : {}) })),
        button(prompt, 'User unavailable', () => ({ type: prompt.type, kind: 'user-not-available' }))];
      break;
    }
    case 'copilot.question': {
      const selected = text(values, 'choice');
      body = h('fieldset', { disabled: busy, ...errorProps('answer') }, h('legend', null, prompt.question), prompt.options.length ? h('div', { className: 'mpx-requests__choices' },
        ...prompt.options.map((option, index) => h('label', { key: option, className: 'mpx-ui-choice' }, h('input', { type: 'radio', name: `${groupId}:answer`, checked: selected === `option:${index}`, onChange: () => update('choice', `option:${index}`) }), option)),
        prompt.freeform ? h('label', { className: 'mpx-ui-choice' }, h('input', { type: 'radio', name: `${groupId}:answer`, checked: selected === 'other', onChange: () => update('choice', 'other') }), 'Other') : null) : null,
        prompt.freeform && (!prompt.options.length || selected === 'other') ? input('answer', 'Your answer') : null, fieldError('answer'));
      actions = [button(prompt, 'Send answer', () => {
        const freeform = !prompt.options.length || selected === 'other', index = /^option:\d+$/.test(selected) ? Number(selected.slice(7)) : -1;
        return { type: prompt.type, answer: freeform ? text(values, 'answer') : prompt.options[index] ?? '', wasFreeform: freeform };
      }, true)];
      break;
    }
    case 'copilot.plan':
      body = h('div', null, h('p', null, prompt.summary), prompt.plan ? h(ChatMarkdown, { text: prompt.plan }) : h('p', { role: 'status' }, 'The agent supplied no full plan. Review the summary before deciding whether to continue.'),
        h('label', null, 'Action after approval', h(Select, { 'aria-label': 'Action after approval', ...errorProps('action'), value: text(values, 'action'), disabled: busy, onValueChange: action => { if (action === '' || prompt.actions.includes(action)) update('action', action); }, options: [{ value: '', label: 'Choose an offered action' }, ...prompt.actions.map(action => ({ value: action, label: `${planActionLabel(action)}${action === prompt.recommendedAction ? ' (recommended)' : ''}` }))] })), fieldError('action'),
        input('feedback', 'Plan feedback (optional)'));
      actions = [button(prompt, 'Approve selected action', () => ({ type: prompt.type, approved: true, selectedAction: text(values, 'action'), ...(text(values, 'feedback') ? { feedback: text(values, 'feedback') } : {}) }), true), button(prompt, text(values, 'feedback').trim() ? 'Request changes' : 'Keep planning', () => ({ type: prompt.type, approved: false, ...(text(values, 'feedback') ? { feedback: text(values, 'feedback') } : {}) }))];
      break;
    case 'codex.elicitation': case 'copilot.elicitation': {
      const url = link(prompt.url), parsed = prompt.form;
      body = h('div', null, h('p', null, prompt.message), prompt.mode === 'unsupported' ? h('p', null, 'This native form is unsupported. Decline or cancel this request.')
        : prompt.mode === 'url' ? h('div', null, h('p', null, 'Open the requested page, complete its steps, then confirm here.'), url ? h('a', { ...(busy ? {} : { href: url }), 'aria-disabled': busy, tabIndex: busy ? -1 : undefined, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, 'Open verification page') : h('p', null, 'The verification address is unavailable.'))
        : parsed ? h('div', null, ...Object.entries(parsed.fields).map(([name, field]) => h(FormField, { key: name, name, field, required: parsed.required.includes(name), values, busy, update, error: fieldMessage(name) }))) : null);
      const content = (): Readonly<Record<string, string | number | boolean | readonly string[]>> => {
        const result: Record<string, string | number | boolean | readonly string[]> = Object.create(null) as Record<string, string | number | boolean | readonly string[]>;
        for (const [name, field] of Object.entries(parsed?.fields ?? {})) {
          const value = (Object.hasOwn(values, name) ? values[name] : undefined) ?? (parsed?.required.includes(name) && field.type === 'array' ? [] : parsed?.required.includes(name) && field.type === 'string' && !field.enum ? '' : undefined);
          if (value === undefined) continue;
          if (field.type === 'number' || field.type === 'integer') result[name] = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
          else result[name] = value;
        }
        return result;
      };
      actions = [...(prompt.mode !== 'unsupported' ? [button(prompt, prompt.mode === 'url' ? "I've completed this" : 'Confirm once', () => ({ type: prompt.type, action: 'accept', ...(prompt.mode === 'form' ? { content: content() } : {}) }), true, prompt.mode === 'url' && !url)] : []),
        button(prompt, 'Decline request', () => ({ type: prompt.type, action: 'decline' })), button(prompt, 'Cancel request', () => ({ type: prompt.type, action: 'cancel' }))];
      break;
    }
    default: return unreachable(prompt);
  }
  return h('div', { ref: editor, className: 'mpx-requests__editor', 'data-prompt-type': prompt.type }, h('div', { className: 'mpx-requests__fields' }, body),
    disabled ? h('p', { role: 'status' }, disabledReason ?? 'This request is unavailable. Your unfinished answers remain in this workspace.') : null,
    error ? h('p', { role: 'alert' }, error) : null,
    h('div', { className: 'mpx-requests__footer' }, h(Button, { type: 'button', variant: 'ghost', onClick: onLater }, 'Later'),
      h('div', { className: 'mpx-requests__actions' }, h('div', { className: 'mpx-requests__alternatives' }, ...actions.filter(action => !action.primary).map(action => action.node)),
        h('div', { className: 'mpx-requests__primary' }, ...actions.filter(action => action.primary).map(action => action.node)))));
}

function FormField({ name, field, required, values, busy, update, error }: Readonly<{ name: string; field: Field; required: boolean; values: FormValues; busy: boolean; error: string | undefined; update(key: string, value: string | boolean | readonly string[] | undefined): void }>) {
  const fieldId = useId(), label = field.title ?? name, included = required || Object.hasOwn(values, name), value = Object.hasOwn(values, name) ? values[name] : undefined;
  const describedBy = [field.description ? `${fieldId}:hint` : '', error ? `${fieldId}:error` : ''].filter(Boolean).join(' ') || undefined;
  const attributes = { 'aria-invalid': !!error, 'aria-describedby': describedBy };
  const initial = field.type === 'array' ? [] : '';
  let control: ReactNode;
  if (field.type === 'boolean') control = h(Select, { 'aria-label': label, ...attributes, value: typeof value === 'boolean' ? String(value) : '', onValueChange: choice => { if (choice === '' || choice === 'true' || choice === 'false') update(name, choice === '' ? '' : choice === 'true'); }, options: [{ value: '', label: 'Choose true or false' }, { value: 'true', label: 'True' }, { value: 'false', label: 'False' }] });
  else if (field.type === 'array') control = h('div', { role: 'group', 'aria-label': label, ...attributes }, ...(field.enum ?? []).map(option => h('label', { key: option, className: 'mpx-ui-choice' }, h('input', { type: 'checkbox', checked: Array.isArray(value) && value.includes(option), onChange: (event: { currentTarget: HTMLInputElement }) => update(name, event.currentTarget.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value : []).filter(item => item !== option)) }), option)));
  else if (field.enum) control = h(Select, { 'aria-label': label, ...attributes, value: typeof value === 'string' && field.enum.includes(value) ? `option:${field.enum.indexOf(value)}` : '', onValueChange: choice => {
    if (choice === '') update(name, undefined);
    else if (/^option:\d+$/.test(choice)) { const option = field.enum?.[Number(choice.slice(7))]; if (option !== undefined) update(name, option); }
  }, options: [{ value: '', label: 'Choose a value' }, ...field.enum.map((option, index) => ({ value: `option:${index}`, label: option || 'Empty value' }))] });
  else control = h(Input, { 'aria-label': label, ...attributes, type: field.type === 'number' || field.type === 'integer' ? 'number' : 'text', autoComplete: 'off', value: typeof value === 'string' ? value : '', min: field.minimum, max: field.maximum, step: field.type === 'integer' ? 1 : 'any', minLength: field.minLength, maxLength: field.maxLength, onChange: (event: { currentTarget: HTMLInputElement }) => update(name, event.currentTarget.value) });
  return h('fieldset', { disabled: busy }, h('legend', null, `${label}${required ? ' (required)' : ' (optional)'}`), field.description ? h('p', { id: `${fieldId}:hint` }, field.description) : null,
    !required ? h('label', { className: 'mpx-ui-choice' }, h('input', { type: 'checkbox', checked: included, onChange: (event: { currentTarget: HTMLInputElement }) => update(name, event.currentTarget.checked ? initial : undefined) }), `Include ${label}`) : null,
    included ? control : null, error ? h('p', { id: `${fieldId}:error`, role: 'alert' }, error) : null);
}

function decisionLabel(value: unknown): string {
  if (value === 'accept') return 'Approve once';
  if (value === 'acceptForSession') return 'Approve for this session';
  if (value === 'decline') return 'Decline request';
  if (value === 'cancel') return 'Cancel this turn';
  const offered = object(value);
  return offered.acceptWithExecpolicyAmendment ? 'Allow this command pattern' : offered.applyNetworkPolicyAmendment ? 'Apply this network rule' : 'Review offered decision';
}
function planActionLabel(value: string): string {
  return ({ exit_only: 'Leave plan mode', interactive: 'Continue interactively', autopilot: 'Continue in autopilot' } as Readonly<Record<string, string>>)[value] ?? value.replaceAll('_', ' ');
}
function approvalSummary(prompt: Extract<Prompt, { type: 'codex.command' | 'codex.file' }>): ReactNode {
  const value = object(prompt.detail);
  return h('dl', { className: 'mpx-requests__facts' }, ...['command', 'cwd', 'reason', 'grantRoot'].flatMap(key => typeof value[key] === 'string' ? [h('div', { key }, h('dt', null, ({ cwd: 'Working directory', grantRoot: 'Write access' } as Readonly<Record<string, string>>)[key] ?? key[0]!.toUpperCase() + key.slice(1)), h('dd', null, h('pre', null, value[key] as string)))] : []));
}
function requestSummary(value: unknown): ReactNode {
  const request = object(value);
  return h('dl', { className: 'mpx-requests__facts' }, ...['kind', 'fullCommandText', 'path', 'fileName', 'serverName', 'toolName', 'url'].flatMap(key => typeof request[key] === 'string' ? [h('div', { key }, h('dt', null, ({ kind: 'Request', fullCommandText: 'Command', fileName: 'File', serverName: 'MCP server', toolName: 'Tool' } as Readonly<Record<string, string>>)[key] ?? key), h('dd', null, request[key] as string))] : []));
}
function permissionSummary(value: unknown): ReactNode {
  const requested = object(value), network = object(requested.network), files = object(requested.fileSystem);
  const lines: string[] = [];
  if (typeof network.enabled === 'boolean') lines.push(network.enabled ? 'Network access requested' : 'Network remains disabled');
  for (const access of ['read', 'write']) if (Array.isArray(files[access])) for (const path of files[access]) if (typeof path === 'string') lines.push(`${access === 'read' ? 'Read' : 'Write'} ${path}`);
  if (Array.isArray(files.entries)) for (const raw of files.entries) { const entry = object(raw), path = object(entry.path); if (typeof path.path === 'string') lines.push(`${entry.access === 'deny' ? 'Keep blocked' : entry.access === 'write' ? 'Write' : 'Read'} ${path.path}`); }
  return lines.length ? h('ul', null, ...lines.map((line, index) => h('li', { key: index }, line))) : h('p', null, 'Review the requested scope in Technical details.');
}

type RequestView = Pick<WorkspaceView, 'form' | 'respond' | 'checkReceipt'>;
type RequestSnapshot = Exclude<AgentSnapshot, { kind: 'disposed' }>;
function responseHeld(response: ConfirmationResponse | undefined): boolean { return !!response && response.receipt?.state !== 'refused'; }
function responseText(response: ConfirmationResponse | undefined, state: string): string {
  if (state === 'responseUnknown' || response?.state === 'unknown' || response?.receipt?.state === 'outcomeUnknown') return 'The response outcome is unknown. Check its original receipt before responding again.';
  if (state === 'responseSubmitted' || response?.receipt?.state === 'acknowledged') return 'Response submitted. Native completion has not been confirmed.';
  if (response?.receipt?.state === 'refused') return 'The response was refused. Review this request before choosing a new response.';
  return 'Sending this response. Native completion has not been confirmed.';
}
function requestReason(snapshot: RequestSnapshot, prompt: Prompt): string | undefined {
  const native = snapshot.session.native;
  if (!snapshot.access.read || !snapshot.access.control) return 'This Gateway is read-only. Your unfinished answers are retained.';
  if (!snapshot.session.connected) return 'Reconnect before responding. Your unfinished answers are retained.';
  if (!native || native.phase !== 'running' || native.nativeSession !== prompt.run.nativeSession || native.generation !== prompt.run.generation || snapshot.confirmations?.issue === 'ownershipRetired') return 'This native request is no longer active. Your unfinished answers are retained.';
  if (snapshot.confirmationsStale || snapshot.session.requiresRebind) return 'Wait for the current session observation before responding. Your unfinished answers are retained.';
  if (native.issue) return 'Native control is unavailable. Your unfinished answers are retained.';
  return undefined;
}
/** Acquiring a private form is an existing retained-owner operation. It happens
 * only after commit, never during render/SSR, and unmount does not retire it. */
function RequestEditor({ prompt, view, reason, collapse }: Readonly<{ prompt: Prompt; view: RequestView; reason: string | undefined; collapse(): void }>) {
  const shape = canonical(prompt, 65536);
  const [acquired, setAcquired] = useState<Readonly<{ view: RequestView; shape: string; form: FormHandle }> | Readonly<{ view: RequestView; shape: string; error: true }> | null>(null);
  useEffect(() => {
    try { setAcquired({ view, shape, form: view.form(prompt) }); }
    catch { setAcquired({ view, shape, error: true }); }
  }, [view, shape]);
  if (!acquired || acquired.view !== view || acquired.shape !== shape) return h('p', { role: 'status' }, 'Preparing the private answer form…');
  if ('error' in acquired) return h('p', { role: 'status' }, 'This answer form is no longer available. Check any original response shown with the request.');
  return h(PromptFields, { key: shape, prompt, form: acquired.form, disabled: reason !== undefined, ...(reason ? { disabledReason: reason } : {}), respond: view.respond, onLater: collapse,
    onResult: (_id: string, result: Promise<unknown>) => { void result.catch(() => {}); } });
}
/** One presentation over existing prompt/form/original owners. Selecting,
 * collapsing and dismissing never answers, cancels, or retries a callback. */
export function RequestArea({ view, snapshot }: Readonly<{ view: RequestView; snapshot: RequestSnapshot }>) {
  const [selection, setSelection] = useState<string | null | undefined>(undefined), [dialog, setDialog] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null), [checkError, setCheckError] = useState<string | null>(null);
  const container = useRef<HTMLElement | null>(null), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const items = snapshot.confirmations?.items ?? [];
  const responses = snapshot.confirmationResponses;
  const pending = items.find(item => item.state === 'pending' && !responses.some(response => response.interactionId === item.prompt.id && response.generation === item.prompt.run.generation && responseHeld(response)));
  const expanded = selection === null ? null : items.some(item => item.prompt.id === selection) ? selection : pending?.prompt.id ?? items[0]?.prompt.id;
  const check = (id: string) => {
    if (checking) return; setChecking(id); setCheckError(null);
    void view.checkReceipt(id).catch(() => { if (mounted.current) setCheckError(id); }).finally(() => { if (mounted.current) setChecking(null); });
  };
  const displayResponse = (response: ConfirmationResponse, state: string) => h('div', { role: 'status', className: 'mpx-requests__response', 'data-response-original': response.id },
    h('p', null, responseText(response, state)),
    response.state === 'unknown' || !response.receipt || !['acknowledged', 'refused'].includes(response.receipt.state) ? h(Button, { type: 'button', variant: 'outline', disabled: checking !== null, onClick: () => check(response.id) }, checking === response.id ? 'Checking original response…' : 'Check original response') : null,
    checkError === response.id ? h('p', { role: 'alert' }, 'The original receipt could not be read. The response has not been sent again.') : null);
  const orphaned = responses.filter(response => !items.some(item => item.prompt.id === response.interactionId) && (response.state !== 'observed' || response.receipt && !['acknowledged', 'refused'].includes(response.receipt.state)));
  if (!items.length && !orphaned.length) return null;
  return h('section', { ref: container, className: 'mpx-requests', 'aria-label': 'Agent requests', 'data-action': 'requests' },
    ...items.map(({ prompt, state }) => {
      const response = responses.filter(value => value.interactionId === prompt.id && value.generation === prompt.run.generation).at(-1), held = responseHeld(response) || state !== 'pending';
      const inline = prompt.type === 'codex.question' || prompt.type === 'copilot.question' || prompt.type === 'copilot.plan';
      const open = expanded === prompt.id, reason = requestReason(snapshot, prompt), child = snapshot.agents.find(value => value.id === prompt.owner.nativeAgent);
      const source = prompt.owner.relation === 'child' ? `Child agent${child?.name ? ` · ${child.name}` : ` · ${prompt.owner.nativeAgent}`}` : 'Agent';
      return h('article', { key: prompt.id, className: 'mpx-requests__request', 'data-interaction': prompt.id, 'data-prompt-type': prompt.type },
        h(Button, { type: 'button', variant: 'ghost', className: 'mpx-requests__heading', 'data-action': 'confirmation', 'aria-expanded': open, onClick: () => setSelection(open ? null : prompt.id) }, h('span', null, prompt.title), h('small', null, source)),
        open ? h('div', { className: 'mpx-requests__body' },
          response ? displayResponse(response, state) : null,
          held ? !response ? h('p', { role: 'status' }, responseText(undefined, state)) : null
            : inline ? h(RequestEditor, { key: `${prompt.id}:${response?.id ?? ''}`, prompt, view, reason, collapse: () => setSelection(null) })
            : h(Dialog, { open: dialog === prompt.id, onOpenChange: open => setDialog(open ? prompt.id : null) },
              h(DialogTrigger, { asChild: true }, h(Button, { type: 'button', variant: 'outline', onClick: () => setDialog(prompt.id) }, prompt.type.endsWith('.elicitation') ? 'Review verification request' : 'Review permission request')),
              h(DialogContent, { container: container.current?.closest<HTMLElement>('.multiplex-chat') ?? container.current, className: 'mpx-requests__dialog' },
                h('div', { className: 'mpx-requests__dialog-heading' }, h(DialogTitle, null, prompt.title), h(DialogDescription, null, `${source} request. Closing this dialog leaves it pending.`)),
                h(RequestEditor, { key: `${prompt.id}:${response?.id ?? ''}`, prompt, view, reason, collapse: () => setDialog(null) })))) : null);
    }), ...orphaned.map(response => h('div', { key: response.id }, displayResponse(response, 'unknown'))));
}
