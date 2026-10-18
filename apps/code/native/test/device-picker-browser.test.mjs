// The same client-only computer/harness page on every product. Selecting a
// computer never starts a session: only an explicit harness activation does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const MESSAGES = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
const HARNESSES = [
  { agent: 'pi', ready: true, usual: false },
  { agent: 'claude', ready: true, usual: true },
  { agent: 'codex', ready: false, usual: false, blocked: 'Sign in to Codex in imperfect' },
];
const local = { id: 'a', name: 'desktop', self: true, online: true, reachable: true };
const chooser = page => page.locator('.agent-choose');

async function chooseFixture(machines) {
  const f = await harnessFixture({ messages: MESSAGES, machines, snapshot: { harnesses: HARNESSES } });
  f.started = [];
  f.answer = (command, owner) => { if (command.type === 'tab-new') f.started.push({ ...command, owner }); };
  return f;
}

test('hosted computer offers disabled Local and selected Cloud above its real harnesses', async () => {
  const f = await chooseFixture([{ ...local, hosted: true }]); const { page } = f;
  try {
    await page.evaluate(() => harness.newTab());
    assert.deepEqual(await chooser(page).locator('.agent-choose-title').allTextContents(), ['pick a computer', 'pick a harness']);
    assert.deepEqual(await chooser(page).locator('[data-computer]').allTextContents(), ['Local', 'Cloud']);
    assert.equal(await page.locator('[data-computer="local"]').isDisabled(), true);
    assert.equal(await page.locator('[data-computer="cloud"]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.started.length, 0, 'opening the page creates nothing');
    assert.equal(await page.locator('.agent-choose-hint').count(), 0);
    await page.locator('[data-agent="pi"].agent-choose-option').click();
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.deepEqual(f.started.map(command => command.agent), ['pi']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('self is selected, Cloud is disabled when absent, and arrow/Enter keys still choose the usual harness', async () => {
  const f = await chooseFixture([local]); const { page } = f;
  try {
    await page.evaluate(() => harness.newTab());
    assert.equal(await page.locator('[data-computer="local"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-computer="cloud"]').isDisabled(), true);
    assert.deepEqual(await page.locator('.agent-choose-harness').allTextContents(), ['Codex · sign in', 'Claude Code', 'Pi']);
    assert.equal(await page.locator('.agent-choose-harness[data-agent="codex"]').isDisabled(), false);
    assert.equal(await page.locator('.agent-choose-harness[data-agent="codex"]').getAttribute('title'), 'Sign in to Codex in imperfect');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.agent), 'claude');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.agent), 'pi');
    assert.equal(f.started.length, 0);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.deepEqual(f.started.map(command => command.agent), ['pi']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('another reachable computer of the same kind stays selectable, offline computers are disabled', async () => {
  const f = await chooseFixture([local,
    { id: 'b', name: 'laptop', online: true, reachable: true },
    { id: 'c', name: 'offline', online: false, reachable: false },
  ]); const { page } = f;
  try {
    await page.evaluate(() => harness.newTab());
    assert.equal(await page.locator('select[aria-label="Local computer"]').inputValue(), 'a', 'self, not home or the previously focused owner');
    assert.equal(await page.locator('.agent-choose-machine option[value="c"]').isDisabled(), true);
    await page.locator('.agent-choose-machine').selectOption('b');
    await page.waitForFunction(() => document.querySelector('.agent-choose-harness[data-agent="claude"]') && document.querySelector('.agent-choose-machine')?.value === 'b');
    assert.equal(f.started.length, 0, 'selecting the execution owner creates nothing');
    await page.locator('.agent-choose-harness[data-agent="claude"]').click();
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.deepEqual(f.started.map(command => [command.agent, command.owner]), [['claude', 'b']]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Cloud selection changes the destination on the same page; Escape cancels without creating a tab', async () => {
  const f = await chooseFixture([local, { id: 'vm', name: 'cloud', hosted: true, reachable: true }]); const { page } = f;
  try {
    await page.evaluate(() => harness.newTab());
    await page.locator('[data-computer="cloud"]').click();
    await page.waitForFunction(() => document.querySelector('[data-computer="cloud"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(f.started.length, 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.equal(f.started.length, 0);
    await page.evaluate(() => harness.newTab());
    await page.locator('[data-computer="cloud"]').click();
    await page.locator('.agent-choose-harness[data-agent="claude"]').click();
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.deepEqual(f.started.map(command => [command.agent, command.owner]), [['claude', 'vm']]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a single harness still needs an explicit start; opening a bare chooser never auto-creates a tab', async () => {
  const f = await harnessFixture({ messages: MESSAGES, machines: [local], snapshot: { harnesses: [{ agent: 'pi', ready: true }] } });
  try {
    await f.page.evaluate(() => harness.newTab());
    await f.page.locator('.agent-choose-harness[data-agent="pi"]').waitFor();
    assert.equal(f.commands.some(command => command.type === 'tab-new'), false);
    await f.page.locator('.agent-choose-harness[data-agent="pi"]').click();
    await f.page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.equal(f.commands.filter(command => command.type === 'tab-new').length, 1);
  } finally { await f.close(); }
});
