import assert from 'node:assert/strict';
import test from 'node:test';
import {remainingChildShell,remainingOwnedPlan,remainingPlanCallbackMatches,remainingToolKey,remainingToolOffer,remainingToolResult} from './copilot-remaining.mjs';

test('question offer excludes the previous MCP and skill alternatives',()=>{
 assert.deepEqual(remainingToolOffer([{name:'ask_user'}],'question'),['ask_user']);
 for(const name of['skill','v8_interaction_fixture-v8_interaction_form','task','bash'])assert.throws(()=>remainingToolOffer([{name:'ask_user'},{name}],'question'));
});
test('native plan absence remains representable and cannot manufacture an offered action',()=>{
 assert.deepEqual(remainingToolOffer([],'plan'),[]);
 assert.deepEqual(remainingToolOffer([{name:'exit_plan_mode'}],'plan'),['exit_plan_mode']);
 assert.throws(()=>remainingToolOffer([{name:'ask_user'}],'plan'));
});
test('root child stage cannot offer the child shell directly',()=>{
 assert.deepEqual(remainingToolOffer([{name:'task'}],'child'),['task']);
 assert.throws(()=>remainingToolOffer([{name:'task'},{name:'bash'}],'child'));
});
test('child approval permits exactly one harmless command, not a shell policy',()=>{
 const request={kind:'shell',fullCommandText:"printf 'V8_REMAINING_CHILD_SHELL_OK\\n'",hasWriteFileRedirection:false,possiblePaths:[],possibleUrls:[],resolvedWorkingDirectory:'/tmp/owned-workspace'};
 assert.equal(remainingChildShell(request,'/tmp/owned-workspace'),true);
 for(const extra of[{fullCommandText:request.fullCommandText+'; true'},{hasWriteFileRedirection:true},{possiblePaths:['/tmp/other']},{possibleUrls:['https://example.invalid']},{requestSandboxBypass:true},{resolvedWorkingDirectory:'/tmp/other'},{kind:'mcp'}])assert.equal(remainingChildShell({...request,...extra},'/tmp/owned-workspace'),false);
});
test('plan approval requires the exact owned content and actually offered exit_only',()=>{
 const plan='# V8 remaining harmless plan\nReview this disposable plan and exit only. No implementation, file changes, install, authentication, networks, delegation, model switch or automatic continuation is authorized.';
 const prompt={type:'copilot.plan',owner:{relation:'root'},plan,actions:['exit_only','interactive']};
 assert.equal(remainingOwnedPlan(prompt),true);
 for(const extra of[{plan:undefined},{plan:plan+'\nImplement now.'},{actions:['interactive']},{owner:{relation:'child'}}])assert.equal(remainingOwnedPlan({...prompt,...extra}),false);
});
test('native tool return classification does not turn expanded failure or opaque text into success',()=>{
 assert.equal(remainingToolResult({resultType:'success',textResultForLlm:'done'}),'explicit-success');
 assert.equal(remainingToolResult('native opaque result'),'opaque-string');
 for(const resultType of['failure','timeout','rejected','denied'])assert.throws(()=>remainingToolResult({resultType,textResultForLlm:'no'}));
 assert.throws(()=>remainingToolResult({resultType:'success',error:'native error'}));
});
test('equal vendor tool IDs from different proved owners never cross the completion join',()=>{
 const root={nativeAgent:'native-root'},child={nativeAgent:'native-child'},results=new Map([[remainingToolKey(root,'same-id'),{tool:'ask_user'}],[remainingToolKey(child,'same-id'),{tool:'bash'}]]);
 assert.equal(results.size,2);
 assert.equal(results.get(remainingToolKey(root,'same-id')).tool,'ask_user');
 assert.equal(results.get(remainingToolKey(child,'same-id')).tool,'bash');
 assert.throws(()=>remainingToolKey({},'same-id'));
});
test('captured native plan callback body must preserve owned content and every offered action',()=>{
 const event={requestId:'captured-native-request',toolCallId:'controlled-native-invocation',summary:'V8 remaining harmless plan review',actions:['autopilot','interactive','exit_only'],recommendedAction:'autopilot',planContent:'# V8 remaining harmless plan\nReview this disposable plan and exit only. No implementation, file changes, install, authentication, networks, delegation, model switch or automatic continuation is authorized.'};
 const callback={summary:event.summary,actions:[...event.actions],recommendedAction:event.recommendedAction,planContent:event.planContent};
 assert.equal(remainingPlanCallbackMatches(event,callback),true);
 for(const extra of[{planContent:undefined},{planContent:'different plan'},{actions:['exit_only']},{summary:'different summary'},{recommendedAction:'interactive'}])assert.equal(remainingPlanCallbackMatches(event,{...callback,...extra}),false);
 assert.equal(!!remainingPlanCallbackMatches({...event,toolCallId:undefined},callback),false);
});
