// #107 tests:  node windows/taburl.test.js
const assert = require('assert');
const { canonical, sameTab, pickTab } = require('./taburl');

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


console.log('#138: picking which tab already shows a URL');

const TABS = [
  { id: 1, url: 'https://news.example.com/' },
  { id: 2, url: 'https://gerrit.corp/dashboard/self' },
  { id: 3, url: 'https://docs.example.com/guide' },
];

test('the tab already showing the URL is found', () => {
  assert.strictEqual(pickTab(TABS, 'https://docs.example.com/guide'), 3);
});

test('canonical matching still applies (www, trailing slash, scheme)', () => {
  assert.strictEqual(pickTab(TABS, 'http://www.docs.example.com/guide/'), 3);
});

test('a URL nothing shows returns null, meaning open a new tab', () => {
  assert.strictEqual(pickTab(TABS, 'https://elsewhere.test/'), null);
});

test('THE BUG: the tab being re-homed is never chosen to rescue itself', () => {
  // A pinned tab (id 2) has just drifted to the bookmark URL, so at this moment
  // it IS the tab showing that URL. Without exceptId it picks itself, gets sent
  // home, and the page opens nowhere — flicker, nothing opened.
  const drifted = [
    { id: 1, url: 'https://news.example.com/' },
    { id: 2, url: 'https://bookmark.example.com/page' }, // the sticky tab, drifted
  ];
  assert.strictEqual(pickTab(drifted, 'https://bookmark.example.com/page'), 2, 'precondition');
  assert.strictEqual(
    pickTab(drifted, 'https://bookmark.example.com/page', 2),
    null,
    'must open a NEW tab rather than reuse the tab it is about to send home'
  );
});

test('a DIFFERENT tab already showing the URL is still reused', () => {
  const tabs = [
    { id: 5, url: 'https://bookmark.example.com/page' }, // an ordinary tab
    { id: 2, url: 'https://bookmark.example.com/page' }, // the drifted sticky tab
  ];
  assert.strictEqual(pickTab(tabs, 'https://bookmark.example.com/page', 2), 5);
});

test('tab id 0 is excluded properly — a truthiness check would not', () => {
  const tabs = [{ id: 0, url: 'https://a.test/' }];
  assert.strictEqual(pickTab(tabs, 'https://a.test/'), 0);
  assert.strictEqual(pickTab(tabs, 'https://a.test/', 0), null);
});

test('the first match wins, so display order decides', () => {
  const tabs = [{ id: 7, url: 'https://a.test/' }, { id: 8, url: 'https://a.test/' }];
  assert.strictEqual(pickTab(tabs, 'https://a.test/'), 7);
});

test('a lazily-restored tab with no URL never matches', () => {
  assert.strictEqual(pickTab([{ id: 9, url: '' }], ''), null);
  assert.strictEqual(pickTab([{ id: 9, url: '' }], 'https://a.test/'), null);
});

test('junk input returns null instead of throwing', () => {
  for (const tabs of [null, undefined, 'nope', [null, undefined]]) {
    assert.strictEqual(pickTab(tabs, 'https://a.test/'), null);
  }
});

console.log(`\n${run} tests passed`);
