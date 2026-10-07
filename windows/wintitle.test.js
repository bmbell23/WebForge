// #317 unit tests. Plain node, no framework:  node windows/wintitle.test.js
const assert = require('assert');
const { windowTitle, makeTitleSetter } = require('./wintitle');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

test('fullscreen holds the title at WebForge whatever the page is', () => {
  assert.strictEqual(windowTitle({ fullscreen: true, locked: false, pageTitle: '(76) Penny · desk' }), 'WebForge');
  assert.strictEqual(windowTitle({ fullscreen: true, locked: false, pageTitle: 'SFAP-108852' }), 'WebForge');
  assert.strictEqual(windowTitle({ fullscreen: true, locked: true, pageTitle: null }), 'WebForge');
});

test('windowed follows the active tab', () => {
  assert.strictEqual(windowTitle({ fullscreen: false, locked: false, pageTitle: 'Jira' }), 'Jira — WebForge');
  assert.strictEqual(windowTitle({ fullscreen: false, locked: false, pageTitle: '' }), 'WebForge');
  assert.strictEqual(windowTitle({ fullscreen: false, locked: false, pageTitle: undefined }), 'WebForge');
});

test('windowed and locked says so', () => {
  assert.strictEqual(windowTitle({ fullscreen: false, locked: true, pageTitle: 'Jira' }), 'WebForge — locked');
});

test('setter only calls through on a real change', () => {
  const calls = [];
  const set = makeTitleSetter((t) => calls.push(t));
  assert.strictEqual(set('WebForge'), true);
  assert.strictEqual(set('WebForge'), false);
  assert.strictEqual(set('WebForge'), false);
  assert.strictEqual(set('Jira — WebForge'), true);
  assert.strictEqual(set('WebForge'), true);
  assert.deepStrictEqual(calls, ['WebForge', 'Jira — WebForge', 'WebForge']);
});

test('a hundred fullscreen pushes across tab switches set the title once', () => {
  const calls = [];
  const set = makeTitleSetter((t) => calls.push(t));
  const pages = ['(76) Penny · desk', '(73) Drafts', 'SFAP-108852', '10.36.28.42'];
  for (let i = 0; i < 100; i++) set(windowTitle({ fullscreen: true, locked: false, pageTitle: pages[i % 4] }));
  assert.deepStrictEqual(calls, ['WebForge']);
});

console.log(`wintitle: ${run} tests passed`);
