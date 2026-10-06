// #232: reader mode. Electron-free on purpose (see CLAUDE.md): main.js runs
// readerScript() inside the page and loads readerHtml()'s output into the same
// tab; everything that can be decided without Electron is decided here and
// unit-tested (reader.test.js).
'use strict';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The script main.js hands to webContents.executeJavaScript. Both library
// sources are inlined inside one function so nothing leaks into the page's
// globals (and `module`/`exports` are shadowed so their CommonJS tails no-op).
// The result is a plain, structured-cloneable object.
function readerScript(readabilitySource, readerableSource) {
  return `(function () {
  var module = undefined, exports = undefined;
  try {
    ${readabilitySource}
    ${readerableSource}
    // You asked for reader mode, so always try: isProbablyReaderable is a
    // guess and refuses plenty of real articles. Only an empty result fails.
    var article = new Readability(document.cloneNode(true)).parse();
    if (!article || !article.content || String(article.textContent || '').trim().length < 200) {
      return { ok: false, reason: 'Could not find an article on this page.' };
    }
    return {
      ok: true,
      title: article.title || document.title || '',
      byline: article.byline || '',
      siteName: article.siteName || '',
      content: article.content,
      excerpt: article.excerpt || '',
      lang: article.lang || document.documentElement.lang || '',
      dir: article.dir || '',
      url: location.href
    };
  } catch (err) {
    return { ok: false, reason: 'Reader mode failed: ' + String((err && err.message) || err) };
  }
})()`;
}

// Defensive: Readability already sanitizes, and the CSP forbids scripts anyway,
// but a <script> must never be in the document. Loops so that nesting such as
// "<scr<script></script>ipt>" cannot reassemble one.
function stripScripts(html) {
  let out = String(html == null ? '' : html);
  let prev;
  do {
    prev = out;
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    out = out.replace(/<\/?script\b[^>]*>?/gi, '');
  } while (out !== prev);
  return out;
}

const isWebUrl = (u) => /^https?:\/\//i.test(String(u || ''));

const CSP = "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; media-src *";

const CSS = `
  :root { color-scheme: light dark; }
  html { background: #fbfaf7; color: #222; }
  body { margin: 0; padding: 2rem 1.25rem 5rem; font: 1.15rem/1.7 Georgia, 'Times New Roman', serif; }
  main, header { max-width: 42rem; margin: 0 auto; }
  header { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid rgba(128,128,128,.35); }
  .site { font: 600 .8rem/1.2 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; opacity: .65; }
  h1.title { font-size: 2rem; line-height: 1.2; margin: .5rem 0; }
  .byline { font: .95rem/1.4 system-ui, sans-serif; opacity: .75; margin: 0; }
  .orig { display: inline-block; margin-top: .75rem; font: .8rem/1.2 system-ui, sans-serif; }
  a { color: #1a5fb4; }
  img, video, svg, iframe { max-width: 100%; height: auto; }
  figure { margin: 1.5rem 0; }
  figcaption { font: .85rem/1.4 system-ui, sans-serif; opacity: .7; }
  pre { overflow-x: auto; padding: .75rem; background: rgba(128,128,128,.12); }
  blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid rgba(128,128,128,.4); }
`;
const CSS_DARK = `html { background: #17181a; color: #d8d8d8; } a { color: #7db3ff; }`;

// theme: 'auto' (default, follows the OS), 'light' or 'dark'.
function readerHtml(article, theme) {
  const a = article || {};
  const web = isWebUrl(a.url);
  const url = web ? escapeHtml(a.url) : '';
  const title = escapeHtml(a.title);
  const dark =
    theme === 'dark' ? CSS_DARK : theme === 'light' ? '' : `@media (prefers-color-scheme: dark) { ${CSS_DARK} }`;
  const scheme = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'light dark';
  const lang = /^[A-Za-z0-9-]{1,35}$/.test(a.lang || '') ? ` lang="${escapeHtml(a.lang)}"` : '';
  const dir = a.dir === 'rtl' || a.dir === 'ltr' ? ` dir="${a.dir}"` : '';
  return `<!DOCTYPE html>
<html${lang}${dir}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
${web ? `<base href="${url}">\n` : ''}<title>${title}</title>
<style>${CSS}${dark}</style>
</head>
<body>
<header>
${a.siteName ? `<div class="site">${escapeHtml(a.siteName)}</div>\n` : ''}<h1 class="title">${title}</h1>
${a.byline ? `<p class="byline">${escapeHtml(a.byline)}</p>\n` : ''}${web ? `<a class="orig" href="${url}">Original page</a>\n` : ''}</header>
<main>
${stripScripts(a.content)}
</main>
</body>
</html>`;
}

module.exports = { escapeHtml, readerScript, readerHtml, stripScripts, CSP };
