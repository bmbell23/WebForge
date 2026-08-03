// #125 tests:  node windows/popuprule.test.js
const assert = require('assert');
const { wantsRealWindow } = require('./popuprule');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const win = (features, frameName = '', disposition = 'new-window') =>
  wantsRealWindow({ features, frameName, disposition });

console.log('the reported regression — these must be TABS');

test('the standard safe-link idiom is not a popup', () => {
  assert.strictEqual(win('noopener', '_blank'), false);
  assert.strictEqual(win('noreferrer', '_blank'), false);
  assert.strictEqual(win('noopener,noreferrer', '_blank'), false);
});

test('a NAMED window with no geometry is not a popup', () => {
  assert.strictEqual(win('', 'someName'), false);
  assert.strictEqual(win('noopener', 'reportWindow'), false);
});

test('no features at all is not a popup', () => {
  assert.strictEqual(win(''), false);
  assert.strictEqual(win(undefined), false);
  assert.strictEqual(win(null, '_blank', 'foreground-tab'), false);
});

test('cosmetic-only features are not geometry', () => {
  assert.strictEqual(win('menubar=no,toolbar=no,location=no'), false);
  assert.strictEqual(win('scrollbars=yes,resizable=yes'), false);
});

console.log('real popups — these must stay WINDOWS (#111 terminal launcher)');

test('explicit geometry means a popup', () => {
  assert.strictEqual(win('width=500,height=400'), true);
  assert.strictEqual(win('width=800'), true);
  assert.strictEqual(win('height=600'), true);
  assert.strictEqual(win('menubar=no,width=500,height=400,resizable=yes'), true);
});

test('an explicit popup flag means a popup', () => {
  assert.strictEqual(win('popup=1'), true);
  assert.strictEqual(win('popup=yes'), true);
  assert.strictEqual(win('popup=true'), true);
  assert.strictEqual(win('popup'), true, 'a bare flag counts as set');
});

test('geometry survives odd spacing and case', () => {
  assert.strictEqual(win(' WIDTH = 500 , HEIGHT = 400 '), true);
});

console.log('degenerate geometry is not a popup request');

test('zero or unparseable sizes do not qualify', () => {
  assert.strictEqual(win('width=0,height=0'), false);
  assert.strictEqual(win('width=abc'), false);
  assert.strictEqual(win('width='), false);
});

test('popup=0 / no is not a popup', () => {
  assert.strictEqual(win('popup=0'), false);
  assert.strictEqual(win('popup=no'), false);
});

console.log(`\n${run} tests passed`);
