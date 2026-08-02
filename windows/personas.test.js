// #120 regression test:  node windows/personas.test.js
//
// The trap: `forUrl('')` returns UNASSIGNED, and a lazily-restored tab (#78) has
// an EMPTY webContents URL until it is first shown. Any caller that reaches for
// `webContents.getURL()` instead of `tabUrlOf()` therefore sees "" for every
// unopened tab and silently concludes it belongs nowhere.
//
// That has now cost three bugs:
//   #95  — findTabByUrl missed restored tabs, so sync adopted duplicates
//   #116 — restored quick-launch tabs lost their hotkey status
//   #120 — persona sync dumped every unopened tab into Unassigned
//
// personas.js needs Electron only for `app.getPath`, so it is loaded against a
// stub (same technique as hotkeys.test.js and scripts/vault-interop.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'webforge-personas-test-'));
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return load.apply(this, [request, parent, isMain]);
};

const personas = require('./personas');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

// The user's real rules, taken from the live sync store on 2026-08-01.
const WORK = 'caf73ffb';
const PERSONAL = '4e439a00';
personas.all(); // replaceAll writes into the cache, so force the lazy load first
personas.replaceAll(
  [
    { id: 'unassigned', name: 'Unassigned', builtin: true, rules: [] },
    { id: PERSONAL, name: 'Personal', rules: ['https://github.com', 'https://www.chess.com'] },
    {
      id: WORK,
      name: 'Work',
      rules: [
        'https://ime-ddn.atlassian.net/*',
        'https://*.colorado.datadirectnet.com/',
        'https://co-ci.colorado.datadirectnet.com/*',
      ],
    },
  ],
  Date.now()
);

console.log('THE TRAP: an empty URL belongs nowhere');

test('forUrl("") is UNASSIGNED — so getURL() on a lazy tab demotes it', () => {
  assert.strictEqual(personas.forUrl(''), personas.UNASSIGNED);
  assert.strictEqual(personas.forUrl(null), personas.UNASSIGNED);
  assert.strictEqual(personas.forUrl(undefined), personas.UNASSIGNED);
});

console.log('the rules themselves work — this was never the matcher');

test('Jira and the datadirect hosts resolve to Work', () => {
  assert.strictEqual(personas.forUrl('https://ime-ddn.atlassian.net/browse/SFAP-107268'), WORK);
  assert.strictEqual(personas.forUrl('https://ime-ddn.atlassian.net/wiki/spaces/SFA/overview'), WORK);
  assert.strictEqual(personas.forUrl('https://gitops.devops.colorado.datadirectnet.com/login'), WORK);
  assert.strictEqual(personas.forUrl('https://nexus.devops.colorado.datadirectnet.com/'), WORK);
});

test('github and chess resolve to Personal', () => {
  assert.strictEqual(personas.forUrl('https://github.com/users/bmbell23/projects/9'), PERSONAL);
  assert.strictEqual(personas.forUrl('https://www.chess.com/home?x=1'), PERSONAL);
});

console.log('known rule gaps, recorded so they are not mistaken for bugs');

test('a non-default PORT defeats a rule that expects / after the host', () => {
  // Both Work rules require '/' immediately after .com, so ':8080/' misses.
  assert.strictEqual(personas.forUrl('https://co-ci.colorado.datadirectnet.com:8080/'), personas.UNASSIGNED);
});

test("Atlassian's SSO host is covered by no rule", () => {
  assert.strictEqual(personas.forUrl('https://id.atlassian.com/login?continue=x'), personas.UNASSIGNED);
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\n${run} tests passed`);
