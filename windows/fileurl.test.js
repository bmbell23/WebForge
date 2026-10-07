// #319 unit tests. Plain node, no framework:  node windows/fileurl.test.js
const assert = require('assert');
const { fileUrl, isFileUrlOf } = require('./fileurl');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const WIN = { windows: true };
const winErr = 'C:\\Users\\bbell\\AppData\\Local\\Programs\\webforge\\resources\\app.asar\\ui\\neterror.html';
// Copied verbatim from Brandon's PC log (sticky-rehome, v0.1.222, 2026-10-07T18:12:40Z).
const reported = 'file:///C:/Users/bbell/AppData/Local/Programs/webforge/resources/app.asar/ui/neterror.html';

test('a Windows path gets three slashes, matching what Chromium reports', () => {
  assert.strictEqual(fileUrl(winErr, WIN), reported);
});

test('the error page from the real log is recognised as ours', () => {
  assert.strictEqual(isFileUrlOf(reported, winErr, WIN), true);
  assert.strictEqual(isFileUrlOf(reported + '?url=https%3A%2F%2Fx&code=-106', winErr, WIN), true);
});

test('the old two-slash form is what used to be built, and it never matched', () => {
  const old = `file://${winErr.replace(/\\/g, '/')}`;
  assert.notStrictEqual(old, reported);
  assert.strictEqual(reported.startsWith(old), false);
});

test('POSIX paths keep the form they always had', () => {
  assert.strictEqual(fileUrl('/opt/WebForge/resources/app.asar/ui/neterror.html', { windows: false }), 'file:///opt/WebForge/resources/app.asar/ui/neterror.html');
});

test('spaces are percent-encoded like Chromium does', () => {
  assert.strictEqual(fileUrl('/Applications/Web Forge.app/ui/a.html', { windows: false }), 'file:///Applications/Web%20Forge.app/ui/a.html');
});

test('a sibling file with the same prefix is not ours', () => {
  assert.strictEqual(isFileUrlOf(reported.replace('neterror.html', 'neterror.html.evil'), winErr, WIN), false);
  assert.strictEqual(isFileUrlOf('https://example.com/', winErr, WIN), false);
  assert.strictEqual(isFileUrlOf(undefined, winErr, WIN), false);
});

console.log(`fileurl: ${run} tests passed`);
