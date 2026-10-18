import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../../../tools/test-browser.mjs';

test('the laptop-shaped native lock draws every password dot in the same Outfit subset as the launch', async () => {
  const evidence = process.env.LOCK_FONT_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { window.__lockClock = 100; window.__lockWall = 1760083230; });
    const path = fileURLToPath(new URL('../../../../desktop/lock/index.html', import.meta.url));
    await page.goto(`file://${path}?world=dragon&bg=000000&ink=ffffff&epoch=1760083200.123`);
    await page.waitForFunction(() => (window.__lockSaid || []).includes('ready') || window.__lockError, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__lockError ?? null), null);
    const look = await page.evaluate(async () => {
      // The keeper passes only a count, never the password; show a synthetic count for glyph evidence.
      window.lock.key(5);
      for (let i = 0; i < 120 && window.__lock().phase !== 'box'; i++) {
        window.__lockClock += 0.25; window.__lockWall += 0.25;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (window.__lock().phase !== 'box') throw new Error('native password phase did not arrive');
      await document.fonts.load('400 24px Outfit');
      await document.fonts.ready;
      const style = getComputedStyle(document.getElementById('dots'));
      return { family: style.fontFamily, loaded: document.fonts.check('400 24px Outfit'), count: document.querySelectorAll('#dots i').length, faces: [...document.fonts].map(f => `${f.family} ${f.weight} ${f.status}`) };
    });
    assert.match(look.family, /Outfit/);
    assert.equal(look.loaded, true);
    assert.equal(look.count, 5);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#dots i' });
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    const pseudo = node.pseudoElements?.find(n => n.pseudoType === 'before');
    assert.ok(pseudo, 'the actual bullet pseudo-element exists');
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: pseudo.nodeId });
    assert.ok(fonts.length > 0);
    assert.ok(fonts.every(f => f.isCustomFont && f.postScriptName === 'Outfit-Regular'), JSON.stringify(fonts));
    if (evidence) {
      await writeFile(`${evidence}/font.json`, JSON.stringify({ look, fonts }, null, 2));
      await page.screenshot({ path: `${evidence}/native-lock-outfit.png` });
    }
  } finally { await browser.close(); }
});
