// #100 tests:  node windows/textrules.test.js
const assert = require('assert');
const { DEFAULT_RULES, normalizeSelection, resolve } = require('./textrules');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const JIRA = 'https://ime-ddn.atlassian.net/browse/';

console.log('the reported case');

test('SFAP-107190 resolves to its Jira ticket', () => {
  assert.strictEqual(resolve('SFAP-107190', DEFAULT_RULES).url, `${JIRA}SFAP-107190`);
});

console.log('selection tidying');

test('surrounding whitespace and punctuation are ignored', () => {
  for (const raw of ['  SFAP-107190  ', 'SFAP-107190.', '(SFAP-107190)', '"SFAP-107190",', '[SFAP-107190]']) {
    assert.strictEqual(resolve(raw, DEFAULT_RULES).url, `${JIRA}SFAP-107190`, `failed on ${raw}`);
  }
});

test('a key inside a sentence is still found', () => {
  const r = resolve('please look at SFAP-107190 when you can', DEFAULT_RULES);
  assert.strictEqual(r.matched, 'SFAP-107190');
});

test('normalizeSelection caps absurd input', () => {
  assert.ok(normalizeSelection('x'.repeat(5000)).length <= 512);
});

console.log('staying inert');

test('ordinary text matches nothing', () => {
  for (const raw of ['hello world', '', '   ', 'just-words', '12345']) {
    assert.strictEqual(resolve(raw, DEFAULT_RULES), null, `should not match: "${raw}"`);
  }
});

test('non-strings do not throw', () => {
  assert.strictEqual(resolve(null, DEFAULT_RULES), null);
  assert.strictEqual(resolve(undefined, DEFAULT_RULES), null);
  assert.strictEqual(resolve(42, DEFAULT_RULES), null);
});

console.log('general rules, not a Jira special case');

const RULES = [
  { name: 'GitHub', pattern: '#(\\d+)', template: 'https://github.com/bmbell23/WebForge/issues/$1' },
  { name: 'Jira', pattern: '[A-Z][A-Z0-9]+-\\d+', template: `${JIRA}$0` },
];

test('capture groups land in the template', () => {
  assert.strictEqual(resolve('#116', RULES).url, 'https://github.com/bmbell23/WebForge/issues/116');
});

test('first matching rule wins, in list order', () => {
  const both = [
    { pattern: '.+', template: 'https://first/$0' },
    { pattern: '[A-Z]+-\\d+', template: `${JIRA}$0` },
  ];
  assert.strictEqual(resolve('SFAP-1', both).url, 'https://first/SFAP-1');
});

test('matching is case-insensitive', () => {
  assert.strictEqual(resolve('sfap-107190', DEFAULT_RULES).url, `${JIRA}sfap-107190`);
});

console.log('robustness');

test('an invalid regex is skipped, not fatal', () => {
  const rules = [
    { pattern: '[unclosed', template: 'https://broken/$0' },
    { pattern: '[A-Z]+-\\d+', template: `${JIRA}$0` },
  ];
  assert.strictEqual(resolve('SFAP-2', rules).url, `${JIRA}SFAP-2`, 'a typo in one rule must not break the rest');
});

test('rules missing a pattern or template are skipped', () => {
  const rules = [{ pattern: '[A-Z]+-\\d+' }, { template: 'x' }, ...DEFAULT_RULES];
  assert.strictEqual(resolve('SFAP-3', rules).url, `${JIRA}SFAP-3`);
});

test('substituted values are URL-encoded', () => {
  const rules = [{ pattern: 'q=(.+)', template: 'https://example.com/search?q=$1' }];
  assert.strictEqual(resolve('q=hello world&x', rules).url, 'https://example.com/search?q=hello%20world%26x');
});

test('an unmatched $ placeholder is left alone rather than printing undefined', () => {
  const rules = [{ pattern: '(a)', template: 'https://example.com/$1/$5' }];
  assert.strictEqual(resolve('a', rules).url, 'https://example.com/a/$5');
});

test('an empty rule list falls back to the defaults', () => {
  assert.strictEqual(resolve('SFAP-4', []).url, `${JIRA}SFAP-4`);
  assert.strictEqual(resolve('SFAP-4', null).url, `${JIRA}SFAP-4`);
});

console.log(`\n${run} tests passed`);
