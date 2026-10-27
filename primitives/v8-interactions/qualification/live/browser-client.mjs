import {InteractionWorkspace} from '../../src/client.ts';
import {HttpGatewayTransport} from '../../../v8-gateway/src/client/http.ts';
import {GatewayClient} from '../../../v8-gateway/src/client/coordinator.ts';
import {HistoryWorkspace} from '../../../v8-history/src/client/workspace.ts';

const root=document.querySelector('#prompts');
const element=(tag,text)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=text;return value};
let workspace,entry,scope,unsubscribe;
window.liveReceipt=null;window.liveFailure=null;window.livePrompts=[];
function input(parent,name,{type='text',value='',options,secret=false}={}){
  const label=element('label',name),control=element(options?'select':'input');control.dataset.field=name;control.setAttribute('aria-label',name);
  if(options){for(const option of options){const item=element('option',option);item.value=option;control.append(item)}}
  else{control.type=secret?'password':type;if(type==='checkbox')control.checked=value===true;else control.value=value}
  label.append(control);parent.append(label);return control;
}
function render(){
  const view=entry.getSnapshot();window.livePrompts=view.snapshot?.items.map(value=>({id:value.prompt.id,type:value.prompt.type,state:value.state}))??[];
  root.replaceChildren();
  for(const item of view.snapshot?.items??[]){
    const p=item.prompt,dialog=element('section');dialog.dataset.promptId=p.id;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.append(element('h2',p.title));
    dialog.append(element('p',`Native ${p.owner.relation} request · ${p.type}`));
    const submit=(label,key,answer)=>{
      const button=element('button',label);button.dataset.action=key;button.disabled=item.state!=='pending'||view.stale||!view.connected;
      button.addEventListener('click',async()=>{try{
        const operationId=window.liveOperationId;if(typeof operationId!=='string')throw Error('Original response ID required');
        const operation=workspace.answer(scope,p,answer(),operationId);window.liveReceipt=await operation.result;
      }catch(error){window.liveFailure={code:error.code??'LIVE_UI_RESPONSE_FAILED'}}});dialog.append(button);
    };
    switch(p.type){
      case 'codex.command':case 'codex.file':
        dialog.append(element('pre',JSON.stringify(p.detail,null,2)));
        for(const decision of p.decisions)submit(decision.label,decision.id,()=>({type:p.type,decisionId:decision.id}));break;
      case 'codex.permission':
        dialog.append(element('pre',JSON.stringify(p.requested,null,2)));for(const grant of ['deny','turn','session'])submit(grant,grant,()=>({type:p.type,grant}));break;
      case 'codex.question':{
        const fields=p.questions.map(q=>{dialog.append(element('p',q.question));return[q.id,input(dialog,q.id,{...(q.options.length&&!q.other?{options:q.options}:{}),secret:q.secret})]});
        submit('Submit answers','submit',()=>({type:p.type,answers:Object.fromEntries(fields.map(([id,field])=>[id,[field.value]]))}));break;
      }
      case 'copilot.permission':{
        const feedback=input(dialog,'feedback');dialog.append(element('pre',JSON.stringify(p.request,null,2)));
        for(const kind of ['approve-once','reject','user-not-available'])submit(kind,kind,()=>({type:p.type,kind,...(kind==='reject'&&feedback.value?{feedback:feedback.value}:{})}));break;
      }
      case 'copilot.question':{
        dialog.append(element('p',p.question));const field=input(dialog,'answer',p.freeform?{}:{options:p.options});
        const freeform=input(dialog,'wasFreeform',{type:'checkbox',value:p.freeform});if(!p.freeform)freeform.disabled=true;
        submit('Submit answer','submit',()=>({type:p.type,answer:field.value,wasFreeform:freeform.checked}));break;
      }
      case 'copilot.plan':{
        dialog.append(element('p',p.summary));if(p.plan)dialog.append(element('pre',p.plan));const action=input(dialog,'selectedAction',{options:p.actions}),feedback=input(dialog,'feedback');
        for(const approved of [true,false])submit(approved?'Approve plan':'Reject plan',approved?'approve':'reject',()=>({type:p.type,approved,...(approved?{selectedAction:action.value}:{}),...(feedback.value?{feedback:feedback.value}:{})}));break;
      }
      case 'codex.elicitation':case 'copilot.elicitation':{
        dialog.append(element('p',p.message));if(p.url)dialog.append(element('p',p.url));const fields=[];
        if(p.mode==='form')for(const [name,field]of Object.entries(p.form.fields)){
          const control=input(dialog,name,field.type==='boolean'?{type:'checkbox'}:field.type==='array'?{}:field.enum?{options:field.enum}:['number','integer'].includes(field.type)?{type:'number'}:{});
          if(field.minimum!==undefined)control.min=String(field.minimum);if(field.maximum!==undefined)control.max=String(field.maximum);
          const required=p.form.required.includes(name),include=required?null:input(dialog,`Include ${name}`,{type:'checkbox'});fields.push([name,field,control,include]);
        }
        for(const action of p.mode==='unsupported'?['decline','cancel']:['accept','decline','cancel'])submit(action,action,()=>({type:p.type,action,...(action==='accept'&&p.mode==='form'?{content:Object.fromEntries(fields.filter(([, , ,include])=>include===null||include.checked).map(([name,field,control])=>[name,field.type==='boolean'?control.checked:field.type==='array'?control.value.split('\n'):['number','integer'].includes(field.type)?Number(control.value):control.value]))}:{})}));break;
      }
    }
    const dismiss=element('button','Dismiss');dismiss.dataset.action='dismiss';dismiss.addEventListener('click',()=>dialog.hidden=true);dialog.append(dismiss);root.append(dialog);
  }
}
window.liveConfigure=async config=>{
  scope=config.scope;const history=new HistoryWorkspace({connection:scope.connection,principal:scope.principal});
  const transport=new HttpGatewayTransport({url:config.url,authorization:config.authorization});
  const session=new GatewayClient({transport,history,targets:[config.target],onFence:()=>workspace?.close()});
  workspace=new InteractionWorkspace({session,port:session.interactionPort(scope)});await workspace.bind(scope);entry=workspace.entry(scope);unsubscribe=entry.subscribe(render);render();
  window.liveClose=()=>{unsubscribe();workspace.close();session.close()};
};
window.liveReady=true;
