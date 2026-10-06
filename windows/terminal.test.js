// #206 tests:  node windows/terminal.test.js
const assert = require('assert');
const path = require('path');
const t = require('./terminal');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

console.log('parseTarget');
eq(t.parseTarget('brandon@dockerhost'), { username: 'brandon', host: 'dockerhost', port: 22 }, 'default port');
eq(t.parseTarget('brandon@dockerhost:2222'), { username: 'brandon', host: 'dockerhost', port: 2222 }, 'explicit port');
eq(t.parseTarget('dockerhost'), { username: null, host: 'dockerhost', port: 22 }, 'no username');
eq(t.parseTarget('u@[::1]:2200'), { username: 'u', host: '::1', port: 2200 }, 'bracketed host');

console.log('knownHostsVerdict');
const K1 = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const K2 = 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const v = (text, host, port, type, key) => t.knownHostsVerdict(text, host, port, type, key);
eq(v(`dockerhost ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'match', 'plain entry');
eq(v(`dockerhost ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K2), 'mismatch', 'different key');
eq(v(`other ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', 'not listed');
eq(v('', 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', 'empty file');
eq(v(`a,dockerhost,10.0.0.160 ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'match', 'comma list');
eq(v(`[dockerhost]:2222 ssh-ed25519 ${K1}`, 'dockerhost', 2222, 'ssh-ed25519', K1), 'match', '[host]:port');
eq(v(`[dockerhost]:2222 ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', 'port 22 is not port 2222');
eq(v(`dockerhost ssh-ed25519 ${K1}`, 'dockerhost', 2222, 'ssh-ed25519', K1), 'unknown', 'plain entry is port 22 only');
eq(v(`[dockerhost]:22 ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'match', '[host]:22 is port 22');
eq(v(`|1|abc=|def= ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', 'hashed entries skipped');
eq(v(`@revoked dockerhost ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', '@revoked skipped');
eq(v(`@cert-authority dockerhost ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', '@cert-authority skipped');
eq(v(`# dockerhost ssh-ed25519 ${K1}\n`, 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', 'comment skipped');
eq(v(`dockerhost ssh-rsa ${K2}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'unknown', 'other key type only');
eq(v(`dockerhost ssh-rsa ${K2}\r\ndockerhost ssh-ed25519 ${K1} me@box\r\n`, 'dockerhost', 22, 'ssh-ed25519', K1), 'match', 'CRLF and comment field');
eq(v(`dockerhost ssh-ed25519 ${K2}\ndockerhost ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'match', 'any listed key may match');
eq(v(`*.lan ssh-ed25519 ${K1}`, 'box.lan', 22, 'ssh-ed25519', K1), 'match', 'wildcard');
eq(v(`*.lan,!box.lan ssh-ed25519 ${K1}`, 'box.lan', 22, 'ssh-ed25519', K1), 'unknown', 'negation');
eq(v(`DockerHost ssh-ed25519 ${K1}`, 'dockerhost', 22, 'ssh-ed25519', K1), 'match', 'case-insensitive host');

console.log('key wire format');
const wire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.alloc(36)]);
eq(t.keyTypeOf(wire), 'ssh-ed25519', 'key type read from the blob');
ok(/^SHA256:[A-Za-z0-9+/]{43}$/.test(t.fingerprint(wire)), 'fingerprint is unpadded SHA256 base64');

console.log('osc52Text');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
eq(t.osc52Text('c;' + b64('hello')), 'hello', 'plain');
eq(t.osc52Text(';' + b64('hello')), 'hello', 'empty selection');
eq(t.osc52Text('c;' + b64('héllo ✓ 日本')), 'héllo ✓ 日本', 'UTF-8');
eq(t.osc52Text('c;?'), null, 'read request ignored');
eq(t.osc52Text('c;'), null, 'empty payload (a clear request)');
eq(t.osc52Text('c;%%%%'), null, 'bad base64');
eq(t.osc52Text('c;abc'), null, 'unpadded base64');
eq(t.osc52Text('c;' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')), null, 'not UTF-8');
eq(t.osc52Text('nosemicolon'), null, 'no separator');
eq(t.osc52Text('c;' + 'A'.repeat(t.OSC52_MAX_BASE64 + 4)), null, 'over the cap');
ok(t.osc52Text('c;' + b64('x'.repeat(1000000))).length === 1000000, '1 MB is allowed');

console.log('keyCandidates');
eq(t.keyCandidates('/h').map((p) => path.basename(p)), ['id_ed25519', 'id_ecdsa', 'id_rsa'], 'order');
ok(t.keyCandidates('/h').every((p) => p.startsWith(path.join('/h', '.ssh'))), 'under ~/.ssh');

console.log(`${n} assertions passed`);
