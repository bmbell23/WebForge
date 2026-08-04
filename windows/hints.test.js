// #109 tests:  node windows/hints.test.js
//
// The label generator decides whether hinting is usable at all: a label that is a
// PREFIX of another can never be typed unambiguously, and a duplicate means two
// elements answer to one key. Both are invisible until you try it on a real page.
//
// content-preload.js cannot be `require`d (it pulls in electron and runs against
// a DOM), so the function is extracted from the real shipped source and evaluated
// — the same technique closekey.test.js uses to keep three copies honest.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'content-preload.js'), 'utf8');
const from = src.indexOf("const HINT_ALPHABET");
const to = src.indexOf('const HINT_SELECTOR');
assert.notStrictEqual(from, -1, 'HINT_ALPHABET missing from content-preload.js');
assert.notStrictEqual(to, -1, 'HINT_SELECTOR missing from content-preload.js');
// eslint-disable-next-line no-eval
const { hintLabels, HINT_ALPHABET } = eval(
  `(() => { ${src.slice(from, to)}; return { hintLabels, HINT_ALPHABET }; })()`
);

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const ALPHA = HINT_ALPHABET.length;

console.log('labels are usable');

test('exactly as many labels as targets', () => {
  for (const n of [0, 1, 5, ALPHA, ALPHA + 1, 50, 200]) {
    assert.strictEqual(hintLabels(n).length, n, `wrong count for ${n}`);
  }
});

test('labels are unique — two elements must never share a key', () => {
  for (const n of [5, ALPHA, ALPHA + 3, 97]) {
    const l = hintLabels(n);
    assert.strictEqual(new Set(l).size, l.length, `duplicates at ${n}`);
  }
});

test('NO label is a prefix of another — the ambiguity that breaks typing', () => {
  for (const n of [ALPHA - 1, ALPHA, ALPHA + 1, 60]) {
    const l = hintLabels(n);
    for (const a of l) {
      for (const b of l) {
        if (a !== b) assert.ok(!b.startsWith(a), `"${a}" is a prefix of "${b}" at count ${n}`);
      }
    }
  }
});

test('small pages get single-key labels', () => {
  const l = hintLabels(4);
  assert.deepStrictEqual(l, HINT_ALPHABET.slice(0, 4));
  assert.ok(l.every((x) => x.length === 1));
});

test('busy pages fall back to two keys, uniformly', () => {
  const l = hintLabels(ALPHA + 1);
  assert.ok(l.every((x) => x.length === 2), 'mixing 1- and 2-char labels reintroduces prefixes');
});

test('only home-row keys are used', () => {
  for (const label of hintLabels(80)) {
    for (const ch of label) assert.ok(HINT_ALPHABET.includes(ch), `stray character ${ch}`);
  }
});

test('capacity covers a realistically busy page', () => {
  assert.ok(ALPHA * ALPHA >= 100, 'two-character labels should cover 100+ targets');
});

console.log(`\n${run} tests passed`);
