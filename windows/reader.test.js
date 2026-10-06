// #232 tests:  node windows/reader.test.js
const assert = require('assert');
const { escapeHtml, readerScript, readerHtml, stripScripts, CSP } = require('./reader');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

const art = (o = {}) => ({
  ok: true,
  title: 'A Title',
  byline: 'By Someone',
  siteName: 'Example',
  content: '<p>Hello</p>',
  url: 'https://example.com/a/b?x=1&y=2',
  ...o,
});

console.log('escaping');
test('escapeHtml covers & < > " \'', () => {
  assert.strictEqual(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
test('escapeHtml tolerates null/undefined/numbers', () => {
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
  assert.strictEqual(escapeHtml(5), '5');
});
test('title, byline and site name are escaped', () => {
  const h = readerHtml(art({ title: '<img src=x onerror=1>', byline: '"><b>', siteName: '<i>S</i>' }));
  assert.ok(!h.includes('<img src=x'));
  assert.ok(h.includes('&lt;img src=x onerror=1&gt;'));
  assert.ok(h.includes('&quot;&gt;&lt;b&gt;'));
  assert.ok(h.includes('&lt;i&gt;S&lt;/i&gt;'));
});

console.log('the page');
test('strict CSP meta is present', () => {
  const h = readerHtml(art());
  assert.ok(h.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`));
  assert.strictEqual(CSP, "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; media-src *");
});
test('base href is the (escaped) article URL', () => {
  assert.ok(readerHtml(art()).includes('<base href="https://example.com/a/b?x=1&amp;y=2">'));
});
test('Original page link points at the article', () => {
  assert.ok(readerHtml(art()).includes('<a class="orig" href="https://example.com/a/b?x=1&amp;y=2">Original page</a>'));
});
test('a non-web URL gets no base and no link', () => {
  const h = readerHtml(art({ url: 'javascript:alert(1)' }));
  assert.ok(!h.includes('<base'));
  assert.ok(!h.includes('Original page'));
  assert.ok(!h.includes('javascript:'));
});
test('content is included as-is', () => {
  assert.ok(readerHtml(art({ content: '<p class="x">Hi <em>there</em></p>' })).includes('<p class="x">Hi <em>there</em></p>'));
});
test('typography and both colour schemes', () => {
  const h = readerHtml(art());
  assert.ok(h.includes('max-width: 42rem'));
  assert.ok(h.includes('1.15rem/1.7'));
  assert.ok(h.includes('max-width: 100%'));
  assert.ok(h.includes('prefers-color-scheme: dark'));
});
test('forced themes drop the media query', () => {
  assert.ok(!readerHtml(art(), 'dark').includes('prefers-color-scheme'));
  assert.ok(readerHtml(art(), 'dark').includes('#17181a'));
  assert.ok(!readerHtml(art(), 'light').includes('#17181a'));
});
test('missing site name and byline leave no empty elements', () => {
  const h = readerHtml(art({ siteName: '', byline: '' }));
  assert.ok(!h.includes('class="site"'));
  assert.ok(!h.includes('class="byline"'));
});

console.log('scripts never survive');
test('<script> in content is stripped', () => {
  const h = readerHtml(art({ content: '<p>a</p><script>alert(1)</script><p>b</p>' }));
  assert.ok(!/<script/i.test(h));
  assert.ok(!h.includes('alert(1)'));
  assert.ok(h.includes('<p>a</p>') && h.includes('<p>b</p>'));
});
test('upper-case, attributes and nesting tricks are stripped', () => {
  assert.ok(!/<script/i.test(stripScripts('<SCRIPT type="x">1</SCRIPT >')));
  assert.ok(!/<script/i.test(stripScripts('<scr<script></script>ipt>alert(1)</scr<script></script>ipt>')));
  assert.ok(!/<script/i.test(stripScripts('<script src=//evil/x.js>')));
});

console.log('the injected script');
test('readerScript embeds both sources and is valid JS', () => {
  const s = readerScript('function Readability(d){this.d=d;}', 'function isProbablyReaderable(){return true;}');
  assert.ok(s.includes('function Readability') && s.includes('isProbablyReaderable'));
  new Function(`return ${s}`); // parses
});
test('readerScript runs: a real article is shaped; a too-short one fails; the readerable guess never blocks', () => {
  const long = 'word '.repeat(60);
  const mk = (text) => `function Readability(d){} Readability.prototype.parse=function(){return {title:"T",content:"<p>x</p>",textContent:${JSON.stringify(text)},byline:"B",siteName:"S",excerpt:"E",lang:"en"};};`;
  const run = (src, ro) => new Function('document', 'location', `return ${readerScript(src, `function isProbablyReaderable(){return ${ro};}`)}`);
  const doc = { cloneNode: () => ({}), title: 'DT', documentElement: { lang: 'fr' } };
  const loc = { href: 'https://e.com/x' };
  const ok = run(mk(long), false)(doc, loc); // #232: the guess says no, we try anyway
  assert.deepStrictEqual(ok, { ok: true, title: 'T', byline: 'B', siteName: 'S', content: '<p>x</p>', excerpt: 'E', lang: 'en', dir: '', url: 'https://e.com/x' });
  const short = run(mk('Subscribe now'), true)(doc, loc);
  assert.strictEqual(short.ok, false);
  assert.ok(short.reason);
});
test('readerScript turns an exception into {ok:false}', () => {
  const r = new Function('document', 'location', `return ${readerScript('function Readability(){throw new Error("boom");}', '')}`)({ cloneNode: () => ({}) }, {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('boom'));
});

console.log(`\n${run} tests passed`);
