import { spawnSync } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const build=spawnSync(process.execPath,['../../node_modules/typescript/bin/tsc','--project','tsconfig.json'],{cwd,stdio:'inherit',timeout:60000});
if(build.status!==0)process.exit(build.status??1);
const module=resolve(cwd,'.build/primitives/v8-harness-copilot');await mkdir(module,{recursive:true});
try{await symlink(resolve(cwd,'../v8-harness-copilot/node_modules'),resolve(module,'node_modules'),'dir')}catch(error){if(error.code!=='EEXIST')throw error}
const tests=['v8-harness-codex/qualification/plugin.test.js','v8-harness-copilot/qualification/plugin.test.js','v8-session/qualification/native-invocation.test.js','v8-session/qualification/native-validation.test.js','v8-host/qualification/native-runtime.test.js','v8-host/qualification/native-copilot.test.js'];
const selected=process.argv[2]; const selectedTests=selected?tests.filter(path=>path.includes(`v8-harness-${selected}/`)||path.includes(`native-${selected==='codex'?'runtime':'copilot'}.test.js`)):tests;
const run=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-timeout=60000',...selectedTests.map(path=>`.build/primitives/${path}`)],{cwd,stdio:'inherit',timeout:180000});process.exit(run.status??1);
