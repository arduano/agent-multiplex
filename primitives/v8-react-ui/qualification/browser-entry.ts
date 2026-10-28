import { createElement as h, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { renderToString } from 'react-dom/server';
import { MultiplexChat, lightChatTheme } from '../src/index.js';
import { workspaceFixture, deferred, catalogScope } from '../../v8-workspace/qualification/fixture.js';
import { digest } from '../../v8-files/src/contracts/content.js';
import { MemoryDraftPersistence } from '../../v8-files/src/client/persistence.js';
import { CAPTURE_GAP_ID } from '../../v8-history/src/contracts/types.js';
import { codexErrorRecord } from '../../v8-history/src/native/codex/errors.js';
import type { ArtifactRef, FilePort, FileMethod, FileInputs, FileOutputs } from '../../v8-files/src/contracts/types.js';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import type { Row, Scope, HistoryPage } from '../../v8-history/src/contracts/types.js';
const previewBytes = new TextEncoder().encode('Verified file preview from the existing resource owner'), previewSha = await digest(previewBytes);
const previewArtifacts = new Map<string, ArtifactRef>(), reads = new Map<string, ArtifactRef>();
const artifactBytes = new Map<string, Uint8Array>(), captured = new Map<string, { path: string; artifact: ArtifactRef }>(), captures: { sourceKey: string; path: string }[] = [];
const documentFiles = new Map<string, Uint8Array>();
const encode = (text: string) => new TextEncoder().encode(text);
documentFiles.set('docs/guide.md', encode('# Captured guide\n\n[Read child](child.txt)\n\n![Local picture](picture.png)\n\n![Remote never loads](https://outside.invalid/document.png)'));
documentFiles.set('docs/child.txt', encode('Nested file reached the exact same authenticated owner.'));
documentFiles.set('docs/unsafe.html', encode('<h1>Static verified HTML</h1><script>parent.document.body.textContent="UNSAFE_HTML_SCRIPT";fetch("https://outside.invalid/script")</script><meta http-equiv="refresh" content="0;url=https://outside.invalid/refresh"><base href="https://outside.invalid/"><style>body{background:url(https://outside.invalid/style)}</style><img src="https://outside.invalid/image"><form action="https://outside.invalid/form"><input autofocus></form><p><a href="child.txt">Open child safely</a></p>'));
documentFiles.set('docs/large.html', encode('<div></div>'.repeat(10_001)));
documentFiles.set('docs/picture.png', Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), value => value.charCodeAt(0)));
const imageBytes = documentFiles.get('docs/picture.png')!, imageSha = await digest(imageBytes);
documentFiles.set('docs/original.bin', new Uint8Array([0, 255, 0, 1, 128, 37]));
function examplePdf() {
  const page = (text: string) => `BT /F1 22 Tf 20 160 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(unsafe\\)) >> >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${page('Verified PDF first page').length} >>\nstream\n${page('Verified PDF first page')}\nendstream`, `<< /Length ${page('Verified PDF second page').length} >>\nstream\n${page('Verified PDF second page')}\nendstream`, '<< /Type /Annot /Subtype /Link /Rect [0 0 300 200] /A << /S /URI /URI (https://outside.invalid/pdf-action) >> >>'];
  let text = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = text.length; text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(text);
}
documentFiles.set('docs/pages.pdf', examplePdf());
const files: FilePort = { call: async <M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> => {
  const body = input as { id?: string; leaseId?: string; offset?: number; length?: number };
  if (method === 'capture') {
    const reference = input as FileInputs['capture']; captures.push({ sourceKey: reference.sourceKey, path: reference.path });
    const prior = captured.get(reference.sourceKey); if (prior) { if (prior.path !== reference.path) throw Error('Capture changed path'); return prior.artifact as FileOutputs[M]; }
    const bytes = documentFiles.get(reference.path); if (!bytes) throw Error('File is outside fixture roots');
    const artifact: ArtifactRef = { kind: 'artifact', owner: reference.scope, id: crypto.randomUUID(), name: reference.path.split('/').at(-1)!, bytes: bytes.length, sha256: await digest(bytes), mediaType: 'application/octet-stream', capturedAt: 1 };
    captured.set(reference.sourceKey, { path: reference.path, artifact }); previewArtifacts.set(artifact.id, artifact); artifactBytes.set(artifact.id, bytes); return artifact as FileOutputs[M];
  }
  if (method === 'status') return { state: 'committed', artifact: previewArtifacts.get(body.id!)! } as FileOutputs[M];
  if (method === 'acquire') { const artifact = previewArtifacts.get(body.id!)!, leaseId = crypto.randomUUID(); reads.set(leaseId, artifact); return { artifact, leaseId } as FileOutputs[M]; }
  if (method === 'read') { const artifact = reads.get(body.leaseId!); if (!artifact) throw Error('Missing exact read lease'); return (artifactBytes.get(artifact.id) ?? previewBytes).slice(body.offset!, body.offset! + body.length!) as FileOutputs[M]; }
  if (method === 'release') { reads.delete(body.leaseId!); return undefined as FileOutputs[M]; }
  throw Error('Unexpected file operation');
} };
const knownChildren = new Map<string, Scope[]>(); let inventoryReads = 0;
const persistence = new MemoryDraftPersistence(), protectOriginal = persistence.original.bind(persistence);
let protectionGate: ReturnType<typeof deferred<void>> | null = null, protectionEntered = false, submissionGate: ReturnType<typeof deferred<void>> | null = null, progressRevision = 0;
let ownMessageArmed = false, ownMessage: Readonly<{ id: string; text: string }> | null = null, ownMessageRevision = 0;
persistence.original = async (...args) => { const result = await protectOriginal(...args), gate = protectionGate; if (args[3] === 'protect' && gate) { protectionEntered = true; await gate.promise; } return result; };
let heldOlder: ReturnType<typeof deferred<HistoryPage>> | null = null, olderInput: { scope: Scope; generation: string | undefined; readContext: string | undefined } | null = null, wheelGrowths = 0;
const f = workspaceFixture({ files, persistence, historyScopes: async scope => { inventoryReads++; return [f.bindings.get(scope.session)!.history, ...knownChildren.get(scope.session) ?? []]; }, older: async (_parent, scope, _cursor, generation) => {
  if (heldOlder) { olderInput = { scope, generation, readContext: f.history.session(scope).client.current?.readContext }; return heldOlder.promise; }
  return { scope, generation: 'host-generation', rows: [{ id: 'older', kind: 'user', lifecycle: 'completed', body: { kind: 'complete', text: 'older private page', evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 }], olderEdge: { state: 'end', evidence: 'nativeBoundary' } };
} }), views = await f.open(), embed = f.workspace.view('a', 'embed');
const invoke = f.native.invoke!;
f.native.invoke = async request => {
  if (ownMessageArmed && request.command.type === 'send') { ownMessageArmed = false; ownMessage = { id: `own-message-${++ownMessageRevision}`, text: request.command.text }; }
  const gate = submissionGate; if (gate && ['send', 'codex.steer', 'codex.queue.add'].includes(request.command.type)) await gate.promise; return invoke(request);
};
let acquiredPreviews = 0, releasedPreviews = 0, heldPreview: (() => void) | null = null;
const actualPreview = f.workspace.previewCapturedFile.bind(f.workspace);
f.workspace.previewCapturedFile = async (session: string, id: string): Promise<ResourceLease> => {
  const lease = await actualPreview(session, id); acquiredPreviews++;
  if (id === 'late-preview') await new Promise<void>(resolve => { heldPreview = resolve; });
  let released = false; return { ...lease, release() { if (released) return; released = true; releasedPreviews++; lease.release(); } };
};
const nonce = (document.querySelector('script[data-chat-entry]') as HTMLScriptElement).nonce ?? ''; 
let root = createRoot(document.getElementById('app')!), choose: (session: 'a' | 'b') => void = () => {}, privateAnswer = '';
let elicitationAnswer: unknown = null, planAnswer: unknown = null, codexQuestionSerial = 0;
const codexQuestionAnswers: unknown[] = [];
function Shell() { const [selected, select] = useState<'a' | 'b'>('a'); choose = select;
  return h('main', null, h('nav', { 'aria-label': 'Fixture sessions' }, h('button', { id: 'session-a', onClick: () => select('a') }, 'A'), h('button', { id: 'session-b', onClick: () => select('b') }, 'B')),
    h('div', { id: 'chat-container' }, h(MultiplexChat, { view: views[selected], assets: { cspNonce: nonce } })),
    h('div', { id: 'light-embed' }, h(MultiplexChat, { view: embed, header: false, theme: lightChatTheme, assets: { cspNonce: nonce } })));
}
const before = f.counts(), html = renderToString(h(MultiplexChat, { view: views.a }));
const ssr = { htmlHasComposer: html.includes('data-action="message"'), before, after: f.counts(), references: f.history.session(f.bindings.get('a')!.history).mountedReferences };
root.render(h(StrictMode, null, h(Shell)));
Object.assign(window, { chatFixture: { ready: true, ssr, counts: f.counts, choose: (session: 'a' | 'b') => choose(session),
  refs: () => ({ a: f.history.session(f.bindings.get('a')!.history).mountedReferences, b: f.history.session(f.bindings.get('b')!.history).mountedReferences }),
  pin: (value: boolean) => f.workspace.setPinned('a', value), snapshot: (session: 'a' | 'b') => views[session].getSnapshot(),
  optionalQuestions(session: 'a' | 'b' = 'a', variant: 'fallback' | 'prose' | 'ordinary' | 'without-delivery' | 'omitted' = 'fallback') {
    const client = f.history.session(f.bindings.get(session)!.history).client, current = client.current!;
    const questions = [{ title: 'Which approach should we explore?', options: ['Keep the current approach', 'Explore a longer alternative that wraps on a narrow phone'] }, { title: 'Any details to add?', options: [] }];
    const fallback = questions.map(question => [question.title, ...question.options.map(option => `- ${option}`)].join('\n')).join('\n\n');
    const row: Row = { id: `optional-${variant}`, kind: 'assistant', lifecycle: 'completed', body: { kind: 'complete', text: variant === 'prose' ? 'Native explanation stays visible before the optional question.' : fallback, evidence: 'nativeFullBody' }, native: variant === 'ordinary' ? {} : { type: 'agentMessage', ...(variant === 'without-delivery' ? {} : { delivery: 'async' }), questions: variant === 'omitted' ? [] : questions, questionsOmitted: variant === 'omitted' ? 1 : 0 }, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [row] } }); views[session].viewport.followLatest();
    return { row: row.id, fallback, questions };
  },
  async optionalDraft() {
    const file = await views.a.saveFile({ name: 'optional-attachment.png', mediaType: 'image/png', blob: new Blob([new Uint8Array(imageBytes).buffer]) }), scope = f.workspace.fileScope('a');
    const artifact: ArtifactRef = { ...file.manifest, kind: 'artifact', owner: scope, capturedAt: 1 };
    previewArtifacts.set(artifact.id, artifact); artifactBytes.set(artifact.id, imageBytes); await views.a.uploadFile(artifact.id);
    views.a.setDraft({ text: 'Existing unsent draft  \n', fileIds: [artifact.id] });
    const snapshot = views.a.getSnapshot(); if (snapshot.kind !== 'codex') throw Error('Expected Codex');
    snapshot.actions.setSelectionDraft({ kind: 'codex', model: 'original', effort: 'ultra' });
    await f.workspace.composer('a').flush(); return { file: artifact.id, text: 'Existing unsent draft  \n' };
  },
  optionalState() { const snapshot = views.a.getSnapshot(); if (snapshot.kind !== 'codex') throw Error('Expected Codex'); return { composer: snapshot.composer, selectionDraft: snapshot.session.draft, observed: snapshot.session.native?.selection, activity: snapshot.session.native?.activity, commands: f.native.submitted.map(value => value.command) }; },
  async optionalStored() { return persistence.getComposer({ ...catalogScope, host: f.bindings.get('a')!.run.scope.host, session: 'a' }); },
  optionalReconnect() { const scope = f.bindings.get('a')!.run.scope; f.observation({ scope, kind: 'history', history: f.bindings.get('a')!.history, state: 'disconnected' }); f.observation({ scope, kind: 'history', history: f.bindings.get('a')!.history, state: 'live' }); f.native.publish(scope, {}); },
  nativeError(session: 'a' | 'b' = 'a', willRetry = false) {
    const binding = f.bindings.get(session)!, client = f.history.session(binding.history).client, current = client.current!;
    const message = `Native provider rejected the turn.\n**Exact text** <detail> [not a link](https://outside.invalid/error)\n${'long-native-diagnostic-'.repeat(24)}`;
    const record = codexErrorRecord(binding.history.kind === 'codex' ? binding.history.threadId : 'not-codex', 'failed-turn', { message }, willRetry);
    const row: Row = { ...record, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows.filter(value => value.id !== row.id), row] } });
    views[session].viewport.followLatest(); return { id: row.id, message };
  },
  prompt(question = 'A private fixture response?', submitted = false, choices?: readonly string[]) { const binding = f.bindings.get('b')!; return f.owners.get('b')!.registerCopilot({ token: {}, requestId: null, owner: { nativeAgent: binding.run.nativeSession, relation: 'root' }, method: 'userInput', payload: { question, allowFreeform: true, ...(choices ? { choices } : {}) }, respond: async response => { privateAnswer = String((response as { answer: string }).answer); return submitted ? { kind: 'submitted' } : { kind: 'ack', success: true }; } }).id; },
  permission() { const binding = f.bindings.get('b')!; return f.owners.get('b')!.registerCopilot({ token: {}, requestId: 'explicit-permission', owner: { nativeAgent: binding.run.nativeSession, relation: 'root' }, method: 'permission', payload: { kind: 'mcp', serverName: 'fixture', toolName: 'explicit-confirmation' }, respond: async () => ({ kind: 'ack', success: true }) }).id; },
  codexQuestion() { const binding = f.bindings.get('a')!; return f.owners.get('a')!.registerCodex({ token: {}, requestId: `codex-question-${++codexQuestionSerial}`, owner: { nativeAgent: binding.run.nativeSession, relation: 'root' }, method: 'item/tool/requestUserInput', params: { threadId: binding.run.nativeSession, turnId: 'question-turn', itemId: 'question-item', isBlocking: true, questions: [{ id: 'choice with space', header: 'Choice', question: 'Choose a route', isOther: false, isSecret: false, options: [{ label: 'A', description: 'Native choice description' }, { label: 'B', description: 'Second route' }] }, { id: 'context:question', header: 'Approach', question: 'Choose an independent approach', isOther: true, isSecret: false, options: [{ label: 'C', description: 'Third route' }, { label: 'D', description: 'Fourth route' }] }, { id: 'secret', header: 'Secret', question: 'Private answer', isOther: true, isSecret: true, options: null }] }, respond: async response => { codexQuestionAnswers.push(response); return { kind: 'ack', success: true }; } }).id; },
  plan() { const binding = f.bindings.get('b')!; return f.owners.get('b')!.registerCopilot({ token: {}, requestId: null, owner: { nativeAgent: binding.run.nativeSession, relation: 'root' }, method: 'exitPlan', payload: { summary: 'Review a fixed plan', planContent: '## Fixed plan\n\nDo **this carefully**.', actions: ['interactive', 'exit_only'], recommendedAction: 'interactive' }, respond: async response => { planAnswer = response; return { kind: 'ack', success: true }; } }).id; },
  elicitation() { const binding = f.bindings.get('b')!; return f.owners.get('b')!.registerCopilot({ token: {}, requestId: null, owner: { nativeAgent: binding.run.nativeSession, relation: 'root' }, method: 'elicitation', payload: { sessionId: binding.run.nativeSession, mode: 'form', message: 'Verify bounded fields', requestedSchema: { type: 'object', properties: {
    count: { type: 'integer', title: 'Count', description: 'One through three', minimum: 1, maximum: 3 },
    enabled: { type: 'boolean', title: 'Enabled', description: 'An explicit boolean choice' },
    mode: { type: 'string', title: 'Mode', enum: ['', 'safe'] },
    strategy: { type: 'string', title: 'Strategy', enum: ['first', 'second'] },
    omitted: { type: 'string', title: 'Omitted', enum: ['optional'] },
  }, required: ['count', 'strategy'] } }, respond: async response => { elicitationAnswer = response; return { kind: 'ack', success: true }; } }).id; },
  promptAnswers: () => ({ elicitation: elicitationAnswer, plan: planAnswer, codexQuestions: codexQuestionAnswers }),
  completePrompt(id: string) { const binding = f.bindings.get('b')!; f.owners.get('b')!.completed(id, binding.run); },
  loseResponse() { const submit = f.native.submit.bind(f.native); f.native.submit = async request => { f.native.submit = submit; await submit(request); throw Error('Scripted reply loss after admission'); }; },
  privateAnswer: () => privateAnswer,
  previewCounts: () => ({ acquired: acquiredPreviews, released: releasedPreviews, held: heldPreview !== null, hostReadLeases: reads.size }),
  fileStats: () => ({ captures, hostReadLeases: reads.size }),
  childStats: () => ({ inventoryReads, older: f.counts().older }),
  children(session: 'a' | 'b', optional = false) {
    const root = f.bindings.get(session)!.history, child: Scope = root.kind === 'codex' ? { ...root, threadId: 'codex-child' } : { kind: 'copilot', origin: root.origin, agentId: 'copilot-child' };
    knownChildren.set(session, [child]); const client = f.history.session(child).client;
    if (!client.current || optional) { const version = (client.current?.rows.find(row => row.id === 'child-row')?.version ?? 0) + 1;
      client.apply({ kind: 'snapshot', snapshot: { scope: child, generation: 'host-generation', revision: (client.current?.revision ?? 0) + 1, rows: [{ id: 'child-row', kind: 'assistant', lifecycle: 'completed', body: { kind: 'complete', text: `AUTHENTICATED_${child.kind.toUpperCase()}_CHILD`, evidence: 'nativeFullBody' }, native: optional ? { type: 'agentMessage', delivery: 'async', questions: [{ title: 'Child question stays read only', options: ['Child choice'] }] } : {}, version, contentVersion: version }], retirements: [], olderEdge: { state: 'available', cursor: 'owned-child-edge' }, coverage: { knownStart: true, gaps: [] }, activity: { turnId: null, state: 'idle' } } }); }
  },
  mutateGuide: () => documentFiles.set('docs/guide.md', encode('# Changed file must not replace the captured occurrence')),
  documents() { const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const row: Row = { id: 'local-documents', kind: 'assistant', lifecycle: 'completed', body: { kind: 'complete', text: '[Guide](docs/guide.md) [HTML](docs/unsafe.html) [Large HTML](docs/large.html) [PDF](docs/pages.pdf) [Original binary](docs/original.bin)', evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [row] } });
  },
  resolvePreview() { heldPreview?.(); heldPreview = null; },
  media(id = 'preview', kind: Row['kind'] = 'assistant') { const binding = f.bindings.get('a')!, client = f.history.session(binding.history).client, current = client.current!;
    previewArtifacts.set(id, { kind: 'artifact', owner: { ...binding.run.scope, session: binding.run.nativeSession }, id, name: `${id}.png`, mediaType: 'image/png', bytes: imageBytes.length, sha256: imageSha, capturedAt: 1 }); artifactBytes.set(id, imageBytes);
    const row: Row = { id: `media-${id}`, kind, lifecycle: 'completed', body: { kind: 'complete', text: 'A captured attachment', evidence: 'nativeFullBody' }, native: { media: [{ id: `occurrence-${id}`, kind: 'image', source: 'native', state: 'available', artifactId: id }] }, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row] } });
  },
  visualMarkdown() { const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const row: Row = { id: 'inline-local-image', kind: 'assistant', lifecycle: 'completed', body: { kind: 'complete', text: '![Local picture](docs/picture.png)\n\n![External image](https://outside.invalid/tracker.png)', evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row] } }); views.a.viewport.followLatest();
  },
  archiveVisualFixture() { f.native.publish(f.bindings.get('a')!.run.scope, { phase: 'stopped', activity: 'idle', archive: { id: 'scripted-visual-archive', state: 'complete' } }); },
  rich() { const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const rows: Row[] = [{ id: 'rich', kind: 'assistant', lifecycle: 'completed', body: { kind: 'complete', evidence: 'nativeFullBody', text: 'Inline $x^2$ and display:\n\n$$\n\\frac{1}{2}\n$$\n\n```mermaid\nflowchart LR\nA[Gateway] --> B[Host]\n```\n\n![blocked](https://outside.invalid/tracker.png)\n\n```mermaid\nflowchart LR\nA["<img src=\"https://outside.invalid/mermaid.png\">"] --> B[Safe]\n```' }, native: {}, version: 1, contentVersion: 1 }];
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows } }); views.a.viewport.followLatest();
  },
  activity() { const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const row: Row = { id: 'captured-running-tool', kind: 'tool', lifecycle: 'running', body: { kind: 'partial', text: 'Exact retained terminal output\n'.repeat(120), missing: ['final'] }, native: {}, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row] } });
  },
  history(count = 60, expandable = false) { const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const rows: Row[] = Array.from({ length: count }, (_, index) => ({ id: `long-${index}`, kind: index % 4 === 0 ? 'user' : 'assistant', lifecycle: 'completed', body: { kind: 'complete', text: `Message ${index}\n\nA paragraph with **formatting**, a [link](https://example.invalid/) and enough text to exercise retained scrolling.\n\n\`\`\`ts\nconst longValue = '${'x'.repeat(180)}';\n\`\`\``, evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 }));
    if (expandable) rows.splice(20, 0, { id: 'scroll-earlier-tool', kind: 'tool', lifecycle: 'completed', body: { kind: 'complete', text: 'Retained tool output\n'.repeat(60), evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 });
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows } });
  },
  historyTools() { const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const rows: Row[] = Array.from({ length: 64 }, (_, index) => {
      const kind = index % 11 === 0 ? 'assistant' : index % 13 === 0 ? 'user' : 'tool';
      return { id: `compact-${index}`, kind, lifecycle: 'completed', body: { kind: 'complete', text: kind === 'tool' ? 'Retained tool output\n'.repeat(12) : 'A retained paragraph with enough words to wrap at the ordinary content measure. '.repeat(index % 3 + 1), evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 };
    });
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows } });
  },
  scrollState() { const value = views.a.getSnapshot(); return value.kind === 'codex' ? value.history.viewport : null; },
  scrollReset() { f.history.session(f.bindings.get('a')!.history).client.view('main').resetPaging(); views.a.viewport.followLatest(); },
  armWheelGrowth(touch = false) {
    const eventName = touch ? 'touchmove' : 'wheel';
    document.addEventListener(eventName, function grow(event) {
      if (!(event.target instanceof Element) || !event.target.closest('#chat-container [data-action=history]')) return;
      document.removeEventListener(eventName, grow);
      // The actual React wheel handler ran, but the browser has not yet performed
      // its default scroll. A synchronous streamed update exercises that gap.
      flushSync(() => {
        const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
        const row: Row = { id: `wheel-growth-${++wheelGrowths}`, kind: 'assistant', lifecycle: 'running', body: { kind: 'partial', text: 'A streamed line\n'.repeat(30), missing: ['final'] }, native: {}, version: 1, contentVersion: 1 };
        client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row] } });
      });
    });
  },
  wheelGrowths: () => wheelGrowths,
  holdSubmission() { if (submissionGate) throw Error('One held receipt'); submissionGate = deferred<void>(); },
  releaseSubmission() { const gate = submissionGate; submissionGate = null; gate?.resolve(); },
  authoringTail() {
    const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    // Previous scroll cases intentionally retained several replaced windows.
    // This native-shaped current window proves the actual retained tail order.
    const rows = client.view('main').getSnapshot().rows.slice(-64);
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows } });
  },
  holdOwnMessage() { if (ownMessageArmed || ownMessage) throw Error('One held own-message observation'); ownMessageArmed = true; },
  releaseOwnMessage() {
    const message = ownMessage; if (!message) throw Error('No admitted own message'); ownMessage = null;
    const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const row: Row = { id: message.id, kind: 'user', lifecycle: 'completed', body: { kind: 'complete', text: message.text, evidence: 'nativeFullBody' }, native: { type: 'userMessage', turnId: 'authoring-turn' }, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row] } }); return row.id;
  },
  growProgress(id: string) {
    const client = f.history.session(f.bindings.get('a')!.history).client, current = client.current!;
    const row = current.rows.find(value => value.id === id); if (!row || row.body.kind === 'unavailable') throw Error('No captured assistant row');
    const grown: Row = { ...row, body: { ...row.body, text: row.body.text + '\n\nA later streamed paragraph with **formatting**.\n\n'.repeat(12) }, version: row.version + 1, contentVersion: row.contentVersion + 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: current.rows.map(value => value.id === id ? grown : value) } });
  },
  holdProtection() { protectionEntered = false; protectionGate = deferred<void>(); },
  protectionEntered: () => protectionEntered,
  releaseProtection() { const gate = protectionGate; protectionGate = null; gate?.resolve(); },
  commands: () => f.native.submitted.map(value => value.command.type),
  progress(mode: 'working' | 'idle' | 'stopped' | 'disconnected' | 'gap', missing: readonly ('prefix' | 'interior' | 'final' | 'truncated')[] = ['final']) {
    const binding = f.bindings.get('a')!, client = f.history.session(binding.history).client, current = client.current!, native = f.snapshot('a'), working = mode !== 'idle' && mode !== 'stopped';
    const row: Row = { id: `progress-${++progressRevision}`, kind: 'assistant', lifecycle: working ? 'running' : 'completed', body: { kind: 'partial', text: 'A positively captured assistant update\n\n'.repeat(12), missing }, native: { turnId: 'authoring-turn' }, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row], activity: { state: working ? 'working' : 'idle', turnId: working ? 'authoring-turn' : null }, scopeInventory: { nativeGeneration: binding.run.generation, entries: [{ scope: binding.history }] }, coverage: { ...current.coverage, gaps: mode === 'gap' ? [{ id: CAPTURE_GAP_ID, kind: 'nativeGap' }] : [] } } });
    f.observation({ scope: native.scope, kind: 'session', state: mode === 'disconnected' ? 'disconnected' : 'live' });
    f.observation({ scope: native.scope, kind: 'history', history: binding.history, state: mode === 'disconnected' ? 'disconnected' : 'live' });
    f.native.publish(native.scope, { phase: mode === 'stopped' ? 'stopped' : 'running', activity: working ? 'working' : 'idle', capabilities: { ...native.capabilities, commands: [...new Set([...native.capabilities.commands, 'codex.steer', 'codex.queue.add'] as const)] } });
    return row.id;
  },
  compaction(mode: 'working' | 'completed' | 'unconfirmed' | 'disconnected' | 'foreign-turn' | 'failed' | 'interrupted') {
    const binding = f.bindings.get('a')!, client = f.history.session(binding.history).client, current = client.current!, native = f.snapshot('a');
    const serial = ++progressRevision, turnId = `compaction-turn-${serial}`, working = ['working', 'disconnected', 'foreign-turn'].includes(mode);
    const row: Row = { id: `compaction-${serial}`, kind: 'notice', lifecycle: working ? 'running' : mode === 'failed' || mode === 'interrupted' ? mode : 'completed', body: mode === 'unconfirmed' ? { kind: 'partial', text: '', missing: ['final'] } : { kind: 'unavailable', reason: 'nativeOmitted' }, native: { type: 'contextCompaction', turnId, ...(mode === 'completed' ? { compactionCompleted: true } : {}) }, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row], activity: { state: working ? 'working' : 'idle', turnId: working ? mode === 'foreign-turn' ? 'a-different-turn' : turnId : null }, scopeInventory: { nativeGeneration: binding.run.generation, entries: [{ scope: binding.history }] }, coverage: { ...current.coverage, gaps: [] } } });
    f.observation({ scope: native.scope, kind: 'session', state: mode === 'disconnected' ? 'disconnected' : 'live' });
    f.observation({ scope: native.scope, kind: 'history', history: binding.history, state: mode === 'disconnected' ? 'disconnected' : 'live' });
    f.native.publish(native.scope, { phase: 'running', activity: working ? 'working' : 'idle' });
    return row.id;
  },
  partialTool(empty: boolean) {
    const binding = f.bindings.get('a')!, client = f.history.session(binding.history).client, current = client.current!;
    const row: Row = { id: `partial-tool-${++progressRevision}`, kind: 'tool', lifecycle: 'completed', body: { kind: 'partial', text: empty ? '' : 'Positively retained tool output', missing: empty ? ['prefix', 'final'] : ['truncated'] }, native: { type: 'commandExecution' }, version: 1, contentVersion: 1 };
    client.apply({ kind: 'snapshot', snapshot: { ...current, revision: current.revision + 1, rows: [...current.rows, row] } }); return row.id;
  },
  readAt(rowId: string, offset = 16) {
    const container = document.querySelector<HTMLElement>('#chat-container [data-action=history]')!, row = [...container.querySelectorAll<HTMLElement>('[data-row]')].find(value => value.dataset.row === rowId)!;
    container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top + offset;
    views.a.viewport.userScroll('earlier', false); views.a.viewport.report({ rowId, offsetPx: container.getBoundingClientRect().top - row.getBoundingClientRect().top });
  },
  holdOlder() { if (heldOlder) throw Error('One held older read only'); heldOlder = deferred<HistoryPage>(); },
  releaseOlder(empty: boolean, count = 1) {
    const gate = heldOlder, input = olderInput; if (!gate || !input) throw Error('No admitted older read'); heldOlder = null; olderInput = null;
    gate.resolve({ scope: input.scope, generation: input.generation!, ...(input.readContext === undefined ? {} : { readContext: input.readContext }),
      rows: empty ? [] : Array.from({ length: count }, (_, index) => ({ id: count === 1 ? 'scroll-prepended' : `scroll-prepended-${index}`, kind: 'assistant', lifecycle: 'completed', body: { kind: 'complete', text: count === 1 ? 'A real earlier page\n'.repeat(20) : `An earlier message ${index}`, evidence: 'nativeFullBody' }, native: {}, version: 1, contentVersion: 1 })),
      olderEdge: empty ? { state: 'end', evidence: 'nativeBoundary' } : { state: 'available', cursor: 'scroll-terminal-page' } });
  },
  unmount() { root.unmount(); }, remount() { root = createRoot(document.getElementById('app')!); root.render(h(StrictMode, null, h(Shell))); }, close: () => { protectionGate?.resolve(); submissionGate?.resolve(); f.workspace.close(); },
} });
