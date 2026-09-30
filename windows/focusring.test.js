// #131 tests:  node windows/focusring.test.js
//
// Round 1 of this ticket had 10 tests here for an F6 cycling ring. The user
// rejected F6 outright, so the ring is gone rather than left as dead code with
// a passing suite around it — a tested function nothing calls is a trap for the
// next reader.
//
// What remains is the one decision main makes: chrome surface or page view.
// It matters because Esc depends on it, and getting it wrong traps the keyboard
// in the sidebar, which is worse than having no keyboard access at all.
const assert = require('assert');
const ring = require('./focusring');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

test('the chrome surfaces are recognised', () => {
  for (const s of ['tabs', 'url', 'bookmarks']) {
    assert.strictEqual(ring.isChromeSurface(s), true, s);
  }
});

test('the page is NOT a chrome surface', () => {
  // main branches on this: chrome surfaces get chrome.webContents.focus(),
  // the page gets activeWc().focus(). Confusing the two sends keys nowhere.
  assert.strictEqual(ring.isChromeSurface(ring.PAGE), false);
  assert.strictEqual(ring.isChromeSurface('page'), false);
});

test('junk is never treated as a chrome surface', () => {
  for (const bad of [undefined, null, '', 'nonsense', 42, {}]) {
    assert.strictEqual(ring.isChromeSurface(bad), false, String(bad));
  }
});

test('Escape always means the page, so focus can never be trapped', () => {
  assert.strictEqual(ring.escapeTarget(), 'page');
  assert.strictEqual(ring.isChromeSurface(ring.escapeTarget()), false);
});

console.log(`\n${run} tests passed`);
