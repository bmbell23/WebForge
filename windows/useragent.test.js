// #134 tests:  node windows/useragent.test.js
const assert = require('assert');
const { cleanUserAgent } = require('./useragent');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

// The real thing, copied from Electron 34.5.8 / Chromium 132 on Windows.
const REAL =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'WebForge/0.1.142 Chrome/132.0.0.0 Electron/34.5.8 Safari/537.36';

console.log('we stop advertising that we are Electron');

test('both giveaway tokens are gone', () => {
  const ua = cleanUserAgent(REAL);
  assert.ok(!/Electron/i.test(ua), `Electron token survived: ${ua}`);
  assert.ok(!/WebForge/i.test(ua), `WebForge token survived: ${ua}`);
});

test('the result is exactly what Chrome would send', () => {
  assert.strictEqual(
    cleanUserAgent(REAL),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/132.0.0.0 Safari/537.36'
  );
});

console.log('the parts that must survive, survive');

test('the Chrome version token is untouched — sniffers gate on it', () => {
  assert.ok(cleanUserAgent(REAL).includes('Chrome/132.0.0.0'));
});

test('platform, AppleWebKit and Safari tokens are untouched', () => {
  const ua = cleanUserAgent(REAL);
  for (const part of [
    '(Windows NT 10.0; Win64; x64)',
    'AppleWebKit/537.36',
    '(KHTML, like Gecko)',
    'Safari/537.36',
  ]) {
    assert.ok(ua.includes(part), `lost ${part}`);
  }
});

console.log('the string never comes out malformed');

test('no double spaces where the tokens were removed', () => {
  assert.ok(!/ {2,}/.test(cleanUserAgent(REAL)), 'double space betrays the edit');
});

test('no leading or trailing whitespace', () => {
  assert.strictEqual(cleanUserAgent(`  ${REAL}  `), cleanUserAgent(REAL));
});

console.log('it holds up on inputs that are not the happy path');

test('a UA with neither token is returned unchanged', () => {
  const plain =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/132.0.0.0 Safari/537.36';
  assert.strictEqual(cleanUserAgent(plain), plain);
});

test('running it twice changes nothing', () => {
  const once = cleanUserAgent(REAL);
  assert.strictEqual(cleanUserAgent(once), once);
});

test('a token at the very end is still removed', () => {
  // Chromium has moved token order between versions; do not assume Safari is last.
  assert.strictEqual(
    cleanUserAgent('Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36 Electron/34.5.8'),
    'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36'
  );
});

test('a differently-cased app token is still removed', () => {
  assert.ok(!/webforge/i.test(cleanUserAgent('Mozilla/5.0 webforge/1.2.3 Chrome/132.0.0.0')));
});

test('junk in does not throw', () => {
  for (const junk of [undefined, null, '', 0, {}, []]) {
    assert.strictEqual(cleanUserAgent(junk), '', `threw or leaked on ${JSON.stringify(junk)}`);
  }
});

console.log(`\n${run} tests passed`);
