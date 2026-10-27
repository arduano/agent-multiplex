import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Native-shaped metadata + actual retained workspace, files, composer and chat. */
export async function qualifyOptionalQuestions(page, chat, cases, out) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#session-a').click();
  const attachment = await page.evaluate(() => window.chatFixture.optionalDraft());
  const native = await page.evaluate(() => window.chatFixture.optionalQuestions());
  await page.evaluate(() => window.chatFixture.progress('working'));
  const row = chat.locator(`[data-row="${native.row}"]`), message = chat.locator('[data-action=message]');
  await row.getByRole('button', { name: native.questions[0].options[0], exact: true }).waitFor();
  assert.equal(await row.locator('.mpx-chat__markdown').count(), 0, 'Only exact native fallback text is visually replaced by structured questions');
  assert.equal(await row.getByText(native.questions[0].title, { exact: true }).count(), 1);
  const before = await page.evaluate(() => window.chatFixture.optionalState());
  assert.equal(before.activity, 'working');
  assert.equal(await chat.locator('button[data-action=steer]').isEnabled(), true);
  const choice = native.questions[0].options[0];
  await row.getByRole('button', { name: choice, exact: true }).click();
  const chosen = `${attachment.text}\n\nRegarding: ${native.questions[0].title}\n${choice}`;
  assert.equal(await message.inputValue(), chosen);
  assert.equal(await message.evaluate(element => document.activeElement === element), true);
  await page.waitForFunction(() => window.chatFixture.optionalState().composer.state === 'saved');
  const selected = await page.evaluate(() => window.chatFixture.optionalState());
  assert.deepEqual(selected.composer.value.fileIds, [attachment.file]);
  assert.deepEqual(selected.selectionDraft, before.selectionDraft); assert.deepEqual(selected.observed, before.observed);
  assert.deepEqual(selected.commands, before.commands, 'Question mount and choice only edit the draft');
  assert.equal(selected.activity, 'working'); assert.equal(await chat.locator('button[data-action=steer]').isEnabled(), true);
  assert.deepEqual((await page.evaluate(() => window.chatFixture.optionalStored())).value, selected.composer.value, 'The existing persistence owner commits the exact appended draft');
  cases.push('While native work continues with Steer available, an optional choice appends exact contextual text to the durable prior draft, keeps its PNG and selection, focuses the composer and makes no native call');

  await page.locator('#session-b').click();
  const spoof = await page.evaluate(() => window.chatFixture.optionalQuestions('b'));
  await chat.locator(`[data-row="${spoof.row}"]`).waitFor();
  assert.equal(await chat.locator(`[data-row="${spoof.row}"] [data-action=optional-questions]`).count(), 0, 'Copilot metadata cannot introduce Codex affordances');
  await page.locator('#session-a').click(); await row.waitFor();
  await page.evaluate(() => window.chatFixture.optionalReconnect());
  assert.equal(await message.inputValue(), chosen);
  assert.deepEqual((await page.evaluate(() => window.chatFixture.optionalState())).commands, before.commands);
  await row.getByRole('group', { name: native.questions[1].title, exact: true }).getByRole('button', { name: 'Write a reply', exact: true }).click();
  const written = `${chosen}\n\nRegarding: ${native.questions[1].title}\n`;
  assert.equal(await message.inputValue(), written);
  assert.equal(await message.evaluate(element => document.activeElement === element), true);
  assert.deepEqual((await page.evaluate(() => window.chatFixture.optionalState())).composer.value.fileIds, [attachment.file]);
  cases.push('A/B/A and observation reconnect retain the optional reply without submission; Write a reply appends its empty answer and Copilot prose remains inert');

  const geometry = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 800 }]) {
    await page.setViewportSize(viewport); await row.locator('[data-action=optional-reply]').first().scrollIntoViewIfNeeded();
    const fact = await row.evaluate(element => ({ overflow: element.scrollWidth > element.clientWidth + 1,
      buttons: [...element.querySelectorAll('button')].map(button => { const box = button.getBoundingClientRect(); return { height: box.height, left: box.left, right: box.right }; }) }));
    assert.equal(fact.overflow, false); assert.ok(fact.buttons.length > 0);
    for (const button of fact.buttons) { assert.ok(button.height >= 44); assert.ok(button.left >= 0 && button.right <= viewport.width + 1); }
    geometry.push({ ...viewport, ...fact }); await page.screenshot({ path: resolve(out, `optional-questions-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const variant of ['prose', 'without-delivery', 'ordinary', 'omitted']) {
    const detail = await page.evaluate(variant => window.chatFixture.optionalQuestions('a', variant), variant), item = chat.locator(`[data-row="${detail.row}"]`);
    await item.waitFor();
    if (variant === 'prose') { await item.getByText('Native explanation stays visible before the optional question.', { exact: true }).waitFor(); assert.equal(await item.locator('[data-action=optional-reply]').count(), 2); }
    if (variant === 'without-delivery') assert.equal(await item.locator('[data-action=optional-reply]').count(), 2, 'Validated questions remain usable with older/unspecified delivery metadata');
    if (variant === 'ordinary') { assert.equal(await item.locator('[data-action=optional-questions]').count(), 0); assert.equal(await item.locator('.mpx-chat__markdown').count(), 1); }
    if (variant === 'omitted') { await item.getByText('Some optional questions could not be shown. You can reply in the message box.', { exact: true }).waitFor(); assert.equal(await item.locator('.mpx-chat__markdown').count(), 1); }
  }
  assert.equal(await message.inputValue(), written);
  assert.deepEqual((await page.evaluate(() => window.chatFixture.optionalState())).commands, before.commands);
  cases.push('Optional questions wrap at320/390px with44px actions; real prose and bounded omissions stay visible, and prose alone never becomes a prompt');

  await page.evaluate(() => window.chatFixture.children('a', true));
  await chat.getByRole('button', { name: 'More message actions', exact: true }).click();
  await chat.getByRole('menuitem', { name: 'Session tools', exact: true }).click();
  const picker = chat.locator('.mpx-chat__child-histories'); await picker.locator('summary').click();
  await picker.getByRole('button', { name: 'Refresh observed agents', exact: true }).click();
  await picker.getByRole('button', { name: 'View agent codex-child', exact: true }).click();
  const child = chat.getByRole('dialog', { name: 'Agent history · codex-child', exact: true });
  await child.getByText('Child question stays read only', { exact: true }).waitFor();
  assert.equal(await child.locator('[data-action=optional-reply],[data-action=optional-write-reply]').count(), 0);
  await child.getByText('Child choice', { exact: true }).waitFor();
  await child.getByRole('button', { name: 'Close agent history', exact: true }).click();
  await chat.getByRole('button', { name: 'Close session tools', exact: true }).click();
  assert.equal(await message.inputValue(), written);
  assert.deepEqual((await page.evaluate(() => window.chatFixture.optionalState())).commands, before.commands);

  await page.evaluate(() => window.chatFixture.progress('idle'));
  const send = chat.locator('button[data-action=send]'); await send.click();
  await page.waitForFunction(count => window.chatFixture.optionalState().commands.length === count + 1, before.commands.length);
  const after = await page.evaluate(() => window.chatFixture.optionalState());
  const command = after.commands.at(-1); assert.equal(command.type, 'send'); assert.equal(command.text, written);
  assert.equal(command.inputs.items[0].artifact.id, attachment.file); assert.deepEqual(command.selection, before.selectionDraft);
  await page.waitForFunction(() => window.chatFixture.optionalState().composer.value.text === '');
  await page.evaluate(() => window.chatFixture.archiveVisualFixture());
  await chat.locator('[data-action=archive-status]').waitFor();
  assert.ok((await chat.locator('[data-action=archive-status]').innerText()).includes('Archived. Loaded history and original receipts are retained.'));
  assert.equal(await chat.locator('[data-action=optional-reply],[data-action=optional-write-reply]').count(), 0);
  const retained = chat.locator('[data-row=optional-prose]'); await retained.scrollIntoViewIfNeeded();
  await retained.getByText(native.questions[0].title, { exact: true }).waitFor();
  cases.push('Child and archived questions stay readable and inert; only a later explicit Send submits the exact staged text, PNG and retained selection once');
  await writeFile(resolve(out, 'optional-question-facts.json'), JSON.stringify({ beforeCommandCount: before.commands.length, afterCommandCount: after.commands.length, geometry, attachmentPreserved: true, nativeQuestionCallbacks: 0 }, null, 2) + '\n');
}
