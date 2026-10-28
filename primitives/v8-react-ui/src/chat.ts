import { createElement as h, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAgent } from '../../v8-workspace/src/react.js';
import type { AgentSnapshot, WorkspaceView } from '../../v8-workspace/src/contracts.js';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import type { ArtifactRef } from '../../v8-files/src/contracts/types.js';
import type { Selection } from '../../v8-session/src/contracts/types.js';
import { CAPTURE_GAP_ID } from '../../v8-history/src/contracts/types.js';
import type { CodexOptionalQuestion } from '../../v8-history/src/native/codex/questions.js';
import { imageType } from '../../v8-files/src/contracts/content.js';
import { svgInputToPng } from '../../v8-files/src/client/svg.js';
import { chatThemeStyle, type ChatThemeTokens } from './theme.js';
import { Transcript } from './transcript.js';
import { AgentControls } from './controls.js';
import { NativeActions } from './native-actions.js';
import { CodexGoalControl } from './native-goal.js';
import { RequestArea } from './prompts.js';
import { ComposerTextarea, useChatLayout } from './composer.js';
import { Button, IconButton, Dialog, DialogContent, DialogTitle, DialogClose, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/index.js';
import { isUnresolved, OperationHistory, OperationNotice, OperationStatusList } from './operations.js';
import { ToolConnections } from './tools.js';
import { AttachmentChips, Files } from './files.js';
import { SessionStatus } from './status.js';
import { resolveChatShortcut, shortcutSuggestions } from './slash.js';
import type { FileAddress, LocalFileReference } from './file-reference.js';
import { ChildHistories } from './child-history.js';

export type MultiplexChatProps = Readonly<{
  view: WorkspaceView;
  theme?: Partial<ChatThemeTokens>; className?: string; style?: CSSProperties;
  /** false removes only the heading; native state and pending requests remain visible. */
  header?: ReactNode | false;
  /** Shell presentation only; these slots receive no independent authority. */
  title?: ReactNode; subtitle?: string; headerLeading?: ReactNode; headerActions?: ReactNode;
  assets?: Readonly<{ diagramRendererUrl?: string; cspNonce?: string; pdfResourceBaseUrl?: string }>;
  /** Trusted shell route only. The viewer validates same-origin; the server
   * must reauthenticate and reauthorize each navigation independently. */
  fileAddress?: FileAddress;
  /** Advanced shells may provide their own MCP panel over the same workspace. */
  showMcp?: boolean;
  /** Optional shell navigation; native shortcuts retain this view's owner. */
  onNewConversation?(): void;
  onShowSessionDetails?(): void;
}>;
type Ready = Extract<AgentSnapshot, { kind: 'codex' | 'copilot' }>;
type DraftAction = 'send' | 'steer' | 'queue';
const icon = (path: string) => h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path }));
function draftDisabled(snapshot: Ready, action: DraftAction): boolean {
  return !snapshot.draftActions[action] || snapshot.sendPreparation.state === 'preparing' ||
    ['loading', 'unavailable', 'disposed'].includes(snapshot.composer.state) ||
    !snapshot.composer.value.text.trim() && !snapshot.composer.value.fileIds.length;
}
function ConversationHeader({ snapshot, header, title, subtitle, headerLeading, headerActions }: MultiplexChatProps & Readonly<{ snapshot: Ready }>) {
  if (header === false) return h(SessionStatus, { snapshot });
  return h('header', { className: 'mpx-chat__heading', 'data-action': 'conversation-header' },
    header ?? h('div', { className: 'mpx-chat__heading-main' }, headerLeading,
      h('div', { className: 'mpx-chat__heading-title' }, h('h2', null, title ?? snapshot.logical.entry?.metadata.name ?? snapshot.sessionId), h('p', null, subtitle ?? snapshot.logical.entry?.metadata.cwd ?? 'Agent workspace')), headerActions),
    h(SessionStatus, { snapshot }));
}
/** No allocation/IO in render: the supplied prepared view owns conversation,
 * draft, files, receipt and viewport state; useAgent owns one commit lease. */
export function MultiplexChat(props: MultiplexChatProps) {
  const identity = useRef({ view: props.view, version: 0 });
  if (identity.current.view !== props.view) identity.current = { view: props.view, version: identity.current.version + 1 };
  const snapshot = useAgent(props.view), shell = { className: `multiplex-chat${props.className ? ` ${props.className}` : ''}`, style: { ...chatThemeStyle(props.theme), ...props.style } };
  if (snapshot.kind === 'disposed') return h('section', shell, h('p', { role: 'status' }, 'Workspace closed'));
  if (snapshot.kind === 'unavailable') return h('section', shell, h('p', { role: 'status' }, 'Waiting for session observation'));
  return h('section', { ...shell, 'aria-label': snapshot.logical.entry?.metadata.name ?? 'Agent conversation', 'data-session': snapshot.sessionId },
    h(Conversation, { key: identity.current.version, ...props, snapshot }));
}
function Conversation(props: MultiplexChatProps & Readonly<{ snapshot: Ready }>) {
  const { view, snapshot, assets, fileAddress, showMcp = true, onNewConversation, onShowSessionDetails } = props;
  const sessionId = snapshot.sessionId, inputId = useId(), fileId = useId(), cameraId = useId();
  const [error, setError] = useState('');
  const active = useRef<symbol | null>(null), fileInput = useRef<HTMLInputElement | null>(null), cameraInput = useRef<HTMLInputElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null), shortcutRunning = useRef(false);
  const layout = useChatLayout(surface);
  const [shortcutNotice, setShortcutNotice] = useState('');
  const [toolsPanel, setToolsPanel] = useState<'native' | 'mcp' | 'agents' | null>(null), [goalOpen, setGoalOpen] = useState(false);
  const toolsTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { const token = Symbol('committed-chat'); active.current = token; return () => { if (active.current === token) active.current = null; }; }, [view]);
  const run = (work: () => Promise<unknown>) => { const token = active.current; setError(''); void Promise.resolve().then(work).catch(() => { if (token && token === active.current) setError('This action could not be observed. Review Activity before trying it again. Your draft and originals are retained.'); }); };
  const sync = (work: () => unknown) => { try { setError(''); work(); } catch { setError('This action is unavailable. Your draft is retained.'); } };
  const openPreview = (artifact: ArtifactRef | string) => typeof artifact === 'string' ? view.previewCapturedFile(artifact) : view.previewFile(artifact);
  const previewLocal = async (reference: LocalFileReference) => view.previewFile(await view.captureFile({ sourceKey: reference.sourceKey, path: reference.path }, reference.historyScope));
  const previewOptions = { sessionId, ...assets, ...(fileAddress ? { fileAddress } : {}) };
  const edit = (value: { text?: string; fileIds?: readonly string[] }) => sync(() => { const current = view.getSnapshot(); if (current.kind !== 'disposed') view.setDraft({ ...current.composer.value, ...value }); });
  // Optional native callouts have no pending callback. A choice is only a
  // retained draft edit; the existing Send/Steer action owns later submission.
  const draftOptionalReply = (question: CodexOptionalQuestion, answer?: string) => sync(() => {
    const current = view.getSnapshot();
    if (current.kind !== 'codex' || !current.access.control || current.logical.entry?.archive || current.session.native?.archive || ['loading', 'disposed'].includes(current.composer.state)) return;
    const value = current.composer.value, reply = `Regarding: ${question.title}\n${answer ?? ''}`;
    view.setDraft({ ...value, text: value.text ? `${value.text}\n\n${reply}` : reply });
    surface.current?.querySelector<HTMLTextAreaElement>('[data-action=message]')?.focus({ preventScroll: true });
  });
  const attach = async (file: File) => {
    const admitted = view.getSnapshot(); if (admitted.kind === 'disposed' || !admitted.access.fileWrite) return;
    let blob: Blob = file, name = file.name, mediaType = file.type;
    if (imageType(new Uint8Array(await file.arrayBuffer())) === 'image/svg+xml') { blob = (await svgInputToPng(file)).blob; name = `${name.replace(/\.svg$/i, '')}.png`; mediaType = 'image/png'; }
    const record = await view.saveFile({ name, mediaType, blob });
    const current = view.getSnapshot(); if (current.kind === 'disposed') return;
    view.setDraft({ ...current.composer.value, fileIds: [...current.composer.value.fileIds, record.manifest.id] });
    await view.uploadFile(record.manifest.id);
  };
  const native = snapshot.session.native, actions = snapshot.actions, composer = snapshot.composer, preparing = snapshot.sendPreparation.state === 'preparing';
  const header = h(ConversationHeader, props);
  const archive = snapshot.logical.entry?.archive ? { ...snapshot.logical.entry.archive, state: 'complete' as const } : native?.archive;
  if (archive) return h('div', { className: 'mpx-chat__inner' },
    header,
    h('div', { role: 'status', className: 'mpx-chat__notice', 'data-action': 'archive-status' },
      archive.state === 'complete' ? 'Archived. Loaded history and original receipts are retained.' : 'Archive is pending. New work is sealed until cleanup is proved.',
      archive.state === 'complete' && !snapshot.logical.entry?.archive ? h(Button, { variant: 'ghost', type: 'button', 'data-action': 'publish-archive', disabled: !snapshot.access.catalogWrite || !snapshot.session.connected, onClick: () => run(() => view.publishArchive(archive.id, native!.generation)) }, 'Update archived listing') : null),
    h(Transcript, { view, history: snapshot.history, archived: true, previewOptions, preview: (id: string) => openPreview(id), previewLocal, run }),
    h(OperationStatusList, { operations: snapshot.operations, check: (id: string) => run(() => view.checkReceipt(id)) }),
    error ? h('p', { role: 'alert', className: 'mpx-chat__error' }, error) : null);
  const primary: DraftAction = native?.activity === 'working' ? 'steer' : 'send';
  const send = (requested: DraftAction = primary) => {
    setError(''); setShortcutNotice('');
    const current = view.getSnapshot(); if (current.kind !== 'codex' && current.kind !== 'copilot') return;
    const token = active.current, isCurrent = () => token !== null && active.current === token;
    if (requested === 'queue') {
      if (!draftDisabled(current, 'queue')) { try { void view.submitDraft('queue', isCurrent).catch(() => {}); } catch { setError('Queue is unavailable. Your draft is retained.'); } }
      return;
    }
    const text = current.composer.value.text, intent = resolveChatShortcut(text, current);
    const consume = (replacement = '') => { const latest = view.getSnapshot(); if (latest.kind !== 'disposed' && latest.composer.value.text === text) view.setDraft({ ...latest.composer.value, text: replacement }); };
    const select = (selection: Selection) => {
      if (current.kind === 'codex' && selection.kind === 'codex') current.actions.setSelectionDraft(selection);
      else if (current.kind === 'copilot' && selection.kind === 'copilot') current.actions.setSelectionDraft(selection);
    };
    const disclose = (action: string) => {
      if (action === 'controls') { const panel = surface.current?.querySelector<HTMLButtonElement>('[data-action=session-controls]'); if (panel?.getAttribute('aria-expanded') !== 'true') panel?.click(); return !!panel; }
      if (action === 'goal') { setToolsPanel('native'); setGoalOpen(true); return true; }
      setToolsPanel(action === 'mcp' ? 'mcp' : 'native'); return true;
    };
    if (intent.kind === 'error') { setError(intent.message); return; }
    try {
      if (intent.kind === 'selection') { select(intent.selection); consume(); setShortcutNotice(intent.message); return; }
      if (intent.kind === 'local') {
        if (intent.action === 'help') { consume('/'); setShortcutNotice('Choose a command below. Use // to send a literal slash command.'); }
        else if (intent.action === 'new') { if (onNewConversation) { consume(); onNewConversation(); } else setError('This embedded chat does not provide conversation creation.'); }
        else if (intent.action === 'status') { consume(); if (onShowSessionDetails) onShowSessionDetails(); else setShortcutNotice(`${current.kind} · ${current.session.native?.phase ?? 'unobserved'} · ${current.session.native?.activity ?? 'unknown'}. Connection and native lifetime are separate facts.`); }
        else if (disclose(intent.action)) consume();
        else setError('This embedded chat does not provide that panel.');
        return;
      }
      if (intent.kind === 'native') {
        if (!current.access.control) return;
        if (shortcutRunning.current) return; shortcutRunning.current = true;
        const result = intent.run(); consume(); run(() => result.finally(() => { shortcutRunning.current = false; })); return;
      }
      const action = requested;
      if (draftDisabled(current, action)) return;
      if (intent.kind === 'send') select(intent.selection);
      if (intent.text !== text) consume(intent.text);
      void view.submitDraft(action, isCurrent).catch(() => {});
    } catch { shortcutRunning.current = false; setError('The action could not be prepared. Your draft is retained.'); }
  };
  const shortcut = resolveChatShortcut(composer.value.text, snapshot), suggestions = shortcutSuggestions(composer.value.text, snapshot.kind);
  const submitDisabled = shortcut.kind === 'message' || shortcut.kind === 'send' ? draftDisabled(snapshot, primary) : preparing || ['loading', 'unavailable', 'disposed'].includes(composer.state) || shortcut.kind === 'native' && !snapshot.access.control;
  const files = { files: snapshot.files, selected: composer.value.fileIds, edit: (fileIds: readonly string[]) => edit({ fileIds }), preview: (artifact: ArtifactRef) => openPreview(artifact), options: previewOptions, clear: (file: Ready['files'][number]) => run(() => view.clearFile(file.manifest.id, file.revision)) };
  const notice = composer.state === 'unavailable' ? 'Draft storage unavailable · messages paused. Your text remains here.' : !snapshot.access.control ? 'Agent controls are unavailable through this Gateway. Your local draft is retained.' : native?.issue === 'storageUnavailable' ? 'Host storage unavailable · messages paused. Stop remains available.' : native?.issue ? 'Native ownership is unconfirmed. The agent has not been proved stopped.' : snapshot.confirmations?.issue === 'nativeGap' ? 'Sending is paused because the Host lost track of native confirmation requests. Your draft is retained.' : snapshot.confirmations?.issue === 'capacity' ? 'Sending is paused because native confirmation tracking is full. Your draft is retained.' : snapshot.observation.history === 'unavailable' ? 'History connection interrupted. Loaded messages are retained.' : snapshot.history.current?.coverage.gaps.some(gap => gap.id === CAPTURE_GAP_ID) ? 'History capture was interrupted. Some messages may be missing.' : undefined;
  return h('div', { ref: surface, className: 'mpx-chat__inner', onDragOver: (event: { dataTransfer: DataTransfer; preventDefault(): void }) => { if (snapshot.access.fileWrite && event.dataTransfer.types.includes('Files')) event.preventDefault(); }, onDrop: (event: { dataTransfer: DataTransfer; preventDefault(): void }) => { if (!snapshot.access.fileWrite || !event.dataTransfer.files.length) return; event.preventDefault(); const files = [...event.dataTransfer.files]; run(async () => { for (const file of files) await attach(file); }); } },
    header,
    snapshot.session.requiresRebind ? h('div', { className: 'mpx-chat__notice', role: 'status' }, snapshot.bindingTransition?.state === 'preparing' ? 'Connecting the resumed session…' : 'The native session has resumed. Connect its retained view.', h(Button, { variant: 'ghost', type: 'button', disabled: snapshot.bindingTransition?.state === 'preparing', onClick: () => run(() => view.rebind()) }, 'Connect session view')) : null,
    h(Transcript, { view, history: snapshot.history, footer: h(RequestArea, { view, snapshot }), previewOptions, preview: (id: string) => openPreview(id), previewLocal, run,
      ...(snapshot.kind === 'codex' && snapshot.access.control && !['loading', 'disposed'].includes(composer.state) ? { onOptionalReply: draftOptionalReply } : {}) }),
    h('div', { className: 'mpx-chat__dock' },
    h('div', { className: 'mpx-chat__feedback' },
    notice ? h('p', { role: 'status', className: 'mpx-chat__notice' }, notice) : null,
    shortcutNotice ? h('p', { role: 'status', className: 'mpx-chat__notice', 'data-action': 'shortcut-status' }, shortcutNotice) : null,
    suggestions.length ? h('div', { className: 'mpx-chat__suggestions', 'aria-label': 'Slash commands' }, ...suggestions.map(command => h(Button, { variant: 'ghost', key: command, type: 'button', onClick: () => edit({ text: `/${command} ` }) }, `/${command}`))) : null,
    h(OperationNotice, { operations: snapshot.operations, check: (id: string) => run(() => view.checkReceipt(id)) }),
    snapshot.sendPreparation.state === 'failed' ? h('p', { role: 'alert', className: 'mpx-chat__error' }, snapshot.sendPreparation.code === 'UNSUPPORTED' ? 'This action cannot use that attachment. Detach it or choose a supported action.' : 'The message action could not be prepared. Your draft is retained.') : null,
    error ? h('p', { role: 'alert', className: 'mpx-chat__error' }, error) : null),
    h(Dialog, { open: toolsPanel !== null, onOpenChange: open => setToolsPanel(open ? 'native' : null) },
        h(DialogContent, { container: layout.container, className: 'mpx-chat__session-tools', 'aria-describedby': undefined, onCloseAutoFocus: event => { event.preventDefault(); toolsTrigger.current?.focus(); } }, h(DialogTitle, { asChild: true }, h('h3', null, 'Session tools')),
          h('div', { className: 'mpx-chat__secondary-actions' }, h(Files, { ...files, inline: true }), snapshot.kind === 'codex' ? h(CodexGoalControl, { snapshot, run, open: goalOpen, onOpenChange: setGoalOpen }) : null, h(OperationHistory, { operations: snapshot.operations, check: (id: string) => run(() => view.checkReceipt(id)) })),
          h(NativeActions, { snapshot, text: composer.value.text, hasFiles: composer.value.fileIds.length > 0, run, showGoal: false, open: toolsPanel === 'native' }),
          showMcp ? h(ToolConnections, { snapshot: snapshot.mcp, stale: snapshot.mcpStale, connected: snapshot.session.connected, canRefresh: snapshot.access.mcpRefresh, refresh: () => run(() => view.refreshMcp()), open: toolsPanel === 'mcp' }) : null,
          h(ChildHistories, { view, snapshot, previewOptions, preview: (id: string) => openPreview(id), previewLocal, open: toolsPanel === 'agents' }),
          native?.phase === 'stopped' ? h(Button, { variant: 'ghost', type: 'button', 'data-action': 'archive', disabled: !snapshot.access.control || !snapshot.session.connected || snapshot.operations.some(value => value.type === 'archive' && isUnresolved(value)), onClick: () => sync(() => {
            const current = view.getSnapshot(); if (current.kind === 'disposed' || current.kind === 'unavailable' || current.operations.some(value => value.type === 'archive' && isUnresolved(value))) return;
            const original = current.actions.archive(); run(async () => { const receipt = await original.result; if (receipt.state === 'acknowledged') await view.publishArchive(original.id, receipt.generation); });
          }) }, 'Archive session') : null,
          h(Button, { variant: 'ghost', type: 'button', 'data-action': 'pin', 'aria-pressed': snapshot.logical.pinned, onClick: () => sync(() => view.setPinned(!snapshot.logical.pinned)) }, snapshot.logical.pinned ? 'Unpin session' : 'Pin session'),
          h('footer', { className: 'mpx-chat__panel-actions mpx-chat__dialog-actions' }, h(DialogClose, { asChild: true }, h(Button, { variant: 'outline', type: 'button' }, 'Close session tools'))))),
    h('form', { className: 'mpx-chat__composer', onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); if (!submitDisabled) send(); } },
      h('label', { className: 'mpx-chat__sr-only', htmlFor: inputId }, 'Message'),
      h(ComposerTextarea, { chatHeight: layout.height, chatWidth: layout.width, id: inputId, 'data-action': 'message', value: composer.value.text, placeholder: 'Message this agent', disabled: ['loading', 'disposed'].includes(composer.state), onChange: (event: { currentTarget: HTMLTextAreaElement }) => edit({ text: event.currentTarget.value }), onPaste: (event: { clipboardData: DataTransfer; preventDefault(): void }) => { if (!event.clipboardData.files.length) return; event.preventDefault(); const files = [...event.clipboardData.files]; run(async () => { for (const file of files) await attach(file); }); }, onKeyDown: (event: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault(): void }) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!submitDisabled) send(); } } }),
      h('div', { className: 'mpx-chat__composer-toolbar' },
        h(AgentControls, { snapshot, view, run, compact: layout.width < 680, container: layout.container }),
        h('div', { className: 'mpx-chat__composer-actions' },
          h('input', { id: fileId, className: 'mpx-chat__sr-only', ref: fileInput, type: 'file', multiple: true, disabled: !snapshot.access.fileWrite, 'aria-label': 'Choose files', onChange: (event: { currentTarget: HTMLInputElement }) => { const files = [...event.currentTarget.files ?? []]; event.currentTarget.value = ''; run(async () => { for (const file of files) await attach(file); }); } }),
          h('input', { id: cameraId, className: 'mpx-chat__sr-only', ref: cameraInput, type: 'file', accept: 'image/*', capture: 'environment', disabled: !snapshot.access.fileWrite, 'aria-label': 'Take photo', onChange: (event: { currentTarget: HTMLInputElement }) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) run(() => attach(file)); } }),
          h(DropdownMenu, { modal: false },
            h(DropdownMenuTrigger, { asChild: true }, h(IconButton, { type: 'button', label: 'Add files or photo', variant: 'ghost' }, icon('M12 5v14M5 12h14'))),
            h(DropdownMenuContent, { container: layout.container, side: 'top', align: 'end' },
              h(DropdownMenuItem, { disabled: !snapshot.access.fileWrite, onSelect: () => fileInput.current?.click() }, 'Choose files'),
              h(DropdownMenuItem, { disabled: !snapshot.access.fileWrite, onSelect: () => cameraInput.current?.click() }, 'Take photo'))),
          native?.phase !== 'stopped' ? h(IconButton, { type: 'button', 'data-action': 'stop', label: native?.phase === 'stopping' ? 'Stopping…' : 'Stop', variant: 'ghost', title: 'Stop the native agent', disabled: !snapshot.access.control || !snapshot.session.connected || native?.stopRequested === true, onClick: () => sync(() => { void actions.stop().result.catch(() => {}); }) }, icon('M6 6h12v12H6z')) : null,
          native?.phase === 'stopped' && native.capabilities.fullStop && native.capabilities.reopen ? h(Button, { type: 'button', 'data-action': 'resume', variant: 'ghost', title: 'Reopen this native session and allow its saved work to continue.', disabled: !snapshot.access.control || !snapshot.session.connected, onClick: () => sync(() => { void actions.resume().result.catch(() => {}); }) }, 'Reopen') : null,
          h(Button, { className: 'mpx-chat__send', type: 'submit', 'data-action': primary, 'aria-label': preparing ? 'Preparing…' : primary === 'steer' ? 'Steer' : 'Send', title: preparing ? 'Preparing message…' : primary === 'steer' ? 'Steer the current turn' : 'Send message', disabled: submitDisabled }, h('span', { className: 'mpx-chat__send-label', 'aria-hidden': true }, preparing ? 'Preparing…' : primary === 'steer' ? 'Steer' : 'Send'), h('span', { className: 'mpx-chat__send-icon', 'aria-hidden': true }, icon(preparing ? 'M12 5v2m0 10v2M5 12h2m10 0h2' : primary === 'steer' ? 'M6 18 18 6M6 6h12v12' : 'M12 19V5m-6 6 6-6 6 6'))),
          h(DropdownMenu, { modal: false },
            h(DropdownMenuTrigger, { asChild: true }, h(IconButton, { ref: toolsTrigger, type: 'button', label: 'More message actions', variant: 'ghost' }, icon('M5 12h.01M12 12h.01M19 12h.01'))),
            h(DropdownMenuContent, { container: layout.container, side: 'top', align: 'end' },
              h(DropdownMenuItem, { 'data-action': 'queue', disabled: draftDisabled(snapshot, 'queue'), onSelect: () => send('queue') }, 'Queue message'),
              h(DropdownMenuItem, { 'data-action': 'session-tools', onSelect: () => setToolsPanel('native') }, 'Session tools'))))),
      h(AttachmentChips, files))));
}
