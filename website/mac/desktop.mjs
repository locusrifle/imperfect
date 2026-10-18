// A Mac hosts one window throughout. Apps fold INTO it; the last narrated build part
// is the verified real app, held inert until the voice finishes. No resized window,
// crossfade, or copied private product state is needed across the origin boundary.
export const INTRO = { voice: 'mac/sounds/line-0.m4a', durationMs: 6000 };
export const STEPS = [
  { line: 'we wrap the harnesses', voice: 'mac/sounds/line-1.m4a', durationMs: 9760, apps: ['claude', 'chatgpt'], build: 's-harness' },
  { line: 'we wrap the files', voice: 'mac/sounds/line-2.m4a', durationMs: 6960, apps: ['finder'], build: 's-files' },
  { line: 'we put a browser in', voice: 'mac/sounds/line-3.m4a', durationMs: 8240, apps: ['safari'], build: 's-browser' },
  { line: 'we wrap your messages', voice: 'mac/sounds/line-4.m4a', durationMs: 5680, apps: ['kinso'], build: 's-messages' },
  { line: 'it remembers', voice: 'mac/sounds/line-5.m4a', durationMs: 10080, holdMs: 8000, apps: ['notes'], build: 's-memory' },
  { line: 'it makes things', voice: 'mac/sounds/line-6.m4a', durationMs: 8480, apps: ['imovie'], build: 's-make' },
  { line: 'every change can be undone', voice: 'mac/sounds/line-7.m4a', durationMs: 5760, holdMs: 7000, apps: ['time-machine'], build: 's-undo' },
  { line: 'it goes where you go', voice: 'mac/sounds/line-8.m4a', durationMs: 5440, apps: [], build: 's-everywhere' },
  { line: 'your own operating system', voice: 'mac/sounds/line-9.m4a', durationMs: 12000, apps: [], build: 's-live' },
];
// Reuse the existing short Dock drop sound; no generated sound or new asset.
export const DROP_SOUND = 'mac/sounds/drag-to-trash.m4a';
// The Mac's screen, in its points: the page is fitted to it. The arrow's hot spot, in its points (NSCursor.arrow).
const SCREEN = { w: 1440, h: 900 }, HOT = { x: 4, y: 4 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const between = (a, b) => a + Math.random() * (b - a);

export function createMac({ screen, curtain, reduced, onstage, onfinish }) {
  const frame = screen.querySelector('iframe'), line = screen.querySelector('.mac-line'), clock = screen.querySelector('.mac-clock');
  const dock = screen.querySelector('.mac-dock'), arrow = screen.querySelector('.mac-cursor');
  let prepared = false, revealed = false, step = -1, built = [], absorbed = [], appReady = null, played = false;
  let us = 1, x = 0, y = 0, hosted = false, live = false, stopped = false, finished = false;
  const voicePlayer = new Audio(), dropPlayer = new Audio();
  voicePlayer.preload = dropPlayer.preload = 'auto';
  voicePlayer.src = INTRO.voice; dropPlayer.src = DROP_SOUND;
  // Both players are activated in the password gesture, before any network answer.
  function prime() {
    for (const audio of [voicePlayer, dropPlayer]) {
      audio.muted = true;
      audio.play().then(() => { audio.pause(); audio.currentTime = 0; audio.muted = false; }).catch(() => { audio.muted = false; });
    }
  }

  function fit() {
    us = Math.min(innerWidth / SCREEN.w, innerHeight / SCREEN.h);
    screen.style.setProperty('--us', String(us));
  }
  // The clock says the visitor's own time, as the Mac's does.
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  function tick() {
    const now = new Date();
    clock.textContent = `${day.format(now).replace(',', '')} ${time.format(now)}`;
  }
  // Ready behind the film: the window's page and the pictures load while it plays.
  function prepare() {
    if (prepared) return;
    prepared = true;
    fit(); tick();
    addEventListener('resize', fit);
    setInterval(tick, 10_000);
    screen.hidden = false;
    appReady = new Promise(resolve => {
      frame.addEventListener('load', () => resolve(frame.contentDocument), { once: true });
      frame.src = frame.dataset.src;
    });
  }
  // The film's frame goes up; the Mac was under it.
  async function reveal() {
    prepare();
    revealed = true;
    screen.dataset.visible = 'true'; screen.setAttribute('aria-hidden', 'false'); screen.inert = false;
    point(innerWidth * .56, innerHeight * .48);
    const ms = reduced.matches ? 0 : 1500;
    document.body.style.setProperty('--rise-ms', `${ms}ms`);
    curtain.hidden = false;
    document.body.dataset.curtain = 'down';
    void curtain.offsetHeight;
    document.body.dataset.curtain = 'up';
    await delay(ms + 50);
    curtain.hidden = true;
  }

  // The pointer: macOS's arrow, its tip where it points.
  function point(px, py) {
    x = px; y = py;
    arrow.style.translate = `${px - HOT.x * us}px ${py - HOT.y * us}px`;
  }
  // A hand's way there: a slight curve (or one by a given point), quick in the middle, settling at the end.
  function move(tx, ty, ms, along, via) {
    if (reduced.matches) { point(tx, ty); along?.(tx, ty); return Promise.resolve(); }
    const sx = x, sy = y, dx = tx - sx, dy = ty - sy, length = Math.hypot(dx, dy) || 1;
    const bend = (Math.random() < .5 ? -1 : 1) * Math.min(50 * us, length * .1);
    const cx = via?.x ?? sx + dx / 2 - dy / length * bend, cy = via?.y ?? sy + dy / 2 + dx / length * bend;
    return new Promise(resolve => {
      const start = performance.now();
      const frameAt = now => {
        const t = Math.min(1, (now - start) / ms), e = t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        const px = (1 - e) ** 2 * sx + 2 * (1 - e) * e * cx + e * e * tx, py = (1 - e) ** 2 * sy + 2 * (1 - e) * e * cy + e * e * ty;
        point(px, py); along?.(px, py);
        if (t < 1) requestAnimationFrame(frameAt); else resolve();
      };
      requestAnimationFrame(frameAt);
    });
  }
  const tileOf = name => dock.querySelector(`.mac-tile[data-app="${name}"]`);
  const centre = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r }; };
  const travel = (tx, ty) => Math.min(1100, 380 + Math.hypot(tx - x, ty - y) * .9 / Math.max(us, .5));
  // Its place in the Dock closes, as the Dock's icons slide together.
  function close(tile) {
    tile.animate([{ width: getComputedStyle(tile).width }, { width: '0px' }], { duration: reduced.matches ? 1 : 420, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
  }
  // One app, from the Dock into the window, never towards the Trash.
  async function intoWindow(name) {
    const tile = tileOf(name), icon = tile?.querySelector('img');
    if (!icon) return;
    const at = centre(icon), grab = { x: at.x + between(-6, 6) * us, y: at.y + between(-2, 8) * us };
    await move(grab.x, grab.y, travel(grab.x, grab.y));
    await delay(reduced.matches ? 0 : 120);
    icon.classList.add('mac-dim'); // pressed
    await delay(reduced.matches ? 0 : 170);
    if (stopped) { icon.classList.remove('mac-dim'); return; }
    // Picked up: the icon goes with the pointer, held where it was taken.
    const ghost = icon.cloneNode();
    ghost.className = 'mac-ghost';
    for (const [key, value] of Object.entries({ left: at.r.left, top: at.r.top, width: at.r.width, height: at.r.height })) ghost.style[key] = `${value}px`;
    screen.append(ghost);
    icon.style.visibility = 'hidden'; icon.classList.remove('mac-dim');
    if (tile.querySelector('.mac-run')) tile.querySelector('.mac-run').style.visibility = 'hidden';
    let out = false;
    const top = dock.getBoundingClientRect().top;
    const carry = (px, py) => {
      ghost.style.translate = `${px - grab.x}px ${py - grab.y}px`;
      if (!out && py < top - 6 * us) { out = true; close(tile); }
    };
    const win = frame.getBoundingClientRect();
    const target = { x: win.left + win.width * between(.42, .58), y: win.top + win.height * .48 };
    screen.dataset.dragging = name;
    await move(target.x, target.y, Math.max(900, travel(target.x, target.y)), carry);
    if (!out) close(tile);
    if (stopped) { ghost.remove(); delete screen.dataset.dragging; return; }
    // The drop is inspectable at real window coordinates, including reduced motion.
    screen.dispatchEvent(new CustomEvent('imperfect:drop', { bubbles: true, detail: { name, x: target.x, y: target.y } }));
    await delay(reduced.matches ? 0 : 160);
    sound(DROP_SOUND);
    absorbed.push(name);
    await ghost.animate([{ scale: '1', opacity: 1 }, { scale: '.12', opacity: 0 }], { duration: reduced.matches ? 1 : 260, easing: 'ease-in', fill: 'forwards' }).finished;
    ghost.remove(); delete screen.dataset.dragging;
    await delay(reduced.matches ? 0 : 220);
  }
  function build(doc, part) {
    if (!built.includes(part)) built.push(part);
    doc.documentElement.classList.add(part);
    if (part === 's-live') arrow.hidden = true;
    onstage?.(part);
    if (part === 's-memory') {
      screen.dataset.story = 'true';
      doc.querySelector('[data-page]')?.classList.remove('active');
    }
    for (const film of doc.querySelectorAll('video')) {
      if (part === 's-make') { film.currentTime = 77; film.play().catch(() => {}); }
      else film.pause();
    }
    // The browser's page is the one open now: the sidebar says so.
    if (part === 's-browser') {
      doc.querySelector('[data-home]')?.classList.remove('active');
      doc.querySelector('[data-page]')?.classList.add('active');
    }
  }
  function say(text) {
    line.textContent = text;
    line.dataset.on = String(Boolean(text));
  }
  // Voice completion, not just a timer: a buffering line must finish before the next one starts.
  // A failed/blocked sound still keeps its measured reading time and the on-screen line.
  async function sound(src, durationMs = 0) {
    if (stopped) return;
    const audio = src === DROP_SOUND ? dropPlayer : voicePlayer;
    audio.src = src; audio.muted = false;
    if (!durationMs) { audio.play().catch(() => {}); return; }
    const finished = new Promise(resolve => {
      const done = () => { clearTimeout(timeout); audio.removeEventListener('ended', done); audio.removeEventListener('error', done); resolve(); };
      const timeout = setTimeout(done, durationMs + 20000);
      audio.addEventListener('ended', done, { once: true }); audio.addEventListener('error', done, { once: true });
      audio.play().catch(done);
    });
    await Promise.all([finished, delay(durationMs)]);
    audio.pause();
  }
  function finish() {
    finished = true; arrow.hidden = true; say('');
  }
  function present(on) {
    hosted = on; screen.dataset.hosted = String(on);
    if (on) screen.querySelector('.mac-offline').hidden = true;
  }
  // The keyboard shortcut skips the story, never the lock or readiness check.
  async function complete() {
    prepare(); stopped = true; voicePlayer.pause(); dropPlayer.pause();
    const doc = await appReady;
    for (const s of STEPS) {
      build(doc, s.build);
      for (const name of s.apps) {
        const tile = tileOf(name); if (tile) tile.style.display = 'none';
        if (!absorbed.includes(name)) absorbed.push(name);
      }
    }
    for (const ghost of screen.querySelectorAll('.mac-ghost')) ghost.remove();
    arrow.hidden = true; say(''); step = STEPS.length;
  }
  function setLive(on) {
    live = on; screen.dataset.live = String(on);
    if (on) screen.querySelector('.mac-offline').hidden = true;
  }
  function offline() { screen.querySelector('.mac-offline').hidden = false; }
  // The build: the plain window a moment, then each step.
  async function play() {
    if (played) return;
    played = true;
    const doc = await appReady;
    await delay(reduced.matches ? 300 : 1000);
    await sound(INTRO.voice, INTRO.durationMs);
    for (const [i, s] of STEPS.entries()) {
      if (stopped) return;
      step = i;
      const began = performance.now();
      say(s.line);
      const spoken = sound(s.voice, s.durationMs);
      await delay(reduced.matches ? 0 : 500);
      for (const name of s.apps) { if (stopped) return; await intoWindow(name); }
      if (stopped) return;
      // Back to the window, and the part arrives.
      const win = frame.getBoundingClientRect();
      await move(win.left + win.width * between(.42, .58), win.top + win.height * between(.38, .55), 750);
      build(doc, s.build);
      const hold = delay(s.holdMs ?? 2600);
      await Promise.all([spoken, hold]);
      await delay(Math.max(700, 3200 - (performance.now() - began)));
      say('');
      await delay(600);
    }
    if (stopped) return;
    step = STEPS.length;
    await onfinish?.();
  }
  return { prime, prepare, reveal, play, complete, finish, present, live: setLive, offline,
    state: () => ({ prepared, revealed, step, finished, hosted, live, built: [...built], absorbed: [...absorbed] }) };
}
