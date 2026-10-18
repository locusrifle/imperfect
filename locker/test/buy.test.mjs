import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { openStore, KEY_PATTERN } from '../store.mjs';
import { createLockerServer } from '../server.mjs';

// The buy page: renting is open only when billing is configured; the code is US$150 once through the store's own
// checkout (POST /buy), open only when its price is configured. Signing up gives no key.
async function boot({ rentPrice = '', webhookSecret = '', price = '' } = {}) {
  const store = openStore();
  const stripe = rentPrice || price ? { checkoutSession: async () => ({}), retrieveSession: async () => ({}) } : null;
  const app = await createLockerServer({
    store, stripe, mail: { configured: false, async send() {} },
    config: { secure: false, hosts: 'shop.test', stripe: { rentPrice, webhookSecret, price } },
    productDir: '', websiteDir: fileURLToPath(new URL('../../website/', import.meta.url)), port: 0,
    log: { info() {}, warn() {}, error() {} },
  });
  const address = await app.listen();
  const call = (path, host = 'shop.test') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, headers: { host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: async () => Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  return { app, store, call, close: () => app.close().then(() => store.close()) };
}

test('the buy page keeps renting closed until a rental price and webhook secret are configured', async () => {
  const closed = await boot();
  try {
    const page = await (await closed.call('/buy')).text();
    assert.match(page, /data-billing="closed"/);
    assert.match(page, /Monthly billing is not open yet/);
    assert.match(page, /data-code="closed"/);
    assert.doesNotMatch(page, /free code|Sign up for the free/i);
    assert.equal(page.match(/<h1\b/gi).length, 1);
  } finally { await closed.close(); }
  const open = await boot({ rentPrice: 'price_rent', webhookSecret: 'whsec_test' });
  try {
    const page = await (await open.call('/buy')).text();
    assert.match(page, /data-billing="open"/);
    assert.match(page, /Rent your computer/);
  } finally { await open.close(); }
});

test('the old rent address moves to the buy page', async () => {
  const { app, call, close } = await boot();
  try {
    const moved = await call('/rent.html');
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.location, '/buy');
  } finally { await close(); }
});

test('the code is US$150 once: the buy page posts to the store checkout when its price is configured', async () => {
  const open = await boot({ price: 'price_code' });
  try {
    const page = await (await open.call('/buy')).text();
    assert.match(page, /data-code="open"/);
    assert.match(page, /US\$150 <span>once<\/span>/);
    assert.match(page, /<form method="post" action="\/buy"><button class="button" type="submit">Buy the code/);
    assert.equal(open.store.issueAccountCode, undefined, 'no free keys');
  } finally { await open.close(); }
});
