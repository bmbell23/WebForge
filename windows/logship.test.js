// #171 tests:  node windows/logship.test.js
const assert = require('assert');
const { create, deviceName } = require('./logship');

let run = 0;
const test = async (name, fn) => {
  await fn();
  run++;
  console.log(`  ok  ${name}`);
};

const entry = (n) => ({ at: `t${n}`, where: 'test', body: `entry ${n}` });

// A fake fetch that records every body and answers from a script of results.
function fakeFetch(results) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = results.length ? results.shift() : true;
    if (r === 'throw') throw new Error('offline');
    return { ok: r };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  console.log('device names');

  await test('a normal hostname passes through', () => {
    assert.strictEqual(deviceName('BRANDON-PC'), 'BRANDON-PC');
  });
  await test('unsafe characters become dashes and the ends are trimmed', () => {
    assert.strictEqual(deviceName('../my pc.local'), 'my-pc-local');
  });
  await test('an empty hostname still gives a usable name', () => {
    assert.strictEqual(deviceName(''), 'unknown');
    assert.strictEqual(deviceName(undefined), 'unknown');
  });
  await test('names are capped at 64 characters', () => {
    assert.strictEqual(deviceName('x'.repeat(100)).length, 64);
  });

  console.log('shipping');

  await test('a flush posts the queued entries with the version and empties the queue', async () => {
    const f = fakeFetch([true]);
    const s = create({ url: 'http://h/logs/pc', version: '1.2.3', fetch: f });
    s.push(entry(1));
    s.push(entry(2));
    assert.strictEqual(await s.flush(), true);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, 'http://h/logs/pc');
    assert.strictEqual(f.calls[0].body.version, '1.2.3');
    assert.deepStrictEqual(f.calls[0].body.entries.map((e) => e.body), ['entry 1', 'entry 2']);
    assert.strictEqual(s.size(), 0);
  });

  await test('an empty queue sends nothing', async () => {
    const f = fakeFetch([]);
    const s = create({ url: 'u', version: 'v', fetch: f });
    assert.strictEqual(await s.flush(), true);
    assert.strictEqual(f.calls.length, 0);
  });

  await test('large queues go out in batches', async () => {
    const f = fakeFetch([]);
    const s = create({ url: 'u', version: 'v', fetch: f, batch: 3 });
    for (let i = 0; i < 7; i++) s.push(entry(i));
    await s.flush();
    assert.deepStrictEqual(f.calls.map((c) => c.body.entries.length), [3, 3, 1]);
    assert.strictEqual(s.size(), 0);
  });

  console.log('failures keep the log');

  await test('a server error keeps the batch, and the next flush sends it', async () => {
    const f = fakeFetch([false, true]);
    const s = create({ url: 'u', version: 'v', fetch: f });
    s.push(entry(1));
    assert.strictEqual(await s.flush(), false);
    assert.strictEqual(s.size(), 1);
    assert.strictEqual(await s.flush(), true);
    assert.strictEqual(f.calls[1].body.entries[0].body, 'entry 1');
    assert.strictEqual(s.size(), 0);
  });

  await test('a network failure (fetch throws) keeps the batch too', async () => {
    const f = fakeFetch(['throw']);
    const s = create({ url: 'u', version: 'v', fetch: f });
    s.push(entry(1));
    assert.strictEqual(await s.flush(), false);
    assert.strictEqual(s.size(), 1);
  });

  await test('entries pushed while a send is in flight are kept, not counted as sent', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const calls = [];
    const s = create({
      url: 'u',
      version: 'v',
      fetch: async (_u, init) => {
        calls.push(JSON.parse(init.body).entries.map((e) => e.body));
        if (calls.length === 1) await gate;
        return { ok: true };
      },
    });
    s.push(entry(1));
    const p = s.flush();
    s.push(entry(2)); // arrives mid-flight
    release();
    await p;
    assert.deepStrictEqual(calls, [['entry 1'], ['entry 2']]);
    assert.strictEqual(s.size(), 0);
  });

  await test('a second flush while one is running shares it instead of double-sending', async () => {
    const f = fakeFetch([]);
    const s = create({ url: 'u', version: 'v', fetch: f });
    s.push(entry(1));
    const a = s.flush();
    const b = s.flush();
    assert.strictEqual(a, b);
    await a;
    assert.strictEqual(f.calls.length, 1);
  });

  console.log('the cap');

  await test('past the cap the OLDEST entries go, and the server is told how many', async () => {
    const f = fakeFetch([]);
    const s = create({ url: 'u', version: 'v', fetch: f, max: 3 });
    for (let i = 1; i <= 5; i++) s.push(entry(i));
    assert.strictEqual(s.size(), 3);
    await s.flush();
    const bodies = f.calls[0].body.entries.map((e) => e.body);
    assert.deepStrictEqual(bodies, ['dropped 2 entries (queue full)', 'entry 3', 'entry 4', 'entry 5']);
  });

  await test('the dropped notice is sent once, not on every later batch', async () => {
    const f = fakeFetch([]);
    const s = create({ url: 'u', version: 'v', fetch: f, max: 2 });
    for (let i = 1; i <= 3; i++) s.push(entry(i));
    await s.flush();
    s.push(entry(4));
    await s.flush();
    assert.deepStrictEqual(f.calls[1].body.entries.map((e) => e.body), ['entry 4']);
  });

  console.log(`\n${run} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
