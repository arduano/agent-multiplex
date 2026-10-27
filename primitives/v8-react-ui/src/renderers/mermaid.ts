import { createElement as h, useEffect, useRef, useState } from 'react';
import { diagramLimits, prepareDiagram, validateDiagram, type Diagram } from './mermaid-policy.js';
import { ImageVisual } from '../preview-image.js';

/** Caller-owned trusted asset configuration, never derived from chat content. */
export function diagramAsset(value: string, base: string): URL {
  const url = new URL(value, base), origin = new URL(base).origin;
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || url.hash) throw new Error('The diagram renderer must be a packaged asset on this origin.');
  return url;
}
export function diagramDocument(script: string, nonce: string): string {
  if (!/^[a-zA-Z0-9+/_-]{16,128}={0,2}$/.test(nonce)) throw new Error('Invalid renderer nonce');
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  const bootstrap = `(()=>{const create=document.createElement.bind(document);document.createElement=function(name,options){const element=create(name,options);if(String(name).toLowerCase()==='style')element.setAttribute('nonce',${JSON.stringify(nonce)});return element;};})();`;
  const trusted = `${bootstrap}\n${script}`.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body><script nonce="${nonce}">${trusted}\n</script></body></html>`;
}
async function readScript(url: URL, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal });
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || !['application/javascript', 'text/javascript', 'application/ecmascript', 'text/ecmascript'].includes(mime ?? '') || Number(response.headers.get('content-length') ?? 0) > diagramLimits.scriptBytes || !response.body) { void response.body?.cancel(); throw new Error('The packaged diagram renderer could not be loaded.'); }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, script = '';
  try {
    for (;;) { const chunk = await reader.read(); if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); if (chunk.done) break; bytes += chunk.value.length; if (bytes > diagramLimits.scriptBytes) throw new Error('The packaged diagram renderer is too large.'); script += decoder.decode(chunk.value, { stream: true }); }
    script += decoder.decode(); if (!script.trim()) throw new Error('The packaged diagram renderer is empty.'); return script;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
let rendering = 0;
/** A fresh realm per bounded render avoids shared jobs, queues and global
 * Mermaid caches. Completed output is an inert image; the realm is retired. */
async function renderDiagram(source: string, asset: string, container: HTMLElement, signal: AbortSignal, cspNonce?: string): Promise<Diagram> {
  const prepared = prepareDiagram(source), url = diagramAsset(asset, location.href);
  if (rendering >= 4) throw new Error('Other diagrams are rendering. Retry this diagram shortly.');
  rendering++;
  try {
    const script = await readScript(url, signal); if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const html = diagramDocument(script, cspNonce ?? crypto.randomUUID());
    return await new Promise<Diagram>((resolve, reject) => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID(); let settled = false;
      frame.sandbox.add('allow-scripts'); frame.title = 'Isolated diagram renderer'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
      Object.assign(frame.style, { position: 'fixed', left: '-100000px', top: '0', width: '1400px', height: '1000px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
      function finish(error?: Error, diagram?: Diagram) { if (settled) return; settled = true; clearTimeout(timer); window.removeEventListener('message', receive); signal.removeEventListener('abort', cancel); frame.remove(); if (error) reject(error); else resolve(diagram!); }
      function cancel() { finish(new DOMException('Cancelled', 'AbortError')); }
      function receive(event: MessageEvent) {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type === 'multiplex.diagram.ready') frame.contentWindow!.postMessage({ type: 'multiplex.diagram.render', id, source: prepared }, '*');
        if (event.data?.type !== 'multiplex.diagram.result' || event.data.id !== id) return;
        try { if (event.data.error) throw new Error('The diagram could not be rendered. Its source is available below.'); finish(undefined, validateDiagram(event.data.diagram)); }
        catch { finish(new Error('The diagram could not be rendered. Its source is available below.')); }
      }
      const timer = setTimeout(() => finish(new Error('The diagram took too long to render. Its source is available below.')), diagramLimits.timeoutMs);
      signal.addEventListener('abort', cancel, { once: true }); window.addEventListener('message', receive);
      try { frame.srcdoc = html; container.append(frame); if (signal.aborted) cancel(); } catch { finish(new Error('The packaged diagram frame could not be opened.')); }
    });
  } finally { rendering--; }
}

export function MermaidBlock({ source, closed, streaming = false, rendererUrl, cspNonce }: Readonly<{ source: string; closed: boolean; streaming?: boolean; rendererUrl: string; cspNonce?: string }>) {
  const container = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false), [attempt, retry] = useState(0);
  const [preview, setPreview] = useState<Readonly<{ source: string; url: string; width: number; height: number }> | null>(null), [error, setError] = useState<string | null>(null);
  const blocked = streaming || !closed, asset = rendererUrl;
  useEffect(() => {
    const element = container.current; if (!element) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setVisible(true); }, { rootMargin: '160px' });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPreview(null); setError(null); if (blocked || !visible || !container.current) return;
    const abort = new AbortController(); let objectUrl: string | undefined;
    const deadline = setTimeout(() => { abort.abort(); setError('The diagram renderer took too long. Retry to load it again.'); }, diagramLimits.timeoutMs);
    void renderDiagram(source, asset, container.current, abort.signal, cspNonce).then(diagram => {
      if (abort.signal.aborted) return; objectUrl = URL.createObjectURL(new Blob([diagram.svg], { type: 'image/svg+xml' })); setPreview({ source, url: objectUrl, width: diagram.width, height: diagram.height });
    }, reason => { if (!abort.signal.aborted) setError(reason instanceof Error && reason.message.startsWith('This diagram') ? reason.message : 'The diagram could not be rendered. Retry or inspect its source below.'); }).finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source, asset, cspNonce, blocked, visible, attempt]);
  const current = !blocked && preview?.source === source ? preview : null, code = h('pre', { tabIndex: 0, 'aria-label': 'Mermaid source' }, h('code', null, source));
  return h('div', { ref: container, className: 'mpx-chat__diagram', 'data-testid': 'mermaid-block', 'data-state': current ? 'ready' : error ? 'error' : blocked ? 'source-only' : visible ? 'loading' : 'deferred' },
    !blocked ? h('div', { className: 'mpx-chat__diagram-visual' }, current ? h(ImageVisual, { url: current.url, width: current.width, height: current.height, name: 'Mermaid diagram' }) : h('p', { role: 'status' }, error ?? (visible ? 'Rendering diagram…' : 'Diagram will render when visible.'), error ? h('button', { type: 'button', onClick: () => retry(value => value + 1) }, 'Retry diagram') : null)) : h('p', { role: 'status' }, streaming ? 'Diagram · still writing' : 'Diagram fence is incomplete. Source is shown below.'),
    !blocked ? h('details', null, h('summary', null, 'Mermaid source'), code) : code);
}
