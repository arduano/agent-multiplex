import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const here = dirname(fileURLToPath(import.meta.url)), framework = resolve(here, '../../..');

export async function runPluginBrowserQualification({ buildRoot = resolve(here, '../.build') } = {}) {
  const load = path => import(pathToFileURL(resolve(buildRoot, path)).href);
  const [{ pluginBrowserDomains }, { activateHost }, { GatewayCoordinator }, { createGatewayHttpHandler }, { createHmacHostProof, authenticateHostProof }, { createInProcessHostRpcPort }] = await Promise.all([
    load('primitives/v8-workspace/qualification/plugins-browser-fixture.js'), load('primitives/v8-plugins/src/index.js'), load('primitives/v8-gateway/src/gateway/coordinator.js'), load('primitives/v8-gateway/src/http/server.js'), load('primitives/v8-gateway/src/node/host-proof.js'), load('primitives/v8-gateway/src/node/in-process-host.js'),
  ]);
  const domains = pluginBrowserDomains(), coordinator = new GatewayCoordinator(), proof = createHmacHostProof({ issuer: 'browser-gateway', audience: 'browser-hosts', secret: randomBytes(32) });
  const identity = { connection: 'fixture', principal: 'owner', authorities: ['authority'], actions: ['read', 'control'] }, hosts = [];
  const metadata = {};
  for (const kind of ['local', 'work']) {
    const target = { connection: 'fixture', principal: 'owner', authority: 'authority', host: `${kind}-host`, owner: 'durable-owner', routeEpoch: 'route-1' };
    const host = await activateHost(domains[kind], { route: target, storage: {}, authenticate: authenticateHostProof(proof) }); hosts.push(host);
    coordinator.registerHostRpc({ target, port: createInProcessHostRpcPort({ router: host.router, manifest: host.manifest,
      context: (caller, request, type) => host.context({ proof: { authorization: proof.issue(caller, request, type), path: request.path, type }, expected: request.expected, ...(request.session ? { session: request.session } : {}) }),
    }) });
    metadata[kind] = { target, manifest: host.manifest };
  }
  const fromFramework = createRequire(resolve(framework, 'package.json'));
  const bundle = await build({ entryPoints: [resolve(here, 'plugins-browser-entry.ts')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2023', define: { 'process.env.NODE_ENV': '"development"' }, alias: { react: fromFramework.resolve('react'), 'react-dom/client': fromFramework.resolve('react-dom/client'), 'react-dom/server': fromFramework.resolve('react-dom/server.browser') }, metafile: true, logLevel: 'silent' });
  for (const path of Object.keys(bundle.metafile.inputs)) if (/\/src\/(?:host|node|authority|gateway|http)\//.test(path) || path.includes('storage-sqlite') || path.includes('v8-plugins/src/host') || path.includes('plugins-browser-fixture')) throw Error('Server owner escaped typed plugin browser graph');
  const handler = createGatewayHttpHandler(coordinator, async value => value === 'Bearer browser-owner' ? identity : null);
  const server = createServer((req, res) => {
    if (req.url === '/v8') { handler(req, res); return; }
    if (req.url === '/meta') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata)); return; }
    if (req.url === '/emit') { domains.emit(); res.writeHead(200).end(); return; }
    if (req.url === '/revoke') { handler.revoke(identity); res.writeHead(200).end(); return; }
    if (req.url === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].contents); return; }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>'); return; }
    res.writeHead(404).end();
  });
  let browser, timer; const errors = [], cases = [];
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    return await Promise.race([(async () => {
      browser = await chromium.launch({ executablePath: '/run/current-system/sw/bin/chromium', headless: true, timeout: 15000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin); await page.waitForFunction(() => window.pluginReact?.ready).catch(error => { throw Error(`${error.message}; browser errors: ${JSON.stringify(errors)}`); });
      await page.waitForFunction(() => document.getElementById('custom-session')?.textContent?.includes('main'));
      const ssr = await page.evaluate(() => window.pluginReact.ssr); assert.equal(ssr.htmlHasCodex, true); assert.deepEqual(ssr.before, ssr.after); assert.equal(ssr.before.channels, 0); assert.equal(ssr.before.streams, 0);
      assert.equal(await page.locator('#native').textContent(), 'codex'); cases.push('actual SSR is inert and StrictMode commit binds the typed Codex Host and custom data');

      const first = await page.evaluate(() => window.pluginReact.stats());
      await page.locator('#edit').click(); await page.evaluate(() => window.pluginReact.pin(true)); await page.locator('#work').click();
      await page.waitForFunction(() => document.getElementById('custom-session')?.textContent?.includes('engineering'));
      assert.equal(await page.locator('#native').textContent(), 'copilot'); assert.match(await page.locator('#custom-host').textContent(), /managed/);
      assert.equal((await page.evaluate(() => window.pluginReact.stats())).channels, first.channels);
      assert.equal(domains.stats().watchers, 4);
      await page.request.get(origin + '/emit');
      await page.waitForFunction(() => window.pluginReact.snapshot().local.plugin.value?.extensions.workspace.branch === 'background-update');
      await page.locator('#local').click(); await page.waitForFunction(() => document.getElementById('custom-session')?.textContent?.includes('background-update'));
      assert.equal(await page.locator('#draft').textContent(), 'retained typed plugin draft');
      assert.equal((await page.evaluate(() => window.pluginReact.stats())).channels, first.channels);
      cases.push('two different Host contracts share one existing HTTP mux; A/B/A and pinned background updates retain actual draft/history');

      const result = await page.evaluate(() => window.pluginReact.query()); assert.equal(result.local.directory, '/owned/local'); assert.equal(result.work.team, 'operations');
      await page.evaluate(() => window.pluginReact.claim()); assert.deepEqual(await page.evaluate(() => window.pluginReact.original()), { id: 'browser-original', branch: 'claimed' });
      assert.equal(domains.stats().effects, 1); cases.push('concrete typed query, custom data and one original mutation traverse React client to actual Host router');

      const beforeReconnect = await page.evaluate(() => window.pluginReact.stats());
      await page.evaluate(() => window.pluginReact.disconnect());
      assert.equal(await page.evaluate(() => window.pluginReact.snapshot().local.plugin.value.extensions.workspace.branch), 'claimed');
      await page.evaluate(() => window.pluginReact.reconnect());
      await page.waitForFunction(() => window.pluginReact.snapshot().local.plugin.observation === 'live');
      assert.equal((await page.evaluate(() => window.pluginReact.stats())).channels, beforeReconnect.channels + 1);
      assert.equal(domains.stats().effects, 1);
      await page.evaluate(() => window.pluginReact.unmount()); assert.equal(domains.stats().watchers >= 2, true);
      await page.evaluate(() => window.pluginReact.remount()); await page.waitForFunction(() => document.getElementById('custom-session')?.textContent?.includes('claimed'));
      assert.equal(await page.locator('#draft').textContent(), 'retained typed plugin draft');
      cases.push('existing Gateway reconnect reopens public observations only; unmount/remount preserves pins without mutation replay');

      await page.request.get(origin + '/revoke'); await page.waitForFunction(() => document.getElementById('state')?.textContent === 'disposed');
      const disposed = await page.evaluate(() => { const value = window.pluginReact.snapshot(); return { local: { plugin: value.local.plugin, agent: value.local.agent }, work: { plugin: value.work.plugin } }; }); assert.equal(disposed.local.plugin.value, null); assert.equal(disposed.work.plugin.value, null);
      assert.deepEqual(disposed.local.agent, { kind: 'disposed' }); assert.deepEqual(errors, []);
      await page.evaluate(() => window.pluginReact.close()); await context.close();
      cases.push('positive auth revocation redacts both retained typed views and releases every pinned observation');
      return { passed: true, cases, react: fromFramework('react/package.json').version, chromium: browser.version(), nativeAgentCalls: 0, modelCalls: 0, source: 'two scripted owners; actual React/HTTP/Gateway/Host routers', effects: domains.stats().effects };
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Typed plugin React proof exceeded60 seconds')), 60000); })]);
  } finally {
    clearTimeout(timer); await browser?.close(); handler.close(); coordinator.close(); server.closeAllConnections();
    await new Promise(accept => server.close(accept));
    for (const host of hosts.reverse()) await host.close(); proof.revoke();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runPluginBrowserQualification().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
