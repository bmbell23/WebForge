// #236 unit tests. Plain node, no framework:  node windows/tabname.test.js
const assert = require('assert');
const { cleanTabName, MAX_TAB_NAME } = require('./tabname');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

test('trims surrounding whitespace', () => {
  assert.strictEqual(cleanTabName('  Jenkins  '), 'Jenkins');
});

test('empty, whitespace-only and non-strings clear the name', () => {
  assert.strictEqual(cleanTabName(''), null);
  assert.strictEqual(cleanTabName('   \n\t '), null);
  assert.strictEqual(cleanTabName(undefined), null);
  assert.strictEqual(cleanTabName(42), null);
});

test('collapses newlines and tabs to single spaces', () => {
  assert.strictEqual(cleanTabName('a\nb\t\tc'), 'a b c');
  assert.strictEqual(cleanTabName('a \r\n  b'), 'a b');
});

test('caps at the max length', () => {
  assert.strictEqual(MAX_TAB_NAME, 120);
  assert.strictEqual(cleanTabName('x'.repeat(500)).length, 120);
});

test('does not leave a trailing space after the cap', () => {
  const s = 'x'.repeat(119) + ' yyy';
  assert.strictEqual(cleanTabName(s), 'x'.repeat(119));
});

console.log(`${run} tests passed`);
