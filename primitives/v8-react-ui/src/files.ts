import { Button } from './ui/index.js';
import { createElement as h, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import type { DraftRecord } from '../../v8-files/src/client/persistence.js';
import { InlineMedia } from './inline-media.js';
import type { Scope } from '../../v8-history/src/contracts/types.js';
import type { LocalMediaRenderer } from './markdown.js';
import type { ArtifactRef } from '../../v8-files/src/contracts/types.js';
import { PreviewContent, usePreview, type OpenLocalFile, type PreviewRequest } from './preview.js';
import { authenticatedFileAddress, fileLinkTarget, localFileReference, type FileAddress, type LocalFileReference } from './file-reference.js';

type FilesProps = Readonly<{ files: readonly DraftRecord[]; selected: readonly string[]; edit(ids: readonly string[]): void; preview(artifact: ArtifactRef): Promise<ResourceLease>; clear(file: DraftRecord): void; options?: PreviewOptions }>;
export function AttachmentChips({ files, selected, edit, preview, options }: FilesProps) {
  return selected.length ? h('div', { className: 'mpx-chat__attachments', 'aria-label': 'Message attachments' }, ...selected.map(id => {
    const file = files.find(value => value.manifest.id === id);
    return h('div', { key: id, className: 'mpx-chat__attachment' }, h('span', { title: file?.manifest.name }, file?.manifest.name ?? 'Attachment'),
      file?.artifact ? h(FilePreviewButton, { load: () => preview(file.artifact!), label: 'Preview', ariaLabel: `Preview ${file.manifest.name}`, ...(options ? { options } : {}) }) : h('small', null, file?.phase ?? 'Loading'),
      h(Button, { variant: 'ghost', type: 'button', 'aria-label': `Detach ${file?.manifest.name ?? 'attachment'}`, onClick: () => edit(selected.filter(value => value !== id)) }, '×'));
  })) : null;
}
export function Files({ files, selected, edit, preview, clear, options, inline = false }: FilesProps & Readonly<{inline?: boolean}>) {
  const trigger = useRef<HTMLButtonElement | null>(null), [open, setOpen] = useState(false);
  const list = h('div', { className: 'mpx-chat__files' }, ...files.map(file => h('div', { key: file.key, className: 'mpx-chat__file' },
    h('span', { title: file.manifest.name }, file.manifest.name, h('small', null, ` · ${file.phase}`)),
    file.artifact ? h(FilePreviewButton, { load: () => preview(file.artifact!), label: 'Preview', ...(options ? { options } : {}) }) : null,
    selected.includes(file.manifest.id)
      ? h(Button, { variant: 'ghost', 'aria-label': `Detach ${file.manifest.name}`, onClick: () => edit(selected.filter(id => id !== file.manifest.id)) }, 'Detach')
      : h(Button, { variant: 'ghost', 'aria-label': `Attach ${file.manifest.name}`, onClick: () => edit([...selected, file.manifest.id]) }, 'Attach'),
    h(Button, { variant: 'ghost', disabled: selected.includes(file.manifest.id) || file.operationIds.length > 0, 'aria-label': `Clear local ${file.manifest.name}`, onClick: () => clear(file) }, 'Clear local'))));
  if (!files.length) return null;
  if (inline) return h('section', { 'data-action': 'session-files', 'aria-label': 'Session files' }, h('h3', null, 'Session files'), list);
  return h(Dialog.Root, { open, onOpenChange: setOpen },
    h(Dialog.Trigger, { asChild: true }, h(Button, { variant: 'ghost', ref: trigger, 'data-action': 'session-files' }, `Files (${files.length})`)),
    h(Dialog.Portal, { container: trigger.current?.closest<HTMLElement>('.multiplex-chat') }, h(Dialog.Overlay, { className: 'mpx-chat__overlay' }),
      h(Dialog.Content, { className: 'mpx-chat__dialog', 'aria-describedby': undefined }, h(Dialog.Title, { asChild: true }, h('h3', null, 'Session files')), list,
        h('footer', { className: 'mpx-chat__panel-actions mpx-chat__dialog-actions' }, h(Dialog.Close, { asChild: true }, h(Button, { variant: 'outline' }, 'Close files'))))));
}
export type PreviewOptions = Readonly<{ sessionId: string; fileAddress?: FileAddress; diagramRendererUrl?: string; cspNonce?: string; pdfResourceBaseUrl?: string }>;
export type LocalPreviewOptions = PreviewOptions & Readonly<{ occurrence: string; historyScope?: Scope; preview(reference: LocalFileReference): Promise<ResourceLease> }>;
function previewFailure(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'EXPIRED') return 'This captured file has expired. Its original bytes will not be replaced by a disk read.';
  if (code === 'NOT_FOUND') return 'This file is no longer available from its Host.';
  if (code === 'FENCED' || code === 'FORBIDDEN') return 'This file reference is no longer authorized for the current session.';
  if (code === 'UNSUPPORTED') return 'This file cannot be previewed in this viewer.';
  if (code === 'BUSY' || code === 'STORAGE_FULL') return 'File preview capacity is currently in use. Close another preview and retry.';
  if (code === 'CORRUPT' || code === 'CONFLICT') return 'The file could not be verified against its saved identity.';
  return 'The file could not be loaded. Check the Host connection, then retry this preview.';
}
function FilePreview({ request, trigger, local, options }: Readonly<{ request: PreviewRequest; trigger: HTMLElement | null; local?: LocalPreviewOptions; options?: PreviewOptions }>) {
  const [trail, setTrail] = useState<readonly PreviewRequest[]>([request]), [attempt, setAttempt] = useState(0), [copied, setCopied] = useState('');
  const current = trail.at(-1)!;
  const retry = useRef<Readonly<{ current: PreviewRequest; attempt: number; request: PreviewRequest }> | null>(null);
  if (!retry.current || retry.current.current !== current || retry.current.attempt !== attempt) retry.current = { current, attempt, request: { ...current } };
  const active = usePreview(retry.current.request), lease = active.loaded?.lease, path = active.loaded?.source?.path ?? current.path;
  const config = local ?? options;
  const reference = (href: string) => {
    if (!local) return undefined;
    const target = fileLinkTarget(href, path);
    return target.kind === 'local' ? localFileReference(local.occurrence, target.path, local.historyScope, target.fragment) : undefined;
  };
  const openLocal: OpenLocalFile | undefined = local ? href => {
    const source = reference(href); if (!source) return;
    if (trail.length >= 16) { setCopied('Close or go back before opening another nested document.'); return; }
    setCopied(''); setTrail(previous => [...previous, { path: source.path, load: async () => ({ lease: await local.preview(source), source }) }]);
  } : undefined;
  const localFileAddress = local && config?.fileAddress ? (href: string) => {
    const source = reference(href); return source ? authenticatedFileAddress(config.fileAddress!({ sessionId: config.sessionId, source, ...(source.fragment ? { fragment: source.fragment } : {}) }), location.href) : undefined;
  } : undefined;
  const localMedia: LocalMediaRenderer | undefined = local ? image => {
    const source = reference(image.href); return source ? h(InlineMedia, { identity: source.sourceKey, label: image.alt || 'Document image', load: () => local.preview(source) }) : h('span', null, image.alt || 'Unsupported image reference');
  } : undefined;
  const addressInput = lease && config ? { sessionId: config.sessionId, artifact: lease.artifact, ...(active.loaded?.source ? { source: active.loaded.source } : {}) } : undefined;
  const address = addressInput && config?.fileAddress ? authenticatedFileAddress(config.fileAddress(addressInput), location.href) : undefined;
  const htmlAddress = addressInput && config?.fileAddress ? authenticatedFileAddress(config.fileAddress({ ...addressInput, representation: 'html' }), location.href) : undefined;
  const copy = (value: string, label: string) => { if (!navigator.clipboard) { setCopied('Copy is unavailable in this browser.'); return; } void navigator.clipboard.writeText(value).then(() => setCopied(label), () => setCopied('Copy is unavailable in this browser.')); };
  return h(Dialog.Content, { className: 'mpx-chat__dialog mpx-chat__file-dialog', 'aria-describedby': undefined, onCloseAutoFocus: event => { if (trigger?.isConnected) { event.preventDefault(); trigger.focus(); } } },
    h('header', { className: 'mpx-chat__file-header' }, trail.length > 1 ? h(Button, { variant: 'ghost', type: 'button', 'aria-label': 'Back to previous file', onClick: () => { setCopied(''); setTrail(previous => previous.slice(0, -1)); } }, 'Back') : null,
      h('div', null, h(Dialog.Title, { asChild: true }, h('h3', null, lease?.artifact.name ?? path?.split(/[\\/]/).at(-1) ?? 'File preview')),
        path ? h('p', { className: 'mpx-chat__file-path', title: path }, path) : null),
      h(Dialog.Close, { asChild: true }, h(Button, { variant: 'ghost', type: 'button', 'aria-label': 'Close file preview' }, '×'))),
    h('div', { className: 'mpx-chat__file-body' }, active.loaded ? h(PreviewContent, { key: lease!.artifact.id, loaded: active.loaded,
      ...(openLocal ? { openLocal } : {}), ...(localMedia ? { localMedia } : {}), ...(localFileAddress ? { localFileAddress } : {}), ...(htmlAddress ? { htmlAddress } : {}),
      ...(config?.diagramRendererUrl ? { diagramRendererUrl: config.diagramRendererUrl } : {}), ...(config?.cspNonce ? { cspNonce: config.cspNonce } : {}), ...(config?.pdfResourceBaseUrl ? { pdfResourceBaseUrl: config.pdfResourceBaseUrl } : {}) })
      : h('p', { role: 'status' }, active.failed ? previewFailure(active.error) : 'Loading verified file…', active.failed ? h(Button, { variant: 'outline', type: 'button', onClick: () => setAttempt(value => value + 1) }, 'Retry preview') : null)),
    h('footer', { className: 'mpx-chat__panel-actions mpx-chat__dialog-actions' },
      path ? h(Button, { variant: 'ghost', type: 'button', onClick: () => copy(path, 'Path copied') }, 'Copy path') : null,
      address ? h('a', { href: address, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, 'Open file') : null,
      address ? h(Button, { variant: 'ghost', type: 'button', onClick: () => copy(address, 'File address copied') }, 'Copy file address') : null,
      lease ? h(Button, { variant: 'ghost', type: 'button', onClick: () => { const url = URL.createObjectURL(lease.blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = lease.artifact.name; anchor.rel = 'noopener'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); } }, 'Download file') : null,
      h(Dialog.Close, { asChild: true }, h(Button, { variant: 'outline', type: 'button' }, 'Close preview'))), copied ? h('p', { role: 'status' }, copied) : null);
}

/** Each visual preview belongs to its actual Radix trigger. Closing/unmounting
 * releases exactly that lease; a late response cannot enter another view. */
export function FilePreviewButton({ load, label, ariaLabel, options }: Readonly<{ load(): Promise<ResourceLease>; label: string; ariaLabel?: string; options?: PreviewOptions }>) {
  const [request, setRequest] = useState<PreviewRequest | null>(null), trigger = useRef<HTMLButtonElement | null>(null);
  return h(Dialog.Root, { open: request !== null, onOpenChange: next => setRequest(next ? { load: async () => ({ lease: await load() }) } : null) }, h(Dialog.Trigger, { asChild: true }, h(Button, { variant: 'ghost', type: 'button', ref: trigger, ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) }, label)),
    request ? h(Dialog.Portal, { container: trigger.current?.closest<HTMLElement>('.multiplex-chat') }, h(Dialog.Overlay, { className: 'mpx-chat__overlay' }), h(FilePreview, { request, trigger: trigger.current, ...(options ? { options } : {}) })) : null);
}

/** One transient dialog for local-link presentation. It holds no catalog,
 * history or file cache; the supplied owner captures and leases exact bytes. */
export function LocalFilePreview({ selected, close }: Readonly<{ selected: Readonly<{ path: string; trigger: HTMLElement; options: LocalPreviewOptions }> | null; close(): void }>) {
  const request = useRef<Readonly<{ selected: typeof selected; request: PreviewRequest }> | null>(null);
  if (selected && request.current?.selected !== selected) {
    const { path, options } = selected;
    request.current = { selected, request: { path, load: async () => { const source = localFileReference(options.occurrence, path, options.historyScope); return { lease: await options.preview(source), source }; } } };
  }
  return h(Dialog.Root, { open: selected !== null, onOpenChange: next => { if (!next) close(); } }, selected && request.current ? h(Dialog.Portal, { container: selected.trigger.closest<HTMLElement>('.multiplex-chat') }, h(Dialog.Overlay, { className: 'mpx-chat__overlay' }), h(FilePreview, { key: selected.options.occurrence + selected.path, request: request.current.request, trigger: selected.trigger, local: selected.options })) : null);
}
