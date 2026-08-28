// #142 tests:  node windows/sidebarorder.test.js
//
// The sidebar's sectioning (ui/index.html renderTabs) and the ordering model
// (taborder.js displayOrder) are two implementations of one rule, and they MUST
// agree: main sends the sidebar tabs in displayOrder's sequence, and the cycling
// chords (Ctrl+PageUp/PageDown) walk that same sequence. When the two drift, you
// get the #107/#118 symptom — "down the list" moves somewhere else on screen.
//
// index.html is a renderer page and cannot `require` taborder.js (no node
// integration), so the duplication is deliberate. This test keeps the copies
// honest by extracting the real bucketing out of the shipped HTML and running it
// against the real module — the technique hints.test.js and closekey.test.js use.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { displayOrder } = require('./taborder');

const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
const from = html.indexOf('    const byKey = (list) =>');
const to = html.indexOf('    const nodes = [];', from);
assert.notStrictEqual(from, -1, 'sidebar bucketing block not found in index.html');
assert.notStrictEqual(to, -1, 'end of sidebar bucketing block not found');
const block = html.slice(from, to);

/** Run the sidebar's OWN code over a tab state, returning its rendered sequence. */
function sidebarOrder(state, groups) {
  const tabGroups = groups || [];
  // bucketFor in the page is supplied by the same settings plumbing; mirror the
  // module's version so only the SECTIONING logic is under comparison here.
  const bucketFor = (url) => {
    const custom = tabGroups.find((g) => g && g.pattern && String(url).includes(g.pattern));
    if (custom) return custom.name;
    try {
      return new URL(url).hostname.replace(/^www\./, '') || '(local)';
    } catch {
      return '(local)';
    }
  };
  // eslint-disable-next-line no-eval
  return eval(
    `(() => { ${block}
      return [...hot, ...pin, ...sections.flatMap((s) => s.tabs), ...singles];
    })()`
  );
}

const matchPattern = (url, pattern) => String(url).includes(pattern);
const ids = (list) => list.map((t) => t.id);

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

/** The whole point: both implementations must produce the same sequence. */
function agree(name, tabs, groups) {
  test(name, () => {
    assert.deepStrictEqual(
      ids(sidebarOrder(tabs, groups)),
      ids(displayOrder(tabs, groups, matchPattern)),
      'sidebar rendering and taborder.js disagree — Ctrl+PageDown will hop'
    );
  });
}

console.log('the sidebar and the ordering model agree');

agree('a hotkey tab inside a host group', [
  { id: 'hk', url: 'https://gh.com/mine', hotkey: 'g' },
  { id: 'a', url: 'https://gh.com/a' },
  { id: 'b', url: 'https://gh.com/b' },
]);

agree('a hotkey tab completing a two-tab group', [
  { id: 'hk', url: 'https://gh.com/mine', hotkey: 'g' },
  { id: 'solo', url: 'https://gh.com/a' },
  { id: 'elsewhere', url: 'https://other.com/' },
]);

agree('hotkey tabs alone on a host stay in the Hotkeys section', [
  { id: 'z', url: 'https://same.com/z', hotkey: 'z' },
  { id: 'a', url: 'https://same.com/a', hotkey: 'a' },
]);

agree(
  'a hotkey tab in a custom pattern group',
  [
    { id: 'loose', url: 'https://zzz.com/' },
    { id: 'hk', url: 'https://gerrit.corp/x', hotkey: 'r' },
  ],
  [{ name: 'Work', pattern: 'gerrit.corp' }]
);

agree('pinned, hotkey, grouped and loose tabs all at once', [
  { id: 'looseB', url: 'https://b-alone.com/' },
  { id: 'hotZ', url: 'https://solo-z.com/', hotkey: 'z' },
  { id: 'pairB', url: 'https://pair.com/2' },
  { id: 'hotA', url: 'https://solo-a.com/', hotkey: 'a' },
  { id: 'pinned', url: 'https://p.com/', pinned: true },
  { id: 'pairA', url: 'https://pair.com/1' },
  { id: 'looseA', url: 'https://a-alone.com/' },
]);

agree('a pinned tab sharing a host with an ordinary group', [
  { id: 'pin', url: 'https://gh.com/pinned', pinned: true },
  { id: 'a', url: 'https://gh.com/a' },
  { id: 'b', url: 'https://gh.com/b' },
]);

agree('hotkey key order is preserved inside a group', [
  { id: 'ordinary', url: 'https://gh.com/z' },
  { id: 'hkZ', url: 'https://gh.com/z2', hotkey: 'z' },
  { id: 'hkA', url: 'https://gh.com/a2', hotkey: 'a' },
]);

agree('no tabs at all', []);


// This case is load-bearing: with two hotkey tabs on ONE host, a drifted sidebar
// would make them a section. Sections are drawn AFTER Pinned while the Hotkeys
// list is drawn BEFORE it, so the pinned tab is what makes the divergence show
// up in the flattened order. Without it the two implementations can disagree
// about sections while coincidentally agreeing about sequence.
agree('two hotkey tabs on one host, WITH a pinned tab to expose the section split', [
  { id: 'z', url: 'https://same.com/z', hotkey: 'z' },
  { id: 'pin', url: 'https://p.com/', pinned: true },
  { id: 'a', url: 'https://same.com/a', hotkey: 'a' },
]);

console.log('the sidebar puts the tabs in the sections a human would expect');

test('a grouped hotkey tab leaves the Hotkeys section empty', () => {
  const tabs = [
    { id: 'a', url: 'https://gh.com/a' },
    { id: 'hk', url: 'https://gh.com/mine', hotkey: 'g' },
  ];
  const tabGroups = [];
  const bucketFor = (url) => new URL(url).hostname.replace(/^www\./, '');
  const state = tabs;
  // eslint-disable-next-line no-eval
  const parts = eval(`(() => { ${block} return { hot, sections, singles }; })()`);
  assert.deepStrictEqual(ids(parts.hot), [], 'Hotkeys section should be empty');
  assert.strictEqual(parts.sections.length, 1, 'expected one gh.com section');
  assert.deepStrictEqual(ids(parts.sections[0].tabs), ['hk', 'a']);
});


test('hotkey tabs alone on a host form NO section (structure, not just order)', () => {
  const state = [
    { id: 'z', url: 'https://same.com/z', hotkey: 'z' },
    { id: 'a', url: 'https://same.com/a', hotkey: 'a' },
  ];
  const tabGroups = [];
  const bucketFor = (url) => new URL(url).hostname.replace(/^www\./, '');
  // eslint-disable-next-line no-eval
  const parts = eval(`(() => { ${block} return { hot, sections, singles }; })()`);
  assert.strictEqual(parts.sections.length, 0, 'hotkey tabs must not convene a group');
  assert.deepStrictEqual(ids(parts.hot), ['a', 'z'], 'they belong in Hotkeys, in key order');
});

console.log(`\n${run} tests passed`);
