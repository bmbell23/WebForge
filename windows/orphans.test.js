// #333 unit tests. Plain node, no framework:  node windows/orphans.test.js
const assert = require('assert');
const { pickOrphans, parseProcs } = require('./orphans');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const SELF = 500;

test('our own children (GPU, network, renderers) are never picked', () => {
  const procs = [
    { pid: SELF, ppid: 1 },
    { pid: 501, ppid: SELF },
    { pid: 502, ppid: SELF },
  ];
  assert.deepStrictEqual(pickOrphans(procs, SELF), []);
});

test("a previous run's leftover network service is picked", () => {
  const procs = [
    { pid: SELF, ppid: 1 },
    { pid: 501, ppid: SELF },
    { pid: 2356, ppid: 9999 }, // old main already gone; parent unknown
  ];
  assert.deepStrictEqual(pickOrphans(procs, SELF), [2356]);
});

test('an old main and all its children are picked', () => {
  const procs = [
    { pid: SELF, ppid: 1 },
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100 },
    { pid: 102, ppid: 100 },
  ];
  assert.deepStrictEqual(pickOrphans(procs, SELF).sort(), [100, 101, 102]);
});

test('grandchildren of ours (e.g. a crashpad handler under a child) are kept', () => {
  const procs = [{ pid: SELF, ppid: 1 }, { pid: 501, ppid: SELF }, { pid: 601, ppid: 501 }];
  assert.deepStrictEqual(pickOrphans(procs, SELF), []);
});

test('a parent loop never hangs', () => {
  const procs = [{ pid: 7, ppid: 8 }, { pid: 8, ppid: 7 }];
  assert.deepStrictEqual(pickOrphans(procs, SELF).sort(), [7, 8]);
});

test('PowerShell JSON: one object or an array, junk ignored', () => {
  assert.deepStrictEqual(parseProcs('{"ProcessId":5,"ParentProcessId":1,"Name":"WebForge.exe"}'), [{ pid: 5, ppid: 1, name: 'WebForge.exe' }]);
  assert.strictEqual(parseProcs('[{"ProcessId":5,"ParentProcessId":1},{"ProcessId":6,"ParentProcessId":5}]').length, 2);
  assert.deepStrictEqual(parseProcs(''), []);
  assert.deepStrictEqual(parseProcs('not json'), []);
});

console.log(`orphans: ${run} tests passed`);
