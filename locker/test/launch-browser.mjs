// The launch, in imperfect's own browser, one page at a time. Real locker + private fixture lock;
// the child is explicitly a transport fixture, never claimed as proof of a signed-in live VM.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { launchChromium } from '../../tools/test-browser.mjs';
import { createLockerServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { command, createSiteLocks, readTicket } from '../site-locks.mjs';
import { STEPS, INTRO } from '../../website/mac/desktop.mjs';
import { WORD } from '../../website/wordmark.mjs';
import { goatTimes } from '../../website/intro/goat.mjs';
const evidence = resolve(process.argv[2] || '/tmp/imperfect-launch-browser');
await mkdir(evidence, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'website-mac-'));
const credentials = join(privateDir, 'credentials');
const files = { file: join(credentials, 'site-locks.json'), doorFile: join(credentials, 'site-door-secret'), credentials, out() {} };
let childMode = 'ready', tickets = [], requests = [], appOrigin;
const child = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/mac/')) {
    if (!/^\/mac\/(?:app\/[a-z-]+\.css|browser-page\.webp)$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', url.pathname.endsWith('.css') ? 'text/css' : 'image/webp');
    res.end(await readFile(new URL('../../website' + url.pathname, import.meta.url))); return;
  }
  requests.push(req.url.split('?')[0]);
  if (url.pathname === '/door/ticket') {
    const ticket = readTicket(url.searchParams.get('t'), await readFile(files.doorFile));
    tickets.push({ valid: Boolean(ticket), id: ticket?.id });
    if (ticket?.id !== 'noah') { res.writeHead(403); res.end('Fixture door refused'); return; }
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (childMode === 'offline') { res.writeHead(503); res.end('<h1>Fixture failure MUST NEVER BE VISIBLE</h1>'); return; }
  // Product-shaped isolated transport fixture, with no VM state.
  let html = await readFile(new URL('../../website/mac/app.html', import.meta.url), 'utf8');
  html = html.replace('<head>', '<head><base href="/mac/">').replace('class="is-1"', 'class="is-1 s-harness s-files s-browser s-messages s-memory s-make s-undo s-everywhere s-live"');
  res.end(html.replace('</body>', `<script>
    document.querySelectorAll('video').forEach(v=>v.remove());
    document.querySelectorAll('.agent-choose-option').forEach(b=>b.onclick=()=>{
      document.querySelector('#entry-terminal').classList.remove('choosing');
      document.querySelector('.agent-choose').remove();
      const output=document.querySelector('#entry-output');
      output.classList.add('gui-transcript');
      output.style.setProperty('padding', '58px 24px 110px', 'important');
      document.querySelector('#entry-input').focus();
    });
    document.querySelector('#entry-input').onkeydown=e=>{if(e.key==='Enter'){
      const p=document.createElement('article');p.className='gui-message gui-user';
      const prompt=document.createElement('div');prompt.className='gui-prompt';prompt.textContent=e.target.value;p.append(prompt);
      p.id='fixture-sent';document.querySelector('#entry-output').append(p);e.target.value='';e.preventDefault();
    }};
    ${childMode === 'manual' ? '' : `setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({type:'imperfect:demo-ready'},${JSON.stringify(appOrigin)}))),300);`}
    </script></body>`));
});
await new Promise(ok => child.listen(0, '127.0.0.1', ok));
const childOrigin = `http://127.0.0.1:${child.address().port}`;
await command(['door-secret'], files);
await command(['replace', 'noah', 'noah', childOrigin, '--ticket'], files);
const store = openStore();
const locks = createSiteLocks({ ...files, secure: false, log: { error() {} } });
const app = await createLockerServer({ store, mail: { configured: false }, config: { secure: false, hosts: '127.0.0.1' }, siteLocks: locks, port: 0, log: { info() {}, warn() {}, error() {} } });
const address = await app.listen(); appOrigin = `http://127.0.0.1:${address.port}`;
console.log('Isolated locker:', appOrigin);
const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
let page, passes = 0, pageErrors = [], labelNow, drops = [], shots = [], lastWindow;
let restingPixels;
const windowPixels = () => page.locator('.mac-window').screenshot({ caret: 'hide', animations: 'disabled' });
const state = () => page.evaluate(() => window.__launch());
const shot = name => page.screenshot({ path: join(evidence, name + '.png') });
async function clock(t) {
  await page.evaluate(t => { window.__introClock = t; }, t);
  await page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))));
}
async function open({ phone = false, reduced = false } = {}) {
  await page?.close(); requests = []; tickets = []; pageErrors = []; drops = []; shots = []; restingPixels = null;
  while (loadavg()[0] >= 5) await new Promise(ok => setTimeout(ok, 10000));
  console.log('PAGE', phone ? '390x844' : '1440x900', 'load1', loadavg()[0]);
  page = await browser.newPage({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: phone, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGE ERROR', e.message); });
  await page.exposeFunction('captureDrop', async detail => {
    const win = await page.locator('.mac-window').boundingBox();
    assert.ok(detail.x > win.x && detail.x < win.x + win.width && detail.y > win.y && detail.y < win.y + win.height, 'drop goes inside the window');
    drops.push(detail.name);
    const p = shot(`${labelNow}-drag-${detail.name}`); shots.push(p); await p;
  });
  await page.addInitScript(() => {
    addEventListener('imperfect:drop', e => window.captureDrop(e.detail));
    window.__introClock = 100;
    window.__phases = []; window.__voices = [];
    addEventListener('imperfect:sequence', e => window.__phases.push(e.detail.phase));
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      if (this.src.includes('/line-')) {
        const entry = { src: this.src.split('/').at(-1), muted: this.muted, at: performance.now() };
        window.__voices.push(entry);
        // Capture runs before the player's completion listener/microtask starts the next line.
        if (!this.muted) this.addEventListener('ended', () => { entry.endedAt = performance.now(); }, { once: true, capture: true });
      }
      return play.call(this);
    };
  });
  await page.goto(appOrigin);
  await page.waitForFunction(() => window.__launch?.().phase === 'intro');
}
async function opener(label) {
  assert.equal((await state()).lock.shown, false, 'the opener, NOT the lock, is first');
  assert.equal(requests.length, 0, 'no computer before password');
  await shot(label + '-00-opener');
  const viewport = page.viewportSize();
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.evaluate(() => { window.__wheels = []; addEventListener('wheel', e => window.__wheels.push([e.deltaY, e.cancelable, e.target.id])); });
  for (let i = 0; i < 6 && (await state()).intro.scrolled === 0; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(100); await clock(100.1 + i * .01); }
  console.log('SCROLL', JSON.stringify(await page.evaluate(() => ({ scrolled: window.__launch().intro.scrolled, wheels: window.__wheels }))));
  assert.ok((await state()).intro.scrolled > 0, 'real wheel brings them together');
  await page.mouse.wheel(0, -30); await clock(100.2);
  await page.keyboard.press('ArrowDown');
  for (let i = 1; i < 80 && (await state()).intro.phase === 'scene'; i++) await clock(100.2 + i * .2);
  const contact = (await state()).intro.soundAt;
  assert.ok(contact !== null);
  await clock(contact + WORD.gone - .8); await shot(label + '-01-wordmark');
  await clock(contact + goatTimes().whole + .2); await shot(label + '-02-goat');
  await clock(contact + goatTimes().gone + .5);
  await page.waitForFunction(() => window.__launch().phase === 'ready');
  await shot(label + '-03-lock');
  await page.locator('#password').fill('wrong'); await page.locator('#password').press('Enter');
  await page.waitForFunction(() => document.querySelector('#lock').dataset.state === 'wrong');
  assert.equal((await state()).videoTime, 0); assert.equal(requests.length, 0);
  await page.waitForFunction(() => document.querySelector('#lock').dataset.state === 'idle');
  await page.locator('#password').fill('noah'); await page.locator('#password').press('Enter');
  await page.waitForFunction(() => ['film', 'film-blocked'].includes(window.__launch().phase));
  if ((await state()).phase === 'film-blocked') await page.click('#action');
  await page.waitForFunction(() => window.__launch().phase === 'film');
  // Seek the real trailer (including a real buffered preload), do not dispatch a synthetic ended event.
  await page.evaluate(() => { document.querySelector('#film').currentTime = 12; });
  await page.waitForFunction(() => window.__launch().demoPreloadAt !== null);
  await page.waitForTimeout(350); await shot(label + '-04-trailer');
  if (childMode === 'ready') {
    await page.waitForFunction(() => window.__launch().demoVerified);
    assert.equal((await state()).mac.hosted, false, 'a ready frame never interrupts the film or early build');
    assert.equal(await page.locator('#demoScreen').getAttribute('aria-hidden'), 'true');
  }
  await page.evaluate(() => { const v = document.querySelector('#film'); v.currentTime = v.duration - .5; });
  await page.waitForFunction(() => window.__launch().phase === 'mac');
}
async function build(label) {
  await page.waitForFunction(() => window.__launch().mac.revealed);
  await page.waitForTimeout(1700); await page.mouse.move(4, 4); await shot(label + '-05-plain');
  lastWindow = await page.locator('.mac-window').boundingBox();
  const viewport = frame => frame.locator('html').evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual(await viewport(page.frameLocator('iframe[title="Your own app"]')), await viewport(page.frameLocator('#computer')), 'static and real documents have the same native viewport from the start');
  const snapshots = [];
  for (const [i, step] of STEPS.entries()) {
    await page.waitForFunction(part => window.__launch().mac.built.includes(part), step.build, { timeout: 35000 });
    await page.waitForTimeout(1000); await shot(`${label}-${String(i + 6).padStart(2, '0')}-${step.build}`);
    const s = (await state()).mac;
    snapshots.push(s);
    assert.equal(s.step, i);
    assert.deepEqual(await page.locator('.mac-window').boundingBox(), lastWindow, 'the window never moves or grows');
    if (page.viewportSize().width <= 600 && i < 4) {
      const caption = await page.locator('.mac-line').boundingBox(), win = await page.locator('.mac-window').boundingBox();
      assert.ok(caption.y >= win.y + win.height + 8, 'phone captions never cover the miniature app');
      assert.ok(await page.locator('.mac-line').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    }
    for (const app of step.apps) assert.ok(s.absorbed.includes(app), app + ' folded into the window');
    if (page.viewportSize().width <= 600 && i >= 4 && i < 8) {
      const panel = page.frameLocator('iframe[title="Your own app"]').locator('.stage-conversation:visible');
      assert.ok((await panel.boundingBox()).width > lastWindow.width * .85, 'phone conversations use the window, never a leftover desktop sidebar column');
    }
    if (step.build === 's-live') {
      assert.equal(s.hosted, true, 'the final narrated build part is the actual ready document');
      assert.equal(s.live, false, 'still inert while the voice speaks');
      assert.equal(await page.locator('#demoScreen').evaluate(el => el.inert), true);
      await page.waitForTimeout(2000);
      await shot(label + '-last-resting-frame');
      restingPixels = await windowPixels();
      await writeFile(join(evidence, label + '-last-resting-window.png'), restingPixels);
    }
    if (step.build === 's-undo' && !(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches))) {
      await page.waitForTimeout(4200);
      await shot(label + '-12-s-undo-after');
      const preview = page.frameLocator('iframe[title="Your own app"]').locator('.stage-theme-preview');
      assert.notEqual(await preview.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'the light change is actually undone');
    }
    if (step.build === 's-make') {
      const film = page.frameLocator('iframe[title="Your own app"]').locator('video');
      assert.equal(await film.count(), 1);
      assert.ok(await film.evaluate(v => !v.paused && v.currentTime > 0), 'film really plays in the chat');
    }
  }
  await page.waitForFunction(() => window.__launch().mac.finished, null, { timeout: 35000 });
  await Promise.all(shots);
  assert.deepEqual(drops, STEPS.flatMap(s => s.apps));
  assert.equal(await page.locator('.mac-menus a').textContent(), 'Shop');
  assert.equal(await page.locator('.mac-menus a').getAttribute('href'), '/buy');
  const bar = await page.locator('.mac-bar').boundingBox();
  const win = await page.locator('.mac-window').boundingBox();
  assert.ok(win.y >= bar.height && win.width < page.viewportSize().width && win.height < page.viewportSize().height - bar.height, 'desktop remains around the app');
  assert.deepEqual(win, lastWindow);
  assert.equal(await page.locator('.mac-dock').evaluate(el => getComputedStyle(el).opacity), '1');
  await writeFile(join(evidence, label + '-states.json'), JSON.stringify(snapshots, null, 2));
}
try {
  for (const [label, options] of [['desktop', {}], ['phone', { phone: true }], ['phone-reduced', { phone: true, reduced: true }]]) {
    if (process.env.ONLY && !label.includes(process.env.ONLY)) continue;
    childMode = 'ready'; labelNow = label; await open(options); await opener(label); await build(label);
    await page.waitForFunction(() => window.__launch().phase === 'demo');
    assert.equal((await state()).mac.live, true);
    assert.ok(tickets.length > 0 && tickets.every(t => t.valid && t.id === 'noah'));
    await shot(label + '-first-live-frame');
    const interactivePixels = await windowPixels();
    await writeFile(join(evidence, label + '-first-live-window.png'), interactivePixels);
    assert.ok(interactivePixels.equals(restingPixels), 'last inert and first interactive window are pixel-identical');
    const live = page.frameLocator('#computer');
    await live.locator('.agent-choose-option').first().click();
    await live.locator('#entry-input').fill('The app is usable'); await live.locator('#entry-input').press('Enter');
    assert.equal(await live.locator('#fixture-sent').textContent(), 'The app is usable');
    assert.equal(await page.locator('#demoScreen').evaluate(el => getComputedStyle(el).opacity), '1');
    await shot(label + '-15-live');
    const voices = await page.evaluate(() => window.__voices.filter(v => !v.muted));
    await writeFile(join(evidence, label + '-voices.json'), JSON.stringify(voices, null, 2));
    assert.deepEqual([...new Set(voices.map(v => v.src))], [INTRO, ...STEPS].map(s => s.voice.split('/').at(-1)));
    assert.ok(voices.every(v => v.endedAt > v.at), 'every spoken line actually finished');
    for (let i = 1; i < voices.length; i++) assert.ok(voices[i].at >= voices[i - 1].endedAt, `voices never overlap or truncate: ${JSON.stringify([voices[i - 1], voices[i]])}`);
    assert.deepEqual(pageErrors, []);
    passes++; console.log('PASS', label + ': full order, wrong lock, voiced build, fresh ticket, usable frame, menu bar');
  }
  if (!process.env.ONLY || process.env.ONLY === 'offline') {
  childMode = 'offline'; await open({ reduced: true });
  // Accessible skip still requires the single lock and uses the same verified Mac ending.
  await page.evaluate(() => document.querySelector('#skip').click());
  await page.waitForFunction(() => window.__launch().phase === 'ready');
  await page.locator('#password').fill('noah'); await page.locator('#password').press('Enter');
  await page.waitForFunction(() => window.__launch().mac.finished);
  await page.waitForTimeout(1000);
  assert.equal((await state()).mac.live, false);
  assert.equal(await page.locator('#demoScreen').getAttribute('aria-hidden'), 'true');
  assert.ok(await page.locator('.mac-offline').isVisible());
  await shot('offline-preview');
  // A forged parent-source message cannot reveal an error document.
  await page.evaluate(() => postMessage({ type: 'imperfect:demo-ready' }, '*'));
  assert.equal((await state()).demoVerified, false);
  childMode = 'ready'; await page.locator('#macRetry').click();
  await page.waitForFunction(() => window.__launch().phase === 'demo');
  await shot('offline-recovered');
  assert.deepEqual(pageErrors, []);
  passes++; console.log('PASS offline: hidden error, quiet preview, forged handshake refused, Retry recovers');
  }
  if (!process.env.ONLY || process.env.ONLY === 'late') {
    childMode = 'manual'; await open();
    await page.evaluate(() => document.querySelector('#skip').click());
    await page.waitForFunction(() => window.__launch().phase === 'ready');
    await page.locator('#password').fill('noah'); await page.locator('#password').press('Enter');
    await page.waitForFunction(() => window.__launch().mac.finished);
    assert.equal((await state()).mac.hosted, false);
    await page.frameLocator('#computer').locator('body').evaluate(() => parent.postMessage({ type: 'imperfect:demo-ready' }, '*'));
    await page.waitForFunction(() => window.__launch().phase === 'demo');
    await shot('late-ready-in-place');
    await page.frameLocator('#computer').locator('body').evaluate(() => { location.href = '/elsewhere'; });
    await page.waitForFunction(() => !window.__launch().demoVerified);
    assert.equal((await state()).mac.live, false, 'a later unverified document falls back to the preview');
    assert.equal(await page.locator('#demoScreen').getAttribute('aria-hidden'), 'true');
    assert.deepEqual(pageErrors, []);
    passes++; console.log('PASS late readiness: same window; a later document must earn its own handshake');
  }
  // A short repeatable interaction-only check also captures submitted content,
  // independent of the narrated sequence (and never against the real computer).
  if (process.env.ONLY === 'interaction') {
    for (const [label, phone] of [['desktop', false], ['phone', true], ['phone-reduced', true]]) {
      childMode = 'ready'; await open({ phone, reduced: true });
      await page.evaluate(() => document.querySelector('#skip').click());
      await page.waitForFunction(() => window.__launch().phase === 'ready');
      await page.locator('#password').fill('noah'); await page.locator('#password').press('Enter');
      await page.waitForFunction(() => window.__launch().phase === 'demo');
      const live = page.frameLocator('#computer');
      await live.locator('.agent-choose-option').first().click();
      await live.locator('#entry-input').fill('The app is usable'); await live.locator('#entry-input').press('Enter');
      assert.equal(await live.locator('#fixture-sent').textContent(), 'The app is usable');
      await live.locator('#entry-input').fill('Typing in the same window');
      await shot(label + '-15-live');
      assert.deepEqual(pageErrors, []);
      passes++; console.log('PASS', label, 'fixture interaction and submitted conversation');
    }
  }
  console.log(`${passes} browser scenarios passed`);
} finally {
  await page?.close(); await browser.close(); await app.close(); store.close();
  await new Promise(ok => child.close(ok)); await rm(privateDir, { recursive: true, force: true });
}
