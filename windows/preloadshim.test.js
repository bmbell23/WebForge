// #21 tests:  node windows/preloadshim.test.js
const assert = require('assert');
const { ensurePreloadRegistration } = require('./preloadshim');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

// An Electron 34 session: only the old preload API.
const oldSession = (initial = []) => {
  let preloads = [...initial];
  return {
    getPreloads: () => [...preloads],
    setPreloads: (p) => {
      preloads = [...p];
    },
  };
};

console.log('Electron 34 sessions get the newer preload API');

test('a session without registerPreloadScript is shimmed', () => {
  const ses = oldSession();
  assert.strictEqual(ensurePreloadRegistration(ses), true);
  assert.strictEqual(typeof ses.registerPreloadScript, 'function');
  assert.strictEqual(typeof ses.unregisterPreloadScript, 'function');
});

test('registering appends the preload and keeps existing ones', () => {
  const ses = oldSession(['/app/existing.js']);
  ensurePreloadRegistration(ses);
  ses.registerPreloadScript({ type: 'frame', filePath: '/app/adblock.js' });
  assert.deepStrictEqual(ses.getPreloads(), ['/app/existing.js', '/app/adblock.js']);
});

test('unregistering removes only that preload', () => {
  const ses = oldSession(['/app/existing.js']);
  ensurePreloadRegistration(ses);
  const id = ses.registerPreloadScript({ type: 'frame', filePath: '/app/adblock.js' });
  ses.unregisterPreloadScript(id);
  assert.deepStrictEqual(ses.getPreloads(), ['/app/existing.js']);
});

test('the same file registered twice is listed once and survives one unregister', () => {
  const ses = oldSession();
  ensurePreloadRegistration(ses);
  const a = ses.registerPreloadScript({ type: 'frame', filePath: '/app/adblock.js' });
  ses.registerPreloadScript({ type: 'frame', filePath: '/app/adblock.js' });
  assert.deepStrictEqual(ses.getPreloads(), ['/app/adblock.js']);
  ses.unregisterPreloadScript(a);
  assert.deepStrictEqual(ses.getPreloads(), ['/app/adblock.js']);
});

test('an unknown id is ignored', () => {
  const ses = oldSession(['/app/existing.js']);
  ensurePreloadRegistration(ses);
  ses.unregisterPreloadScript('nope');
  assert.deepStrictEqual(ses.getPreloads(), ['/app/existing.js']);
});

console.log('newer Electron is left alone');

test('a session that already has registerPreloadScript is not touched', () => {
  const native = () => 'native';
  const ses = { registerPreloadScript: native };
  assert.strictEqual(ensurePreloadRegistration(ses), false);
  assert.strictEqual(ses.registerPreloadScript, native);
});

console.log(`\n${run} passed`);
