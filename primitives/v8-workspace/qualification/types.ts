import type { AgentSnapshot, WorkspaceView } from '../src/index.js';
declare const state: AgentSnapshot;
if (state.kind === 'codex') {
  state.actions.setDefaults?.({ kind: 'codex', model: 'model' });
  state.actions.loginMcp?.('server');
  // @ts-expect-error Force reauthentication belongs to the Copilot login API.
  state.actions.loginMcp?.('server', true);
  // @ts-expect-error Native Copilot controls cannot exist on Codex.
  state.actions.setMode('plan');
  // @ts-expect-error A model brand cannot change the native harness selection type.
  state.actions.send?.('text', { kind: 'copilot', model: 'model' });
}
if (state.kind === 'copilot') {
  state.actions.setMode?.('plan');
  state.actions.loginMcp?.('server', true);
  // @ts-expect-error Native Codex controls cannot exist on Copilot.
  state.actions.updateTurn('turn', { kind: 'codex' });
}
declare const view: WorkspaceView;
declare const prompt: Extract<import('../../v8-interactions/src/contracts.js').Prompt, { type: 'copilot.question' }>;
// @ts-expect-error The exact prompt determines the native answer contract.
view.respond(prompt, { type: 'codex.permission', grant: 'session' });
