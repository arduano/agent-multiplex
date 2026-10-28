import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Real retained workspace + StrictMode chat; native-shaped diagnostics only. */
export async function qualifyNativeErrors(page, chat, cases, out) {
  const original = await page.evaluate(() => window.chatFixture.nativeError());
  const row = chat.getByRole('note', { name: 'Agent error', exact: true });
  await row.waitFor();
  assert.equal(await row.locator('.mpx-chat__native-error-message').textContent(), original.message);
  assert.equal(await row.locator('a,strong,img').count(), 0, 'Native diagnostics are escaped exact text, not interpreted Markdown');
  assert.equal(await row.locator('button').count(), 0, 'A diagnostic does not offer command replay');
  const before = await page.evaluate(() => window.chatFixture.commands());
  assert.doesNotMatch(await chat.locator('[data-action=session-status]').innerText(), /Turn failed/, 'An error notification alone is not terminal evidence');
  await page.evaluate(() => window.chatFixture.optionalReconnect());
  await page.locator('#session-b').click();
  await page.locator('#session-a').click(); await row.waitFor();
  await page.evaluate(() => window.chatFixture.unmount());
  await page.evaluate(() => window.chatFixture.remount());
  await row.waitFor();
  assert.equal(await row.locator('.mpx-chat__native-error-message').textContent(), original.message);
  assert.deepEqual(await page.evaluate(() => window.chatFixture.commands()), before);
  cases.push('Exact native error is an accessible inline note on initial retained render, reconnect, A/B/A and remount without native actions');

  await page.evaluate(() => window.chatFixture.progress('working'));
  const retry = await page.evaluate(() => window.chatFixture.nativeError('a', true));
  await chat.getByRole('note', { name: 'Retry notice', exact: true }).waitFor();
  assert.match(await chat.locator('[data-action=session-status]').innerText(), /Working/);
  assert.equal(await chat.locator('[data-action=working-indicator]').count(), 1);
  assert.equal(await row.count(), 1, 'Later work retains the earlier error at its original row');
  assert.deepEqual(await page.evaluate(() => window.chatFixture.commands()), before, 'Retrying is a captured diagnostic, not a new UI retry');
  await page.evaluate(() => window.chatFixture.progress('idle'));
  await chat.locator('[data-action=message]').fill('An explicit later turn');
  await chat.locator('button[data-action=send]').click();
  await page.waitForFunction(count => window.chatFixture.commands().length === count + 1, before.length);
  assert.equal((await page.evaluate(() => window.chatFixture.commands())).at(-1), 'send');
  assert.equal(await row.count(), 1); assert.equal(await chat.getByRole('note', { name: 'Retry notice', exact: true }).count(), 1);
  cases.push('Retry diagnostics do not terminate current work; only explicit later Send submits once and keeps both original error rows');

  const geometry = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await row.scrollIntoViewIfNeeded();
    const fact = await row.evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, overflow: element.scrollWidth > element.clientWidth + 1 }; });
    assert.equal(fact.overflow, false); assert.ok(fact.left >= 0 && fact.right <= width + 1);
    geometry.push({ width, ...fact }); await page.screenshot({ path: resolve(out, `native-error-${width}.png`) });
  }
  await page.locator('#session-b').click();
  await page.evaluate(() => window.chatFixture.nativeError('b'));
  assert.equal(await chat.locator('[data-action=native-error]').count(), 0, 'Foreign harness metadata never gains Codex error semantics');
  cases.push('Exact long error text wraps at320/390px; foreign harness notice metadata stays generic');
  await writeFile(resolve(out, 'native-error-facts.json'), JSON.stringify({ originalRow: original.id, retryRow: retry.id, commandsBefore: before, commandsAfter: await page.evaluate(() => window.chatFixture.commands()), geometry }, null, 2) + '\n');
}
