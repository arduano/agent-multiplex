import type { CodexApproval,CopilotPermission,CopilotQuestion,NativeAnswer,SessionScope } from "../src/contracts.js";
import type { FormHandle, FormValues, InteractionWorkspace } from "../src/client.js";
declare const workspace:InteractionWorkspace,scope:SessionScope,codex:CodexApproval,copilot:CopilotPermission,question:CopilotQuestion;
workspace.answer(scope,codex,{type:"codex.command",decisionId:"decision:0"});
workspace.answer(scope,copilot,{type:"copilot.permission",kind:"approve-once"});
// @ts-expect-error Copilot response cannot be called on a narrowed Codex capability.
workspace.answer(scope,codex,{type:"copilot.permission",kind:"approve-once"});
// @ts-expect-error Codex response cannot be called on a narrowed Copilot permission capability.
workspace.answer(scope,copilot,{type:"codex.command",decisionId:"decision:0"});
// @ts-expect-error Permission decisions are not user-input responses.
workspace.answer(scope,question,{type:"copilot.permission",kind:"reject"});
// @ts-expect-error No arbitrary native reply escape hatch.
const injected:NativeAnswer={type:"copilot.permission",kind:"approve-permanently"};
void injected;
declare const form:FormHandle;
form.update({answer:"private",enabled:true,choices:["one","two"]});
const privateValues:FormValues=form.getSnapshot();
// @ts-expect-error Native form numbers remain renderer text until answer validation.
form.update({number:42});
// @ts-expect-error Binary/native payload objects are not private form fields.
form.update({file:new Uint8Array([1,2])});
// @ts-expect-error Private form snapshots cannot be mutated by a renderer.
privateValues.answer="different";
// @ts-expect-error A private form handle grants no response/native effect capability.
form.answer({type:"copilot.permission",kind:"approve-once"});
