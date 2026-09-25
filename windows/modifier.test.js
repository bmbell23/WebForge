// #150 tests:  node windows/modifier.test.js
//
// The whole point of this module is behaviour on a platform this host cannot
// run, so every case is asserted on BOTH platforms explicitly. A pass on win32
// alone would prove nothing about the thing being built.
const assert = require('assert');
const mod = require('./modifier');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

// Electron before-input-event shape
const input = (o = {}) => ({ control: false, meta: false, alt: false, shift: false, ...o });
// DOM KeyboardEvent shape
const dom = (o = {}) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

const WIN = 'win32';
const MAC = 'darwin';

console.log('the right physical key fires the chord on each platform');

test('Ctrl is the chord on Windows; Cmd is NOT', () => {
  assert.strictEqual(mod.isChord(input({ control: true }), WIN), true);
  assert.strictEqual(mod.isChord(input({ meta: true }), WIN), false, 'the Windows key must not fire chords');
});

test('Cmd is the chord on macOS; Ctrl is NOT', () => {
  assert.strictEqual(mod.isChord(input({ meta: true }), MAC), true);
  assert.strictEqual(
    mod.isChord(input({ control: true }), MAC),
    false,
    'macOS Control is a separate key — firing on it is the bug this module exists to stop'
  );
});

test('holding BOTH never counts as the chord, on either platform', () => {
  // Otherwise the foreign key becomes a way to trigger us by accident.
  for (const platform of [WIN, MAC]) {
    assert.strictEqual(mod.isChord(input({ control: true, meta: true }), platform), false, platform);
  }
});

test('Alt disqualifies the chord on both platforms', () => {
  assert.strictEqual(mod.isChord(input({ control: true, alt: true }), WIN), false);
  assert.strictEqual(mod.isChord(input({ meta: true, alt: true }), MAC), false);
});

console.log('shift is allowed for chords, rejected for the guarded page keys');

test('Ctrl+Shift+Tab is still a chord (it is a real binding)', () => {
  assert.strictEqual(mod.isChord(input({ control: true, shift: true }), WIN), true);
  assert.strictEqual(mod.isChord(input({ meta: true, shift: true }), MAC), true);
});

test('isChordExact rejects shift, so the page keeps Ctrl+Shift+X', () => {
  assert.strictEqual(mod.isChordExact(input({ control: true }), WIN), true);
  assert.strictEqual(mod.isChordExact(input({ control: true, shift: true }), WIN), false);
  assert.strictEqual(mod.isChordExact(input({ meta: true, shift: true }), MAC), false);
});

console.log('both event shapes are understood');

test('a DOM KeyboardEvent reads identically to an Electron input', () => {
  assert.strictEqual(mod.isChord(dom({ ctrlKey: true }), WIN), true);
  assert.strictEqual(mod.isChord(dom({ metaKey: true }), MAC), true);
  assert.strictEqual(mod.isChord(dom({ metaKey: true }), WIN), false);
  assert.strictEqual(mod.isChord(dom({ ctrlKey: true }), MAC), false);
});

test('a false Electron field is not mistaken for an absent one', () => {
  // `control: false` must win over a non-existent ctrlKey — an `||` fallback
  // here would read the wrong field and quietly invert the check.
  assert.strictEqual(mod.isChord({ control: false, meta: true }, MAC), true);
  assert.strictEqual(mod.isChord({ control: false, meta: false }, MAC), false);
});

test('junk input never throws and never claims a chord', () => {
  for (const ev of [null, undefined, 'nope', 42, {}]) {
    assert.strictEqual(mod.isChord(ev, WIN), false);
    assert.strictEqual(mod.isChord(ev, MAC), false);
  }
});

console.log('bare and alt-only keys');

test('F11/Escape need no modifier, and shift does not disqualify them', () => {
  assert.strictEqual(mod.isBare(input(), WIN), true);
  assert.strictEqual(mod.isBare(input({ shift: true }), MAC), true);
  assert.strictEqual(mod.isBare(input({ control: true }), WIN), false);
  assert.strictEqual(mod.isBare(input({ meta: true }), MAC), false);
  // macOS Control is not our modifier, but it is still A modifier: a chord
  // that means something else to the OS must not read as "bare".
  assert.strictEqual(mod.isBare(input({ control: true }), MAC), false);
});

test('Alt+Left is alt-only; Ctrl+Alt+Left is not', () => {
  assert.strictEqual(mod.isAltOnly(input({ alt: true }), WIN), true);
  assert.strictEqual(mod.isAltOnly(input({ alt: true }), MAC), true);
  assert.strictEqual(mod.isAltOnly(input({ alt: true, control: true }), WIN), false);
  assert.strictEqual(mod.isAltOnly(input({ alt: true, meta: true }), MAC), false);
});

console.log('the stored hotkey id must NOT vary by platform');

test('a Mac ⌘ press stores the same id a Windows Ctrl press does', () => {
  // These ids live in the vault and reconcile against Android through sync.
  // "Cmd+K" on one platform would silently stop matching the same binding.
  assert.strictEqual(mod.keyId(input({ meta: true }), 'K', MAC), 'Ctrl+K');
  assert.strictEqual(mod.keyId(input({ control: true }), 'K', WIN), 'Ctrl+K');
});

test('macOS Control does NOT earn the Ctrl+ prefix', () => {
  assert.strictEqual(mod.keyId(input({ control: true }), 'K', MAC), 'K');
});

test('Alt is recorded, and ordering is stable', () => {
  assert.strictEqual(mod.keyId(input({ control: true, alt: true }), 'K', WIN), 'Ctrl+Alt+K');
  assert.strictEqual(mod.keyId(input({ meta: true, alt: true }), 'K', MAC), 'Ctrl+Alt+K');
  assert.strictEqual(mod.keyId(input({ alt: true }), 'K', WIN), 'Alt+K');
  assert.strictEqual(mod.keyId(input(), 'K', WIN), 'K');
});

test('a missing key yields just the prefix rather than "undefined"', () => {
  assert.strictEqual(mod.keyId(input({ control: true }), undefined, WIN), 'Ctrl+');
});

console.log('the leader chord stays on Control everywhere');

test('the leader is Control+Space on both platforms, not Cmd+Space', () => {
  // ⌘+Space is Spotlight; the OS owns it.
  assert.strictEqual(mod.LEADER_ACCELERATOR, 'Control+Space');
  assert.strictEqual(mod.isLeaderChord(input({ control: true })), true);
  assert.strictEqual(mod.isLeaderChord(input({ meta: true })), false);
});

test('the leader rejects Alt and the Cmd/Win key', () => {
  assert.strictEqual(mod.isLeaderChord(input({ control: true, alt: true })), false);
  assert.strictEqual(mod.isLeaderChord(input({ control: true, meta: true })), false);
});

// --- the copies that cannot require this module --------------------------
//
// Sandboxed preloads can only require `electron` and a couple of node built-ins
// — never a local file. That is proved, not assumed: a probe under WebForge's
// real webPreferences returned "module not found" for a local require. So the
// three preloads carry an inlined copy, and preload.js carries the id format for
// the chrome UI on top of that.
//
// Duplication is forced, drift is not. These tests evaluate the REAL shipped
// source out of each file against a stubbed `process.platform`, so a copy that
// falls out of step with modifier.js fails here instead of on a Mac.
const fs = require('fs');
const path = require('path');

const PRELOADS = ['preload.js', 'content-preload.js', 'internal-preload.js'];
const START = '// #150-modifier-copy-start';
const END = '// #150-modifier-copy-end';

function copyFrom(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const from = src.indexOf(START);
  const to = src.indexOf(END, from);
  assert.notStrictEqual(from, -1, `${file}: the modifier copy is missing entirely`);
  assert.notStrictEqual(to, -1, `${file}: the modifier copy is unterminated`);
  return src.slice(from + START.length, to);
}

/** Evaluate an extracted snippet with a chosen platform, returning a named fn. */
function withPlatform(snippet, name, platform) {
  return new Function('process', `${snippet}\nreturn ${name};`)({ platform });
}

console.log('the inlined preload copies match this module');

test('all three preload copies are byte-identical', () => {
  const [first, ...rest] = PRELOADS.map(copyFrom);
  for (let i = 0; i < rest.length; i++) {
    assert.strictEqual(rest[i], first, `${PRELOADS[i + 1]} has drifted from ${PRELOADS[0]}`);
  }
});

test('each preload copy agrees with isChordExact on BOTH platforms', () => {
  const CASES = [
    dom({ ctrlKey: true }),
    dom({ metaKey: true }),
    dom({ ctrlKey: true, metaKey: true }),
    dom({ ctrlKey: true, shiftKey: true }),
    dom({ metaKey: true, shiftKey: true }),
    dom({ ctrlKey: true, altKey: true }),
    dom({ metaKey: true, altKey: true }),
    dom({}),
  ];
  for (const file of PRELOADS) {
    const snippet = copyFrom(file);
    for (const platform of [WIN, MAC]) {
      const appChord = withPlatform(snippet, 'appChord', platform);
      for (const ev of CASES) {
        assert.strictEqual(
          appChord(ev),
          mod.isChordExact(ev, platform),
          `${file} disagrees on ${platform} for ${JSON.stringify(ev)}`
        );
      }
    }
  }
});

console.log('the id format handed to the chrome UI matches this module');

test('preload.js appKeyId produces the same ids as modifier.keyId', () => {
  const src = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const from = src.indexOf('const appKeyId = (e, key) =>');
  assert.notStrictEqual(from, -1, 'appKeyId is missing from preload.js');
  const snippet = src.slice(from, src.indexOf('\n};', from) + 3);
  const CASES = [
    [dom({ ctrlKey: true }), 'K'],
    [dom({ metaKey: true }), 'K'],
    [dom({ ctrlKey: true, altKey: true }), 'K'],
    [dom({ metaKey: true, altKey: true }), 'K'],
    [dom({ altKey: true }), 'K'],
    [dom({}), 'K'],
  ];
  for (const platform of [WIN, MAC]) {
    const appKeyId = withPlatform(snippet, 'appKeyId', platform);
    for (const [ev, key] of CASES) {
      assert.strictEqual(
        appKeyId(ev, key),
        mod.keyId(ev, key, platform),
        `preload.js appKeyId disagrees on ${platform} for ${JSON.stringify(ev)}`
      );
    }
  }
});

test('preload.js appForeign matches the module on both platforms', () => {
  const src = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const from = src.indexOf('const appForeign = (e) =>');
  assert.notStrictEqual(from, -1, 'appForeign is missing from preload.js');
  const snippet = src.slice(from, src.indexOf('\n', from) + 1);
  for (const platform of [WIN, MAC]) {
    const appForeign = withPlatform(snippet, 'appForeign', platform);
    for (const ev of [dom({ ctrlKey: true }), dom({ metaKey: true }), dom({})]) {
      assert.strictEqual(appForeign(ev), mod.state(ev, platform).foreign, `${platform} ${JSON.stringify(ev)}`);
    }
  }
});

console.log(`\n${run} tests passed`);
