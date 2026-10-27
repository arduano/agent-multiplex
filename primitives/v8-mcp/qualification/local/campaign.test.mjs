import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openCampaign,createModelTrap} from './campaign.mjs';

test('one proven pre-dispatch failure keeps time and diagnostics; any admission consumes the fixed CLI slot',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'v8-mcp-budget-'));let campaign;
 try{
  const path=join(directory,'allowance.json');campaign=openCampaign(path);
  const original=campaign.snapshot(),preflight=campaign.begin('codex');preflight.finish('failed-native-diagnostic');
  const first=campaign.begin('codex');first.admit('native-process-start');
  for(let i=1;i<64;i++)first.admit('bounded-native-request');
  assert.throws(()=>first.admit('over-cap'));first.finish('failed-native-diagnostic');
  campaign.close('failed-diagnostic');campaign=openCampaign(path,original.id);
  assert.equal(campaign.snapshot().deadline,original.deadline);assert.equal(campaign.snapshot().attempts.length,2);
  const second=campaign.begin('codex');for(let i=0;i<64;i++)second.admit('bounded-native-request');
  assert.throws(()=>second.admit('over-total'));second.finish('passed-native-local-mcp-subset');
  assert.throws(()=>campaign.begin('codex'),/Fresh CLI allowance exhausted/);
  campaign.close('complete');assert.throws(()=>openCampaign(path,original.id));
  const durable=JSON.parse(await readFile(path,'utf8'));assert.equal(durable.attempts[0].requests.length,0);
  assert.equal(durable.attempts.slice(1).reduce((n,a)=>n+a.requests.length,0),128);
  assert.equal(durable.limits.launchesPerHarness,2);assert.equal(durable.limits.modelInference,0);
 }finally{campaign?.close('complete');await rm(directory,{recursive:true,force:true});}
});

test('owned model rejection trap counts attempted inference and has no forwarding path',async()=>{
 const trap=await createModelTrap();try{
  const response=await fetch(trap.endpoint+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'INFERENCE_DISABLED');
  assert.deepEqual(trap.snapshot(),{requests:1,inferenceAttempts:1,forwarded:0});
 }finally{await trap.close();await trap.close();}
});
