import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

// The locker serves the website without a build. Check its static pages and
// optional art's dependencies, including references outside the front page.
const SITE = resolve(import.meta.dirname, '../../website');
const PUBLIC = resolve(import.meta.dirname, '../public');
const ROUTES = new Set(['/account', '/buy']);
const exists = file => access(file).then(() => true, () => false);
const page = name => readFile(join(SITE, name), 'utf8');
const words = html => html.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp);/g, ' ').replace(/\s+/g, ' ').trim();
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(([, name, , value]) => [name, value]));
// A link's name is its words, and an image's alt text inside it (the logo is an image).
const links = html => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(([, attributes, label]) => ({ ...attrs(attributes), label: words(label.replace(/<img\b([^>]*)>/gi, (_, img) => ` ${attrs(img).alt ?? ''} `)) }));
async function files(dir, keep) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(full, keep));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}
async function missing(names) {
  const gone = [];
  for (const [from, file] of names) if (!await exists(file)) gone.push(`${relative(SITE, from)} names ${relative(SITE, file)}`);
  return gone;
}

async function localReference(from, ref, names, fragments) {
  if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(ref)) return;
  const [path, fragment] = ref.split('#');
  let pathname = decodeURIComponent(path.split('?')[0]);
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (ROUTES.has(pathname)) return; // sibling account service and explicitly legacy store
  let target = pathname ? resolve(pathname.startsWith('/') ? SITE : dirname(from), pathname.replace(/^\//, '')) : from;
  // Icons are served by the existing store, not copied into the website.
  if (pathname.startsWith('/') && !await exists(target) && await exists(join(PUBLIC, 'store', pathname))) target = join(PUBLIC, 'store', pathname);
  names.push([from, target]);
  if (fragment && /\.html$/.test(target)) fragments.push([from, target, decodeURIComponent(fragment)]);
}

test('all HTML, CSS and local module references resolve, including page fragments', async () => {
  const names = [];
  const fragments = [];
  for (const file of await files(SITE, name => /\.(html|css|mjs|js)$/.test(name))) {
    if (file.includes(`${SITE}/vendor/`)) continue;
    const text = await readFile(file, 'utf8');
    if (/\.html$/.test(file)) {
      for (const [, , ref] of text.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gs)) await localReference(file, ref, names, fragments);
      for (const [, , set] of text.matchAll(/\bsrcset\s*=\s*(["'])(.*?)\1/gs)) {
        for (const candidate of set.split(',')) await localReference(file, candidate.trim().split(/\s+/)[0], names, fragments);
      }
    }
    if (/\.(html|css)$/.test(file)) {
      for (const match of text.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/g)) await localReference(file, match[1] ?? match[2] ?? match[3], names, fragments);
      for (const [, , ref] of text.matchAll(/@import\s+(["'])(.*?)\1/g)) await localReference(file, ref, names, fragments);
    }
    if (/\.(mjs|js)$/.test(file)) {
      const refs = [
        ...text.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm),
        ...text.matchAll(/^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm),
        ...text.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
        ...text.matchAll(/new URL\(['"](\.{0,2}\/?[^'":]+)['"], import\.meta\.url\)/g),
      ].map(match => match[1]);
      for (const ref of refs) await localReference(file, ref, names, fragments);
    }
  }
  assert.ok(names.length > 20, 'the site names its local assets and optional art modules');
  assert.deepEqual(await missing(names), []);
  for (const [from, target, id] of fragments) {
    const ids = [...(await readFile(target, 'utf8')).matchAll(/\bid\s*=\s*(["'])(.*?)\1/g)].map(match => match[2]);
    assert.ok(ids.includes(id), `${relative(SITE, from)} links to missing ${relative(SITE, target)}#${id}`);
  }
});

test('the front stages the lock, galaxy, transparent launch film and the real Noah computer behind the exact handshake', async () => {
  const html = await page('index.html');
  assert.match(html, /<body data-phase="loading">/);
  assert.match(html, /<script type="module" src="launch\.mjs(?:\?v=[\w-]+)?"><\/script>/);
  assert.match(html, /<section id="introScreen"[^>]*aria-label="Noah and Locus, the Creation of Adam"/);
  for (const id of ['scene', 'galaxyScene', 'wordmark']) assert.match(html, new RegExp(`<canvas[^>]*id="${id}"[^>]*aria-hidden="true"`));
  for (const id of ['filmScreen', 'demoScreen']) assert.match(html, new RegExp(`<section id="${id}"[^>]*data-visible="false"[^>]*aria-hidden="true"[^>]*inert`));
  assert.ok(html.indexOf('id="introScreen"') < html.indexOf('id="filmScreen"'));
  const macWindow = html.slice(html.indexOf('<div class="mac-window">'), html.indexOf('<div class="mac-dock"'));
  assert.match(macWindow, /<section id="demoScreen"\s/, 'the real app stays inside the Mac window, under its menu bar');
  assert.match(macWindow, /<iframe id="computer"\s/);
  // The Mac the film ends on is under the sky and the film, ready but unseen until the film's frame goes up.
  assert.match(html, /<section id="macScreen" class="screen mac" data-visible="false"[^>]*aria-hidden="true" inert hidden>/);
  assert.ok(html.indexOf('id="macScreen"') < html.indexOf('id="curtain"') && html.indexOf('id="curtain"') < html.indexOf('id="introScreen"'));
  const app = attrs(html.match(/<iframe title="Your own app"[^>]*>/)[0]);
  assert.match(app['data-src'], /^mac\/app\.html(?:\?v=[\w-]+)?$/, 'its window is the site\'s own static page');
  assert.ok(!app.src && !app.srcdoc, 'loaded only once the film plays');
  assert.match(html, /<video id="film"[^>]*playsinline[^>]*aria-label="imperfect launch film"/);
  assert.match(html, /<canvas id="filmCanvas" aria-hidden="true"><\/canvas>/);
  const frame = attrs(html.match(/<iframe id="computer"[^>]*>/i)[0]);
  assert.equal(frame.id, 'computer');
  assert.equal(frame.title, 'imperfect · live computer');
  assert.equal(frame.referrerpolicy, 'strict-origin-when-cross-origin');
  assert.ok(!frame.src && !frame.srcdoc, 'no eager or simulated demo');
  assert.match(html, /<noscript><div class="no-script">JavaScript is needed for the launch sequence\.<\/div><\/noscript>/);
  assert.doesNotMatch(html, /noah\.imperfect\.computer|\/door\/ticket/, 'no computer\'s address in the page: the locker gives it after the unlock');
  // The launch page has no UI of its own beyond the lock and the failure fallbacks: the account link that sat in the
  // old controls bar went with it (the computer itself is the way on).
  assert.equal(links(html).find(link => link.id === 'own'), undefined);
  assert.equal(frame.allow, 'clipboard-read; clipboard-write; microphone; fullscreen', 'the product frame\'s permissions are as they were');
  const { config } = await import(join(SITE, 'launch-config.mjs'));
  assert.equal('demoUrl' in config, false, 'the locker says which computer, after the unlock');
  assert.equal(config.demoReadyType, 'imperfect:demo-ready');
  assert.equal(fileURLToPath(config.videoUrl), join(SITE, 'media/v8-lets-begin.mp4'));
  assert.equal(fileURLToPath(config.cuesUrl), join(SITE, 'media/v8-cues.json'));
  assert.ok(Array.isArray(JSON.parse(await readFile(fileURLToPath(config.cuesUrl), 'utf8')).warp));
  assert.deepEqual(html.match(/<form\b[^>]*>/gi), ['<form id="lock" aria-label="Locked" autocomplete="off" novalidate hidden>'], 'one form: the lock, which only asks the locker');
  assert.doesNotMatch(html, /srcdoc=|offer-grid|hero-copy|checkout\.stripe\.com|AUD\s*(?:40|400)/i, 'cinematic front neither sells the old product nor promises signup/payment');
  const menus = html.match(/<nav\b[^>]*class="mac-menus"[^>]*>([\s\S]*?)<\/nav>/)[1];
  assert.deepEqual(links(menus).map(({ href, label }) => ({ href, label })), [{ href: '/buy', label: 'Shop' }], 'Shop stays in the Mac menu bar and opens the existing buy page');
  assert.doesNotMatch(macWindow, /<a[^>]*class="buy"/, 'no floating buy overlay over the real app');
});

test('the static build adds memory, making, undo and the same conversation on a phone using product markup', async () => {
  const html = await page('mac/app.html'), css = await page('mac/app/stage.css');
  const panels = [...html.matchAll(/<section\b[^>]*data-stage-panel="([^"]+)"[^>]*>/g)];
  assert.deepEqual(panels.map(([, name]) => name), ['memory', 'make', 'undo', 'everywhere']);
  for (const [tag, name] of panels) {
    assert.ok(attrs(tag).class.split(/\s+/).includes('gui-transcript'), `${name} uses the real conversation layout`);
    assert.ok(attrs(tag)['aria-label'], `${name} has an accessible description`);
    assert.ok(css.includes(`.s-${name}`) && css.includes(`[data-stage-panel="${name}"]`), `${name} appears with its build step`);
  }
  assert.match(words(html), /what did we decide last week/i);
  assert.match(words(html), /undo that/i);
  assert.match(html, /class="[^"]*stage-phone[^"\n]*"/);
  assert.match(html, /class="[^"]*stage-phone-transcript[^"\n]*"/);
  assert.match(html, /class="[^"]*stage-phone-composer[^"\n]*"/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation-duration:\s*(?:0|1)ms\s*!important/);
});

test('buy stages an honest account handoff, not a pretend signup or provisioned computer', async () => {
  const html = await page('buy.html');
  const text = words(html);
  assert.match(text, /US\$40\b/, 'rent is US$40 a month (Noah, 15 Oct)');
  assert.match(text, /month|monthly/i);
  assert.match(text, /Claude/);
  assert.match(text, /ChatGPT/);
  assert.match(text, /(?:not yet|not live|not ready|staging|in progress|being built|still being|not available)/i);
  assert.ok(links(html).some(link => link.href === '/account' && link.label), 'agreed sibling account route has a named handoff');
  assert.match(text, /US\$150\b/, 'the code is US$150 once');
  assert.deepEqual([...html.matchAll(/<form\b[^>]*>/gi)].map(m => m[0]), ['<form method="post" action="/buy">'], 'one form: the code\'s checkout');
  assert.doesNotMatch(html, /<script\b|type=["']password["']/i, 'static page does not collect credentials');
});

test('self-hosting states AUD400 lifetime, with checkout unavailable and any old store unmistakably legacy', async () => {
  const html = await page('host.html');
  const text = words(html);
  assert.match(text, /(?:AUD|A\$)\s*400\b/i);
  assert.match(text, /lifetime/i);
  assert.match(text, /self[ -]host|own hardware|own computer/i);
  assert.match(text, /Claude/);
  assert.match(text, /ChatGPT/);
  assert.match(text, /(?:checkout|purchase|payment)[\s\S]{0,180}(?:not yet|not ready|not live|not available|being built|being prepared|in progress)/i);
  assert.doesNotMatch(html, /<form\b|<script\b|checkout\.stripe\.com/i, 'AUD400 checkout is not wired to an old price');
  for (const link of links(html).filter(link => /^\/buy(?:[?#]|$)/.test(link.href))) {
    assert.match(link.label, /legacy/i, 'the /buy anchor itself is explicitly legacy');
    assert.match(text, /different[\s,]+(?:legacy\s+)?(?:product|offer)/i);
    assert.match(text, /(?:different|existing|old|legacy) price/i);
    assert.doesNotMatch(link.label, /400|buy now|checkout/i, 'legacy store is not an AUD400 purchase action');
  }
});

test('all explanatory pages have accessible static structure and named navigation', async () => {
  for (const name of ['index.html', 'buy.html', 'host.html']) {
    const html = await page(name);
    assert.match(html, /<html\b[^>]*\blang=["']en["']/i, name);
    assert.match(html, /<meta\b[^>]*name=["']viewport["']/i, name);
    assert.match(html, /<title>[^<]+<\/title>/i, name);
    assert.equal([...html.matchAll(/<main\b/gi)].length, 1, `${name}: one main landmark`);
    assert.equal([...html.matchAll(/<h1\b/gi)].length, 1, `${name}: one primary heading`);
    assert.ok(words(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)[1]), `${name}: meaningful primary heading`);
    if (name === 'index.html') {
      assert.match(html, /<h1 id="launchHeading" class="sr-only">imperfect: launch film and live computer<\/h1>/);
      // No visible UI on the normal path: the lock's one password field (and its arrow once something is typed), a
      // keyboard-only skip link to the verified computer, and the failure prompt (hidden until a failure).
      assert.match(html, /<a class="keyboard-skip" id="skip" href="#computer">Skip to the computer<\/a>/);
      assert.match(html, /<input id="password" name="password" type="password" aria-label="Password" autocomplete="current-password"/);
      assert.match(html, /<button id="unlock" type="submit" aria-label="Unlock"><svg\b[^>]*aria-hidden="true"/);
      assert.doesNotMatch(html, /id="power"/, 'no power button');
      assert.doesNotMatch(html, /id="launchControls"|class="controls"|<button id="(?:mute|pause|replay)"/, 'no controls bar');
      assert.match(html, /<div class="prompt" id="prompt" hidden>/);
      assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
      assert.match(html, /<p class="sr-only" id="announce" aria-live="polite">/);
    }
    assert.match(html, /<nav\b[^>]*aria-label=["'][^"']+["']/i, `${name}: named navigation`);
    assert.ok(links(html).some(link => /^#/.test(link.href) && /skip/i.test(link.label)), `${name}: keyboard skip link`);
    const ids = [...html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/g)].map(match => match[2]);
    assert.equal(new Set(ids).size, ids.length, `${name}: unique IDs`);
    for (const [, , references] of html.matchAll(/\baria-(?:labelledby|describedby)\s*=\s*(["'])(.*?)\1/g)) {
      for (const id of references.split(/\s+/)) assert.ok(ids.includes(id), `${name}: accessible description references ${id}`);
    }
    for (const [, tag] of html.matchAll(/(<img\b[^>]*>)/gi)) assert.ok(Object.hasOwn(attrs(tag), 'alt'), `${name}: images have alt text (empty for decoration)`);
    for (const link of links(html)) assert.ok(link.label || link['aria-label'], `${name}: ${link.href} has an accessible name`);
    if (name !== 'index.html') assert.ok(links(html).some(link => /^(?:index\.html(?:#.*)?|\/)$/i.test(link.href)), `${name}: return to front`);
  }
});

// The subset Outfit files hold Basic Latin and these; every visible word on the front keeps to them.
const SUBSET = /^[\x20-\x7e\u00a0\u00b7\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]*$/u;
test('the cinematic front uses the subset Outfit, accessible focus and full-viewport, safe-area screens', async () => {
  const html = await page('index.html');
  const sheets = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => attrs(match[0])).filter(link => link.rel === 'stylesheet');
  assert.ok(sheets.length > 0);
  assert.deepEqual(sheets.map(link => link.href.split('?')[0]), ['sequence.css', 'mac/desktop.css'], 'launch styles stay separate from native lock and retained offer pages');
  const css = await page('sequence.css');
  // The Mac the film ends on draws macOS as macOS does, in the visitor's own system font: no font file, no name of one.
  const mac = (await page('mac/desktop.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, family] of mac.matchAll(/font-family: ([^;]+);/g)) assert.match(family, /^-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, sans-serif$/);
  assert.doesNotMatch(mac, /@font-face|url\([^)]*\.(?:woff2?|ttf|otf)|SF Pro|https?:\/\//, 'the Mac loads no font');
  assert.doesNotMatch(mac, /font:[^;]*['"](?!Outfit)[^'"]+['"]/, 'its words in the launch\'s own font, or the system\'s');
  assert.match(css, /font-family: 'Outfit'; src: url\('fonts\/outfit-regular\.woff2'\) format\('woff2'\); font-weight: 400;[^}]*font-display: swap/);
  assert.match(css, /font-family: 'Outfit'; src: url\('fonts\/outfit-medium\.woff2'\) format\('woff2'\); font-weight: 500;[^}]*font-display: swap/);
  // The font in one place: its files (@font-face) and its name (--font), which everything takes.
  assert.match(css, /:root \{ --font: 'Outfit', system-ui, sans-serif; \}/);
  assert.match(css, /html, body\s*\{[^}]*font: 400 14px\/1\.45 var\(--font\)/);
  assert.match(css, /button, a, input \{ color: inherit; font: inherit; \}/);
  assert.equal(css.replace(/\/\*[\s\S]*?\*\//g, '').match(/Outfit/g).length, 3, 'named only in the two @font-face lines and --font');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /font-family:(?![^;]*'Outfit'; src:)/, 'no other font-family anywhere');
  assert.doesNotMatch(css, /SF Pro/, 'SF Pro is gone from the site');
  assert.doesNotMatch(css, /Space Mono/, 'the front no longer loads Space Mono (the file stays for the other pages)');
  assert.match(css, /\.hint\s*\{[^}]*font-size: 13px; font-weight: 400;[^}]*color: rgba\(212, 212, 212, \.5\)/);
  const visible = [...words(html.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '')).matchAll(/./gu)].join('');
  assert.match(visible, SUBSET, 'the page\'s words are all in the subset');
  const launchText = await page('launch.mjs');
  const strings = [...launchText.matchAll(/\b(?:prompt|fallbackPrompt|say)\(\s*'([^']*)'(?:\s*,\s*'[^']*'\s*,\s*'([^']*)')?/g)].flatMap(([, text, label]) => [text, label ?? '']);
  assert.ok(strings.length >= 8);
  for (const text of strings) assert.match(text, SUBSET, `in the subset: ${text}`);
  assert.match(css, /button:focus-visible, a:focus-visible\s*\{[^}]*outline: 1px solid #d4d4d4/);
  assert.match(css, /#unlock:focus-visible\s*\{[^}]*outline-offset: -6px/);
  assert.match(css, /\.field:focus-within\s*\{[^}]*border-color: #fff/, 'the field shows where the keys go');
  assert.match(css, /\.keyboard-skip:focus\s*\{[^}]*position: fixed;[^}]*z-index: 40/);
  assert.match(css, /\.sr-only, \.keyboard-skip:not\(:focus\)[^{]*\{[^}]*clip-path: inset\(50%\)/);
  assert.match(css, /\.screen\s*\{[^}]*position: fixed; inset: 0/);
  assert.match(css, /--safe: env\(safe-area-inset-top\) env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\)/);
  assert.match(css, /\.film-area\s*\{[^}]*inset: var\(--safe\)/, 'the film is contained in the safe area');
  assert.match(css, /\.demo\s*\{[^}]*inset: var\(--safe\)/, 'the computer has the whole safe viewport');
  assert.match(css, /\.film-box video\s*\{[^}]*width: 200%;[^}]*object-fit: fill/, 'the packed film: its picture half fills the 4:3 box');
  assert.doesNotMatch(css, /\.controls|--controls-(?:space|height)/, 'no controls bar and no space kept for one');
  assert.doesNotMatch(await page('launch.mjs'), /measureControls|launchControls/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /https?:\/\//i, 'no remote stylesheet dependency');
  const imports = [...css.matchAll(/@import[^;]+;/g)].map(m => m[0]);
  assert.equal(imports.length, 1); assert.match(imports[0], /^@import url\('\.\/boot\/sequence\.css\?v=[\w-]+'\);$/, 'the same local boot layers as the native lock, cache-busted');
});

test('the native OS lock keeps its borrowed dark art styles, separate from the landing page', async () => {
  const lock = await readFile(resolve(SITE, '../desktop/lock/index.html'), 'utf8');
  assert.match(lock, /<base href="\.\.\/\.\.\/website\/">/);
  assert.match(lock, /href="style\.css"/);
  const shared = await page('style.css');
  assert.match(shared, /html, body\s*\{[^}]*background:\s*#07060c/);
  assert.match(shared, /\.box\s*\{\s*position:\s*absolute/, 'the native password field must remain positioned at its computed centre');
  assert.match(shared, /\.box\s*\{[^}]*display:\s*flex/);
  assert.match(shared, /\.box\s*\{[^}]*align-items:\s*center/);
  assert.match(shared, /\.box\s*\{[^}]*justify-content:\s*center/);
  assert.match(shared, /\.box\.on\s*\{[^}]*opacity:\s*1/);
  assert.doesNotMatch(shared, /--paper|\.hero-copy|\.offer-grid/, 'the new site styles cannot leak into the native lock');
});

test('only the launch remains: the world page, its galaxy and its cut-outs are gone; the launch has its real film', async () => {
  for (const gone of ['world.html', 'world.mjs', 'galaxy.mjs', 'config.mjs', 'opener/opener.mjs', 'opener/input.mjs', 'media/v4-launch.mp4', 'ending.mjs']) {
    assert.equal(await exists(join(SITE, gone)), false, `${gone}: gone`);
  }
  assert.equal(await exists(join(SITE, 'assets', 'cutouts')), false, 'no cut-outs (the world page\'s white goat went with it)');
  const { config: launch } = await import(join(SITE, 'launch-config.mjs'));
  assert.ok(await exists(fileURLToPath(launch.videoUrl)), 'the launch has its real film');
  assert.deepEqual((await readdir(join(SITE, 'media'))).sort(), ['v8-cues.json', 'v8-lets-begin.mp4'], 'one film');
  const sky = await page('scene.mjs');
  assert.match(sky, /instances: \[\]/);
  assert.doesNotMatch(sky, /TextureLoader|PlaneGeometry|fetch\(|manifest|cutouts/, 'the galaxy needs no cut-out assets');
});

test('existing art stays; only contact, the launch film, build voices and app drops supply sound', async () => {
  const names = [[SITE, join(SITE, 'blackhole/blackhole.mjs')], [SITE, join(SITE, 'fonts', 'SpaceMono-Regular.woff2')]];
  const opener = join(SITE, 'opener');
  const paintings = [];
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) {
      if ((key === 'src' || key === 'hd') && typeof inner === 'string') paintings.push(inner);
      else walk(inner);
    }
  };
  const { locus, vaitas, worlds } = (await import(join(opener, 'assets', 'manifest.mjs'))).default;
  walk([locus, vaitas, worlds]);
  assert.deepEqual(paintings.sort(), ['assets/hd/locus.webp', 'assets/hd/vaita-dragon.webp', 'assets/hd/worlds/dragon.webp', 'assets/hd/worlds/portrait-dragon.webp'],
    'the HD paintings the launch page and the OS lock draw, and nothing else');
  assert.deepEqual((await files(join(opener, 'assets'), name => /\.webp$/.test(name))).map(file => relative(opener, file)).sort(), paintings, 'no painting left that nothing draws');
  names.push(...paintings.map(file => [opener, join(opener, file)]));
  for (const gone of ['hand.mjs', 'line.mjs', 'assets/ink']) assert.equal(await exists(join(SITE, gone)), false, `${gone}: no handwriting or drawn line`);
  const { LETTERING } = await import(join(SITE, 'wordmark.mjs'));
  names.push([SITE, fileURLToPath(LETTERING.src)]);
  assert.equal(await exists(join(opener, 'sound.mjs')), false);
  assert.equal(await exists(join(opener, 'assets', 'sound')), false);
  const fonts = await readdir(join(SITE, 'fonts'));
  assert.deepEqual(fonts.filter(name => /\.woff2$/.test(name)).sort(), ['SpaceMono-Regular.woff2', 'outfit-medium.woff2', 'outfit-regular.woff2']);
  assert.deepEqual(fonts.filter(name => /\.(?:otf|ttf|woff)$/i.test(name)), [], 'never full font files');
  assert.deepEqual(fonts.filter(name => /sf-pro/i.test(name)), [], 'no SF Pro');
  assert.match(await readFile(join(SITE, 'fonts', 'Outfit-OFL.txt'), 'utf8'), /^Copyright 2021 The Outfit Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/, 'its licence beside it');
  for (const name of ['outfit-regular.woff2', 'outfit-medium.woff2']) {
    const bytes = await readFile(join(SITE, 'fonts', name));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2'); assert.ok(bytes.length < 10000, `${name} is the small subset`);
  }
  assert.equal(await exists(join(SITE, 'sounds.mjs')), false);
  for (const file of await files(SITE, name => /\.(html|mjs|js)$/.test(name))) {
    if (file.includes(`${SITE}/vendor/`)) continue;
    const text = await readFile(file, 'utf8');
    if (relative(SITE, file) === 'bootup.mjs') {
      assert.doesNotMatch(text, /new Audio\(|sounds\.(type|draw)\(|<(?:audio|video)\b/i, 'contact retains only its existing Web Audio player');
    } else if (relative(SITE, file) === 'mac/desktop.mjs') {
      // Narration and the existing short Dock drop sound, on independent players.
      assert.equal([...text.matchAll(/new Audio\(/g)].length, 2, 'independent voice and drop players: folding in an app must not interrupt its spoken line');
      assert.doesNotMatch(text, /AudioContext|sounds\.(type|draw)\(|<(?:audio|video)\b/i, 'mac/desktop.mjs has no other sound');
      const { INTRO, STEPS, DROP_SOUND } = await import(file);
      for (const step of [INTRO, ...STEPS]) assert.ok(await exists(join(SITE, step.voice)), `its voice: ${step.voice}`);
      assert.ok(await exists(join(SITE, DROP_SOUND)), `the drop sound: ${DROP_SOUND}`);
    } else if (relative(SITE, file) === 'mac/app.html') {
      const videos = [...text.matchAll(/<video\b[^>]*>/gi)].map(match => match[0]);
      assert.equal(videos.length, 1, 'one explicit film card in the static conversation');
      const video = videos[0], attributes = attrs(video);
      assert.equal(attributes.src.split('#')[0], '../media/v8-lets-begin.mp4', 'the card reuses the existing film, not a second soundtrack');
      assert.ok(attributes['aria-label'], 'the film card has an accessible name');
      for (const flag of ['muted', 'playsinline', 'loop']) assert.match(video, new RegExp(`\\b${flag}\\b`), `${flag}: the preview cannot compete with the voice`);
      assert.doesNotMatch(video, /\bcontrols\b/, 'a static staged card, not a second audible player');
      assert.doesNotMatch(text.replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, ''), /AudioContext|new Audio\(|sounds\.(type|draw)\(|<(?:audio|video)\b/i, 'the muted card is the only media exception in the preview');
    } else if (relative(SITE, file) === 'index.html') {
      assert.equal([...text.matchAll(/<video\b/gi)].length, 1, 'only one launch film');
      assert.doesNotMatch(text.replace(/<video\b[^>]*>[\s\S]*?<\/video>/i, ''), /AudioContext|new Audio\(|sounds\.(type|draw)\(|<(?:audio|video)\b/i, 'no added audio outside that film');
    } else {
      assert.doesNotMatch(text, /AudioContext|new Audio\(|sounds\.(type|draw)\(|<(?:audio|video)\b/i, `${relative(SITE, file)} has no other sound`);
    }
  }
  for (const file of ['bootup.webm', 'bootup.m4a']) assert.ok(await exists(join(SITE, 'assets/sound', file)));
  assert.deepEqual(await missing(names), []);
});

test('the existing store still finds the typeface and black hole it borrows', async () => {
  const names = [];
  for (const file of await files(PUBLIC, name => /\.(html|js|css)$/.test(name))) {
    for (const [, path] of (await readFile(file, 'utf8')).matchAll(/["'(](\/assets\/[^"'?)\s]+)/g)) names.push([file, join(SITE, path)]);
  }
  assert.ok(names.length >= 5);
  assert.deepEqual(await missing(names), []);
});
