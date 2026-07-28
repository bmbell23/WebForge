// Bookmarks store (#11): flat list with folder paths, JSON in userData.
// updatedAt/addedAt are kept for the future sync service (#13).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

let cached = null;
const file = () => path.join(app.getPath('userData'), 'bookmarks.json');

function load() {
  if (!cached) {
    try {
      cached = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      cached = { bookmarks: [] };
    }
    if (!Array.isArray(cached.bookmarks)) cached = { bookmarks: [] };
  }
  return cached.bookmarks;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cached));
  } catch {}
}

function all() {
  return load();
}

function has(url) {
  return load().some((b) => b.url === url);
}

function add({ title, url, folder = '' }) {
  if (!url || has(url)) return false;
  load().push({
    id: crypto.randomUUID(),
    title: title || url,
    url,
    folder,
    addedAt: Date.now(),
    updatedAt: Date.now(),
  });
  save();
  return true;
}

function remove(idOrUrl) {
  const list = load();
  const idx = list.findIndex((b) => b.id === idOrUrl || b.url === idOrUrl);
  if (idx === -1) return false;
  list.splice(idx, 1);
  save();
  return true;
}

// --- Firefox import (#11) ---

// Netscape bookmarks.html (what Firefox's "Export bookmarks to HTML" writes):
// nested <DL> lists, <DT><H3> folder names, <DT><A HREF> bookmarks.
function parseNetscapeHtml(text) {
  const out = [];
  const stack = [];
  const tokens = text.match(/<DT><H3[^>]*>.*?<\/H3>|<\/DL>|<DT><A [^>]*>.*?<\/A>/gis) || [];
  const decode = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  for (const tok of tokens) {
    if (tok.startsWith('<DT><H3')) {
      stack.push(decode(tok.replace(/<[^>]+>/g, '').trim()));
    } else if (tok === '</DL>' || tok.toUpperCase() === '</DL>') {
      stack.pop();
    } else {
      const href = tok.match(/HREF="([^"]*)"/i)?.[1];
      const title = decode(tok.replace(/<[^>]+>/g, '').trim());
      if (href && /^https?:/i.test(href)) {
        out.push({ title: title || href, url: decode(href), folder: stack.join('/') });
      }
    }
  }
  return out;
}

// Firefox .json backup (Bookmarks → Backup): a tree of
// text/x-moz-place-container / text/x-moz-place nodes.
function parseFirefoxJson(text) {
  const out = [];
  const walk = (node, trail) => {
    if (!node) return;
    if (node.type === 'text/x-moz-place' && node.uri && /^https?:/i.test(node.uri)) {
      out.push({ title: node.title || node.uri, url: node.uri, folder: trail.join('/') });
    } else if (Array.isArray(node.children)) {
      const next = node.title && trail.length ? [...trail, node.title] : node.title ? [node.title] : trail;
      for (const c of node.children) walk(c, next);
    }
  };
  walk(JSON.parse(text), []);
  return out;
}

function importFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = filePath.toLowerCase().endsWith('.json')
    ? parseFirefoxJson(text)
    : parseNetscapeHtml(text);
  let added = 0;
  for (const b of parsed) if (add(b)) added++;
  return { found: parsed.length, added, skipped: parsed.length - added };
}

module.exports = { all, has, add, remove, importFile };
