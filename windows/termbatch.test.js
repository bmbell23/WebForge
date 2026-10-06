// #216 tests:  node windows/termbatch.test.js
const assert = require('assert');
const { createBatcher } = require('./termbatch');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('several pushes become one flush after the delay', async () => {
  const out = [];
  const b = createBatcher((buf) => out.push(buf), { delayMs: 10 });
  b.push(Buffer.from('ab'));
  b.push('cd');
  b.push(Buffer.from('ef'));
  assert.strictEqual(out.length, 0);
  await sleep(40);
  assert.strictEqual(out.length, 1);
  assert.ok(Buffer.isBuffer(out[0]));
  assert.strictEqual(out[0].toString(), 'abcdef');
});

test('reaching maxBytes flushes immediately', async () => {
  const out = [];
  const b = createBatcher((buf) => out.push(buf), { delayMs: 1000, maxBytes: 4 });
  b.push('ab');
  assert.strictEqual(out.length, 0);
  b.push('cd');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].toString(), 'abcd');
  b.cancel();
});

test('flushNow flushes pending data synchronously and the timer does not repeat it', async () => {
  const out = [];
  const b = createBatcher((buf) => out.push(buf), { delayMs: 10 });
  b.push('xy');
  b.flushNow();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].toString(), 'xy');
  await sleep(40);
  assert.strictEqual(out.length, 1);
});

test('cancel drops pending data and the timer', async () => {
  const out = [];
  const b = createBatcher((buf) => out.push(buf), { delayMs: 10 });
  b.push('gone');
  b.cancel();
  b.flushNow();
  await sleep(40);
  assert.strictEqual(out.length, 0);
});

test('flushNow with nothing pending does nothing', () => {
  const out = [];
  const b = createBatcher((buf) => out.push(buf));
  b.flushNow();
  assert.strictEqual(out.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`  ok  ${name}`);
  }
  console.log(`${tests.length} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
