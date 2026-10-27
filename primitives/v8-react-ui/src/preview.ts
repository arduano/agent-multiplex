import { createElement as h, useEffect, useState } from 'react';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import type { LocalMediaRenderer } from './markdown.js';
import { ImagePreview } from './preview-image.js';
import { HtmlPreview } from './preview-html.js';
import type { LocalFileReference } from './file-reference.js';
import { PdfPreview } from './preview-pdf.js';
import { MarkdownPreview, TextPreview } from './preview-text.js';

export type OpenLocalFile = (path: string, trigger: HTMLElement) => void;
export type LoadedPreview = Readonly<{ lease: ResourceLease; source?: LocalFileReference }>;
export type PreviewRequest = Readonly<{ load(): Promise<LoadedPreview>; path?: string }>;

export function PreviewContent({ loaded, openLocal, localMedia, localFileAddress, htmlAddress, diagramRendererUrl, cspNonce, pdfResourceBaseUrl }: Readonly<{ loaded: LoadedPreview; openLocal?: OpenLocalFile; localMedia?: LocalMediaRenderer; localFileAddress?: (href: string) => string | undefined; htmlAddress?: string; diagramRendererUrl?: string; cspNonce?: string; pdfResourceBaseUrl?: string }>) {
  const { lease, source } = loaded, content = lease.preview, name = source?.path ?? lease.artifact.name, mediaType = lease.artifact.mediaType.split(';', 1)[0]!.toLowerCase();
  if (content.kind === 'image') return h(ImagePreview, { url: content.url, name: lease.artifact.name });
  if (/\.pdf$/i.test(name) || lease.artifact.mediaType === 'application/pdf') return h(PdfPreview, { blob: lease.blob, name: lease.artifact.name, ...(pdfResourceBaseUrl ? { resourceBaseUrl: pdfResourceBaseUrl } : {}) });
  if (content.kind === 'text') {
    if (/\.html?$/i.test(name) || ['text/html', 'application/xhtml+xml'].includes(mediaType)) return h(HtmlPreview, { name: lease.artifact.name, ...(htmlAddress ? { address: htmlAddress } : {}) });
    if (/\.(?:md|markdown|mdown|mmd|mermaid)$/i.test(name) || mediaType === 'text/markdown') return h(MarkdownPreview, { text: content.text, diagram: /\.(?:mmd|mermaid)$/i.test(name), ...(openLocal ? { openLocal } : {}), ...(localMedia ? { localMedia } : {}), ...(localFileAddress ? { localFileAddress } : {}), ...(diagramRendererUrl ? { diagramRendererUrl } : {}), ...(cspNonce ? { cspNonce } : {}) });
    return h('div', { className: 'mpx-document' }, h(TextPreview, { text: content.text }));
  }
  return h('p', { role: 'status' }, 'This file has no safe inline preview. Download the original bytes.');
}
/** Requests enter only after an explicit preview action. One lease belongs to
 * this mounted dialog; stale completions release without publishing content. */
export function usePreview(request: PreviewRequest | null): Readonly<{ loaded: LoadedPreview | null; failed: boolean; error?: unknown }> {
  const [state, setState] = useState<Readonly<{ request: PreviewRequest | null; loaded: LoadedPreview | null; failed: boolean; error?: unknown }>>({ request: null, loaded: null, failed: false });
  useEffect(() => {
    if (!request) return;
    let live = true, held: ResourceLease | undefined;
    void Promise.resolve().then(() => live ? request.load() : undefined).then(loaded => { if (!loaded) return; if (!live) { loaded.lease.release(); return; } held = loaded.lease; setState({ request, loaded, failed: false }); }, error => { if (live) setState({ request, loaded: null, failed: true, error }); });
    return () => { live = false; held?.release(); };
  }, [request]);
  return state.request === request ? state : { loaded: null, failed: false };
}
