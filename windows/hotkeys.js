// Hotkey store (#16): keyId -> {url, title}. keyId is event.key with optional
// modifier prefixes ("b", "B", "!", "Ctrl+j", "Alt+B", ...) — the shift layer
// is implicit in event.key's case/symbol. Plain JSON in userData (not secret,
// shaped for the sync service later).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let cached = null;
const file = () => path.join(app.getPath('userData'), 'hotkeys.json');

function load() {
  if (!cached) {
    try {
      cached = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      cached = {};
    }
    if (typeof cached !== 'object' || cached === null || Array.isArray(cached)) cached = {};
  }
  return cached;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cached));
  } catch {}
}

function all() {
  return { ...load() };
}

function get(keyId) {
  return load()[keyId] || null;
}

function set(keyId, entry) {
  if (!keyId || !entry?.url) return false;
  load()[keyId] = { url: entry.url, title: entry.title || entry.url };
  save();
  return true;
}

function remove(keyId) {
  const store = load();
  if (!(keyId in store)) return false;
  delete store[keyId];
  save();
  return true;
}

function keyIds() {
  return Object.keys(load());
}

// Find the keyId bound to a URL (for unbind-from-bookmark UX).
function keyForUrl(url) {
  const store = load();
  return Object.keys(store).find((k) => store[k].url === url) || null;
}

module.exports = { all, get, set, remove, keyIds, keyForUrl };
