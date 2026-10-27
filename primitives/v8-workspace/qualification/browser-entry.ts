import { createElement as h, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { useAgent } from '../src/react.js';
import type { WorkspaceView } from '../src/index.js';
import { workspaceFixture } from './fixture.js';

const f = workspaceFixture(); const views = await f.open();
function Panel({ view }: { view: WorkspaceView }) {
  const snapshot = useAgent(view), [dialog, setDialog] = useState(false), [answer, setAnswer] = useState('');
  if (snapshot.kind === 'disposed') return h('div', { id: 'state' }, 'disposed');
  const prompt = snapshot.confirmations?.items.find(value => value.state === 'pending')?.prompt;
  return h('section', {}, h('div', { id: 'state' }, snapshot.kind), h('div', { id: 'draft' }, JSON.stringify(snapshot.composer.value)), h('div', { id: 'rows' }, snapshot.history.rows.length),
    h('button', { id: 'edit', onClick: () => view.setDraft({ text: 'retained React draft', fileIds: [] }) }, 'Edit draft'),
    h('div', { id: 'operations' }, JSON.stringify(snapshot.operations)),
    prompt ? h('button', { id: 'open-prompt', onClick: () => setDialog(true) }, 'Open confirmation') : null,
    dialog && prompt ? h('div', { role: 'dialog', 'aria-label': 'Native confirmation' }, h('p', {}, prompt.type === 'copilot.question' ? prompt.question : prompt.type),
      h('input', { id: 'answer', 'aria-label': 'Private answer', value: answer, onChange: (event: { target: { value: string } }) => setAnswer(event.target.value) }),
      h('button', { id: 'dismiss', onClick: () => setDialog(false) }, 'Dismiss'),
      h('button', { id: 'submit', onClick: async () => { if (prompt.type !== 'copilot.question') throw new Error('Unsupported fixture prompt'); await view.respond(prompt, { type: prompt.type, answer, wasFreeform: true }, 'react-answer').result; setAnswer(''); setDialog(false); } }, 'Submit answer')) : null);
}
function Shell() { const [selected, select] = useState<'a' | 'b'>('a'); return h('main', {}, h('button', { id: 'a', onClick: () => select('a') }, 'A'), h('button', { id: 'b', onClick: () => select('b') }, 'B'), h(Panel, { view: views[selected] })); }
const before = f.counts(); const html = renderToString(h(Panel, { view: views.a })); const ssr = { htmlHasCodex: html.includes('codex'), before, after: f.counts(), references: f.history.session(f.bindings.get('a')!.history).mountedReferences };
let root = createRoot(document.getElementById('app')!); root.render(h(StrictMode, {}, h(Shell)));
let privateAnswer = '';
Object.assign(window, { workspaceReact: { ready: true, ssr, counts: f.counts,
  refs: () => ({ a: f.history.session(f.bindings.get('a')!.history).mountedReferences, b: f.history.session(f.bindings.get('b')!.history).mountedReferences }),
  pin: (session: string, value: boolean) => f.workspace.setPinned(session, value), snapshot: (session: 'a' | 'b') => views[session].getSnapshot(),
  prompt() { const binding = f.bindings.get('b')!; f.owners.get('b')!.registerCopilot({ token: {}, requestId: null, owner: { nativeAgent: binding.run.nativeSession, relation: 'root' }, method: 'userInput', payload: { question: 'Harmless private input?', allowFreeform: true }, respond: async response => { privateAnswer = String((response as { answer: string }).answer); return { kind: 'ack', success: true }; } }); },
  privateAnswer: () => privateAnswer,
  unmount() { root.unmount(); }, remount() { root = createRoot(document.getElementById('app')!); root.render(h(StrictMode, {}, h(Shell))); },
  close: () => f.workspace.close(),
} });
