// #149 tests:  node scripts/apkversion.test.js
//
// The case that matters is the first one: it is the exact pair that was live on
// 2026-09-14 (endpoint 0.1.155, APK 0.1.151) and the reason the phone prompted
// on every launch. If this test ever passes that pair, the loop is back.
const assert = require('assert');
const { parseBadging, compareSemver, checkStageable } = require('./apkversion');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const built = (versionName, versionCode) => ({ versionName, versionCode });

console.log('the loop this exists to prevent');

test('an APK older than the advertised version is REFUSED (the #149 pair)', () => {
  const r = checkStageable({ built: built('0.1.151', 251), expected: '0.1.155', published: null });
  assert.strictEqual(r.ok, false);
  assert.ok(/0\.1\.151/.test(r.reason) && /0\.1\.155/.test(r.reason), 'must name both numbers');
});

test('a matching pair is allowed', () => {
  const r = checkStageable({ built: built('0.1.156', 256), expected: '0.1.156', published: null });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, '0.1.156');
});

test('an APK NEWER than version.txt is also refused', () => {
  // Not a loop, but it means the endpoint understates what it is serving and
  // phones would sit one version behind with no prompt. Still incoherent.
  const r = checkStageable({ built: built('0.1.157', 257), expected: '0.1.156', published: null });
  assert.strictEqual(r.ok, false);
});

console.log('the quieter ways this goes wrong');

test('reusing a versionCode for different content is refused', () => {
  // Android compares versionCode, not the name — an equal code makes the
  // install a no-op, so the phone never actually moves.
  const r = checkStageable({
    built: built('0.1.156', 251),
    expected: '0.1.156',
    published: built('0.1.151', 251),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/versionCode/.test(r.reason));
});

test('a downgrade over what is already published is refused', () => {
  const r = checkStageable({
    built: built('0.1.150', 250),
    expected: '0.1.150',
    published: built('0.1.156', 256),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/downgrade/.test(r.reason));
});

test('republishing the identical version is allowed (a rebuild is not a downgrade)', () => {
  const r = checkStageable({
    built: built('0.1.156', 256),
    expected: '0.1.156',
    published: built('0.1.156', 256),
  });
  assert.strictEqual(r.ok, true);
});

console.log('bad input fails closed, never open');

test('an unreadable APK is refused rather than assumed fine', () => {
  const r = checkStageable({ built: null, expected: '0.1.156', published: null });
  assert.strictEqual(r.ok, false);
});

test('a junk version.txt is refused', () => {
  for (const expected of ['', null, undefined, 'unknown', '0.1', 'v0.1.156']) {
    const r = checkStageable({ built: built('0.1.156', 256), expected, published: null });
    assert.strictEqual(r.ok, false, `expected refusal for ${JSON.stringify(expected)}`);
  }
});

console.log('reading aapt2 output');

test('a real aapt2 badging line is parsed', () => {
  const line =
    "package: name='com.webforge.browser' versionCode='256' versionName='0.1.156' " +
    "platformBuildVersionName='14' platformBuildVersionCode='34' compileSdkVersion='34'";
  assert.deepStrictEqual(parseBadging(line), { versionName: '0.1.156', versionCode: 256 });
});

test('unparseable aapt2 output yields null, not a guess', () => {
  for (const text of ['', 'ERROR: dump failed', null, undefined, "package: name='x'"]) {
    assert.strictEqual(parseBadging(text), null);
  }
});

console.log('semver comparison');

test('versions order numerically, not as strings', () => {
  assert.ok(compareSemver('0.1.9', '0.1.10') < 0, '10 is newer than 9');
  assert.ok(compareSemver('0.2.0', '0.1.99') > 0);
  assert.strictEqual(compareSemver('1.2.3', '1.2.3'), 0);
});

console.log(`\n${run} tests passed`);
