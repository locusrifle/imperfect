// The actual product document, embedded at its real origin behind an isolated
// transport fixture. No production ticket, computer, credentials or runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, readBody, PNG } from './fixtures/harness-page.mjs';

const HARNESSES = [{ agent: 'pi', ready: true }, { agent: 'claude', ready: true }, { agent: 'codex', ready: true }];
const mutatesSession = command => /^(tab-(?:new|focus|open|close)|session-attach|prompt|set-model)$/.test(command.type);
async function launchFixture({ hasTouch = false } = {}) {
  const browserCalls = [], filesCalls = [], watchers = new Set();
  let tabs = [{ tab: 4, title: 'Other', url: 'https://example.test', front: true }];
  const send = ws => {
    const tab = tabs.find(tab => tab.front);
    ws.send(JSON.stringify({ tabs }));
    if (tab) ws.send(JSON.stringify({ frame: PNG.toString('base64'), width: 1, height: 1, tab: tab.tab }));
  };
  const f = await harnessFixture({ launchFrame: true, hasTouch, messages: [{ role: 'assistant', content: 'Existing private session' }],
    machines: [{ id: 'vm', name: 'Noah', self: true, hosted: true, home: true, reachable: true }], snapshot: { harnesses: HARNESSES },
    handleRequest: async (req, res, path) => {
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (path === '/files/list') { filesCalls.push(req.url); json({ path: '/home/noah', home: '/home/noah', entries: [{ name: 'Downloads', path: '/home/noah/Downloads', dir: true, size: 0, mtime: 1 }] }); return true; }
      if (path !== '/browser') return false;
      const request = await readBody(req); browserCalls.push(request);
      if (request.do === 'tabs') json({ tabs });
      else if (request.do === 'open') { const tab = { tab: 5, url: request.url, title: 'Google', front: false }; tabs.push(tab); json(tab); }
      else if (request.do === 'front') { tabs = tabs.map(tab => ({ ...tab, front: tab.tab === request.tab })); json({ tab: request.tab }); }
      else { res.statusCode = 400; json({ error: 'unexpected browser command' }); }
      for (const ws of watchers) send(ws);
      return true;
    },
    onBrowserLive: ws => { watchers.add(ws); ws.on('close', () => watchers.delete(ws)); ws.on('message', raw => { const request = JSON.parse(raw); if (request.do === 'watch') send(ws); }); },
  });
  return Object.assign(f, { browserCalls, filesCalls });
}
async function step(f, step) {
  await f.page.evaluate(step => document.querySelector('iframe').contentWindow.postMessage({ type: 'imperfect:assemble', step }, 'https://noah.imperfect.computer'), step);
  await f.page.waitForFunction(step => messages.some(message => message.type === 'imperfect:assembled' && message.step === step), step);
}

test('the real framed chooser assembles monotonically without touching existing session state', async () => {
  const f = await launchFixture(); const { product, page } = f;
  try {
    assert.equal(await product.locator('html').getAttribute('data-assembly-step'), 'bare');
    assert.deepEqual(await product.locator('.agent-choose-title').allTextContents(), ['pick a computer', 'pick a harness']);
    assert.equal(await product.locator('[data-computer="local"]').isDisabled(), true);
    assert.equal(await product.locator('[data-computer="cloud"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await product.locator('.agent-choose-harness').allTextContents(), ['Pi']);
    assert.equal(await product.locator('#session-rail').isVisible(), false);
    assert.equal(await product.locator('.wm-files').isVisible(), false);
    assert.equal(await product.locator('canvas.kept-sky').count(), 0);
    assert.equal(f.commands.some(mutatesSession), false);
    assert.equal(f.browserCalls.length, 0, 'bare does not open or navigate the browser');
    await page.waitForFunction(() => messages.some(message => message.type === 'imperfect:demo-ready'));
    for (const [stepName, agents] of [['bare', ['pi']], ['claude', ['claude', 'pi']], ['codex', ['codex', 'claude', 'pi']]]) {
      await step(f, stepName);
      assert.deepEqual(await product.locator('.agent-choose-harness').evaluateAll(nodes => nodes.map(node => node.dataset.agent)), agents);
    }
    await step(f, 'files');
    assert.equal(await product.locator('#session-rail').isVisible(), true);
    await product.locator('.wm-files .workbench-item').first().waitFor();
    assert.ok(f.filesCalls.some(path => path === '/files/list?path='));
    assert.equal(await product.locator('.wm-files').isVisible(), true);
    await step(f, 'browser');
    await product.locator('.wm-live .browser-live-frame').waitFor();
    await page.waitForFunction(() => true);
    await product.waitForFunction(() => document.querySelector('.wm-live .gui-window-address')?.value === 'https://www.google.com');
    assert.deepEqual(f.browserCalls, [{ do: 'tabs' }, { do: 'open', url: 'https://www.google.com' }, { do: 'front', tab: 5 }]);
    await step(f, 'done');
    await step(f, 'done');
    assert.equal(f.browserCalls.length, 3, 'duplicate done does not reopen the browser');
    assert.equal(await product.locator('.agent-choose').isVisible(), true, 'done retains the new-session page');
    assert.equal(await product.locator('.agent-choose-hint').count(), 0);
    assert.equal(f.commands.some(mutatesSession), false);
    // Already-existing/background sessions cannot displace the client chooser.
    f.push({ ...f.tab, tabs: [...f.tab.tabs, { id: 'background', agent: 'claude', name: 'Background' }] });
    await product.locator('.agent-choose').waitFor();
    assert.equal(f.commands.some(mutatesSession), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a snapshot redraw detaches old chooser handles, not the live assembled options', async () => {
  const f = await launchFixture();
  try {
    await step(f, 'codex');
    const old = await f.product.evaluateHandle(() => [...document.querySelectorAll('.agent-choose button[data-agent]')]);
    try {
      assert.equal(await old.evaluate(nodes => nodes.length), 3);
      f.push({ ...f.tab });
      await f.product.waitForFunction(nodes => nodes.every(node => !node.isConnected), old, { timeout: 2000 });
      assert.equal(await old.evaluate(nodes => nodes.every(node => node.getBoundingClientRect().width === 0)), true, 'stale handle geometry would falsely report no options');
      const connected = await f.product.evaluate(() => [...document.querySelectorAll('.agent-choose button[data-agent]')]
        .filter(node => node.isConnected && node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden')
        .map(node => node.dataset.agent).sort());
      assert.deepEqual(connected, ['claude', 'codex', 'pi'], 'one atomic live-DOM read sees every actual option');
      assert.equal(f.commands.some(mutatesSession), false);
    } finally { await old.dispose(); }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('skip is cumulative and a coarse pointer still gets the desktop product in the launch frame', async () => {
  const f = await launchFixture({ hasTouch: true });
  try {
    await step(f, 'done');
    assert.equal(await f.product.locator('#entry-terminal.focus-layout').count(), 1);
    assert.equal(await f.product.locator('#entry-terminal.phone-layout').count(), 0);
    assert.equal(await f.product.locator('.agent-choose-harness').count(), 3);
    assert.equal(await f.product.locator('.agent-choose-cancel').isVisible(), false, 'the frame uses desktop controls even on a coarse pointer');
    assert.equal(await f.product.locator('#session-rail').isVisible(), true);
    assert.equal(f.commands.some(mutatesSession), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the same authenticated launch surface can show an inert native phone chooser, not another session', async () => {
  const f = await launchFixture();
  try {
    await f.page.evaluate(() => {
      const frame = document.querySelector('iframe');
      Object.assign(frame.style, { width: '390px', height: '844px' });
      frame.src = 'https://noah.imperfect.computer/?face=code&launch=phone';
    });
    await f.product.waitForURL('**/?face=code&launch=phone');
    await f.product.locator('html.launch-phone #entry-terminal.phone-layout .agent-choose').waitFor();
    await step(f, 'done');
    assert.equal(await f.product.locator('html.launch-framed').count(), 0);
    assert.equal(await f.product.locator('#entry-terminal.focus-layout').count(), 0);
    assert.deepEqual(await f.product.locator('.agent-choose-title').allTextContents(), ['pick a computer', 'pick a harness']);
    assert.equal(await f.product.locator('[data-computer="cloud"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await f.product.locator('.agent-choose-harness').count(), 3);
    const rect = await f.product.locator('.agent-choose').evaluate(node => {
      const r = node.getBoundingClientRect(), root = getComputedStyle(document.documentElement);
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, safeTop: root.getPropertyValue('--safe-top').trim(), safeBottom: root.getPropertyValue('--safe-bottom').trim() };
    });
    assert.equal(rect.width, 390); assert.equal(rect.height, 844);
    assert.ok(rect.left >= 0 && rect.right <= 390 && rect.top >= 54 && rect.bottom <= 818, JSON.stringify(rect));
    assert.equal(rect.safeTop, '54px'); assert.equal(rect.safeBottom, '26px');
    assert.equal(f.browserCalls.length, 0, 'the phone does not open another Google tab');
    const hello = f.commands.filter(command => command.type === 'hello').at(-1);
    assert.equal(hello.kind, 'viewer'); assert.equal(hello.visible, false, 'a passive companion never takes the active person/browser role');
    f.send({ type: 'browse', machine: 'vm' }); f.send({ type: 'shown', target: 'https://www.google.com' });
    await f.product.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await f.product.locator('.wm-live').count(), 0, 'agent announcements cannot open a second stream behind the phone chooser');
    assert.equal(f.browserCalls.length, 0);
    assert.equal(f.commands.some(mutatesSession), false);
    f.push({ ...f.tab, tabs: [...f.tab.tabs, { id: 'ambient', agent: 'claude', name: 'Background' }] });
    await f.product.locator('.agent-choose').waitFor();
    assert.equal(f.commands.some(mutatesSession), false, 'ambient snapshots never focus or create a session');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('same-frame and wrong-origin messages cannot start assembly, and earlier steps never undo it', async () => {
  const f = await launchFixture();
  try {
    await f.product.evaluate(() => {
      window.postMessage({ type: 'imperfect:assemble', step: 'done' }, location.origin);
      dispatchEvent(new MessageEvent('message', { source: parent, origin: 'https://imperfect.computer.evil.test', data: { type: 'imperfect:assemble', step: 'done' } }));
    });
    await f.product.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await f.product.locator('html').getAttribute('data-assembly-step'), 'bare');
    await step(f, 'codex');
    await f.page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'imperfect:assemble', step: 'bare' }, 'https://noah.imperfect.computer'));
    assert.equal(await f.product.locator('html').getAttribute('data-assembly-step'), 'codex');
    assert.equal(f.browserCalls.length, 0);
    assert.equal(f.commands.some(mutatesSession), false);
  } finally { await f.close(); }
});
