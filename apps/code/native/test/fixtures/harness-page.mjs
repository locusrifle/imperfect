// The complete production harness on a real page on loopback, with a fake
// backend: no running service, credentials, runtime or agent is touched.
// Shared by the browser tests of the windows and the browser's tabs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../../tools/test-browser.mjs';
import { WEBSITE_SKY } from '../../../../../system/server.mjs';

export const readBody = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); };
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

// Where the desktop strip is. A person's MOD arrow moves it at once
// (windows.js), so there is nothing to wait for.
export const settled = (page, selector = '.canvas-strip') => page.evaluate(selector => document.querySelector(selector).scrollLeft, selector);

// The desktop window, as far as the page can tell: Electron's bridge
// (preload.cjs) and a <webview> that keeps its address and history, takes
// the keys, and is a page with an id once its first page is ready. What the
// window would send is the page's to call: browseFromWindow, tabFromWindow,
// keyFromWindow (a key heard inside a website).
export const FAKE_DESK = () => {
  const said = globalThis.deskSaid = [];
  globalThis.imperfectDesk = {
    close() {},
    onBrowse: fn => { globalThis.browseFromWindow = fn; },
    onTab: fn => { globalThis.tabFromWindow = fn; },
    onKey: fn => { globalThis.keyFromWindow = fn; },
    front: id => said.push(['front', id]),
  };
  // Chromium's <webview> is a plain element; this gives each one Electron's ways.
  const make = document.createElement.bind(document);
  let pages = 100;
  document.createElement = (tag, ...rest) => {
    const element = make(tag, ...rest);
    if (tag !== 'webview') return element;
    const id = ++pages;
    element.tabIndex = -1;
    setTimeout(() => element.dispatchEvent(new Event('dom-ready')));
    return Object.defineProperties(element, {
      src: { get() { return this.getAttribute('src'); }, set(url) { this.setAttribute('src', url); } },
      getWebContentsId: { value() { return id; } },
      canGoBack: { value() { return this.back > 0; } },
      canGoForward: { value() { return false; } },
      goBack: { value() { this.wentBack = true; } },
      goForward: { value() {} },
      reload: { value() { this.reloaded = (this.reloaded ?? 0) + 1; } },
    });
  };
};

// The harness mounted on index.html (without site.js). fixture.push(tab)
// sends a snapshot, fixture.send(message) anything else the computer tells
// its windows; fixture.answer(command) may answer a command (else {}).
// machines: the computers /machines.json lists (none, unless given).
// layout: the window's layout when a test is about the scrolling or dwindle
// layouts. Like a native desk, a browser starts in focus; layout is an explicit
// choice, legacyLayout an automatically saved reload from before browser focus.
export async function harnessFixture({ desk = false, messages, viewport = { width: 1200, height: 900 }, hasTouch = false, machines = [], handleRequest = async () => false, onBrowserLive = null, site = false, themeCSS = '', browser: suppliedBrowser = null, layout = null, legacyLayout = null, launchFrame = false, snapshot = {} }) {
  const root = new URL('../../public/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const index = site || launchFrame ? html : html.replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const base = { agent: 'pi', sessionId: 'thread-a', cwd: '/fixture', model: { provider: 'fixture', id: 'fixture' }, queue: { items: [] }, stats: {}, ui: {}, tabs: [{ id: 'tab-a', sessionId: 'thread-a', focused: true, agent: 'pi', name: 'A', prompt: 'make a game', status: 'idle' }] };
  const fixture = { tab: { ...base, busy: false, messages, ...snapshot }, machines, commands: [], added: [], holds: [], started: [], poster: PNG, imageRequests: [], answer: () => undefined };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://fixture').pathname;
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (await handleRequest(req, res, path)) return;
      if (path === '/theme.css') { res.setHeader('Content-Type', 'text/css'); res.end(themeCSS); return; }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(index + '<style>#harness-reach{display:none}#entry-terminal{height:650px!important}.entry-screen{height:450px;min-height:0}</style>'); return; }
      // The computer says where a thing named by its path or local address plays.
      if (path === '/shown/add' || path === '/shown/view') { const body = await readBody(req); const asked = body.target ?? body.path; fixture.added.push(asked); json({ ...(path === '/shown/view' ? { stream: false } : {}), url: /^https?:/.test(asked) ? asked : `http://${req.headers.host}/shown${asked}` }); return; }
      if (path === '/shown/preview') { json({ local: false }); return; }
      if (path.startsWith('/shown/')) { fixture.imageRequests.push(req.url); res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store'); res.end(fixture.poster); return; }
      // Projects (system/projects.mjs): started, and held while a tab shows one.
      if (path === '/projects/hold') { fixture.holds.push(await readBody(req)); json({ ok: true }); return; }
      const project = /^\/projects\/([^/]+)\/start$/.exec(path);
      if (project) { fixture.started.push(project[1]); json({ url: `http://${req.headers.host}/shown/projects/${project[1]}/index.html` }); return; }
      if (path.endsWith('.json')) { json(path.includes('usage') ? { providers: [], machines: [] } : { machines: fixture.machines }); return; }
      res.setHeader('Content-Type', /\.m?js$/.test(path) ? 'text/javascript' : 'text/css');
      // the website's sky, as the server answers it (system/server.mjs WEBSITE_SKY), and nothing else of it
      const sky = /^(?:\/b\/[^/]+)?\/website\/(.+)$/.exec(path)?.[1];
      if (sky) { if (!WEBSITE_SKY.includes(sky)) throw new Error('not served'); res.end(await readFile(new URL(`../../../../../website/${sky}`, import.meta.url))); return; }
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode = 404; res.end(); }
  });
  // fixture.mute() silences the sockets open now, as a network dying under
  // them does; while fixture.refuse is set, new ones are turned away. An
  // answer may be a promise, for one that comes late.
  const wss = new WebSocketServer({ server, verifyClient: () => !fixture.refuse });
  const muted = new WeakSet();
  fixture.mute = () => { for (const ws of wss.clients) muted.add(ws); };
  fixture.send = message => { for (const ws of wss.clients) if (!muted.has(ws)) ws.send(JSON.stringify(message)); };
  fixture.sendFrom = (owner, message) => { for (const ws of wss.clients) if (!muted.has(ws) && ws.owner === owner) ws.send(JSON.stringify(message)); };
  fixture.push = next => { fixture.tab = next; fixture.send({ type: 'snapshot', data: next }); };
  wss.on('connection', (ws, req) => {
    if (req.url.endsWith('/browser/live') && onBrowserLive) { onBrowserLive(ws, req); return; }
    ws.owner = /^\/peer\/([^/]+)/.exec(req.url)?.[1] || '';
    ws.send(JSON.stringify({ type: 'snapshot', data: fixture.tab }));
    ws.on('message', raw => {
      if (muted.has(ws)) return;
      const c = JSON.parse(raw);
      fixture.commands.push(c);
      const reply = data => { if (!muted.has(ws)) ws.send(JSON.stringify({ type: 'response', id: c.id, success: true, data: data ?? (c.type === 'snapshot' ? fixture.tab : {}) })); };
      const data = fixture.answer(c, ws.owner);
      if (typeof data?.then === 'function') data.then(reply, error => { if (!muted.has(ws)) ws.send(JSON.stringify({ type: 'response', id: c.id, success: false, error: error?.message || String(error) })); }); else reply(data);
    });
  });
  let browser, ready = false;
  fixture.close = async () => {
    try {
      // A supplied browser (screenshot batches) is shared: close only this fixture's context.
      if (suppliedBrowser) await fixture.page?.context().close(); else await browser?.close();
    } finally {
      for (const ws of wss.clients) ws.terminate();
      try {
        await new Promise(r => wss.close(r));
      } finally {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
      }
    }
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    // Screenshot batches share one process; each fixture still owns its context.
    browser = suppliedBrowser ?? await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = fixture.page = await browser.newPage({ viewport, hasTouch });
    fixture.errors = []; page.on('pageerror', e => fixture.errors.push(e.message));
    if (layout || legacyLayout) await page.addInitScript(({ layout, legacyLayout }) => {
      if (layout) localStorage.setItem('imperfect.layout-choice', layout);
      sessionStorage.setItem('imperfect.surface-code-view', JSON.stringify({ layout: legacyLayout || layout, oneLayout: true }));
    }, { layout, legacyLayout });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (launchFrame) {
      // Real parent/child origins and the production origin guard; only test
      // transport is routed onto this isolated fixture, never production.
      await page.route('https://imperfect.computer/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body{margin:0}iframe{border:0;width:1200px;height:800px}</style><script>window.messages=[];addEventListener("message",e=>{if(e.source===document.querySelector("iframe")?.contentWindow&&e.origin==="https://noah.imperfect.computer")messages.push(e.data)});</script><iframe src="https://noah.imperfect.computer/"></iframe>' }));
      await page.route('https://noah.imperfect.computer/**', async route => route.fulfill({ response: await route.fetch({ url: route.request().url().replace('https://noah.imperfect.computer', origin) }) }));
      await page.addInitScript(socketOrigin => {
        const Native = WebSocket;
        globalThis.WebSocket = class extends Native { constructor(url, protocols) { super(String(url).replace('wss://noah.imperfect.computer', socketOrigin), protocols); } };
      }, origin.replace(/^http/, 'ws'));
    }
    await page.goto(launchFrame ? 'https://imperfect.computer/assembly-fixture' : origin);
    if (desk) await page.evaluate(FAKE_DESK);
    // desk may say more of the window, as preload.cjs would: { altAlias: false } is sway.
    if (typeof desk === 'object') await page.evaluate(more => Object.assign(globalThis.imperfectDesk, more), desk);
    if (!site && !launchFrame) await page.evaluate(async () => {
      const { mountGueyPi } = await import('/js/harness.js');
      window.harness = mountGueyPi({ hooks: { canFocus: () => true } });
    });
    if (!site && !launchFrame) await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-a');
    if (launchFrame) {
      fixture.product = page.frame({ url: 'https://noah.imperfect.computer/' });
      await fixture.product.locator('.agent-choose-harness[data-agent="pi"]').waitFor();
    } else await page.locator('#entry-output .gui-assistant').first().waitFor();
    // A snapshot/attached transcript is not a painted, font-stable window.
    // Give every fixture the same settled starting frame; later transitions
    // remain real and are observed by the individual behaviour tests.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState === 'finished'), null, { timeout: 60000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    ready = true;
    return fixture;
  } finally {
    if (!ready) await fixture.close();
  }
}
