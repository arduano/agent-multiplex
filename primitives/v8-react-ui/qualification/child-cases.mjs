import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { embeddedDialogGeometry, inSideBySideEmbeds } from './preview-cases.mjs';

export async function qualifyChildHistories(page, chat, cases, out) {
 return inSideBySideEmbeds(page, async () => {
  const geometry = [];
  const message = chat.locator('[data-action=message]');
  for (const [session, kind] of [['a', 'codex'], ['b', 'copilot']]) {
    await page.locator(`#session-${session}`).click(); await message.fill(`Parent ${kind} draft stays with parent`);
    await page.evaluate(session => window.chatFixture.children(session), session);
    const before = await page.evaluate(() => window.chatFixture.childStats()), effects = await page.evaluate(() => window.chatFixture.counts().submitted);
    await chat.getByRole('button',{name:'More message actions',exact:true}).click();
    await chat.getByRole('menuitem',{name:'Session tools',exact:true}).click();
    const picker = chat.locator('.mpx-chat__child-histories'); await picker.locator('summary').click();
    assert.equal((await page.evaluate(() => window.chatFixture.childStats())).inventoryReads, before.inventoryReads, 'Opening a disclosure performs no inventory/native read');
    await picker.getByRole('button', { name: 'Refresh observed agents', exact: true }).click();
    const trigger = picker.getByRole('button', { name: `View agent ${kind}-child`, exact: true }); await trigger.click();
    const dialog = chat.getByRole('dialog', { name: `Agent history · ${kind}-child`, exact: true }); await dialog.getByText(`AUTHENTICATED_${kind.toUpperCase()}_CHILD`, { exact: true }).waitFor();
    geometry.push({ kind, ...await embeddedDialogGeometry(chat, dialog, dialog.getByRole('button', { name: 'Close agent history', exact: true })) });
    if (out) await page.screenshot({ path: resolve(out, `embedded-${kind}-child.png`) });
    assert.equal(await dialog.locator('[data-action=message],[data-action=send],[data-action=stop],[data-action=confirmation]').count(), 0);
    assert.equal(await dialog.getByText('retained history', { exact: true }).count(), 0);
    assert.equal((await page.evaluate(() => window.chatFixture.childStats())).older, before.older);
    await dialog.getByRole('button', { name: 'Load earlier history', exact: true }).click(); await dialog.getByText('older private page', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Close agent history', exact: true }).click();
    await page.waitForFunction(label => document.activeElement?.textContent === label, `View agent ${kind}-child`);
    await trigger.click(); await dialog.getByText('older private page', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.chatFixture.childStats())).older, before.older + 1);
    await dialog.getByRole('button', { name: 'Close agent history', exact: true }).click();
    await chat.getByRole('button', { name: 'Close session tools', exact: true }).click();
    assert.equal(await message.inputValue(), `Parent ${kind} draft stays with parent`); assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), effects);
    await message.fill('');
  }
  await page.locator('#session-a').click();
  cases.push('Codex and Copilot child pickers read only explicit Host-proved inventories; read-only modals preserve independent cached pages, parent drafts, focus and one explicit older read without native controls');
  cases.push('Both native child dialogs stay within one narrow side-by-side retained chat with visible hittable close controls');
  if (out) await writeFile(resolve(out, 'child-geometry.json'), JSON.stringify(geometry, null, 2) + '\n');
 });
}
