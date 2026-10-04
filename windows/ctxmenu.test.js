// #133 tests:  node windows/ctxmenu.test.js
const assert = require('assert');
const { build, shorten, MAX_LABEL } = require('./ctxmenu');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const ids = (items) => items.filter((i) => i.id).map((i) => i.id);
const find = (items, id) => items.find((i) => i.id === id);
const ALWAYS = ['nav.back', 'nav.forward', 'nav.reload', 'page.viewSource', 'page.inspect'];

console.log('a right-click always does something');

test('bare page still offers navigation and page tools', () => {
  assert.deepStrictEqual(ids(build({}, {})), ALWAYS);
});

test('nothing is enabled that cannot happen', () => {
  const items = build({}, { canGoBack: false, canGoForward: true });
  assert.strictEqual(find(items, 'nav.back').enabled, false);
  assert.strictEqual(find(items, 'nav.forward').enabled, true);
});

console.log('links');

test('a link offers open, copy and save', () => {
  const items = build({ linkURL: 'https://x.com/a' }, {});
  assert.deepStrictEqual(ids(items).slice(0, 4), [
    'link.open', 'link.openBackground', 'link.copy', 'link.save',
  ]);
});

console.log('images');

test('an image offers open, copy, copy-address and save', () => {
  const items = build({ mediaType: 'image', srcURL: 'https://x.com/i.png' }, {});
  assert.deepStrictEqual(ids(items).slice(0, 4), [
    'image.open', 'image.copy', 'image.copyAddress', 'image.save',
  ]);
});

test('a linked image offers BOTH sections', () => {
  const items = build(
    { linkURL: 'https://x.com/a', mediaType: 'image', srcURL: 'https://x.com/i.png' },
    {}
  );
  assert.ok(ids(items).includes('link.copy'), 'link items missing');
  assert.ok(ids(items).includes('image.save'), 'image items missing');
});

test('mediaType image with no srcURL adds nothing', () => {
  assert.deepStrictEqual(ids(build({ mediaType: 'image' }, {})), ALWAYS);
});

console.log('selections');

test('a selection offers copy and search', () => {
  const items = build({ selectionText: 'hello world', editFlags: { canCopy: true } }, { engineName: 'Google' });
  assert.ok(ids(items).includes('selection.copy'));
  assert.strictEqual(find(items, 'selection.search').label, 'Search Google for "hello world"');
});

test('the Jira jump appears ONLY when a rule matched', () => {
  const withRule = build({ selectionText: 'SFAP-1' }, { ruleLabel: 'Open SFAP-1 in Jira' });
  assert.ok(ids(withRule).includes('rule.open'));
  const without = build({ selectionText: 'not a ticket' }, {});
  assert.ok(!ids(without).includes('rule.open'), 'must not advertise a jump that goes nowhere');
});

test('a long selection is truncated in the label', () => {
  const long = 'x'.repeat(100);
  const items = build({ selectionText: long }, { engineName: 'Bing' });
  assert.ok(find(items, 'selection.search').label.length < 60);
  assert.ok(find(items, 'selection.search').label.includes('…'));
});

test('whitespace in a selection is collapsed, not shown raw', () => {
  assert.strictEqual(shorten('  a\n\n  b  '), 'a b');
  assert.ok(shorten('y'.repeat(MAX_LABEL + 5)).endsWith('…'));
});

test('whitespace-only selection is not a selection', () => {
  assert.deepStrictEqual(ids(build({ selectionText: '   \n ' }, {})), ALWAYS);
});

console.log('text fields');

test('an editable field offers the edit actions, enabled from editFlags', () => {
  const items = build(
    { isEditable: true, editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true } },
    {}
  );
  assert.strictEqual(find(items, 'edit.undo').enabled, true);
  assert.strictEqual(find(items, 'edit.redo').enabled, false);
  assert.strictEqual(find(items, 'edit.cut').enabled, false);
  assert.strictEqual(find(items, 'edit.paste').enabled, true);
});

test('missing editFlags disables everything rather than throwing', () => {
  const items = build({ isEditable: true }, {});
  for (const id of ['edit.undo', 'edit.cut', 'edit.paste']) {
    assert.strictEqual(find(items, id).enabled, false, `${id} should be disabled`);
  }
});

test('a selection INSIDE a text field uses the edit section, not the page one', () => {
  const items = build({ isEditable: true, selectionText: 'abc', editFlags: { canCopy: true } }, {});
  assert.ok(!ids(items).includes('selection.search'), 'should not offer a web search for text being edited');
  assert.ok(ids(items).includes('edit.copy'));
});

console.log('the menu never looks broken');

test('no leading, trailing or doubled separators', () => {
  for (const params of [
    {},
    { linkURL: 'https://x' },
    { isEditable: true },
    { selectionText: 'a' },
    { linkURL: 'https://x', mediaType: 'image', srcURL: 'https://i', selectionText: 'a', isEditable: true },
  ]) {
    const items = build(params, {});
    assert.notStrictEqual(items[0].type, 'separator', 'leading separator');
    assert.notStrictEqual(items[items.length - 1].type, 'separator', 'trailing separator');
    for (let i = 1; i < items.length; i++) {
      assert.ok(
        !(items[i].type === 'separator' && items[i - 1].type === 'separator'),
        `doubled separator at ${i}`
      );
    }
  }
});

test('every non-separator item has an id and a label', () => {
  const items = build(
    { linkURL: 'https://x', mediaType: 'image', srcURL: 'https://i', isEditable: true },
    {}
  );
  for (const item of items) {
    if (item.type === 'separator') continue;
    assert.ok(item.id, 'item without an id cannot be wired to an action');
    assert.ok(item.label, `${item.id} has no label`);
  }
});

console.log('#179/#181: Create Outfit');

test('an http(s) image offers it, last in the image section', () => {
  const items = build({ mediaType: 'image', srcURL: 'https://x.com/i.png' }, { imageOutfit: true });
  const got = ids(items);
  assert.strictEqual(got[got.indexOf('image.save') + 1], 'image.outfit');
  assert.strictEqual(find(items, 'image.outfit').label, 'Create Outfit…');
});

test('an image the Studio cannot fetch does not', () => {
  assert.ok(!ids(build({ mediaType: 'image', srcURL: 'data:image/png;base64,A' }, { imageOutfit: false })).includes('image.outfit'));
});

console.log('#156: Download content (yt-dlp)');

test('a web page offers Download content, after Reload', () => {
  const got = ids(build({}, { pageYtdlp: true }));
  assert.deepStrictEqual(got, ['nav.back', 'nav.forward', 'nav.reload', 'page.ytdlp', 'page.viewSource', 'page.inspect']);
  assert.strictEqual(find(build({}, { pageYtdlp: true }), 'page.ytdlp').label, 'Download content…');
});

test('the new-tab page and file: pages do not', () => {
  assert.deepStrictEqual(ids(build({}, { pageYtdlp: false })), ALWAYS);
});

test('a web link offers Download content from link, after Download linked file', () => {
  const got = ids(build({ linkURL: 'https://youtube.com/watch?v=a' }, { linkYtdlp: true }));
  assert.deepStrictEqual(got.slice(0, 5), ['link.open', 'link.openBackground', 'link.copy', 'link.save', 'link.ytdlp']);
});

test('a mailto: link does not', () => {
  assert.ok(!ids(build({ linkURL: 'mailto:a@b.c' }, { linkYtdlp: false })).includes('link.ytdlp'));
});

console.log('#177: Add to Stash');

test('an http(s) image offers Add to Stash after Create Outfit', () => {
  const got = ids(build({ mediaType: 'image', srcURL: 'https://x.com/i.png' }, { imageOutfit: true, mediaStash: true }));
  assert.strictEqual(got[got.indexOf('image.outfit') + 1], 'media.stash');
});

test('a <video> with a file behind it offers Add video to Stash', () => {
  const items = build({ mediaType: 'video', srcURL: 'https://x.com/v.mp4' }, { mediaStash: true });
  assert.strictEqual(find(items, 'media.stash').label, 'Add video to Stash');
  assert.ok(!ids(build({ mediaType: 'video', srcURL: 'blob:https://x.com/1' }, { mediaStash: false })).includes('media.stash'));
});

test('a web page offers video and all-images, after Download content', () => {
  const got = ids(build({}, { pageYtdlp: true, pageStash: true }));
  assert.deepStrictEqual(got, ['nav.back', 'nav.forward', 'nav.reload', 'page.ytdlp', 'page.stashVideo', 'page.stashGallery', 'page.viewSource', 'page.inspect']);
  assert.deepStrictEqual(ids(build({}, { pageStash: false })), ALWAYS);
});

console.log(`\n${run} tests passed`);
