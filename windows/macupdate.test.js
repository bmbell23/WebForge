// #315 tests:  node windows/macupdate.test.js
const assert = require('assert');
const mu = require('./macupdate');
const pkg = require('./package.json');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

// files[] as electron-updater parses the real v0.1.221 latest-mac.yml
const files = [
  { url: 'WebForge-0.1.221-arm64.zip' },
  { url: 'WebForge-0.1.221-x64.zip' },
  { url: 'WebForge-0.1.221-arm64.dmg' },
  { url: 'WebForge-0.1.221-x64.dmg' },
];

test('only macOS updates by hand', () => {
  assert.strictEqual(mu.isManual('darwin'), true);
  assert.strictEqual(mu.isManual('win32'), false);
  assert.strictEqual(mu.isManual('linux'), false);
});

test('picks the .dmg for this chip, never a .zip', () => {
  assert.strictEqual(mu.pickDmg(files, 'arm64'), 'WebForge-0.1.221-arm64.dmg');
  assert.strictEqual(mu.pickDmg(files, 'x64'), 'WebForge-0.1.221-x64.dmg');
});

test('unknown chip falls back to the first .dmg; no .dmg is null', () => {
  assert.strictEqual(mu.pickDmg(files, 'ia32'), 'WebForge-0.1.221-arm64.dmg');
  assert.strictEqual(mu.pickDmg(files.slice(0, 2), 'arm64'), null);
  assert.strictEqual(mu.pickDmg(undefined, 'arm64'), null);
  assert.strictEqual(mu.pickDmg([null, { url: 5 }], 'arm64'), null);
});

test('download URL is on the :8012 mac feed', () => {
  assert.strictEqual(
    mu.dmgUrl({ version: '0.1.221', files }, 'arm64'),
    'http://100.69.184.113:8012/mac/WebForge-0.1.221-arm64.dmg',
  );
  assert.strictEqual(mu.dmgUrl({ files: [] }, 'arm64'), null);
  assert.strictEqual(mu.dmgUrl(null, 'arm64'), null);
});

test('MAC_FEED matches the feed electron-builder bakes into the app', () => {
  assert.strictEqual(mu.MAC_FEED, pkg.build.mac.publish.url);
});

console.log(`macupdate: ${run} passed`);
