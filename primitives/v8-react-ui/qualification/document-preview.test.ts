import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { htmlPreviewAddress } from '../src/preview-html.js';
import { MARKDOWN_PREVIEW_CHARACTER_LIMIT, MarkdownPreview, markdownPreviewText } from '../src/preview-text.js';
import { PreviewContent } from '../src/preview.js';
import { pdfResourceUrl } from '../src/preview-pdf.js';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';

test('document addresses keep HTML and PDF resources on the authenticated origin', () => {
  const base = 'https://gateway.invalid/chat';
  assert.equal(htmlPreviewAddress('/file?representation=html#section', base), 'https://gateway.invalid/file?representation=html#section');
  for (const value of ['https://foreign.invalid/document', 'https://user:password@gateway.invalid/document', 'data:text/html,unsafe', 'javascript:alert(1)', 'blob:https://gateway.invalid/asset']) assert.equal(htmlPreviewAddress(value, base), undefined);
  assert.equal(pdfResourceUrl('/renderers/pdf/', 'standardFontDataUrl', 'FoxitSerif.pfb', base), 'https://gateway.invalid/renderers/pdf/fonts/FoxitSerif.pfb');
  for (const [root, kind, name] of [['https://foreign.invalid/pdf/', 'cMapUrl', 'a.bcmap'], ['/pdf/', 'other', 'a.ttf'], ['/pdf/', 'cMapUrl', '../a.bcmap'], ['/pdf/', 'cMapUrl', 'font.ttf']]) assert.throws(() => pdfResourceUrl(root!, kind!, name!, base));
});

test('Markdown parser cap retains the complete source and never splits a surrogate pair', () => {
  const text = 'x'.repeat(MARKDOWN_PREVIEW_CHARACTER_LIMIT - 1) + '😀' + 'full-source-end';
  assert.equal(markdownPreviewText(text), 'x'.repeat(MARKDOWN_PREVIEW_CHARACTER_LIMIT - 1));
  const html = renderToString(h(MarkdownPreview, { text }));
  assert.ok(html.includes('full-source-end'), 'Full escaped Content must survive the parse cap');
  assert.ok(html.includes('Preview is limited to the beginning of this file.'));
  assert.equal((html.match(/full-source-end/g) ?? []).length, 1);
});

test('linked Mermaid uses the same deferred renderer and preserves exact source without reads', () => {
  let released = 0;
  const text = 'flowchart LR\nA-->B', lease: ResourceLease = { artifact: { kind: 'artifact', owner: { connection: 'c', principal: 'p', host: 'h', session: 's' }, id: 'diagram', name: 'architecture.mmd', mediaType: 'application/octet-stream', bytes: text.length, sha256: '0'.repeat(64), capturedAt: 0 }, blob: new Blob([text]), preview: { kind: 'text', text }, release() { released++; } };
  const html = renderToString(h(PreviewContent, { loaded: { lease } }));
  assert.match(html, /data-testid="mermaid-block"/); assert.match(html, /data-state="deferred"/);
  assert.ok(html.includes('flowchart LR')); assert.equal(released, 0); assert.ok(!html.includes('<iframe'));
});
