// #113/#114 unit tests. Plain node, no framework:  node windows/tabnav.test.js
const assert = require('assert');
const { nextInOrder, mostRecent } = require('./tabnav');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

console.log('nextInOrder (Ctrl+Shift+Tab)');

test('steps forward and wraps', () => {
  const list = [1, 2, 3];
  assert.strictEqual(nextInOrder(list, 1, 1), 2);
  assert.strictEqual(nextInOrder(list, 2, 1), 3);
  assert.strictEqual(nextInOrder(list, 3, 1), 1);
});

test('steps backward and wraps', () => {
  const list = [1, 2, 3];
  assert.strictEqual(nextInOrder(list, 1, -1), 3);
  assert.strictEqual(nextInOrder(list, 3, -1), 2);
});

test('visits every tab exactly once per lap — the #114 symptom', () => {
  // The reported bug was Ctrl+Tab "going all over the place". With a STABLE
  // list, stepping must be a clean permutation: N presses, N distinct tabs.
  const list = [10, 20, 30, 40];
  let at = 10;
  const seen = [];
  for (let i = 0; i < list.length; i++) {
    at = nextInOrder(list, at, 1);
    seen.push(at);
  }
  assert.deepStrictEqual(seen.sort(), [10, 20, 30, 40]);
  assert.strictEqual(at, 10, 'a full lap returns to the start');
});

test('a list that shrinks mid-lap DOES skip — proving why #114 matters', () => {
  // This is the old behaviour, kept as a regression witness: if activateTab
  // disposes of the departed new-tab page, the next step is computed against a
  // shorter list and a tab is silently skipped. The fix is to stop mutating.
  let list = [1, 2, 3, 4];
  let at = nextInOrder(list, 1, 1); // -> 2
  list = list.filter((id) => id !== 1); // tab 1 disposed of behind us
  at = nextInOrder(list, at, 1); // [2,3,4] from 2 -> 3
  list = list.filter((id) => id !== 2);
  at = nextInOrder(list, at, 1); // [3,4] from 3 -> 4
  list = list.filter((id) => id !== 3);
  assert.deepStrictEqual(list, [4], 'three tabs vanished during one lap');
});

test('does nothing with fewer than two tabs', () => {
  assert.strictEqual(nextInOrder([7], 7, 1), null);
  assert.strictEqual(nextInOrder([], null, 1), null);
});

test('active tab missing from the list falls back to the first', () => {
  assert.strictEqual(nextInOrder([1, 2, 3], 99, 1), 2);
});

console.log('mostRecent (Ctrl+Tab flip)');

const stamps = (obj) => ({ get: (id) => obj[id] });

test('flips between the two most recent, repeatedly', () => {
  const list = [1, 2, 3];
  // 2 used most recently, then 1 (active), then 3 long ago.
  let at = 1;
  const t = { 1: 300, 2: 200, 3: 100 };
  const b = mostRecent(list, at, stamps(t));
  assert.strictEqual(b, 2);
  // Activating 2 stamps it newest; flipping back must return to 1.
  t[2] = 400;
  assert.strictEqual(mostRecent(list, 2, stamps(t)), 1);
  t[1] = 500;
  assert.strictEqual(mostRecent(list, 1, stamps(t)), 2, 'and back again');
});

test('a third tab becomes the flip target once used', () => {
  const list = [1, 2, 3];
  const t = { 1: 500, 2: 400, 3: 600 }; // just came from 3
  assert.strictEqual(mostRecent(list, 1, stamps(t)), 3);
});

test('a closed flip target falls through to the next most recent', () => {
  const list = [1, 3]; // tab 2 (the most recent) has been closed
  const t = { 1: 500, 2: 900, 3: 400 };
  assert.strictEqual(mostRecent(list, 1, stamps(t)), 3);
});

test('never returns the active tab', () => {
  const list = [1, 2, 3];
  const t = { 1: 999, 2: 1, 3: 2 }; // active tab has the newest stamp
  assert.notStrictEqual(mostRecent(list, 1, stamps(t)), 1);
});

test('is defined even with no timestamps at all', () => {
  assert.strictEqual(mostRecent([1, 2, 3], 1, stamps({})), 2);
});

test('does nothing when the active tab is alone', () => {
  assert.strictEqual(mostRecent([5], 5, stamps({ 5: 1 })), null);
  assert.strictEqual(mostRecent([], null, stamps({})), null);
});

console.log(`\n${run} tests passed`);
