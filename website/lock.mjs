// The launch page's lock: one field over the galaxy at the very centre, as imperfect OS's lock box draws it
// (desktop/lock: a dot a key, the dots breathing while it checks, going last first when it is wrong), here with the
// site's text font, a small padlock inside it on the right (the unlock button) and a soft shake. No message, no hint.
// The page never knows the passwords: the locker checks them (POST /unlock, locker/site-locks.mjs) and answers with
// the workbench this one opens and a cookie, so a reload does not ask again (GET /unlock answers from the cookie).
// Every answer carries a freshly minted address for the frame (a ticket lasts a minute), so the page asks again just
// before it mounts the frame.

// The workbench a locker answer opens, or null: { id, url } with an https (or loopback http) url and no credentials.
export function workbenchOf(answer) {
  const bench = answer?.ok === true ? answer.workbench : null;
  if (!bench || typeof bench.id !== 'string' || typeof bench.url !== 'string') return null;
  try {
    const url = new URL(bench.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) return null;
    return { id: bench.id, url: url.href };
  } catch { return null; }
}
async function ask(fetcher, init) {
  const response = await fetcher('/unlock', { credentials: 'same-origin', cache: 'no-store', ...init });
  return workbenchOf(await response.json().catch(() => null));
}
// A remembered unlock (the cookie), with a fresh address; null if there is none or the locker cannot be reached.
export const remembered = ({ fetcher = fetch } = {}) => ask(fetcher, { method: 'GET' }).catch(() => null);
// The password, checked by the locker; null for any refusal (wrong, too many tries, unreachable): all look the same.
export const unlock = (password, { fetcher = fetch } = {}) => ask(fetcher, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: String(password) }),
}).catch(() => null);

// The field. onsubmit(password) is called inside the submit event (Enter, the keyboard's Go, the arrow): the gesture.
export function createLock({ screen, form, field, input, dots, reduced, onsubmit, MAX = 16 }) {
  let state = 'idle', wrongTimer = null;
  const show = () => {
    const n = Math.min(input.value.length, MAX);
    while (dots.children.length > n) dots.lastChild.remove();
    while (dots.children.length < n) { const dot = document.createElement('i'); dot.style.setProperty('--i', dots.children.length); dots.append(dot); }
    field.dataset.typed = String(n > 0);
  };
  const set = next => { state = next; form.dataset.state = next; input.readOnly = next !== 'idle'; };
  input.addEventListener('input', () => { if (state === 'idle') show(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (state !== 'idle' || form.hidden) return;
    if (!input.value.trim()) { lock.wrong(); return; } // nothing typed: a shake, nothing sent
    onsubmit(input.value);
  });
  // Anywhere on the lock is the field: a tap brings up the keyboard, a key goes into it.
  screen.addEventListener('click', event => { if (!form.hidden && event.target !== input && !event.target.closest('button')) input.focus({ preventScroll: true }); });
  document.addEventListener('keydown', event => {
    if (form.hidden || state !== 'idle' || event.target === input || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1 && !event.target.closest?.('a, button, input, textarea, select')) input.focus({ preventScroll: true });
  });
  const lock = {
    get state() { return state; },
    show({ focus = true } = {}) { form.hidden = false; set('idle'); show(); if (focus) input.focus({ preventScroll: true }); },
    checking() { set('checking'); },
    // Wrong: the field shakes softly and dims, the dots go, the last first; then it is empty and ready again.
    wrong() {
      clearTimeout(wrongTimer);
      set('wrong');
      const n = dots.children.length;
      [...dots.children].forEach((dot, i) => { dot.style.transitionDelay = `${(n - 1 - i) * 45}ms`; });
      wrongTimer = setTimeout(() => {
        input.value = ''; dots.replaceChildren(); field.dataset.typed = 'false';
        set('idle');
        input.focus({ preventScroll: true });
      }, reduced.matches ? 300 : Math.max(420, n * 45 + 300));
    },
    open() { clearTimeout(wrongTimer); set('open'); },
    leave() { input.blur(); input.value = ''; },
  };
  return lock;
}
