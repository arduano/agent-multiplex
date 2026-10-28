import { createElement as h, useState, type ReactNode } from 'react';
import type { AgentSnapshot, WorkspaceView } from '../../v8-workspace/src/contracts.js';
import type { ReadonlyHistorySnapshot } from '../../v8-workspace/src/history-view.js';
import { rootPlan, planImplementationText } from '../../v8-workspace/src/plan-action.js';
import { operationLabel } from './operations.js';
import type { ViewSnapshot } from '../../v8-history/src/client/history-client.js';
import { CAPTURE_GAP_ID, type Row } from '../../v8-history/src/contracts/types.js';
import { rowMedia } from '../../v8-history/src/contracts/media.js';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import { LocalFilePreview, type LocalPreviewOptions, type PreviewOptions } from './files.js';
import { ChatMarkdown, type MarkdownFileAdapters } from './markdown.js';
import { authenticatedFileAddress, fileLinkTarget, localFileReference, type LocalFileReference } from './file-reference.js';
import { InlineMedia } from './inline-media.js';
import { Button } from './ui/index.js';
import { conversationKey, sameScope } from '../../v8-history/src/contracts/identity.js';
import { useTranscriptViewport } from './transcript-viewport.js';
import { HistoryBoundary, historyBoundaryKey } from './history-boundary.js';
import { codexOptionalQuestions } from '../../v8-history/src/native/codex/questions.js';
import { codexErrorRow, type CodexErrorRow } from '../../v8-history/src/native/codex/errors.js';
import { OptionalQuestions, type OptionalReply } from './optional-questions.js';
export type TranscriptView = Pick<WorkspaceView, 'viewport' | 'setExpanded' | 'loadOlder' | 'recoverHistory'> & Partial<Pick<WorkspaceView, 'implementPlan'>> & Readonly<{ getSnapshot(): AgentSnapshot | ReadonlyHistorySnapshot }>;

function CompactionNotice({ row, inProgress }: Readonly<{ row: Row; inProgress: boolean }>) {
  let text = 'Compaction status unavailable';
  if (row.lifecycle === 'completed' && row.native.compactionCompleted === true) text = 'Context compacted';
  else if (row.lifecycle === 'failed') text = 'Context compaction failed';
  else if (row.lifecycle === 'interrupted') text = 'Context compaction interrupted';
  else if (inProgress) text = 'Compacting context…';
  else if (row.lifecycle === 'running') text = 'Last observed: compacting context';
  return h('p', { className: `mpx-chat__compaction${inProgress ? ' mpx-chat__working' : ''}`, 'data-action': 'compaction-status', ...(inProgress ? { role: 'status' } : {}) }, text);
}
function HistoryRow({ row, expanded, toggle, preview, fileAdapters, previewOptions, archived, inProgress, compaction = false, nativeError, planAction, optionalQuestions, duplicateQuestionBody = false }: Readonly<{ row: Row; expanded: boolean; toggle(expanded: boolean): void; preview(id: string): Promise<ResourceLease>; fileAdapters: MarkdownFileAdapters; previewOptions: PreviewOptions; archived: boolean; inProgress: boolean; compaction?: boolean; nativeError?: CodexErrorRow; planAction?: ReactNode; optionalQuestions?: ReactNode; duplicateQuestionBody?: boolean }>) {
  if (compaction) return h('article', { className: 'mpx-chat__row mpx-chat__row--notice', 'data-row': row.id, 'data-kind': row.kind, 'data-lifecycle': row.lifecycle }, h('div', { className: 'mpx-chat__row-body' }, h(CompactionNotice, { row, inProgress })));
  const { diagramRendererUrl, cspNonce } = previewOptions;
  const activity = ['tool', 'reasoning', 'delegation'].includes(row.kind), open = expanded;
  const errorLabel = nativeError ? nativeError.willRetry ? 'Retry notice' : 'Agent error' : undefined;
  const emptyTool = row.kind === 'tool' && row.body.kind === 'partial' && row.body.text.length === 0;
  const body = nativeError ? h('p', { className: 'mpx-chat__native-error-message' }, nativeError.message) : emptyTool ? null : row.body.kind === 'unavailable' ? h('p', { className: 'mpx-chat__muted' }, `Content unavailable (${row.body.reason})`) :
    row.kind === 'tool' ? h('pre', { className: 'mpx-chat__terminal', tabIndex: 0, role: 'region', 'aria-label': 'Tool output' }, row.body.text) : h(ChatMarkdown, { text: row.body.text, streaming: inProgress, ...(!archived ? fileAdapters : {}), ...(diagramRendererUrl ? { diagramRendererUrl } : {}), ...(cspNonce ? { cspNonce } : {}) });
  const missing = row.body.kind === 'partial' ? row.body.missing.filter(value => !inProgress || value !== 'final') : [];
  const missingText = { prefix: 'Beginning not captured', interior: 'Some content not captured', final: 'Final content not captured', truncated: 'Content truncated' };
  const partialLabel = emptyTool ? 'Tool output not captured' : row.kind === 'tool' ? 'Partial output' : row.kind === 'user' || row.kind === 'assistant' ? 'Message excerpt' : row.kind === 'reasoning' ? 'Reasoning excerpt' : 'Partial capture';
  const content = h('div', { className: 'mpx-chat__row-body' }, duplicateQuestionBody ? null : body, optionalQuestions,
    missing.length ? h('details', { className: 'mpx-chat__partial', 'data-action': 'partial-content' }, h('summary', null, partialLabel), h('p', null, missing.map(value => missingText[value]).join('. ') + '.')) : null);
  // Native image output remains visible when its textual tool output is folded.
  const mediaContent = rowMedia(row).length ? h('div', { className: 'mpx-chat__row-media' }, ...rowMedia(row).map(media => h('div', { key: media.id, 'data-media': media.id },
    media.state === 'available' && media.artifactId ? h(InlineMedia, { identity: media.artifactId, load: () => preview(media.artifactId!), label: 'Agent image', disabled: archived }) : h('small', null, `Agent image · ${archived ? 'resource access retired' : media.state}`)))) : null;
  return h('article', { className: `mpx-chat__row mpx-chat__row--${row.kind}${nativeError ? ' mpx-chat__row--native-error' : ''}`, ...(nativeError ? { role: 'note', 'aria-label': errorLabel, 'data-action': 'native-error' } : {}), 'data-row': row.id, 'data-kind': row.kind, 'data-lifecycle': row.lifecycle },
    activity ? h('details', { open, onToggle: (event: { currentTarget: HTMLDetailsElement }) => { if (event.currentTarget.open !== open) toggle(event.currentTarget.open); } },
      h('summary', null, h('span', null, row.kind === 'delegation' ? 'Subagent' : row.kind === 'reasoning' ? 'Reasoning' : 'Tool / terminal'), h('small', null, row.lifecycle === 'running' ? 'Last captured: running' : row.lifecycle)), content)
      : h('div', null, h('div', { className: 'mpx-chat__speaker' }, errorLabel ?? (row.native.type === 'plan' ? 'Plan' : row.kind === 'user' ? 'You' : row.kind === 'assistant' ? 'Agent' : 'Notice')), content, planAction), mediaContent);
}
export function Transcript({ view, history, preview, previewLocal, previewOptions, run, emptyLabel = 'Start a conversation', emptyContent, footer, archived = false, nativeWorking = false, onOptionalReply }: Readonly<{ view: TranscriptView; history: ViewSnapshot; preview(id: string): Promise<ResourceLease>; previewLocal(reference: LocalFileReference): Promise<ResourceLease>; previewOptions: PreviewOptions; run(work: () => Promise<unknown>): void; emptyLabel?: string; emptyContent?: ReactNode; footer?: ReactNode; archived?: boolean; nativeWorking?: boolean; onOptionalReply?: OptionalReply }>) {
  const { element, boundaryElement, footerElement, beforeHistoryRead, ...input } = useTranscriptViewport(view, history);
  const [selected, setSelected] = useState<Readonly<{ path: string; trigger: HTMLElement; options: LocalPreviewOptions }> | null>(null);
  const snapshot = view.getSnapshot();
  const current = history.current;
  const freshWork = snapshot.kind === 'codex' || snapshot.kind === 'copilot' ? snapshot.session.connected && !snapshot.session.stale && !snapshot.session.requiresRebind && !snapshot.session.issue && snapshot.observation.session === 'live' && snapshot.observation.history === 'live' && snapshot.session.native?.phase === 'running' && !snapshot.session.native.stopRequested && snapshot.session.native.activity === 'working' && current?.scope.origin.nativeSession === snapshot.session.native.nativeSession && current.scopeInventory?.nativeGeneration === snapshot.session.native.generation
    : snapshot.kind === 'ready' && snapshot.observation === 'live' && nativeWorking;
  // Native activity and captured progress are independent facts. Missing
  // transcript updates cannot hide positively observed native work.
  const working = !archived && freshWork;
  const capturedWorking = working && current?.activity.state === 'working' && !current.coverage.gaps.some(gap => gap.id === CAPTURE_GAP_ID);
  const inProgress = (row: Row) => {
    if (!capturedWorking || !current) return false;
    const origin = history.origins[row.id];
    return row.lifecycle === 'running' && !!origin && origin.source === 'current' && origin.generation === current.generation && sameScope(origin.scope, current.scope) && !!current.activity.turnId && row.native.turnId === current.activity.turnId;
  };
  const compaction = (row: Row) => (history.origins[row.id]?.scope ?? current?.scope)?.kind === 'codex' && row.kind === 'notice' && row.native.type === 'contextCompaction';
  const compacting = history.rows.some(row => compaction(row) && inProgress(row));
  const planAction = (row: Row) => {
    if (archived || !view.implementPlan || snapshot.kind !== 'codex' || row.native.type !== 'plan') return undefined;
    const native = snapshot.session.native, original = snapshot.planActions.find(value => value.rowId === row.id);
    const operation = original?.originalId ? snapshot.operations.find(value => value.id === original.originalId) : undefined;
    const visible = !!native?.nativeSession && native.selection.kind === 'codex' && native.selection.collaboration?.mode === 'plan' && !!history.current && !!rootPlan(history, history.current.scope, { scope: native.scope, generation: native.generation, nativeSession: native.nativeSession }, row.id);
    let issue: string | undefined;
    if (visible) try { planImplementationText(row); } catch (error) { issue = error instanceof Error ? error.message : 'This plan cannot be sent automatically.'; }
    const allowed = visible && !issue && snapshot.sendReady && !snapshot.session.activeJobs && snapshot.sendPreparation.state !== 'preparing' && native!.activity === 'idle' && native!.interactions.length === 0;
    if (!visible && !original) return undefined;
    return h('div', { 'data-action': 'plan-actions' }, h(Button, { type: 'button', variant: 'outline', 'data-action': 'implement-plan', disabled: !allowed || !!original, title: issue ?? 'Leave Plan mode and ask Codex to implement this plan. Your message draft and files stay here.', onClick: () => run(async () => { const action = await view.implementPlan!(row.id); await action.result; }) }, 'Implement plan'),
      issue && !original ? h('p', { className: 'mpx-chat__muted' }, issue) : null,
      original ? h('p', { role: 'status' }, operation ? operationLabel(operation) : original.originalId ? 'Check the saved original implementation request.' : 'Preparing implementation request…') : null);
  };
  return h('div', { className: 'mpx-chat__transcript-wrap' },
    h('div', { ref: element, className: 'mpx-chat__transcript', tabIndex: 0, role: 'region', 'aria-label': 'Conversation history', 'data-action': 'history', ...input },
      h('div', { ref: boundaryElement, className: 'mpx-chat__history-boundary' }, h(HistoryBoundary, { key: historyBoundaryKey(history), view, history, archived, beforeRead: beforeHistoryRead })),
      !history.rows.length ? h('div', { className: 'mpx-chat__empty' }, emptyContent ?? [h('p', { key: 'title' }, history.olderEdge.state === 'unknown' ? 'History not loaded' : emptyLabel), h('p', { key: 'description' }, history.olderEdge.state === 'unknown' ? history.olderEdge.reason : 'Messages and native activity will appear here.')]) : null,
      ...history.rows.map(row => {
        const scope = history.origins[row.id]?.scope ?? history.current?.scope, occurrence = JSON.stringify([scope ? conversationKey(scope) : null, row.id]);
        const optional = scope?.kind === 'codex' && row.kind === 'assistant' && row.native.type === 'agentMessage' ? codexOptionalQuestions(row.native.questions) : undefined;
        const questions = optional?.questions ?? [];
        const omitted = optional ? optional.omitted + (typeof row.native.questionsOmitted === 'number' && Number.isSafeInteger(row.native.questionsOmitted) && row.native.questionsOmitted > 0 ? row.native.questionsOmitted : 0) : 0;
        const duplicateQuestionBody = questions.length > 0 && row.native.delivery === 'async' && omitted === 0 && row.body.kind === 'complete' && row.body.text === questions.map(question => [question.title, ...question.options.map(option => `- ${option}`)].join('\n')).join('\n\n');
        const optionalQuestions = questions.length || omitted ? h(OptionalQuestions, { questions, omitted, ...(!archived && onOptionalReply ? { onReply: onOptionalReply } : {}) }) : undefined;
        const reference = (href: string, key = occurrence) => { const target = fileLinkTarget(href); return target.kind === 'local' ? localFileReference(key, target.path, scope, target.fragment) : undefined; };
        const fileAdapters: MarkdownFileAdapters = {
          onLocalFile: (href, trigger) => {
            const source = reference(href); if (!source || view.getSnapshot().kind === 'disposed') return;
            setSelected({ path: source.path, trigger, options: { ...previewOptions, occurrence, ...(scope ? { historyScope: scope } : {}), preview: previewLocal } });
          },
          localMedia: ({ href, alt }) => {
            // Preserve the existing click-preview capture key across UI upgrades.
            const source = reference(href); return source ? h(InlineMedia, { identity: source.sourceKey, load: () => previewLocal(source), label: alt, disabled: archived }) : null;
          },
          ...(previewOptions.fileAddress ? { localFileAddress: (href: string) => { const source = reference(href); return source && typeof location !== 'undefined' ? authenticatedFileAddress(previewOptions.fileAddress!({ sessionId: previewOptions.sessionId, source }), location.href) : undefined; } } : {}),
        };
        const nativeError = scope?.kind === 'codex' ? codexErrorRow(row) : undefined;
        return h(HistoryRow, { key: row.id, row, archived, inProgress: inProgress(row), compaction: compaction(row), ...(nativeError ? { nativeError } : {}), previewOptions, planAction: planAction(row), optionalQuestions, duplicateQuestionBody, expanded: history.expansions.includes(row.id), toggle: (expanded: boolean) => view.setExpanded(row.id, expanded), preview, fileAdapters });
      }), h('div', { ref: footerElement, className: 'mpx-chat__transcript-footer' }, working && !compacting ? h('div', { className: 'mpx-chat__working', role: 'status', 'data-action': 'working-indicator' }, 'Working…') : null, footer)),
    !archived ? h(LocalFilePreview, { selected, close: () => setSelected(null) }) : null,
    history.viewport.intent === 'readingHistory' ? h('button', { className: 'mpx-chat__jump', type: 'button', onClick: () => view.viewport.followLatest() }, 'Jump to latest') : null);
}
