// #116 regression test:  node windows/hotkeys.test.js
//
// The trap this pins down has now caused two bugs. `hotkeys.get(keyId)` with no
// Persona silently reads the **Unassigned** bucket rather than "any bucket", so
// a lookup for a hotkey bound inside a real Persona returns null and the caller
// concludes the hotkey does not exist:
//   #78  — enforceHome stopped keeping quick-launch tabs on their own site
//   #116 — restored tabs stopped counting as hotkey tabs, so Ctrl+Shift+X closed
//          them and sticky mode / expiry immunity broke with them
//
// hotkeys.js needs Electron only for `app.getPath('userData')`, so the module is
// loaded against a stub pointing at a throwaway directory — the same technique
// scripts/vault-interop.js uses to drive the real vault.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'webforge-hotkeys-test-'));
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return load.apply(this, [request, parent, isMain]);
};

const hotkeys = require('./hotkeys');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

console.log('per-Persona hotkey buckets (#25)');

hotkeys.set('b', { url: 'https://work.example.com', title: 'Work' }, 'work');

test('a hotkey bound in a Persona is found WITH that Persona', () => {
  const entry = hotkeys.get('b', 'work');
  assert.ok(entry, 'should resolve inside its own Persona');
  assert.strictEqual(entry.url, 'https://work.example.com');
});

test('THE TRAP: the same lookup with no Persona returns null', () => {
  // Not "any bucket" — the Unassigned one. Every caller that omits the Persona
  // concludes the hotkey does not exist. This is the whole of #78 and #116.
  assert.strictEqual(
    hotkeys.get('b'),
    null,
    'omitting the Persona must read Unassigned — if this ever starts passing, the ' +
      'bucket semantics changed and the call sites in main.js should be revisited'
  );
});

test('and it is not found from a DIFFERENT Persona either', () => {
  assert.strictEqual(hotkeys.get('b', 'personal'), null);
});

test('an Unassigned binding is the one a persona-less lookup finds', () => {
  hotkeys.set('u', { url: 'https://loose.example.com', title: 'Loose' }, null);
  assert.ok(hotkeys.get('u'), 'binding stored with no Persona lands in Unassigned');
  assert.strictEqual(hotkeys.get('u').url, 'https://loose.example.com');
});

test('the same key can mean different things in different Personas (#25)', () => {
  hotkeys.set('b', { url: 'https://personal.example.com', title: 'Personal' }, 'personal');
  assert.strictEqual(hotkeys.get('b', 'work').url, 'https://work.example.com');
  assert.strictEqual(hotkeys.get('b', 'personal').url, 'https://personal.example.com');
});

test('#217: digits bind like any other key, now that Personas use ` ! @ # $ % ^', () => {
  assert.strictEqual(hotkeys.set('1', { url: 'https://one.example.com', title: 'One' }, 'work'), true);
  assert.strictEqual(hotkeys.set('9', { url: 'https://nine.example.com', title: 'Nine' }, 'work'), true);
  assert.strictEqual(hotkeys.get('1', 'work').url, 'https://one.example.com');
  assert.strictEqual(hotkeys.get('9', 'work').url, 'https://nine.example.com');
});

console.log('hotkey scope (#311)');

test('scope is stored trimmed; blank or missing means no scope field', () => {
  hotkeys.set('m', { url: 'http://100.69.184.113:8015/office/', title: 'Office', scope: '  http://100.69.184.113:8015/office/*  ' }, 'personal');
  assert.strictEqual(hotkeys.get('m', 'personal').scope, 'http://100.69.184.113:8015/office/*');
  hotkeys.set('n', { url: 'https://n.example.com', title: 'N', scope: '   ' }, 'personal');
  assert.ok(!('scope' in hotkeys.get('n', 'personal')));
});

test('re-binding the same bookmark to a new key carries its scope; blank clears it', () => {
  hotkeys.set('M', { url: 'http://100.69.184.113:8015/office/', title: 'Office' }, 'personal');
  assert.strictEqual(hotkeys.get('M', 'personal').scope, 'http://100.69.184.113:8015/office/*');
  assert.strictEqual(hotkeys.get('m', 'personal'), null);
  hotkeys.set('M', { url: 'http://100.69.184.113:8015/office/', title: 'Office', scope: '' }, 'personal');
  assert.ok(!('scope' in hotkeys.get('M', 'personal')));
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\n${run} tests passed`);
