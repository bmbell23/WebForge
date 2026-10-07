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
  { favorites: ['forge'], frequent: ['pve01', 'x'], config: ['dh'], names: {} }, 'each host once: Favorites > Frequent > config');
eq(th.connectionGroups(), { favorites: [], frequent: [], config: [], names: {} }, 'empty');

console.log('validTarget');
for (const t of ['dockerhost', 'brandon@dockerhost', 'brandon@dockerhost:2222', 'u@[::1]:22', '10.0.0.160']) eq(th.validTarget(t), true, t);
for (const t of ['', 'a b', 'x;rm -rf', '@host', 'host:']) eq(th.validTarget(t), false, JSON.stringify(t));

console.log('edit a favorite (#228)');
eq(th.splitTarget('brandon@dockerhost'), { user: 'brandon', host: 'dockerhost', port: null }, 'user@host');
eq(th.splitTarget('host:2222'), { user: null, host: 'host', port: 2222 }, 'host:port');
eq(th.splitTarget('u@[::1]:22'), { user: 'u', host: '::1', port: 22 }, 'user@[v6]:port');
eq(th.splitTarget('[fe80::1]'), { user: null, host: 'fe80::1', port: null }, 'bare [v6]');
eq(th.joinTarget({ user: 'u', host: 'h', port: 2222 }), 'u@h:2222', 'join all');
eq(th.joinTarget({ host: 'h' }), 'h', 'host only');
eq(th.joinTarget({ user: 'u', host: '::1', port: 22 }), 'u@[::1]:22', 'v6 bracketed with port');
eq(th.joinTarget({ user: 'u', host: '::1' }), 'u@[::1]', 'v6 bracketed without port');
eq(th.joinTarget({ host: 'h', port: '' }), 'h', 'blank port');
eq(th.joinTarget({ host: 'h', port: 0 }), null, 'port 0');
eq(th.joinTarget({ host: 'h', port: 65536 }), null, 'port too big');
eq(th.joinTarget({ host: 'h', port: 'x' }), null, 'port not a number');
eq(th.joinTarget({ host: '' }), null, 'no host');
eq(th.joinTarget({ user: 'a b', host: 'h' }), null, 'invalid user');
for (const t of ['a@b', 'b:2222', 'u@[::1]:22']) eq(th.joinTarget(th.splitTarget(t)), t, 'round trip ' + t);
const base = { favorites: ['a', 'x@b', 'c'], uses: { 'x@b': 3, 'y@b': 2 }, names: { 'x@b': 'Old', c: 'See' } };
const snap = JSON.stringify(base);
const r1 = th.renameFavorite(base, 'x@b', { name: ' New ', user: 'y', host: 'b' });
eq(r1.ok, true, 'rename ok');
eq(r1.target, 'y@b', 'new target');
eq(r1.hosts.favorites, ['a', 'y@b', 'c'], 'same position');
eq(r1.hosts.uses, { 'y@b': 5 }, 'uses moved and summed');
eq(r1.hosts.names, { 'y@b': 'New', c: 'See' }, 'name trimmed, old name removed');
eq(JSON.stringify(base), snap, 'input not mutated');
eq(th.renameFavorite(base, 'x@b', { name: '', user: 'x', host: 'b' }).hosts.names, { c: 'See' }, 'blank name clears');
eq(th.renameFavorite(base, 'x@b', { name: 'x@b', user: 'x', host: 'b' }).hosts.names, { c: 'See' }, 'name equal to target clears');
eq(th.renameFavorite(base, 'x@b', { name: 'N', user: 'x', host: 'b', port: 2200 }).hosts.uses, { 'x@b:2200': 3, 'y@b': 2 }, 'uses follow the target');
eq(th.renameFavorite(base, 'x@b', { host: 'a' }).ok, false, 'already another favorite');
eq(th.renameFavorite(base, 'x@b', { host: 'a b' }).ok, false, 'invalid');
eq(th.renameFavorite(base, 'nope', { host: 'z' }).ok, false, 'unknown favorite');
eq(th.renameFavorite(base, 'a', { name: 'Alpha', host: 'a' }).hosts.names.a, 'Alpha', 'name-only edit');
eq(th.connectionGroups({ favorites: ['a', 'b'], names: { a: 'Alpha', z: 'Stray' } }).names, { a: 'Alpha' }, 'names only for favorites');

eq(th.connectionGroups({ favorites: ['root@pve01'], uses: { pve01: 3, 'brandon@pve01': 2 }, configHosts: ['pve01', 'dh'] }),
  { favorites: ['root@pve01'], frequent: ['brandon@pve01'], config: ['dh'], names: {} },
  '#241: a Favorite hides its bare host, not another user on it');
// #280: delete connections
eq(th.connectionGroups({ favorites: ['a'], uses: { f1: 3, f2: 2 }, configHosts: ['c1', 'c2'], hidden: ['f1', 'c2'] }),
  { favorites: ['a'], frequent: ['f2'], config: ['c1'], names: {} }, 'hidden leaves frequent and config');
eq(th.connectionGroups({ favorites: ['a'], hidden: ['a'] }).favorites, ['a'], 'favorites never hidden');
eq(th.connectionGroups({ favorites: ['a'], uses: { f: 1 } }).frequent, ['f'], 'hidden defaults to none');
const pre280 = { favorites: ['a', 'b'], uses: { a: 2, f: 1 }, names: { a: 'Alpha' }, hidden: ['h'] };
const snap280 = JSON.parse(JSON.stringify(pre280));
const rf280 = th.removeConnection(pre280, 'a', 'favorites');
eq(rf280, { favorites: ['b'], uses: { f: 1 }, names: {}, hidden: ['h'] }, 'favorites: drops star, name and uses');
eq(th.removeConnection(pre280, 'f', 'frequent'), { favorites: ['a', 'b'], uses: { a: 2 }, names: { a: 'Alpha' }, hidden: ['h'] }, 'frequent: forgets uses only');
eq(th.removeConnection(pre280, 'c', 'config').hidden, ['h', 'c'], 'config: hides');
eq(th.removeConnection(pre280, 'h', 'config').hidden, ['h'], 'config: hidden deduped');
eq(th.removeConnection({ favorites: [], uses: {}, names: {} }, 'c', 'config').hidden, ['c'], 'hidden created when missing');
eq(th.removeConnection(pre280, 'a', 'bogus').favorites, ['a', 'b'], 'unknown group changes nothing');
eq(pre280, snap280, 'input not mutated');

console.log('local shells (#276)');
eq(th.connectionGroups({ platform: 'win32' }).local, [{ target: 'local:powershell', label: 'PowerShell' }, { target: 'local:cmd', label: 'Command Prompt' }], 'win32 local group');
eq(th.connectionGroups({ platform: 'darwin' }).local, [{ target: 'local:shell', label: 'Terminal' }], 'darwin local group');
eq(th.connectionGroups({ platform: 'linux' }).local, [{ target: 'local:shell', label: 'Terminal' }], 'linux local group');
eq(Object.keys(th.connectionGroups({ platform: 'linux' }))[0], 'local', 'local group comes first');
eq('local' in th.connectionGroups({}), false, 'no platform, no local group');
eq(th.validTarget('local:powershell') && th.validTarget('local:shell') && th.validTarget('local:cmd'), true, 'local targets are valid');
eq(th.validTarget('local:'), false, 'bare local: is not');
eq(th.validTarget('local:Power Shell'), false, 'junk after local: is not');

console.log(`termhosts:${n} passed`);
