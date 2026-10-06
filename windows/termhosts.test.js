// #214 tests:  node windows/termhosts.test.js
const assert = require('assert');
const th = require('./termhosts');

let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

console.log('ssh config');
const cfg = th.parseSshConfig(`
# comment
Host forge dh
  HostName dockerhost.tailb8b575.ts.net
  User brandon
  IdentityFile ~/.ssh/id_forge

Host pve01
  HostName=10.0.0.20
  Port 2222
  User root
  User ignored-second-value

Host *.lan !nas.lan
  User lanuser

Host *
  User fallback
  Port 22

Match host foo
  User never
`);
eq(th.configHosts(cfg), ['forge', 'dh', 'pve01'], 'pickable aliases only: no wildcards, no negations');
eq(th.resolveHost(cfg, 'forge'), { host: 'dockerhost.tailb8b575.ts.net', username: 'brandon', port: 22, identityFile: '~/.ssh/id_forge' }, 'alias resolves; Host * fills Port');
eq(th.resolveHost(cfg, 'pve01'), { host: '10.0.0.20', username: 'root', port: 2222, identityFile: null }, 'first value wins, key=value form');
eq(th.resolveHost(cfg, 'box.lan').username, 'lanuser', 'wildcard block');
eq(th.resolveHost(cfg, 'nas.lan').username, 'fallback', 'negated pattern excludes');
eq(th.resolveHost(cfg, 'elsewhere'), { host: 'elsewhere', username: 'fallback', port: 22, identityFile: null }, 'unlisted host keeps its name');
eq(th.resolveHost(th.parseSshConfig(''), 'x'), { host: 'x', username: null, port: null, identityFile: null }, 'no config at all');
eq(th.resolveHost(th.parseSshConfig('Host a\n  HostName %h.example.com'), 'a').host, 'a.example.com', '%h expands');
eq(th.configHosts(th.parseSshConfig('Host a\r\n  User b\r\nHost c')), ['a', 'c'], 'CRLF files');

console.log('frequency');
eq(th.rankFrequent({ a: 3, b: 10, c: 3, d: 0 }), ['b', 'a', 'c'], 'most used first, ties alphabetical, zero dropped');
eq(th.rankFrequent({ a: 1, b: 2, c: 3 }, 2), ['c', 'b'], 'limit');
eq(th.rankFrequent(null), [], 'nothing yet');

console.log('connectionGroups');
eq(th.connectionGroups({ favorites: ['forge'], uses: { forge: 9, pve01: 4, x: 1 }, configHosts: ['forge', 'pve01', 'dh'] }),
  { favorites: ['forge'], frequent: ['pve01', 'x'], config: ['dh'] }, 'each host once: Favorites > Frequent > config');
eq(th.connectionGroups(), { favorites: [], frequent: [], config: [] }, 'empty');

console.log('validTarget');
for (const t of ['dockerhost', 'brandon@dockerhost', 'brandon@dockerhost:2222', 'u@[::1]:22', '10.0.0.160']) eq(th.validTarget(t), true, t);
for (const t of ['', 'a b', 'x;rm -rf', '@host', 'host:']) eq(th.validTarget(t), false, JSON.stringify(t));

console.log(`termhosts: ${n} passed`);
