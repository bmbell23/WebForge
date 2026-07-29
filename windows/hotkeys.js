// Hotkey store (#16): keyId -> {url, title}. keyId is event.key with optional
// modifier prefixes ("b", "B", "!", "Ctrl+j", "Alt+B", ...) — the shift layer
// is implicit in event.key's case/symbol. Plain JSON in userData (not secret,
// shaped for the sync service later).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let cached = null;
const file = () => path.join(app.getPath('userData'), 'hotkeys.json');

// #25: bindings are per-Persona — 'w' in Personal and 'w' in Work are
// different bookmarks. Shape: { personaId: { keyId: {url,title} } }.
function load() {
  if (!cached) {
    try {
      cached = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      cached = {};
    }
    if (typeof cached !== 'object' || cached === null || Array.isArray(cached)) cached = {};
    // Migrate the old flat { keyId: {url,title} } store into a persona bucket
    // so existing bindings survive the upgrade.
    const flat = Object.keys(cached).filter((k) => cached[k] && typeof cached[k].url === 'string');
    if (flat.length) {
      const migrated = {};
      for (const k of flat) {
        migrated[k] = cached[k];
        delete cached[k];
      }
      cached.__migrated = migrated;
    }
  }
  return cached;
}

function bucket(personaId) {
  const store = load();
  const id = personaId || 'unassigned';
  if (!store[id]) {
    store[id] = {};
    save();
  }
  return store[id];
}

/**
 * #73: move pre-Persona bindings into a CHOSEN Persona, once. Previously the
 * migrated bag went to whichever Persona happened to request its bucket first,
 * so old bindings landed somewhere effectively random.
 */
function migrateInto(personaId) {
  const store = load();
  if (!store.__migrated) return 0;
  const target = store[personaId] || (store[personaId] = {});
  let n = 0;
  for (const [k, v] of Object.entries(store.__migrated)) {
    if (!(k in target)) {
      target[k] = v;
      n++;
    }
  }
  delete store.__migrated;
  save();
  return n;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cached));
  } catch {}
}

function all(personaId) {
  return { ...bucket(personaId) };
}

function get(keyId, personaId) {
  return bucket(personaId)[keyId] || null;
}

function set(keyId, entry, personaId) {
  if (!keyId || !entry?.url) return false;
  // Bare digits are reserved for Persona switching (Ctrl+Space then 1-9).
  if (/^[1-9]$/.test(keyId)) return false;
  const b = bucket(personaId);
  // #73: one hotkey per bookmark per Persona. Without this an older key for
  // the same URL survived and kept winning keyForUrl(), so the badge showed
  // the stale key while both pointed at the same bookmark.
  for (const k of Object.keys(b)) {
    if (k !== keyId && b[k] && b[k].url === entry.url) delete b[k];
  }
  b[keyId] = { url: entry.url, title: entry.title || entry.url };
  save();
  return true;
}

function remove(keyId, personaId) {
  const b = bucket(personaId);
  if (!(keyId in b)) return false;
  delete b[keyId];
  save();
  return true;
}

function keyIds(personaId) {
  return Object.keys(bucket(personaId));
}

// Find the keyId bound to a URL in this persona (for unbind-from-bookmark UX).
function keyForUrl(url, personaId) {
  const b = bucket(personaId);
  return Object.keys(b).find((k) => b[k].url === url) || null;
}

module.exports = { all, get, set, remove, keyIds, keyForUrl, migrateInto };
