import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { buildUiStyles } from './ui-styles.mjs';
const module = resolve(dirname(fileURLToPath(import.meta.url)), '..'), framework = resolve(module, '../..');
/** Consumer build helper only. Scope published math styles to this chat while
 * keeping their exact published font bytes as ordinary emitted assets. */
export async function buildChatStyles({ outdir, minify = true } = {}) {
  if (!outdir) throw Error('An explicit output directory is required');
  const ownRequire = createRequire(resolve(module, 'package.json')), toolsRequire = createRequire(resolve(framework, 'package.json'));
  const katexPath = ownRequire.resolve('katex/dist/katex.min.css'), postcss = toolsRequire('postcss'), stylesheet = postcss.parse(await readFile(katexPath, 'utf8'));
  stylesheet.walkRules(rule => { rule.selectors = rule.selectors.map(selector => `.multiplex-chat ${selector}`); });
  stylesheet.walkDecls(declaration => { declaration.value = declaration.value.replace(/url\(([^)]+)\)/g, (_, raw) => {
    const path = raw.trim().replace(/^['"]|['"]$/g, ''); if (/^(?:data:|https?:)/.test(path)) throw Error('Unexpected remote font asset');
    return `url(${JSON.stringify(resolve(dirname(katexPath), path))})`;
  }); });
  const scratch = resolve(outdir, '../.chat-style-inputs', basename(outdir)); await mkdir(scratch, { recursive: true }); await mkdir(outdir, { recursive: true });
  const scoped = resolve(scratch, 'katex-scoped.css'), entry = resolve(scratch, 'styles-entry.css');
  const utilities = await buildUiStyles(scratch);
  const uiEntry = resolve(scratch, 'ui-entry.css');
  await writeFile(uiEntry, [utilities, resolve(module, 'src/ui/styles.css')].map(path => `@import ${JSON.stringify(path)};`).join('\n'));
  await build({ entryPoints: [uiEntry], bundle: true, outfile: resolve(outdir, 'ui.css'), minify, logLevel: 'warning' });
  await writeFile(scoped, stylesheet.toString()); await writeFile(entry, [uiEntry, resolve(module, 'src/chat.css'), resolve(module, 'src/visual-media.css'), resolve(module, 'src/document-preview.css'), scoped, resolve(module, 'src/renderers/markdown.css')].map(path => `@import ${JSON.stringify(path)};`).join('\n'));
  const result = await build({ entryPoints: [entry], bundle: true, outfile: resolve(outdir, 'chat.css'), loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'fonts/[name]-[hash]', minify, metafile: true, logLevel: 'warning' });
  return { stylesheet: resolve(outdir, 'chat.css'), metafile: result.metafile };
}
