import { createElement as h, memo, useRef, useState } from 'react';
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from './ui/index.js';
import { ChatMarkdown, type LocalMediaRenderer } from './markdown.js';
import { MermaidBlock } from './renderers/mermaid.js';
import type { OpenLocalFile } from './preview.js';
import { usePreviewZoom } from './preview-zoom.js';

export const MARKDOWN_PREVIEW_CHARACTER_LIMIT = 128 * 1024;
export function markdownPreviewText(text: string): string {
  const limit = MARKDOWN_PREVIEW_CHARACTER_LIMIT;
  return text.length <= limit ? text : text.slice(0, /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') ? limit - 1 : limit);
}
export type DocumentMarkdownProps = Readonly<{ text: string; openLocal?: OpenLocalFile; localMedia?: LocalMediaRenderer; localFileAddress?: (href: string) => string | undefined; diagramRendererUrl?: string; cspNonce?: string; diagram?: boolean }>;

export function TextPreview({ text }: Readonly<{ text: string }>) {
  const viewport = useRef<HTMLDivElement>(null), controls = usePreviewZoom({ viewport, identity: text });
  return h('div', { className: 'mpx-document__pane' }, h(DocumentZoom, { ...controls, label: 'text' }),
    h('div', { ref: viewport, ...controls.gestures, className: 'mpx-document__viewport', tabIndex: 0, role: 'region', 'aria-label': 'Text document. Pinch or use plus and minus to zoom; zero resets.', style: { touchAction: 'none' }, 'data-testid': 'document-source-scroll' },
      h('pre', { className: 'mpx-document__source', style: { fontSize: 12 * controls.zoom } }, text)));
}

/** The complete source remains available; only Markdown parsing is capped.
 * Both panes stay mounted across narrow-screen tabs and retain their scroll. */
export function MarkdownPreview(props: DocumentMarkdownProps) {
  const [tab, setTab] = useState('preview');
  return h(Tabs, { value: tab, onValueChange: setTab, className: 'mpx-document mpx-document--markdown' },
    h(TabsList, { className: 'mpx-document__tabs', 'aria-label': props.diagram ? 'Diagram document view' : 'Markdown document view' }, h(TabsTrigger, { value: 'source' }, 'Content'), h(TabsTrigger, { value: 'preview' }, 'Preview')),
    h('div', { className: 'mpx-document__split' },
      h(TabsContent, { forceMount: true, value: 'source', className: 'mpx-document__pane mpx-document__tab-panel', onFocusCapture: () => setTab('source') }, h('h4', { className: 'mpx-document__pane-title' }, 'Content'), h(TextPreview, { text: props.text })),
      h(TabsContent, { forceMount: true, value: 'preview', className: 'mpx-document__pane mpx-document__tab-panel', onFocusCapture: () => setTab('preview') }, h('h4', { className: 'mpx-document__pane-title' }, 'Preview'), h(RenderedDocument, props))));
}

function RenderedDocument(props: DocumentMarkdownProps) {
  const viewport = useRef<HTMLDivElement>(null), controls = usePreviewZoom({ viewport, identity: props.text }), limited = !props.diagram && props.text.length > MARKDOWN_PREVIEW_CHARACTER_LIMIT;
  return h('div', { className: 'mpx-document__pane' }, h(DocumentZoom, { ...controls, label: 'document preview' }),
    limited ? h('p', { className: 'mpx-document__hint', role: 'status' }, 'Preview is limited to the beginning of this file. The complete file is available in Content.') : null,
    h('div', { ref: viewport, ...controls.gestures, className: 'mpx-document__viewport', tabIndex: 0, role: 'region', 'aria-label': 'Rendered document. Pinch or use plus and minus to zoom; zero resets.', style: { touchAction: 'none' }, 'data-testid': 'document-rendered-scroll' }, h('div', { style: { zoom: controls.zoom } }, h(DocumentRendering, props))));
}

const DocumentRendering = memo(function DocumentRendering({ text, openLocal, localMedia, localFileAddress, diagramRendererUrl, cspNonce, diagram }: DocumentMarkdownProps) {
  return diagram ? h(MermaidBlock, { source: text, closed: true, streaming: false, rendererUrl: diagramRendererUrl ?? new URL('./renderers/mermaid-frame.js', import.meta.url).href, ...(cspNonce ? { cspNonce } : {}) }) : h(ChatMarkdown, { text: markdownPreviewText(text), ...(openLocal ? { onLocalFile: openLocal } : {}), ...(localMedia ? { localMedia } : {}), ...(localFileAddress ? { localFileAddress } : {}), ...(diagramRendererUrl ? { diagramRendererUrl } : {}), ...(cspNonce ? { cspNonce } : {}) });
});

export function DocumentZoom({ zoom, zoomRef, changeZoom, reset, label }: ReturnType<typeof usePreviewZoom> & Readonly<{ label: string }>) {
  return h('div', { className: 'mpx-document__toolbar' },
    h(Button, { variant: 'ghost', type: 'button', disabled: zoom <= 1, 'aria-label': `Zoom ${label} out`, onClick: () => changeZoom(zoomRef.current - 0.5) }, '−'),
    h(Button, { variant: 'ghost', type: 'button', 'aria-label': `Reset ${label} zoom`, onClick: reset }, `${Math.round(zoom * 100)}%`),
    h(Button, { variant: 'ghost', type: 'button', disabled: zoom >= 3, 'aria-label': `Zoom ${label} in`, onClick: () => changeZoom(zoomRef.current + 0.5) }, '+'));
}
