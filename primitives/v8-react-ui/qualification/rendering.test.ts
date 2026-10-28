import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Children, isValidElement, createElement as h, type ReactNode } from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';
import { MultiplexChat, type MultiplexChatProps } from '../src/index.js';
import type { WorkspaceView } from '../../v8-workspace/src/contracts.js';
import { operationLabel, isUnresolved, OperationStatusList } from '../src/operations.js';
import { prepareDiagram, closedDiagramFence, diagramLimits } from '../src/renderers/mermaid-policy.js';
import { diagramAsset, diagramDocument } from '../src/renderers/mermaid.js';
import { workspaceFixture } from '../../v8-workspace/qualification/fixture.js';
import { ChatMarkdown, safeChatLink, localChatFile } from '../src/markdown.js';
import { NativeActions } from '../src/native-actions.js';
import { goalBudget } from '../../v8-workspace/src/goal-form.js';
import { AgentControls, AgentSettingsContent } from '../src/controls.js';
import { CodexGoals } from '../src/native-goal.js';
import { ToolConnections } from '../src/tools.js';
import { RequestArea } from '../src/prompts.js';
import { sessionStatus } from '../src/status.js';
import { CAPTURE_GAP_ID, type Gap } from '../../v8-history/src/contracts/types.js';
import { installPlan } from '../../v8-workspace/qualification/goal-plan-fixture.js';

type ControlProps = { children?: ReactNode; 'data-action'?: string; disabled?: boolean; value?: string; onClick?: () => void; onValueChange?: (value: string) => void; options?: readonly Readonly<{ value: string; label: string; disabled?: boolean }>[] };
function preparedViewContract(view: WorkspaceView): MultiplexChatProps {
  // @ts-expect-error A renderer cannot receive a second workspace authority.
  const mixed: MultiplexChatProps = { view, workspace: {} };
  void mixed; return { view };
}
function control(node: ReactNode, action: string): ControlProps | undefined {
  if (!isValidElement<ControlProps>(node)) return undefined;
  if (node.props['data-action'] === action) return node.props;
  return Children.toArray(node.props.children).map(child => control(child, action)).find(Boolean);
}

test('native root plan action remains discoverable while busy and after the current Host window rolls', async () => {
  const f = workspaceFixture();
  try {
    const { a } = await f.open(), capture = installPlan(f, a), native = f.snapshot('a');
    const render = () => renderToStaticMarkup(h(MultiplexChat, { view: a }));
    const button = () => render().match(/<button[^>]*data-action="implement-plan"[^>]*>/)?.[0];
    assert.ok(button()); assert.doesNotMatch(button()!, /disabled/);
    f.native.publish(native.scope, { activity: 'working' });
    assert.match(button() ?? '', /disabled/, 'A current completed plan stays visible with a busy admission guard');
    f.native.publish(native.scope, { activity: 'idle' });
    f.history.session(capture.root).client.apply({ kind: 'snapshot', snapshot: capture.rollWindow() });
    const state = a.getSnapshot(); if (state.kind !== 'codex') assert.fail('Wrong family');
    assert.equal(state.history.origins[capture.row.id]!.source, 'retainedCurrent');
    assert.ok(button()); assert.doesNotMatch(button()!, /disabled/);
    f.native.publish(native.scope, { selection: { kind: 'codex', model: 'original', effort: 'low', collaboration: { mode: 'default', model: 'original', effort: 'low' } } });
    assert.equal(button(), undefined, 'Default mode does not acquire a plan-mode action');
    f.advance('a'); await a.rebind();
    assert.equal(button(), undefined, 'Old native generation cannot grant an implementation action');
    assert.equal(f.native.submitted.length, 0, 'Rendering never dispatches a native command');
    capture.release();
  } finally { f.workspace.close(); }
});

test('a complete native plan beyond the Send text limit has a visible disabled action and explanation', async () => {
  const f = workspaceFixture();
  try {
    const { a } = await f.open(), capture = installPlan(f, a, 'a', ['x'.repeat(8192)]);
    const markup = renderToStaticMarkup(h(MultiplexChat, { view: a }));
    assert.equal(capture.row.body.kind, 'complete');
    assert.match(markup.match(/<button[^>]*data-action="implement-plan"[^>]*>/)?.[0] ?? '', /disabled/);
    assert.match(markup, /The complete plan exceeds the 8,192-character message limit\./);
    assert.equal(f.native.submitted.length, 0);
    assert.equal(f.workspace.originalReferences('a').length, 0);
    capture.release();
  } finally { f.workspace.close(); }
});

test('actual SSR uses the prepared view without observing, reading, effects or draft allocation', async () => {
  const fixture = workspaceFixture(), views = await fixture.open(), before = fixture.counts();
  const markup = renderToString(h(MultiplexChat, { view: views.a, header: false, theme: { accent: '#123456' } }));
  assert.match(markup, /multiplex-chat/); assert.match(markup, /--mpx-chat-accent:#123456/); assert.match(markup, /Message this agent/);
  assert.doesNotMatch(markup, /mpx-chat__heading/); assert.deepEqual(fixture.counts(), before);
  assert.equal(fixture.history.session(fixture.bindings.get('a')!.history).mountedReferences, 0);
  fixture.workspace.close();
});
test('connected chat warns only for the canonical live capture gap without reading or treating ordinary partial history as capture loss', async () => {
  const f = workspaceFixture();
  try {
    const { a } = await f.open(), lease = a.observe(), client = f.history.session(f.bindings.get('a')!.history).client;
    try {
      const notice = 'Some live history updates were missed. Recent messages may be missing.';
      const render = () => renderToStaticMarkup(h(MultiplexChat, { view: a }));
      const capture = (gaps: readonly Gap[]) => { const current = client.current!; client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, coverage: { ...current.coverage, gaps } } }); };
      const current = a.getSnapshot(); if (current.kind !== 'codex') assert.fail('Expected connected Codex chat');
      assert.equal(current.session.connected, true);
      const before = f.counts();
      assert.equal(render().includes(notice), false);
      capture([{ id: 'native:partial-prefix', kind: 'missingPrefix' }, { id: 'native:compacted-prefix', kind: 'truncated' }]);
      assert.equal(render().includes(notice), false);
      capture([{ id: 'other:native-gap', kind: 'nativeGap' }]); assert.equal(render().includes(notice), false);
      capture([{ id: CAPTURE_GAP_ID, kind: 'nativeGap' }]);
      assert.equal(render().split(notice).length - 1, 1, 'The canonical capture gap remains visible on a healthy connection');
      capture([]); assert.equal(render().includes(notice), false);
      assert.deepEqual(f.counts(), before, 'Rendering neither reads history nor changes native state');
    } finally { lease.release(); }
  } finally { f.workspace.close(); }
});
test('native turn errors remain exact accessible history content without inferring turn completion or interpreting message markup', async () => {
  const f = workspaceFixture();
  try {
    const { a } = await f.open(), lease = a.observe(), binding = f.bindings.get('a')!, client = f.history.session(binding.history).client;
    try {
      if (binding.history.kind !== 'codex') assert.fail('Expected Codex history');
      const message = 'The provider rejected this turn.\n**Exact native text** <private-detail> [do not navigate](https://outside.invalid/error)';
      const current = client.current!, error = { id: 'native-turn-error', kind: 'notice' as const, lifecycle: 'completed' as const, body: { kind: 'complete' as const, text: message, evidence: 'nativeFullBody' as const }, native: { type: 'turnError', threadId: binding.history.threadId, turnId: 'failed-turn', willRetry: false }, version: 1, contentVersion: 1 };
      client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, error] } });
      const before = f.counts(), render = () => renderToStaticMarkup(h(MultiplexChat, { view: a }));
      const initial = render();
      assert.match(initial, /role="note" aria-label="Agent error"/);
      assert.match(initial, /\*\*Exact native text\*\* &lt;private-detail&gt;/);
      assert.doesNotMatch(initial, /<a[^>]+outside\.invalid|<strong>Exact native text|Turn failed/);
      assert.equal(initial.split('data-action="native-error"').length - 1, 1);
      f.observation({ scope: binding.run.scope, kind: 'history', history: binding.history, state: 'disconnected' });
      f.observation({ scope: binding.run.scope, kind: 'history', history: binding.history, state: 'live' });
      const captured = client.current!;
      client.apply({ kind: 'snapshot', snapshot: { ...captured, revision: captured.revision + 1, activity: { state: 'working', turnId: 'next-turn' } } });
      f.native.publish(binding.run.scope, { activity: 'working' });
      const subsequent = render(); assert.match(subsequent, /aria-label="Agent error"/); assert.match(subsequent, /Working/);
      assert.deepEqual(client.current!.rows.find(row => row.id === error.id), error, 'A new turn never rewrites or hides the previous diagnostic');
      const latest = client.current!;
      client.apply({ kind: 'snapshot', snapshot: { ...latest, revision: latest.revision + 1, rows: [...latest.rows, { ...error, id: 'native-retry-error', native: { ...error.native, willRetry: true } }] } });
      assert.match(render(), /aria-label="Retry notice"/);
      assert.deepEqual(f.counts(), before, 'History error rendering and observation changes never submit, retry or read native state');
    } finally { lease.release(); }
  } finally { f.workspace.close(); }
});
test('Send presentation and actual workspace admission agree for connected stale, stopped, incomplete and rebound sessions', async () => {
  for (const session of ['a', 'b'] as const) for (const fact of ['stale', 'stopped', 'incomplete', 'rebind'] as const) {
    const f = workspaceFixture();
    try {
      const view = await f.workspace.open(session), native = f.snapshot(session);
      view.setDraft('Retained Send intent'); await f.workspace.composer(session).flush();
      const sendButton = () => renderToString(h(MultiplexChat, { view })).match(/<button[^>]*data-action="send"[^>]*>/)![0];
      assert.doesNotMatch(sendButton(), /disabled=/);
      if (fact === 'stale') {
        f.observation({ scope: native.scope, kind: 'session', state: 'connecting' });
        f.observation({ scope: native.scope, kind: 'session', state: 'live' });
      } else if (fact === 'stopped') f.native.publish(native.scope, { phase: 'stopped' });
      else if (fact === 'incomplete') f.native.publish(native.scope, { interactionsComplete: false });
      else f.advance(session);
      const blocked = view.getSnapshot(); if (blocked.kind === 'disposed') throw Error('Disposed');
      assert.equal(blocked.session.connected, true);
      assert.match(sendButton(), /disabled=/, `${session}/${fact}: an admitted connection is insufficient for Send`);
      assert.equal(blocked.sendReady, false);
      assert.throws(() => view.sendDraft(), { code: 'FENCED' });
      assert.equal(f.native.submitted.length, 0); assert.equal(blocked.composer.value.text, 'Retained Send intent');
      if (fact === 'rebind') await f.workspace.rebind(session);
      else f.native.publish(native.scope, { phase: 'running', interactionsComplete: true });
      const ready = view.getSnapshot(); if (ready.kind === 'disposed') throw Error('Disposed');
      assert.equal(ready.sendReady, true); assert.doesNotMatch(sendButton(), /disabled=/);
      assert.equal(f.native.submitted.length, 0, 'readiness and rendering neither submit nor replay intent');
    } finally { f.workspace.close(); }
  }
});
test('chat derives write affordances from exact route grants while preserving native facts and independently permitted file writes', async () => {
  const f = workspaceFixture({ hostForKind: { codex: 'reader', copilot: 'file-writer' }, access: scope => ({ read: true, control: false, fileWrite: scope.host === 'file-writer', mcpRefresh: false, catalogWrite: false }) });
  try {
    const { a, b } = await f.open(); a.setDraft('Retained read-only intent'); b.setDraft('Local file draft');
    const render = (view: typeof a) => renderToString(h(MultiplexChat, { view }));
    for (const view of [a, b]) {
      const markup = render(view);
      for (const action of ['send', 'stop']) assert.match(markup.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))![0], /disabled=/);
      const snapshot = view.getSnapshot(); if (snapshot.kind !== 'codex' && snapshot.kind !== 'copilot') assert.fail('Expected agent');
      const mcp = renderToStaticMarkup(h(ToolConnections, { snapshot: snapshot.mcp, stale: false, connected: true, canRefresh: snapshot.access.mcpRefresh, refresh() { assert.fail('Render cannot refresh'); } }));
      assert.match(mcp.match(/<button[^>]*data-action="refresh-mcp"[^>]*>/)![0], /disabled=/);
      assert.match(markup, /Agent controls are unavailable through this Gateway/);
      assert.match(markup, /running/); assert.match(markup, /Message this agent/);
    }
    assert.match(render(a).match(/<input[^>]*aria-label="Choose files"[^>]*>/)![0], /disabled=/);
    assert.doesNotMatch(render(b).match(/<input[^>]*aria-label="Choose files"[^>]*>/)![0], /disabled=/);
    const readOnly = a.getSnapshot(); if (readOnly.kind !== 'codex') assert.fail('Expected Codex');
    // Closed menus/popovers do not mount their controls. Render the actual pure
    // settings body to preserve the grant invariant without forcing it open.
    const settings = renderToStaticMarkup(h(AgentSettingsContent, { snapshot: readOnly, view: a, run() { assert.fail('Rendering cannot run controls'); } }));
    assert.match(settings, /<button[^>]*disabled=""[^>]*>Apply Codex defaults<\/button>/);
    const before = f.counts(); render(a); render(b); assert.deepEqual(f.counts(), before);
    assert.equal(f.native.submitted.length, 0);
  } finally { f.workspace.close(); }
});
test('a fresh-only native opening permission never advertises Resume in chat', async () => {
  const fixture = workspaceFixture();
  try {
    const { a } = await fixture.open(), native = fixture.snapshot('a');
    fixture.native.publish(native.scope, { phase: 'stopped', capabilities: { ...native.capabilities, reopen: false, createAndWait: true } });
    const before = fixture.counts();
    assert.doesNotMatch(renderToString(h(MultiplexChat, { view: a })), /data-action="resume"/);
    fixture.native.publish(native.scope, { capabilities: { ...native.capabilities, reopen: true } });
    assert.match(renderToString(h(MultiplexChat, { view: a })), /data-action="resume"/);
    assert.deepEqual(fixture.counts(), before);
  } finally { fixture.workspace.close(); }
});
test('archive presentation derives only positive facts, retains loaded history and retires controls without effects during render', async () => {
  const f = workspaceFixture({ publishArchive: async request => {
    const entry = f.workspace.list().rows.find(row => row.entry.session === request.session)!.entry;
    return { ...entry, version: entry.version + 1, archive: { id: request.id, generation: request.generation } };
  } });
  try {
    const { a } = await f.open(), lease = a.observe(), native = f.snapshot('a');
    const client = f.history.session(f.bindings.get('a')!.history).client, captured = client.current!;
    const tool = { id: 'unfinished-tool', kind: 'tool' as const, lifecycle: 'running' as const, body: { kind: 'partial' as const, text: 'Retained terminal output', missing: ['final' as const] }, native: {}, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...captured, revision: captured.revision + 1, rows: [...captured.rows, tool] } });
    f.native.publish(native.scope, { phase: 'stopped' });
    const render = () => renderToString(h(MultiplexChat, { view: a }));
    const stopped = render(); assert.match(stopped, /aria-label="More message actions"/);
    assert.match(stopped, /Last captured: running/); assert.match(stopped, /data-kind="tool" data-lifecycle="running"/);
    f.native.publish(native.scope, { archive: { id: 'original-archive', state: 'pending' } });
    const before = f.counts(), pending = render();
    assert.match(pending, /Archive is pending/); assert.match(pending, /retained history/);
    assert.doesNotMatch(pending, /data-action="(?:archive|send|resume|message|publish-archive)"|Load earlier history/);
    f.native.publish(native.scope, { archive: { id: 'original-archive', state: 'complete' } });
    assert.match(render(), /data-action="publish-archive"/);
    await f.workspace.publishArchive('a', 'original-archive', native.generation);
    const complete = render(); assert.match(complete, /Archived\. Loaded history and original receipts are retained/);
    assert.match(complete, /retained history/); assert.doesNotMatch(complete, /data-action="publish-archive"/);
    assert.match(complete, /Last captured: running/); assert.match(complete, /data-kind="tool" data-lifecycle="running"/);
    assert.deepEqual(client.current!.rows.find(row => row.id === tool.id), tool, 'Rendering retirement never invents a terminal lifecycle or edits captured content');
    assert.deepEqual(f.counts(), before); lease.release();
  } finally { f.workspace.close(); }
});
test('shared status keeps native lifetime, completed work and stale observation distinct without duplicate authority', async () => {
  const f = workspaceFixture();
  try {
    const { a } = await f.open(), native = f.snapshot('a');
    const current = () => { const snapshot = a.getSnapshot(); if (snapshot.kind !== 'codex') assert.fail('Expected Codex'); return snapshot; };
    f.native.publish(native.scope, { activity: 'idle', attention: { state: 'finished', cause: { source: 'codex.turn', id: 'turn' }, nativeSession: native.nativeSession!, generation: native.generation, epoch: native.epoch, revision: native.revision } });
    assert.equal(sessionStatus(current()), 'Turn finished · agent running');
    a.setDraft('Unsent follow-up'); await f.workspace.composer('a').flush();
    assert.equal(current().draftActions.send, true, 'An open native agent with a finished turn accepts another ordinary Send');
    const lease = a.observe();
    f.owners.get('a')!.gap(); f.native.publish(native.scope, { interactionsComplete: false });
    const paused = renderToStaticMarkup(h(MultiplexChat, { view: a }));
    assert.equal(current().draftActions.send, false);
    assert.match(paused, /Sending is paused because the Host lost track of native confirmation requests/);
    assert.match(paused.match(/<button[^>]*data-action="send"[^>]*>/)![0], /disabled=/);
    assert.equal(current().composer.value.text, 'Unsent follow-up'); assert.equal(f.native.submitted.length, 0);
    lease.release();
    f.observation({ scope: native.scope, kind: 'session', state: 'disconnected' });
    assert.equal(sessionStatus(current()), 'Turn finished · agent running · last observed');
    f.native.publish(native.scope, { phase: 'stopped' });
    assert.match(sessionStatus(current()), /^Agent stopped/); assert.doesNotMatch(sessionStatus(current()), /finished|agent running/);
    const markup = renderToStaticMarkup(h(MultiplexChat, { view: a, title: h('span', null, 'Shell title'), subtitle: 'Host / workspace', headerLeading: h('button', null, 'Back'), headerActions: h('button', null, 'Details') }));
    assert.equal((markup.match(/data-action="session-status"/g) ?? []).length, 1);
    assert.match(markup, /Shell title/); assert.match(markup, /Host \/ workspace/);
  } finally { f.workspace.close(); }
});
test('Markdown renders structured content without injecting HTML or remote image fetch elements', () => {
  const markup = renderToStaticMarkup(h(ChatMarkdown, { text: '**Strong**\n\n```ts\nconst value = 1;\n```\n\n|A|B|\n|-|-|\n|1|2|\n\n![secret](https://outside.invalid/tracker.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n- [x] Finished task\n- [ ] Remaining task' }));
  assert.match(markup, /<strong>Strong<\/strong>/); assert.match(markup, /<pre[\s>]/); assert.match(markup, /<table[\s>]/);
  assert.doesNotMatch(markup, /<script|<img|href="javascript:/);
  const tasks = markup.match(/<input[^>]*>/g) ?? []; assert.equal(tasks.length, 2);
  assert.match(tasks[0]!, /aria-label="Completed task"/); assert.match(tasks[0]!, /checked=""/);
  assert.match(tasks[1]!, /aria-label="Incomplete task"/); assert.doesNotMatch(tasks[1]!, /checked=/);
  for (const task of tasks) assert.match(task, /disabled=""/);
  assert.equal(safeChatLink('file:///etc/passwd'), undefined); assert.equal(safeChatLink('https://name:secret@example.invalid/'), undefined);
});
test('terminal UI renders retained native pages without IO and stale actions require an explicit refresh', async () => {
  const f = workspaceFixture(); let reads = 0;
  try {
    const { a } = await f.open(), native = f.snapshot('a');
    f.native.publish(native.scope, { capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'codex.terminal.terminate', 'codex.terminals.clean'], reads: ['codex.terminals'] } });
    f.native.nativeRead = async (run, request) => { assert.equal(request.type, 'codex.terminals'); reads++; return { run, type: 'codex.terminals', data: [{ itemId: 'item', processId: 'native-process', command: 'retained command', cwd: '/workspace', osPid: null, cpuPercent: null, rssKb: null }], nextCursor: 'next-page' }; };
    const current = () => { const value = a.getSnapshot(); if (value.kind !== 'codex') assert.fail('Expected Codex snapshot'); return value; };
    const render = () => renderToStaticMarkup(h(NativeActions, { snapshot: current(), text: '', hasFiles: false, run() { assert.fail('Rendering cannot execute a native action'); } }));
    assert.match(render(), /Refresh background terminals/); assert.equal(reads, 0);
    await current().actions.read!({ type: 'codex.terminals' });
    const markup = render(); assert.match(markup, /retained command/); assert.match(markup, /Next terminal page/); assert.equal(reads, 1);
    assert.doesNotMatch(markup, /data-action="terminate-terminal-0" disabled/);
    await current().actions.terminateTerminal!('native-process').result;
    assert.deepEqual(f.native.submitted[0]!.command, { type: 'codex.terminal.terminate', processId: 'native-process' });
    assert.match(render(), /data-action="terminate-terminal-0" disabled/); assert.equal(reads, 1, 'Mutation never guesses a new list or reads it automatically');
    assert.match(render(), /last observation may be out of date/);
  } finally { f.workspace.close(); }
});
test('MCP login rendering is inert, family-specific and requires private-link read plus control', async () => {
  const f = workspaceFixture(); let lookups = 0;
  try {
    const { a, b } = await f.open();
    for (const view of [a, b]) {
      const snapshot = view.getSnapshot(); if (snapshot.kind !== 'codex' && snapshot.kind !== 'copilot' || !snapshot.mcp) assert.fail('Expected native MCP snapshot');
      const actions = { ...snapshot.actions, loginMcp: () => { assert.fail('Rendering cannot create an original'); }, mcpLoginLink: async () => { lookups++; return { state: 'available' as const, status: 'initiated' as const, authorizationUrl: 'https://oauth.invalid/PRIVATE_TRANSIENT_MARKER', expiresInMs: 1000 }; } };
      const mcp = snapshot.mcp.kind === 'codex' ? { ...snapshot.mcp, freshness: 'current' as const, servers: [{ name: 'remote', runtimeStatus: 'authenticationRequired' as const, authStatus: 'notLoggedIn' as const, toolCount: 0, transport: 'http' as const, canAuthenticate: true }] } : { ...snapshot.mcp, freshness: 'current' as const, servers: [{ name: 'remote', enabled: true, runtimeStatus: 'needs-auth' as const, transport: 'http' as const, canAuthenticate: true }] };
      const prepared = { ...snapshot, actions, mcp, mcpStale: false } as Parameters<typeof NativeActions>[0]['snapshot'];
      const render = (value = prepared) => renderToStaticMarkup(h(NativeActions, { snapshot: value, text: '', hasFiles: false, run() { assert.fail('Rendering cannot read or dispatch'); } }));
      assert.match(render(), /Sign in to remote/); assert.doesNotMatch(render(), /PRIVATE_TRANSIENT_MARKER|Open sign-in page/);
      if (prepared.kind === 'codex') assert.doesNotMatch(render(), /Sign in again/); else assert.match(render(), /Sign in again to remote/);
      assert.match(render({ ...prepared, access: { ...prepared.access, control: false } }), /data-action="login-mcp-0" disabled/);
      assert.match(render({ ...prepared, access: { ...prepared.access, read: false } }), /data-action="login-mcp-0" disabled/);
    }
    assert.equal(lookups, 0); assert.equal(f.native.submitted.length, 0);
  } finally { f.workspace.close(); }
});
test('operation language keeps delivery, native acceptance, uncertainty and completion distinct', () => {
  const original = { id: 'one', type: 'send', generation: 1, state: 'outcomeUnknown' as const };
  assert.equal(isUnresolved(original), true); assert.equal(operationLabel(original), 'Receipt not yet observed');
  assert.equal(operationLabel({ ...original, state: 'acknowledged', outcome: { status: 'accepted' } }), 'Accepted by the native agent');
  assert.equal(operationLabel({ ...original, state: 'acknowledged' }), 'Request acknowledged');
  assert.equal(operationLabel({ ...original, state: 'acknowledged', outcome: { status: 'refused', sendDispatched: false } }), 'Message not sent');
  const results = [
    { type: 'copilot.compact', success: false, tokensRemoved: 0, messagesRemoved: 0 },
    { type: 'copilot.queue.promote', steered: false }, { type: 'copilot.task.cancel', cancelled: false },
    { type: 'copilot.task.promote', promoted: false }, { type: 'codex.goal.clear', cleared: false },
    { type: 'codex.terminal.terminate', terminated: false },
  ] as const;
  for (const result of results) {
    const operation = { ...original, type: result.type, state: 'acknowledged' as const, outcome: { status: 'applied' as const, result } };
    assert.match(operationLabel(operation), /did not|no goal was cleared/);
    assert.match(renderToStaticMarkup(h(OperationStatusList, { operations: [operation], check() { assert.fail('Render cannot check an original'); } })), /did not|no goal was cleared/);
    assert.equal(isUnresolved(operation), false);
  }
  assert.match(operationLabel({ ...original, type: 'codex.compact', state: 'acknowledged', outcome: { status: 'acknowledged' } }), /completion has not been proved/);
  assert.match(operationLabel({ ...original, type: 'copilot.compact', state: 'acknowledged', outcome: { status: 'applied', result: { type: 'copilot.compact', success: true, tokensRemoved: 25, messagesRemoved: 3 } } }), /3 messages removed · 25 tokens freed/);
});

test('goal editor keeps message files and draft separate, refuses invalid budgets and submits exact native patches without optimistic goal changes', async () => {
  const f = workspaceFixture();
  try {
    const { a } = await f.open(), native = f.snapshot('a');
    f.native.publish(native.scope, { capabilities: { ...native.capabilities, commands: [...native.capabilities.commands, 'codex.goal.set'], reads: ['codex.goal'] } });
    f.native.nativeRead = async run => ({ run, type: 'codex.goal', goal: { threadId: run.nativeSession, objective: 'retained goal', status: 'paused', tokenBudget: 500, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 3, updatedAt: 4 } });
    const current = () => { const value = a.getSnapshot(); if (value.kind !== 'codex') assert.fail('Expected Codex'); return value; };
    await current().actions.read!({ type: 'codex.goal' });
    const file = await a.saveFile({ name: 'draft.txt', mediaType: 'text/plain', blob: new Blob(['Retained message attachment']) });
    a.setDraft({ text: 'Ordinary message draft', fileIds: [file.manifest.id] });
    const composer = current().composer.value;
    current().actions.goalEditor!.open();
    for (const invalid of ['0', '-1', '1.5', '9007199254740992']) {
      current().actions.goalEditor!.edit({ objective: 'edited goal', budget: invalid });
      const before = f.native.submitted.length;
      assert.throws(() => goalBudget(invalid)); assert.throws(() => current().actions.goalEditor!.save());
      const button = control(CodexGoals({ snapshot: current(), disabled: false, readDisabled: false, run() { assert.fail('Invalid goal cannot dispatch'); } }), 'save-goal');
      assert.equal(button!.disabled, true); assert.equal(f.native.submitted.length, before);
    }
    assert.equal(goalBudget(''), null); assert.equal(goalBudget('1200'), 1200);
    current().actions.goalEditor!.edit({ objective: 'edited goal', budget: '1200' });
    let result: Promise<unknown> | undefined;
    const run = (work: () => Promise<unknown>) => { result = work(); }, before = f.counts();
    const props = { snapshot: current(), text: composer.text, hasFiles: true, run };
    assert.match(renderToStaticMarkup(h(NativeActions, props)), /edited goal/);
    assert.deepEqual(f.counts(), before, 'Rendering the retained editor is inert');
    control(CodexGoals({ snapshot: current(), disabled: false, readDisabled: false, run }), 'save-goal')!.onClick!(); await result;
    assert.deepEqual(f.native.submitted.at(-1)!.command, { type: 'codex.goal.set', objective: 'edited goal', tokenBudget: 1200 });
    assert.deepEqual(current().composer.value, composer);
    const observed = current().session.nativeReads.find(value => value.request.type === 'codex.goal')!.value;
    assert.equal(observed?.type === 'codex.goal' && observed.goal?.objective, 'retained goal');
    assert.equal(f.native.submitted.filter(value => value.command.type === 'send').length, 0);
  } finally { f.workspace.close(); }
});

test('Codex permission choices retain native facts and encode explicit sandbox or observed-profile intent without invented profiles', async () => {
  const f = workspaceFixture();
  try {
    const { a } = await f.open(), native = f.snapshot('a');
    f.native.publish(native.scope, { selection: { kind: 'codex', model: 'native-model', access: { approval: 'on-request', sandbox: 'danger-full-access' } } });
    const snapshot = () => { const value = a.getSnapshot(); if (value.kind !== 'codex') assert.fail('Expected Codex'); return value; };
    const tree = () => AgentSettingsContent({ snapshot: snapshot(), view: a, run() { assert.fail('Editing intent cannot dispatch'); } });
    assert.equal(control(tree(), 'next-sandbox')!.value, 'keep');
    for (const sandbox of ['workspace-write', 'read-only', 'danger-full-access'] as const) {
      control(tree(), 'next-sandbox')!.onValueChange!(sandbox);
      assert.deepEqual(snapshot().session.draft, { kind: 'codex', access: { approval: 'on-request', sandbox } });
      assert.deepEqual(snapshot().session.native!.selection, { kind: 'codex', model: 'native-model', access: { approval: 'on-request', sandbox: 'danger-full-access' } });
    }
    control(tree(), 'next-approval')!.onValueChange!('untrusted'); const selected = snapshot().session.draft; assert.equal(selected?.kind === 'codex' && selected.access?.approval, 'untrusted');
    control(tree(), 'next-sandbox')!.onValueChange!('keep'); assert.deepEqual(snapshot().session.draft, { kind: 'codex' });
    f.native.publish(native.scope, { selection: { kind: 'codex', model: 'native-model', access: { approval: 'on-request', profile: 'actual-native-profile' } } });
    const markup = renderToStaticMarkup(tree()); assert.match(markup, /Current permissions/); assert.match(markup, /actual-native-profile/); assert.doesNotMatch(markup, /unavailable for Next Send|fake-profile/);
    control(tree(), 'next-sandbox')!.onValueChange!('profile:actual-native-profile'); assert.deepEqual(snapshot().session.draft, { kind: 'codex', access: { approval: 'on-request', profile: 'actual-native-profile' } });
    control(tree(), 'next-sandbox')!.onValueChange!('profile:fake-profile'); assert.deepEqual(snapshot().session.draft, { kind: 'codex', access: { approval: 'on-request', profile: 'actual-native-profile' } });
    assert.equal(f.native.submitted.length, 0);
    f.native.publish(native.scope, { selection: { kind: 'codex', model: 'native-model' } }); snapshot().actions.setSelectionDraft(null); assert.equal(control(tree(), 'next-approval')!.disabled, true, 'unreported native policy does not become full access');
  } finally { f.workspace.close(); }
});

test('model controls keep Codex provider metadata out of its identity and refuse ambiguous models while Copilot keeps provider choices', async () => {
  let choices = [{ model: 'gpt-6-luna', providerId: 'codex-lb', efforts: ['low'] }];
  const f = workspaceFixture({ controlCatalog: async () => ({ available: true, choices }) });
  try {
    const { a, b } = await f.open(); await a.refreshControls();
    const tree = (view: typeof a) => {
      const snapshot = view.getSnapshot(); if (snapshot.kind !== 'codex' && snapshot.kind !== 'copilot') assert.fail('Expected native snapshot');
      return AgentSettingsContent({ snapshot, view, run() { assert.fail('This oracle changes draft intent only'); } });
    };
    const codexKey = JSON.stringify(['gpt-6-luna', null]);
    control(tree(a), 'next-model')!.onValueChange!(codexKey);
    let snapshot = a.getSnapshot(); if (snapshot.kind !== 'codex') assert.fail('Expected Codex');
    assert.deepEqual(snapshot.session.draft, { kind: 'codex', model: 'gpt-6-luna', effort: 'low' });
    assert.equal(control(tree(a), 'next-model')!.value, codexKey);
    assert.doesNotMatch(renderToStaticMarkup(tree(a)), /not offered/);
    control(tree(a), 'next-effort')!.onValueChange!('effort:0');
    control(tree(a), 'next-mode')!.onValueChange!('default');
    choices = [{ model: 'gpt-6-luna', providerId: 'one', efforts: ['low'] }, { model: 'gpt-6-luna', providerId: 'two', efforts: ['high'] }];
    await a.refreshControls();
    const ambiguous = renderToStaticMarkup(tree(a));
    assert.match(ambiguous, /reports more than one choice/);
    assert.match(ambiguous, /<button[^>]*disabled=""[^>]*>Apply Codex defaults<\/button>/);
    assert.equal(control(tree(a), 'next-effort')!.disabled, true);
    assert.equal([control(tree(a), 'next-model'), control(tree(a), 'next-effort')].flatMap(field => field!.options ?? []).filter(option => option.label.includes('(not offered)')).length, 2, 'Retain model and effort intent without merging incompatible offered efforts');
    assert.deepEqual(control(tree(a), 'next-model')!.options!.map(option => option.value), ['', codexKey]);
    const observedCopilot = f.snapshot('b'); f.native.publish(observedCopilot.scope, { selection: { kind: 'copilot', model: 'original', providerId: 'native-provider', effort: 'medium' } });
    await b.refreshControls();
    const copilotKey = JSON.stringify(['gpt-6-luna', 'two']);
    control(tree(b), 'next-model')!.onValueChange!(copilotKey);
    const copilot = b.getSnapshot(); if (copilot.kind !== 'copilot') assert.fail('Expected Copilot');
    assert.deepEqual(copilot.session.draft, { kind: 'copilot', model: 'gpt-6-luna', providerId: 'two', effort: 'medium' });
    assert.equal(copilot.session.native!.selection.effort, 'medium');
    assert.equal(control(tree(b), 'next-model')!.value, copilotKey);
    assert.deepEqual(control(tree(b), 'next-model')!.options!.slice(1).map(option => option.label), ['gpt-6-luna (one)', 'gpt-6-luna (two)']);
    assert.equal(f.native.submitted.length, 0); snapshot = a.getSnapshot(); if (snapshot.kind !== 'codex') assert.fail('Expected Codex');
    assert.equal(snapshot.session.native!.selection.model, 'original');
  } finally { f.workspace.close(); }
});

test('compact settings show observed facts while searchable native metadata edits only retained next-Send intent', async () => {
  const choices = [{ model: 'original', efforts: ['ultra'], displayName: 'Observed friendly name', description: 'Everyday native description', defaultEffort: 'ultra', inputModalities: ['text', 'image'] as const },
    { model: 'next-model', efforts: ['high'], displayName: 'Different label', description: 'Specialized search phrase', defaultEffort: 'high', inputModalities: ['text'] as const }];
  const f = workspaceFixture({ controlCatalog: async () => ({ available: true, choices }) });
  try {
    const { a } = await f.open(), native = f.snapshot('a');
    f.native.publish(native.scope, { selection: { kind: 'codex', model: 'original', effort: 'ultra', collaboration: { mode: 'plan', model: 'original', effort: 'ultra' } } });
    await a.refreshControls();
    const current = () => { const value = a.getSnapshot(); if (value.kind !== 'codex') assert.fail('Expected Codex'); return value; };
    const run = () => { assert.fail('Rendering and editing intent cannot read or dispatch'); }, before = f.counts();
    const render = () => renderToStaticMarkup(h(AgentControls, { snapshot: current(), view: a, run }));
    assert.match(render(), /title="Observed friendly name · Plan · ultra"/);
    const fields = (search = '') => AgentSettingsContent({ snapshot: current(), view: a, run, search });
    const searched = control(fields('specialized'), 'next-model')!.options!;
    assert.ok(searched.some(option => option.label === 'Different label · next-model')); assert.equal(searched.some(option => option.label.includes('Observed friendly name')), false);
    control(fields(), 'next-model')!.onValueChange!(JSON.stringify(['next-model', null]));
    assert.equal(current().session.draft!.effort, 'ultra', 'Changing the model cannot silently choose native default reasoning');
    assert.ok(control(fields(), 'next-effort')!.options!.some(option => option.disabled && option.label === 'ultra (not offered)'));
    control(fields(), 'next-effort')!.onValueChange!('effort:0');
    assert.match(render(), /title="Observed friendly name · Plan · ultra"/, 'Draft selection cannot become the observed trigger');
    assert.match(render(), /Choose Agent or Plan/); assert.equal((render().match(/data-action="codex-mode-hint"/g) ?? []).length, 1, 'Unknown mode prerequisite is visible beside inline fields, with one derived explanation');
    assert.match(renderToStaticMarkup(fields('missing')), /No matching models/);
    assert.ok(control(fields('missing'), 'next-model')!.options!.some(option => option.label.includes('Different label · next-model')), 'Search never removes retained selected intent');
    assert.deepEqual(current().session.draft, { kind: 'codex', model: 'next-model', effort: 'high' });
    assert.deepEqual(f.counts(), before); assert.equal(f.native.submitted.length, 0);
    assert.ok(control(fields(), 'next-effort')!.options!.some(option => option.label === 'Native default (high)'));
    f.observation({ scope: native.scope, kind: 'session', state: 'connecting' });
    assert.match(render(), /title="Last observed: Observed friendly name/);
  } finally { f.workspace.close(); }
});

test('MCP UI renders only the narrowed native action, preserves explicit originals and disables stale per-server controls', async () => {
  const f = workspaceFixture();
  try {
    const { a, b } = await f.open(), codex = f.snapshot('a'), copilot = f.snapshot('b');
    f.native.publish(codex.scope, { capabilities: { ...codex.capabilities, commands: [...codex.capabilities.commands, 'codex.mcp.reload'] } });
    f.native.publish(copilot.scope, { capabilities: { ...copilot.capabilities, commands: [...copilot.capabilities.commands, 'copilot.mcp.reconnect'] } });
    const c = a.getSnapshot(), p = b.getSnapshot(); if (c.kind !== 'codex' || p.kind !== 'copilot' || p.mcp?.kind !== 'copilot') assert.fail('Wrong fixture harness');
    const prepared = { ...p, mcpStale: false, mcp: { ...p.mcp, freshness: 'current' as const, management: 'session-originals' as const, servers: [{ name: 'remote', enabled: true, runtimeStatus: 'connected' as const, transport: 'http' as const, canAuthenticate: true }] } };
    const before = f.counts(), render = (snapshot: Parameters<typeof NativeActions>[0]['snapshot']) => renderToStaticMarkup(h(NativeActions, { snapshot, text: '', hasFiles: false, run() { assert.fail('Render cannot dispatch'); } }));
    assert.match(render(c), /Reload this agent&#x27;s MCP configuration/); assert.doesNotMatch(render(c), /reconnect-mcp/);
    assert.match(render(prepared), /Reconnect remote/); assert.doesNotMatch(render(prepared), /reload-mcp/); assert.doesNotMatch(render(prepared), /data-action="reconnect-mcp-0" disabled/);
    assert.match(render({ ...prepared, mcpStale: true }), /data-action="reconnect-mcp-0" disabled/);
    assert.match(render({ ...prepared, mcp: { ...prepared.mcp, servers: [{ ...prepared.mcp.servers[0]!, transport: 'unknown', canAuthenticate: null }] } }), /data-action="reconnect-mcp-0" disabled/);
    assert.deepEqual(f.counts(), before);
    await c.actions.reloadMcp!().result; await p.actions.reconnectMcp!('remote').result;
    assert.deepEqual(f.native.submitted.map(item => item.command), [{ type: 'codex.mcp.reload' }, { type: 'copilot.mcp.reconnect', serverName: 'remote' }]);
    assert.equal(f.counts().discovery, 0);
  } finally { f.workspace.close(); }
});

test('math keeps TeX delimiters, prices, literal examples and bounded geometry distinct', () => {
  const render = (text: string) => renderToStaticMarkup(h(ChatMarkdown, { text }));
  assert.match(render('$x^2$'), /class="katex/); assert.match(render('\\(x^2\\)'), /class="katex/);
  assert.match(render('\\[x^2\\]'), /katex-display/); assert.match(render('$$\nx^2\n$$'), /katex-display/);
  assert.doesNotMatch(render('Prices $5 and $10'), /class="katex/);
  assert.doesNotMatch(render('```math\nx^2\n```'), /class="katex/);
  assert.doesNotMatch(render('$' + 'x'.repeat(4100) + '$'), /class="katex/);
});
test('diagram admission strips untrusted configuration and renderer realm denies network', () => {
  assert.equal(prepareDiagram('%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B'), 'flowchart LR\nA-->B');
  assert.throws(() => prepareDiagram('x'.repeat(diagramLimits.source + 1)));
  assert.equal(closedDiagramFence('```mermaid\nA-->B\n```'), true); assert.equal(closedDiagramFence('```mermaid\nA-->B'), false);
  assert.equal(diagramAsset('/renderer.js', 'https://example.invalid/page').origin, 'https://example.invalid');
  assert.throws(() => diagramAsset('https://outside.invalid/renderer.js', 'https://example.invalid/page'));
  const document = diagramDocument('window.value = "</script><img src=x>";', '12345678-1234-1234-1234-123456789012');
  assert.match(document, /connect-src &#39;none&#39;|connect-src 'none'/); assert.match(document, /img-src 'none'/);
  assert.equal((document.match(/<\/script>/gi) ?? []).length, 1);
  const streaming = renderToStaticMarkup(h(ChatMarkdown, { text: '```mermaid\nflowchart LR\nA-->B\n```', streaming: true })); assert.match(streaming, /still writing/); assert.doesNotMatch(streaming, /<img/);
});
test('link classification never navigates local/private paths or accepts encoded controls as file intents', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.invalid', ' https://example.invalid', 'https://example.invalid/\u0001']) assert.equal(safeChatLink(value), undefined);
  for (const value of ['//outside.invalid/path', '\\\\outside\\path', 'data:text/plain,value', '%2f%2foutside.invalid', '%00private']) assert.equal(localChatFile(value), undefined);
  // V7 file URLs are now capture references, never direct browser navigation.
  assert.equal(localChatFile('file:///private/path'), 'file:///private/path');
  const file = renderToStaticMarkup(h(ChatMarkdown, { text: '[Local file](file:///private/path)', onLocalFile() { assert.fail('Render cannot capture'); } }));
  assert.match(file, /mpx-chat__local-link/); assert.doesNotMatch(file, /href="file:/);
  assert.equal(localChatFile('src/example.ts:42'), 'src/example.ts:42');
});

test('unresolved originals remain prominent while completed independent actions recede into Activity', () => {
  const operations = [
    { id: 'send-old', type: 'send', generation: 1, state: 'acknowledged' as const },
    { id: 'send-new', type: 'send', generation: 1, state: 'outcomeUnknown' as const },
    { id: 'answer-old', type: 'answer', generation: 1, state: 'acknowledged' as const },
  ];
  const html = renderToStaticMarkup(h(OperationStatusList, { operations, check() {} })), primary = html.slice(0, html.indexOf('<details'));
  assert.match(primary, /data-original="send-new"/); assert.doesNotMatch(primary, /data-original="answer-old"/);
  assert.match(html, /Activity/); assert.doesNotMatch(html, /Earlier actions/);
  for (const original of operations) assert.equal((html.match(new RegExp(`data-original="${original.id}"`, 'g')) ?? []).length, 1);
});


test('all nine native request types render selectable headings without form acquisition or native dispatch during SSR', async () => {
  const f = workspaceFixture();
  try {
    const views = await f.open(), a = f.bindings.get('a')!, b = f.bindings.get('b')!;
    const codex = f.owners.get('a')!, copilot = f.owners.get('b')!;
    const base = { threadId: a.run.nativeSession, turnId: 'turn', itemId: 'item' }, respond = async () => ({ kind: 'ack' as const, success: true });
    for (const [method, params] of [
      ['item/commandExecution/requestApproval', { ...base, command: 'harmless', availableDecisions: ['accept', 'decline'] }],
      ['item/fileChange/requestApproval', base], ['item/permissions/requestApproval', { ...base, permissions: { network: { enabled: true } } }],
      ['item/tool/requestUserInput', { ...base, isBlocking: true, questions: [{ id: 'q', header: 'Choose', question: 'Choose?', isOther: false, isSecret: false, options: [{ label: 'One', description: 'Native option detail' }] }] }],
      ['mcpServer/elicitation/request', { threadId: a.run.nativeSession, serverName: 'fixture', mode: 'form', message: 'Confirm', requestedSchema: { type: 'object', properties: {}, required: [] } }],
    ] as const) codex.registerCodex({ token: {}, requestId: method, owner: { nativeAgent: a.run.nativeSession, relation: 'root' }, method, params, respond });
    for (const [method, payload] of [
      ['permission', { kind: 'mcp', serverName: 'fixture', toolName: 'fixed' }], ['userInput', { question: 'Question?', allowFreeform: true }],
      ['exitPlan', { summary: 'Summary', planContent: '# Actual plan', actions: ['interactive'], recommendedAction: 'interactive' }],
      ['elicitation', { mode: 'url', message: 'Verify', url: 'https://example.invalid/explicit' }],
    ] as const) copilot.registerCopilot({ token: {}, requestId: method, owner: { nativeAgent: b.run.nativeSession, relation: 'root' }, method, payload, respond });
    let forms = 0;
    const markup = Object.values(views).map(view => { const snapshot = view.getSnapshot(); if (snapshot.kind === 'disposed') assert.fail('Disposed'); return renderToString(h(RequestArea, { snapshot, view: { ...view, form(prompt) { forms++; return view.form(prompt); } } })); }).join('');
    for (const type of ['codex.command', 'codex.file', 'codex.permission', 'codex.question', 'codex.elicitation', 'copilot.permission', 'copilot.question', 'copilot.plan', 'copilot.elicitation']) assert.match(markup, new RegExp(`data-prompt-type="${type}"`));
    assert.equal((markup.match(/data-action="confirmation"/g) ?? []).length, 9);
    assert.equal(forms, 0); assert.equal(f.native.submitted.length, 0); assert.doesNotMatch(markup, /role="dialog"/);
    assert.equal(f.owners.get('a')!.current().items.length, 5); assert.equal(f.owners.get('b')!.current().items.length, 4);
  } finally { f.workspace.close(); }
});
