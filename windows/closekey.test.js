// #115 tests:  node windows/closekey.test.js
//
// The Ctrl+X handler is duplicated across the three preloads (a sandboxed preload
// cannot require a local file). Two risks follow: the copies drifting apart, and
// the "am I typing?" rule being wrong. This tests BOTH, and it tests the real
// shipped source rather than a re-typed copy — the helper is extracted from each
// preload file and evaluated.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PRELOADS = ['content-preload.js', 'preload.js', 'internal-preload.js'];
// The shared guard function must be byte-identical everywhere; each file's
// install CALL differs (content-preload also binds Ctrl+S for hints, #109),
// so the comparison stops at the function's closing brace.
const START = '// #115/#109: keys that belong to the app';
const END = '\n}';

function extract(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const from = src.indexOf(START);
  assert.notStrictEqual(from, -1, `${file}: guard block is missing entirely`);
  const to = src.indexOf(END, from);
  assert.notStrictEqual(to, -1, `${file}: guard block is unterminated`);
  assert.ok(src.includes('installGuardedKeys({'), `${file}: guard is never installed`);
  return src.slice(from, to + END.length);
}

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

console.log('the three copies stay in sync');

const blocks = PRELOADS.map(extract);
test('all three preloads carry a byte-identical handler', () => {
  for (let i = 1; i < blocks.length; i++) {
    assert.strictEqual(
      blocks[i],
      blocks[0],
      `${PRELOADS[i]} has drifted from ${PRELOADS[0]} — the copies must match`
    );
  }
});

console.log('the "am I typing?" rule (evaluated from the real source)');

// Pull the predicate out of the shipped block and run it for real.
const body = blocks[0];
const editableSrc = body.slice(body.indexOf('const editable ='), body.indexOf('window.addEventListener'));
// eslint-disable-next-line no-eval
const editable = eval(`(() => { ${editableSrc}; return editable; })()`);

const el = (tagName, extra = {}) => ({ tagName, isContentEditable: false, ...extra });

test('typing targets are protected — Cut must still work', () => {
  assert.strictEqual(editable(el('INPUT', { type: 'text' })), true);
  assert.strictEqual(editable(el('INPUT', { type: 'password' })), true);
  assert.strictEqual(editable(el('INPUT', { type: 'search' })), true);
  assert.strictEqual(editable(el('INPUT', { type: 'email' })), true);
  assert.strictEqual(editable(el('INPUT', {})), true, 'an INPUT with no type is a text field');
  assert.strictEqual(editable(el('TEXTAREA')), true);
  assert.strictEqual(editable(el('SELECT')), true);
  assert.strictEqual(editable(el('DIV', { isContentEditable: true })), true, 'rich text editors');
});

test('non-typing targets let Ctrl+X close the tab', () => {
  assert.strictEqual(editable(el('BODY')), false);
  assert.strictEqual(editable(el('DIV')), false);
  assert.strictEqual(editable(el('A')), false);
  assert.strictEqual(editable(el('INPUT', { type: 'checkbox' })), false);
  assert.strictEqual(editable(el('INPUT', { type: 'radio' })), false);
  assert.strictEqual(editable(el('INPUT', { type: 'submit' })), false);
  assert.strictEqual(editable(el('INPUT', { type: 'button' })), false);
  assert.strictEqual(editable(el('INPUT', { type: 'range' })), false);
});

test('handles a missing element without throwing', () => {
  assert.strictEqual(editable(null), false);
  assert.strictEqual(editable(undefined), false);
});

test('input type matching is case-insensitive', () => {
  assert.strictEqual(editable(el('INPUT', { type: 'CHECKBOX' })), false);
  assert.strictEqual(editable(el('INPUT', { type: 'Text' })), true);
});

console.log(`\n${run} tests passed`);
