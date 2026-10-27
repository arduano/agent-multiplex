import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url)), moduleRoot = resolve(here, '..'), framework = resolve(moduleRoot, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const overrides = Object.freeze({
  'react-remove-scroll-bar@2.3.8': { path: resolve(here, 'license-inputs/react-remove-scroll-bar-2.3.8-LICENSE.txt'), source: 'https://github.com/theKashey/react-remove-scroll-bar/blob/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE' },
  'remark-math@6.0.0': { path: resolve(here, 'license-inputs/remark-math-6.0.0-LICENSE.txt'), source: 'https://github.com/remarkjs/remark-math/blob/d5d0660b150810a535bbb07eac6cc96a4510aa24/license' },
  'rehype-katex@7.0.1': { path: resolve(here, 'license-inputs/rehype-katex-7.0.1-LICENSE.txt'), source: 'https://github.com/remarkjs/remark-math/blob/88a9497e1ede93b958237c85edbf5651faeca7af/license' },
});
function packageRoot(input) {
  const clean = input.split(/[?#]/, 1)[0];
  const path = [isAbsolute(clean) ? clean : resolve(process.cwd(), clean), resolve(framework, clean), resolve(moduleRoot, clean)].find(existsSync);
  if (!path) return null;
  const parts = realpathSync(path).split('/'), index = parts.lastIndexOf('node_modules');
  if (index < 0) return null;
  const root = parts.slice(0, index + (parts[index + 1]?.startsWith('@') ? 3 : 2)).join('/');
  if (!existsSync(resolve(root, 'package.json'))) throw Error('Bundled dependency metadata is missing');
  return root;
}
function locked(root, manifest) {
  for (let base = dirname(root); ; base = dirname(base)) {
    const path = resolve(base, 'package-lock.json');
    if (existsSync(path)) {
      const entry = json(path).packages?.[relative(base, root).replaceAll('\\', '/')];
      if (entry) {
        if (entry.version !== manifest.version || !entry.integrity || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://')) throw Error(`Unlocked bundled dependency: ${manifest.name}`);
        return { version: entry.version, integrity: entry.integrity, artifact: entry.resolved };
      }
    }
    if (dirname(base) === base) throw Error(`No exact lock entry for ${manifest.name}`);
  }
}
function fontNames(path) {
  const bytes = readFileSync(path), tableCount = bytes.readUInt16BE(4), names = new Map();
  for (let i = 0; i < tableCount; i++) {
    const at = 12 + i * 16; if (bytes.toString('ascii', at, at + 4) !== 'name') continue;
    const start = bytes.readUInt32BE(at + 8), count = bytes.readUInt16BE(start + 2), strings = start + bytes.readUInt16BE(start + 4);
    for (let row = 0; row < count; row++) {
      const record = start + 6 + row * 12, platform = bytes.readUInt16BE(record), name = bytes.readUInt16BE(record + 6);
      if (![0, 13, 14].includes(name)) continue;
      const value = Buffer.from(bytes.subarray(strings + bytes.readUInt16BE(record + 10), strings + bytes.readUInt16BE(record + 10) + bytes.readUInt16BE(record + 8)));
      const text = platform === 0 || platform === 3 ? value.swap16().toString('utf16le') : value.toString('latin1');
      names.set(`${name}:${text}`, `Name record ${name}:\n${text}`);
    }
  }
  if (![...names.values()].some(text => text.includes('SIL Open Font License'))) throw Error('KaTeX font license metadata changed');
  return [...names.values()].join('\n\n');
}

/** Build-time artifact companion only. Metafiles come from the actual JS,
 * renderer and CSS builds; no application/native code is imported or executed. */
export async function buildChatNotices({ outdir, metafiles } = {}) {
  if (!outdir) throw Error('An explicit output directory is required');
  if (!metafiles) {
    const result = await build({ absWorkingDir: framework, entryPoints: [resolve(moduleRoot, 'src/index.ts'), resolve(moduleRoot, 'src/renderers/mermaid-frame.ts')], bundle: true, write: false, outdir: resolve(outdir, '.notice-inputs'), platform: 'browser', format: 'esm', target: 'es2023', minify: true, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], metafile: true, logLevel: 'silent' });
    metafiles = [result.metafile];
  }
  if (!Array.isArray(metafiles) || !metafiles.length) throw Error('Actual build metafiles are required');
  const roots = new Map();
  for (const meta of metafiles) for (const input of Object.keys(meta.inputs ?? {})) {
    const root = packageRoot(input); if (!root) continue;
    const manifest = json(resolve(root, 'package.json')); if (manifest.private) continue;
    const sources = roots.get(root) ?? new Set(); roots.set(root, sources);
    const path = [resolve(process.cwd(), input), resolve(framework, input)].find(existsSync);
    if (path && /\.[cm]?[jt]sx?$/.test(path)) {
      const text = readFileSync(path, 'utf8');
      for (const comment of text.matchAll(/\/\*[\s\S]*?\*\//g)) if (/@license|@preserve|copyright/i.test(comment[0])) sources.add(comment[0]);
    }
  }
  // Font CSS may be transformed before esbuild sees it. Admission remains tied
  // to this module's exact declared KaTeX dependency rather than ambient fonts.
  const katex = realpathSync(resolve(moduleRoot, 'node_modules/katex')); if (!roots.has(katex)) roots.set(katex, new Set());
  const entries = [...roots].map(([root, sourceNotices]) => {
    const manifest = json(resolve(root, 'package.json')), identity = `${manifest.name}@${manifest.version}`, lock = locked(root, manifest);
    const license = manifest.license ?? (identity === 'khroma@2.1.0' ? 'MIT (license document)' : null); if (!license) throw Error(`Missing declared bundled license: ${identity}`);
    const override = overrides[identity];
    const files = override ? [override.path] : readdirSync(root).filter(name => /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(name) && statSync(resolve(root, name)).isFile()).sort().map(name => resolve(root, name));
    if (!files.length) throw Error(`Missing upstream license text: ${identity}`);
    const documents = files.map(path => ({ name: path.split('/').at(-1), text: readFileSync(path, 'utf8') }));
    if (identity === 'pdfjs-dist@6.3.289') for (const folder of ['cmaps', 'standard_fonts']) for (const name of readdirSync(resolve(root, folder)).filter(name => /^LICENSE/.test(name)).sort()) documents.push({ name: `${folder}/${name}`, text: readFileSync(resolve(root, folder, name), 'utf8') });
    if (sourceNotices.size) documents.push({ name: 'BUNDLED-SOURCE-NOTICES', text: [...sourceNotices].sort().join('\n\n') });
    const extra = identity === 'elkjs@0.9.3' ? '\nELK source availability (EPL-2.0): the unmodified elkjs 0.9.3 Program source is available under EPL-2.0 at https://github.com/kieler/elkjs/tree/a8304cf79fde75bc2ab1a89d28320f53f8637436 . Its upstream Eclipse ELK Java sources and build instructions are available at https://github.com/eclipse/elk and in that elkjs source tree.\n' : identity === 'dompurify@3.4.16' ? '\nLicense selection: Apache-2.0 alternative. The archive also retains its alternative MPL text; this is an OR license.\n' : '';
    return { identity, license, ...lock, overrideSource: override?.source, documents, extra };
  }).sort((a, b) => a.identity.localeCompare(b.identity, 'en'));
  if (!entries.length) throw Error('No bundled dependencies found');
  const fontFiles = readdirSync(resolve(katex, 'dist/fonts')).filter(name => name.endsWith('.ttf')).sort();
  if (!fontFiles.length) throw Error('KaTeX font metadata inputs are missing');
  const fonts = fontFiles.map(name => `--- ${name}: preserved font metadata ---\n${fontNames(resolve(katex, 'dist/fonts', name))}`).join('\n\n');
  const preamble = 'Agent Multiplex V8 chat: third-party notices\n\nThis companion covers the actual bundled JavaScript inputs and emitted math font assets. React peers are supplied by the embedding application. Each artifact locator and integrity names the published dependency used; source copyright headers and upstream license documents retain their original text. Agent Multiplex source uses the MIT License below; this does not relicense a consuming application.\n\n--- Agent Multiplex LICENSE ---\n' + readFileSync(resolve(framework, 'LICENSE'), 'utf8');
  const sections = entries.map(entry => `\n===============================================================================\n${entry.identity}\nDeclared license: ${entry.license}\nPublished artifact: ${entry.artifact}\nIntegrity: ${entry.integrity}\n${entry.overrideSource ? `License source: ${entry.overrideSource}\n` : ''}${entry.extra}\n${entry.documents.map(doc => `--- ${doc.name} ---\n${doc.text}`).join('\n\n')}`);
  const fontNotice = `\n===============================================================================\nKaTeX font software (separate from the MIT JavaScript package)\n\nThese unmodified font bytes retain their embedded copyright statements and Reserved Font Names, reproduced below. The font software is licensed under SIL OFL 1.1.\n\n${fonts}\n\n--- Full SIL Open Font License 1.1 ---\n${readFileSync(resolve(here, 'license-inputs/SIL-Open-Font-License-1.1.txt'), 'utf8')}`;
  const shadcnNotice = '\n===============================================================================\nshadcn/ui: adapted New York presentation components\nSource provenance: https://ui.shadcn.com/r/styles/new-york/\nLocal source checksums: build/shadcn/sources.json\n\n' + readFileSync(resolve(here, 'shadcn/LICENSE.md'), 'utf8');
  const text = preamble + sections.join('') + fontNotice + shadcnNotice + '\n'; await mkdir(outdir, { recursive: true }); await writeFile(resolve(outdir, 'THIRD_PARTY_LICENSES.txt'), text);
  const result = { packages: entries.length, fonts: fontFiles.length, bytes: Buffer.byteLength(text), sha256: sha(text), components: entries.map(({ documents, extra, ...entry }) => entry) };
  await writeFile(resolve(outdir, 'THIRD_PARTY_COMPONENTS.json'), JSON.stringify(result, null, 2) + '\n'); return result;
}
