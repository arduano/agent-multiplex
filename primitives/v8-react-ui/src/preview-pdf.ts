import { Button } from './ui/index.js';
import { createElement as h, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import { usePreviewViewport, usePreviewZoom } from './preview-zoom.js';

export const PDF_CANVAS_PIXELS = 8_000_000, PDF_TOTAL_CANVAS_PIXELS = 24_000_000;
const maximumPixels = PDF_CANVAS_PIXELS, maximumDimension = 4096;
/** Factory-owned published assets only. PDF URLs, annotations, actions,
 * scripts, forms and attachments never become browser elements or requests. */
export function pdfResourceUrl(base: string, kind: string, filename: string, origin: string): string {
  const root = new URL(base, origin);
  if (root.origin !== new URL(origin).origin || !['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash || !root.pathname.endsWith('/')) throw Error('Invalid PDF resources');
  const folder = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'fonts' : undefined;
  if (!folder || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\.(?:bcmap|pfb|ttf)$/.test(filename) || filename.includes('..') || kind === 'cMapUrl' !== filename.endsWith('.bcmap')) throw Error('Unsupported PDF resource');
  return new URL(`${folder}/${filename}`, root).href;
}
export async function readPdfResource(url: string, filename: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal, credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok || response.redirected || response.url !== url) throw Error('PDF resource unavailable');
  const size = Number(response.headers.get('content-length')); if (Number.isFinite(size) && size > 1_048_576) throw Error('PDF resource exceeds bound');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 1_048_576 || /^\s*(?:<!doctype|<html|<head|<body|[\[{])/i.test(new TextDecoder().decode(bytes.subarray(0, 128)))) throw Error('Invalid PDF resource');
  const cff = bytes[0] === 1 && bytes[1] === 0 && bytes[2]! >= 4 && bytes[3]! >= 1 && bytes[3]! <= 4;
  if (filename.endsWith('.pfb') && !(cff || bytes[0] === 0x80 && bytes[1] === 1) || filename.endsWith('.ttf') && !(bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) throw Error('Invalid PDF font');
  return bytes;
}

/** One verified document and owned worker. Only near-viewport pages own
 * canvases; their combined backing pixels stay within the shared visual cap. */
export function PdfPreview({ blob, name = 'PDF document', resourceBaseUrl }: Readonly<{ blob: Blob; name?: string; resourceBaseUrl?: string }>) {
  const [opened, setOpened] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState(''), [ratio, setRatio] = useState(1.4), [renderZoom, setRenderZoom] = useState(1);
  const container = useRef<HTMLDivElement>(null), stop = useRef<() => void>(() => {}), size = usePreviewViewport(container), width = Math.min(800, Math.max(1, size.width));
  const contentAt = useCallback((_x: number, y: number) => [...container.current?.querySelectorAll<HTMLElement>('.mpx-document__pdf-sheet') ?? []].find(element => { const box = element.getBoundingClientRect(); return y >= box.top && y <= box.bottom; }) ?? null, []);
  const { zoom, zoomRef, changeZoom, reset, gestures } = usePreviewZoom({ viewport: container, identity: blob, contentAt });
  // Immediate gesture geometry; bitmap work settles after the gesture instead
  // of allocating/cancelling a canvas on every finger movement.
  useEffect(() => { const timer = setTimeout(() => setRenderZoom(zoom), 120); return () => clearTimeout(timer); }, [zoom]);
  useEffect(() => {
    const abort = new AbortController(); let task: PDFDocumentLoadingTask | undefined, worker: Worker | undefined;
    const dispose = () => { abort.abort(); void task?.destroy().catch(() => {}); worker?.terminate(); }; stop.current = dispose;
    const timer = setTimeout(() => { dispose(); setError('This PDF took too long to open. Download the original file.'); }, 20_000);
    setOpened(null); setError(''); setRatio(1.4); setRenderZoom(1);
    void (async () => {
      const pdf = await import('pdfjs-dist'); if (abort.signal.aborted) return;
      const base = new URL(resourceBaseUrl ?? './renderers/pdf/', import.meta.url).href;
      pdfResourceUrl(base, 'standardFontDataUrl', 'FoxitSerif.pfb', location.href);
      const bytes = new Uint8Array(await blob.arrayBuffer()); if (abort.signal.aborted) return;
      if (!new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-')) throw Error('Not PDF bytes');
      worker = new Worker(new URL('pdf.worker.min.mjs', base), { type: 'module', name: 'multiplex-file-pdf' });
      const parser = pdf.PDFWorker.create({ port: worker, verbosity: 0 });
      class PrivateBinaryDataFactory {
        async fetch({ kind, filename }: { kind: string; filename: string }) { return readPdfResource(pdfResourceUrl(base, kind, filename, location.href), filename, abort.signal); }
      }
      task = pdf.getDocument({ data: bytes, worker: parser, BinaryDataFactory: PrivateBinaryDataFactory, useWorkerFetch: false, useWasm: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: true, maxImageSize: maximumPixels, canvasMaxAreaInBytes: maximumPixels * 4, disableAutoFetch: true, disableStream: true, disableRange: true, verbosity: 0 });
      const document = await task.promise;
      if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 100_000) throw Error('Unsupported page inventory');
      const first = await document.getPage(1), page = first.getViewport({ scale: 1 });
      if (![page.width, page.height].every(value => Number.isFinite(value) && value > 0)) throw Error('Invalid page geometry');
      if (!abort.signal.aborted) { clearTimeout(timer); setRatio(page.height / page.width); setOpened(document); }
    })().catch(reason => {
      if (!abort.signal.aborted) { clearTimeout(timer); setError(reason instanceof Error && reason.name === 'PasswordException' ? 'Password-protected PDFs cannot be previewed. Download the original file.' : 'This PDF could not be opened safely. Download the original file.'); dispose(); }
    });
    return () => { clearTimeout(timer); dispose(); if (stop.current === dispose) stop.current = () => {}; };
  }, [blob, resourceBaseUrl]);
  const pages = useVirtualizer({ count: opened?.numPages ?? 0, getScrollElement: () => container.current, estimateSize: () => Math.max(80, width * zoom * ratio) + 68, overscan: 1, gap: 16 });
  useLayoutEffect(() => { pages.measure(); }, [pages, width, zoom]);
  const pageTimeout = useCallback(() => { stop.current(); setOpened(null); setError('This PDF page took too long to render. Download the original file.'); }, []);
  const visible = pages.getVirtualItems(), currentPage = (visible.find(page => page.end > (pages.scrollOffset ?? 0))?.index ?? 0) + 1;
  const pixelBudget = Math.min(maximumPixels, Math.floor(PDF_TOTAL_CANVAS_PIXELS / Math.max(1, visible.length)));
  return h('div', { className: 'mpx-document mpx-document--pdf', 'data-testid': 'pdf-preview' },
    opened ? h('div', { className: 'mpx-document__toolbar' },
      h(Button, { variant: 'ghost', type: 'button', disabled: currentPage <= 1, onClick: () => pages.scrollToIndex(currentPage - 2, { align: 'start' }), 'aria-label': 'Previous PDF page' }, 'Previous'),
      h('span', { role: 'status' }, `Page ${currentPage} of ${opened.numPages}`),
      h(Button, { variant: 'ghost', type: 'button', disabled: currentPage >= opened.numPages, onClick: () => pages.scrollToIndex(currentPage, { align: 'start' }), 'aria-label': 'Next PDF page' }, 'Next'),
      h(Button, { variant: 'ghost', type: 'button', disabled: zoom <= 1, onClick: () => changeZoom(zoomRef.current - 0.5), 'aria-label': 'Zoom PDF out' }, '−'),
      h(Button, { variant: 'ghost', type: 'button', onClick: reset, 'aria-label': 'Fit PDF page' }, `${Math.round(zoom * 100)}%`),
      h(Button, { variant: 'ghost', type: 'button', disabled: zoom >= 3, onClick: () => changeZoom(zoomRef.current + 0.5), 'aria-label': 'Zoom PDF in' }, '+')) : null,
    error ? h('p', { role: 'alert' }, error) : !opened ? h('p', { role: 'status' }, 'Opening verified PDF…') : null,
    h('div', { ref: container, ...gestures, className: 'mpx-document__viewport mpx-document__pdf-pages', tabIndex: 0, role: 'region', 'aria-label': 'PDF document pages. Pinch or use plus and minus to zoom; zero resets.', style: { touchAction: 'none' } },
      opened ? h('div', { style: { position: 'relative', height: pages.getTotalSize(), minWidth: width * zoom } }, ...visible.map(page => h('div', { key: page.key, ref: pages.measureElement, 'data-index': page.index, style: { position: 'absolute', left: 0, top: 0, width: '100%', transform: `translateY(${page.start}px)` } },
        h(PdfPage, { document: opened, page: page.index + 1, name, width, zoom, renderZoom, estimatedRatio: ratio, pixelBudget, onTimeout: pageTimeout })))) : null));
}

function PdfPage({ document, page, name, width, zoom, renderZoom, estimatedRatio, pixelBudget, onTimeout }: Readonly<{ document: PDFDocumentProxy; page: number; name: string; width: number; zoom: number; renderZoom: number; estimatedRatio: number; pixelBudget: number; onTimeout(): void }>) {
  const canvas = useRef<HTMLCanvasElement>(null), [ratio, setRatio] = useState(estimatedRatio), [text, setText] = useState(''), [error, setError] = useState(''), [rendering, setRendering] = useState(true);
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    let live = true, render: RenderTask | undefined, cleanup: (() => void) | undefined;
    setText(''); setError(''); setRendering(true);
    const timer = setTimeout(() => { live = false; render?.cancel(); cleanup?.(); element.width = 0; element.height = 0; onTimeout(); }, 20_000);
    void (async () => {
      const selected = await document.getPage(page); if (!live) return;
      cleanup = () => selected.cleanup();
      const base = selected.getViewport({ scale: 1 });
      if (![base.width, base.height].every(value => Number.isFinite(value) && value > 0)) throw Error('Invalid page geometry');
      setRatio(base.height / base.width);
      const scale = Math.min(width * renderZoom * Math.min(devicePixelRatio, 2) / base.width, maximumDimension / Math.max(base.width, base.height), Math.sqrt(pixelBudget / (base.width * base.height)));
      const viewport = selected.getViewport({ scale }); element.width = Math.max(1, Math.floor(viewport.width)); element.height = Math.max(1, Math.floor(viewport.height));
      const context = element.getContext('2d'); if (!context) throw Error('Canvas unavailable');
      render = selected.render({ canvas: element, canvasContext: context, viewport, annotationMode: 0, background: 'rgb(255,255,255)' });
      const [content] = await Promise.all([selected.getTextContent({ disableNormalization: false }), render.promise]);
      if (!live) return;
      setText(content.items.flatMap(item => 'str' in item ? [item.str + (item.hasEOL ? '\n' : ' ')] : []).join('').slice(0, 100_000)); setRendering(false); clearTimeout(timer); cleanup();
    })().catch(() => { if (live) { clearTimeout(timer); render?.cancel(); cleanup?.(); element.width = 0; element.height = 0; setRendering(false); setError('This PDF page could not be rendered safely. Download the original file.'); } });
    return () => { live = false; clearTimeout(timer); render?.cancel(); cleanup?.(); element.width = 0; element.height = 0; };
  }, [document, page, width, renderZoom, pixelBudget, onTimeout]);
  return h('section', { className: 'mpx-document__pdf-page', style: { width: width * zoom }, 'aria-label': `Page ${page}`, 'data-page-number': page },
    h('p', null, `Page ${page}`),
    h('div', { className: 'mpx-document__pdf-sheet', style: { minHeight: Math.max(80, width * zoom * ratio) }, 'aria-busy': rendering },
      error ? h('p', { role: 'alert' }, error) : rendering ? h('p', { role: 'status' }, `Rendering page ${page}…`) : null,
      h('canvas', { ref: canvas, role: 'img', 'aria-label': `${name}, page ${page}`, 'data-rendered': !rendering && !error ? 'true' : 'false', style: { width: width * zoom, height: width * zoom * ratio, visibility: rendering || error ? 'hidden' : 'visible' } })),
    text && !error ? h('details', null, h('summary', null, `Read page ${page} text`), h('pre', { tabIndex: 0, role: 'region', 'aria-label': `Page ${page} text` }, text)) : null);
}
