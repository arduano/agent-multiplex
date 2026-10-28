import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { buildChatStyles } from '../build/styles.mjs';
import { chromium } from 'playwright-core';
import { AxeBuilder } from '@axe-core/playwright';
import { buildPdfAssets } from '../build/pdf-assets.mjs';
import { qualifyDocumentPreviews } from './preview-cases.mjs';
import { qualifyChildHistories } from './child-cases.mjs';
import { qualifyTranscriptScrolling } from './transcript-cases.mjs';
import { qualifyInlineVisuals } from './visual-cases.mjs';
import { qualifyOptionalQuestions } from './optional-question-cases.mjs';
import { qualifyNativeErrors } from './native-error-cases.mjs';
import { qualifyCodexQuestions } from './question-cases.mjs';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
export async function runBrowserQualification({ previewOnly = false, childOnly = false, firstClickOnly = false, promptOnly = false, codexQuestionsOnly = false, scrollOnly = false, visualOnly = false, optionalQuestionsOnly = false, nativeErrorsOnly = false, transcriptSource, outputDirectory = resolve(here, '../artifacts/browser') } = {}) {
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const require = createRequire(resolve(root, 'package.json'));
  const bundle = await build({ entryPoints: [resolve(here, 'browser-entry.ts')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2023', define: { 'process.env.NODE_ENV': '"development"' }, alias: { react: dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client'), 'react-dom/server': require.resolve('react-dom/server.browser') }, ...(transcriptSource===undefined?{}:{plugins:[{name:'retained-transcript-counterexample',setup(api){api.onLoad({filter:/[/\\]src[/\\]transcript\.ts$/},()=>({contents:transcriptSource,loader:'ts',resolveDir:resolve(here,'../src')}));}}]}), metafile: true, logLevel: 'silent' });
  for (const path of Object.keys(bundle.metafile.inputs)) assert.equal(/\/src\/(?:host|node|authority|gateway|http)\//.test(path) || path.includes('storage-sqlite'), false, `Node domain owner in browser: ${path}`);
  const staticDir = resolve(out, 'static'),styles=await buildChatStyles({ outdir: staticDir });
  await buildPdfAssets({ outdir: staticDir });
  const css = await readFile(resolve(staticDir, 'chat.css'), 'utf8');
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const inputPaths=[...new Set([...Object.keys(bundle.metafile.inputs),...Object.keys(styles.metafile.inputs),'package.json','package-lock.json'].map(path=>resolve(path)).concat([fileURLToPath(import.meta.url),resolve(here,'transcript-cases.mjs'),resolve(here,'visual-cases.mjs'),resolve(here,'optional-question-cases.mjs'),resolve(here,'native-error-cases.mjs'),resolve(here,'question-cases.mjs')]))].sort();
  const sourceInputs=await Promise.all(inputPaths.map(async path=>({path,sha256:sha(transcriptSource!==undefined&&path===resolve(here,'../src/transcript.ts')?transcriptSource:await readFile(path)),...(transcriptSource!==undefined&&path===resolve(here,'../src/transcript.ts')?{override:true}:{})})));
  await writeFile(resolve(out,'sources.json'),JSON.stringify(sourceInputs,null,2)+'\n');
  await build({ entryPoints: [resolve(here, '../src/renderers/mermaid-frame.ts')], bundle: true, outfile: resolve(staticDir, 'mermaid-frame.js'), platform: 'browser', format: 'iife', target: 'es2023', minify: true, logLevel: 'warning' });
  const server = createServer((request, response) => {
    if (request.url === '/') response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self' 'nonce-qualification-chat-nonce-123456789'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" }).end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embeddable chat qualification</title><style>html,body,#app{height:100%;margin:0}body{background:#141615}main{height:100%;display:flex;flex-direction:column}nav{height:36px;flex:none}#chat-container{flex:1;min-height:0}#light-embed{height:320px;flex:none} @media(max-width:600px),(max-height:600px){#light-embed{display:none}}</style><link rel="stylesheet" href="/chat.css"></head><body><div id="app"></div><script type="module" data-chat-entry nonce="qualification-chat-nonce-123456789" src="/fixture.js"></script></body></html>');
    else if (request.url === '/fixture.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (request.url === '/chat.css') response.writeHead(200, { 'content-type': 'text/css' }).end(css);
    else if (/^\/renderers\/pdf\/(?:pdf\.worker\.min\.mjs|(?:cmaps|fonts)\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:bcmap|pfb|ttf))$/.test(request.url ?? '') && !request.url.includes('..')) void readFile(resolve(staticDir, request.url.slice(1))).then(bytes => response.writeHead(200, { 'content-type': request.url.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' }).end(bytes), () => response.writeHead(404).end());
    else if (request.url === '/renderers/mermaid-frame.js') void readFile(resolve(staticDir, 'mermaid-frame.js')).then(bytes => response.writeHead(200, { 'content-type': 'text/javascript' }).end(bytes));
    else if (/^\/fonts\/[a-zA-Z0-9_-]+\.(?:woff2?|ttf)$/.test(request.url ?? '')) void readFile(resolve(staticDir, request.url.slice(1))).then(bytes => response.writeHead(200, { 'content-type': request.url.endsWith('.woff2') ? 'font/woff2' : request.url.endsWith('.woff') ? 'font/woff' : 'font/ttf' }).end(bytes));
    else response.writeHead(404).end();
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const origin = `http://127.0.0.1:${server.address().port}`, errors = [], cases = [], externalRequests = [], browserDiagnostics = [], viewportFacts = []; let browser, timer;
  try { return await Promise.race([(async () => {
    browser = await chromium.launch({ executablePath: process.env.MULTIPLEX_CHROMIUM ?? '/run/current-system/sw/bin/chromium', headless: true, timeout: 15000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', route => { if (route.request().url().startsWith(origin + '/') || route.request().url().startsWith('blob:')) return route.continue(); externalRequests.push(route.request().resourceType()); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.length < 30 && errors.push(error.message)); page.on('console', message => { if (['error','warning'].includes(message.type())) browserDiagnostics.length < 30 && browserDiagnostics.push(message.text()); });
    await page.goto(origin); await page.waitForFunction(() => window.chatFixture?.ready && window.chatFixture.refs().a === 2);
    const ssr = await page.evaluate(() => window.chatFixture.ssr); assert.equal(ssr.htmlHasComposer, true); assert.deepEqual(ssr.before, ssr.after); assert.equal(ssr.references, 0);
    if (codexQuestionsOnly) {
      let failure;
      try { await qualifyCodexQuestions(page, page.locator('#chat-container .multiplex-chat'), cases, out); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); }
      catch (error) { failure = String(error.stack ?? error); await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {}); }
      await page.evaluate(() => window.chatFixture.close()); const streams = await page.evaluate(() => window.chatFixture.counts().streams); await context.close();
      for (const input of sourceInputs) if (!input.override && sha(await readFile(input.path)) !== input.sha256) failure = 'Source changed during Codex-question qualification: ' + input.path;
      const result = { passed: failure === undefined, cases, ...(failure ? { error: failure } : {}), sourceHash: sha(JSON.stringify(sourceInputs)), errors, externalRequests, nativeModelCalls: 0, cleanup: { context: true, workspaceStreams: streams } };
      await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); if (failure) throw Error(failure); return result;
    }
    if (nativeErrorsOnly) {
      let failure;
      try { await qualifyNativeErrors(page, page.locator('#chat-container .multiplex-chat'), cases, out); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); }
      catch (error) { failure = String(error.stack ?? error); await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {}); }
      await page.evaluate(() => window.chatFixture.close()); const streams = await page.evaluate(() => window.chatFixture.counts().streams); await context.close();
      for (const input of sourceInputs) if (!input.override && sha(await readFile(input.path)) !== input.sha256) failure = 'Source changed during native-error qualification: ' + input.path;
      const result = { passed: failure === undefined, cases, ...(failure ? { error: failure } : {}), sourceHash: sha(JSON.stringify(sourceInputs)), errors, externalRequests, nativeModelCalls: 0, cleanup: { context: true, workspaceStreams: streams } };
      await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); if (failure) throw Error(failure); return result;
    }
    if (optionalQuestionsOnly) {
      let failure;
      try { await qualifyOptionalQuestions(page, page.locator('#chat-container .multiplex-chat'), cases, out); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); }
      catch (error) { failure = String(error.stack ?? error); await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {}); }
      await page.evaluate(() => window.chatFixture.close()); const streams = await page.evaluate(() => window.chatFixture.counts().streams); await context.close();
      for (const input of sourceInputs) if (!input.override && sha(await readFile(input.path)) !== input.sha256) failure = 'Source changed during optional-question qualification: ' + input.path;
      const result = { passed: failure === undefined, cases, ...(failure ? { error: failure } : {}), sourceHash: sha(JSON.stringify(sourceInputs)), errors, externalRequests, nativeModelCalls: 0, cleanup: { context: true, workspaceStreams: streams } };
      await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); if (failure) throw Error(failure); return result;
    }
    if (visualOnly) {
      let failure;
      try { await qualifyInlineVisuals(page, page.locator('#chat-container .multiplex-chat'), cases, out, { archive: true }); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); } catch (error) { failure = String(error.stack ?? error); }
      await page.evaluate(() => window.chatFixture.close()); await context.close();
      for (const input of sourceInputs) if (!input.override && sha(await readFile(input.path)) !== input.sha256) failure = 'Source changed during visual qualification: ' + input.path;
      const result = { passed: failure === undefined, cases, ...(failure ? { error: failure } : {}), sourceHash: sha(JSON.stringify(sourceInputs)), errors, externalRequests, nativeModelCalls: 0, cleanup: { context: true } };
      await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); if (failure) throw Error(failure); return result;
    }
    if(scrollOnly){
      let observation,failure;
      try{observation=await qualifyTranscriptScrolling(page,page.locator('#chat-container .multiplex-chat'),cases,out);assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);}catch(error){failure=String(error.stack??error);}
      await page.evaluate(()=>window.chatFixture.close());const streams=await page.evaluate(()=>window.chatFixture.counts().streams);await context.close();
      for(const input of sourceInputs)if(!input.override&&sha(await readFile(input.path))!==input.sha256)failure='Source changed during transcript qualification: '+input.path;
      const result={passed:failure===undefined,cases,...(observation?{observation}:{}),...(failure?{error:failure}:{}),errors,externalRequests,nativeModelCalls:0,sourceHash:sha(JSON.stringify(sourceInputs)),cleanup:{context:true,workspaceStreams:streams}};
      await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');if(failure)throw Error(failure);return result;
    }
    if (promptOnly) {
      await qualifyInteractionRequests(page, page.locator('#chat-container .multiplex-chat'), cases, out);
      assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
      await page.screenshot({ path: resolve(out, 'requests.png') }); await page.evaluate(() => window.chatFixture.close()); await context.close();
      const result = { passed: true, cases, chromium: browser.version(), nativeModelCalls: 0, externalRequests, errors };
      await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
    }
    assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(element => element.id); return new Set(ids).size === ids.length; }), true);
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.querySelector('#chat-container .multiplex-chat')).backgroundColor, getComputedStyle(document.querySelector('#light-embed .multiplex-chat')).backgroundColor]), ['rgb(20, 22, 21)', 'rgb(247, 248, 245)']);
    cases.push('SSR inert; StrictMode retains exact commit leases; simultaneous independently themed embeds have unique control IDs');
    const chat = page.locator('#chat-container .multiplex-chat'), message = chat.locator('[data-action=message]');
    if (firstClickOnly) {
      const before = await page.locator('#session-a').evaluate(element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return { box: box.toJSON(), visibility: style.visibility, display: style.display, hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element }; });
      await page.locator('#session-a').click();
      assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
      await page.screenshot({ path: resolve(out, 'first-click.png') });
      await page.evaluate(() => window.chatFixture.close()); await context.close();
      const result = { passed: true, cases: ['Exact initial session-A click with unchanged 7000ms timeout'], before, chromium: browser.version(), nativeModelCalls: 0 };
      await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
    }
    if (!previewOnly) await qualifyChildHistories(page, chat, cases, out);
    if (childOnly) {
      assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); await page.evaluate(() => window.chatFixture.close()); await context.close();
      const result = { passed: true, cases, chromium: browser.version(), nativeModelCalls: 0, sourceScope: 'focused child history: scripted proved-scope port + real retained HistoryWorkspace/React' }; await writeFile(resolve(out, 'child-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
    }
    await qualifyDocumentPreviews(page, chat, cases, out);
    if (previewOnly) {
      assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); await page.evaluate(() => window.chatFixture.close()); await context.close();
      const result = { passed: true, cases, chromium: browser.version(), nativeModelCalls: 0, sourceScope: 'focused document preview: scripted FilePort + real ResourceCache/React/PDF worker' }; await writeFile(resolve(out, 'preview-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
    }
    await message.fill('Retained draft after switching'); await page.evaluate(() => window.chatFixture.pin(true));
    await page.locator('#session-b').click(); await page.waitForFunction(() => window.chatFixture.refs().b === 1); await page.locator('#session-a').click();
    assert.equal(await message.inputValue(), 'Retained draft after switching');
    await page.evaluate(() => window.chatFixture.unmount()); assert.deepEqual(await page.evaluate(() => window.chatFixture.refs()), { a: 0, b: 0 }); assert.equal(await page.evaluate(() => window.chatFixture.counts().streams), 1);
    await page.evaluate(() => window.chatFixture.remount()); await page.waitForFunction(() => window.chatFixture.refs().a === 2); assert.equal(await message.inputValue(), 'Retained draft after switching');
    cases.push('Switching, real unmount and pinning preserve shared draft/history and background observation without duplicate stores');
    await qualifyInlineVisuals(page, chat, cases, out);
    const olderBeforeScroll = await page.evaluate(() => window.chatFixture.counts().older);
    await page.evaluate(() => window.chatFixture.history()); await page.waitForFunction(() => document.querySelectorAll('#chat-container [data-row^=long-]').length === 60);
    await chat.locator('[data-action=history]').evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true })); element.dispatchEvent(new Event('scroll')); });
    await chat.getByRole('button', { name: 'Jump to latest' }).waitFor(); assert.equal(await page.evaluate(() => window.chatFixture.counts().older), olderBeforeScroll);
    await chat.getByRole('button', { name: 'Load earlier history' }).click(); await page.waitForFunction(before => window.chatFixture.counts().older === before + 1, olderBeforeScroll);
    cases.push('Retained viewport changes do not read history; earlier history requires one explicit action');
    await qualifyTranscriptScrolling(page,chat,cases,out);await page.setViewportSize({width:1440,height:900});
    await qualifyInteractionRequests(page, chat, cases, out);
    await page.locator('#session-a').click();
    await page.evaluate(() => window.chatFixture.rich()); await chat.locator('[data-row=rich] .katex-display').waitFor();
    await chat.locator('[data-row=rich] [data-testid=mermaid-block]').first().waitFor();
    await chat.locator('[data-row=rich] [data-testid=mermaid-block]').first().scrollIntoViewIfNeeded();
    await chat.locator('[data-row=rich] [data-testid=mermaid-block][data-state=ready]').first().waitFor({ timeout: 25000 }).catch(async error => { const debug = await chat.locator('[data-row=rich]').innerText(); await writeFile(resolve(out,'failed-diagram.json'), JSON.stringify({error:String(error),debug,errors,browserDiagnostics},null,2)); throw error; });
    const diagram = await chat.locator('[data-row=rich] [data-testid=mermaid-block] img').first().evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, blob: image.src.startsWith('blob:') })); assert.ok(diagram.width > 0 && diagram.height > 0 && diagram.blob); assert.deepEqual(externalRequests, []);
    cases.push('Scoped KaTeX and sandboxed Mermaid render under a strict parent script CSP using an explicit trusted nonce, with no remote image requests');
    await page.evaluate(() => window.chatFixture.activity());
    const tool = chat.locator('[data-row=captured-running-tool]');
    assert.equal(await tool.locator('details').evaluate(element => element.open), false);
    await tool.locator('summary').click();
    assert.equal(await tool.locator('details').evaluate(element => element.open), true);
    assert.equal(await tool.locator('pre').evaluate(element => element.scrollHeight > element.clientHeight), true);
    const output = tool.getByRole('region', { name: 'Tool output', exact: true });
    await output.focus(); assert.equal(await output.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('[data-row=captured-running-tool] pre')?.scrollTop > 0);
    await tool.locator('summary').click(); assert.equal(await tool.locator('details').evaluate(element => element.open), false);
    assert.equal(await tool.getAttribute('data-lifecycle'), 'running');
    cases.push('Captured running activity starts compact, expands and collapses, and retains exact bounded terminal output with labelled keyboard scrolling without inventing completion');
    const viewports = [[1720,1180],[1440,900],[1024,768],[768,1024],[390,844],[844,390],[390,360]];
    for (const [width,height] of viewports) { await page.setViewportSize({ width,height });
      await page.waitForFunction(() => { const chat = document.querySelector('#chat-container .multiplex-chat'); return chat?.querySelector('.mpx-chat__inline-settings')?.getAttribute('data-layout') === (chat.getBoundingClientRect().width < 680 ? 'compact' : 'direct'); });
      const geometry = await chat.evaluate(element => {
        const box = element.getBoundingClientRect(), heading = element.querySelector('.mpx-chat__heading').getBoundingClientRect(), composer = element.querySelector('.mpx-chat__composer').getBoundingClientRect(), history = element.querySelector('.mpx-chat__transcript').getBoundingClientRect();
        const direct = box.width >= 680;
        const selectors = ['[data-action=message]', 'button[data-action=send],button[data-action=steer]', '[data-action=stop]', 'button[data-action=session-controls]', 'button[aria-label="Add files or photo"]', 'button[aria-label="More message actions"]', ...(direct ? ['.mpx-chat__composer-toolbar [data-action=next-mode]', '.mpx-chat__composer-toolbar [data-action=next-effort]'] : [])];
        const controls = selectors.map(selector => {
          const target = element.querySelector(selector); if (!target) return { selector, missing: true };
          const rect = target.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { selector, height: rect.height, inBounds: rect.top >= box.top && rect.bottom <= box.bottom + 1 && rect.left >= box.left && rect.right <= box.right + 1, hit: hit === target || target.contains(hit) };
        });
        return { direct, overflow: element.scrollWidth > element.clientWidth + 1, composer: composer.height, history: history.height, headerVisible: heading.top >= box.top - 1, controls };
      });
      assert.equal(geometry.overflow, false); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1), false); assert.ok(geometry.composer > 50); assert.equal(geometry.headerVisible, true); assert.ok(geometry.history > 20, JSON.stringify({ width,height,...geometry }));
      for (const control of geometry.controls) { assert.equal(control.missing, undefined, JSON.stringify({ width,height,control })); assert.equal(control.inBounds, true, JSON.stringify({ width,height,control })); assert.equal(control.hit, true, JSON.stringify({ width,height,control })); if (control.selector !== '[data-action=message]') assert.ok(control.height >= 44); }
      if (!geometry.direct) {
        assert.equal(await chat.locator('.mpx-chat__composer-toolbar [data-action=next-mode],.mpx-chat__composer-toolbar [data-action=next-effort]').count(), 0);
        await chat.getByRole('button', { name: 'Agent settings', exact: true }).click();
        const settings = chat.getByRole('dialog', { name: 'Agent settings', exact: true });
        await settings.locator('[data-action=next-mode]').waitFor(); await settings.locator('[data-action=next-effort]').waitFor();
        await page.keyboard.press('Escape'); await settings.waitFor({ state: 'detached' });
      }
      await page.screenshot({ path: resolve(out, `${width}x${height}.png`), fullPage: true });
      viewportFacts.push({ width, height, ...geometry });
    }
    cases.push('Seven desktop/tablet/phone/landscape viewports retain hittable composer, primary, Stop, model/settings, Add and More controls with 44px actions; mode/reasoning stay direct at680px chat width and explicitly disclosed below it');
    await qualifyNativeErrors(page, chat, cases, out);
    await qualifyOptionalQuestions(page, chat, cases, out);
    const accessibility = await new AxeBuilder({ page }).include('.multiplex-chat').analyze();
    const serious = accessibility.violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
    await writeFile(resolve(out, 'accessibility.json'), JSON.stringify({ violations: serious }, null, 2) + '\n');
    assert.deepEqual(serious.map(item => ({id:item.id,impact:item.impact})), []); cases.push('Actual rendered chats have no serious or critical axe accessibility violations');
    await page.evaluate(() => window.chatFixture.close()); await page.waitForFunction(() => document.querySelector('#chat-container .multiplex-chat')?.textContent === 'Workspace closed'); assert.equal(await page.evaluate(() => window.chatFixture.counts().streams), 0); assert.deepEqual(errors, []);
    cases.push('Auth disposal redacts mounted chat and releases observations; no browser errors');
    await context.close(); const result = { passed: true, cases, viewportFacts, chromium: browser.version(), nativeModelCalls: 0, sourceScope: 'scripted retained workspace + public React presentation' }; await writeFile(resolve(out, 'result.json'), JSON.stringify(result,null,2)+'\n'); return result;
  })(),new Promise((_,reject) => { timer = setTimeout(() => reject(Error('Chat browser qualification exceeded 75 seconds')),75000); })]); }
  finally { clearTimeout(timer); await browser?.close(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runBrowserQualification({ previewOnly: process.argv.includes('--preview-only'), childOnly: process.argv.includes('--child-only'), promptOnly: process.argv.includes('--prompt-only'), codexQuestionsOnly: process.argv.includes('--codex-questions-only'), scrollOnly: process.argv.includes('--scroll-only'), visualOnly: process.argv.includes('--visual-only'), optionalQuestionsOnly: process.argv.includes('--optional-questions-only'), nativeErrorsOnly: process.argv.includes('--native-errors-only') }).then(value => process.stdout.write(JSON.stringify(value)+'\n')).catch(error => { process.stderr.write(error.stack+'\n'); process.exitCode=1; });


async function qualifyInteractionRequests(page, chat, cases, out) {
  await page.locator('#session-b').click();
  const before = await page.evaluate(() => window.chatFixture.counts().submitted);
  const [first, second, third] = await page.evaluate(() => [window.chatFixture.prompt(), window.chatFixture.prompt('An independent question?', true, ['Choice A', 'Choice B']), window.chatFixture.prompt('A third independent choice?', false, ['Blue', 'Green'])]);
  const request = id => chat.locator(`[data-interaction="${id}"]`);
  const expand = async id => { const heading = request(id).locator('[data-action=confirmation]'); if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click(); };
  const choose = async (trigger, label) => { await trigger.click(); await chat.getByRole('option', { name: label, exact: true }).click(); };
  await expand(first); assert.equal(await chat.getByRole('dialog').count(), 0);
  await request(first).getByRole('button', { name: 'Send answer', exact: true }).click();
  await request(first).getByText('Enter your response.', { exact: true }).waitFor();
  assert.equal(await request(first).getByLabel('Your answer').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), before);
  await request(first).getByLabel('Your answer').fill('PRIVATE_CHAT_RESPONSE');
  await expand(second); await request(second).getByRole('radio', { name: 'Choice A', exact: true }).waitFor(); assert.equal(await request(second).getByRole('radio').count(), 3); await request(second).getByRole('radio', { name: 'Other', exact: true }).check(); await request(second).getByLabel('Your answer').fill('SECOND_PRIVATE_RESPONSE');
  await request(second).getByRole('button', { name: 'Later', exact: true }).click();
  assert.equal(await chat.locator('[data-action=confirmation]').count(), 3);
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), before);
  await page.locator('#session-a').click(); await page.locator('#session-b').click();
  await expand(first); assert.equal(await request(first).getByLabel('Your answer').inputValue(), 'PRIVATE_CHAT_RESPONSE');
  await page.screenshot({ path: resolve(out, 'inline-questions.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(out, 'mobile-question.png') });
  assert.equal(await chat.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await request(first).getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.waitForFunction(() => window.chatFixture.privateAnswer() === 'PRIVATE_CHAT_RESPONSE');
  assert.equal(await request(first).count(), 0);
  await expand(second); assert.equal(await request(second).getByLabel('Your answer').inputValue(), 'SECOND_PRIVATE_RESPONSE');
  await page.evaluate(() => window.chatFixture.loseResponse());
  await request(second).getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.waitForFunction(id => window.chatFixture.snapshot('b').confirmationResponses.some(response => response.interactionId === id && response.state === 'unknown'), second);
  await expand(second); await request(second).getByText(/response outcome is unknown/i).waitFor();
  const original = await request(second).locator('[data-response-original]').getAttribute('data-response-original'); assert.ok(original);
  assert.equal(await request(second).getByRole('button', { name: 'Send answer', exact: true }).count(), 0);
  await request(second).getByRole('button', { name: 'Check original response', exact: true }).click();
  await request(second).getByText('Response submitted. Native completion has not been confirmed.').waitFor();
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), before + 2);
  await page.evaluate(id => window.chatFixture.completePrompt(id), second); await request(second).waitFor({ state: 'detached' });
  assert.equal(await request(third).locator('[data-action=confirmation]').getAttribute('aria-expanded'), 'true');
  await request(third).getByRole('radio', { name: 'Green', exact: true }).check();
  await request(third).getByRole('button', { name: 'Send answer', exact: true }).click(); await request(third).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.chatFixture.privateAnswer()), 'Green');
  const permission = await page.evaluate(() => window.chatFixture.permission()); await expand(permission);
  assert.equal(await chat.getByRole('dialog').count(), 0);
  await request(permission).getByRole('button', { name: 'Review permission request', exact: true }).click();
  await chat.getByRole('dialog').getByText('explicit-confirmation', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, 'permission-dialog.png') });
  const permissionGeometry = await chat.evaluate(element => {
    const dialog = element.querySelector('[role=dialog]'), surface = element.getBoundingClientRect(), box = dialog.getBoundingClientRect();
    return { surface: surface.toJSON(), dialog: box.toJSON(), insideSurface: box.top >= surface.top && box.bottom <= surface.bottom && box.left >= surface.left && box.right <= surface.right,
      buttons: [...dialog.querySelectorAll('button')].map(button => { const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return { label: button.textContent, rect: rect.toJSON(), hit: hit === button || button.contains(hit) }; }) };
  });
  await writeFile(resolve(out, 'permission-geometry.json'), JSON.stringify(permissionGeometry, null, 2) + '\n');
  assert.equal(permissionGeometry.insideSurface, true, 'Scoped permission dialog must remain within its actual chat surface');
  await chat.getByRole('button', { name: 'Later', exact: true }).click();
  await request(permission).getByRole('button', { name: 'Review permission request', exact: true }).click();
  await chat.getByRole('button', { name: 'Approve once', exact: true }).click(); await request(permission).waitFor({ state: 'detached' });
  const verification = await page.evaluate(() => window.chatFixture.elicitation()); await expand(verification);
  await request(verification).getByRole('button', { name: 'Review verification request', exact: true }).click();
  const form = chat.getByRole('dialog'), count = form.getByRole('spinbutton', { name: 'Count', exact: true });
  await count.fill('4'); const beforeInvalid = await page.evaluate(() => window.chatFixture.counts().submitted);
  await form.getByRole('button', { name: 'Confirm once', exact: true }).click();
  await form.getByText('Enter 3 or less.', { exact: true }).waitFor(); assert.equal(await count.getAttribute('aria-invalid'), 'true');
  assert.equal(await count.evaluate(element => element.getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id)?.textContent).includes('Enter 3 or less.')), true);
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), beforeInvalid);
  await page.screenshot({ path: resolve(out, 'verification-field-error.png') });
  await count.fill('2');
  await form.getByRole('checkbox', { name: 'Include Enabled', exact: true }).check();
  await choose(form.getByRole('combobox', { name: 'Enabled', exact: true }), 'False');
  await form.getByRole('checkbox', { name: 'Include Enabled', exact: true }).uncheck();
  assert.equal(await form.getByRole('combobox', { name: 'Enabled', exact: true }).count(), 0);
  await form.getByRole('checkbox', { name: 'Include Enabled', exact: true }).check();
  assert.equal(await form.getByRole('combobox', { name: 'Enabled', exact: true }).getAttribute('data-value'), '');
  await choose(form.getByRole('combobox', { name: 'Enabled', exact: true }), 'False');
  await form.getByRole('checkbox', { name: 'Include Mode', exact: true }).check();
  await choose(form.getByRole('combobox', { name: 'Mode', exact: true }), 'safe');
  await choose(form.getByRole('combobox', { name: 'Mode', exact: true }), 'Choose a value');
  assert.equal(await form.getByRole('checkbox', { name: 'Include Mode', exact: true }).isChecked(), false, 'Enum placeholder omits optional content rather than choosing native item zero');
  await form.getByRole('checkbox', { name: 'Include Mode', exact: true }).check();
  assert.equal(await form.getByRole('combobox', { name: 'Mode', exact: true }).getAttribute('data-value'), 'option:0', 'Explicit empty enum text remains a real native choice');
  const strategy = form.getByRole('combobox', { name: 'Strategy', exact: true });
  await choose(strategy, 'second'); await choose(strategy, 'Choose a value');
  await form.getByRole('button', { name: 'Confirm once', exact: true }).click();
  await form.getByText('This field is required.', { exact: true }).waitFor();
  assert.equal(await strategy.getAttribute('aria-invalid'), 'true');
  assert.equal(await strategy.evaluate(element => document.getElementById(element.getAttribute('aria-describedby'))?.textContent), 'This field is required.');
  assert.equal(await strategy.evaluate(element => document.activeElement === element), true, 'Validation focuses the actual Select trigger');
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), beforeInvalid);
  await choose(strategy, 'first');
  await form.getByRole('button', { name: 'Later', exact: true }).click();
  await request(verification).getByRole('button', { name: 'Review verification request', exact: true }).click();
  assert.equal(await form.getByRole('combobox', { name: 'Enabled', exact: true }).getAttribute('data-value'), 'false');
  assert.equal(await form.getByRole('combobox', { name: 'Mode', exact: true }).getAttribute('data-value'), 'option:0');
  const promptGeometry = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await form.getByRole('combobox', { name: 'Mode', exact: true }).click();
    assert.equal(await chat.getByRole('listbox').evaluate(element => !!element.closest('[role=dialog]')), true, 'Select portal remains inside its owning request dialog');
    await chat.getByRole('option', { name: 'Empty value', exact: true }).click();
    const confirm = form.getByRole('button', { name: 'Confirm once', exact: true }); await confirm.scrollIntoViewIfNeeded();
    const geometry = await confirm.evaluate(element => { const box = element.getBoundingClientRect(), dialog = element.closest('[role=dialog]'), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return { height: box.height, insideViewport: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth, hit: hit === element || element.contains(hit), overflow: dialog.scrollWidth > dialog.clientWidth + 1 }; });
    assert.ok(geometry.height >= 44); assert.equal(geometry.insideViewport, true); assert.equal(geometry.hit, true); assert.equal(geometry.overflow, false);
    promptGeometry.push({ viewport, ...geometry }); await page.screenshot({ path: resolve(out, `verification-${viewport.width}.png`) });
  }
  await writeFile(resolve(out, 'verification-geometry.json'), JSON.stringify(promptGeometry, null, 2) + '\n');
  await page.setViewportSize({ width: 1440, height: 900 });
  await form.getByRole('button', { name: 'Confirm once', exact: true }).click(); await request(verification).waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.chatFixture.promptAnswers().elicitation), { action: 'accept', content: { count: 2, enabled: false, mode: '', strategy: 'first' } });
  const plan = await page.evaluate(() => window.chatFixture.plan()); await expand(plan);
  await request(plan).getByRole('heading', { name: 'Fixed plan' }).waitFor();
  assert.equal(await chat.getByRole('dialog').count(), 0);
  await page.screenshot({ path: resolve(out, 'inline-plan.png') });
  await request(plan).getByRole('button', { name: 'Keep planning', exact: true }).click(); await request(plan).waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.chatFixture.promptAnswers().plan), { approved: false });
  const approvedPlan = await page.evaluate(() => window.chatFixture.plan()); await expand(approvedPlan);
  await request(approvedPlan).getByRole('button', { name: 'Approve selected action', exact: true }).click();
  const planAction = request(approvedPlan).getByRole('combobox', { name: 'Action after approval', exact: true });
  assert.equal(await planAction.getAttribute('aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), before + 6);
  await choose(planAction, 'Continue interactively (recommended)');
  await request(approvedPlan).getByRole('button', { name: 'Approve selected action', exact: true }).click(); await request(approvedPlan).waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.chatFixture.promptAnswers().plan), { approved: true, selectedAction: 'interactive' });
  await qualifyCodexQuestions(page, chat, cases, out);
  const privacy = await page.evaluate(() => ({ submitted: window.chatFixture.counts().submitted, leak: JSON.stringify([window.chatFixture.snapshot('a'), window.chatFixture.snapshot('b')]).includes('PRIVATE_') }));
  assert.deepEqual(privacy, { submitted: before + 9, leak: false });
  cases.push('Three simultaneous individually selectable inline questions retain private drafts across collapse/navigation; exact unknown response checks its original without replay; permissions and MCP verification stay explicit dialogs; field errors associate with their inputs without dispatch; native choice radios, plan feedback and Codex descriptions preserve native semantics');
  cases.push('Actual scoped Select interactions distinguish false, omitted optional content and explicit empty enum text; clearing a required enum blocks dispatch and focuses its error; exact native form/plan payloads and retained private values survive dialog dismissal; mobile and short landscape dialogs keep 44px primary actions hittable');
}
