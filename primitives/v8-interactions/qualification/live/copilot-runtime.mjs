import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
export const GLIBC_IMAGE='node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
const DOCKER='/run/current-system/sw/bin/docker';
export const ensure=(v,c)=>{if(!v)throw Error(c);};
export async function bounded(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(code)),ms);})]);}finally{clearTimeout(timer);}}
export async function packageRoot(entry,name){let dir=dirname(entry);for(let i=0;i<6;i++,dir=dirname(dir)){try{const metadata=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(metadata.name===name)return{directory:dir,metadata};}catch{}}throw Error('COPILOT_PINNED_PACKAGE_MISSING');}
async function docker(args){return new Promise((yes,no)=>execFile(DOCKER,args,{encoding:'utf8',timeout:10000,maxBuffer:65536},(error,stdout)=>error?no(Error('COPILOT_OWNED_CONTAINER_COMMAND_FAILED')):yes(stdout)));}
async function containerAbsent(name){return new Promise((yes,no)=>execFile(DOCKER,['container','inspect',name,'--format','{{.State.Running}}'],{encoding:'utf8',timeout:10000,maxBuffer:65536},(error,_stdout,stderr)=>{if(!error)return yes(false);if(error.code===1&&/No such (?:object|container)/i.test(stderr))return yes(true);no(Error('COPILOT_CONTAINER_ABSENCE_UNPROVED'));}));}
/** Only called by the root-owned allowed live runner; creates one new exact disposable runtime. */
export async function makeRuntime(cli,ctx){
 await docker(['image','inspect',GLIBC_IMAGE,'--format','{{.Id}}']);ensure(typeof process.execve==='function','COPILOT_EXECVE_REQUIRED');
 for(const dir of[ctx.nativeHome,ctx.workspace])await mkdir(dir,{recursive:true,mode:0o700});
 for(const name of['tmp','xdg-config','xdg-cache','xdg-data'])await mkdir(join(ctx.nativeHome,name),{recursive:true,mode:0o700});
 const containerName=`multiplex-v8-interactions-${randomUUID()}`,filename=join(ctx.nativeHome,'owned-launcher.js'),ownerFile=join(ctx.nativeHome,'owned-process.json');
 const args=[DOCKER,'run','--rm','--interactive','--name',containerName,'--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','2g','--user',`${process.getuid()}:${process.getgid()}`,'--tmpfs','/tmp:rw,exec,nosuid,nodev,mode=1777','--mount',`type=bind,src=${dirname(cli)},dst=${dirname(cli)},readonly`,'--mount',`type=bind,src=${ctx.nativeHome},dst=${ctx.nativeHome}`,'--mount',`type=bind,src=${ctx.workspace},dst=${ctx.workspace}`,'--workdir',ctx.workspace];
 for(const[key,value]of Object.entries({HOME:ctx.nativeHome,COPILOT_HOME:ctx.nativeHome,PATH:'/usr/local/bin:/usr/bin:/bin',SHELL:'/bin/bash',LANG:'C.UTF-8',TMPDIR:'/tmp',XDG_CONFIG_HOME:join(ctx.nativeHome,'xdg-config'),XDG_CACHE_HOME:join(ctx.nativeHome,'xdg-cache'),XDG_DATA_HOME:join(ctx.nativeHome,'xdg-data')}))args.push('--env',`${key}=${value}`);
 args.push(GLIBC_IMAGE,cli);
 await writeFile(filename,`import {readFileSync,writeFileSync} from 'node:fs';\nconst stat=readFileSync('/proc/self/stat','utf8');const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];\nwriteFileSync(${JSON.stringify(ownerFile)},JSON.stringify({pid:process.pid,start}),{mode:0o600});\nprocess.execve(${JSON.stringify(DOCKER)},[...${JSON.stringify(args)},...process.argv.slice(2)],process.env);\n`,{mode:0o700,flag:'wx'});
 return{filename,containerName,ownerFile,image:GLIBC_IMAGE};
}
export async function exactRuntimeGone(runtime){
 let owner;try{owner=JSON.parse(await readFile(runtime.ownerFile,'utf8'));}catch{return{processExited:false,containerRemoved:false};}
 ensure(Number.isSafeInteger(owner.pid)&&owner.pid>0&&/^\d+$/.test(owner.start),'COPILOT_BAD_PROCESS_IDENTITY');
 let exited=false;for(let i=0;i<60;i++){const stat=await readFile(`/proc/${owner.pid}/stat`,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat||stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]!==owner.start){exited=true;break;}await new Promise(r=>setTimeout(r,50));}
 return{processExited:exited,containerRemoved:await containerAbsent(runtime.containerName)};
}
export async function forceOwnContainer(runtime){ensure(/^multiplex-v8-interactions-[a-f0-9-]+$/.test(runtime.containerName),'COPILOT_NOT_OWN_CONTAINER');await docker(['container','stop','--time','2',runtime.containerName]).catch(()=>{});}
