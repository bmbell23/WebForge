// #107 tests:  node windows/taborder.test.js
const assert = require('assert');
const { displayOrder } = require('./taborder');

// Stand-in for the app's pattern matcher; only prefix matching is needed here.
const matchPattern = (url, pattern) => String(url).includes(pattern);
const ids = (list) => list.map((t) => t.id);

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

console.log('sections come out in the order the sidebar draws them');

test('hotkeys, then pinned, then groups, then loose tabs', () => {
  const tabs = [
    { id: 'loose', url: 'https://alone.example.com/' },
    { id: 'pin1', url: 'https://p.example.com/', pinned: true },
    { id: 'grp1', url: 'https://gh.com/a' },
    { id: 'hot1', url: 'https://h.example.com/', hotkey: 'b' },
    { id: 'grp2', url: 'https://gh.com/b' },
  ];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), [
    'hot1', // hotkeys first
    'pin1', // then pinned
    'grp1', // then the gh.com bucket (2 tabs, so it is a section)
    'grp2',
    'loose', // singleton hosts fall to the bottom
  ]);
});

test('hotkey tabs are ordered by their KEY, not insertion (#44)', () => {
  const tabs = [
    { id: 'c', url: 'https://x/', hotkey: 'c' },
    { id: 'a', url: 'https://x/', hotkey: 'a' },
    { id: 'b', url: 'https://x/', hotkey: 'b' },
  ];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['a', 'b', 'c']);
});

test('hotkey keys sort numerically, not lexically', () => {
  const tabs = [
    { id: 'k10', url: 'https://x/', hotkey: 'F10' },
    { id: 'k2', url: 'https://x/', hotkey: 'F2' },
  ];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['k2', 'k10']);
});

test('a custom group is a section even with one tab (#34)', () => {
  const tabs = [
    { id: 'other', url: 'https://zzz.example.com/' },
    { id: 'work', url: 'https://gerrit.corp/x' },
  ];
  const groups = [{ name: 'Work', pattern: 'gerrit.corp' }];
  // The custom group is a real section, so it sorts above the loose singleton.
  assert.deepStrictEqual(ids(displayOrder(tabs, groups, matchPattern)), ['work', 'other']);
});

test('a single-tab host is loose, two tabs make it a section', () => {
  const one = [{ id: 'a', url: 'https://solo.com/1' }, { id: 'b', url: 'https://other.com/1' }];
  // both singletons: order preserved, both loose
  assert.deepStrictEqual(ids(displayOrder(one, [], matchPattern)), ['a', 'b']);

  const two = [
    { id: 'solo', url: 'https://solo.com/1' },
    { id: 'pairA', url: 'https://pair.com/1' },
    { id: 'pairB', url: 'https://pair.com/2' },
  ];
  // pair.com becomes a section and therefore precedes the loose solo tab
  assert.deepStrictEqual(ids(displayOrder(two, [], matchPattern)), ['pairA', 'pairB', 'solo']);
});

console.log('the reported symptom');

test('stepping the display order never jumps between sections at random', () => {
  // Ctrl+PageDown walked tabOrder, which had no idea about hotkey-key sorting or
  // groups — so "down the list" moved somewhere else on screen. Walking THIS
  // order visits the sidebar top to bottom.
  const tabs = [
    { id: 'looseB', url: 'https://b-alone.com/' },
    { id: 'hotZ', url: 'https://x/', hotkey: 'z' },
    { id: 'pairB', url: 'https://pair.com/2' },
    { id: 'hotA', url: 'https://x/', hotkey: 'a' },
    { id: 'pinned', url: 'https://p.com/', pinned: true },
    { id: 'pairA', url: 'https://pair.com/1' },
    { id: 'looseA', url: 'https://a-alone.com/' },
  ];
  const order = ids(displayOrder(tabs, [], matchPattern));
  assert.deepStrictEqual(order, ['hotA', 'hotZ', 'pinned', 'pairB', 'pairA', 'looseB', 'looseA']);

  // Walking it forward from each position lands on the next one down, always.
  for (let i = 0; i < order.length; i++) {
    const next = order[(i + 1) % order.length];
    assert.strictEqual(next, order[(i + 1) % order.length]);
  }
});

console.log('degenerate input');

test('empty and non-array input do not throw', () => {
  assert.deepStrictEqual(displayOrder([], [], matchPattern), []);
  assert.deepStrictEqual(displayOrder(null, null, matchPattern), []);
});

test('an unparseable URL is bucketed as (local) rather than throwing', () => {
  const tabs = [{ id: 'weird', url: 'not-a-url' }, { id: 'ok', url: 'https://x.com/' }];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)).sort(), ['ok', 'weird']);
});

console.log(`\n${run} tests passed`);
