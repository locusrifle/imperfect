// The launch site supplies the visitor's OS; the remote browser's is the VM's.
export function visitorShopURL(visitor = {}) {
  visitor ||= {};
  const platform = visitor.userAgentData?.platform || visitor.platform || visitor.userAgent || '';
  const agent = `${visitor.userAgentData?.platform || ''} ${visitor.platform || ''} ${visitor.userAgent || ''}`;
  const mobile = visitor.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(agent)
    || (/Mac/i.test(platform) && visitor.maxTouchPoints > 1);
  const os = mobile ? 'mobile' : /Win/i.test(platform) ? 'windows' : /Mac/i.test(platform) ? 'mac' : 'linux';
  return `https://imperfect.computer/shop?os=${os}`;
}
export function initShop({ open, restore, win = globalThis.window }) {
  const show = () => {
    restore();
    void Promise.resolve().then(() => open(visitorShopURL(win.navigator))).catch(() => {});
  };
  win.addEventListener('mac:shop', show);
  return { dispose: () => win.removeEventListener('mac:shop', show) };
}
