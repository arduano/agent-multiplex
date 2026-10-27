import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
/** Actual scripted Host -> authenticated HTTP Gateway -> retained Workspace ->
 * mounted shared React child UI. The caller supplies an isolated Host emit. */
export async function qualifyChildInventory({ emitted = resolve(root, '.cache/r06-child-inventory/emit/primitives') } = {}) {
  const [{ openHost }, { scriptedHost }, { GatewayCoordinator }, { createGatewayHttpHandler }, { scopeKey }] = await Promise.all([
    import(pathToFileURL(resolve(emitted, 'v8-lifecycle-default/src/assembly.js'))),
    import(pathToFileURL(resolve(emitted, 'v8-host/qualification/fixture.js'))),
    import(pathToFileURL(resolve(emitted, 'v8-gateway/src/gateway/coordinator.js'))),
    import(pathToFileURL(resolve(emitted, 'v8-gateway/src/http/server.js'))),
    import(pathToFileURL(resolve(emitted, 'v8-history/src/contracts/identity.js'))),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'v8-child-stream-')), coordinator = new GatewayCoordinator(), owned = [], targets = [], entries = [];
  const catalog = { connection: 'child-stream', principal: 'owner', authority: 'authority' };
  let browser, server, handler;
  try {
    for (const kind of ['codex', 'copilot']) {
      const scope = { connection: catalog.connection, principal: catalog.principal, host: kind, session: kind }, cwd = join(directory, kind);
      await mkdir(cwd); const driver = scriptedHost(kind, { cwd }), host = await openHost({ directory: cwd, cwd, scope, controller: driver.controller,
        policy: kind === 'codex' ? { kind, provider: 'copilot-only', access: { approval: 'on-request', sandbox: 'danger-full-access' } } : { kind, provider: 'copilot-only', permissions: 'manual' } });
      owned.push({ host, driver, scope });
      await host.session.submit({ scope, id: `create-${kind}`, generation: 0, command: { type: 'create' } });
      const binding = await host.binding(), target = { ...scope, authority: catalog.authority, owner: `owned-${kind}`, routeEpoch: 'route-1' };
      assert.ok(binding); targets.push(target);
      coordinator.register({ target, session: host.session, history: host.history, interactions: host.interactions, mcp: host.mcp, binding: () => host.binding(), authorizeHistory: value => host.history.scopes().some(scope => scopeKey(scope) === scopeKey(value)) });
      entries.push({ scope: catalog, session: kind, target: { host: kind, owner: target.owner, kind, placement: 'dedicated' }, createId: `create-${kind}`, version: 1, revision: 1,
        metadata: { name: kind, cwd: '/scripted-workspace' }, binding: { kind, generation: binding.run.generation, nativeSession: binding.run.nativeSession, placement: 'dedicated' } });
    }
    const require = createRequire(resolve(root, 'package.json'));
    const bundle = await build({ stdin: { resolveDir: here, sourcefile: 'child-inventory-entry.ts', loader: 'ts', contents: `
      import {createElement as h,useSyncExternalStore,useEffect} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ChildHistories} from '../../v8-react-ui/src/child-history.js';
      import {MultiplexWorkspace} from '../../v8-workspace/src/workspace.js';
      import {MemoryDraftPersistence} from '../../v8-files/src/client/persistence.js';
      import {GatewayClient} from '../../v8-gateway/src/client/coordinator.js';
      import {HttpGatewayTransport} from '../../v8-gateway/src/client/http.js';
      const config=await(await fetch('/configuration')).json();
      const transport=new HttpGatewayTransport({url:location.origin+'/v8',authorization:'Bearer disposable-child-fixture'});
      const catalog={list:async()=>config.entries,get:async(_,session)=>config.entries.find(value=>value.session===session),creation:async()=>null,subscribe:()=>()=>{},metadataOriginal:async()=>null,
        create:async()=>{throw Error('NO_UI_CREATE')},rename:async()=>{throw Error('NO_RENAME')},setWatched:async()=>{throw Error('NO_WATCH')}};
      const workspace=new MultiplexWorkspace({scope:config.catalog,persistence:new MemoryDraftPersistence(),connect(context){
        const gateway=new GatewayClient({...context,transport,history:context.history,targets:config.targets});
        const target=scope=>config.targets.find(value=>value.host===scope.host&&value.session===scope.session);
        return {session:gateway,catalog,access:()=>({read:true,control:false,fileWrite:false,mcpRefresh:false,catalogWrite:false}),
          binding:scope=>transport.binding(target(scope)),filePort:scope=>transport.filePort(target(scope)),interactionPort:scope=>gateway.interactionPort(scope),mcpPort:scope=>gateway.mcpPort(scope),
          observeHistory:(scope,history)=>gateway.observeHistory(scope,history),historyScopes:scope=>gateway.historyScopes(scope),
          older:(scope,history,cursor,generation)=>gateway.older(scope,history,cursor,generation),recover:(scope,history,observation)=>gateway.recover(scope,history,observation),
          close:()=>gateway.close()};
      }});
      window.childSetup='codex';const codexView=await workspace.open('codex');window.childSetup='copilot';const copilotView=await workspace.open('copilot');const views={codex:codexView,copilot:copilotView};window.childSetup='mounted';
      const unexpected=()=>{throw Error('NO_MEDIA_READ')};
      function Agent({kind}) {const view=views[kind],snapshot=useSyncExternalStore(view.subscribe,view.getSnapshot,view.getServerSnapshot);useEffect(()=>{const lease=view.observe();return()=>lease.release()},[view]);
        return h('section',{'aria-label':kind,className:'multiplex-chat'},snapshot.kind==='disposed'?null:h(ChildHistories,{workspace,snapshot,preview:unexpected,previewLocal:unexpected,previewOptions:{}}));}
      const app=createRoot(document.getElementById('app'));app.render(h('main',null,h(Agent,{kind:'codex'}),h(Agent,{kind:'copilot'})));
      window.childStream={snapshot:kind=>views[kind].getSnapshot(),close(){app.unmount();workspace.close();transport.close()}};
    ` }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2023', define: { 'process.env.NODE_ENV': '"development"' },
      alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom/server': require.resolve('react-dom/server.browser') }, logLevel: 'silent', metafile: true });
    assert.equal(Object.keys(bundle.metafile.inputs).some(value => /\/src\/(host|node|gateway|http|authority)\//.test(value)), false);
    const identity = { ...catalog, authorities: [catalog.authority], actions: ['read'] };
    handler = createGatewayHttpHandler(coordinator, async authorization => authorization === 'Bearer disposable-child-fixture' ? identity : null);
    server = createServer((request, response) => {
      if (request.url === '/') response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><head><title>Child stream</title></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>');
      else if (request.url === '/entry.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
      else if (request.url === '/configuration') response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ catalog, entries, targets }));
      else handler(request, response);
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    browser = await chromium.launch({ executablePath: process.env.MULTIPLEX_CHROMIUM ?? '/run/current-system/sw/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
    const page = await browser.newPage(), errors = [], operations = [];
    page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push({code:error.message,frames:error.stack?.split('\n').slice(1,5)}));
    page.on('request', request => { if (request.url().endsWith('/v8') && request.postData()) operations.push(JSON.parse(request.postData()).op); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    try { await page.waitForFunction(() => ['codex','copilot'].every(kind => window.childStream?.snapshot(kind).historyScopes.state === 'observed')); }
    catch (error) {
      const stage = await page.evaluate(() => window.childSetup); const facts = await page.evaluate(() => ['codex','copilot'].map(kind => { const s = window.childStream?.snapshot(kind); return { kind, exists: !!s, nativePhase: s?.session?.native?.phase, inventoryState: s?.historyScopes?.state, historyPresent: !!s?.history?.current, historyInventory: s?.history?.current?.scopeInventory?.entries.length, observation: s?.observation }; }));
      throw new Error(JSON.stringify({ stage: 'initial-root-stream', opening:stage, facts, errors, operations }), { cause: error });
    }
    for (const kind of ['codex', 'copilot']) await page.getByRole('region', { name: kind, exact: true }).locator('summary').click();
    const codex = owned[0], codexRoot = (await codex.host.binding()).history;
    codex.driver.notify('thread/started', { thread: { id: 'codex-child', sessionId: 'codex-child', parentThreadId: codexRoot.threadId,
      source: { subAgent: { thread_spawn: { parent_thread_id: codexRoot.threadId, agent_path: '/root/native-worker' } } }, agentNickname: 'Native nickname', agentRole: 'reviewer', model: 'configured-model', status: { type: 'active' } } });
    const codexRow = page.locator('[data-native-agent="codex-child"]');
    await codexRow.getByRole('button', { name: 'View agent codex-child', exact: true }).waitFor(); await codexRow.getByText('Configured: configured-model', { exact: true }).waitFor();
    assert.ok((await codexRow.innerText()).includes('Native nickname')); assert.equal(codex.host.history.snapshot(codexRoot).rows.length, 0, 'Metadata-only discovery has no parent body/delegation row');
    codex.driver.notify('item/completed', { threadId: codexRoot.threadId, turnId: 'parent-turn', item: { id: 'child-start', type: 'subAgentActivity', kind: 'started', agentThreadId: 'codex-child', agentPath: '/root/native-worker', model: 'resolved-model' } });
    await codexRow.getByText('Resolved at start: resolved-model', { exact: true }).waitFor(); assert.ok((await codexRow.innerText()).includes('running'));
    const copilot = owned[1];
    copilot.driver.event('subagent.started', { toolCallId: 'old-task', agentName: 'worker', agentDisplayName: 'Old invocation', model: 'old-start' }, 'copilot-child');
    copilot.driver.event('subagent.completed', { toolCallId: 'old-task', agentName: 'worker', model: 'old-completion', firstDispatchedModel: 'old-dispatched' }, 'copilot-child');
    copilot.driver.event('subagent.started', { toolCallId: 'new-task', agentName: 'worker', agentDisplayName: 'Current invocation', model: 'new-start' }, 'copilot-child');
    copilot.driver.event('subagent.completed', { toolCallId: 'old-task', agentName: 'worker', model: 'old-completion', firstDispatchedModel: 'old-dispatched' }, 'copilot-child');
    const copilotRow = page.locator('[data-native-agent="copilot-child"]'); await copilotRow.getByText('Resolved at start: new-start', { exact: true }).waitFor();
    assert.ok((await copilotRow.innerText()).includes('Current invocation')); assert.ok((await copilotRow.innerText()).includes('running')); assert.ok(!(await copilotRow.innerText()).includes('old-completion')); assert.ok(!(await copilotRow.innerText()).includes('old-dispatched'));
    copilot.driver.event('subagent.started', { toolCallId: 'nested-old', parentId: 'new-task', agentName: 'nested', agentDisplayName: 'Nested old', model: 'nested-old-model' }, 'nested-child');
    copilot.driver.event('subagent.completed', { toolCallId: 'nested-old', agentName: 'nested', model: 'nested-old-completion', firstDispatchedModel: 'nested-old-dispatch' }, 'nested-child');
    copilot.driver.event('subagent.started', { toolCallId: 'nested-new', parentId: 'new-task', agentName: 'nested', agentDisplayName: 'Nested current', model: 'nested-new-model' }, 'nested-child');
    copilot.driver.event('subagent.completed', { toolCallId: 'nested-old', agentName: 'nested', model: 'nested-old-completion', firstDispatchedModel: 'nested-old-dispatch' }, 'nested-child');
    const nested = page.locator('[data-native-agent="nested-child"]'); await nested.getByText('Resolved at start: nested-new-model', { exact: true }).waitFor();
    assert.ok((await nested.innerText()).includes('Nested current')); assert.ok((await nested.innerText()).includes('running')); assert.ok(!(await nested.innerText()).includes('nested-old-completion'));
    assert.equal(copilot.host.history.snapshot((await copilot.host.binding()).history).rows.some(row => row.native.toolCallId === 'nested-new'), false, 'Nested summary metadata did not manufacture a root transcript row');
    copilot.driver.event('subagent.completed', { toolCallId: 'new-task', agentName: 'worker', agentDisplayName: 'Current invocation', model: 'reported-model', firstDispatchedModel: 'dispatched-model', explicitModelOverride: 'requested-model', configuredModelPreference: 'preferred-model' }, 'copilot-child');
    for (const label of ['Requested: requested-model', 'Configured: preferred-model', 'First dispatched: dispatched-model', 'Completion reported: reported-model']) await copilotRow.getByText(label, { exact: true }).waitFor();
    assert.ok((await copilotRow.innerText()).includes('completed'));
    assert.equal(operations.filter(op => op === 'history.scopes').length, 0); assert.equal(operations.filter(op => ['history.recover','history.older','submit','native.read'].includes(op)).length, 0);
    await codexRow.getByRole('button', { name: 'View agent codex-child', exact: true }).click(); await page.getByRole('dialog').getByRole('heading', { name: 'Agent history · codex-child' }).waitFor();
    assert.equal(await page.getByRole('dialog').locator('[data-action=send],[data-action=stop],[data-action=confirmation]').count(), 0); await page.getByRole('button', { name: 'Close agent history', exact: true }).click();
    await codex.host.session.submit({ scope: codex.scope, id: 'explicit-stop', generation: 1, command: { type: 'stop' } });
    await page.waitForFunction(() => window.childStream.snapshot('codex').session.native.phase === 'stopped');
    await page.waitForFunction(() => window.childStream.snapshot('codex').agents[0]?.status === 'stopped');
    assert.ok(!(await codexRow.innerText()).includes('running'), 'Positive root nativeTree Stop cannot display a child as currently running');
    assert.deepEqual(errors, []);
    for (const { driver } of owned) assert.deepEqual({ sends: driver.counts.sends, resumes: driver.counts.resumes, bodyReads: driver.counts.bodyReads }, { sends: 0, resumes: 0, bodyReads: 0 });
    await page.evaluate(() => window.childStream.close());
    return { status: 'PASS', seams: ['metadata-only Codex native lineage streams identity/nickname/configured model without parent rows', 'mounted Copilot newest-invocation status with distinct requested/configured/started/dispatched/completion provenance', 'same authenticated Gateway and retained workspace authorize readonly child modal with no body read or mutation'], bundleHash: createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex'), scriptedOnly: true };
  } finally {
    await browser?.close(); handler?.close(); if (server) { server.closeAllConnections(); await new Promise(yes => server.close(yes)); } coordinator.close();
    for (const { host, scope } of owned.reverse()) { const state = await host.session.snapshot(scope); if (state.phase !== 'stopped') await host.session.submit({ scope, id: 'cleanup-stop', generation: state.generation, command: { type: 'stop' } }); await host.terminate(); }
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const out = resolve(root, '.cache/r06-child-inventory/browser'); await mkdir(out, { recursive: true });
  const option = process.argv.indexOf('--emitted');
  const result = await qualifyChildInventory(option < 0 ? {} : { emitted: resolve(process.argv[option + 1]) }); await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2)+'\n'); process.stdout.write(JSON.stringify(result)+'\n');
}
