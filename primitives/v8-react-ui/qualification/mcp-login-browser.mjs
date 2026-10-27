import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
const modulePath = resolve(here, '../src/mcp-login.ts');
const hash = value => createHash('sha256').update(value).digest('hex');

/** Component-only mounted lifecycle oracle. All actions are scripted; the
 * existing workspace fixture supplies the real immutable snapshot shape. */
export async function qualifyMcpLoginDialog() {
  const source = await readFile(modulePath, 'utf8');
  const oldSource = source.replace(/key = JSON\.stringify\(\[[^\n]*\]\);/, 'key = JSON.stringify([snapshot.sessionId, native?.generation, native?.nativeSession]);');
  assert.notEqual(source, oldSource, 'The comparison must change only the formerly incomplete dialog identity');
  const require = createRequire(resolve(root, 'package.json')), bundles = new Map();
  for (const [variant, contents] of [['current', source], ['old-key', oldSource]]) {
    const bundle = await build({ stdin: { resolveDir: here, sourcefile: 'mcp-login-dialog-fixture.ts', loader: 'ts', contents: `
      import {createElement as h,useEffect,useLayoutEffect,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {McpLogin} from '../src/mcp-login.js';
      import {workspaceFixture} from '../../v8-workspace/qualification/fixture.js';
      const f=workspaceFixture(), view=await f.workspace.open('a'), base=view.getSnapshot();
      if(base.kind!=='codex'||!base.session.native)throw Error('SCRIPTED_SNAPSHOT');
      const authorizationUrl='https://fixture.invalid/authorize?test=private-dialog-only';
      const available={state:'available',status:'initiated',authorizationUrl,expiresInMs:120000};
      const stats={loginCalls:0,lookups:0,otherMutations:0,mounts:0,unmounts:0};
      let holdNext=false,heldResolve,latest,setSnapshot;
      const work=new Set();
      const actions={...base.actions,
        loginMcp(){stats.loginCalls++;return {id:'explicit-login',generation:1,result:Promise.resolve({state:'acknowledged'})};},
        mcpLoginLink(){stats.lookups++;if(holdNext){holdNext=false;return new Promise(resolve=>{heldResolve=resolve;});}return Promise.resolve(available);},
        stop(){stats.otherMutations++;throw Error('UNEXPECTED_STOP');}
      };
      const initial={...base,actions,operations:[{id:'retained-original',generation:base.session.native.generation,type:'codex.mcp.login'}],
        mcp:{...base.mcp,servers:[{name:'fixture-mcp',transport:'http',canAuthenticate:true}]},mcpStale:false};
      function App(){
        const [snapshot,update]=useState(initial);setSnapshot=update;latest=snapshot;
        useEffect(()=>{stats.mounts++;return()=>{stats.unmounts++;};},[]);
        useLayoutEffect(()=>{document.documentElement.dataset.epoch=String(snapshot.session.native.epoch);document.documentElement.dataset.session=snapshot.sessionId;},[snapshot]);
        return h('div',{className:'multiplex-chat'},h(McpLogin,{snapshot,disabled:false,run(fn){const promise=Promise.resolve().then(fn);work.add(promise);void promise.finally(()=>work.delete(promise));}}));
      }
      const reactRoot=createRoot(document.getElementById('app'));reactRoot.render(h(App));
      Object.assign(window,{mcpFixture:{
        hold(){if(heldResolve)throw Error('HELD_LOOKUP_EXISTS');holdNext=true;},
        resolveHeld(){if(!heldResolve)throw Error('NO_HELD_LOOKUP');const resolve=heldResolve;heldResolve=undefined;resolve(available);},
        epoch(){setSnapshot(value=>({...value,session:{...value.session,native:{...value.session.native,epoch:value.session.native.epoch+1}}}));},
        navigate(){setSnapshot(value=>({...value,sessionId:'different-session',session:{...value.session,native:{...value.session.native,scope:{...value.session.native.scope,session:'different-session'}}}}));},
        counts:()=>({...stats,scriptedNativeSubmits:f.native.submitted.length}),
        identity:()=>({session:latest.sessionId,epoch:latest.session.native.epoch,generation:latest.session.native.generation,nativeSession:latest.session.native.nativeSession}),
        privateProjectionClean:()=>!JSON.stringify({snapshot:latest,originals:latest.operations,history:latest.history}).includes(authorizationUrl),
        async settled(){await Promise.all([...work]);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},
        unmount(){reactRoot.unmount();f.workspace.close();}
      }});
    ` }, plugins: [{ name: 'frozen-login-module', setup(api) { api.onLoad({ filter: /[/\\]mcp-login\.ts$/ }, () => ({ contents, loader: 'ts', resolveDir: dirname(modulePath) })); } }],
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2023',
      define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
      alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client') } });
    bundles.set(variant, bundle.outputFiles[0].contents);
  }
  const server = createServer((request, response) => {
    const variant = request.url?.slice(1);
    if (bundles.has(variant)) response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(`<!doctype html><html lang="en"><head><title>MCP login lifecycle</title></head><body><div id="app"></div><script type="module" src="/${variant}.js"></script></body></html>`);
    else if (variant?.endsWith('.js') && bundles.has(variant.slice(0, -3))) response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(bundles.get(variant.slice(0, -3)));
    else response.writeHead(404).end();
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  let browser;
  const variants = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.MULTIPLEX_CHROMIUM ?? '/run/current-system/sw/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const variant of ['old-key', 'current']) {
      const context = await browser.newContext(), page = await context.newPage(), errors = [], externalRequests = [];
      page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.name));
      await page.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); externalRequests.push(route.request().resourceType()); return route.abort(); });
      try {
        await page.goto(`${origin}/${variant}`);
        await page.waitForFunction(() => window.mcpFixture?.counts().mounts === 1);
        const before = await page.evaluate(() => ({ url: location.href, history: JSON.stringify(history.state), length: history.length, local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
        const link = page.getByRole('link', { name: 'Open sign-in page' }), inspect = page.getByRole('button', { name: 'Check sign-in action 1', exact: true });
        await page.getByRole('button', { name: 'Sign in to fixture-mcp', exact: true }).click();
        await link.waitFor(); assert.equal(await page.getByRole('dialog').getByRole('link').count(), 1);
        assert.deepEqual(await page.evaluate(() => window.mcpFixture.counts()), { loginCalls: 1, lookups: 1, otherMutations: 0, mounts: 1, unmounts: 0, scriptedNativeSubmits: 0 });
        assert.equal(await page.evaluate(() => window.mcpFixture.privateProjectionClean()), true);
        const initialIdentity = await page.evaluate(() => window.mcpFixture.identity());
        await page.evaluate(() => window.mcpFixture.epoch());
        await page.waitForFunction(epoch => document.documentElement.dataset.epoch === String(epoch), initialIdentity.epoch + 1);
        const afterIdentity = await page.evaluate(() => window.mcpFixture.identity());
        assert.deepEqual(afterIdentity, { ...initialIdentity, epoch: initialIdentity.epoch + 1 });
        const retainedAfterEpoch = await link.count();
        assert.equal(retainedAfterEpoch, variant === 'old-key' ? 1 : 0, 'The former key retains an old private link; the actual key must discard it');
        if (await page.getByRole('dialog').count()) await page.getByRole('button', { name: 'Close sign-in', exact: true }).click();

        await page.evaluate(() => window.mcpFixture.hold()); await inspect.click();
        await page.getByRole('dialog').waitFor();
        assert.equal(await link.count(), 0);
        await page.evaluate(() => window.mcpFixture.epoch());
        await page.waitForFunction(epoch => document.documentElement.dataset.epoch === String(epoch), initialIdentity.epoch + 2);
        await page.evaluate(async () => { window.mcpFixture.resolveHeld(); await window.mcpFixture.settled(); });
        const lateReplyDisplayed = await link.count();
        assert.equal(lateReplyDisplayed, variant === 'old-key' ? 1 : 0, 'A pending old-epoch reply must not revive the dialog');
        if (await page.getByRole('dialog').count()) await page.getByRole('button', { name: 'Close sign-in', exact: true }).click();

        await inspect.click(); await link.waitFor();
        await page.evaluate(() => window.mcpFixture.navigate());
        await page.waitForFunction(() => document.documentElement.dataset.session === 'different-session');
        assert.equal(await link.count(), 0);
        assert.equal(await page.getByRole('dialog').count(), 0);
        await page.evaluate(() => window.mcpFixture.hold()); await inspect.click();
        await page.getByRole('dialog').waitFor();
        await page.evaluate(async () => { window.mcpFixture.unmount(); window.mcpFixture.resolveHeld(); await window.mcpFixture.settled(); });
        assert.equal(await link.count(), 0); assert.equal(await page.getByRole('dialog').count(), 0);
        const counts = await page.evaluate(() => window.mcpFixture.counts());
        assert.deepEqual(counts, { loginCalls: 1, lookups: 4, otherMutations: 0, mounts: 1, unmounts: 1, scriptedNativeSubmits: 0 }, 'Epoch/navigation/unmount may hide responses but never create, repeat or cancel a native action');
        assert.equal(await page.evaluate(() => window.mcpFixture.privateProjectionClean()), true);
        assert.deepEqual(await page.evaluate(() => ({ url: location.href, history: JSON.stringify(history.state), length: history.length, local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) })), before, 'The temporary link never enters browser storage or navigation history');
        assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
        variants.push({ variant, retainedAfterEpoch: !!retainedAfterEpoch, lateReplyDisplayed: !!lateReplyDisplayed, counts, privateProjectionClean: true, storageAndHistoryUnchanged: true, externalRequests: 0 });
      } finally { await context.close(); }
    }
    const result = { status: 'PASS', sourceHash: hash(source), qualifierHash: hash(await readFile(fileURLToPath(import.meta.url))), variants,
      boundary: 'actual McpLogin React/Radix component in Chromium; scripted action responses; copied old-key module only for counterexample', nativeModelCalls: 0, sharedEmits: 0 };
    const directory = await mkdtemp(resolve(root, '.cache/mcp-login-browser-'));
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    return { ...result, directory };
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await qualifyMcpLoginDialog()));
