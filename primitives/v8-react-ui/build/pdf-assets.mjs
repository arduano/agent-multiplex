import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Copy only the exact published passive reader closure. No document data,
 * sandbox scripting runtime, image decoder or arbitrary user URL is bundled. */
export async function buildPdfAssets({ outdir } = {}) {
  if (!outdir) throw Error('Explicit PDF output directory required');
  const own = createRequire(resolve(moduleRoot, 'package.json')), root = dirname(own.resolve('pdfjs-dist/package.json'));
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (manifest.version !== '6.3.289') throw Error('Unexpected PDF reader version');
  const inputs = {}, assets = [];
  const copy = async (source, target) => {
    const bytes = await readFile(source); inputs[source] = { bytes: bytes.length, imports: [] };
    await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); assets.push(relative(outdir, target));
  };
  const destination = resolve(outdir, 'renderers/pdf');
  await copy(resolve(root, 'build/pdf.worker.min.mjs'), resolve(destination, 'pdf.worker.min.mjs'));
  for (const [source, target, extension] of [['cmaps', 'cmaps', /\.bcmap$/], ['standard_fonts', 'fonts', /\.(?:pfb|ttf)$/]]) {
    for (const name of (await readdir(resolve(root, source))).sort()) if (extension.test(name) || /^LICENSE/.test(name)) await copy(resolve(root, source, name), resolve(destination, target, name));
  }
  await copy(resolve(root, 'LICENSE'), resolve(destination, 'LICENSE'));
  return { base: 'renderers/pdf/', assets, metafile: { inputs, outputs: {} } };
}
