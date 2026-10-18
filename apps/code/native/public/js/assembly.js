// Only the launch site's real, ticketed product may be assembled. No model,
// session, files or credentials leave the frame: just painted step names and
// empty-titlebar pointer coordinates.
import { demoParentOrigin } from './demo-ready.js';
import { framedByLaunch, phoneByLaunch } from './arrival.js';

export const ASSEMBLY_STEPS = Object.freeze(['bare', 'claude', 'codex', 'files', 'browser', 'done']);
export function mountAssembly({ apply, win = globalThis.window, doc = globalThis.document } = {}) {
  if (!framedByLaunch(win, doc)) return null;
  const origin = demoParentOrigin(win.location.origin, doc.referrer);
  let current = -1, finished = false;
  const receive = event => {
    if (event.source !== win.parent || event.origin !== origin || event.data?.type !== 'imperfect:assemble') return;
    const next = ASSEMBLY_STEPS.indexOf(event.data.step);
    if (next < 0 || next < current || finished && next !== current) return;
    const changed = next > current;
    current = next;
    finished = event.data.step === 'done';
    if (changed) apply(event.data.step);
    // Duplicate requests may recover a lost acknowledgment, but never replay
    // a pane opening. Superseded paints must not claim an earlier appearance.
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
      if (current === next) win.parent.postMessage({ type: 'imperfect:assembled', step: ASSEMBLY_STEPS[next] }, origin);
    }));
  };
  win.addEventListener('message', receive);
  doc.documentElement.classList.add(phoneByLaunch(win, doc) ? 'launch-phone' : 'launch-framed');
  return { dispose: () => win.removeEventListener('message', receive) };
}

export function mountLaunchDrag({ win = globalThis.window, doc = globalThis.document } = {}) {
  if (!framedByLaunch(win, doc) || phoneByLaunch(win, doc)) return null;
  const origin = demoParentOrigin(win.location.origin, doc.referrer);
  let pointer = null;
  const send = (phase, event) => win.parent.postMessage({ type: 'imperfect:window-drag', phase, x: event.clientX, y: event.clientY }, origin);
  const down = event => {
    const top = Number.parseFloat(win.getComputedStyle(doc.getElementById('entry-terminal')).getPropertyValue('--focus-top')) || 38;
    if (event.button !== 0 || event.clientY < 0 || event.clientY > top || event.target.closest?.('button, a, input, select, textarea, [contenteditable], [role="button"], [role="menu"]')) return;
    pointer = event.pointerId;
    doc.documentElement.setPointerCapture(pointer);
    event.preventDefault();
    send('start', event);
  };
  const move = event => { if (event.pointerId === pointer) send('move', event); };
  const end = event => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    send('end', event);
    if (doc.documentElement.hasPointerCapture(event.pointerId)) doc.documentElement.releasePointerCapture(event.pointerId);
  };
  doc.addEventListener('pointerdown', down);
  doc.addEventListener('pointermove', move);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) doc.addEventListener(type, end);
  return { dispose() {
    doc.removeEventListener('pointerdown', down); doc.removeEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) doc.removeEventListener(type, end);
  } };
}
