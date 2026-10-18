import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

// One browser, serial fixtures, fake snapshots only: never prompt a live agent.
test('original harness marks precede the model on both surfaces and themes', { timeout: 120000 }, async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const theme of ['black', 'light-chalk']) for (const phone of [false, true]) {
      const f = await harnessFixture({ browser, desk: !phone, hasTouch: phone,
        viewport: phone ? { width: 412, height: 915 } : { width: 1200, height: 900 },
        themeCSS: themeCss(await testTheme(theme)),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready.' }] }] });
      const page = f.page, label = page.locator('#entry-pi-label');
      try {
        if (phone) await page.evaluate(() => { globalThis.imperfectNative = {}; });
        for (const agent of ['pi', 'claude']) for (const working of [false, true]) {
          const name = agent === 'claude' ? 'Opus 5.5' : 'GPT-6 Astra';
          const next = { ...f.tab, agent, busy: working, operation: undefined,
            billing: agent === 'claude' ? 'Claude subscription' : 'API key',
            model: agent === 'claude' ? { id: 'claude-opus-5-5' } : { id: 'gpt-6-astra', name },
            tabs: [{ ...f.tab.tabs[0], agent, status: working ? 'working' : 'idle' }] };
          f.push(next);
          await page.waitForFunction(({ agent, working, name }) => {
            const button = document.querySelector('#entry-pi-label'), svg = button.firstElementChild;
            return svg.dataset.agent === agent && svg.classList.contains('mark-working') === working
              && button.textContent === name;
          }, { agent, working, name });
          assert.equal(await label.textContent(), name);
          assert.doesNotMatch(await label.getAttribute('title'), /subscription|API|billing/i);
          assert.equal(await label.locator('img').count(), 0);
          assert.equal(await label.locator('svg').getAttribute('aria-hidden'), 'true');
          // The session's row carries the same mark, as the Mac's sidebar does.
          assert.equal(await page.locator('#session-rail .session-rail-item[data-tab-id] .session-rail-logo').first().getAttribute('data-agent'), agent);
          const geometry = await label.evaluate(button => {
            const mark = button.querySelector('svg').getBoundingClientRect();
            const text = button.querySelector('.entry-model-name').getBoundingClientRect();
            return { width: getComputedStyle(button.querySelector('svg')).width, gap: text.x - mark.right, visible: text.width > 0,
              paths: button.querySelectorAll('path').length };
          });
          assert.equal(geometry.width, '16px');
          assert.ok(geometry.gap > 0 && geometry.visible, `${theme}/${phone}/${agent}: logo then model`);
          assert.equal(geometry.paths, agent === 'pi' ? 3 : working ? 5 : 1);
          const names = await label.locator('path').evaluateAll(paths => paths.map(p => getComputedStyle(p).animationName));
          assert.equal(names.some(n => n !== 'none'), working);
          if (working) {
            const animations = await label.locator('svg').evaluate(svg => {
              const before = [...svg.querySelectorAll('path')].map(p => getComputedStyle(p).transform);
              const animations = svg.getAnimations({ subtree: true });
              for (const a of animations) { a.pause(); a.currentTime = 120; }
              const a = [...svg.querySelectorAll('path')].map(p => getComputedStyle(p).transform);
              for (const animation of animations) animation.currentTime = 260;
              const b = [...svg.querySelectorAll('path')].map(p => getComputedStyle(p).transform);
              for (const animation of animations) animation.play();
              return { before, a, b };
            });
            assert.notDeepEqual(animations.a, animations.b, `${agent} actually moves`);
            // Repeated snapshots must not restart the CSS animation.
            await label.locator('svg').evaluate(svg => { svg.dataset.retained = 'yes'; });
            f.push({ ...next });
            await page.waitForTimeout(50);
            assert.equal(await label.locator('svg').getAttribute('data-retained'), 'yes');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            assert.ok((await label.locator('path').evaluateAll(paths => paths.map(p => getComputedStyle(p).animationName))).every(n => n === 'none'));
            assert.ok((await label.locator('path').evaluateAll(paths => paths.map(p => getComputedStyle(p).opacity))).every(o => o === '1'));
            await page.emulateMedia({ reducedMotion: 'no-preference' });
          }
        }
        // Marks show in the sidebar and the phone's strip alike, nothing to unfold.
        await page.locator('.session-rail-logo').first().waitFor();
        assert.ok((await page.locator('.session-rail-logo').evaluateAll(marks => marks.map(mark => getComputedStyle(mark).width))).every(width => width === '16px'));
        f.push({ ...f.tab, agent: 'pi', busy: false, operation: 'compacting' });
        await page.waitForFunction(() => document.querySelector('#entry-pi-label svg').classList.contains('mark-working'));
        assert.deepEqual(f.errors, []);
        assert.equal(f.commands.some(c => c.type === 'prompt'), false);
      } finally { await f.close(); }
    }
  } finally { await browser.close(); }
});
