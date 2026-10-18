import test from 'node:test';
import assert from 'node:assert/strict';
import { computerKind, computerChoices } from '../public/js/computer-choice.js';

test('Local and Cloud are always present, with hosted self selected and unavailable Local disabled', () => {
  const rows = computerChoices([{ id: 'vm', name: 'Noah', self: true, hosted: true, home: true }], 'vm');
  assert.deepEqual(rows.map(({ kind, disabled, selected, machine }) => ({ kind, disabled, selected, id: machine?.id })), [
    { kind: 'local', disabled: true, selected: false, id: undefined }, { kind: 'cloud', disabled: false, selected: true, id: 'vm' },
  ]);
});

test('home authority is not cloud; self is selected rather than another home computer', () => {
  const machines = [{ id: 'pc', home: true, reachable: true }, { id: 'laptop', self: true }];
  assert.equal(computerKind(machines[0]), 'local');
  const rows = computerChoices(machines, 'laptop');
  assert.equal(rows[0].machine.id, 'laptop'); assert.equal(rows[0].selected, true);
  assert.equal(rows[0].rows.length, 2); assert.equal(rows[1].disabled, true);
});

test('reachable computers of either kind remain selectable and offline inventory is preserved', () => {
  const machines = [{ id: 'pc', self: true }, { id: 'off', hosted: true, reachable: false }, { id: 'cloud-a', hosted: true, reachable: true }, { id: 'cloud-b', hosted: true, reachable: true }];
  const rows = computerChoices(machines, 'cloud-b');
  assert.equal(rows[0].selected, false); assert.equal(rows[0].machine.id, 'pc');
  assert.equal(rows[1].selected, true); assert.equal(rows[1].machine.id, 'cloud-b');
  assert.deepEqual(rows[1].rows.map(row => row.id), ['off', 'cloud-a', 'cloud-b']);
  assert.equal(computerChoices(machines, 'off')[1].machine.id, 'cloud-a', 'offline is not an execution destination');
});

test('empty inventory shows two disabled kinds, never invented computers', () => {
  assert.deepEqual(computerChoices([], null).map(row => [row.kind, row.disabled, row.selected]), [['local', true, false], ['cloud', true, false]]);
});
