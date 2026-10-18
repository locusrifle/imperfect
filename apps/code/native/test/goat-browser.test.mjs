import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve, fixture } from '../../tools/gui-preview.mjs';

for (const width of [390, 1200]) test(`${width}: session tabs use ordered Roman numerals; unfolded sessions wear their harness marks`, async () => {
  const { server, sockets, port } = await serve('');
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width, height: 850 }, hasTouch: width < 500 });
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.locator('.session-rail-number').first().waitFor();
    await page.locator('#entry-input').fill('preserve draft');
    const data = fixture();
    data.tabs = Array.from({ length: 12 }, (_, i) => ({ ...data.tabs[0], id: i ? `tab-${i}` : 'mirror', sessionId: i ? `tab-${i}` : 'mirror', focused: i === 0, agent: i % 2 ? 'claude' : 'pi', status: i < 2 ? 'working' : 'idle', prompt: `Session ${i + 1}` }));
    for (const socket of sockets.clients) socket.send(JSON.stringify({ type: 'snapshot', data }));
    await page.waitForFunction(() => document.querySelectorAll('.session-rail-number').length === 12);
    const expected = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
    assert.deepEqual(await page.locator('.session-rail-number').allTextContents(), expected);
    assert.equal(await page.locator('#session-rail.collapsed .goat').count(), 0);
    assert.equal(await page.locator('.session-rail-item.active .session-rail-number').textContent(), 'I');
    assert.equal(await page.locator('.session-rail-number').first().getAttribute('aria-hidden'), 'true');
    assert.match(await page.locator('.session-rail-item[data-tab-id] .session-rail-agent').first().getAttribute('aria-label'), /working/);
    data.tabs[0].status = 'idle';
    for (const socket of sockets.clients) socket.send(JSON.stringify({ type: 'snapshot', data }));
    await page.waitForFunction(() => document.querySelector('.session-rail-item[data-tab-id="mirror"]').dataset.state === 'idle');
    assert.deepEqual(await page.locator('.session-rail-number').allTextContents(), expected, 'status changes never renumber');
    await page.screenshot({ path: `/tmp/roman-tabs-${width}.png` });
    await page.getByRole('button', { name: 'show the agents', exact: true }).click();
    assert.equal(await page.locator('#session-rail:not(.collapsed) .goat').count(), 0, 'the picker has no goat marks');
    assert.equal(await page.locator('#session-rail .session-rail-logo[data-agent="pi"]').count(), 6);
    assert.equal(await page.locator('#session-rail .session-rail-logo[data-agent="claude"]').count(), 6);
    assert.equal(await page.locator('#session-rail .mark-working').count(), 1, 'only the working Claude session animates after Pi goes idle');
    assert.equal(await page.locator('#session-rail .mark-working.mark-star').count(), 1, "Claude's starburst, not the crab, in its session's row");
    // The working starburst stays still (Noah): the row's spinner says it works.
    for (const mark of await page.locator('#session-rail .session-rail-logo').all()) {
      const bounds = await mark.boundingBox();
      assert.equal(bounds.width, 16); assert.equal(bounds.height, 16);
    }
    assert.equal(await page.locator('#session-rail .mark-working').evaluate(n => getComputedStyle(n).animationName), 'none');
    await page.getByRole('button', { name: 'collapse the agents', exact: true }).click();
    assert.deepEqual(await page.locator('.session-rail-number').allTextContents(), expected);
    assert.equal(await page.locator('#entry-input').inputValue(), 'preserve draft');
  } finally {
    await browser.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
