import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { buildChatStyles } from '../build/styles.mjs';

// The actual retained workspace/chat under held receipt and native frames.
// Historical before/after layout receipts remain immutable in prior cache receipts.
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
const require = createRequire(resolve(root, 'package.json')), cssPath = resolve(here, '../src/chat.css'), chatPath = resolve(here, '../src/chat.ts');
const sha = value => createHash('sha256').update(value).digest('hex');
const choicesOnly = process.argv.includes('--choices-only');
const historyOnly = process.argv.includes('--history-only');
const source = await readFile(chatPath, 'utf8');
const base = resolve(here, '../.cache/composer-layout'); await mkdir(base, { recursive: true });
const receipt = await mkdtemp(resolve(base, 'browser-')), bundles = new Map(), inputs = new Set([cssPath, chatPath, fileURLToPath(import.meta.url), resolve(root, 'package.json'), resolve(root, 'package-lock.json')]);
const styles = await buildChatStyles({outdir:resolve(receipt,'styles'),minify:false}), css = await readFile(styles.stylesheet,'utf8');
for(const path of Object.keys(styles.metafile.inputs)) inputs.add(resolve(path));
for(const name of ['styles.mjs','ui-styles.mjs']) inputs.add(resolve(here,'../build',name));
const producer = await build({ stdin: { resolveDir: here, sourcefile: 'history-output-producer.ts', contents: `
import {HistoryHub} from '../../v8-history/src/host/history-owner.js';
import {createCodexCodec} from '../../v8-history/src/native/codex/index.js';
export function capturedOutput(){const scope={kind:'codex',origin:{connection:'fixture',principal:'owner',host:'host',nativeSession:'native-a',attachment:'attachment-a'},threadId:'native-a'},hub=new HistoryHub(),codec=createCodexCodec({origin:scope.origin,rootThreadId:scope.threadId,capture:hub,knownStart:true});
const emit=(method,params)=>codec.observe({method,params}),threadId=scope.threadId,turnId='captured-output-turn';hub.owner(scope).setScopeInventory({nativeGeneration:1,entries:[{scope}]});
emit('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});emit('item/started',{threadId,turnId,item:{type:'agentMessage',id:'final-output',text:'',phase:'final_answer'}});emit('item/agentMessage/delta',{threadId,turnId,itemId:'final-output',delta:'Exact captured final prefix'});const working=hub.snapshot(scope);
emit('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});const partial=hub.snapshot(scope);
emit('item/completed',{threadId,turnId,item:{type:'agentMessage',id:'final-output',text:'Exact completed final answer',phase:'final_answer'}});return [working,partial,hub.snapshot(scope)];}
`, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2023', metafile: true, logLevel: 'silent' });
const { capturedOutput } = await import('data:text/javascript;base64,' + Buffer.from(producer.outputFiles[0].contents).toString('base64'));
const capturedFrames = capturedOutput(); for(const path of Object.keys(producer.metafile.inputs)) if(!path.endsWith('history-output-producer.ts')) inputs.add(resolve(path));
const fixture = `
  import {createElement as h,StrictMode} from 'react';import {createRoot} from 'react-dom/client';
  import {MultiplexChat} from '../src/chat.js';import {workspaceFixture,deferred} from '../../v8-workspace/qualification/fixture.js';
  import {MemoryDraftPersistence} from '../../v8-files/src/client/persistence.js';
  const catalogWaits=[];let recoveryChecks=0,recoveryWait,draftGate,failDraft=false;const persistence=new MemoryDraftPersistence(),putComposer=persistence.putComposer.bind(persistence);persistence.putComposer=async(...args)=>{if(draftGate)await draftGate.promise;if(failDraft){failDraft=false;throw Error('Scripted draft storage unavailable');}return putComposer(...args);};const f=workspaceFixture({persistence,controlCatalog:()=>new Promise((resolve,reject)=>catalogWaits.push({resolve,reject}))});
  const client=f.history.session(f.bindings.get('a').history).client;client.apply({kind:'snapshot',snapshot:{scope:f.bindings.get('a').history,generation:'host-generation',revision:1,rows:[],retirements:[],coverage:{knownStart:true,gaps:[]},olderEdge:{state:'end',evidence:'nativeBoundary'},activity:{turnId:null,state:'idle'}}});
  const retryTokens=[];const ownedView=await f.workspace.open('a'),view={...ownedView,async recoverHistory(observation,retryToken){recoveryChecks++;retryTokens.push(retryToken??null);const wait=recoveryWait,result=await ownedView.recoverHistory(observation,retryToken);return wait?await wait.promise:result;}},lease=view.observe();let held,submitted=0;
  ${choicesOnly ? "f.native.publish(f.snapshot('a').scope,{selection:{kind:'codex',model:'original',effort:'ultra',collaboration:{mode:'default',model:'original',effort:'ultra'}}});" : ''}
  f.native.invoke=async request=>{submitted++;held=deferred();await held.promise;return{scope:request.scope,id:request.id,type:request.command.type,generation:request.generation,state:'acknowledged',outcome:{status:'accepted'}};};
  const retainedRows=Array.from({length:30},(_,i)=>({id:'retained-'+i,kind:'assistant',lifecycle:'completed',body:{kind:'complete',text:'Retained history row '+i+'\\n\\nA stable paragraph for the earlier-reading anchor.',evidence:'nativeFullBody'},native:{},version:1,contentVersion:1}));const react=createRoot(document.getElementById('app'));const mount=value=>react.render(value?h(StrictMode,null,h(MultiplexChat,{view})):null);mount(true);let secondRoot,secondElement;
  Object.assign(window,{emptyHistoryFixture:{checks:()=>recoveryChecks,retries:()=>retryTokens,
    read(value){const current=client.current;client.apply({kind:'snapshot',snapshot:{...current,revision:current.revision+1,read:value}});},
    empty(knownStart){const current=client.current;client.apply({kind:'snapshot',snapshot:{...current,revision:current.revision+1,rows:[],read:{state:'idle'},coverage:{knownStart,gaps:[]},olderEdge:knownStart?{state:'end',evidence:'nativeBoundary'}:{state:'unknown',reason:'cold-history-not-read'}}});},
    unknownRows(){const current=client.current;client.apply({kind:'snapshot',snapshot:{...current,revision:current.revision+1,rows:retainedRows,read:{state:'idle'},coverage:{knownStart:false,gaps:[{id:'fixture-prefix',kind:'missingPrefix'}]},olderEdge:{state:'unknown',reason:'prefix-not-read'}}});},
    pulse(){const current=client.current;client.apply({kind:'snapshot',snapshot:{...current,revision:current.revision+1}});},
    context(value){const current=client.current;client.apply({kind:'snapshot',snapshot:{...current,revision:current.revision+1,readContext:value,read:{state:'idle'}}});},hold(){recoveryWait=deferred();},finish(result){const wait=recoveryWait;recoveryWait=null;wait.resolve(result);},
    captured(index){const snapshot=${JSON.stringify(capturedFrames)}[index],binding=f.bindings.get('a'),native=f.snapshot('a');f.observation({scope:native.scope,kind:'session',state:'live'});f.observation({scope:native.scope,kind:'history',history:binding.history,state:'live'});f.native.publish(native.scope,{activity:index===0?'working':'idle',attention:{state:index===0?'working':'finished',cause:{source:'codex.turn',id:'captured-output-turn'},nativeSession:native.nativeSession,generation:native.generation,epoch:native.epoch,revision:native.revision+1}});client.apply({kind:'snapshot',snapshot});},
    restore(){const current=client.current;client.apply({kind:'snapshot',snapshot:{...current,revision:current.revision+1,rows:retainedRows,read:{state:'idle'},coverage:{knownStart:true,gaps:[]},olderEdge:{state:'available',cursor:'owned-older-edge'}}});}}});
  Object.assign(window,{composerFixture:{state:()=>view.getSnapshot().composer.state,restore(text){const s=view.getSnapshot();view.setDraft({...s.composer.value,text});},hold(){draftGate=deferred();},release(){const gate=draftGate;draftGate=null;gate?.resolve();},fail(){failDraft=true;},async attach(){const file=await view.saveFile({name:'inline-layout.txt',mediaType:'text/plain',blob:new Blob(['owned layout fixture'])});const snapshot=view.getSnapshot();view.setDraft({...snapshot.composer.value,fileIds:[file.manifest.id]});}}});
  Object.assign(window,{layoutFixture:{ready:true,counts:()=>f.counts(),mount,second(value){secondRoot?.unmount();secondElement?.remove();secondRoot=null;secondElement=null;if(value){secondElement=document.createElement('div');secondElement.id='second-controls';Object.assign(secondElement.style,{position:'fixed',top:'0',right:'0',width:'390px',height:'360px'});document.body.append(secondElement);secondRoot=createRoot(secondElement);secondRoot.render(h(StrictMode,null,h(MultiplexChat,{view:f.workspace.view('a','second-controls')})));}},settings(){const s=view.getSnapshot();return{observed:s.session.native.selection,draft:s.session.draft,catalog:s.modelCatalog.state};},selection(value){view.getSnapshot().actions.setSelectionDraft(value);},models(success){const wait=catalogWaits.shift();if(!wait)throw Error('No admitted model read');if(success)wait.resolve({available:true,choices:[{model:'original',displayName:'Current native label',description:'Everyday tasks',efforts:${choicesOnly ? "['low','ultra']" : "['low']"},defaultEffort:'low'},{model:'next-model',displayName:'Alternate native label',description:'Specialized searchable tasks',efforts:['high']}]});else wait.reject(Error('Scripted catalog unavailable'));},submitted:()=>submitted,operations:()=>view.getSnapshot().operations,commands:()=>f.native.submitted.map(request=>request.command),working(){const binding=f.bindings.get('a'),current=client.current;client.apply({kind:'snapshot',snapshot:{...current,revision:current.revision+1,activity:{state:'working',turnId:'active-turn'},scopeInventory:{nativeGeneration:binding.run.generation,entries:[{scope:binding.history}]}}});const native=f.snapshot('a');f.native.publish(native.scope,{activity:'working',capabilities:{...native.capabilities,commands:[...native.capabilities.commands,'codex.steer','codex.queue.add']}});},release:()=>held.resolve(),close(){held?.resolve();recoveryWait?.resolve({state:'retired'});for(const wait of catalogWaits.splice(0))wait.reject(Error('Fixture closed'));secondRoot?.unmount();secondElement?.remove();react.unmount();lease.release();f.workspace.close();return f.counts();}}});
`;
for (const [name, contents] of [['current', source]]) {
  const bundled = await build({ stdin: { resolveDir: here, sourcefile: 'composer-layout-fixture.ts', loader: 'ts', contents: fixture }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2023', metafile: true,
    plugins: [{ name: 'frozen-chat-order', setup(api) { api.onLoad({ filter: /[/\\]chat\.ts$/ }, () => ({ contents, loader: 'ts', resolveDir: dirname(chatPath) })); } }],
    alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client') }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' });
  bundles.set(name, bundled.outputFiles[0].contents);
  for (const path of Object.keys(bundled.metafile.inputs)) if (!path.endsWith('/composer-layout-fixture.ts')) inputs.add(resolve(path));
}
const sources = await Promise.all([...inputs].sort().map(async path => ({ path: relative(root, path), sha256: sha(await readFile(path)) })));
await writeFile(resolve(receipt, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
const variants = [], errors = [], external = [], steps = [], cleanup = { browser: false, server: false };
let browser, context, server, result, timer, page;
try {
  await Promise.race([(async () => {
    server = createServer((request, response) => {
      const name = request.url?.slice(1);
      if (name?.endsWith('.js') && bundles.has(name.slice(0, -3))) response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundles.get(name.slice(0, -3)));
      else if (bundles.has(name)) response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Composer receipt layout</title><style>html,body{margin:0;height:100%;}#app{width:100%;height:100dvh;}${css}</style></head><body><div id="app"></div><script type="module" src="/${name}.js"></script></body></html>`);
      else response.writeHead(404).end();
    });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.MULTIPLEX_CHROMIUM ?? '/run/current-system/sw/bin/chromium', headless: true, timeout: 15000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push('DENIED'); return route.abort(); });
    page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.name));
    const openTools = async () => { await page.getByRole('button',{name:'More message actions',exact:true}).click(); await page.getByRole('menuitem',{name:'Session tools',exact:true}).click(); await page.getByRole('dialog',{name:'Session tools',exact:true}).waitFor(); };
    const settleLayout = () => page.evaluate(() => new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept))));
    const geometry = () => page.evaluate(() => {
      const box = selector => { const element = document.querySelector(selector); if (!element) return null; const rect = element.getBoundingClientRect(); return { y: rect.y, height: rect.height }; };
      const history = document.querySelector('[data-action=history]'), top = history.getBoundingClientRect().top;
      const anchor = [...history.querySelectorAll('[data-row]')].find(element => element.getBoundingClientRect().bottom > top);
      return { composer: box('.mpx-chat__composer'), header: box('.mpx-chat__heading'), history: box('[data-action=history]'), operations: box('[data-action=latest-action]'), anchor: anchor ? { id: anchor.getAttribute('data-row'), offset: anchor.getBoundingClientRect().top - top } : null };
    });
    const composerGeometry = () => page.evaluate(() => {
      const selectors = { composer: '.mpx-chat__composer', message: '[data-action=message]', actions: '.mpx-chat__composer-actions',
        settings: '.mpx-chat__composer-toolbar', historyColumn: '[data-action=history] .mpx-chat__row--assistant',
        add: '.mpx-chat__composer button[aria-label="Add files or photo"]', stop: '[data-action=stop]', primary: '.mpx-chat__composer button[type=submit]',
        more: '.mpx-chat__composer button[aria-label="More message actions"]', attachments: '.mpx-chat__composer .mpx-chat__attachments' };
      const boxes = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
        const element = document.querySelector(selector); if (!element) return [name, null];
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return [name, { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right, hit: hit === element || element.contains(hit) }];
      }));
      return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1,
        sameMessage: window.retainedLayoutMessage === document.querySelector('[data-action=message]'),
        controlsLayout:document.querySelector('.mpx-chat__inline-settings').dataset.layout,
        directControls:[...document.querySelectorAll('.mpx-chat__composer-toolbar [data-action=next-mode],.mpx-chat__composer-toolbar [data-action=next-effort]')].map(x=>x.dataset.action),
        saveChatter: /Draft saved|Saving draft/.test(document.querySelector('.multiplex-chat').textContent), boxes };
    });
    const assertComposer = facts => {
      assert.equal(facts.overflow, false, JSON.stringify(facts)); assert.equal(facts.sameMessage, true);
      for (const name of ['composer', 'settings', 'historyColumn', 'message', 'actions', 'add', 'stop', 'primary', 'more']) assert.ok(facts.boxes[name], `Missing geometry: ${name}`);
      const { composer, settings, historyColumn, message, actions } = facts.boxes;
      for (const column of [historyColumn]) {
        assert.ok(Math.abs(column.x - composer.x) <= 1 && Math.abs(column.width - composer.width) <= 1, `Common content column: ${JSON.stringify(facts)}`);
      }
      assert.ok(composer.width <= 781, JSON.stringify(facts));
      assert.ok(message.bottom <= settings.y + 1 && settings.y <= actions.y + 1, `Fullwidth textarea above one toolbar: ${JSON.stringify(facts)}`);
      assert.ok(Math.abs(message.x - settings.x) < 1 && Math.abs(message.width - settings.width) < 1, `Input and toolbar share the full content width: ${JSON.stringify(facts)}`);
      assert.equal(facts.controlsLayout,facts.width>=680?'direct':'compact');
      assert.deepEqual(facts.directControls,facts.width>=680?['next-mode','next-effort']:[]);
      for (const name of ['message', 'add', 'stop', 'primary', 'more']) {
        const box = facts.boxes[name];
        assert.ok(box.x >= 0 && box.y >= 0 && box.right <= facts.width + 1 && box.bottom <= facts.height + 1 && box.hit, `Reachable ${name}: ${JSON.stringify(facts)}`);
        assert.ok(box.height >= 44 && box.width >= 44, `44px ${name}: ${JSON.stringify(facts)}`);
      }
      if (facts.boxes.attachments) assert.ok(facts.boxes.attachments.y >= Math.max(message.bottom, actions.bottom) - 1, `Attachments follow the toolbar: ${JSON.stringify(facts)}`);
      assert.equal(facts.saveChatter, false, 'Normal draft saves have no transient status text');
    };
    for (const variant of ['current']) {
      await page.goto(`${origin}/${variant}`); await page.locator('[data-action=message]').waitFor();
      if (choicesOnly) {
        const app = page.locator('#app'), effort = app.locator('[data-action=next-effort]');
        steps.push('automatic-catalog'); await page.waitForFunction(() => window.layoutFixture.counts().controlReads === 1);
        assert.match(await effort.innerText(), /ultra/); assert.equal(await effort.isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: /Load.*choices/ }).count(), 0);
        await page.evaluate(() => window.layoutFixture.second(true)); await page.locator('#second-controls [data-action=message]').waitFor();
        await settleLayout(); assert.equal((await page.evaluate(() => window.layoutFixture.counts())).controlReads, 1, 'StrictMode and a second prepared view share the retained catalog job');
        await page.evaluate(() => { window.layoutFixture.mount(false); window.layoutFixture.selection({kind:'codex',model:'original',effort:'ultra'}); });
        await app.locator('[data-action=message]').waitFor({state:'detached'});
        await page.evaluate(() => window.layoutFixture.mount(true)); await app.locator('[data-action=message]').waitFor();
        await page.evaluate(() => window.layoutFixture.second(false)); await settleLayout();
        assert.equal((await page.evaluate(() => window.layoutFixture.counts())).controlReads, 1, 'Unmount/remount does not admit another read');
        assert.equal((await effort.innerText()).trim(), 'ultra', 'A held catalog cannot declare the retained effort unavailable');
        await app.locator('[data-action=session-controls]').click();
        assert.equal((await app.getByRole('dialog',{name:'Agent settings',exact:true}).locator('[data-action=next-model]').innerText()).trim(), 'original', 'A held catalog cannot declare the retained model unavailable');
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.layoutFixture.models(false));
        await page.waitForFunction(() => window.layoutFixture.settings().catalog === 'unavailable');
        assert.equal((await effort.innerText()).trim(), 'ultra', 'An unavailable catalog is not proof of exclusion');
        await page.evaluate(() => window.layoutFixture.mount(false)); await app.locator('[data-action=message]').waitFor({state:'detached'});
        await page.evaluate(() => window.layoutFixture.mount(true)); await app.locator('[data-action=message]').waitFor(); await settleLayout();
        assert.equal((await page.evaluate(() => window.layoutFixture.counts())).controlReads, 1, 'A retained failure has no automatic retry loop');
        await app.locator('[data-action=session-controls]').click();
        const settings = app.getByRole('dialog', { name: 'Agent settings', exact: true });
        await settings.getByRole('button', { name: 'Retry model choices', exact: true }).click();
        await page.waitForFunction(() => window.layoutFixture.counts().controlReads === 2);
        assert.match(await effort.innerText(), /ultra/);
        await page.evaluate(() => window.layoutFixture.models(true)); await effort.locator(':scope:enabled').waitFor();
        assert.match(await effort.innerText(), /ultra/); assert.deepEqual((await page.evaluate(() => window.layoutFixture.settings())).draft,{kind:'codex',model:'original',effort:'ultra'});
        await page.keyboard.press('Escape');
        await effort.click(); const effortOptions=app.getByRole('listbox');
        assert.ok(await effortOptions.getByRole('option',{name:'ultra',exact:true}).count());
        await page.keyboard.press('Escape');
        await app.locator('[data-action=next-mode]').click(); await app.getByRole('option',{name:'Plan',exact:true}).click();
        await app.locator('[data-action=session-controls]').click();
        await settings.locator('[data-action=next-model]').click();
        await app.getByRole('option').filter({hasText:'Alternate native label'}).click();
        await page.keyboard.press('Escape');
        assert.match(await effort.innerText(), /ultra \(not offered\)/);
        const changed=await page.evaluate(() => window.layoutFixture.settings());
        assert.equal(changed.draft.effort,'ultra');assert.equal(changed.draft.collaboration.effort,'ultra');assert.equal(changed.draft.collaboration.model,'next-model');
        assert.equal(changed.observed.model,'original');assert.equal(changed.observed.effort,'ultra');
        await effort.click(); await app.getByRole('option',{name:'high',exact:true}).click();
        assert.equal((await page.evaluate(() => window.layoutFixture.settings())).draft.effort,'high');
        const counts = await page.evaluate(() => window.layoutFixture.counts()); assert.equal(counts.controlReads, 2); assert.equal(counts.submitted, 0);
        await page.screenshot({ path: resolve(receipt, 'choices-loaded.png') });
        const disposed = await page.evaluate(() => window.layoutFixture.close()); assert.equal(disposed.streams, 0);
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
        for (const input of sources) assert.equal(sha(await readFile(resolve(root, input.path))), input.sha256, `Changed source: ${input.path}`);
        result = { passed: true, sourceHash: sha(JSON.stringify(sources)), currentChatHash: sha(source), scope: 'automatic retained catalog through StrictMode/two prepared views/remount; current Ultra and late intent retained; explicit offered effort required after model change', automaticModelReads: 1, explicitRetryReads: 1, scriptedSubmits: 0, streamsAfterClose: 0, nativeCalls: 0, modelCalls: 0 }; return;
      }
      assert.equal(await page.locator('[data-original]').count(), 0);
      steps.push('empty-history'); await page.evaluate(() => window.emptyHistoryFixture.empty(true));
      await page.getByText('Start a conversation', { exact: true }).waitFor();
      await page.getByText('Start of available history', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.emptyHistoryFixture.checks()), 0);
      await page.evaluate(() => window.emptyHistoryFixture.empty(false));
      await page.getByText('History not loaded', { exact: true }).waitFor();
      assert.equal(await page.getByText('Start a conversation', { exact: true }).count(), 0);
      const recovery = page.getByRole('button', { name: 'Check earlier history', exact: true }); await recovery.waitFor();
      assert.equal(await page.evaluate(() => window.emptyHistoryFixture.checks()), 0, 'Unknown empty history does not read automatically');
      await openTools();
      assert.equal(await page.getByRole('dialog', { name: 'Session tools', exact: true }).getByRole('button', { name: /Check (missing|earlier) history/ }).count(), 0, 'The top action has no duplicate hidden recovery control');
      await page.getByRole('button', { name: 'Close session tools', exact: true }).click();
      await recovery.click(); await page.waitForFunction(() => window.emptyHistoryFixture.checks() === 1);
      await page.getByText('This Host cannot read missing history here. Captured messages are retained.', { exact: true }).waitFor();
      await page.evaluate(() => { window.emptyHistoryFixture.unknownRows(); window.emptyHistoryFixture.hold(); });
      assert.equal(await page.locator('[data-action=history] [data-row]').count(), 30);
      assert.equal(await page.getByText('History not loaded', { exact: true }).count(), 0);
      assert.equal(await recovery.count(), 1, 'Unknown nonempty history exposes the same single top boundary');
      await recovery.scrollIntoViewIfNeeded(); await settleLayout();
      assert.equal(await page.evaluate(() => window.emptyHistoryFixture.checks()), 1, 'Scrolling to the boundary performs no recovery');
      await recovery.click(); await page.getByRole('button', { name: 'Checking earlier history…', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Checking earlier history…', exact: true }).isDisabled(), true);
      await page.waitForFunction(() => window.emptyHistoryFixture.checks() === 2);
      await page.evaluate(() => window.emptyHistoryFixture.finish({ state: 'failed', code: 'PROTECTED_ROW_CAPACITY' }));
      await page.getByText('Earlier history could not be loaded. Loaded messages are retained.', { exact: true }).waitFor();
      assert.equal(await recovery.count(), 0, 'A settled failed fact has no futile repeat action');
      assert.equal(await page.getByText('PROTECTED_ROW_CAPACITY', { exact: false }).count(), 0);
      await page.evaluate(() => window.emptyHistoryFixture.pulse()); await settleLayout();
      assert.equal(await recovery.count(), 0, 'An unrelated revision does not manufacture another read allowance');
      await page.evaluate(() => { window.emptyHistoryFixture.context('changed-reader'); window.emptyHistoryFixture.hold(); });
      await recovery.waitFor(); await recovery.click(); await page.waitForFunction(() => window.emptyHistoryFixture.checks() === 3);
      await page.evaluate(() => window.emptyHistoryFixture.context('replacement-reader'));
      await recovery.waitFor(); assert.equal(await recovery.isEnabled(), true);
      await page.evaluate(() => window.emptyHistoryFixture.finish({ state: 'value', value: { status: 'unsupported' } })); await settleLayout();
      assert.equal(await page.getByText('This Host cannot read missing history here. Captured messages are retained.', { exact: true }).count(), 0, 'A late prior-context result cannot enter the replacement boundary');
      await page.evaluate(() => window.emptyHistoryFixture.hold()); await recovery.click();
      await page.waitForFunction(() => window.emptyHistoryFixture.checks() === 4);
      await page.evaluate(() => window.emptyHistoryFixture.finish({ state: 'waitingExpired' }));
      await page.getByText('The wait ended while the Host still owns the history read. Captured messages are retained.', { exact: true }).waitFor();
      await page.evaluate(() => window.emptyHistoryFixture.read({state:'pending',target:{kind:'recover'}}));
      const stillPending=page.getByRole('button',{name:'Checking earlier history…',exact:true});await stillPending.waitFor();assert.equal(await stillPending.isDisabled(),true,'Observer expiry does not free actual work');
      await page.evaluate(()=>window.layoutFixture.mount(false));await page.locator('.mpx-chat').waitFor({state:'detached'});await page.evaluate(()=>window.layoutFixture.mount(true));await stillPending.waitFor();assert.equal(await stillPending.isDisabled(),true);assert.equal(await page.evaluate(()=>window.emptyHistoryFixture.checks()),4,'Remount joins retained pending state without a read');
      await page.evaluate(()=>window.emptyHistoryFixture.read({state:'settled',target:{kind:'recover'},outcome:'failed',retryToken:'exact-failed-episode'}));
      const retry=page.getByRole('button',{name:'Retry loading history',exact:true});await retry.waitFor();
      await page.evaluate(()=>window.layoutFixture.mount(false));await page.locator('.mpx-chat').waitFor({state:'detached'});await page.evaluate(()=>window.layoutFixture.mount(true));await retry.waitFor();assert.equal(await page.evaluate(()=>window.emptyHistoryFixture.checks()),4);
      await page.evaluate(()=>window.emptyHistoryFixture.hold());await retry.click();await page.waitForFunction(()=>window.emptyHistoryFixture.checks()===5);assert.equal((await page.evaluate(()=>window.emptyHistoryFixture.retries())).at(-1),'exact-failed-episode');
      await page.evaluate(()=>{window.emptyHistoryFixture.read({state:'settled',target:{kind:'recover'},outcome:'failed'});window.emptyHistoryFixture.finish({state:'failed',code:'READ_FAILED'});});await page.getByText('Earlier history could not be loaded. Loaded messages are retained.',{exact:true}).waitFor();assert.equal(await retry.count(),0);
      steps.push('codec-output');await page.evaluate(()=>window.emptyHistoryFixture.captured(0));await page.locator('[data-action=working-indicator]').waitFor();await page.getByText('Exact captured final prefix',{exact:true}).waitFor();assert.equal(await page.locator('[data-action=partial-content]').count(),0,'A still-running final does not claim missing completion');
      await page.evaluate(()=>window.emptyHistoryFixture.captured(1));await page.locator('[data-action=working-indicator]').waitFor({state:'detached'});await page.getByText('Turn finished · agent running',{exact:true}).waitFor();await page.getByText('Exact captured final prefix',{exact:true}).waitFor();await page.locator('[data-action=partial-content]').waitFor();
      await page.evaluate(()=>window.emptyHistoryFixture.captured(2));await page.getByText('Exact completed final answer',{exact:true}).waitFor();assert.equal(await page.locator('[data-action=partial-content]').count(),0,'Only exact full native completion heals the missing final');assert.equal(await page.locator('[data-action=working-indicator]').count(),0);
      await page.evaluate(() => window.emptyHistoryFixture.restore());
      const emptyHistory = { knownEmptyAutomaticReads: 0, unknownPrefixAutomaticReads: 0, explicitRecoveryChecks: await page.evaluate(() => window.emptyHistoryFixture.checks()), unknownNonemptyTopAction: true, stickyFailureHasNoRepeat: true, lateContextResultIgnored: true, expiredWaitRetainsPending: true, retainedFailureRetry: true, codecFinalCompletion: true };
      if (historyOnly) {
        const disposed = await page.evaluate(() => window.layoutFixture.close()); assert.equal(disposed.streams, 0);
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
        for (const input of sources) assert.equal(sha(await readFile(resolve(root, input.path))), input.sha256, `Changed source: ${input.path}`);
        result = { passed: true, sourceHash: sha(JSON.stringify(sources)), currentChatHash: sha(source), scope: 'shared top history boundary through actual root workspace and chat', emptyHistory, scriptedSubmits: 0, streamsAfterClose: 0, nativeCalls: 0, modelCalls: 0 }; return;
      }
      let settingsOverlay;
      if (variant === 'current') {
        const trigger=page.locator('[data-action=session-controls]'), controls = page.getByRole('dialog',{name:'Agent settings',exact:true}), before = await geometry(), counts = await page.evaluate(() => window.layoutFixture.counts());
        assert.equal(counts.controlReads, 1, 'Committed views automatically share one catalog read');
        steps.push('open-model'); await trigger.click(); steps.push('model-opened'); await controls.getByLabel('Find a model', { exact: true }).fill('specialized'); await settleLayout();
        await page.waitForFunction(() => window.layoutFixture.counts().controlReads === 1);
        await controls.getByText('Loading the Host’s model and reasoning choices…', { exact: true }).waitFor();
        assert.equal(await controls.locator('[data-action=next-model]').isDisabled(), true);
        await trigger.click(); await trigger.click(); await settleLayout();
        assert.equal((await page.evaluate(() => window.layoutFixture.counts())).controlReads, 1, 'Reopening a pending chooser shares the existing catalog job');
        await page.evaluate(() => window.layoutFixture.models(false));
        await controls.getByRole('button', { name: 'Retry model choices', exact: true }).waitFor();
        await controls.getByRole('button', { name: 'Retry model choices', exact: true }).click();
        await page.waitForFunction(() => window.layoutFixture.counts().controlReads === 2);
        await controls.getByText('Loading the Host’s model and reasoning choices…', { exact: true }).waitFor();
        await page.evaluate(() => window.layoutFixture.models(true));
        await page.locator('[data-action=next-effort]:enabled').waitFor();
        const opened = await geometry(); assert.ok(Math.abs(before.composer.y - opened.composer.y) < 0.5);
        assert.equal((await page.evaluate(() => window.layoutFixture.counts())).controlReads, 2, 'A loaded chooser and search do not rediscover models');
        steps.push('loaded-models'); await controls.locator('[data-action=next-model]:enabled').waitFor();
        await controls.locator('[data-action=next-model]').click();
        const offered = controls.getByRole('option').filter({hasText:'Alternate native label'});
        assert.equal(await offered.count(),1); assert.equal(await offered.getAttribute('data-value'),JSON.stringify(['next-model',null]));
        await offered.click();
        await controls.getByRole('listbox').waitFor({state:'detached'});
        assert.match(await trigger.getAttribute('title'), /Current native label/);
        await controls.locator('[data-action=reset-selection]').click(); await settleLayout();
        const loaded = await geometry(), after = await page.evaluate(() => window.layoutFixture.counts());
        assert.ok(Math.abs(before.composer.y - loaded.composer.y) < 0.5); assert.equal(after.controlReads, counts.controlReads + 1); assert.equal(after.submitted, 0);
        settingsOverlay = { before: before.composer, opened: opened.composer, loaded: loaded.composer, automaticModelReads: counts.controlReads, explicitRetryReads: after.controlReads - counts.controlReads, submits: after.submitted };
        steps.push('close-model'); await trigger.click(); await settleLayout();
      }
      steps.push('quiet-draft-persistence');
      await page.evaluate(() => { window.retainedLayoutMessage = document.querySelector('[data-action=message]'); window.composerFixture.hold(); });
      const draftBefore = await geometry();
      await page.locator('[data-action=message]').fill('A durable draft without save chatter');
      await page.waitForFunction(() => window.composerFixture.state() === 'saving'); await settleLayout();
      const saving = await composerGeometry(); assertComposer(saving);
      await page.evaluate(() => window.composerFixture.release()); await page.waitForFunction(() => window.composerFixture.state() === 'saved'); await settleLayout();
      const saved = await composerGeometry(); assertComposer(saved);
      assert.ok(Math.abs(draftBefore.composer.y - saved.boxes.composer.y) < 0.5);
      await page.evaluate(() => window.composerFixture.fail());
      await page.locator('[data-action=message]').fill('Retain this text through a storage failure');
      await page.waitForFunction(() => window.composerFixture.state() === 'unavailable');
      await page.getByText('Draft storage unavailable · messages paused. Your text remains here.', { exact: true }).waitFor();
      assert.equal(await page.locator('.mpx-chat__composer button[type=submit]').isDisabled(), true);
      await page.locator('[data-action=message]').fill('A repaired durable draft'); await page.waitForFunction(() => window.composerFixture.state() === 'saved');
      const responsive = [];
      for (const [width, height] of [[1280, 900], [780, 900], [680, 900], [679, 900], [520, 800], [390, 844], [320, 700], [844, 390]]) {
        await page.setViewportSize({ width, height }); await settleLayout();
        const empty = await composerGeometry(); assertComposer(empty);
        await page.evaluate(() => window.composerFixture.attach());
        await page.getByLabel('Message attachments', { exact: true }).waitFor(); await settleLayout();
        const attached = await composerGeometry(); assertComposer(attached);
        assert.ok(attached.boxes.message.bottom <= attached.boxes.actions.y);
        await page.locator('[data-action=session-controls]').click();
        const responsivePanel=page.getByRole('dialog',{name:'Agent settings',exact:true}); await responsivePanel.waitFor();
        if(width<680){await responsivePanel.locator('[data-action=next-mode]').waitFor();await responsivePanel.locator('[data-action=next-effort]').waitFor();}
        if(width===390||width===320){
          await responsivePanel.getByText('Advanced settings',{exact:true}).click();
          const facts=await responsivePanel.evaluate(panel=>({primary:panel.querySelectorAll('.mpx-ui-button--primary').length,gaps:[...panel.querySelectorAll('.mpx-chat__panel-actions')].map(row=>parseFloat(getComputedStyle(row).gap)),turnActions:panel.querySelectorAll('[data-action=update-turn],[data-action=interrupt-turn]').length}));
          assert.ok(facts.primary<=1,JSON.stringify(facts));assert.ok(facts.gaps.every(gap=>gap>=8));assert.equal(facts.turnActions,0);
          await page.screenshot({path:resolve(receipt,`advanced-${width}x${height}.png`)});
        }
        await page.keyboard.press('Escape'); await responsivePanel.waitFor({state:'detached'});
        await page.waitForFunction(()=>document.activeElement===document.querySelector('[data-action=session-controls]'));
        assert.equal(await page.locator('[data-action=session-controls]').evaluate(e=>document.activeElement===e),true,'Settings Escape restores trigger focus');
        if(width===1280){
          const advancedTrigger=page.getByRole('button',{name:'Advanced agent settings',exact:true});await advancedTrigger.click();
          const panel=page.getByRole('dialog',{name:'Advanced agent settings',exact:true});await panel.waitFor();
          const facts=await panel.evaluate(panel=>({primary:panel.querySelectorAll('.mpx-ui-button--primary').length,gaps:[...panel.querySelectorAll('.mpx-chat__panel-actions')].map(row=>parseFloat(getComputedStyle(row).gap)),turnActions:panel.querySelectorAll('[data-action=update-turn],[data-action=interrupt-turn]').length}));
          assert.ok(facts.primary<=1,JSON.stringify(facts));assert.ok(facts.gaps.every(gap=>gap>=8));assert.equal(facts.turnActions,0);
          await panel.getByRole('combobox',{name:'Next Send permissions',exact:true}).click();await panel.getByRole('listbox').waitFor();
          await page.screenshot({path:resolve(receipt,`advanced-${width}x${height}-select.png`)});await page.keyboard.press('Escape');await panel.getByRole('listbox').waitFor({state:'detached'});await panel.waitFor();
          await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
        }
        await page.getByRole('button', { name: 'Detach inline-layout.txt', exact: true }).click();
        await page.getByLabel('Message attachments', { exact: true }).waitFor({ state: 'detached' });
        responsive.push({ width, height, empty, attached });
      }
      const autosize=[];
      for(const [width,height] of [[1280,900],[390,844],[844,390]]){
        await page.setViewportSize({width,height}); await settleLayout();
        const input=page.locator('[data-action=message]');
        const measure=()=>input.evaluate(e=>({height:e.getBoundingClientRect().height,scroll:e.scrollHeight,overflow:getComputedStyle(e).overflowY,identity:e===window.retainedLayoutMessage}));
        await input.fill('Short'); await settleLayout(); const short=await measure(); assert.equal(short.height,44);
        // A genuine paste event takes the same controlled-value/autosize path.
        await input.focus(); await input.press('Control+A');
        await page.evaluate(()=>{const input=document.querySelector('[data-action=message]'),text=Array.from({length:40},(_,i)=>'Pasted line '+i).join('\n');const transfer=new DataTransfer();transfer.setData('text/plain',text);const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});if(input.dispatchEvent(event))document.execCommand('insertText',false,text);});
        await settleLayout(); const pasted=await measure(); assert.ok(pasted.height>44); assert.ok(Math.abs(pasted.height-Math.max(44,Math.min(240,height*.3)))<1);assert.equal(pasted.overflow,'auto');
        await input.fill('Short again');await settleLayout();const shrunk=await measure();assert.equal(shrunk.height,44);
        await page.evaluate(()=>window.composerFixture.restore('Restored multiline draft\n'+('one line\n'.repeat(20))));await settleLayout();const restored=await measure();assert.ok(restored.height>44);assert.equal(restored.identity,true);
        await page.setViewportSize({width,height:Math.max(140,height-180)});await settleLayout();const resized=await measure();assert.ok(resized.height<=Math.max(44,Math.min(240,(height-180)*.3))+1);
        await page.setViewportSize({width,height:120});await settleLayout();const floor=await measure();assert.equal(floor.height,44,'Even a short embedding retains the44px input floor');
        await input.fill('Short final');await settleLayout();assert.equal((await measure()).height,44);
        autosize.push({width,height,short,pasted,shrunk,restored,resized,floor});
      }
      await page.setViewportSize({ width: 1280, height: 900 }); await settleLayout();
      const sequence = [{ state: 'empty', ...await geometry() }];
      for (let round = 1; round <= 2; round++) {
        await page.locator('[data-action=message]').fill('A short draft with fixed textarea height'); await settleLayout();
        const before = await geometry();
        await page.locator('[data-action=send]').click();
        await page.waitForFunction(expected => window.layoutFixture.submitted() === expected, round);
        const active = page.locator('[data-action=latest-action]');
        await active.getByRole('button', { name: 'Check original send', exact: true }).waitFor();
        await active.getByText('Sending request', { exact: false }).waitFor(); await settleLayout();
        const pending = await geometry();
        assert.equal(before.composer.height, pending.composer.height, 'Draft clearing does not resize the textarea');
        const history = page.locator('[data-action=history]'); await history.hover(); await page.mouse.wheel(0, -500); await page.getByRole('button', { name: 'Jump to latest', exact: true }).waitFor(); await settleLayout();
        const reading = await geometry();
        await page.evaluate(() => window.layoutFixture.release());
        await active.waitFor({ state: 'detached' }); await page.waitForFunction(()=>window.layoutFixture.operations().every(value=>value.state==='acknowledged')); await settleLayout();
        const settled = await geometry();
        assert.equal(reading.anchor.id, settled.anchor.id); assert.ok(Math.abs(reading.anchor.offset - settled.anchor.offset) < 0.5, 'Earlier-reading anchor survives receipt layout changes');
        sequence.push({ state: `pending-${round}`, ...pending, readingAnchorBeforeReceipt: reading.anchor }, { state: `ack-${round}`, ...settled });
      }
      await openTools();
      const other = page.locator('[data-action=action-history]'); await other.locator(':scope > summary').click(); await settleLayout();
      await other.locator('[data-original]').first().waitFor({ state: 'visible' });
      const expanded = await geometry(); await page.getByRole('button', { name: 'Close session tools', exact: true }).click(); sequence.push({ state: 'details-expanded', ...expanded });
      const ys = sequence.map(value => value.composer.y), shift = Math.max(...ys) - Math.min(...ys);
      const pendingShift = Math.abs(sequence[3].composer.y - sequence[4].composer.y);
      const variantFacts = { variant, sequence, composerShift: shift, pendingAckShift: pendingShift, emptyHistory, autosize, draftPersistence: { saving, saved, failureVisible: true, failurePausesSend: true }, responsive, ...(settingsOverlay ? { settingsOverlay } : {}) }; variants.push(variantFacts);
      { assert.ok(shift < 0.5, 'Composer stays fixed from empty through first/additional originals, receipt settlement and explicit details'); assert.equal(sequence[0].operations, null, 'The fix reserves no empty status footer'); }
      await page.evaluate(()=>window.layoutFixture.working());
      const message=page.locator('[data-action=message]');
      await message.fill('/plan Follow up on this running turn');
      await page.locator('[data-action=steer]:enabled').waitFor(); await message.press('Enter');
      await page.waitForFunction(()=>window.layoutFixture.submitted()===3);
      assert.equal((await page.evaluate(()=>window.layoutFixture.commands().at(-1))).type,'codex.steer');
      await page.evaluate(()=>window.layoutFixture.release()); await page.waitForFunction(()=>window.layoutFixture.operations().every(value=>value.state==='acknowledged'));
      await message.fill('/status Keep this literal queue text');
      await page.getByLabel('More message actions',{exact:true}).click(); await page.locator('[data-action=queue]').click();
      await page.waitForFunction(()=>window.layoutFixture.submitted()===4);
      const queued=await page.evaluate(()=>window.layoutFixture.commands().at(-1)); assert.equal(queued.type,'codex.queue.add'); assert.equal(queued.text,'/status Keep this literal queue text');
      await page.evaluate(()=>window.layoutFixture.release()); await page.waitForFunction(()=>window.layoutFixture.operations().every(value=>value.state==='acknowledged'));
      variantFacts.authoring={idle:'send',workingEnter:'codex.steer',explicitQueue:queued.type,originals:4};
      const disposed = await page.evaluate(() => window.layoutFixture.close()); assert.equal(disposed.streams, 0);
      Object.assign(variantFacts, { streamsAfterClose: disposed.streams, scriptedSubmits: disposed.submitted });
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    for (const input of sources) assert.equal(sha(await readFile(resolve(root, input.path))), input.sha256, `Changed source: ${input.path}`);
    result = { passed: true, sourceHash: sha(JSON.stringify(sources)), currentChatHash: sha(source), variants, nativeCalls: 0, modelCalls: 0 };
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bounded composer oracle exceeded 45 seconds')), 45000); })]);
} catch (error) { process.exitCode = 1; await page?.screenshot({path:resolve(receipt,'failure.png'),fullPage:true}).catch(()=>{}); const geometry=await page?.evaluate(()=>{const element=document.querySelector('[data-action=session-controls]');const box=element?.getBoundingClientRect();return{box:box?.toJSON(),text:element?.textContent,bodyHeight:document.body.scrollHeight};}).catch(()=>null); result = { passed: false, variants, errors, steps, geometry, error: String(error.stack??error) }; }
finally { clearTimeout(timer); await context?.close(); await browser?.close(); cleanup.browser = true; if (server) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); } cleanup.server = true; await writeFile(resolve(receipt, 'result.json'), JSON.stringify({ ...result, cleanup }, null, 2) + '\n'); }
console.log(JSON.stringify({ receipt: relative(root, receipt), ...result, cleanup }));
