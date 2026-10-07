// #298 tests:  node windows/tabsync.test.js
const assert = require('assert');
const { pruneStaleDevices, otherDeviceTabs, STALE_MS } = require('./tabsync');

let run = 0;
const test = (name, fn) => { fn(); run++; console.log(`  ok  ${name}`); };

const NOW = 1_800_000_000_000;
const H = 3600 * 1000;
const dev = (name, at, open = {}, closed = {}) => ({
  name, at, personas: { p1: { open: Object.fromEntries(Object.entries(open).map(([u, a]) => [u, { title: 't ' + u, at: a, dev: name }])), closed } },
});

console.log('pruneStaleDevices');

test('keeps live devices and this device', () => {
  const d = { me: dev('Windows', NOW - 10 * STALE_MS, { 'https://a.com/': 1 }), ph: dev('Phone', NOW - H, { 'https://b.com/': 2 }) };
  const out = pruneStaleDevices(d, NOW, STALE_MS, 'me');
  assert.deepStrictEqual(Object.keys(out).sort(), ['me', 'ph']);
  assert.ok(out.me.personas.p1.open['https://a.com/']);
});

test('drops a device silent for more than 3 days', () => {
  const d = { old: dev('Windows', NOW - 121 * H, { 'https://a.com/': 1 }), ph: dev('Phone', NOW - H) };
  assert.deepStrictEqual(Object.keys(pruneStaleDevices(d, NOW, STALE_MS, 'x')), ['ph']);
});

test('exactly 3 days is still live', () => {
  const d = { ph: dev('Phone', NOW - STALE_MS, { 'https://a.com/': 1 }) };
  assert.ok(pruneStaleDevices(d, NOW, STALE_MS, 'x').ph.personas.p1.open['https://a.com/']);
});

test('a stale device sheds open facts but keeps close facts inside the tombstone TTL', () => {
  const d = { old: dev('Windows', NOW - 5 * 24 * H, { 'https://a.com/': 1 }, { 'https://c.com/': NOW - 4 * 24 * H, 'https://z.com/': NOW - 40 * 24 * H }) };
  const out = pruneStaleDevices(d, NOW, STALE_MS, 'x');
  assert.deepStrictEqual(out.old.personas.p1, { closed: { 'https://c.com/': NOW - 4 * 24 * H } });
});

test('does not mutate its input', () => {
  const d = { old: dev('Windows', NOW - 121 * H, { 'https://a.com/': 1 }) };
  const before = JSON.stringify(d);
  pruneStaleDevices(d, NOW, STALE_MS, 'x');
  assert.strictEqual(JSON.stringify(d), before);
});

console.log('otherDeviceTabs');

test('lists other devices newest first, grouped by name', () => {
  const d = {
    me: dev('Windows', NOW, { 'https://mine.com/': 5 }),
    ph: dev('Phone', NOW, { 'https://a.com/': 10, 'https://b.com/': 30 }),
    w2: dev('Tablet', NOW, { 'https://c.com/': 50 }),
  };
  const out = otherDeviceTabs(d, 'me', [], () => false);
  assert.deepStrictEqual(out.map((g) => g.device), ['Tablet', 'Phone']);
  assert.deepStrictEqual(out[1].tabs.map((t) => t.url), ['https://b.com/', 'https://a.com/']);
});

test('excludes URLs open here (canonically) and adult URLs', () => {
  const d = { ph: dev('Phone', NOW, { 'https://a.com/x': 1, 'https://b.com/': 2, 'https://adult.test/': 3 }) };
  const out = otherDeviceTabs(d, 'me', ['https://a.com/x/'], (u) => u.includes('adult'));
  assert.deepStrictEqual(out[0].tabs.map((t) => t.url), ['https://b.com/']);
});

test('a device with nothing left to list has no group', () => {
  const d = { ph: dev('Phone', NOW, { 'https://a.com/': 1 }) };
  assert.deepStrictEqual(otherDeviceTabs(d, 'me', ['https://a.com/'], null), []);
});

test('silent devices are never listed when now is given', () => {
  const d = { old: dev('Windows', NOW - 121 * H, { 'https://a.com/': 1 }), ph: dev('Phone', NOW, { 'https://b.com/': 2 }) };
  const out = otherDeviceTabs(d, 'me', [], null, NOW);
  assert.deepStrictEqual(out.map((g) => g.device), ['Phone']);
});

test('the same URL on two personas lists once', () => {
  const d = { ph: { name: 'Phone', at: NOW, personas: { p1: { open: { 'https://a.com/': { title: 'A', at: 1 } } }, p2: { open: { 'https://a.com/': { title: 'A2', at: 9 } } } } } };
  const out = otherDeviceTabs(d, 'me', [], null);
  assert.strictEqual(out[0].tabs.length, 1);
  assert.strictEqual(out[0].tabs[0].at, 9);
});

console.log(`\n${run} tests passed`);
