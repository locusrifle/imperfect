// imperfect OS's screen lock (desktop/electron/lock.mjs). While it holds, imperfect shows only its sky, the whole
// window: the lock's own stars (kept-sky.js, website/sky.mjs), drawn here from the lock's own times, so the lock
// and the window behind it are one sky. When the lock goes the bars, panels and input bar fade in over it, opacity
// only, and then the sky fades away under them to the window's own plain ground:
// the galaxy is the lock's and the website's, not the app's (Noah). Without word of a lock (any other computer,
// the phone, a browser, an older imperfect OS) none of this happens: the UI is simply there, as it is; except
// framed by imperfect.computer, where the website's sky is behind it from the start (framedByLaunch). A lock whose
// keeper has gone, or a word that the lock has gone, brings the UI back.
import { still } from './turn.js';
import { demoParentOrigin } from './demo-ready.js';

export const ARRIVAL = Object.freeze({ duration: 600, easing: 'ease-in-out' });
export const arrivalFrames = () => [{ opacity: 0 }, { opacity: 1 }];

const finite = v => (Number.isFinite(v) ? v : null);

// Framed by imperfect.computer (the launch site's live product, demo-ready.js): the same sky behind it as on
// Noah's own computer after its lock, from the moment it opens, so the product there looks as it does here.
export function framedByLaunch(win = globalThis.window, doc = globalThis.document) {
  try { return Boolean(win && doc && win.parent !== win && demoParentOrigin(win.location.origin, doc.referrer)); } catch { return false; }
}
function keepFramed({ load, clock }) {
  const root = document.documentElement, now = clock(), times = { epoch: now, touched: null, gone: now };
  const canvas = document.createElement('canvas');
  canvas.className = 'kept-sky';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const handle = { kept: null };
  const fallback = () => { handle.kept?.dispose(); handle.kept = null; canvas.remove(); root.classList.remove('kept-sky'); };
  load().then(({ mountKeptSky }) => {
    handle.kept = mountKeptSky(canvas, times, { clock, onLost: fallback });
    if (!handle.kept) { fallback(); return; }
    handle.kept.frame();
    root.classList.add('kept-sky');
  }).catch(fallback);
  return handle;
}

export function mountArrival(desk = globalThis.imperfectDesk, { load = () => import('./kept-sky.js'), clock = () => Date.now() / 1000, framed = framedByLaunch } = {}) {
  if (!desk?.onLock) return framed() ? keepFramed({ load, clock }) : null;
  const root = document.documentElement;
  let locked = false, times = null, kept = null, canvas = null, turning = [], leaving = null;

  // the canvas, for as long as a lock holds; the kept look only once it has drawn
  function keep() {
    leaving?.cancel(); leaving = null;
    if (canvas) { kept?.times(times); return; }
    canvas = document.createElement('canvas');
    canvas.className = 'kept-sky';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    const mine = canvas;
    const fallback = () => { if (canvas === mine) drop(); };
    load().then(({ mountKeptSky }) => {
      if (canvas !== mine) return; // the lock went while it loaded
      kept = mountKeptSky(canvas, times, { clock, onLost: fallback });
      if (!kept) { fallback(); return; } // no WebGL: the UI's own ground
      kept.frame();
      root.classList.add('kept-sky');
    }).catch(fallback);
  }
  function drop() {
    leaving = null;
    kept?.dispose(); kept = null; canvas?.remove(); canvas = null;
    root.classList.remove('kept-sky');
  }
  function hold(state) {
    locked = true;
    root.classList.add('locked-away');
    for (const a of turning.splice(0)) a.cancel();
    // the same lock again (its touch now known, or gone back to the painting) only gives the sky its times
    times = { epoch: state.epoch, touched: finite(state.touched), gone: null };
    keep();
  }
  function arrive() {
    if (!locked) return;
    locked = false;
    times = { ...times, gone: clock() };
    kept?.times(times);
    // PAM's yes has released the native lock; only now may the UI fade in, as the sky fades from under it.
    const parts = [...document.body.children].filter(el => el !== canvas && el.localName !== 'script');
    root.classList.remove('locked-away');
    if (still() || !canvas) { drop(); return; }
    for (const el of parts) {
      const box = el.getBoundingClientRect();
      if (box.width && box.height) turning.push(el.animate(arrivalFrames(), ARRIVAL));
    }
    turning.forEach(a => a.finished.catch(() => {}).finally(() => { turning = turning.filter(b => b !== a); }));
    // the sky stays whole while the UI comes in over it (the lock's last frame is the window's first), then fades
    const going = leaving = canvas.animate([{ opacity: 1 }, { opacity: 0 }], { ...ARRIVAL, delay: ARRIVAL.duration, fill: 'forwards' });
    going.finished.then(() => { if (leaving === going) drop(); }, () => {});
  }
  desk.onLock(state => (state && Number.isFinite(state.epoch) ? hold(state) : arrive()));
  return { hold, arrive, get kept() { return kept; } };
}
