import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

// The strips where the camera and the gesture bar or buttons are belong to
// the page, which fills them with the bars' dust: the app draws edge to edge
// under clear bars with light icons, and tells the page how tall they are.
test('the app draws under clear bars and hands the page their strips to fill with dust', async () => {
  const theme = await read('../app/src/main/res/values/themes.xml');
  for (const [item, value] of [['statusBarColor', '@android:color/transparent'], ['navigationBarColor', '@android:color/transparent'],
    ['windowLightStatusBar', 'false'], ['windowLightNavigationBar', 'false'], ['windowLayoutInDisplayCutoutMode', 'shortEdges']]) {
    assert.match(theme, new RegExp(`name="android:${item}">${value}<`), item);
  }
  const main = await read('../app/src/main/java/computer/imperfect/code/MainActivity.kt');
  assert.match(main, /WindowCompat\.setDecorFitsSystemWindows\(window, false\)/);
  assert.match(main, /setProperty\('--safe-top','\$\{top\}px'\)/);
  assert.match(main, /setProperty\('--safe-bottom','\$\{bottom\}px'\)/);
  const css = (await read('../../apps/code/native/public/css/imperfect.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.stardust-top \{[^}]*height: var\(--safe-top/);
  assert.match(css, /\.stardust-bottom \{[^}]*height: min\(var\(--safe-bottom/);
});
