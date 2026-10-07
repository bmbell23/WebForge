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

// #214
{
  const po = require('./personaorder');
  let m = 0;
  const e2 = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); m++; };
  console.log('holdDecision (#214)');
  const key = (k, code, mods = {}) => ({ key: k, code, shift: false, control: false, alt: false, meta: false, ...mods });
  const ordered = po.orderPersonas([{ id: 'w', name: 'Work' }, { id: 'p', name: 'Personal' }]);
  const d = (input) => t.holdDecision(input, (i) => po.leaderPick(i, ordered));
  e2(d(key('Shift', 'ShiftLeft', { shift: true })), { kind: 'wait' }, 'Shift on its own keeps holding');
  e2(d(key('Control', 'ControlLeft', { control: true })), { kind: 'wait' }, 'Ctrl on its own keeps holding');
  e2(d(key('CapsLock', 'CapsLock')), { kind: 'wait' }, 'a lock key keeps holding');
  e2(d(key('Dead', 'Quote')), { kind: 'wait' }, 'a dead key keeps holding');
  e2(d(key('`', 'Backquote')), { kind: 'persona', id: 'terminal' }, '` = Terminal');
  e2(d(key('!', 'Digit1', { shift: true })), { kind: 'persona', id: 'slot-work-mattermost' }, '! = Work Mattermost');
  e2(d(key('$', 'Digit4', { shift: true })), { kind: 'persona', id: 'p' }, '$ = Personal');
  e2(d(key('^', 'Digit6', { shift: true })), { kind: 'persona', id: 'slot-outlook' }, '^ = Outlook');
  e2(d(key('&', 'Digit7', { shift: true })), { kind: 'persona', id: 'slot-discord' }, '#282: Shift+7 is Discord (no & key in forge src/config.rs)');
  e2(d(key('*', 'Digit8', { shift: true })).kind, 'persona', '#307: Shift+8 is the 9th position (forge binds no *)');
  e2(d(key(')', 'Digit0', { shift: true })), { kind: 'pass' }, 'Shift+0 is forge\'s');
  e2(d(key('1', 'Digit1')), { kind: 'pass' }, 'bare 1 is a forge window jump');
  e2(d(key('r', 'KeyR')), { kind: 'pass' }, 'a letter passes');
  e2(d(key('Escape', 'Escape')), { kind: 'pass' }, 'Esc passes; forge cancels');
  e2(t.CTRL_SPACE, '\x1b[32;5u', 'Ctrl+Space as kitty CSI-u');
  // #256: typing a password
  e2(t.lineEdit('', 'hunter2'), { buf: 'hunter2', submit: false, cancel: false, echo: '' }, 'a password never echoes');
  e2(t.lineEdit('hunter', '2\r'), { buf: 'hunter2', submit: true, cancel: false, echo: '\r\n' }, 'Enter submits');
  e2(t.lineEdit('abc', '\x7f\x7f').buf, 'a', 'Backspace edits');
  e2(t.lineEdit('', '\x7f').buf, '', 'Backspace on empty is harmless');
  e2(t.lineEdit('secret', '\x03').cancel, true, 'Ctrl+C cancels');
  e2(t.lineEdit('', 'a\x1b[Ab\x1bOD').buf, 'ab', 'arrow keys are dropped whole');
  e2(t.lineEdit('', 'bob', true).echo, 'bob', 'an echoed prompt shows what you type');
  e2(t.lineEdit('bo', '\x7f', true).echo, '\b \b', 'and erases on Backspace');
  // #249: replacing a changed key
  const kh = [
    '# comment',
    'co-sf-pe-042 ssh-ed25519 OLDKEY',
    'co-sf-pe-042,10.36.21.5 ssh-ed25519 OLDKEY',
    'co-sf-pe-042 ssh-rsa RSAKEY',
    '[co-sf-pe-042]:2222 ssh-ed25519 OTHERPORT',
    '*.colorado.example ssh-ed25519 WILD',
    '|1|abc=|def= ssh-ed25519 HASHED',
    'pve01 ssh-ed25519 PVE',
  ].join('\n');
  e2(t.knownHostsWithout(kh, 'co-sf-pe-042', 22, 'ssh-ed25519').split('\n'), [
    '# comment',
    '10.36.21.5 ssh-ed25519 OLDKEY',
    'co-sf-pe-042 ssh-rsa RSAKEY',
    '[co-sf-pe-042]:2222 ssh-ed25519 OTHERPORT',
    '*.colorado.example ssh-ed25519 WILD',
    '|1|abc=|def= ssh-ed25519 HASHED',
    'pve01 ssh-ed25519 PVE',
  ], 'drops only this host:port + key type; a shared line keeps its other name; wildcards, hashed and other ports stay');
  const kb2 = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 1, 9])]);
  const fixed = t.knownHostsWithout(kh, 'co-sf-pe-042', 22, 'ssh-ed25519') + '\n' + t.knownHostsLine('co-sf-pe-042', 22, kb2);
  e2(t.knownHostsVerdict(fixed, 'co-sf-pe-042', 22, 'ssh-ed25519', kb2.toString('base64')), 'match', 'after the rewrite the new key matches');
  const kb = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 1, 7])]);
  e2(t.knownHostsLine('dockerhost', 22, kb), `dockerhost ssh-ed25519 ${kb.toString('base64')}`, 'known_hosts line, port 22');
  e2(t.knownHostsLine('h', 2222, kb).split(' ')[0], '[h]:2222', 'known_hosts line, other port');
  e2(t.knownHostsVerdict(t.knownHostsLine('h', 2222, kb), 'h', 2222, 'ssh-ed25519', kb.toString('base64')), 'match', 'a saved key matches next time');
  console.log(`terminal (#214): ${m} passed`);
}
