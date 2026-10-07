// #206: the terminal spike's pure half — target parsing, known_hosts matching,
// OSC 52 decoding. Electron-free and unit-tested (terminal.test.js).
const path = require('path');
const crypto = require('crypto');

const OSC52_MAX_BASE64 = 1400000; // ~1 MB once decoded

function parseTarget(s) {
  let rest = String(s || '').trim();
  let username = null;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    username = rest.slice(0, at) || null;
    rest = rest.slice(at + 1);
  }
  let host = rest;
  let port = 22;
  const m = /^\[(.+)\](?::(\d+))?$/.exec(rest) || /^([^:]+):(\d+)$/.exec(rest);
  if (m) {
    host = m[1];
    if (m[2]) port = Number(m[2]);
  }
  return { username, host, port };
}

// OpenSSH host patterns: `*` and `?` wildcards, a leading `!` negates.
function patternMatches(pattern, name) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(name);
}

function hostListMatches(list, host, port) {
  const name = port === 22 ? host : `[${host}]:${port}`;
  let hit = false;
  for (const p of list.split(',')) {
    if (!p) continue;
    if (p.startsWith('!')) {
      if (patternMatches(p.slice(1), name)) return false;
    } else if (patternMatches(p, name) || (port === 22 && patternMatches(p, `[${host}]:22`))) {
      hit = true;
    }
  }
  return hit;
}

// 'match' — the host is listed with exactly this key.
// 'mismatch' — the host is listed with a DIFFERENT key of the same type.
// 'unknown' — not listed, only hashed entries, or listed only under other key
//   types (we cannot tell those from a legitimate second key).
function knownHostsVerdict(text, host, port, keyType, keyBase64) {
  let mismatch = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split(/\s+/);
    if (f[0].startsWith('@')) continue; // @revoked / @cert-authority
    if (f.length < 3 || f[0].startsWith('|1|')) continue;
    if (!hostListMatches(f[0], host, port)) continue;
    if (f[1] !== keyType) continue;
    if (f[2] === keyBase64) return 'match';
    mismatch = true;
  }
  return mismatch ? 'mismatch' : 'unknown';
}

// #249: known_hosts text without the entry for host:port and this key type,
// the way `ssh-keygen -R` cleans up before a changed key is re-saved. Only
// literal names are dropped (a wildcard line also covers other hosts, and the
// re-saved exact line wins anyway: a match beats a mismatch). On a shared line
// like "host,1.2.3.4" just that name goes. Hashed and @marker lines are kept.
function knownHostsWithout(text, host, port, keyType) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const f = line.split(/\s+/);
    if (!line || line.startsWith('#') || f[0].startsWith('@') || f[0].startsWith('|1|') || f.length < 3 || f[1] !== keyType) {
      out.push(raw);
      continue;
    }
    const names = f[0].split(',');
    const kept = names.filter((p) => !p || p.startsWith('!') || /[*?]/.test(p) || !hostListMatches(p, host, port));
    if (kept.length === names.length) out.push(raw);
    else if (kept.some((p) => p && !p.startsWith('!'))) out.push([kept.join(','), ...f.slice(1)].join(' '));
  }
  return out.join('\n');
}

// #256: one chunk of typing into a password / server prompt. Returns the new
// buffer, whether Enter submitted it or Ctrl+C cancelled it, and what to echo
// (only for prompts the server marks as echoed; passwords echo nothing).
function lineEdit(buf, data, echo = false) {
  let out = '';
  // Arrow keys and other escape sequences mean nothing in a password: drop them whole.
  const text = String(data).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO.|\x1b./g, '');
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') return { buf, submit: true, cancel: false, echo: out + '\r\n' };
    if (ch === '\x03') return { buf: '', submit: false, cancel: true, echo: out + '^C\r\n' };
    if (ch === '\x7f' || ch === '\b') {
      if (buf) {
        buf = [...buf].slice(0, -1).join('');
        if (echo) out += '\b \b';
      }
      continue;
    }
    if (ch < ' ' || ch === '\x1b') continue; // control keys and escape sequences start
    buf += ch;
    if (echo) out += ch;
  }
  return { buf, submit: false, cancel: false, echo: out };
}

// The SSH wire format starts with a length-prefixed key type string.
function keyTypeOf(keyBuf) {
  const n = keyBuf.readUInt32BE(0);
  return keyBuf.toString('latin1', 4, 4 + n);
}

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

// `data` is the OSC 52 payload: "<selection>;<base64>". "?" asks to READ the
// clipboard — never answered.
function osc52Text(data) {
  const s = String(data || '');
  const i = s.indexOf(';');
  if (i < 0) return null;
  const b64 = s.slice(i + 1).replace(/\s+/g, '');
  if (!b64 || b64 === '?' || b64.length > OSC52_MAX_BASE64) return null;
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function keyCandidates(homeDir) {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => path.join(homeDir, '.ssh', n));
}

// #214: the known_hosts line for a host key the user just accepted.
function knownHostsLine(host, port, keyBuf) {
  const name = port === 22 ? host : `[${host}]:${port}`;
  return `${name} ${keyTypeOf(keyBuf)} ${keyBuf.toString('base64')}`;
}

// #214: Ctrl+Space as kitty CSI-u — what forge reads as its prefix (Cora, #205).
const CTRL_SPACE = '\x1b[32;5u';

// #214: inside a terminal tab, Ctrl+Space holds the NEXT key. A Persona key
// (` and Shift+1–6, see personaorder.KEYMAP; Cora: all unbound in forge) switches
// Persona and forge never sees the prefix; any other key goes to the session
// right behind the prefix, in one write. Bare modifiers keep waiting. No timeout:
// forge never expires an armed prefix, so neither do we.
//   'wait'          a modifier on its own; keep holding
//   'persona'       switch to Persona `id` (forge sees nothing)
//   'pass'          send the prefix, then let the key through to xterm
function holdDecision(input, pick) {
  const key = String(input?.key || '').toLowerCase();
  if (['control', 'shift', 'alt', 'meta', 'altgraph', 'capslock', 'numlock', 'scrolllock', 'dead', 'unidentified'].includes(key)) {
    return { kind: 'wait' };
  }
  const id = pick(input);
  if (id) return { kind: 'persona', id };
  return { kind: 'pass' };
}

module.exports = {
  parseTarget, knownHostsVerdict, keyTypeOf, fingerprint, osc52Text, keyCandidates, OSC52_MAX_BASE64,
  knownHostsLine, CTRL_SPACE, holdDecision, lineEdit, knownHostsWithout,
};
