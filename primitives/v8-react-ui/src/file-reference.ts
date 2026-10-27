import { mediaDigest } from '../../v8-history/src/contracts/media.js';
import type { Scope } from '../../v8-history/src/contracts/types.js';
import type { ArtifactRef } from '../../v8-files/src/contracts/types.js';

export type LocalFileReference = Readonly<{ sourceKey: string; path: string; historyScope?: Scope; fragment?: string }>;
export type FileAddressInput = Readonly<{ sessionId: string; representation?: 'html'; fragment?: string }> &
  (Readonly<{ artifact: ArtifactRef; source?: LocalFileReference }> | Readonly<{ artifact?: never; source: LocalFileReference }>);
export type FileAddress = (file: FileAddressInput) => string | undefined;
export type FileLinkTarget = Readonly<{ kind: 'web' | 'fragment'; href: string }> | Readonly<{ kind: 'local'; path: string; fragment?: string }> | Readonly<{ kind: 'unsupported' }>;
const unsupported: FileLinkTarget = Object.freeze({ kind: 'unsupported' });

/** URL syntax is decoded once here. Native paths from tools bypass this parser.
 * A classified reference grants no filesystem or browser-navigation authority. */
export function fileLinkTarget(value: string, documentPath?: string): FileLinkTarget {
  if (!value || value !== value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return unsupported;
  if (value.startsWith('#')) return /^#[A-Za-z0-9_.:=\-]+$/.test(value) ? { kind: 'fragment', href: value } : unsupported;
  if (/^(?:https?:|mailto:)/i.test(value)) {
    try { const url = new URL(value); return !url.username && !url.password ? { kind: 'web', href: url.href } : unsupported; } catch { return unsupported; }
  }
  let raw = value, fragment: string | undefined;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host || url.search) return unsupported;
      raw = url.pathname; fragment = url.hash || undefined;
      if (/^\/[a-zA-Z]:\//.test(raw)) raw = raw.slice(1);
    } catch { return unsupported; }
  } else {
    // A filename plus numeric source location can resemble a URL scheme.
    const fileLocation = /^[^:?#]+\.[^:?#]+:\d+(?::\d+)?(?:[?#]|$)/.test(value);
    if (!fileLocation && /^(?![a-zA-Z]:[\\/])[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return unsupported;
    raw = value.split(/[?#]/, 1)[0]!;
    if (value.includes('#')) fragment = value.slice(value.indexOf('#'));
  }
  // Extract location syntax before decoding: an encoded colon belongs to the name.
  const line = /:(\d+)(?::\d+)?$/.exec(raw);
  if (line) { raw = raw.slice(0, line.index); fragment ??= `#L${line[1]}`; }
  if (fragment && !/^#[A-Za-z0-9_.:=\-]+$/.test(fragment)) return unsupported;
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return unsupported; }
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || /^[\\/]{2}/.test(path) ||
    /^[a-zA-Z]:/.test(path) && (!/^[a-zA-Z]:[\\/]/.test(path) || path.slice(2).includes(':'))) return unsupported;
  if (documentPath && !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path)) {
    const separator = /^[a-zA-Z]:[\\/]/.test(documentPath) || documentPath.includes('\\') ? '\\' : '/';
    const index = Math.max(documentPath.lastIndexOf('/'), documentPath.lastIndexOf('\\'));
    path = (index >= 0 ? documentPath.slice(0, index + 1) : '') + path.replace(/[\\/]/g, separator);
  }
  return { kind: 'local', path, ...(fragment ? { fragment } : {}) };
}
export function localFilePath(value: string, documentPath?: string): string | undefined {
  const target = fileLinkTarget(value, documentPath); return target.kind === 'local' ? target.path : undefined;
}
/** Synchronous identity lets a real link exist before any file read. This is
 * the same SHA-256/source-key format as previous immutable captures. */
export function localFileReference(occurrence: string, path: string, historyScope?: Scope, fragment?: string): LocalFileReference {
  return Object.freeze({ sourceKey: `chat-link:${mediaDigest(new TextEncoder().encode(JSON.stringify([occurrence, path])))}`, path,
    ...(historyScope ? { historyScope } : {}), ...(fragment ? { fragment } : {}) });
}
export function authenticatedFileAddress(value: string | undefined, base: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value, base), origin = new URL(base); return ['http:', 'https:'].includes(url.protocol) && url.origin === origin.origin && !url.username && !url.password ? url.href : undefined; } catch { return; }
}
