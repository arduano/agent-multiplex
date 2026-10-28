import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The existing native callback owner and private FormHandle, rendered in React. */
export async function qualifyCodexQuestions(page, chat, cases, out) {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.locator('#session-a').click();
  const before = await page.evaluate(() => ({ count: window.chatFixture.counts().submitted, answers: window.chatFixture.promptAnswers().codexQuestions.length }));
  const request = id => chat.locator(`[data-interaction="${id}"]`);
  const open = async id => { const heading = request(id).locator('[data-action=confirmation]'); if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click(); };
  const question = await page.evaluate(() => window.chatFixture.codexQuestion()); await open(question);
  await request(question).getByText('Native choice description', { exact: true }).waitFor();
  await request(question).getByRole('button', { name: 'Send answers', exact: true }).click();
  const choice = request(question).getByRole('group', { name: 'Choice', exact: true });
  assert.equal(await choice.getAttribute('aria-invalid'), 'true');
  assert.equal(await choice.evaluate(element => document.getElementById(element.getAttribute('aria-describedby'))?.textContent), 'Choose an answer or enter your response.');
  const first = request(question).getByLabel('Extra info for Choice', { exact: true }), second = request(question).getByLabel('Extra info for Approach', { exact: true });
  await first.fill('  PRIVATE_FIRST_CONTEXT\nwith more detail  '); await second.fill('  PRIVATE_SECOND_CONTEXT  ');
  const secret = request(question).getByLabel('Answer for Secret'); assert.equal(await secret.getAttribute('type'), 'password'); await secret.fill('  PRIVATE_SECRET_ANSWER  ');
  await request(question).getByRole('button', { name: 'Send answers', exact: true }).click();
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), before.count, 'Extra info cannot replace the required selected choice');
  await request(question).getByRole('radio', { name: /A Native choice description/ }).check();
  const approach = request(question).getByRole('group', { name: 'Approach', exact: true });
  await approach.getByRole('radio', { name: /C Third route/ }).check();
  await approach.getByRole('radio', { name: 'Other', exact: true }).check();
  await approach.getByLabel('Answer for Approach').fill('PRIVATE_HIDDEN_OTHER'); assert.equal(await second.count(), 0);
  await approach.getByRole('radio', { name: /C Third route/ }).check(); assert.equal(await second.inputValue(), '  PRIVATE_SECOND_CONTEXT  ');
  await page.locator('#session-b').click(); assert.equal(await chat.getByLabel('Extra info for Choice', { exact: true }).count(), 0);
  await page.locator('#session-a').click(); await open(question);
  await request(question).locator('[data-action=confirmation]').click(); await open(question);
  await page.evaluate(() => window.chatFixture.unmount()); await page.evaluate(() => window.chatFixture.remount()); await open(question);
  assert.equal(await first.inputValue(), '  PRIVATE_FIRST_CONTEXT\nwith more detail  '); assert.equal(await second.inputValue(), '  PRIVATE_SECOND_CONTEXT  ');
  assert.equal(await request(question).getByRole('radio', { name: /A Native choice description/ }).isChecked(), true);
  assert.equal(await approach.getByRole('radio', { name: /C Third route/ }).isChecked(), true);
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), before.count);
  assert.equal(await page.evaluate(() => JSON.stringify([window.chatFixture.snapshot('a'), window.chatFixture.snapshot('b')]).includes('PRIVATE_')), false);
  cases.push('Each structured Codex question retains its own private choice and extra info across Other, collapse, A/B/A and remount; context alone cannot answer and private values stay out of shared snapshots');

  await page.setViewportSize({ width: 320, height: 844 }); await first.scrollIntoViewIfNeeded();
  const geometry = await first.evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, overflow: element.scrollWidth > element.clientWidth + 1 }; });
  assert.equal(geometry.overflow, false); assert.ok(geometry.left >= 0 && geometry.right <= 321);
  await page.screenshot({ path: resolve(out, 'question-extra-info-320.png') });
  await request(question).getByRole('button', { name: 'Send answers', exact: true }).click(); await request(question).waitFor({ state: 'detached' });
  assert.deepEqual((await page.evaluate(() => window.chatFixture.promptAnswers().codexQuestions)).at(-1), { answers: { 'choice with space': { answers: ['A', 'PRIVATE_FIRST_CONTEXT\nwith more detail'] }, 'context:question': { answers: ['C', 'PRIVATE_SECOND_CONTEXT'] }, secret: { answers: ['PRIVATE_SECRET_ANSWER'] } } });
  cases.push('One explicit response maps every exact question ID to selected label plus separate trimmed extra-info string; secret freeform remains a single answer and320px inputs remain contained');

  const other = await page.evaluate(() => window.chatFixture.codexQuestion()); await open(other);
  await request(other).getByRole('radio', { name: /B Second route/ }).check();
  await request(other).getByLabel('Extra info for Choice', { exact: true }).fill(' \n ');
  await request(other).getByLabel('Extra info for Approach', { exact: true }).fill('PRIVATE_NOT_THE_OTHER_ANSWER');
  const otherApproach = request(other).getByRole('group', { name: 'Approach', exact: true });
  await otherApproach.getByRole('radio', { name: 'Other', exact: true }).check();
  await otherApproach.getByLabel('Answer for Approach').fill('  PRIVATE_OTHER_ANSWER  ');
  await request(other).getByLabel('Answer for Secret').fill('  PRIVATE_FREEFORM_ANSWER  ');
  await request(other).getByRole('button', { name: 'Send answers', exact: true }).click(); await request(other).waitFor({ state: 'detached' });
  assert.deepEqual((await page.evaluate(() => window.chatFixture.promptAnswers().codexQuestions)).at(-1), { answers: { 'choice with space': { answers: ['B'] }, 'context:question': { answers: ['PRIVATE_OTHER_ANSWER'] }, secret: { answers: ['PRIVATE_FREEFORM_ANSWER'] } } });
  assert.equal(await page.evaluate(() => window.chatFixture.counts().submitted), before.count + 2);
  cases.push('Blank extra info is omitted; Other and plain freeform submit only their own trimmed answer, excluding hidden retained choice context');
  await writeFile(resolve(out, 'question-extra-info-facts.json'), JSON.stringify({ geometry, responseCount: 2, privateValuesAbsentFromSnapshots: true, nativeModelCalls: 0 }, null, 2) + '\n');
}
