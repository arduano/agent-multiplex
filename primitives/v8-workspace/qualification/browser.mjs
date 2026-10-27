import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url)), framework = resolve(here, '../../..');
/** Actual pinned React/ReactDOM, SSR and Chromium. Native facts remain scripted, no models. */
export async function runBrowserQualification() {
  const fromFramework = createRequire(resolve(framework, 'package.json'));
  assert.equal(fromFramework('react/package.json').version, '19.2.8'); assert.equal(fromFramework('react-dom/package.json').version, '19.2.8');
  const bundle = await build({ entryPoints: [resolve(here, 'browser-entry.ts')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2023', define: { 'process.env.NODE_ENV': '"development"' }, alias: { react: fromFramework.resolve('react'), 'react-dom/client': fromFramework.resolve('react-dom/client'), 'react-dom/server': fromFramework.resolve('react-dom/server.browser') }, metafile: true, logLevel: 'silent' });
  for (const path of Object.keys(bundle.metafile.inputs)) if (/\/src\/(?:host|node|authority|gateway|http)\//.test(path) || path.includes('storage-sqlite')) throw new Error('Node domain owner escaped workspace browser graph');
  const server = createServer((request, response) => { if (request.url === '/') response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'); else if (request.url === '/fixture.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].contents); else response.writeHead(404).end(); });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const origin = `http://127.0.0.1:${server.address().port}`, errors = [], cases = []; let browser, timer;
  try {
    return await Promise.race([(async () => {
      browser = await chromium.launch({ executablePath: '/run/current-system/sw/bin/chromium', headless: true, timeout: 15000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } }); await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); await page.waitForFunction(() => window.workspaceReact?.ready); await page.waitForFunction(() => window.workspaceReact.refs().a === 1);
      const ssr = await page.evaluate(() => window.workspaceReact.ssr); assert.equal(ssr.htmlHasCodex, true); assert.deepEqual(ssr.before, ssr.after); assert.equal(ssr.references, 0); assert.deepEqual(await page.evaluate(() => window.workspaceReact.refs()), { a: 1, b: 0 }); cases.push('actual SSR is inert; StrictMode setup/cleanup/setup retains exactly the current committed observation');
      await page.locator('#edit').click(); await page.evaluate(() => window.workspaceReact.pin('a', true)); await page.locator('#b').click(); await page.waitForFunction(() => window.workspaceReact.refs().b === 1); await page.locator('#a').click(); await page.waitForFunction(() => window.workspaceReact.refs().a === 1); assert.match(await page.locator('#draft').textContent(), /retained React draft/); assert.equal(await page.locator('#rows').textContent(), '1');
      await page.evaluate(() => window.workspaceReact.unmount()); assert.deepEqual(await page.evaluate(() => window.workspaceReact.refs()), { a: 0, b: 0 }); assert.equal(await page.evaluate(() => window.workspaceReact.counts().streams), 1); await page.evaluate(() => window.workspaceReact.remount()); await page.waitForFunction(() => window.workspaceReact.refs().a === 1); cases.push('A/B/A and real unmount/remount preserve draft/history; pinned background stream survives with zero mounted hooks');
      await page.locator('#b').click(); await page.evaluate(() => window.workspaceReact.prompt()); await page.locator('#open-prompt').click(); await page.locator('#dismiss').click(); assert.equal(await page.evaluate(() => window.workspaceReact.counts().submitted), 0); await page.locator('#a').click(); await page.locator('#b').click(); await page.locator('#open-prompt').click(); await page.locator('#answer').fill('PRIVATE_REACT_715'); await page.locator('#submit').click(); await page.waitForFunction(() => window.workspaceReact.privateAnswer() === 'PRIVATE_REACT_715');
      const privacy = await page.evaluate(async () => ({ submitted: window.workspaceReact.counts().submitted, leaked: JSON.stringify(window.workspaceReact.snapshot('b')).includes('PRIVATE_REACT_715'), statuses: window.workspaceReact.snapshot('b').operations.length, local: localStorage.length, db: (await indexedDB.databases()).length })); assert.deepEqual(privacy, { submitted: 1, leaked: false, statuses: 1, local: 0, db: 0 }); cases.push('actual React confirmation survives dismiss/switch; one explicit answer reaches actual callback owner and one redacted operation marker');
      await page.evaluate(() => window.workspaceReact.close()); await page.waitForFunction(() => document.getElementById('state')?.textContent === 'disposed'); assert.deepEqual(await page.evaluate(() => ({ streams: window.workspaceReact.counts().streams, kind: window.workspaceReact.snapshot('a').kind })), { streams: 0, kind: 'disposed' }); assert.deepEqual(errors, []); cases.push('auth namespace disposal updates mounted React and revokes every background observation without a native lifetime effect');
      await context.close(); return { passed: true, cases, react: '19.2.8', chromium: browser.version() };
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workspace React fixture exceeded45 seconds')), 45000); })]);
  } finally { clearTimeout(timer); await browser?.close(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runBrowserQualification().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
