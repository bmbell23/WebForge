// #151 tests:  node windows/syncdecide.test.js
//
// The first test is the incident. On 2026-09-23 a new Windows install destroyed
// every Persona rule on every device by pushing its factory defaults over the
// sync store. If that case ever returns 'push' again, this suite goes red.
const assert = require('assert');
const { decide, personaWeight, bookmarkWeight } = require('./syncdecide');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

console.log('the incident');

test('a fresh install must NOT push its empty defaults over real data', () => {
  // Exactly the 2026-09-23 sequence: first run, no personas.json, defaults()
  // stamped with Date.now(), server holding 23 real rules.
  const d = decide({ localAt: Date.now(), remoteAt: Date.now() - 86400000, localWeight: 0, remoteWeight: 23 });
  assert.strictEqual(d.action, 'none', 'this is the bug that wiped both machines');
  assert.ok(/refusing to push/.test(d.reason));
});

test('...and the same install SHOULD pull the real data down', () => {
  // Once defaults stop claiming to be newer (updatedAt: 0), the pull branch runs.
  const d = decide({ localAt: 0, remoteAt: Date.now(), localWeight: 0, remoteWeight: 23 });
  assert.strictEqual(d.action, 'pull');
});

console.log('the mirror mistake — wiping the device instead of the server');

test('an empty remote must NOT be pulled over local data', () => {
  const d = decide({ localAt: 1000, remoteAt: 9999, localWeight: 23, remoteWeight: 0 });
  assert.strictEqual(d.action, 'none');
  assert.ok(/refusing to pull/.test(d.reason));
});

console.log('normal operation still works — the guard must not freeze sync');

test('a real local edit pushes', () => {
  assert.strictEqual(decide({ localAt: 2000, remoteAt: 1000, localWeight: 5, remoteWeight: 3 }).action, 'push');
});

test('a real remote edit pulls', () => {
  assert.strictEqual(decide({ localAt: 1000, remoteAt: 2000, localWeight: 3, remoteWeight: 5 }).action, 'pull');
});

test('deleting rules down to a smaller set still pushes', () => {
  // Weight dropping is legitimate as long as it is not to zero; refusing here
  // would make deletions impossible to sync.
  assert.strictEqual(decide({ localAt: 2000, remoteAt: 1000, localWeight: 1, remoteWeight: 20 }).action, 'push');
});

test('equal timestamps do nothing', () => {
  assert.strictEqual(decide({ localAt: 1000, remoteAt: 1000, localWeight: 5, remoteWeight: 5 }).action, 'none');
});

test('two empty stores do nothing rather than ping-pong', () => {
  assert.strictEqual(decide({ localAt: 2000, remoteAt: 1000, localWeight: 0, remoteWeight: 0 }).action, 'none');
  assert.strictEqual(decide({ localAt: 1000, remoteAt: 2000, localWeight: 0, remoteWeight: 0 }).action, 'none');
});

console.log('a first-ever sync, where the server has nothing yet');

test('a populated device seeds an empty server', () => {
  // remoteAt 0 is what sync.py returns when the key has never been written.
  assert.strictEqual(decide({ localAt: Date.now(), remoteAt: 0, localWeight: 12, remoteWeight: 0 }).action, 'push');
});

console.log('junk never produces a destructive action');

test('missing or garbage fields fail closed', () => {
  for (const args of [{}, { localAt: null, remoteAt: null }, { localAt: 'x', remoteAt: 'y', localWeight: 'z' }]) {
    assert.strictEqual(decide(args).action, 'none');
  }
});

console.log('weight measures what would actually be mourned');

test('personaWeight counts rules, not personas', () => {
  // Three empty personas is what a factory default looks like — weight 0, so it
  // can never overwrite anything. That is the entire point.
  const FACTORY = [
    { id: 'unassigned', name: 'Unassigned', rules: [] },
    { id: 'a', name: 'Personal', rules: [] },
    { id: 'b', name: 'Work', rules: [] },
  ];
  assert.strictEqual(personaWeight(FACTORY), 0, 'factory defaults must weigh nothing');
  assert.strictEqual(personaWeight([{ rules: ['a', 'b'] }, { rules: ['c'] }]), 3);
});

test('personaWeight survives malformed input', () => {
  for (const bad of [null, undefined, 'nope', 42, [null], [{}], [{ rules: 'no' }]]) {
    assert.strictEqual(personaWeight(bad), 0);
  }
});

test('bookmarkWeight counts entries', () => {
  assert.strictEqual(bookmarkWeight([1, 2, 3]), 3);
  for (const bad of [null, undefined, 'nope', {}]) assert.strictEqual(bookmarkWeight(bad), 0);
});

console.log(`\n${run} tests passed`);
