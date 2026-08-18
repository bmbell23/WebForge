// #136 tests:  node windows/credmatch.test.js
const assert = require('assert');
const { matchFor, bestMatch, baseDomain } = require('./credmatch');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const cred = (origin, username = 'me') => ({ origin, username, password: 'p', id: origin + username });
const names = (list) => list.map((m) => m.entry.origin);

console.log('the case that made us write this');

test('a login saved for www.chase.com fills on chase.com and secure.chase.com', () => {
  const store = [cred('https://www.chase.com')];
  for (const url of [
    'https://www.chase.com/login',
    'https://chase.com/login',
    'https://secure.chase.com/auth',
  ]) {
    assert.ok(bestMatch(store, url), `should fill on ${url}`);
  }
});

console.log('ranking: the most specific saved entry wins');

test('exact origin beats same host beats same domain', () => {
  const store = [
    cred('https://login.example.com'), // domain-level
    cred('http://www.example.com'), // host-level (scheme upgrade)
    cred('https://www.example.com'), // exact
  ];
  const ranked = matchFor(store, 'https://www.example.com/signin');
  assert.deepStrictEqual(ranked.map((m) => m.tierName), ['origin', 'host', 'domain']);
  assert.strictEqual(bestMatch(store, 'https://www.example.com/signin').origin, 'https://www.example.com');
});

test('equal-tier entries keep the store order', () => {
  const store = [cred('https://a.example.com', 'first'), cred('https://b.example.com', 'second')];
  const ranked = matchFor(store, 'https://c.example.com');
  assert.deepStrictEqual(ranked.map((m) => m.entry.username), ['first', 'second']);
});

test('a port difference is not an exact origin, but is still the same host', () => {
  const ranked = matchFor([cred('https://app.local:8443')], 'https://app.local:9000/x');
  assert.strictEqual(ranked[0].tierName, 'host');
});

console.log('the dangerous cases — filling the WRONG site');

test('a lookalike suffix domain never matches', () => {
  assert.strictEqual(bestMatch([cred('https://example.com')], 'https://example.com.evil.tld/login'), null);
});

test('two different sites under co.uk never match each other', () => {
  assert.strictEqual(bestMatch([cred('https://barclays.co.uk')], 'https://hsbc.co.uk/login'), null);
  // ...but the same site still matches across its own subdomains.
  assert.ok(bestMatch([cred('https://barclays.co.uk')], 'https://online.barclays.co.uk/login'));
});

test('the same guard holds for other multi-part suffixes', () => {
  for (const [a, b] of [
    ['https://alpha.com.au', 'https://beta.com.au'],
    ['https://alpha.co.jp', 'https://beta.co.jp'],
    ['https://alpha.com.br', 'https://beta.com.br'],
  ]) {
    assert.strictEqual(bestMatch([cred(a)], b), null, `${a} must not fill on ${b}`);
  }
});

test('a bare public suffix cannot be a registrable domain', () => {
  assert.strictEqual(baseDomain('co.uk'), null);
  assert.strictEqual(baseDomain('com.au'), null);
});

test('an https credential is NEVER carried onto a plaintext page', () => {
  assert.strictEqual(bestMatch([cred('https://bank.com')], 'http://bank.com/login'), null);
  assert.strictEqual(bestMatch([cred('https://www.bank.com')], 'http://login.bank.com/'), null);
});

test('the reverse — saved http, page https — is an upgrade and is allowed', () => {
  assert.ok(bestMatch([cred('http://intranet.corp.com')], 'https://intranet.corp.com/'));
});

test('unrelated domains never match', () => {
  assert.strictEqual(bestMatch([cred('https://example.com')], 'https://example.org/'), null);
  assert.strictEqual(bestMatch([cred('https://notexample.com')], 'https://example.com/'), null);
});

console.log('hosts with no domain hierarchy fall back to exact host');

test('IP addresses match only themselves', () => {
  assert.ok(bestMatch([cred('http://10.0.0.160:8012')], 'http://10.0.0.160:8012/x'));
  assert.strictEqual(bestMatch([cred('http://10.0.0.160')], 'http://10.0.0.161/'), null);
  assert.strictEqual(baseDomain('10.0.0.160'), null);
});

test('single-label intranet names match only themselves', () => {
  assert.ok(bestMatch([cred('http://localhost:3000')], 'http://localhost:3000/'));
  assert.strictEqual(bestMatch([cred('http://localhost')], 'http://dockerhost/'), null);
});

console.log('parsing is forgiving about what got stored');

test('a hand-typed bare host is treated as https', () => {
  assert.ok(bestMatch([cred('chase.com')], 'https://www.chase.com/login'));
});

test('case and a trailing dot in the host do not matter', () => {
  assert.ok(bestMatch([cred('https://WWW.Example.COM')], 'https://example.com./'));
});

test('a full URL with a path stored as the origin still matches', () => {
  assert.ok(bestMatch([cred('https://www.example.com/login?x=1')], 'https://example.com/'));
});

console.log('junk never throws and never fills');

test('unparseable or non-web entries are skipped, not matched', () => {
  const store = [
    cred(''), cred('   '), cred('not a url at all $$'),
    cred('file:///c:/x'), cred('javascript:alert(1)'), { username: 'no origin' }, null,
  ];
  assert.deepStrictEqual(matchFor(store, 'https://example.com/'), []);
});

test('a non-web page URL matches nothing', () => {
  const store = [cred('https://example.com')];
  for (const url of ['file:///c:/newtab.html', 'about:blank', '', null, 'garbage']) {
    assert.deepStrictEqual(matchFor(store, url), [], `${url} should match nothing`);
  }
});

test('a missing or non-array store does not throw', () => {
  for (const store of [null, undefined, {}, 'nope']) {
    assert.deepStrictEqual(matchFor(store, 'https://example.com/'), []);
  }
});

console.log(`\n${run} tests passed`);
