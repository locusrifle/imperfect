// The sky of imperfect OS's lock, over the whole window while the lock holds and fading as it goes (arrival.js):
// the lock's own stars, drawn here by website/sky.mjs from the same three times the lock draws them from (when it
// began, when Locus and Vaita touched, and here, when it went), so the frame here is the frame there at the same
// moment, whatever either missed. Framed by imperfect.computer, the website's sky behind the window.
//
// It draws only while something moves: every frame while the lock's stars twist behind it (the lock may go at
// any one of them); after unlock thirty a second for the same steady turn and the
// twinkle; nothing at all while hidden or long unfocused, or motion is unwelcome (then each change, once).
//
// The composer's words push the stars over them aside and its cursor keeps a little room; each keystroke knocks
// the stars near the cursor away and they spring home.
import { TOUCH, createSky } from '../website/sky.mjs';

const KICK = 170; // px/s

// clock: the wall clock (s), which only a check would give otherwise
export function mountKeptSky(canvas, times, { clock = () => Date.now() / 1000, restAfter = 30_000, onLost = () => {} } = {}) {
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const sky = createSky(canvas, { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 });
  if (!sky) return null;
  const root = document.documentElement;
  let raf = 0, timer = 0, blurTimer = 0, resting = false, disposed = false, last = 0, dirty = true, keystroke = null;
  const avoid = { lines: [], caret: null, kicks: [] };

  function theme() {
    const css = getComputedStyle(root), hex = name => css.getPropertyValue(name).trim();
    // the lock's own: the theme's panel (else its background), and its brightest ink
    sky.theme(hex('--theme-raised') || hex('--theme-bg') || '#000000', hex('--theme-bright') || hex('--theme-ink') || '#ffffff');
    wake();
  }

  // the composer's lines (its mirror's text, a box a line) and its cursor, in window px
  let measured = false;
  function measure() {
    measured = true;
    avoid.lines = []; avoid.caret = null;
    const mirror = document.querySelector('#entry-input-zone .entry-caret-mirror');
    if (!mirror?.isConnected || mirror.hidden) return;
    const view = mirror.getBoundingClientRect(), range = document.createRange(), lines = [];
    const walk = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (!node.data.trim() || node.parentElement.closest('.entry-block-caret')) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (!r.width || r.bottom <= view.top || r.top >= view.bottom) continue;
        const line = lines.find(l => Math.abs(l[1] - r.top) < 2);
        if (line) { line[0] = Math.min(line[0], r.left); line[2] = Math.max(line[2], r.right); line[3] = Math.max(line[3], r.bottom); }
        else lines.push([r.left, r.top, r.right, r.bottom]);
      }
    }
    avoid.lines = lines.slice(-8).map(([l, t, r, b]) => [l - 1.5, Math.max(t, view.top) - 1.5, r + 1.5, Math.min(b, view.bottom) + 1.5]);
    const at = mirror.querySelector('.entry-block-caret')?.getBoundingClientRect();
    if (at && at.bottom > view.top && at.top < view.bottom) avoid.caret = [(at.left + at.right) / 2, (at.top + at.bottom) / 2, Math.max(at.width, at.height) / 2 + 3];
  }
  const stir = () => { measured = false; wake(); };

  function frame(ms) {
    cancelAnimationFrame(raf); raf = 0; // called directly too: never two loops
    if (disposed || document.hidden || (resting && times.gone !== null)) return;
    const now = clock(), calm = still.matches;
    const { epoch, touched, gone } = times;
    const twisting = Number.isFinite(touched) && now >= touched + TOUCH.pop - 0.2;
    // Seam-ready every frame while locked; thirty draws/s after unlock, at the SAME angular rate.
    const seamReady = gone === null;
    if (!calm && !dirty && !seamReady && last && ms - last < 30) { raf = requestAnimationFrame(frame); return; }
    last = ms;
    if (!measured) measure();
    // a keystroke knocks the stars at the cursor where it is now, the words having moved (measured just now)
    if (keystroke !== null && avoid.caret) avoid.kicks = [[avoid.caret[0], avoid.caret[1], keystroke - epoch, KICK], ...avoid.kicks].slice(0, 4);
    keystroke = null;
    avoid.kicks = avoid.kicks.filter(k => now - epoch - k[2] < 1.5);
    // Drafts under the hidden UI must not disturb the lock's star field.
    sky.frame({ now, epoch, touched, gone, still: calm, avoid: gone === null ? null : avoid });
    dirty = false;
    if (calm) return;
    if (gone !== null || twisting) raf = requestAnimationFrame(frame);
    else if (Number.isFinite(touched)) timer = setTimeout(wake, Math.max(0, (touched + TOUCH.pop - 0.2 - now) * 1000));
    // still locked and no touch yet: the lock shows its painting; this sky waits, drawn, for the touch
  }
  function wake() { clearTimeout(timer); dirty = true; if (!disposed && !raf) raf = requestAnimationFrame(frame); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf); clearTimeout(timer); clearTimeout(blurTimer);
    changes.disconnect(); for (const off of listeners) off(); sky.dispose();
  }

  const listeners = [];
  const listen = (target, type, fn, options) => { target.addEventListener(type, fn, options); listeners.push(() => target.removeEventListener(type, fn, options)); };
  listen(window, 'resize', () => { sky.resize(innerWidth, innerHeight, devicePixelRatio || 1); stir(); });
  listen(document, 'visibilitychange', wake);
  // Keep the visible look unchanged. Only sleep after focus has been elsewhere for a while; focus catches up
  // from the same wall clock immediately. While locked, keep the seam-ready frame regardless of focus.
  listen(window, 'blur', () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      // A focused embedded browser blurs this document, not the native window. Someone is still watching it.
      resting = globalThis.imperfectDesk?.isFocused?.() !== true;
      wake();
    }, restAfter);
  });
  listen(window, 'focus', () => { clearTimeout(blurTimer); resting = false; wake(); });
  listen(canvas, 'webglcontextlost', () => { dispose(); onLost(); });
  listen(still, 'change', wake);
  // a new theme: its colours, nothing else changes
  listen(document, 'load', event => { if (event.target?.id === 'theme-css') theme(); }, true);
  listen(document, 'input', event => {
    if (event.target?.id !== 'entry-input') return;
    stir();
    if (event.inputType?.startsWith('insert') && !still.matches) keystroke = clock();
  }, true);
  for (const type of ['focusin', 'focusout', 'scroll', 'selectionchange']) listen(document, type, stir, { capture: true, passive: true });
  if (document.fonts) listen(document.fonts, 'loadingdone', stir);
  const changes = new MutationObserver(stir);
  const zone = document.getElementById('entry-input-zone');
  if (zone) changes.observe(zone, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class'] });

  theme();
  return {
    sky, avoid,
    // the lock's times changed (a new lock, its touch, its going): nothing resets, the next frame is theirs
    times(next) { times = next; wake(); },
    frame: () => { dirty = true; frame(performance.now()); },
    dispose,
  };
}
