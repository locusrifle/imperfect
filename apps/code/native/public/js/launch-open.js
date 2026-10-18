// A launch-site click may open only the public Shop, never an arbitrary URL.
import { demoParentOrigin } from './demo-ready.js';
import { framedByLaunch, phoneByLaunch } from './arrival.js';

const SHOP = 'https://imperfect.computer/shop';
const OS = new Set(['mac', 'linux', 'windows', 'mobile']);
export function launchShopURL(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value), keys = [...url.searchParams.keys()], os = url.searchParams.get('os');
    if (url.origin !== 'https://imperfect.computer' || url.pathname !== '/shop' || url.username || url.password || url.hash
        || keys.length > 1 || keys.some(key => key !== 'os') || (keys.length && !OS.has(os))) return null;
    const canonical = SHOP + (os ? `?os=${os}` : '');
    return value === canonical ? canonical : null;
  } catch { return null; }
}
const shopTab = tab => {
  try {
    const url = new URL(tab.url);
    return url.origin === 'https://imperfect.computer' && !url.username && !url.password && ['/shop', '/shop/thanks'].includes(url.pathname);
  } catch { return false; }
};
export async function prepareLaunchShop(ask, value, remember = { tab: null }) {
  const url = launchShopURL(value);
  if (!url) throw new Error('Only the public Shop can be opened by the launch site');
  const { tabs } = await ask({ do: 'tabs' });
  if (!Array.isArray(tabs)) throw new Error('The browser did not return its tabs');
  let target = tabs.find(tab => tab.tab === remember.tab) ?? tabs.find(shopTab);
  if (target && (!Number.isSafeInteger(target.tab) || target.tab <= 0)) throw new Error('The browser did not return its tab');
  if (!target || target.url !== url) target = await ask({ do: 'open', url, ...(target ? { tab: target.tab } : {}) });
  if (!Number.isSafeInteger(target?.tab) || target.tab <= 0) throw new Error('The browser did not return its tab');
  remember.tab = target.tab;
  await ask({ do: 'front', tab: target.tab });
  return target.tab;
}
export function mountLaunchOpen({ open, canOpen = () => true, onError = () => {}, win = globalThis.window, doc = globalThis.document } = {}) {
  if (!framedByLaunch(win, doc) || phoneByLaunch(win, doc)) return null;
  const origin = demoParentOrigin(win.location.origin, doc.referrer);
  let pending = null;
  const receive = event => {
    if (event.source !== win.parent || event.origin !== origin || event.data?.type !== 'imperfect:open' || !canOpen()) return;
    const url = launchShopURL(event.data.url);
    if (!url || pending) return;
    pending = Promise.resolve().then(() => open(url)).catch(onError).finally(() => { pending = null; });
  };
  win.addEventListener('message', receive);
  return { dispose: () => win.removeEventListener('message', receive) };
}
