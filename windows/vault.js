// Master-password vault (#15): everything sensitive lives AES-256-GCM
// encrypted under a scrypt-derived key that exists only in this process's
// memory while unlocked. Fully local — no server involved, works off-VPN.
//
// Layout (userData/vault/):
//   check.bin    — {salt, iv, tag, data}: seal of a known constant; wrong
//                  password fails the GCM tag, so it doubles as the verifier.
//   session.bin  — encrypted session (#15), credentials.bin — passwords (#12).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const VERIFIER = 'webforge-vault-ok-v1';
// scrypt cost: N=2^15, r=8, p=1 (~100ms; maxmem raised accordingly).
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

let key = null; // Buffer(32) while unlocked, else null

const dir = () => path.join(app.getPath('userData'), 'vault');
const file = (name) => path.join(dir(), `${name}.bin`);

function derive(password, salt) {
  return crypto.scryptSync(password, salt, 32, SCRYPT_OPTS);
}

function seal(k, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(k, blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

function isInitialized() {
  return fs.existsSync(file('check'));
}

function isUnlocked() {
  return key !== null;
}

function setup(password) {
  if (isInitialized() || !password) return false;
  fs.mkdirSync(dir(), { recursive: true });
  const salt = crypto.randomBytes(16);
  const k = derive(password, salt);
  const blob = seal(k, VERIFIER);
  blob.salt = salt.toString('base64');
  fs.writeFileSync(file('check'), JSON.stringify(blob));
  key = k;
  return true;
}

function unlock(password) {
  try {
    const blob = JSON.parse(fs.readFileSync(file('check'), 'utf8'));
    const k = derive(password, Buffer.from(blob.salt, 'base64'));
    if (open(k, blob) !== VERIFIER) return false; // unreachable: bad key throws on tag
    key = k;
    return true;
  } catch {
    return false; // wrong password (GCM tag mismatch) or unreadable vault
  }
}

function lock() {
  if (key) key.fill(0);
  key = null;
}

// Forgotten password: no recovery — wipe the vault (session + credentials)
// and start over with a fresh master password.
function reset() {
  lock();
  try {
    fs.rmSync(dir(), { recursive: true, force: true });
  } catch {}
}

function readFile(name) {
  if (!key) return null;
  try {
    return open(key, JSON.parse(fs.readFileSync(file(name), 'utf8')));
  } catch {
    return null;
  }
}

function writeFile(name, obj) {
  if (!key) return false;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify(seal(key, obj)));
    return true;
  } catch {
    return false;
  }
}

module.exports = { isInitialized, isUnlocked, setup, unlock, lock, reset, readFile, writeFile };
