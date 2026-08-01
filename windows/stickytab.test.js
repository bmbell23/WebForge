// #117 tests:  node windows/stickytab.test.js
const assert = require('assert');
const { shouldRehome, originOf } = require('./stickytab');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const HOME = 'https://gerrit.corp.example.com/dashboard/self';

console.log('leaving the site is re-homed');

test('a different host is a departure', () => {
  assert.strictEqual(shouldRehome('https://news.example.com/story', HOME), true);
});

test('a different scheme is a different origin', () => {
  assert.strictEqual(shouldRehome('http://gerrit.corp.example.com/x', HOME), true);
});

test('a different port is a different origin', () => {
  assert.strictEqual(shouldRehome('https://gerrit.corp.example.com:8443/x', HOME), true);
});

console.log('staying on the site is left alone — this is the #78 livelock guard');

test('a deeper path on the same origin is fine', () => {
  assert.strictEqual(shouldRehome('https://gerrit.corp.example.com/c/12345', HOME), false);
});

test('a redirecting home does not fight itself', () => {
  // The exact shape that livelocked: home redirects to a longer path, which
  // fires did-navigate, which under full-URL comparison re-loaded home, which
  // redirected again — several times a second, for ever.
  assert.strictEqual(shouldRehome('https://gerrit.corp.example.com/dashboard/self?x=1', HOME), false);
  assert.strictEqual(shouldRehome('https://gerrit.corp.example.com/login?next=%2F', HOME), false);
});

test('SPA hash routing on the same origin is fine', () => {
  assert.strictEqual(shouldRehome('https://gerrit.corp.example.com/#/c/999', HOME), false);
});

test('a query string alone is not a departure', () => {
  assert.strictEqual(shouldRehome(`${HOME}?tab=2`, HOME), false);
});

console.log('unreadable input does nothing rather than something wrong');

test('unparseable or missing URLs never trigger a re-home', () => {
  assert.strictEqual(shouldRehome('not-a-url', HOME), false);
  assert.strictEqual(shouldRehome(HOME, 'not-a-url'), false);
  assert.strictEqual(shouldRehome('', HOME), false);
  assert.strictEqual(shouldRehome(HOME, ''), false);
  assert.strictEqual(shouldRehome(null, undefined), false);
});

test('originOf reports what it can and null otherwise', () => {
  assert.strictEqual(originOf('https://x.com/a/b?c=d#e'), 'https://x.com');
  assert.strictEqual(originOf('garbage'), null);
});

console.log(`\n${run} tests passed`);
