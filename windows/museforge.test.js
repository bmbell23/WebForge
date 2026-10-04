// #179 tests:  node windows/museforge.test.js
const assert = require('assert');
const { canSend, outfitUrl, OUTFIT_PAGE } = require('./museforge');

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

console.log(`ok, ${n} checks`);
