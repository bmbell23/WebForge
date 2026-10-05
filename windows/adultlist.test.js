// #203 tests:  node windows/adultlist.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalize, clean, effective, builtins } = require('./adultlist');

let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

console.log('entries: shared/adult-entry-fixtures.tsv');
let rows = 0;
for (const line of fs.readFileSync(path.join(__dirname, '..', 'shared', 'adult-entry-fixtures.tsv'), 'utf8').split('\n')) {
  if (line.startsWith('#') || !line.includes('\t')) continue;
  const tab = line.lastIndexOf('\t');
  const want = line.slice(tab + 1);
  eq(normalize(line.slice(0, tab)), want === '-' ? null : want, JSON.stringify(line));
  rows++;
}
assert.ok(rows >= 20, `only ${rows} fixture rows read`);

console.log('your list');
eq(clean({ added: ['Foo.com', 'https://foo.com/x', 'junk', 'bar.com'], removed: ['bar.com'] }),
  { added: ['foo.com'], removed: ['bar.com'] }, 'normalized, deduped, removal wins');
eq(clean(null), { added: [], removed: [] }, 'nothing stored');
eq(clean({ added: 'foo.com' }), { added: [], removed: [] }, 'not a list');

console.log('merged with the built-in list');
const base = { endpoint: 'e', adult: ['a.com', 'b.com'], adultWords: ['porn'], adultOrigins: ['*:8005'], short: ['s.com'] };
const eff = effective(base, { added: ['c.com', '10.0.0.1:81'], removed: ['b.com', '*:8005'] });
eq(eff.adult, ['a.com', 'c.com'], 'sites: off and on');
eq(eff.adultOrigins, ['10.0.0.1:81'], 'origins: off and on');
eq([eff.adultWords, eff.short, eff.endpoint], [['porn'], ['s.com'], 'e'], 'the rest untouched');
eq(effective(base, {}).adult, ['a.com', 'b.com'], 'empty list changes nothing');
eq(base.adult, ['a.com', 'b.com'], 'built-in list not mutated');
eq(builtins(base), ['a.com', 'b.com', '*:8005'], 'switchable built-ins');

console.log('the matcher uses it');
const ytdlp = require('./ytdlp');
eq(ytdlp.isAdult('https://wholesome-example.org/'), false, 'not adult before');
ytdlp.setUser({ added: ['wholesome-example.org'] });
eq(ytdlp.isAdult('https://cdn.wholesome-example.org/x'), true, 'adult once added, subdomains too');
ytdlp.setUser({ removed: ['pornhub.com'] });
eq(ytdlp.isAdult('https://www.pornhub.com/'), true, 'a word match still holds after the site is switched off');
ytdlp.setUser({ removed: ['*:8005'] });
eq(ytdlp.isAdult('http://100.69.184.113:8005/'), false, 'a switched-off origin stops matching');
ytdlp.setUser(null);
eq(ytdlp.isAdult('http://100.69.184.113:8005/'), true, 'back to built-in');

console.log(`adultlist: ${n} checks passed (${rows} fixtures)`);
