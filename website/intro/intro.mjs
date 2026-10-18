// The website owns the password before the boot and the film afterwards (launch.mjs).
import { createSequence } from '../boot/sequence.mjs?v=mac-2';
const clock = () => window.__introClock ?? performance.now() / 1000;
const boot = createSequence({
  clock, fixed: () => window.__introClock !== undefined,
  wall: () => window.__introWall ?? Date.now() / 1000,
  tell: type => window.dispatchEvent(new CustomEvent('imperfect:intro', {
    detail: { type: type.split(':')[0], at: clock(), contactSeconds: boot.intro.state().tau },
  })),
});
export const { intro, ready, skyReady } = boot;
