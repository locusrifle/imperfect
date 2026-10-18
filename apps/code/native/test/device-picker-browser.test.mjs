// A new session asks which computer only when there is a choice. A hosted
// computer (the demo's: machine.json "hosted") lists only itself, so there it
// never asks; an ordinary install with two computers still does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const MESSAGES = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
// Whether "pick a device" was ever on screen, from now on.
const WATCH = () => {
  window.asked = false;
  new MutationObserver(() => { if (document.querySelector('.agent-choose-title')) window.asked = true; }).observe(document.body, { childList: true, subtree: true });
};

test('on a hosted computer a new session starts there, without asking which device', async () => {
  const fixture = await harnessFixture({ messages: MESSAGES, machines: [{ id: 'vm', name: 'demo', self: true, online: true, reachable: true }] });
  const { page } = fixture;
  try {
    const started = [], modelRequests = [];
    fixture.answer = command => {
      if (command.type === 'tab-new') started.push(command);
      if (command.type === 'models') modelRequests.push(command);
    };
    await page.evaluate(WATCH);
    await page.evaluate(() => harness.newTab());
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.equal(started.length, 1, 'the session started on the one computer');
    assert.equal(await page.evaluate(() => window.asked), false, 'and "pick a device" never showed');
    assert.equal(modelRequests.length, 0, 'the model chooser is not loaded automatically');
    assert.equal(await page.locator('#entry-dialog.centre-box').count(), 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('with two computers a new session still asks which device', async () => {
  const fixture = await harnessFixture({ messages: MESSAGES, machines: [
    { id: 'a', name: 'desktop', self: true, online: true, reachable: true },
    { id: 'b', name: 'laptop', online: true, reachable: true },
  ] });
  const { page } = fixture;
  try {
    const started = [], modelRequests = [];
    fixture.answer = command => {
      if (command.type === 'tab-new') started.push(command);
      if (command.type === 'models') modelRequests.push(command);
    };
    await page.evaluate(() => harness.newTab());
    await page.locator('.agent-choose-title').waitFor();
    assert.equal(await page.locator('.agent-choose-title').textContent(), 'pick a device');
    assert.deepEqual(await page.locator('.agent-choose-option').allTextContents(), ['desktop', 'laptop']);
    assert.equal(started.length, 0, 'nothing starts until one is picked');
    await page.locator('.agent-choose-option').first().click();
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.equal(started.length, 1);
    assert.equal(started[0].model, undefined, 'the device chooses its saved default');
    assert.equal(modelRequests.length, 0, 'picking the device is the only required choice');
    assert.equal(await page.locator('#entry-dialog.centre-box').count(), 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

// Then which harness: Codex, Claude Code, Pi, in that order, starting on the
// one a new tab would be unasked. One that cannot start here says so.
const HARNESSES = [
  { agent: 'pi', ready: true, usual: false },
  { agent: 'claude', ready: true, usual: true },
  { agent: 'codex', ready: false, usual: false, blocked: 'Sign in to Codex in imperfect' },
];

test('with one computer a new session asks only which harness, and starts the one picked', async () => {
  const fixture = await harnessFixture({ messages: MESSAGES, machines: [{ id: 'a', name: 'desktop', self: true, online: true, reachable: true }] });
  const { page } = fixture;
  try {
    const started = [];
    fixture.answer = command => { if (command.type === 'tab-new') started.push(command); };
    fixture.push({ ...fixture.tab, harnesses: HARNESSES });
    await page.waitForFunction(() => true);
    await page.evaluate(WATCH);
    await page.evaluate(() => harness.newTab());
    await page.locator('.agent-choose-title', { hasText: 'pick a harness' }).waitFor();
    assert.equal(await page.evaluate(() => window.asked && !document.querySelector('.agent-choose-option[data-owner]')), true, 'no device question');
    assert.deepEqual(await page.locator('.agent-choose-option').allTextContents(), ['Codex · sign in', 'Claude Code', 'Pi']);
    assert.equal(await page.locator('.agent-choose-option[data-agent="codex"]').isDisabled(), false, 'it offers its sign-in');
    assert.equal(await page.locator('.agent-choose-unready').count(), 1);
    assert.equal(await page.locator('.agent-choose-option[data-agent="codex"]').getAttribute('title'), 'Sign in to Codex in imperfect');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.agent), 'claude', 'enter takes the usual one');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.agent), 'pi');
    assert.equal(started.length, 0, 'nothing starts until one is picked');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.deepEqual(started.map(command => command.agent), ['pi']);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('with two computers a new session asks the device, then the harness; esc goes back to the devices', async () => {
  const fixture = await harnessFixture({ messages: MESSAGES, machines: [
    { id: 'a', name: 'desktop', self: true, online: true, reachable: true },
    { id: 'b', name: 'laptop', online: true, reachable: true },
  ] });
  const { page } = fixture;
  try {
    const started = [];
    fixture.answer = (command, owner) => { if (command.type === 'tab-new') started.push({ ...command, owner }); };
    fixture.push({ ...fixture.tab, harnesses: HARNESSES });
    await page.evaluate(() => harness.newTab());
    await page.locator('.agent-choose-title', { hasText: 'pick a device' }).waitFor();
    await page.locator('.agent-choose-option[data-owner="b"]').click();
    await page.locator('.agent-choose-title', { hasText: 'pick a harness' }).waitFor();
    assert.match(await page.locator('.agent-choose-hint').textContent(), /esc for devices/);
    await page.keyboard.press('Escape');
    await page.locator('.agent-choose-title', { hasText: 'pick a device' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.owner), 'b', 'back on the device picked');
    await page.keyboard.press('Enter');
    await page.locator('.agent-choose-option[data-agent="claude"]').click();
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.deepEqual(started.map(command => [command.agent, command.owner]), [['claude', 'b']]);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
