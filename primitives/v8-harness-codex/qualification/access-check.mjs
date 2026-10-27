import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), framework = resolve(here, '../../..'), module = resolve(here, '..');
const base = resolve(module, '.cache/access'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(base, { recursive: true });
const receipt = await mkdtemp(resolve(base, 'gate-')), emitted = resolve(receipt, 'emitted');
const paths = ['primitives/v8-harness-codex/src/access.ts', 'primitives/v8-harness-codex/src/invocation.ts', 'primitives/v8-harness-codex/src/controller.ts', 'primitives/v8-harness-codex/src/runtime.ts', 'primitives/v8-harness-codex/README.md', 'primitives/v8-harness-codex/qualification/access-check.mjs', 'primitives/v8-react-ui/src/controls.ts', 'primitives/v8-react-ui/qualification/rendering.test.ts', 'primitives/v8-session/qualification/native-invocation.test.ts', 'primitives/v8-host/qualification/native-runtime.test.ts'];
const sources = await Promise.all(paths.sort().map(async path => ({ path, sha256: sha(await readFile(resolve(framework, path))) })));
await writeFile(resolve(receipt, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
const checks = []; let result;
try {
  const run = (name, args, timeout = 90000) => {
    const child = spawnSync(process.execPath, args, { cwd: framework, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    const output = (child.stdout ?? '') + (child.stderr ?? ''); process.stdout.write(output);
    checks.push({ name, exitCode: child.status }); assert.equal(child.status, 0, name + '\n' + output);
  };
  const includes = ['primitives/v8-react-ui/src/**/*.ts', 'primitives/v8-react-ui/qualification/rendering.test.ts', 'primitives/v8-session/qualification/native-invocation.test.ts', 'primitives/v8-host/qualification/native-runtime.test.ts', 'primitives/v8-lifecycle-default/src/registry-worker.ts', 'primitives/v8-lifecycle-default/src/session/journal-worker.ts', 'primitives/v8-files/src/host/worker.ts'].map(path => resolve(framework, path));
  await writeFile(resolve(receipt, 'tsconfig.json'), JSON.stringify({ extends: resolve(framework, 'primitives/v8-react-ui/tsconfig.json'), compilerOptions: { outDir: emitted, declaration: false, sourceMap: false }, include: includes }, null, 2));
  run('strict settings/Host/React selected graph', [resolve(framework, 'node_modules/typescript/bin/tsc'), '--project', resolve(receipt, 'tsconfig.json')]);
  await writeFile(resolve(emitted, 'package.json'), '{"type":"module"}\n');
  // One React instance serves both the UI and the headless workspace hook.
  // Other installed framework dependencies resolve from this emitted graph's
  // source-tree ancestors; these links are qualification-only.
  await symlink(resolve(framework, 'primitives/v8-react-ui/node_modules'), resolve(emitted, 'node_modules'), 'dir');
  await symlink(resolve(framework, 'primitives/v8-react-ui/node_modules'), resolve(emitted, 'primitives/v8-react-ui/node_modules'), 'dir');
  run('native invocation and retained permission UI', ['--test', '--test-concurrency=1', resolve(emitted, 'primitives/v8-session/qualification/native-invocation.test.js'), resolve(emitted, 'primitives/v8-react-ui/qualification/rendering.test.js')]);
  run('actual runtime/Host settings and exact profile provenance', ['--test', '--test-concurrency=1', '--test-name-pattern=Codex concrete factory is inert|Codex initial settings follow|Codex Resume retains|Codex exact .162 experimental plan|Codex opening encodes|actual Host admits restricted/profile', resolve(emitted, 'primitives/v8-host/qualification/native-runtime.test.js')], 150000);
  for (const source of sources) assert.equal(sha(await readFile(resolve(framework, source.path))), source.sha256, 'Owned source changed during gate');
  result = { status: 'qualified-scripted-codex-access', checks, sourceHash: sha(JSON.stringify(sources)), nativeCalls: 0, modelCalls: 0, limits: ['Exact .162.1 protocol encoding through scripted wire and actual existing Host owners', 'No vendor SDK process, native sandbox enforcement, profile provisioning, provider/model or installed service qualification'] };
} catch (error) { process.exitCode = 1; result = { status: 'failed-diagnostic', checks, error: String(error.stack ?? error) }; }
await writeFile(resolve(receipt, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ receipt: relative(framework, receipt), ...result }));
