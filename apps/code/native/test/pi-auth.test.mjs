import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAuth } from '../auth.mjs';
import { SOURCES, canonicalSnapshot } from '../canonical.mjs';

const settle = async auth => {
  for (let i = 0; i < 200; i++) {
    if (!auth.busy) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Auth did not settle');
};

test('old Pi Anthropic credentials can be removed, but no new Anthropic login is offered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-auth-'));
  const env = { ...process.env };
  let auth;
  try {
    await writeFile(join(root, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'fixture-old-unused-key' } }));
    const models = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json') });
    // Keep native provider login/storage, but forbid network catalog requests.
    models.refresh = async () => ({ aborted: false, errors: new Map() });
    auth = createAuth({ models: () => models, changed() {}, assertIdle() {} });
    assert.ok(!auth.providers().some(p => p.id === 'anthropic'));
    assert.ok(auth.providers().some(p => p.id === 'claude-agent'));
    assert.ok(auth.providers().some(p => p.id === 'codex' && p.methods.some(m => m.subscription)));
    for (const method of ['oauth', 'api_key']) assert.throws(() => auth.login('anthropic', method), /Unknown/);
    assert.match((await auth.accounts()).find(p => p.id === 'anthropic').name, /NOT USED/);
    assert.ok(!JSON.stringify(auth.snapshot()).includes('fixture-old-unused-key'));
    await auth.logout('anthropic');
    await settle(auth);
    assert.equal(auth.snapshot().status, 'success');
    assert.deepEqual(await models.listCredentials(), []);
    await assert.rejects(auth.logout('anthropic'), /No stored/);
    assert.deepEqual({ ...process.env }, env);
  } finally {
    await auth?.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test('canonical execution accepts Pi, Claude and Codex and never relabels other sources', () => {
  assert.deepEqual(SOURCES, ['pi', 'claude', 'codex']);
  assert.equal(canonicalSnapshot().source, 'pi');
  assert.equal(canonicalSnapshot({}, 'claude').source, 'claude');
  assert.equal(canonicalSnapshot({}, 'codex').source, 'codex');
  assert.throws(() => canonicalSnapshot({}, 'gemini'), /Unsupported execution source/);
  assert.throws(() => canonicalSnapshot({ source: 'gemini' }), /Unsupported execution source/);
  assert.throws(() => canonicalSnapshot({ source: 'gemini' }, 'pi'), /Unsupported execution source/);
});
