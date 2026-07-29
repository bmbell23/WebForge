// Bookmarks store (#11): flat list with folder paths, JSON in userData.
// updatedAt/addedAt are kept for the future sync service (#13).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

let cached = null;
let urlIndex = null; // #78: Set of bookmarked URLs — has() ran per tab per push
const file = () => path.join(app.getPath('userData'), 'bookmarks.json');

function load() {
  if (!cached) {
    try {
      cached = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      cached = { bookmarks: [], updatedAt: 0 };
    }
    if (!Array.isArray(cached.bookmarks)) cached = { bookmarks: [], updatedAt: 0 };
    if (typeof cached.updatedAt !== 'number') cached.updatedAt = 0;
  }
  return cached.bookmarks;
}

function save() {
  urlIndex = null; // #78
  cached.updatedAt = Date.now(); // local mutation → we are now the newest copy
  try {
    fs.writeFileSync(file(), JSON.stringify(cached));
  } catch {}
}

// --- #13 sync support: whole-store last-write-wins ---
function meta() {
  load();
  return { updatedAt: cached.updatedAt };
}

// Adopt the server's copy verbatim, KEEPING its timestamp (bumping it would
// make every client look newer than the server and ping-pong forever).
function replaceAll(list, updatedAt) {
  load();
  urlIndex = null; // #78
  cached.bookmarks = Array.isArray(list) ? list : [];
  cached.updatedAt = updatedAt || 0;
  try {
    fs.writeFileSync(file(), JSON.stringify(cached));
  } catch {}
}

function all() {
  return load();
}

function has(url) {
  if (!urlIndex) urlIndex = new Set(load().map((b) => b.url));
  return urlIndex.has(url);
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

// #29: edit title/url/folder in place; bumps timestamps so #13 sync carries it.
function update(id, fields) {
  const b = load().find((x) => x.id === id);
  if (!b) return false;
  if (fields.title) b.title = fields.title;
  if (fields.url) b.url = fields.url;
  if (fields.folder !== undefined) b.folder = fields.folder;
  b.updatedAt = Date.now();
  save();
  return true;
}

// #29 v2: folder operations for the manager (drag & drop, rename, delete).
function moveMany(ids, folder) {
  const set = new Set(ids || []);
  let n = 0;
  for (const b of load()) {
    if (set.has(b.id)) {
      b.folder = folder || '';
      b.updatedAt = Date.now();
      n++;
    }
  }
  if (n) save();
  return n;
}

// Rename a folder and re-parent everything beneath it.
function renameFolder(from, to) {
  if (!from || !to || from === to) return 0;
  let n = 0;
  for (const b of load()) {
    const f = b.folder || '';
    if (f === from || f.startsWith(`${from}/`)) {
      b.folder = to + f.slice(from.length);
      b.updatedAt = Date.now();
      n++;
    }
  }
  if (n) save();
  return n;
}

// Delete a folder: its bookmarks (and subfolders') move up to the parent
// rather than being destroyed — deleting a folder should never lose links.
function deleteFolder(folder) {
  if (!folder) return 0;
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
  let n = 0;
  for (const b of load()) {
    const f = b.folder || '';
    if (f === folder || f.startsWith(`${folder}/`)) {
      b.folder = parent;
      b.updatedAt = Date.now();
      n++;
    }
  }
  if (n) save();
  return n;
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

module.exports = {
  all, has, add, update, remove, importFile, meta, replaceAll,
  moveMany, renameFolder, deleteFolder,
};
