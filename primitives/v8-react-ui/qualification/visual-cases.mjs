import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Same retained Workspace/FilePort/ResourceCache and Transcript as the main
 * fixture. Visibility, gestures and retirement are exercised through real React. */
export async function qualifyInlineVisuals(page, chat, cases, out, { archive = false } = {}) {
  const embed = await page.locator('#light-embed').getAttribute('style');
  await page.locator('#light-embed').evaluate(element => { element.style.display = 'none'; });
  const history = chat.locator('[data-action=history]'), before = await page.evaluate(() => window.chatFixture.counts());
  try {
    await history.evaluate(element => { element.style.display = 'none'; });
    const initial = await page.evaluate(() => window.chatFixture.previewCounts());
    await page.evaluate(() => window.chatFixture.media('visual-native', 'tool'));
    const row = chat.locator('[data-row=media-visual-native]'), placeholder = row.locator('[data-media-state=deferred]');
    await placeholder.waitFor({ state: 'attached' }); await frame(page);
    assert.equal((await page.evaluate(() => window.chatFixture.previewCounts())).acquired, initial.acquired, 'Hidden native images must not acquire bytes');
    const reserved = await placeholder.evaluate(element => getComputedStyle(element).height);
    await history.evaluate(element => { element.style.removeProperty('display'); });
    const expand = row.getByRole('button', { name: 'Expand Agent image', exact: true }); await expand.waitFor();
    assert.equal(await row.locator('details').evaluate(element => element.open), false);
    assert.equal(await expand.evaluate(element => element.closest('details') === null), true, 'Image is outside collapsed tool text');
    assert.ok((await expand.boundingBox()).width >= 160, 'Native thumbnail reserves a useful visible width');
    assert.equal(await row.locator('.mpx-chat__inline-media').evaluate(element => getComputedStyle(element).height), reserved);
    const loaded = await page.evaluate(() => window.chatFixture.previewCounts()); assert.equal(loaded.hostReadLeases, 0);
    await expand.click();
    let dialog = chat.getByRole('dialog', { name: 'Agent image', exact: true });
    await dialog.locator('.mpx-chat__image-viewport img').waitFor();
    await dialog.getByRole('button', { name: 'Zoom image in', exact: true }).click(); await dialog.getByText('125%', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Fit image', exact: true }).click(); await dialog.getByText('100%', { exact: true }).waitFor();
    const viewport = dialog.getByRole('region', { name: /^Image preview/ });
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      // Fit fills height here. The letterboxed horizontal axis stays centred
      // until it overflows; use an off-centre vertical focal point instead.
      const box = await viewport.boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2 + 20;
      const imageBefore = await viewport.locator('img').boundingBox();
      const touches = spread => [{ id: 1, x: cx - spread, y: cy }, { id: 2, x: cx + spread, y: cy }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(30) });
      for (const spread of [36, 42, 48, 54, 60]) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(spread) }); await frame(page); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await frame(page);
      const imageAfter = await viewport.locator('img').boundingBox();
      const focal = { xBefore: (cx - imageBefore.x) / imageBefore.width, xAfter: (cx - imageAfter.x) / imageAfter.width, yBefore: (cy - imageBefore.y) / imageBefore.height, yAfter: (cy - imageAfter.y) / imageAfter.height, scale: imageAfter.width / imageBefore.width };
      assert.ok(focal.scale > 1.8 && focal.scale < 2.2, JSON.stringify(focal));
      assert.ok(Math.abs(focal.xBefore - focal.xAfter) < .003 && Math.abs(focal.yBefore - focal.yAfter) < .003, JSON.stringify(focal));
      await writeFile(resolve(out, 'image-pinch.json'), JSON.stringify(focal, null, 2) + '\n');
    } finally { await cdp.detach(); }
    await page.screenshot({ path: resolve(out, 'native-image-expanded.png') });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.equal(await expand.evaluate(element => document.activeElement === element), true);
    assert.equal((await page.evaluate(() => window.chatFixture.previewCounts())).acquired, loaded.acquired, 'Expand/zoom reuses the visible image lease');
    await page.locator('#session-b').click();
    await page.waitForFunction(() => { const counts = window.chatFixture.previewCounts(); return counts.released === counts.acquired; });
    await page.evaluate(() => window.chatFixture.media('late-preview'));
    await page.locator('#session-a').click(); await page.waitForFunction(() => window.chatFixture.previewCounts().held);
    await page.locator('#session-b').click(); await page.evaluate(() => window.chatFixture.resolvePreview());
    await page.waitForFunction(() => { const counts = window.chatFixture.previewCounts(); return counts.released === counts.acquired; });
    assert.equal(await chat.getByRole('dialog').count(), 0);
    cases.push('Visible native images load lazily outside folded tools with fixed thumbnail geometry; expanded images share the exact lease, support focal touch pinch and focus restoration; switch and late completion release every lease');

    await page.locator('#session-a').click(); await page.evaluate(() => window.chatFixture.visualMarkdown());
    const markdown = chat.locator('[data-row=inline-local-image]');
    await markdown.getByRole('button', { name: 'Expand Local picture', exact: true }).waitFor();
    assert.equal(await markdown.getByRole('link', { name: 'External image', exact: true }).getAttribute('href'), 'https://outside.invalid/tracker.png');
    assert.equal(await markdown.locator('img[src^="https:"]').count(), 0);
    const captures = (await page.evaluate(() => window.chatFixture.fileStats())).captures;
    assert.equal(captures.at(-1).path, 'docs/picture.png');
    await page.setViewportSize({ width: 320, height: 700 });
    await markdown.getByRole('button', { name: 'Expand Local picture', exact: true }).click();
    dialog = chat.getByRole('dialog', { name: 'Local picture', exact: true });
    const geometry = await dialog.evaluate(element => { const box = element.getBoundingClientRect(), close = [...element.querySelectorAll('button')].find(button => button.textContent === 'Close image'), control = close.getBoundingClientRect(); return { box: box.toJSON(), control: control.toJSON(), width: innerWidth, height: innerHeight, overflow: element.scrollWidth > element.clientWidth + 1 }; });
    await writeFile(resolve(out, 'image-mobile-geometry.json'), JSON.stringify(geometry, null, 2) + '\n');
    assert.equal(geometry.overflow, false); assert.ok(geometry.box.left >= 0 && geometry.box.right <= geometry.width && geometry.box.bottom <= geometry.height); assert.ok(geometry.control.height >= 44);
    await page.screenshot({ path: resolve(out, 'inline-image-mobile.png') });
    await dialog.getByRole('button', { name: 'Close image', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.chatFixture.rich());
    const diagram = chat.locator('[data-row=rich] [data-testid=mermaid-block]').first();
    await diagram.scrollIntoViewIfNeeded(); await diagram.locator('[aria-label="Expand Mermaid diagram"]').waitFor({ timeout: 25000 });
    const url = await diagram.locator('img').getAttribute('src'); await diagram.getByRole('button', { name: 'Expand Mermaid diagram', exact: true }).click();
    dialog = chat.getByRole('dialog', { name: 'Mermaid diagram', exact: true });
    assert.equal(await dialog.locator('img').getAttribute('src'), url, 'Expanded diagram reuses its completed inert SVG');
    await dialog.getByRole('button', { name: 'Zoom image in', exact: true }).click(); await dialog.getByText('125%', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(out, 'diagram-expanded.png') }); await page.keyboard.press('Escape');
    cases.push('Local Markdown thumbnails use the verified capture owner, remote images stay links, and completed Mermaid expands in the same scoped viewer without rendering or reading again; 320px controls remain visible');
    if (archive) {
      await page.evaluate(() => window.chatFixture.documents());
      await chat.locator('[data-row=local-documents]').getByRole('button', { name: 'Guide', exact: true }).click();
      const documentDialog = chat.locator('.mpx-chat__file-dialog');
      await documentDialog.getByRole('heading', { name: 'Captured guide', exact: true }).waitFor();
      await documentDialog.getByRole('button', { name: 'Expand Local picture', exact: true }).waitFor();
      const current = await page.evaluate(() => window.chatFixture.fileStats()); await page.evaluate(() => window.chatFixture.archiveVisualFixture());
      await chat.locator('[data-action=archive-status]').waitFor(); await frame(page);
      await documentDialog.waitFor({ state: 'detached' });
      assert.equal(await chat.locator('[data-row=media-visual-native] img').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.chatFixture.fileStats()), current);
      cases.push('Positive Archive facts unmount an already-loaded local-file dialog and retire native/local inline image access without a disk fallback or new acquisition');
    }
    const after = await page.evaluate(() => window.chatFixture.counts()); assert.equal(after.submitted, before.submitted); assert.equal(after.older, before.older); assert.equal(after.discovery, before.discovery);
  } finally {
    await history.evaluate(element => { element.style.removeProperty('display'); }).catch(() => {});
    await page.locator('#light-embed').evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); }, embed);
  }
}
