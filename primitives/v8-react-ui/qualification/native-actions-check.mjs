import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), framework = resolve(here, '../../..'), module = resolve(here, '..'), base = resolve(module, '.cache/native-actions');
await mkdir(base, { recursive: true }); const receipt = await mkdtemp(resolve(base, 'owner-')), emitted = resolve(receipt, 'emitted'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['src/native-actions.ts', 'src/native-observation.ts', 'src/native-goal.ts', 'src/native-queue.ts', 'src/native-tasks.ts', 'qualification/rendering.test.ts', 'qualification/host-rendering.test.ts', 'qualification/native-actions-entry.ts', 'qualification/native-actions-browser.mjs', 'qualification/native-actions-check.mjs'].map(path => resolve(module, path)).concat(['primitives/v8-session/src/contracts/types.ts', 'primitives/v8-harness-defaults/src/state.ts', 'primitives/v8-session/qualification/native-validation.test.ts'].map(path => resolve(framework, path)));
const sources = await Promise.all(paths.sort().map(async path => ({ path: relative(framework, path), sha256: sha(await readFile(path)) }))); await writeFile(resolve(receipt, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
const checks = []; let result;
try {
  const run = (name, args, timeout = 90000) => { const child = spawnSync(process.execPath, args, { cwd: framework, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }); const output = (child.stdout ?? '') + (child.stderr ?? ''); process.stdout.write(output); checks.push({ name, exitCode: child.status }); assert.equal(child.status, 0, name + '\n' + output); };
  await writeFile(resolve(receipt, 'tsconfig.json'), JSON.stringify({ extends: resolve(module, 'tsconfig.json'), compilerOptions: { outDir: emitted, declaration: false, sourceMap: false }, include: [resolve(module, 'src/**/*.ts'), resolve(module, 'qualification/**/*.ts'), resolve(framework, 'primitives/v8-session/qualification/native-validation.test.ts')] }, null, 2));
  run('strict React/native-read selected graph', [resolve(framework, 'node_modules/typescript/bin/tsc'), '--project', resolve(receipt, 'tsconfig.json')]);
  await writeFile(resolve(emitted, 'package.json'), '{"type":"module"}\n'); await symlink(resolve(framework, 'node_modules'), resolve(emitted, 'node_modules'), 'dir');
  run('retained renderer/native-adapter metadata and native state validation', ['--test', '--test-concurrency=1', resolve(emitted, 'primitives/v8-react-ui/qualification/rendering.test.js'), resolve(emitted, 'primitives/v8-react-ui/qualification/host-rendering.test.js'), resolve(emitted, 'primitives/v8-session/qualification/native-validation.test.js')]);
  run('mounted goal/task/queue progression', [resolve(here, 'native-actions-browser.mjs')]);
  for (const source of sources) assert.equal(sha(await readFile(resolve(framework, source.path))), source.sha256, 'Owned source changed during gate');
  result = { status: 'qualified-native-actions-ui', checks, sourceHash: sha(JSON.stringify(sources)), nativeCalls: 0, modelCalls: 0, limits: ['Actual concrete controller with scripted native RPC; actual retained read owner and mounted Chromium', 'No native SDK process, provider/model call, installed artifact or service change'] };
} catch (error) { process.exitCode = 1; result = { status: 'failed-diagnostic', checks, error: String(error.stack ?? error) }; }
await writeFile(resolve(receipt, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify({ receipt: relative(framework, receipt), ...result }));
