import { createElement as h, useEffect, useRef, useState } from 'react';
import { Button } from './ui/index.js';
import { usePreviewViewport, usePreviewZoom } from './preview-zoom.js';

export function htmlPreviewAddress(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try { const address = new URL(value, base); return ['http:', 'https:'].includes(address.protocol) && address.origin === new URL(base).origin && !address.username && !address.password ? address.href : undefined; } catch { return undefined; }
}

/** The authenticated representation response owns CSP. The opaque-origin
 * frame receives no parent capability bridge or application credential. */
export function HtmlPreview({ address, name }: Readonly<{ address?: string; name: string }>) {
  const viewport = useRef<HTMLDivElement>(null), size = usePreviewViewport(viewport);
  const safe = typeof location === 'undefined' ? undefined : htmlPreviewAddress(address, location.href);
  const [pan, setPan] = useState(false), [state, setState] = useState<'opening' | 'loaded' | 'timeout'>('opening');
  const { zoom, zoomRef, changeZoom, reset, gestures } = usePreviewZoom({ viewport, identity: safe, mousePan: true });
  useEffect(() => { setPan(false); setState('opening'); if (!safe) return; const timer = setTimeout(() => setState(value => value === 'opening' ? 'timeout' : value), 20_000); return () => clearTimeout(timer); }, [safe]);
  if (!safe) return h('p', { role: 'status' }, 'Interactive HTML preview is unavailable. Download the original file.');
  return h('div', { className: 'mpx-document mpx-document--html', 'data-testid': 'html-preview' },
    h('div', { className: 'mpx-document__toolbar' },
      h(Button, { variant: 'ghost', type: 'button', disabled: zoom <= 1, 'aria-label': 'Zoom HTML out', onClick: () => changeZoom(zoomRef.current - 0.5) }, '−'),
      h(Button, { variant: 'ghost', type: 'button', 'aria-label': 'Reset HTML zoom', onClick: reset }, `${Math.round(zoom * 100)}%`),
      h(Button, { variant: 'ghost', type: 'button', disabled: zoom >= 3, 'aria-label': 'Zoom HTML in', onClick: () => changeZoom(zoomRef.current + 0.5) }, '+'),
      h(Button, { variant: 'ghost', type: 'button', 'aria-label': 'Pan and zoom HTML', 'aria-pressed': pan, onClick: () => setPan(value => !value) }, 'Pan and zoom')),
    h('p', { className: 'mpx-document__hint', role: 'status' }, state === 'timeout' ? 'This HTML preview took too long to load. Download the original file.' : pan ? 'Drag or pinch to pan and zoom. Turn off Pan and zoom to interact with the page.' : 'Interact with the page, or enable Pan and zoom to drag and pinch.'),
    h('div', { ref: viewport, ...(pan ? gestures : {}), className: 'mpx-document__viewport mpx-document__html-viewport', tabIndex: 0, role: 'region', 'aria-label': 'HTML document preview', style: { touchAction: pan ? 'none' : 'auto' } },
      state !== 'timeout' ? h('div', { className: 'mpx-document__html-stage', style: { width: size.width * zoom, height: size.height * zoom } },
        h('iframe', { key: safe, src: safe, title: `HTML document: ${name}`, sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', tabIndex: pan ? -1 : 0, onLoad: () => setState('loaded'), style: { width: size.width, height: size.height, transform: `scale(${zoom})`, transformOrigin: '0 0', pointerEvents: pan ? 'none' : 'auto' } })) : null));
}
