// #177 tests:  node windows/stash.test.js
const assert = require('assert');
const stash = require('./stash');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

// The page reader is one shared file, run in the page by both apps. Load its
// decision half here without a DOM.
let reader;
global.__stashExport = (x) => { reader = x; };
eval(stash.readerSource()); // eslint-disable-line no-eval
delete global.__stashExport;
const { distill } = reader;

console.log('the endpoint');
ok(stash.ENDPOINT === 'http://100.69.184.113:8001/api/download/stash', 'Dashboard, beside the yt-dlp route');

console.log('page reader: a gallery page');
const page = 'https://www.hqgals.com/gallery/jane-doe-red-dress-12345/';
const g = distill({
  url: page,
  title: 'Jane Doe in Red Dress - HQGals',
  h1: 'Jane Doe in Red Dress',
  meta: { 'og:site_name': 'HQGals', keywords: 'redhead, dress , redhead', 'article:published_time': '2026-09-30T10:00:00Z' },
  ld: [],
  links: [
    { href: 'https://www.hqgals.com/models/jane-doe/', text: ' Jane  Doe ' },
    { href: 'https://www.hqgals.com/channels/met-art/', text: 'MetArt' },
    { href: 'https://cdn.hqgals.com/12345/01.jpg', text: '' },
    { href: 'https://cdn.hqgals.com/12345/02.JPG', text: '' },
    { href: 'https://cdn.hqgals.com/12345/02.JPG', text: '' },
    { href: 'https://cdn.hqgals.com/12345/03.webp?w=1', text: '' },
    { href: 'https://www.hqgals.com/gallery/other/', text: 'Next' },
    { href: 'javascript:void(0)', text: 'x' },
  ],
});
eq(g.title, 'Jane Doe in Red Dress', 'the "- HQGals" tail is dropped');
eq(g.performers, ['Jane Doe'], 'model link, whitespace cleaned');
eq(g.studio, 'MetArt', 'the one channel link is the studio');
eq(g.site, 'hqgals.com', 'site without www');
eq(g.date, '2026-09-30', 'published time → day');
eq(g.tags, ['redhead', 'dress'], 'keywords split, trimmed, deduped');
eq(g.image_urls.length, 3, 'full-size image links, deduped, query allowed');
ok(stash.isGallery(g), 'three images count as a gallery');

console.log('page reader: lazy imx.to thumbnails (#345)');
const nsfw = distill({
  url: 'https://nsfwalbum.com/album/946155',
  title: 'An album',
  links: [{ href: 'https://nsfwalbum.com/photo/91244573', text: '' }],
  imgs: [
    'https://nsfwalbum.com/pic/p.png',
    'https://image.imx.to/u/t/2026/10/09/76upom.jpg',
    'https://image.imx.to/u/t/2026/10/09/76upoo.jpg',
    'https://image.imx.to/u/t/2026/10/09/76upoo.jpg',
    'https://image.imx.to/u/t/2026/10/09/76upor.jpg',
    'https://image.imx.to/u/i/2026/10/09/already.jpg',
    'https://other.example/u/t/x.jpg',
  ],
});
eq(nsfw.image_urls, [
  'https://image.imx.to/u/i/2026/10/09/76upom.jpg',
  'https://image.imx.to/u/i/2026/10/09/76upoo.jpg',
  'https://image.imx.to/u/i/2026/10/09/76upor.jpg',
], 'thumbnails → originals, deduped; placeholders, non-thumbnails and other hosts ignored');
ok(stash.isGallery(nsfw), 'the album counts as a gallery');
eq(distill({ url: 'https://x.com/', links: [], imgs: ['https://x.com/a.jpg', 'https://x.com/b.jpg', 'https://x.com/c.jpg'] }).image_urls, [], 'plain <img> tags never make a gallery');

console.log('page reader: sxypix viewer answer (#347)');
const sxyEl = (sig, pid) => `<div class='gall_pix_el' data-photoid='${pid}' style='width:800px' data-src='//x.sxypix.com/pixiw/${sig}/1791766800/o/64aac/d28f/${pid}.webp' data-ow='1920'><img data-src='//x.sxypix.com/pixi/zz/1791766800/n/64aac/d28f/${pid}.jpg' class='gall_pix_pix'></div>`;
const sxyAnswer = JSON.stringify({ r: [sxyEl('k69', 'a1'), sxyEl('Q2x', 'b2'), sxyEl('Q2x', 'b2'), sxyEl('m-3', 'c3'), '<div>ad</div>'] });
eq(reader.sxypixOriginals(sxyAnswer), [
  'https://x.sxypix.com/pixiw/k69/1791766800/o/64aac/d28f/a1.webp',
  'https://x.sxypix.com/pixiw/Q2x/1791766800/o/64aac/d28f/b2.webp',
  'https://x.sxypix.com/pixiw/Q2x/1791766800/o/64aac/d28f/b2.webp',
  'https://x.sxypix.com/pixiw/m-3/1791766800/o/64aac/d28f/c3.webp',
], 'large data-src per photo, made https; inner thumbnails ignored');
const sxy = distill({ url: 'https://sxypix.com/w/d28f', title: 'A set', links: [], sxypix: sxyAnswer });
eq(sxy.image_urls.length, 3, 'deduped into the gallery');
ok(stash.isGallery(sxy), 'the set counts as a gallery');
for (const bad of [null, '', 'not json', '{"r":"x"}', '{"status":"err"}']) eq(reader.sxypixOriginals(bad), [], 'unreadable answer: ' + bad);

console.log('page reader: a sidebar full of models only keeps the ones the title names');
const many = ['Amy', 'Bea', 'Cat', 'Dee', 'Eve', 'Jane Doe'].map((t) => ({ href: `https://x.com/pornstars/${t}/`, text: t }));
eq(distill({ url: 'https://x.com/g/1', title: 'Jane Doe solo', links: many }).performers, ['Jane Doe'], 'sidebar names dropped');
eq(distill({ url: 'https://x.com/g/1', title: 'Nobody here', links: many }).performers, [], 'none named → none sent');

console.log('page reader: titles keep their own dashes; nav links are not names');
eq(distill({ url: 'https://a.com/x', title: 'Day 1 - A Love Story', links: [] }).title, 'Day 1 - A Love Story', 'short domain does not eat the tail');
eq(distill({ url: 'https://de.pornhub.com/v', title: 'Some Scene - Pornhub', links: [] }).title, 'Some Scene', 'subdomain: the registrable label matches');
eq(distill({ url: 'https://de.pornhub.com/v', title: 'Some Scene - Delta', links: [] }).title, 'Some Scene - Delta', 'subdomain prefix is not a match');
eq(distill({ url: 'https://x.com/g', title: 'Solo', links: [{ href: 'https://x.com/models/top/', text: 'Top Models' }, { href: 'https://x.com/girls/page2/', text: '123 girls' }] }).performers, [], 'generic nav text dropped');
eq(distill({ url: 'https://x.com/g', title: 'Solo', links: [{ href: 'https://x.com/models/kim/', text: 'Kim' }, { href: 'https://x.com/models/lu/', text: 'Lu' }] }).performers, [], 'two unnamed links → none');
eq(distill({ url: 'https://x.com/g', ld: [{ actor: { name: { bad: 1 } } }], links: [] }).performers, [], 'non-string LD name ignored');
eq(distill({ url: 'https://x.com/g', meta: { keywords: 'constructor, a' }, links: [] }).tags, ['constructor', 'a'], 'prototype-ish tags survive');

console.log('page reader: JSON-LD video');
const v = distill({
  url: 'https://tube.example.com/watch/9',
  title: 'ignored',
  meta: { 'og:title': 'Scene Nine', 'video:actor': ['Kay Lee'] },
  ld: [{ '@graph': [{ '@type': 'VideoObject', name: 'LD name', uploadDate: '2025-01-02', actor: [{ name: 'Ann Bo' }, 'Kay Lee'], productionCompany: { name: 'Big Studio' }, keywords: ['a', 'b'] }] }],
  links: [],
});
eq(v.title, 'Scene Nine', 'og:title wins');
eq(v.date, '2025-01-02', 'uploadDate');
eq(v.performers, ['Ann Bo', 'Kay Lee'], 'LD actors + video:actor, deduped');
eq(v.studio, 'Big Studio', 'productionCompany');
eq(v.tags, ['a', 'b'], 'LD keywords');
eq(v.image_urls, [], 'no image links');
ok(!stash.isGallery(v), 'not a gallery');

console.log('page reader: an empty page still answers');
const e = distill({ url: 'https://plain.example/', links: [] });
eq([e.title, e.studio, e.date, e.performers, e.image_urls], [null, null, null, [], []], 'nulls and empty lists');

console.log('request body');
const b = stash.body('gallery', page, page, { ...g, image_urls: [...g.image_urls, 'data:image/png;base64,AA'] });
eq(b.kind, 'gallery', 'kind');
eq(b.page_url, page, 'page_url');
eq(b.meta.performers, ['Jane Doe'], 'performers');
eq(b.meta.image_urls.length, 3, 'gallery carries image_urls, data: dropped');
const m = stash.body('media', 'https://cdn.x.com/a.jpg', 'https://x.com/p', g);
ok(!('image_urls' in m.meta), 'media carries no image list');
eq(m.page_url, 'https://x.com/p', 'media keeps the page it came from');
const bare = stash.body('video', 'https://x.com/v', 'about:blank', null);
eq(bare.page_url, 'https://x.com/v', 'no real page → the url itself');
eq(bare.meta.site, 'x.com', 'site from the url when the reader had nothing');
eq(stash.body('video', 'https://x.com/v', '', { date: 'yesterday' }).meta.date, null, 'a non-ISO date is dropped');
eq(stash.body('bogus', page, page, {}), null, 'unknown kind');
eq(stash.body('media', 'data:image/png;base64,AA', page, {}), null, 'unsendable url');

console.log('status wording');
eq(stash.statusText('gallery', { state: 'downloading' }), 'Stash: downloading gallery…', 'progress');
eq(stash.statusText('gallery', { state: 'done', path: '/data/Pictures/Downloads/2026-10-04 1554 - Jane Doe - Red' }),
  'Added gallery to Stash: 2026-10-04 1554 - Jane Doe - Red', 'done names the folder');
ok(/failed: Unsupported URL/.test(stash.statusText('media', { state: 'failed', error: 'Unsupported URL' })), 'failure reason');
ok(stash.finished({ state: 'done' }) && stash.finished({ state: 'failed' }) && !stash.finished({ state: 'tagging' }), 'finished');

console.log(`stash: ${n} checks passed`);
