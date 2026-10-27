import { createElement as h, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { PromptDialog } from '../../application/prompts.js';
import { InteractionWorkspace, type FormHandle, type InteractionEntry } from '../../../v8-interactions/src/client.js';
import type { Prompt } from '../../../v8-interactions/src/contracts.js';
import { HttpGatewayTransport } from '../../../v8-gateway/src/client/http.js';
import { GatewayClient } from '../../../v8-gateway/src/client/coordinator.js';
import type { GatewayTarget } from '../../../v8-gateway/src/contracts/types.js';
import { HistoryWorkspace } from '../../../v8-history/src/client/workspace.js';
import type { Receipt, SessionScope } from '../../../v8-session/src/contracts/types.js';
import type { WorkspaceView } from '../../../v8-workspace/src/contracts.js';

type Configuration = Readonly<{ url: string; authorization: string; target: GatewayTarget; scope: SessionScope }>;
declare global {
  interface Window {
    nativeUiReady: boolean; nativeUiReceipt: Receipt | null; nativeUiFailure: string | null;
    nativeUiConfigure(config: Configuration, operationId: string): Promise<void>;
    nativeUiHasPrompt(id: string): boolean; nativeUiOpen(id: string): void; nativeUiClose(): void;
  }
}
const element = document.querySelector('#native-prompts');
if (!element) throw Error('Missing native prompt root');
const root = createRoot(element);
let workspace: InteractionWorkspace | undefined, gateway: GatewayClient | undefined, entry: InteractionEntry | undefined;
let scope: SessionScope | undefined, operationId = '', opened: Readonly<{ prompt: Prompt; form: FormHandle }> | null = null;
function Dialog() {
  const current = entry!, observation = useSyncExternalStore(current.subscribe, current.getSnapshot, current.getSnapshot);
  const exact = opened;
  if (!exact || !observation.snapshot?.items.some(item => item.prompt.id === exact.prompt.id)) return null;
  const respond: WorkspaceView['respond'] = (prompt, answer, id) => workspace!.answer(scope!, prompt, answer, id ?? operationId);
  return h(PromptDialog, { prompt: exact.prompt, form: exact.form, disabled: observation.stale || !observation.connected, respond,
    onLater: () => { opened = null; root.render(null); },
    onResult: (_capability, result) => { void result.then(value => { window.nativeUiReceipt = value as Receipt; }, () => { window.nativeUiFailure = 'NATIVE_UI_RESPONSE_FAILED'; }); },
  });
}
window.nativeUiConfigure = async (config, original) => {
  if (workspace) throw Error('Native prompt UI already configured');
  operationId = original; scope = config.scope; window.nativeUiReceipt = null; window.nativeUiFailure = null;
  const history = new HistoryWorkspace({ connection: scope.connection, principal: scope.principal });
  const transport = new HttpGatewayTransport({ url: config.url, authorization: config.authorization });
  gateway = new GatewayClient({ transport, history, targets: [config.target], onFence: () => workspace?.close() });
  workspace = new InteractionWorkspace({ session: gateway, port: gateway.interactionPort(scope) });
  await workspace.bind(scope); entry = workspace.entry(scope);
};
window.nativeUiHasPrompt = id => !!entry?.getSnapshot().snapshot?.items.some(item => item.prompt.id === id && item.state === 'pending');
window.nativeUiOpen = id => {
  if (!workspace || !scope || !entry) throw Error('Unconfigured native prompt UI');
  const prompt = entry.getSnapshot().snapshot?.items.find(item => item.prompt.id === id && item.state === 'pending')?.prompt;
  if (!prompt) throw Error('Exact pending native prompt unavailable');
  // Explicit open obtains the private capability outside React render. Later
  // removes only the mounted dialog; the actual workspace retains the form.
  opened = { prompt, form: workspace.form(scope, prompt) }; root.render(h(Dialog, { key: prompt.id }));
};
window.nativeUiClose = () => { opened = null; root.render(null); workspace?.close(); gateway?.close(); workspace = undefined; gateway = undefined; entry = undefined; scope = undefined; operationId = ''; };
window.nativeUiReady = true;
