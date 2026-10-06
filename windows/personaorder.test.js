// #214 tests:  node windows/personaorder.test.js
const assert = require('assert');
const po = require('./personaorder');

let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

console.log('orderPersonas');
const stored = [
  { id: 'unassigned', name: 'Unassigned' },
  { id: 'p', name: 'Personal' },
  { id: 'w', name: 'Work' },
];
eq(po.orderPersonas(stored).map((p) => p.name), ['Terminal', 'Personal', 'Work', 'Unassigned'], '1 Terminal, 2 Personal, 3 Work, 4 Unassigned');
eq(po.orderPersonas(stored).map((p) => p.id), ['terminal', 'p', 'w', 'unassigned'], 'ids are unchanged');
eq(po.orderPersonas([...stored, { id: 'terminal', name: 'Imposter' }]).map((p) => p.name), ['Terminal', 'Personal', 'Work', 'Unassigned'], 'a stored "terminal" never doubles up');
eq(po.orderPersonas([]).map((p) => p.id), ['terminal'], 'empty list still has Terminal');
eq(stored.length, 3, 'input not mutated');

console.log('personaDigit');
const k = (code, mods = {}) => ({ code, shift: true, control: false, alt: false, meta: false, ...mods });
eq(po.personaDigit(k('Digit1')), 1, 'Shift+1 (!)');
eq(po.personaDigit(k('Digit4')), 4, 'Shift+4 ($)');
eq(po.personaDigit(k('Digit9')), 9, 'Shift+9 by default');
eq(po.personaDigit(k('Digit5')), 5, 'Shift+5 in the browser');
eq(po.personaDigit(k('Digit5'), 4), 0, 'max 4 in a terminal');
eq(po.personaDigit(k('Digit1', { shift: false })), 0, 'bare digit is not a Persona key');
eq(po.personaDigit(k('Digit1', { control: true })), 0, 'Ctrl+Shift+1 is not');
eq(po.personaDigit(k('Digit1', { alt: true })), 0, 'AltGr/Alt+Shift+1 is not');
eq(po.personaDigit(k('Numpad1')), 0, 'numpad is not');
eq(po.personaDigit(k('Digit0')), 0, '0 is not');
eq(po.personaDigit({ key: '!', shift: true }), 0, 'matched on code, not key');

console.log(`personaorder: ${n} passed`);
