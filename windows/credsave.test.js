// #145 tests:  node windows/credsave.test.js
const assert = require('assert');
const { decide, promptFor } = require('./credsave');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const cred = (origin, username, password, id) => ({ origin, username, password, id: id || `${origin}|${username}` });
const STORE = [cred('https://github.red.datadirectnet.com', 'bbell', 'old-password')];

console.log('the two cases that were asked for');

test('a password that changed offers UPDATE, not save', () => {
  const d = decide(STORE, {
    origin: 'https://github.red.datadirectnet.com',
    username: 'bbell',
    password: 'new-password',
  });
  assert.strictEqual(d.action, 'update');
  assert.strictEqual(d.id, STORE[0].id, 'must target the existing entry, not create a second');
});

test('a site with nothing saved offers SAVE', () => {
  const d = decide(STORE, { origin: 'https://newsite.test', username: 'me', password: 'p' });
  assert.strictEqual(d.action, 'save');
});

console.log('the ways this could corrupt the store');

test('an unchanged password says nothing at all', () => {
  const d = decide(STORE, {
    origin: 'https://github.red.datadirectnet.com',
    username: 'bbell',
    password: 'old-password',
  });
  assert.strictEqual(d.action, 'none');
});

test('a DIFFERENT username on a known site is an addition, never an update', () => {
  // Overwriting here would destroy a working credential for the other account.
  const d = decide(STORE, {
    origin: 'https://github.red.datadirectnet.com',
    username: 'someone-else',
    password: 'p',
  });
  assert.strictEqual(d.action, 'add');
  assert.strictEqual(d.id, undefined);
});

test('username case does not create a second entry for one account', () => {
  const d = decide(STORE, {
    origin: 'https://github.red.datadirectnet.com',
    username: 'BBell',
    password: 'new-password',
  });
  assert.strictEqual(d.action, 'update', 'BBell and bbell are one account to the site');
});

test('surrounding whitespace in a username does not fork the entry', () => {
  const d = decide(STORE, {
    origin: 'https://github.red.datadirectnet.com',
    username: '  bbell ',
    password: 'new-password',
  });
  assert.strictEqual(d.action, 'update');
});

console.log('matching is credmatch, so a subdomain is the same site');

test('a login submitted on a sibling subdomain updates the existing entry', () => {
  const store = [cred('https://www.chase.com', 'bbell', 'old')];
  const d = decide(store, { origin: 'https://secure.chase.com', username: 'bbell', password: 'new' });
  assert.strictEqual(d.action, 'update');
});

test('an unrelated lookalike domain is a NEW site, not an update', () => {
  const store = [cred('https://chase.com', 'bbell', 'old')];
  const d = decide(store, { origin: 'https://chase.com.evil.tld', username: 'bbell', password: 'new' });
  assert.strictEqual(d.action, 'save');
});

console.log('nothing is offered for input that is not a login');

test('a blank password is never stored', () => {
  for (const password of ['', null, undefined]) {
    assert.strictEqual(decide(STORE, { origin: 'https://x.test', username: 'u', password }).action, 'none');
  }
});

test('a missing origin is never stored', () => {
  assert.strictEqual(decide(STORE, { origin: '', username: 'u', password: 'p' }).action, 'none');
  assert.strictEqual(decide(STORE, { username: 'u', password: 'p' }).action, 'none');
});

test('an empty username is still a valid login (some sites have only a password)', () => {
  const d = decide([], { origin: 'https://x.test', username: '', password: 'p' });
  assert.strictEqual(d.action, 'save');
});

test('an empty or missing store does not throw', () => {
  for (const store of [[], null, undefined]) {
    assert.strictEqual(decide(store, { origin: 'https://x.test', username: 'u', password: 'p' }).action, 'save');
  }
});

test('junk submissions do not throw', () => {
  for (const sub of [null, undefined, {}, 'nope', 42]) {
    assert.strictEqual(decide(STORE, sub).action, 'none');
  }
});

console.log('the wording tells the truth about what will happen');

test('update says Update and names the account, save says Save', () => {
  const upd = promptFor(
    decide(STORE, { origin: 'https://github.red.datadirectnet.com', username: 'bbell', password: 'new' }),
    'https://github.red.datadirectnet.com'
  );
  assert.strictEqual(upd.confirm, 'Update');
  assert.ok(upd.title.includes('bbell'), 'must say WHICH login changes');

  const sav = promptFor(decide([], { origin: 'https://newsite.test', username: 'u', password: 'p' }), 'https://newsite.test');
  assert.strictEqual(sav.confirm, 'Save');
});

test('the site name is shown without the www. noise', () => {
  const p = promptFor({ action: 'save' }, 'https://www.example.com/login?x=1');
  assert.ok(p.title.includes('example.com'));
  assert.ok(!p.title.includes('www.'));
});

test('no prompt at all for "none"', () => {
  assert.strictEqual(promptFor({ action: 'none' }, 'https://x.test'), null);
});

console.log(`\n${run} tests passed`);
