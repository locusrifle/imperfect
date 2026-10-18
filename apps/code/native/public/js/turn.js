// A new look opens from the middle in a slanted band (the store's wallpaper change: 420ms, in-out cubic), over
// the old look held still beneath it. A theme, a session and imperfect coming in over its sky as the lock goes
// all turn this one way. Where the browser cannot hold the old look (no view transitions) or motion is
// unwelcome, it simply changes.
export const OPEN = [
  { clipPath: 'polygon(calc(50% + 9vh) 0, calc(50% + 9vh) 0, calc(50% - 9vh) 100%, calc(50% - 9vh) 100%)' },
  { clipPath: 'polygon(-4px 0, calc(100% + 18vh + 4px) 0, calc(100% + 4px) 100%, calc(-18vh - 4px) 100%)' },
];
export const OPENING = { duration: 420, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' };
export const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Over the kept sky (arrival.js) the panels let the sky through, so the old look cannot lie under the new: it is
// drawn only outside the band, the band's own edges, for a part w x h px (the window's height gives the vh).
export function outsideBand(w, h, vh = innerHeight / 100) {
  const ring = `M-10 -10 H${w + 10} V${h + 10} H-10 Z`;
  const band = pts => `path(evenodd, '${ring} M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')} Z')`;
  return [
    { clipPath: band([[w / 2 + 9 * vh, 0], [w / 2 + 9 * vh, 0], [w / 2 - 9 * vh, h], [w / 2 - 9 * vh, h]]) },
    { clipPath: band([[-4, 0], [w + 18 * vh + 4, 0], [w + 4, h], [-18 * vh - 4, h]]) },
  ];
}

// `kind` is the class <html> wears while it turns (imperfect.css holds the old look still under it); `part` is
// the view-transition name that opens, the whole window unless a stylesheet names a smaller one. Returns the
// transition, or null when the change was simply made. `el` is the part's element, if it is not the window.
const turning = new Map();
export function turn(kind, update, part = 'root', el = null) {
  if (typeof document.startViewTransition !== 'function' || still()) { update(); return null; }
  const html = document.documentElement, kept = html.classList.contains('kept-sky');
  // over the kept sky the window's UI turns, not the whole page: the sky beneath it is never captured, so it
  // stays live through the turn (imperfect.css names #canvas 'kept-ui' and the root nothing)
  if (kept && part === 'root') { part = 'kept-ui'; el = document.getElementById('canvas'); }
  turning.set(kind, (turning.get(kind) ?? 0) + 1);
  html.classList.add(kind);
  const transition = document.startViewTransition(update);
  // A turn skipped for the next (a quick second change) is not an error.
  transition.ready.then(() => {
    html.animate(OPEN, { ...OPENING, pseudoElement: `::view-transition-new(${part})` });
    if (!kept) return;
    const box = el?.getBoundingClientRect() ?? { width: innerWidth, height: innerHeight };
    html.animate(outsideBand(box.width, box.height), { ...OPENING, pseudoElement: `::view-transition-old(${part})` });
  }).catch(() => {});
  transition.finished.catch(() => {}).finally(() => {
    turning.set(kind, turning.get(kind) - 1);
    if (!turning.get(kind)) html.classList.remove(kind);
  });
  return transition;
}
