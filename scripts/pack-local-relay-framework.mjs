import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const expectedBase = '72ca431a9e70b170b3d164ce9c161892467e7335';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
try { execFileSync('git', ['merge-base', '--is-ancestor', expectedBase, head], { cwd: root, stdio: 'ignore' }); }
catch { throw new Error('framework lineage differs'); }
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('framework source must be clean');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (packageJson.workspaces.length !== 16) throw new Error('framework package count differs');
const out = resolve(process.argv[2] ?? join(root, 'vendor', 'framework'));
await mkdir(out, { recursive: true });
const packages = [];
for (const relative of packageJson.workspaces) {
  const meta = JSON.parse(await readFile(join(root, relative, 'package.json'), 'utf8'));
  if (meta.version !== '0.2.4-hotfix.18') throw new Error('framework package version differs');
  const [packed] = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', `./${relative}`, '--ignore-scripts', '--json', '--pack-destination', out], { cwd: root, encoding: 'utf8' }));
  if (packed.name !== meta.name || packed.version !== meta.version) throw new Error('package identity differs');
  const bytes = await readFile(join(out, packed.filename));
  packages.push({ name: packed.name, version: packed.version, file: packed.filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sri: `sha512-${createHash('sha512').update(bytes).digest('base64')}` });
}
const receipt = { schema: 1, base: head, fork: 'd799fa3f200b8ab862bad91ecd13a4389588111c',
  packageCount: packages.length, packages };
await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ packageCount: packages.length, names: packages.map(p => p.name) }));
