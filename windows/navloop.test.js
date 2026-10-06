// #238 tests:  node windows/navloop.test.js
const assert = require('assert');
const { createNavLoop } = require('./navloop');

let run = 0;
const test = (name, fn) => { fn(); run++; console.log('  ok', name); };

test('a page that navigates now and then is never reported', () => {
  const note = createNavLoop();
  for (let i = 0; i < 20; i++) assert.strictEqual(note('https://a/' + i, 'load', i * 10000), null);
});
test('five navigations inside 30s are reported, with the URLs and kinds', () => {
  const note = createNavLoop();
  let out = null;
  for (let i = 0; i < 5; i++) out = note('https://outlook/mail/id/' + i, i % 2 ? 'in-page' : 'load', 1000 + i * 2000);
  assert.ok(out && out.startsWith('5 main-frame navigations in 30s'));
  assert.ok(out.includes('+8s load https://outlook/mail/id/4'));
  assert.ok(out.includes('in-page https://outlook/mail/id/1'));
});
test('a loop is reported at most once a minute', () => {
  const note = createNavLoop();
  const hits = [];
  for (let i = 0; i < 60; i++) hits.push(note('u', 'load', i * 2000));
  assert.strictEqual(hits.filter(Boolean).length, 2, 'two minutes of looping, two reports');
});

console.log(`\n${run} tests passed`);
