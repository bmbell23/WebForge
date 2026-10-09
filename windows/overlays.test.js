// #170 unit tests. Plain node, no framework:  node windows/overlays.test.js
const assert = require('assert');
const { OPEN_SELECTOR, anyOpen, staleFlags, confirmStale } = require('./overlays');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const none = { bmDialog: false, loginPrompt: false, ytdlp: false, outfit: false, quick: false };

test('nothing open, nothing stale', () => {
  assert.strictEqual(anyOpen(none), false);
  assert.deepStrictEqual(staleFlags(none, []), []);
});

test('a flag the UI is showing is not stale', () => {
  const f = { ...none, loginPrompt: true };
  assert.strictEqual(anyOpen(f), true);
  assert.deepStrictEqual(staleFlags(f, ['loginprompt']), []);
});

test('a flag the UI dropped is stale: the invisible layer over every click', () => {
  const f = { ...none, loginPrompt: true, quick: true };
  assert.deepStrictEqual(staleFlags(f, ['quick']), ['loginPrompt']);
  assert.deepStrictEqual(staleFlags(f, []).sort(), ['loginPrompt', 'quick']);
});

test('flags without a known dialog element are never judged', () => {
  assert.deepStrictEqual(staleFlags({ settings: true, manager: true }, []), []);
});

test('one stale sighting waits; the second in a row heals', () => {
  let r = confirmStale(['ytdlp'], undefined);
  assert.deepStrictEqual(r.heal, []);
  r = confirmStale(['ytdlp'], r.pending);
  assert.deepStrictEqual(r.heal, ['ytdlp']);
});

test('a flag that recovers between checks is not healed', () => {
  let r = confirmStale(['outfit'], undefined);
  r = confirmStale([], r.pending);
  assert.deepStrictEqual(r.heal, []);
  r = confirmStale(['outfit'], r.pending);
  assert.deepStrictEqual(r.heal, []);
});

test('the selector names every dialog', () => {
  assert.strictEqual(OPEN_SELECTOR, '#bmdialog.open,#loginprompt.open,#ytdlp.open,#outfit.open,#quick.open');
});

console.log(`overlays: ${run} tests passed`);
