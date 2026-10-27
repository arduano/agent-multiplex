import type { CodexMcpReadPort,CopilotMcpReadPort,McpOwner,McpSnapshot } from '../src/index.js';
declare const codex:CodexMcpReadPort,copilot:CopilotMcpReadPort,owner:McpOwner,snapshot:McpSnapshot;
if(false){
 // @ts-expect-error Copilot does not have the Codex paginated status request.
 copilot.status({threadId:'native',detail:'toolsAndAuthOnly',cursor:null,limit:32});
 // @ts-expect-error Codex does not expose the Copilot configured-inventory method.
 codex.configured();
 // @ts-expect-error No side journal or unadmitted reload method is available.
 owner.reload();
 // @ts-expect-error Login remains unavailable until original-command admission exists.
 owner.login('server');
 if(snapshot.kind==='copilot'){
  // @ts-expect-error Copilot passive metadata does not invent Codex auth evidence.
  snapshot.servers[0]!.authStatus;
 }else{
  // @ts-expect-error Codex inventory does not invent a Copilot effective-enabled flag.
  snapshot.servers[0]!.enabled;
 }
}
