// #317 unit tests. Plain node, no framework:  node windows/graphics.test.js
const assert = require('assert');
const { disableDirectComposition } = require('./graphics');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

test('never chosen (Brandon\'s PC logs setting=undefined): Chromium default, no switch', () => {
  assert.strictEqual(disableDirectComposition({}), false);
  assert.strictEqual(disableDirectComposition({ directComposition: undefined }), false);
});

test('no settings file at all: Chromium default', () => {
  assert.strictEqual(disableDirectComposition(null), false);
});

test('"Flicker fix on" chosen explicitly: switch applied', () => {
  assert.strictEqual(disableDirectComposition({ directComposition: false }), true);
});

test('"Off (Chromium default)" chosen: no switch', () => {
  assert.strictEqual(disableDirectComposition({ directComposition: true }), false);
});

console.log(`graphics: ${run} tests passed`);
