// #286 tests:  node windows/defineterm.test.js
// The same cases are in server/test_define.py and DefineTermTest.kt.
const assert = require('assert');
const { cleanTerm } = require('./defineterm');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const VALID = [
  ['word', 'word'],
  ['  word  ', 'word'],
  ['"quoted,"', 'quoted'],
  ['(bracketed)', 'bracketed'],
  ['“smart”', 'smart'],
  ['Hello!?', 'Hello'],
  ['end.', 'end'],
  ['ice   cream', 'ice cream'],
  ['ice\n\tcream', 'ice cream'],
  ['don’t', "don't"],
  ['‘tis’', 'tis'],
  ["rock'n'roll", "rock'n'roll"],
  ['well-known', 'well-known'],
  ['-ing', 'ing'],
  ['naïve', 'naïve'],
  ['café', 'café'],
  ['日本語', '日本語'],
  ['route 66', 'route 66'],
  ['a'.repeat(64), 'a'.repeat(64)],
];
const INVALID = [
  '',
  '   ',
  '...',
  '"" ""',
  'a'.repeat(65),
  'two, words',
  'a/b',
  'foo@bar',
  'x=1',
  'The quick brown fox jumps over the lazy dog, then keeps on running far away',
  'tab\u0000bell',
  null,
  undefined,
  42,
];

console.log('words and short phrases');
for (const [input, want] of VALID) {
  test(`${JSON.stringify(input.slice(0, 12))} -> ${JSON.stringify(want.slice(0, 12))}`, () => {
    assert.strictEqual(cleanTerm(input), want);
  });
}

console.log('everything else is not definable');
for (const input of INVALID) {
  test(`${JSON.stringify(typeof input === 'string' ? input.slice(0, 12) : input)} -> null`, () => {
    assert.strictEqual(cleanTerm(input), null);
  });
}

console.log(`\n${run} tests passed`);
