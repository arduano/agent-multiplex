import type { workspaceFixture } from './fixture.js';
import { HistoryHub } from '../../v8-history/src/host/history-owner.js';
import { createCodexCodec } from '../../v8-history/src/native/codex/index.js';
import type { WorkspaceView } from '../src/contracts.js';
import type { CodexScope } from '../../v8-history/src/contracts/types.js';

/** Actual codec → HistoryOwner → retained client. No native/SDK process or IO. */
export function capturePlan(root: CodexScope, nativeGeneration: number, plans: readonly string[] = ['The completed native plan']) {
  const hub = new HistoryHub({ maxBodyBytes: 65_536 }), codec = createCodexCodec({ origin: root.origin, rootThreadId: root.threadId, capture: hub, knownStart: true });
  const threadId = root.threadId;
  for (const [index, text] of plans.entries()) {
    const suffix = index ? '-' + index : '', turnId = 'plan-turn' + suffix, item = { type: 'plan', id: 'native-plan' + suffix, text };
    for (const [method, params] of [
    ['turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [], itemsView: 'notLoaded' } }],
    ['item/started', { threadId, turnId, item: { ...item, text: '' } }],
    ['item/completed', { threadId, turnId, item }],
    ['turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [], itemsView: 'notLoaded' } }],
    ] as const) codec.observe({ method, params });
  }
  hub.owner(root).setScopeInventory({ nativeGeneration, entries: [{ scope: root }] });
  const snapshot = hub.snapshot(root), row = snapshot.rows.find(value => value.native.type === 'plan');
  if (!row || row.lifecycle !== 'completed' || row.body.kind !== 'complete') throw Error('Completed native plan was not captured');
  return { row, root, snapshot, rollWindow() {
    const turnId = 'later-turn';
    codec.observe({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    for (let index = 0; index < 64; index++) codec.observe({ method: 'item/completed', params: {
      threadId, turnId, item: { type: 'agentMessage', id: `later-message-${index}`, text: `Later native message ${index}` },
    } });
    codec.observe({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    return hub.snapshot(root);
  } };
}
export function installPlan(f: ReturnType<typeof workspaceFixture>, view: WorkspaceView, session = 'a', plans?: readonly string[]) {
  const binding = f.bindings.get(session)!, root = binding.history;
  if (root.kind !== 'codex') throw Error('Codex fixture required');
  const capture = capturePlan(root, binding.run.generation, plans), { snapshot } = capture;
  const lease = view.observe();
  f.history.session(root).client.apply({ kind: 'snapshot', snapshot });
  f.native.publish(binding.run.scope, { selection: { kind: 'codex', model: 'original', effort: 'low', collaboration: { mode: 'plan', model: 'original', effort: 'low' } } });
  return { ...capture, release: () => lease.release() };
}
