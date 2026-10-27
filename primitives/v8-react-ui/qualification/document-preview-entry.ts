import { createElement as h, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewContent, usePreview, type PreviewRequest } from '../src/preview.js';
import { documentData } from './document-preview-data.js';
import { ResourceCache } from '../../v8-files/src/client/resource-cache.js';
import { digest } from '../../v8-files/src/contracts/content.js';
import type { ArtifactRef, FileInputs, FileMethod, FileOutputs, FilePort } from '../../v8-files/src/contracts/types.js';
const owner = { connection: 'qualification', principal: 'owner', host: 'document-host', session: 'document-session' };
const artifacts = new Map<string, ArtifactRef>();
for (const data of documentData) artifacts.set(data.id, { kind: 'artifact', owner, id: data.id, name: data.name, bytes: data.bytes.length, mediaType: data.mediaType, sha256: await digest(data.bytes), capturedAt: 1 });
const held = new Map<string, string>(), counts = { acquired: 0, released: 0, localLinks: [] as string[], mediaAdapters: 0 };
const port: FilePort = { async call<M extends FileMethod>(method: M, input: FileInputs[M]): Promise<FileOutputs[M]> {
  const value = input as { id?: string; leaseId?: string; offset?: number; length?: number };
  if (method === 'acquire') { const leaseId = crypto.randomUUID(); held.set(leaseId, value.id!); return { artifact: artifacts.get(value.id!)!, leaseId } as FileOutputs[M]; }
  if (method === 'release') { held.delete(value.leaseId!); return undefined as FileOutputs[M]; }
  if (method === 'read') { const data = documentData.find(data => data.id === held.get(value.leaseId!)); if (!data) throw Error('Missing exact file lease'); return data.bytes.slice(value.offset!, value.offset! + value.length!) as FileOutputs[M]; }
  throw Error('Unexpected document fixture operation');
} };
const cache = new ResourceCache(port); let select: (id: string | null) => void;
function Shell() {
  const [selected, setSelected] = useState<string | null>(null); select = setSelected;
  const [request, setRequest] = useState<PreviewRequest | null>(null);
  const current = usePreview(request);
  const open = (id: string) => { setSelected(id); setRequest({ load: async () => {
    const lease = await cache.acquire(artifacts.get(id)!); counts.acquired++; let released = false;
    return { lease: { ...lease, release() { if (!released) { released = true; counts.released++; lease.release(); } } }, source: { sourceKey: 'document-' + id, path: '/docs/' + artifacts.get(id)!.name } };
  } }); };
  return h('main', { className: 'multiplex-chat mpx-ui' }, h('nav', { 'aria-label': 'Document fixtures' }, ...documentData.map(data => h('button', { key: data.id, onClick: () => open(data.id) }, data.id)), h('button', { onClick: () => { setSelected(null); setRequest(null); } }, 'Close document')),
    h('section', { id: 'document', 'aria-label': 'Document preview' }, current.loaded ? h(PreviewContent, { key: selected!, loaded: current.loaded, htmlAddress: '/v8-artifacts?host=document-host&session=document-session&id=html&representation=html#section', diagramRendererUrl: location.origin + '/renderers/mermaid-frame.js', cspNonce: 'document-preview-nonce-123456789', pdfResourceBaseUrl: location.origin + '/renderers/pdf/', openLocal: href => { counts.localLinks.push(href); }, localFileAddress: href => '/scoped-link?path=' + encodeURIComponent(href), localMedia: image => { counts.mediaAdapters++; return h('span', { 'data-adapted-image': image.href }, image.alt); } }) : h('p', { role: 'status' }, current.failed ? 'Document failed' : request ? 'Loading document…' : 'Choose a document')));
}
const root = createRoot(document.getElementById('app')!); root.render(h(StrictMode, null, h(Shell)));
declare global { interface Window { documentFixture: { counts(): unknown; close(): unknown; theme(light: boolean): void } } }
window.documentFixture = { counts: () => ({ ...counts, hostLeases: held.size, cache: cache.usage }), theme: light => document.querySelector('.multiplex-chat')!.setAttribute('data-theme', light ? 'light' : 'dark'), close() { select!(null); root.unmount(); cache.close(); return { ...counts, hostLeases: held.size, cache: cache.usage }; } };
