// #170 round 2 unit tests. Plain node, no framework:  node windows/hangwatch.test.js
const assert = require('assert');
const { stallTracker, navTracker, probeState } = require('./hangwatch');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

test('a punctual interval is not a stall', () => {
  const s = stallTracker(1000, 5000);
  assert.strictEqual(s.tick(0), 0);
  assert.strictEqual(s.tick(1000), 0);
  assert.strictEqual(s.tick(2100), 0);
});

test('a blocked main thread reports its lag once it runs again', () => {
  const s = stallTracker(1000, 5000);
  s.tick(0);
  assert.strictEqual(s.tick(61000), 60000);
  assert.strictEqual(s.tick(62000), 0);
});

test('reset (e.g. after sleep/resume) forgives the gap', () => {
  const s = stallTracker(1000, 5000);
  s.tick(0);
  s.reset(3600000);
  assert.strictEqual(s.tick(3601000), 0);
});

test('a navigation that finishes is never reported', () => {
  const n = navTracker();
  n.start(1, 'https://a', 0);
  n.end(1);
  assert.deepStrictEqual(n.overdue(60000, 30000), []);
});

test('a navigation that never finishes is reported once', () => {
  const n = navTracker();
  n.start(7, 'https://jira', 0);
  assert.deepStrictEqual(n.overdue(10000, 30000), []);
  assert.deepStrictEqual(n.overdue(31000, 30000), [{ id: 7, url: 'https://jira', ageMs: 31000 }]);
  assert.deepStrictEqual(n.overdue(90000, 30000), []);
});

test('a new navigation in the same tab replaces the old one', () => {
  const n = navTracker();
  n.start(2, 'https://old', 0);
  n.start(2, 'https://new', 20000);
  assert.deepStrictEqual(n.overdue(40000, 30000), []);
  assert.strictEqual(n.size(), 1);
});

test('probe logs only flips, and stays quiet on a healthy start', () => {
  const p = probeState();
  assert.strictEqual(p(true), null);
  assert.strictEqual(p(true), null);
  assert.strictEqual(p(false, 'timeout 10000ms'), 'failing timeout 10000ms');
  assert.strictEqual(p(false, 'timeout 10000ms'), null);
  assert.strictEqual(p(true, 'after 3 min'), 'recovered after 3 min');
});

test('probe failing from the very first check is logged', () => {
  assert.strictEqual(probeState()(false, 'x'), 'failing x');
});

console.log(`hangwatch: ${run} tests passed`);
