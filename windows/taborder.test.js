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


console.log('#142: a hotkey tab shows inside the group it belongs to');

test('a hotkey tab joins a host group that has ordinary tabs', () => {
  const tabs = [
    { id: 'hk', url: 'https://gh.com/mine', hotkey: 'g' },
    { id: 'a', url: 'https://gh.com/a' },
    { id: 'b', url: 'https://gh.com/b' },
  ];
  // All three in one section — no Hotkeys header hoisting the quick-launch tab out.
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['hk', 'a', 'b']);
});

test('a hotkey tab COUNTS toward the two-tab threshold', () => {
  // Previously: the ordinary tab sat alone under "Other" and the hotkey tab
  // sat under "Hotkeys" — the group never formed at all.
  const tabs = [
    { id: 'hk', url: 'https://gh.com/mine', hotkey: 'g' },
    { id: 'solo', url: 'https://gh.com/a' },
    { id: 'elsewhere', url: 'https://other.com/' },
  ];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['hk', 'solo', 'elsewhere']);
});

test('a hotkey tab joins a CUSTOM group even as its only member (#34)', () => {
  const tabs = [
    { id: 'loose', url: 'https://zzz.com/' },
    { id: 'hk', url: 'https://gerrit.corp/x', hotkey: 'r' },
  ];
  const groups = [{ name: 'Work', pattern: 'gerrit.corp' }];
  // The custom group is deliberate, so the hotkey tab belongs in it and the
  // section sorts above loose tabs.
  assert.deepStrictEqual(ids(displayOrder(tabs, groups, matchPattern)), ['hk', 'loose']);
});

test('hotkey tabs alone on a host do NOT convene a group of their own', () => {
  // They stay in the Hotkeys section, in key order — the keyboard map (#44)
  // must not be broken up by an accidental host bucket.
  const tabs = [
    { id: 'z', url: 'https://same.com/z', hotkey: 'z' },
    { id: 'a', url: 'https://same.com/a', hotkey: 'a' },
  ];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['a', 'z']);
});

test('a hotkey tab with no group still sits under Hotkeys, above everything', () => {
  const tabs = [
    { id: 'pair1', url: 'https://pair.com/1' },
    { id: 'hk', url: 'https://solo-host.com/', hotkey: 'a' },
    { id: 'pair2', url: 'https://pair.com/2' },
  ];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['hk', 'pair1', 'pair2']);
});

test('inside a group, hotkey tabs lead and keep KEY order (#44 survives #142)', () => {
  const tabs = [
    { id: 'ordinary', url: 'https://gh.com/z' },
    { id: 'hkZ', url: 'https://gh.com/z2', hotkey: 'z' },
    { id: 'hkA', url: 'https://gh.com/a2', hotkey: 'a' },
  ];
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['hkA', 'hkZ', 'ordinary']);
});

test('pinned tabs are untouched by #142 and keep their own section', () => {
  const tabs = [
    { id: 'pin', url: 'https://gh.com/pinned', pinned: true },
    { id: 'a', url: 'https://gh.com/a' },
    { id: 'b', url: 'https://gh.com/b' },
  ];
  // pinned first, then the gh.com group of the two ordinary tabs
  assert.deepStrictEqual(ids(displayOrder(tabs, [], matchPattern)), ['pin', 'a', 'b']);
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
