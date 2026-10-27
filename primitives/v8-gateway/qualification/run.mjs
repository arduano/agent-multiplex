import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const lane=fileURLToPath(new URL('..',import.meta.url));
const root=resolve(lane,'../..');
const run=(args,timeout)=>new Promise((resolveRun,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit'}),timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);code===0?resolveRun():reject(new Error(`Focused development check failed (${code})`));});
});
await run(['node_modules/typescript/bin/tsc','--project','primitives/v8-gateway/tsconfig.json'],45000);
await run(['--test','--test-concurrency=1','--test-timeout=30000','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/gateway.test.js','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/loopback.test.js','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/wire.test.js','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/mux.test.js','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/relay-config.test.js','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/relay-network.test.js','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/remote-host.test.js','primitives/v8-gateway/.build/primitives/v8-gateway/qualification/catalog-port.test.js'],90000);
