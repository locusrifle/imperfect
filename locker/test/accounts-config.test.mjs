import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
test('the full suite limits Node concurrency before positional test files', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  // Node stops parsing its own options at the first file. npm appends extra
  // flags after the globs. Pulse deliberately makes the full gate serial to
  // avoid overlapping Electron/Chromium-heavy files; keep that bound here,
  // never relying on a trailing override that Node will ignore.
  assert.match(scripts.test, /^node --test --test-concurrency=1 apps\//);
});

const start = new URL('../start.mjs', import.meta.url).href;
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'accounts-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const credentials = join(home, '.imperfect', 'credentials');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  const load = async (settings = {}) => {
    // An isolated HOME is essential: this must never read real credentials,
    // even though production deliberately ignores IMPERFECT_PREFIX for keys.
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
      import { loadConfig } from ${JSON.stringify(start)};
      try {
        const c = await loadConfig();
        console.log(JSON.stringify({
          keys: Object.keys(c.accounts).sort(),
          signer: !!c.accounts.signerPrivateKey, operator: !!c.accounts.operatorToken,
          base: c.accounts.base,
        }));
      } catch (e) { console.log(JSON.stringify({ error: e.message })); }
    `], { env: { HOME: home, PATH: process.env.PATH, IMPERFECT_PREFIX: join(home, 'state'),
      LOCKER_ENV: join(home, 'absent.env'), ...settings } });
    return JSON.parse(stdout.trim());
  };
  return { home, credentials, load };
}

test('password accounts need no credential setup; signer and operator are never accepted inline', async t => {
  const { load } = await fixture(t);
  assert.deepEqual(await load({ ACCOUNTS_SIGNING_KEY: 'synthetic-inline-key',
    ACCOUNTS_OPERATOR_TOKEN: 'synthetic-inline-token-at-least-32-characters' }), {
    keys: ['base', 'operatorToken', 'signerPrivateKey'], signer: false, operator: false, base: 'https://imperfect.computer',
  });
});

test('all documented account credential file defaults load from isolated HOME, not state', async t => {
  const { credentials, load } = await fixture(t);
  for (const [name, value] of Object.entries({
    'accounts-signing-key.pem': 'synthetic-presence-only-key',
    'accounts-operator-token': 'synthetic-operator-value-at-least-32-characters',
  })) await writeFile(join(credentials, name), value + '\n', { mode: 0o600 });
  assert.deepEqual(await load(), {
    keys: ['base', 'operatorToken', 'signerPrivateKey'], signer: true, operator: true, base: 'https://imperfect.computer',
  });
});

test('account files reject outside paths, escaped symlinks, public permissions and short operators', async t => {
  const { home, credentials, load } = await fixture(t);
  const outside = join(home, 'outside');
  await writeFile(outside, 'synthetic-only', { mode: 0o600 });
  assert.match((await load({ ACCOUNTS_SIGNING_KEY_FILE: outside })).error, /inside/);
  await symlink(outside, join(credentials, 'escape'));
  assert.match((await load({ ACCOUNTS_SIGNING_KEY_FILE: join(credentials, 'escape') })).error, /outside/);
  const id = join(credentials, 'accounts-signing-key.pem');
  await writeFile(id, 'synthetic-id', { mode: 0o600 });
  await chmod(id, 0o644);
  assert.match((await load()).error, /private regular/);
  await chmod(id, 0o600);
  await writeFile(join(credentials, 'accounts-operator-token'), 'short-synthetic-value', { mode: 0o600 });
  assert.match((await load()).error, /at least 32/);
});
