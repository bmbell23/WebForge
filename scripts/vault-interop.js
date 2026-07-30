#!/usr/bin/env node
// #55: cross-platform vault proof. Drives the REAL windows/vault.js (Electron's
// `app` is the only thing it needs, so it gets stubbed) so the Android vault is
// tested against the actual desktop implementation rather than a re-description
// of it.
//
// Two directions, both required — a one-way test passes happily while the tag
// and ciphertext are being concatenated in the wrong order.
//
//   node scripts/vault-interop.js seal <outfile>
//       Real vault.js seals its verifier. Writes {salt,iv,tag,data} for the
//       Kotlin test to open.  => proves Windows -> Android
//
//   node scripts/vault-interop.js open <infile>
//       Installs a Kotlin-produced blob as check.bin and calls vault.unlock().
//       Exits non-zero unless the real vault.js accepts it.
//                                    => proves Android -> Windows
//
// Password is fixed below: this only ever touches a throwaway temp vault.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const PASSWORD = 'test-master-password';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'webforge-vault-interop-'));

// Stub `electron` before vault.js is loaded — it only calls app.getPath('userData').
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return load.apply(this, [request, parent, isMain]);
};

const vault = require(path.join(__dirname, '..', 'windows', 'vault.js'));
const checkFile = path.join(userData, 'vault', 'check.bin');
const [mode, target] = process.argv.slice(2);

if (mode === 'seal') {
  if (!vault.setup(PASSWORD)) fail('vault.setup() refused');
  const blob = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
  for (const k of ['salt', 'iv', 'tag', 'data']) {
    if (!blob[k]) fail(`vault.js produced no ${k}`);
  }
  fs.writeFileSync(target, JSON.stringify(blob, null, 2));
  // Sanity: the file we just wrote really is what vault.js reads back.
  vault.lock();
  if (!vault.unlock(PASSWORD)) fail('vault.js cannot reopen its own blob');
  console.log(`sealed by windows/vault.js -> ${target}`);
} else if (mode === 'open') {
  const blob = JSON.parse(fs.readFileSync(target, 'utf8'));
  fs.mkdirSync(path.dirname(checkFile), { recursive: true });
  fs.writeFileSync(checkFile, JSON.stringify(blob));
  if (!vault.unlock(PASSWORD)) fail('windows/vault.js REJECTED the Kotlin-sealed blob');
  console.log('windows/vault.js opened the Kotlin-sealed blob: OK');
} else {
  fail('usage: vault-interop.js <seal|open> <file>');
}

fs.rmSync(userData, { recursive: true, force: true });

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(1);
}
