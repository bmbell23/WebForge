// #107 tests:  node windows/taburl.test.js
const assert = require('assert');
const { canonical, sameTab } = require('./taburl');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const same = (a, b) => assert.strictEqual(sameTab(a, b), true, `expected SAME: ${a}  vs  ${b}`);
const diff = (a, b) => assert.strictEqual(sameTab(a, b), false, `expected DIFFERENT: ${a}  vs  ${b}`);

console.log('the agreed normalisation table');

test('trailing slash', () => {
  same('https://x.com', 'https://x.com/');
  same('https://x.com/docs', 'https://x.com/docs/');
});

test('scheme', () => {
  same('http://x.com/a', 'https://x.com/a');
});

test('leading www.', () => {
  same('https://www.x.com/a', 'https://x.com/a');
});

test('default ports are noise, other ports are not', () => {
  same('https://x.com:443/a', 'https://x.com/a');
  same('http://x.com:80/a', 'http://x.com/a');
  diff('https://x.com:8443/a', 'https://x.com/a');
});

test('plain #anchors are the same page', () => {
  same('https://x.com/guide#install', 'https://x.com/guide#intro');
  same('https://x.com/guide#install', 'https://x.com/guide');
});

test('#/ hash ROUTES are different pages', () => {
  diff('https://app.x.com/#/dashboard', 'https://app.x.com/#/settings');
  // and a route is not the same as no route
  diff('https://app.x.com/#/dashboard', 'https://app.x.com/');
});

test('query strings stay significant', () => {
  diff('https://x.com/s?q=a', 'https://x.com/s?q=b');
  diff('https://x.com/s?q=a', 'https://x.com/s');
  same('https://x.com/s?q=a', 'https://x.com/s?q=a');
});

test('path and host still matter', () => {
  diff('https://x.com/a', 'https://x.com/b');
  diff('https://x.com/a', 'https://y.com/a');
  diff('https://sub.x.com/a', 'https://x.com/a');
});

console.log('the real-world duplicate this fixes');

test('a redirect-shaped difference no longer spawns a second tab', () => {
  // The other device publishes the typed form; ours has redirected. Under exact
  // string matching these looked like different pages and the 30s sync loop
  // adopted a duplicate.
  same('http://www.example.com', 'https://example.com/');
});

console.log('non-web URLs are left alone');

test('internal and file URLs never normalise into each other', () => {
  diff('file:///opt/app/ui/settings.html', 'file:///opt/app/ui/manager.html');
  same('file:///opt/app/ui/settings.html', 'file:///opt/app/ui/settings.html');
  diff('view-source:https://x.com/a', 'https://x.com/a');
});

console.log('degenerate input');

test('empty and unparseable input never matches', () => {
  diff('', '');
  diff('', 'https://x.com');
  assert.strictEqual(canonical(''), '');
  assert.strictEqual(canonical(null), '');
  assert.strictEqual(canonical(undefined), '');
});

test('unparseable strings compare literally', () => {
  same('not a url', 'not a url');
  diff('not a url', 'also not a url');
});

console.log(`\n${run} tests passed`);
