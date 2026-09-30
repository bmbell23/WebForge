// #156: node windows/ytdlp.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const y = require('./ytdlp');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

console.log('the cross-platform fixture set (shared/ytdlp-fixtures.tsv)');
const file = path.join(__dirname, '..', 'shared', 'ytdlp-fixtures.tsv');
let rows = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [url, format, kids, adult, short, kidsOut] = line.split('\t');
  const b = y.body(url, { format, kids: kids === '1' });
  assert.deepStrictEqual(
    [b.format, b.adult, b.short, b.kids],
    [format, adult === '1', short === '1', kidsOut === '1'],
    `fixture: ${url} ${format} kids=${kids}`,
  );
  rows++;
}
ok(rows >= 15, `only ${rows} fixtures read`);

console.log('picker overrides');
ok(y.body('https://www.youtube.com/watch?v=a', { adult: true }).adult, 'Adult can be forced on');
ok(!y.body('https://www.youporn.com/x', { adult: false }).adult, 'and off');
ok(!y.body('https://www.youporn.com/x', { adult: true, kids: true }).adult, 'Kids beats Adult');
ok(y.body('https://www.youtube.com/watch?v=a', { format: 'nonsense' }).format === 'video', 'unknown format is video');

console.log('what can be sent');
ok(y.downloadable('https://www.youtube.com/watch?v=a'), 'a web page');
ok(!y.downloadable('file:///C:/x/newtab.html'), 'not the new-tab page');
ok(!y.downloadable('about:blank'), 'not about:blank');
ok(!y.downloadable(''), 'not nothing');

console.log('the endpoint is the Dashboard');
ok(y.ENDPOINT === 'http://100.69.184.113:8001/api/download/ytdlp', `endpoint ${y.ENDPOINT}`);

console.log(`ok, ${n} checks + ${rows} fixtures`);
