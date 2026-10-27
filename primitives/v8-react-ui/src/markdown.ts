import { createElement as h, createContext, memo, useContext, useMemo, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import type { Element } from 'hast';
import type { Plugin } from 'unified';
import { markdownRemarkPlugins, markdownRehypePlugins } from './renderers/math.js';
import { MermaidBlock } from './renderers/mermaid.js';
import { closedDiagramFence } from './renderers/mermaid-policy.js';
import type { OpenLocalFile } from './preview.js';
import { fileLinkTarget } from './file-reference.js';

export type LocalMediaRenderer = (image: Readonly<{ href: string; alt: string; offset: number }>) => ReactNode;
/** Presentation adapters only. Element construction must never acquire files;
 * a committed visible InlineMedia delegates the existing file/cache owner. */
export type MarkdownFileAdapters = Readonly<{ onLocalFile?: OpenLocalFile; localMedia?: LocalMediaRenderer; localFileAddress?(href: string): string | undefined }>;
const FileAdapters = createContext<MarkdownFileAdapters>({});

function MarkdownLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const adapters = useContext(FileAdapters), safe = href ? safeChatLink(href) : undefined, local = href && adapters.onLocalFile ? localChatFile(href) : undefined;
  const fragment = href && fileLinkTarget(href).kind === 'fragment', address = local ? adapters.localFileAddress?.(local) : undefined;
  return safe ? h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, children) : fragment ? h('a', { href }, children) : local && address ? h('a', { href: address, className: 'mpx-chat__local-link', onClick: (event: { button: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; defaultPrevented: boolean; currentTarget: HTMLAnchorElement; preventDefault(): void }) => { if (event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.defaultPrevented) { event.preventDefault(); adapters.onLocalFile?.(local, event.currentTarget); } } }, children) : local ? h('button', { type: 'button', className: 'mpx-chat__local-link', onClick: (event: { currentTarget: HTMLButtonElement }) => adapters.onLocalFile?.(local, event.currentTarget) }, children) : h('span', null, children);
}
function MarkdownImage({ alt, src, node }: { alt?: string | undefined; src?: string | undefined; node?: Element | undefined }) {
  const adapters = useContext(FileAdapters), target = fileLinkTarget(src ?? ''), local = target.kind === 'local' ? src : undefined;
  return local && adapters.localMedia ? adapters.localMedia({ href: local, alt: alt || 'Image', offset: node?.position?.start.offset ?? 0 }) : target.kind === 'web' ? h('a', { href: target.href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, alt || 'External image') : local && adapters.onLocalFile ? h('button', { type: 'button', className: 'mpx-chat__local-link', onClick: (event: { currentTarget: HTMLButtonElement }) => adapters.onLocalFile?.(local, event.currentTarget) }, `Preview image${alt ? `: ${alt}` : ''}`) : h('span', { className: 'mpx-chat__muted' }, alt ? `[Image: ${alt}; preview unavailable]` : '[Image; preview unavailable]');
}

/** Only explicit safe links. Image bytes must come from the workspace file
 * owner; Markdown never creates arbitrary remote/file/data image requests. */
export function safeChatLink(value: string): string | undefined {
  if (!value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  try { const url = new URL(value); return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
/** A local link is an intent for the authenticated file owner, never a browser
 * navigation or proof that a path exists or is allowed. */
export function localChatFile(value: string): string | undefined {
  return fileLinkTarget(value).kind === 'local' ? value : undefined;
}
const remarkDiagramFence: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value), visit = (node: Root | RootContent): void => {
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-mermaid-closed': closedDiagramFence(source.slice(node.position?.start.offset, node.position?.end.offset)) } };
    if ('children' in node) for (const child of node.children) visit(child);
  }; visit(tree);
};
function diagramCode(node?: Element): Readonly<{ source: string; closed: boolean }> | null {
  const code = node?.children.length === 1 ? node.children[0] : undefined;
  if (code?.type !== 'element' || code.tagName !== 'code' || !Array.isArray(code.properties.className) || !code.properties.className.includes('language-mermaid') || code.children.some(child => child.type !== 'text')) return null;
  return { source: code.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/, ''), closed: code.properties['data-mermaid-closed'] === true || code.properties['data-mermaid-closed'] === 'true' };
}
const remarkPlugins = [remarkGfm, ...markdownRemarkPlugins, remarkDiagramFence];
/** Geometry and unrelated native observations never reparse unchanged text or
 * replace a mounted diagram renderer. Component identities also survive edits. */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming = false, diagramRendererUrl, cspNonce, onLocalFile, localMedia, localFileAddress }: Readonly<{ text: string; streaming?: boolean; diagramRendererUrl?: string; cspNonce?: string }> & MarkdownFileAdapters) {
  const rendererUrl = diagramRendererUrl ?? new URL('./renderers/mermaid-frame.js', import.meta.url).href;
  // Context changes adapters without replacing the focused image/link component.
  // It contains no resource or retained state and performs no acquisition.
  const adapters = useMemo(() => ({ ...(onLocalFile ? { onLocalFile } : {}), ...(localMedia ? { localMedia } : {}), ...(localFileAddress ? { localFileAddress } : {}) }), [onLocalFile, localMedia, localFileAddress]);
  const components = useMemo<Components>(() => ({
      a: MarkdownLink,
      img: MarkdownImage,
      pre: ({ node, children, ...props }) => { const diagram = diagramCode(node); return diagram ? h(MermaidBlock, { ...diagram, streaming, rendererUrl, ...(cspNonce ? { cspNonce } : {}) }) : h('pre', { ...props, tabIndex: 0, 'aria-label': 'Code block' }, children); },
      input: ({ node: _node, type, checked, ...props }) => h('input', { ...props, type, checked, ...(type === 'checkbox' ? { disabled: true, 'aria-label': checked ? 'Completed task' : 'Incomplete task' } : {}) }),
      table: ({ node: _node, ...props }) => h('table', { ...props, tabIndex: 0 }),
    }), [rendererUrl, cspNonce, streaming]);
  return h(FileAdapters.Provider, { value: adapters }, h('div', { className: 'mpx-chat__markdown' }, h(Markdown, {
    remarkPlugins, rehypePlugins: markdownRehypePlugins, skipHtml: true,
    urlTransform: url => safeChatLink(url) ?? (fileLinkTarget(url).kind !== 'unsupported' ? url : ''),
    components,
  }, text)));
});
