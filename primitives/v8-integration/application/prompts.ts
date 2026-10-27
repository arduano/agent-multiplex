import { createElement as h, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AnswerFor, Field, NativeAnswer, Prompt } from '../../v8-interactions/src/contracts.js';
import type { FormHandle, FormValues } from '../../v8-interactions/src/client.js';
import { encodeAnswer } from '../../v8-interactions/src/native.js';
import type { WorkspaceView } from '../../v8-workspace/src/contracts.js';

type Props = Readonly<{
  prompt: Prompt; form: FormHandle; disabled: boolean; respond: WorkspaceView['respond'];
  onLater(): void; onResult(capability: string, result: Promise<unknown>): void;
}>;
const text = (values: FormValues, key: string): string => Object.hasOwn(values, key) && typeof values[key] === 'string' ? values[key] : '';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const detail = (value: unknown): ReactNode => h('pre', { className: 'prompt-details' }, JSON.stringify(value, null, 2));
function unreachable(value: never): never { throw Error('Unsupported native prompt'); }
function link(value: string | null): string | null {
  try { const url = new URL(value ?? ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

/** All native answers share one validation/dispatch boundary. Field values are
 * read explicitly from the private retained handle, never a composite snapshot. */
export function PromptDialog({ prompt, form, disabled, respond, onLater, onResult }: Props) {
  const values = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot);
  const dialog = useRef<HTMLDialogElement | null>(null);
  useLayoutEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal(); return () => { if (element?.open) element.close(); }; }, []);
  const [error, setError] = useState(''), [sending, setSending] = useState(false), dispatching = useRef(false);
  const busy = disabled || sending;
  const update = (key: string, value: string | boolean | readonly string[] | undefined) => {
    try { const next = Object.assign(Object.create(null), form.getSnapshot()) as Record<string, string | boolean | readonly string[]>; if (value === undefined) delete next[key]; else next[key] = value; form.update(next); setError(''); }
    catch { setError('This request is no longer editable, or its private draft is full.'); }
  };
  function submit<P extends Prompt>(exact: P, answer: AnswerFor<NoInfer<P>>) {
    if (busy || dispatching.current) return;
    try {
      encodeAnswer(exact, answer as NativeAnswer);
      const original = respond(exact, answer); dispatching.current = true; setSending(true); setError('');
      onResult(exact.id, original.result);
    } catch { setError('Check the required fields and offered choices before responding.'); }
  }
  const button = <P extends Prompt>(exact: P, label: string, answer: () => AnswerFor<NoInfer<P>>, primary = false, unavailable = false): ReactNode =>
    h('button', { key: label, type: 'button', id: primary ? 'confirm-request' : undefined, disabled: busy || unavailable, onClick: () => { try { submit(exact, answer()); } catch { setError('Check the required fields and offered choices before responding.'); } } }, label);
  const input = (key: string, label: string, secret = false): ReactNode => h('label', { key }, label,
    h('input', { 'aria-label': label, type: secret ? 'password' : 'text', autoComplete: 'off', value: text(values, key), disabled: busy, onChange: (event: { currentTarget: HTMLInputElement }) => update(key, event.currentTarget.value) }));
  let body: ReactNode, actions: ReactNode[];
  switch (prompt.type) {
    case 'codex.command': case 'codex.file':
      body = detail(prompt.detail);
      actions = prompt.decisions.map((decision, index) => h('div', { key: decision.id }, button(prompt, decision.label, () => ({ type: prompt.type, decisionId: decision.id }), index === 0), typeof decision.decision === 'string' ? null : detail(decision.decision)));
      break;
    case 'codex.permission':
      body = h('div', null, h('p', null, 'Review the exact additional access requested. Denied paths remain denied.'), detail(prompt.requested));
      actions = [button(prompt, 'Deny additional access', () => ({ type: prompt.type, grant: 'deny' })), button(prompt, 'Grant for this turn', () => ({ type: prompt.type, grant: 'turn' }), true), button(prompt, 'Grant for this session', () => ({ type: prompt.type, grant: 'session' }))];
      break;
    case 'codex.question':
      body = h('div', null, ...prompt.questions.map(question => {
        const selected = `question:${question.id}:choice`, other = `question:${question.id}:text`;
        return h('fieldset', { key: question.id, disabled: busy }, h('legend', null, question.header), h('p', null, question.question),
          question.options.length ? h('label', null, `Choice for ${question.header}`, h('select', { 'aria-label': `Choice for ${question.header}`, value: text(values, selected), onChange: (event: { currentTarget: HTMLSelectElement }) => update(selected, event.currentTarget.value) },
            h('option', { value: '' }, 'Choose an answer'), ...question.options.map((option, index) => h('option', { key: option, value: `option:${index}` }, option)), question.other ? h('option', { value: 'other' }, 'Other') : null)) : null,
          !question.options.length || question.other && text(values, selected) === 'other' ? input(other, `Answer for ${question.header}`, question.secret) : null);
      }));
      actions = [button(prompt, 'Send answers', () => ({ type: prompt.type, answers: Object.fromEntries(prompt.questions.map(question => {
        const selected = text(values, `question:${question.id}:choice`), raw = text(values, `question:${question.id}:text`);
        const index = /^option:\d+$/.test(selected) ? Number(selected.slice(7)) : -1;
        const answer = question.options.length && selected !== 'other' ? question.options[index] : raw;
        return [question.id, answer ? [answer] : []];
      })) }), true)];
      break;
    case 'copilot.permission': {
      const request = object(prompt.request), known = ['shell', 'read', 'write', 'mcp', 'url'].includes(String(request.kind));
      body = h('div', null, prompt.managedApprovalRequired ? h('p', null, 'Managed policy requires your explicit decision.') : null,
        request.requestSandboxBypass === true ? h('p', null, 'This request asks to run outside the sandbox.') : null,
        !known ? h('p', null, 'This permission format needs a dedicated review surface. You can reject it or report that you are unavailable.') : null,
        detail(prompt.request), input('feedback', 'Reason for rejecting (optional)'));
      actions = [...(known ? [button(prompt, 'Approve once', () => ({ type: prompt.type, kind: 'approve-once' }), true)] : []),
        button(prompt, 'Reject request', () => ({ type: prompt.type, kind: 'reject', ...(text(values, 'feedback') ? { feedback: text(values, 'feedback') } : {}) })),
        button(prompt, 'User unavailable', () => ({ type: prompt.type, kind: 'user-not-available' }))];
      break;
    }
    case 'copilot.question': {
      const selected = text(values, 'choice');
      body = h('div', null, h('p', null, prompt.question), prompt.options.length ? h('label', null, 'Answer choice', h('select', { 'aria-label': 'Answer choice', value: selected, disabled: busy, onChange: (event: { currentTarget: HTMLSelectElement }) => update('choice', event.currentTarget.value) },
        h('option', { value: '' }, 'Choose an answer'), ...prompt.options.map((option, index) => h('option', { key: option, value: `option:${index}` }, option)), prompt.freeform ? h('option', { value: 'other' }, 'Other') : null)) : null,
        prompt.freeform && (!prompt.options.length || selected === 'other') ? input('answer', 'Your answer') : null);
      actions = [button(prompt, 'Send answer', () => {
        const freeform = !prompt.options.length || selected === 'other', index = /^option:\d+$/.test(selected) ? Number(selected.slice(7)) : -1;
        return { type: prompt.type, answer: freeform ? text(values, 'answer') : prompt.options[index] ?? '', wasFreeform: freeform };
      }, true)];
      break;
    }
    case 'copilot.plan':
      body = h('div', null, h('p', null, prompt.summary), prompt.plan ? h('pre', null, prompt.plan) : null,
        h('label', null, 'Action after approval', h('select', { 'aria-label': 'Action after approval', value: text(values, 'action'), disabled: busy, onChange: (event: { currentTarget: HTMLSelectElement }) => update('action', event.currentTarget.value) }, h('option', { value: '' }, 'Choose an offered action'), ...prompt.actions.map(action => h('option', { key: action, value: action }, `${action}${action === prompt.recommendedAction ? ' (recommended)' : ''}`)))),
        input('feedback', 'Plan feedback (optional)'));
      actions = [button(prompt, 'Approve selected action', () => ({ type: prompt.type, approved: true, selectedAction: text(values, 'action'), ...(text(values, 'feedback') ? { feedback: text(values, 'feedback') } : {}) }), true), button(prompt, 'Reject plan', () => ({ type: prompt.type, approved: false, ...(text(values, 'feedback') ? { feedback: text(values, 'feedback') } : {}) }))];
      break;
    case 'codex.elicitation': case 'copilot.elicitation': {
      const url = link(prompt.url), parsed = prompt.form;
      body = h('div', null, h('p', null, prompt.message), prompt.mode === 'unsupported' ? h('p', null, 'This native form is unsupported. Decline or cancel this request.')
        : prompt.mode === 'url' ? h('div', null, h('p', null, 'Open the requested page, complete its steps, then confirm here.'), url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, 'Open verification page') : h('p', null, 'The verification address is unavailable.'))
        : parsed ? h('div', null, ...Object.entries(parsed.fields).map(([name, field]) => h(FormField, { key: name, name, field, required: parsed.required.includes(name), values, busy, update }))) : null);
      const content = (): Readonly<Record<string, string | number | boolean | readonly string[]>> => {
        const result: Record<string, string | number | boolean | readonly string[]> = Object.create(null) as Record<string, string | number | boolean | readonly string[]>;
        for (const [name, field] of Object.entries(parsed?.fields ?? {})) {
          const value = (Object.hasOwn(values, name) ? values[name] : undefined) ?? (parsed?.required.includes(name) && field.type === 'array' ? [] : parsed?.required.includes(name) && field.type === 'string' && !field.enum ? '' : undefined);
          if (value === undefined) continue;
          if (field.type === 'number' || field.type === 'integer') { if (typeof value !== 'string' || !value.trim()) throw Error('Number required'); result[name] = Number(value); }
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
  return h('dialog', { ref: dialog, 'aria-label': 'Agent confirmation', 'data-prompt-type': prompt.type, onCancel: (event: { preventDefault(): void }) => { event.preventDefault(); onLater(); } },
    h('h3', null, prompt.title), h('p', null, `${prompt.owner.relation === 'child' ? 'Child agent' : 'Agent'} request`), body,
    h('div', { className: 'prompt-actions' }, h('button', { type: 'button', onClick: onLater }, 'Later'), ...actions),
    disabled ? h('p', { role: 'status' }, 'Reconnect before responding. Your unfinished answers remain in this workspace.') : null,
    error ? h('p', { role: 'alert' }, error) : null);
}

function FormField({ name, field, required, values, busy, update }: Readonly<{ name: string; field: Field; required: boolean; values: FormValues; busy: boolean; update(key: string, value: string | boolean | readonly string[] | undefined): void }>) {
  const label = field.title ?? name, included = required || Object.hasOwn(values, name), value = Object.hasOwn(values, name) ? values[name] : undefined;
  const initial = field.type === 'array' ? [] : '';
  let control: ReactNode;
  if (field.type === 'boolean') control = h('select', { 'aria-label': label, value: typeof value === 'boolean' ? String(value) : '', onChange: (event: { currentTarget: HTMLSelectElement }) => update(name, event.currentTarget.value === '' ? '' : event.currentTarget.value === 'true') }, h('option', { value: '' }, 'Choose true or false'), h('option', { value: 'true' }, 'True'), h('option', { value: 'false' }, 'False'));
  else if (field.type === 'array') control = h('div', { role: 'group', 'aria-label': label }, ...(field.enum ?? []).map(option => h('label', { key: option }, h('input', { type: 'checkbox', checked: Array.isArray(value) && value.includes(option), onChange: (event: { currentTarget: HTMLInputElement }) => update(name, event.currentTarget.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value : []).filter(item => item !== option)) }), option)));
  else if (field.enum) control = h('select', { 'aria-label': label, value: typeof value === 'string' && field.enum.includes(value) ? `option:${field.enum.indexOf(value)}` : '', onChange: (event: { currentTarget: HTMLSelectElement }) => update(name, field.enum?.[Number(event.currentTarget.value.slice(7))]) }, h('option', { value: '' }, 'Choose a value'), ...field.enum.map((option, index) => h('option', { key: option, value: `option:${index}` }, option)));
  else control = h('input', { 'aria-label': label, type: field.type === 'number' || field.type === 'integer' ? 'number' : 'text', autoComplete: 'off', value: typeof value === 'string' ? value : '', min: field.minimum, max: field.maximum, step: field.type === 'integer' ? 1 : 'any', minLength: field.minLength, maxLength: field.maxLength, onChange: (event: { currentTarget: HTMLInputElement }) => update(name, event.currentTarget.value) });
  return h('fieldset', { disabled: busy }, h('legend', null, `${label}${required ? ' (required)' : ' (optional)'}`), field.description ? h('p', null, field.description) : null,
    !required ? h('label', null, h('input', { type: 'checkbox', checked: included, onChange: (event: { currentTarget: HTMLInputElement }) => update(name, event.currentTarget.checked ? initial : undefined) }), `Include ${label}`) : null,
    included ? control : null);
}
