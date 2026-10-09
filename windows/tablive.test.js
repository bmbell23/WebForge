// #170 unit tests. Plain node, no framework:  node windows/tablive.test.js
const assert = require('assert');
const { liveWc, liveUrl } = require('./tablive');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const wc = (url, destroyed = false) => ({ getURL: () => url, isDestroyed: () => destroyed });

test('a live tab gives its URL', () => {
  assert.strictEqual(liveUrl({ webContents: wc('https://jira') }), 'https://jira');
});

test('the popup that closed itself: view present, webContents gone (the 17:49:42Z crash)', () => {
  assert.strictEqual(liveUrl({ webContents: undefined }), '');
  assert.strictEqual(liveWc({ webContents: undefined }), null);
});

test('a destroyed webContents is treated as gone', () => {
  assert.strictEqual(liveUrl({ webContents: wc('https://x', true) }), '');
});

test('no view at all', () => {
  assert.strictEqual(liveUrl(undefined), '');
});

test('getURL throwing ("Object has been destroyed") never escapes', () => {
  const v = { webContents: { isDestroyed: () => false, getURL: () => { throw new Error('Object has been destroyed'); } } };
  assert.strictEqual(liveUrl(v), '');
});

console.log(`tablive: ${run} tests passed`);
