import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Resize the two existing mounted consumers, without replacing their owners. */
export async function inSideBySideEmbeds(page, run) {
  const previous = await page.evaluate(() => {
    const selectors = ['main', 'main > nav', '#chat-container', '#light-embed'];
    const previous = selectors.map(selector => [selector, document.querySelector(selector).getAttribute('style')]);
    Object.assign(document.querySelector('main').style, { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gridTemplateRows: '36px minmax(0,1fr)', columnGap: '16px', padding: '0 16px 16px', boxSizing: 'border-box' });
    document.querySelector('main > nav').style.gridColumn = '1 / -1';
    Object.assign(document.querySelector('#chat-container').style, { gridColumn: '1', gridRow: '2', minWidth: '0' });
    Object.assign(document.querySelector('#light-embed').style, { display: 'block', gridColumn: '2', gridRow: '2', height: 'auto', minWidth: '0', minHeight: '0' });
    return previous;
  });
  try {
    await page.waitForFunction(() => {
      const left = document.querySelector('#chat-container .multiplex-chat')?.getBoundingClientRect(), right = document.querySelector('#light-embed .multiplex-chat')?.getBoundingClientRect();
      return left && right && left.width < 800 && left.right < right.left && Math.abs(left.top - right.top) < 1;
    });
    return await run();
  } finally {
    await page.evaluate(previous => { for (const [selector, style] of previous) { const element = document.querySelector(selector); if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); } }, previous);
  }
}

export async function embeddedDialogGeometry(chat, dialog, close) {
  const surface = await chat.boundingBox(), box = await dialog.boundingBox(), control = await close.boundingBox();
  const hit = await close.evaluate(node => { const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return hit === node || node.contains(hit); });
  const facts = { surface, dialog: box, close: control, hit };
  assert.ok(surface && box && control, JSON.stringify(facts));
  assert.ok(box.x >= surface.x - 1 && box.y >= surface.y - 1 && box.x + box.width <= surface.x + surface.width + 1 && box.y + box.height <= surface.y + surface.height + 1, JSON.stringify(facts));
  assert.ok(control.x >= box.x && control.y >= box.y && control.x + control.width <= box.x + box.width + 1 && control.y + control.height <= box.y + box.height + 1, JSON.stringify(facts));
  assert.equal(hit, true, JSON.stringify(facts));
  return facts;
}

export async function qualifyDocumentPreviews(page, chat, cases, out) {
 return inSideBySideEmbeds(page, async () => {
  await page.evaluate(() => window.chatFixture.documents());
  const row = chat.locator('[data-row=local-documents]'); await row.getByRole('button', { name: 'Guide', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.chatFixture.fileStats())).captures.length, 0, 'Rendering local links must not read native files');
  await row.getByRole('button', { name: 'Guide', exact: true }).click();
  let dialog = chat.getByRole('dialog'); await dialog.getByRole('heading', { name: 'Captured guide', exact: true }).waitFor();
  const geometry = await embeddedDialogGeometry(chat, dialog, dialog.getByRole('button', { name: 'Close preview', exact: true }));
  if (out) { await writeFile(resolve(out, 'preview-geometry.json'), JSON.stringify(geometry, null, 2) + '\n'); await page.screenshot({ path: resolve(out, 'embedded-preview.png') }); }
  await dialog.getByText('docs/guide.md', { exact: true }).waitFor();
  const thumbnail = dialog.getByRole('button', { name: 'Expand Local picture', exact: true }); await thumbnail.waitFor();
  await dialog.getByRole('button', { name: 'Read child', exact: true }).click(); await dialog.getByText('Nested file reached the exact same authenticated owner.', { exact: true }).waitFor();
  await dialog.getByText('docs/child.txt', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Back to previous file', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Captured guide', exact: true }).waitFor(); await thumbnail.waitFor();
  await dialog.getByText('docs/guide.md', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Guide');
  await page.evaluate(() => window.chatFixture.mutateGuide()); await row.getByRole('button', { name: 'Guide', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Captured guide', exact: true }).waitFor(); assert.equal(await dialog.getByText('Changed file must not replace', { exact: false }).count(), 0);
  let stats = await page.evaluate(() => window.chatFixture.fileStats());
  const guides = stats.captures.filter(value => value.path === 'docs/guide.md'), pictures = stats.captures.filter(value => value.path === 'docs/picture.png');
  assert.ok(guides.length >= 2); assert.equal(new Set(guides.map(value => value.sourceKey)).size, 1); assert.ok(pictures.length >= 1); assert.equal(new Set(pictures.map(value => value.sourceKey)).size, 1);
  assert.deepEqual([...new Set(stats.captures.map(value => value.path))].sort(), ['docs/child.txt', 'docs/guide.md', 'docs/picture.png']); assert.equal(stats.hostReadLeases, 0);
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  cases.push('Explicit Markdown local links and visible local images preserve exact document-relative capture keys; nested Back returns to the immutable first snapshot and closing restores the original link focus');

  // The old static sanitizer/node-count cap is intentionally retired. This
  // standalone embed supplies no authenticated HTML navigation address; the
  // dedicated document gate proves the actual interactive sandbox response.
  await row.getByRole('button', { name: 'HTML', exact: true }).click();
  await dialog.getByText('Interactive HTML preview is unavailable. Download the original file.', { exact: true }).waitFor(); assert.equal(await dialog.locator('iframe').count(), 0);
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click(); await row.getByRole('button', { name: 'Large HTML', exact: true }).click();
  await dialog.getByText('Interactive HTML preview is unavailable. Download the original file.', { exact: true }).waitFor();
  const htmlDownloadEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download file', exact: true }).click(); const htmlDownload = await htmlDownloadEvent;
  assert.equal(htmlDownload.suggestedFilename(), 'large.html'); assert.equal(await readFile(await htmlDownload.path(), 'utf8'), '<div></div>'.repeat(10_001));
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click(); await row.getByRole('button', { name: 'Guide', exact: true }).click();
  await thumbnail.click();
  const imageDialog = chat.getByRole('dialog', { name: 'Local picture', exact: true });
  await imageDialog.locator('.mpx-chat__image-viewport img').waitFor(); await page.waitForFunction(() => document.querySelector('.mpx-chat__image-viewport img')?.naturalWidth > 0);
  await imageDialog.getByRole('button', { name: 'Zoom image in', exact: true }).click(); await imageDialog.getByText('125%', { exact: true }).waitFor();
  await imageDialog.getByRole('button', { name: 'Fit image', exact: true }).click(); await imageDialog.getByText('100%', { exact: true }).waitFor();
  await embeddedDialogGeometry(chat, imageDialog, imageDialog.getByRole('button', { name: 'Close image', exact: true }));
  await imageDialog.getByRole('button', { name: 'Close image', exact: true }).click(); await imageDialog.waitFor({ state: 'detached' });
  assert.equal(await thumbnail.evaluate(element => document.activeElement === element), true);
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  cases.push('An embed without a trusted HTML navigation route reports unavailable and preserves exact verified downloads; nested local image expansion stays in the owning chat, reuses fit/zoom and restores thumbnail focus');

  await row.getByRole('button', { name: 'PDF', exact: true }).click();
  const pdf = dialog.locator('[data-testid=pdf-preview]'); await pdf.getByText('Page 1 of 2', { exact: true }).waitFor({ timeout: 25000 });
  const firstPage = pdf.locator('[data-page-number="1"]'), secondPage = pdf.locator('[data-page-number="2"]');
  await firstPage.locator('canvas[data-rendered=true]').waitFor(); await firstPage.getByText('Read page 1 text', { exact: true }).click(); await firstPage.getByText('Verified PDF first page', { exact: true }).waitFor();
  assert.equal(await pdf.locator('iframe,object,embed,a,script').count(), 0);
  const pixels = await firstPage.locator('canvas').evaluate(canvas => { const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 240 && data[i + 1] < 240 && data[i + 2] < 240 && data[i + 3] > 0) ink++; return { width: canvas.width, height: canvas.height, ink }; });
  assert.ok(pixels.width > 0 && pixels.height > 0 && pixels.width * pixels.height <= 8_000_000 && pixels.ink > 30, JSON.stringify(pixels));
  // Continuous pages replace the intentionally retired one-selected-canvas UI.
  await pdf.getByRole('button', { name: 'Next PDF page', exact: true }).click(); await secondPage.locator('canvas[data-rendered=true]').waitFor();
  await secondPage.getByText('Read page 2 text', { exact: true }).click(); await secondPage.getByText('Verified PDF second page', { exact: true }).waitFor();
  assert.equal(await pdf.locator('[data-page-number]').count(), 2);
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click(); await row.getByRole('button', { name: 'Original binary', exact: true }).click();
  await dialog.getByText('This file has no safe inline preview.', { exact: false }).waitFor();
  const downloaded = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download file', exact: true }).click(); const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'original.bin'); assert.deepEqual(new Uint8Array(await readFile(await download.path())), new Uint8Array([0, 255, 0, 1, 128, 37]));
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  stats = await page.evaluate(() => window.chatFixture.fileStats()); assert.equal(stats.hostReadLeases, 0);
  cases.push('Real PDF.js worker renders verified continuous two-page bytes with bounded canvases and inert PDF actions; unknown binary downloads preserve the original bytes exactly');
  cases.push('A preview opened inside one of two side-by-side retained chats stays within its owning surface and its close control is visible and hittable');
 });
}
