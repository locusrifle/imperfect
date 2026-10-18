// Inventory, not the URL or the home/authority flag, says whether a computer
// is hosted. Home can equally be someone's own always-on PC.
export const computerKind = machine => machine.hosted === true ? 'cloud' : 'local';
export function computerChoices(machines, owner) {
  return ['local', 'cloud'].map(kind => {
    const rows = machines.filter(machine => computerKind(machine) === kind);
    const usable = rows.filter(machine => machine.self || machine.reachable);
    const selected = rows.find(machine => machine.id === owner);
    const machine = selected && usable.includes(selected) ? selected : usable.find(machine => machine.self) ?? usable[0];
    return { kind, rows, machine, disabled: !machine, selected: Boolean(selected) };
  });
}
