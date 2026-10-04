// #141 tests:  node windows/autofillframes.test.js
const assert = require('assert');
const { planFills, fillFrames } = require('./autofillframes');

let run = 0;
const pending = [];
const test = (name, fn) => {
  pending.push(async () => {
    await fn();
    run++;
    console.log(`  ok  ${name}`);
  });
};

const section = (title) => pending.push(async () => console.log(title));

const cred = (origin, username = 'me') => ({ origin, username, password: 'p', id: origin + username });

// A fake WebFrameMain: url, parent, framesInSubtree, and an executeJavaScript
// that returns whatever this frame's form would and records that it ran.
let nextId = 1;
function frame(url, { parent = null, result = false } = {}) {
  const f = { frameTreeNodeId: nextId++, url, parent, detached: false, ran: [], result };
  f.executeJavaScript = async (code) => {
    f.ran.push(code);
    return typeof f.result === 'function' ? f.result() : f.result;
  };
  return f;
}
function page(topUrl, opts) {
  const top = frame(topUrl, opts);
  top.framesInSubtree = [top];
  top.add = (url, o = {}) => {
    const child = frame(url, { parent: o.parent || top, result: o.result });
    top.framesInSubtree.push(child);
    return child;
  };
  return top;
}

section('#141: the case that made us write this');

test('Schwab: the login iframe gets the schwab credential', async () => {
  const top = page('https://client.schwab.com/Areas/Access/Login');
  const widget = top.add('https://sws-gateway-nr.schwab.com/ui/host/?clientid=schwab-secondary', { result: 'filled' });
  assert.strictEqual(await fillFrames(top, [cred('https://client.schwab.com')]), 'filled');
  assert.strictEqual(widget.ran.length, 1);
});

section('which frames are tried');

test('the top frame is tried first, so plain login pages behave as before', async () => {
  const top = page('https://example.com/login', { result: 'filled' });
  const child = top.add('https://example.com/widget', { result: 'filled' });
  assert.deepStrictEqual(planFills([cred('https://example.com')], top).map((p) => p.frame), [top, child]);
  assert.strictEqual(await fillFrames(top, [cred('https://example.com')]), 'filled');
  assert.strictEqual(child.ran.length, 0, 'stops at the first frame that fills');
});

test('a third-party embed of a bank login is never filled', async () => {
  const top = page('https://evil.com/');
  const bank = top.add('https://sws-gateway-nr.schwab.com/ui/host/', { result: 'filled' });
  assert.strictEqual(await fillFrames(top, [cred('https://client.schwab.com')]), false);
  assert.strictEqual(bank.ran.length, 0);
});

test('a same-site login nested under a third-party frame is not filled', async () => {
  const top = page('https://www.schwab.com/');
  const ad = top.add('https://ads.evil.com/slot');
  const login = top.add('https://login.schwab.com/', { parent: ad, result: 'filled' });
  assert.strictEqual(await fillFrames(top, [cred('https://www.schwab.com')]), false);
  assert.strictEqual(login.ran.length, 0);
});

test('a same-site login nested two same-site frames deep is filled', async () => {
  const top = page('https://www.example.com/');
  const mid = top.add('https://app.example.com/shell');
  const login = top.add('https://login.example.com/', { parent: mid, result: 'filled' });
  assert.strictEqual(await fillFrames(top, [cred('https://login.example.com')]), 'filled');
  assert.strictEqual(login.ran.length, 1);
});

test('about:blank and data: frames are skipped', async () => {
  const top = page('https://example.com/');
  const blank = top.add('about:blank', { result: 'filled' });
  const data = top.add('data:text/html,x', { result: 'filled' });
  await fillFrames(top, [cred('https://example.com')]);
  assert.strictEqual(blank.ran.length + data.ran.length, 0);
});

test('the credential is picked from the frame URL, not the top page', () => {
  const top = page('https://www.example.com/');
  top.add('https://login.example.com/');
  const store = [cred('https://login.example.com', 'frame-user'), cred('https://www.example.com', 'top-user')];
  assert.deepStrictEqual(planFills(store, top).map((p) => p.match.username), ['top-user', 'frame-user']);
});

test('no saved login for the site means nothing runs anywhere', async () => {
  const top = page('https://example.com/', { result: 'filled' });
  assert.strictEqual(await fillFrames(top, [cred('https://other.com')]), false);
  assert.strictEqual(top.ran.length, 0);
});

section('results and failure modes');

test("a two-step 'user' in one frame is reported when nothing filled", async () => {
  const top = page('https://example.com/');
  top.add('https://login.example.com/', { result: 'user' });
  assert.strictEqual(await fillFrames(top, [cred('https://example.com')]), 'user');
});

test('a frame that navigated since planning gets nothing', async () => {
  const top = page('https://example.com/');
  const child = top.add('https://login.example.com/');
  // executeJavaScript on the top frame is where the child moves away
  top.result = () => {
    child.url = 'https://evil.com/';
    return false;
  };
  child.result = 'filled';
  assert.strictEqual(await fillFrames(top, [cred('https://example.com')]), false);
  assert.strictEqual(child.ran.length, 0);
});

test('a detached frame, or one that throws, does not break the others', async () => {
  const top = page('https://example.com/');
  const gone = top.add('https://a.example.com/', { result: 'filled' });
  gone.detached = true;
  const broken = top.add('https://b.example.com/');
  broken.executeJavaScript = () => {
    throw new Error('Render frame was disposed');
  };
  const good = top.add('https://c.example.com/', { result: 'filled' });
  assert.strictEqual(await fillFrames(top, [cred('https://example.com')]), 'filled');
  assert.strictEqual(gone.ran.length, 0);
  assert.strictEqual(good.ran.length, 1);
});

test('a missing main frame returns false', async () => {
  assert.strictEqual(await fillFrames(null, [cred('https://example.com')]), false);
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${run} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
