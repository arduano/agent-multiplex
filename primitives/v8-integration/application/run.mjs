import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildApplicationAssets} from './build.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),framework=resolve(root,'../..');
execFileSync(process.execPath,[resolve(framework,'node_modules/typescript/bin/tsc'),'--project',resolve(root,'tsconfig.json')],{cwd:root,stdio:'inherit',timeout:60000});
const directory=await mkdtemp(join(tmpdir(),'multiplex-v8-local-'));
let app,closing;
async function close(){if(closing)return closing;closing=(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});})();return closing;}
try{
 const assets=await buildApplicationAssets(),{startApplication}=await import(pathToFileURL(resolve(root,'.build/primitives/v8-integration/application/server.js')).href);
 app=await startApplication({directory,assets});
 process.stdout.write(`Multiplex V8 local workspace: ${app.url}\nScripted native drivers; no model/provider calls. Ctrl+C closes owned local state.\n`);
 for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(0),()=>process.exit(1));});
}catch(error){await close();throw error;}
