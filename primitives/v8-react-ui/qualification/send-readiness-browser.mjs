import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
/** A real DOM event changes existing workspace facts after the enabled render,
 * before React's submit handler. No Fiber access or alternate client owner. */
export async function qualifySendReadiness() {
  const require = createRequire(resolve(root, 'package.json'));
  const bundle = await build({ stdin: { resolveDir: here, sourcefile: 'send-readiness-fixture.ts', loader: 'ts', contents: `
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import {MultiplexChat} from '../src/chat.js';
    import {workspaceFixture} from '../../v8-workspace/qualification/fixture.js';
    const f=workspaceFixture(), view=await f.workspace.open('a'), root=createRoot(document.getElementById('app')!);
    root.render(h(MultiplexChat,{ view}));
    Object.assign(window,{readinessFixture:{
      stale(){const scope=f.bindings.get('a')!.run.scope; f.observation({scope,kind:'session',state:'connecting'}); f.observation({scope,kind:'session',state:'live'});},
      refresh(){f.native.publish(f.bindings.get('a')!.run.scope,{});},
      snapshot:()=>view.getSnapshot(), submitted:()=>f.native.submitted.length,
      close(){root.unmount();f.workspace.close();}
    }});
  ` }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2023',
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
    alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client') } });
  const server = createServer((request, response) => {
    if (request.url === '/') response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><head><title>Send readiness</title></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>');
    else if (request.url === '/fixture.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else response.writeHead(404).end();
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MULTIPLEX_CHROMIUM ?? '/run/current-system/sw/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.name));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const chat = page.locator('.multiplex-chat'), message = chat.locator('[data-action=message]'), send = chat.locator('[data-action=send]');
    await message.fill('Retained intent across a stale click'); await send.waitFor(); assert.equal(await send.isEnabled(), true);
    await page.evaluate(() => document.querySelector('form').addEventListener('submit', () => window.readinessFixture.stale(), { once: true, capture: true }));
    await send.click(); await page.waitForFunction(() => window.readinessFixture.snapshot().sendReady === false);
    assert.equal(await chat.locator('[role=alert]').count(), 0, 'a fresh click check must not attempt a fenced preparation'); assert.equal(await send.isDisabled(), true);
    assert.equal(await message.inputValue(), 'Retained intent across a stale click');
    assert.equal(await page.evaluate(() => window.readinessFixture.submitted()), 0);
    await page.evaluate(() => window.readinessFixture.refresh()); await page.waitForFunction(() => !document.querySelector('[data-action=send]').disabled);
    await send.click(); await page.waitForFunction(() => window.readinessFixture.submitted() === 1);
    assert.deepEqual(errors, []); await page.evaluate(() => window.readinessFixture.close());
    const result = { status: 'pass', cases: ['stale facts between enabled commit and submit preserve draft without preparing an action', 'fresh exact snapshot restores Send and one explicit click submits once'], nativeModelCalls: 0 };
    await mkdir(resolve(root, '.cache'), { recursive: true }); const directory = await mkdtemp(resolve(root, '.cache/send-readiness-browser-'));
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n'); return { ...result, directory };
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await qualifySendReadiness()));
