// #117 tests:  node windows/stickytab.test.js
const assert = require('assert');
const { shouldRehome, originOf, inScope, scopeTabFor } = require('./stickytab');

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

// --- #311: scope ---
const SCOPE = 'http://100.69.184.113:8015/office/*';
const OFFICE = 'http://100.69.184.113:8015/office/';

test('inScope: Brandon\'s example', () => {
  const b = { url: OFFICE, scope: SCOPE };
  assert.ok(inScope(b, 'http://100.69.184.113:8015/office/messages/@willow'));
  assert.ok(inScope(b, 'http://100.69.184.113:8015/office/messages/@molly'));
  assert.ok(!inScope(b, 'http://100.69.184.113:8015/other/x'));
  assert.ok(!inScope(b, 'http://100.69.184.113:8065/office/messages/@willow'));
});

test('inScope: no scope, blank scope, or no binding is never in scope', () => {
  assert.ok(!inScope({ url: OFFICE }, OFFICE));
  assert.ok(!inScope({ url: OFFICE, scope: '  ' }, OFFICE));
  assert.ok(!inScope(null, OFFICE));
});

test('inScope: plain prefix and /regex/ scopes work like Persona rules', () => {
  assert.ok(inScope({ scope: 'http://100.69.184.113:8015/office' }, 'http://100.69.184.113:8015/office/a'));
  assert.ok(inScope({ scope: '/^http:\\/\\/100\\.69\\.184\\.113:8015\\/office\\//' }, 'http://100.69.184.113:8015/office/a'));
});

test('shouldRehome with a scope: in scope stays, out of scope re-homes', () => {
  assert.strictEqual(shouldRehome('http://100.69.184.113:8015/office/messages/@molly', OFFICE, SCOPE), false);
  // same origin but outside the scope now re-homes (origin rule would not)
  assert.strictEqual(shouldRehome('http://100.69.184.113:8015/other/x', OFFICE, SCOPE), true);
  assert.strictEqual(shouldRehome('http://100.69.184.113:8065/office/a', OFFICE, SCOPE), true);
});

test('shouldRehome without a scope is the origin rule, unchanged', () => {
  assert.strictEqual(shouldRehome('http://100.69.184.113:8015/other/x', OFFICE), false);
  assert.strictEqual(shouldRehome('http://100.69.184.113:8015/other/x', OFFICE, ''), false);
  assert.strictEqual(shouldRehome('http://100.69.184.113:8065/x', OFFICE, '  '), true);
});

test('shouldRehome with a scope still ignores unreadable URLs', () => {
  assert.strictEqual(shouldRehome('', OFFICE, SCOPE), false);
  assert.strictEqual(shouldRehome('about:blank', OFFICE, SCOPE), false);
});

test('scopeTabFor returns the first matching tab, else null', () => {
  const c = [
    { id: 3, scope: 'https://other.example.com/*' },
    { id: 5, scope: SCOPE },
    { id: 9, scope: 'http://100.69.184.113:8015/*' },
  ];
  assert.strictEqual(scopeTabFor('http://100.69.184.113:8015/office/messages/@willow', c), 5);
  assert.strictEqual(scopeTabFor('http://100.69.184.113:8015/other/x', c), 9);
  assert.strictEqual(scopeTabFor('http://100.69.184.113:8065/office/x', c), null);
  assert.strictEqual(scopeTabFor('http://x', []), null);
  assert.strictEqual(scopeTabFor('http://x', undefined), null);
});

console.log(`\n${run} tests passed`);
