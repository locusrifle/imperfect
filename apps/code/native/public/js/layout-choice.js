// Per serving computer/origin, written only by the person's layout chord.
// Old browser reloads saved scrolling automatically, before focus was offered.
export const LAYOUT_CHOICE = 'imperfect.layout-choice';
export const LAYOUTS = ['focus', 'scrolling', 'dwindle'];
export function initialLayout(choice, restored, native = false) {
  if (LAYOUTS.includes(choice)) return choice;
  if (native && LAYOUTS.includes(restored)) return restored;
  return 'focus';
}
