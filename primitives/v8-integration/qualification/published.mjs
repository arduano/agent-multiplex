import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPublishedTransportQualification} from '../../v8-gateway/qualification/published-transport.mjs';
import {runPluginPublishedQualification} from '../../v8-gateway/qualification/plugins-published.mjs';
import {runP14SharedHopQualification} from '../../v8-gateway/qualification/p14-shared-hop.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// The combined runner owns this process group and its finite deadline. A native
// endpoint that never settles cannot leave a long-lived listener in the owner.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const subset=await runPublishedTransportQualification({buildRoot:resolve(root,'.build')});
assert.equal(subset.passed,true);assert.equal(subset.cleanup,true);assert.equal(subset.p14,'unqualified');
assert.equal(subset.nativeAgentCalls,0);assert.equal(subset.modelCalls,0);
const p14=await runP14SharedHopQualification({buildRoot:resolve(root,'.build')});
const directory=process.argv[2]??resolve(root,'artifacts',`p14-${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(directory,{recursive:true,mode:0o700});
const evidence=resolve(directory,'shared-hop.json');
await writeFile(evidence,JSON.stringify(p14,null,2)+'\n',{mode:0o600});
assert.equal(p14.passed,true);assert.equal(p14.cleanup,true);assert.equal(p14.p14,'v8-shared-hop-qualified');
assert.equal(p14.historicalInitialCloseCaller,'unproved');
const plugins=await runPluginPublishedQualification({buildRoot:resolve(root,'.build')});
assert.equal(plugins.passed,true);assert.equal(plugins.cleanup,true);assert.equal(plugins.liveNativeOrModelCalls,0);
const result={...subset,p14:p14.p14,cases:[...subset.cases,...p14.cases,...plugins.cases],endpoints:subset.endpoints+p14.endpoints+plugins.endpoints,plugins,
  historicalP14InitialCloseCaller:p14.historicalInitialCloseCaller,
  p14Evidence:{path:evidence,sha256:createHash('sha256').update(await readFile(evidence)).digest('hex')},
  scope:'published transport subset plus two retained observers sharing one exact Root/Host Peer; original historical close caller remains unproved'};
process.stdout.write('published-transport-result:'+JSON.stringify(result)+'\n');
