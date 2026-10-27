import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Compile the vendored component utilities once, without Tailwind Preflight.
 * Only this small source directory contributes classes, never a private app. */
export async function buildUiStyles(outdir) {
  const require = createRequire(resolve(moduleRoot,'package.json'));
  const {compile} = require('tailwindcss');
  const frameworkRequire = createRequire(resolve(moduleRoot,'../../package.json'));
  const postcss = frameworkRequire('postcss');
  const sourceDir = resolve(moduleRoot,'src/ui');
  const files = (await readdir(sourceDir)).filter(name=>/\.[jt]sx?$/.test(name));
  const source = (await Promise.all(files.map(name=>readFile(resolve(sourceDir,name),'utf8')))).join('\n');
  const compiler = await compile('@theme inline { --spacing: 4px; --radius-md: var(--mpx-ui-radius-md); --text-sm: 14px; --text-sm--line-height: 20px; --font-weight-medium: 500; } @tailwind utilities;');
  const candidates = [...new Set(source.match(/[a-z][a-z0-9-]*(?:\[[^\]\s]+\])?/g)??[])];
  const sheet = postcss.parse(compiler.build(candidates).replaceAll('--tw-','--mpx-ui-tw-'));
  sheet.walkRules(rule=>{if(rule.parent?.type==='atrule'&&/keyframes/.test(rule.parent.name))return;rule.selectors=rule.selectors.map(selector=>`:where(.mpx-ui, .multiplex-chat) ${selector}`);});
  const path = resolve(outdir,'shadcn-utilities.css');await writeFile(path,sheet.toString());
  return path;
}
