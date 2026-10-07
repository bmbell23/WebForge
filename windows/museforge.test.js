// #179 tests:  node windows/museforge.test.js
const assert = require('assert');
const { pageFor, girlUrl, POSE_PAGE, GIRL_PAGE, canSend, outfitUrl, isDone, createForm, createResult, PRICE_LABEL, OUTFIT_PAGE } = require('./museforge');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

console.log('which images can be sent');
ok(canSend('https://example.com/a.jpg'), 'https');
ok(canSend('http://example.com/a.jpg'), 'http');
ok(!canSend('data:image/png;base64,AAAA'), 'not data:');
ok(!canSend('blob:https://example.com/123'), 'not blob:');
ok(!canSend('file:///C:/a.jpg'), 'not file:');
ok(!canSend(''), 'not nothing');

console.log('the Studio address');
ok(OUTFIT_PAGE === 'http://100.69.184.113:8005/library/outfit/from-image', 'the page Molly named');
const u = new URL(outfitUrl('https://ex.com/p.jpg?w=800&h=1200', 'moto jacket', 'black leather moto jacket, ripped jeans & boots'));
ok(u.origin + u.pathname === OUTFIT_PAGE, 'goes to the from-image page');
ok(u.searchParams.get('src') === 'https://ex.com/p.jpg?w=800&h=1200', 'src survives its own query string');
ok(u.searchParams.get('name') === 'moto jacket', 'name');
ok(u.searchParams.get('text') === 'black leather moto jacket, ripped jeans & boots', '& in the description is encoded');
const bare = new URL(outfitUrl('https://ex.com/p.jpg', '  ', ''));
ok(!bare.searchParams.has('name') && !bare.searchParams.has('text'), 'empty name/description are left off');
ok(outfitUrl('data:image/png;base64,AAAA', 'x', 'y') === null, 'an unsendable image gives no address');

console.log('#181: shared fixtures (Android reads the same file)');
const fs = require('fs');
const path = require('path');
let rows = 0;
for (const line of fs.readFileSync(path.join(__dirname, '..', 'shared', 'outfit-fixtures.tsv'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [src, name, text, want] = line.split('\t');
  ok(outfitUrl(src, name, text) === (want || null), `fixture: ${line}`);
  rows++;
}
ok(rows >= 7, `only ${rows} fixtures read`);

console.log('#191: the Studio\'s "queued" page (shared fixtures)');
let done = 0;
for (const line of fs.readFileSync(path.join(__dirname, '..', 'shared', 'outfit-done-fixtures.tsv'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [url, want] = line.split('\t');
  ok(isDone(url) === (want === '1'), `isDone(${url}) should be ${want === '1'}`);
  done++;
}
ok(done >= 8, `only ${done} done fixtures read`);
ok(!isDone('') && !isDone('not a url'), 'nothing is not done');

console.log('#195: Create in the background');
const form = new URLSearchParams(createForm('https://ex.com/p.jpg?w=1&h=2', ' moto jacket ', 'leather & denim'));
ok(form.get('src') === 'https://ex.com/p.jpg?w=1&h=2', 'src survives its own query');
ok(form.get('name') === 'moto jacket' && form.get('text') === 'leather & denim', 'trimmed, & encoded');
ok(new URLSearchParams(createForm('https://ex.com/p.jpg', '', '')).get('name') === '', 'an empty name lets the Studio pick one');
ok(createForm('data:image/png;base64,AA', 'x', 'y') === null, 'unsendable picture → no form');
ok(PRICE_LABEL === '~$0.03', 'price on the button');
let created = 0;
for (const line of fs.readFileSync(path.join(__dirname, '..', 'shared', 'outfit-create-fixtures.tsv'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [status, loc, want] = line.split('\t');
  ok(createResult(Number(status), loc) === want, `createResult(${status}, ${loc}) should be ${want}`);
  created++;
}
ok(created >= 10, `only ${created} create fixtures read`);

console.log('#260: pose and girl');
ok(POSE_PAGE === 'http://100.69.184.113:8005/library/pose/from-image', 'pose page');
ok(GIRL_PAGE === 'http://100.69.184.113:8005/girls/describe', 'girl page');
ok(pageFor('pose') === POSE_PAGE && pageFor('outfit') === OUTFIT_PAGE, 'pageFor the two kinds');
ok(pageFor() === OUTFIT_PAGE && pageFor('girl') === OUTFIT_PAGE, 'anything else is an outfit');
const pu = new URL(outfitUrl('https://ex.com/p.jpg?w=1&h=2', 'hair flip', 'looking back & smiling', 'pose'));
ok(pu.origin + pu.pathname === POSE_PAGE, 'pose goes to the pose page');
ok(pu.searchParams.get('src') === 'https://ex.com/p.jpg?w=1&h=2' && pu.searchParams.get('name') === 'hair flip' && pu.searchParams.get('text') === 'looking back & smiling', 'pose params');
ok(outfitUrl('https://ex.com/p.jpg', 'a', 'b', 'outfit') === outfitUrl('https://ex.com/p.jpg', 'a', 'b'), 'outfit is the default');
ok(outfitUrl('data:image/png;base64,AA', 'x', 'y', 'pose') === null, 'unsendable pose picture');
const gu = new URL(girlUrl('https://ex.com/g.jpg?w=1&h=2'));
ok(gu.origin + gu.pathname === GIRL_PAGE && gu.searchParams.get('src') === 'https://ex.com/g.jpg?w=1&h=2' && [...gu.searchParams].length === 1, 'girl address carries only src');
ok(girlUrl('blob:https://ex.com/1') === null && girlUrl('') === null, 'unsendable girl picture');
const A = 'http://100.69.184.113:8005/approvals';
ok(isDone(A + '#fig-pose-hair-flip', 'pose') && isDone(A, 'pose') && isDone(A + '/', 'pose'), 'pose done');
ok(!isDone(A + '#fig-outfit-x', 'pose'), 'an outfit result is not a pose result');
ok(!isDone(A + '#fig-pose-x') && !isDone(A + '#fig-pose-x', 'outfit'), 'a pose result is not an outfit result');
ok(isDone(A + '#fig-outfit-x') && isDone(A + '#fig-outfit-x', 'outfit'), 'outfit done still');
ok(!isDone('http://100.69.184.113:8005/library/pose/from-image?src=x', 'pose'), 'the form page is not done');
ok(!isDone('https://evil.example/approvals#fig-pose-x', 'pose'), 'wrong origin');

console.log(`ok, ${n} checks`);
