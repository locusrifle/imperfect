// The launch page fades in the actual demo only after its conversation has
// connected and the product has painted. No files, model state or tokens cross
// this boundary. Private computers and unknown embedders never announce it.
const PARENTS = new Set(['https://imperfect.computer', 'https://www.imperfect.computer']);
// The open demo, and the launch page's workbenches: each its own imperfect at https://<id>.noah.imperfect.computer,
// which the site's lock opens in its frame.
const DEMOS = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?noah\.imperfect\.computer$/;

export function demoParentOrigin(origin, referrer) {
  if (!DEMOS.test(String(origin))) return null;
  try {
    const parent = new URL(referrer).origin;
    return PARENTS.has(parent) ? parent : null;
  } catch { return null; }
}

export async function notifyDemoReady(ready, { win = globalThis.window, doc = globalThis.document } = {}) {
  if (!win || !doc || win.parent === win || !ready || typeof ready.then !== 'function') return false;
  const origin = demoParentOrigin(win.location.origin, doc.referrer);
  if (!origin) return false;
  try {
    await ready;
    // Snapshot handling renders synchronously and may schedule layout work.
    // Let that work paint before announcing an interactive product, not HTML.
    await new Promise(done => win.requestAnimationFrame(() => win.requestAnimationFrame(done)));
    if (!doc.getElementById('entry-input') || !doc.getElementById('entry-output')) return false;
    win.parent.postMessage({ type: 'imperfect:demo-ready' }, origin);
    return true;
  } catch { return false; }
}
