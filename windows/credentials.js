// Password store (#12): lives entirely inside the vault (AES-GCM under the
// master key — see vault.js), so it's only readable while unlocked and never
// plaintext on disk. Import source: Firefox about:logins → "Export passwords"
// CSV (header: url,username,password,httpRealm,formActionOrigin,...).
const fs = require('fs');
const crypto = require('crypto');
const vault = require('./vault');

function load() {
  const data = vault.readFile('credentials');
  const creds = Array.isArray(data?.creds) ? data.creds : [];
  // #26: stable ids so the manager UI can address entries; migrates
  // pre-#26 imports in place on first unlocked read.
  let migrated = false;
  for (const c of creds) {
    if (!c.id) {
      c.id = crypto.randomUUID();
      migrated = true;
    }
  }
  if (migrated) save(creds);
  return creds;
}

function save(creds) {
  return vault.writeFile('credentials', { creds });
}

function count() {
  return load().length;
}

// #136: `forOrigin` used to live here and matched origins as exact strings, so
// a login saved for https://www.chase.com could never fill on chase.com. It is
// gone rather than deprecated — leaving it exported is an invitation to
// reintroduce the bug. Matching now lives in credmatch.js, which ranks
// origin > host > registrable domain and refuses unsafe folds.

// Minimal correct CSV: quoted fields, escaped quotes, commas/newlines inside
// quotes, CRLF endings.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  row.push(cur);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function importCsv(filePath) {
  if (!vault.isUnlocked()) return { error: 'vault locked' };
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!rows.length) return { found: 0, added: 0, updated: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iUrl = col('url');
  const iUser = col('username');
  const iPass = col('password');
  if (iUrl === -1 || iPass === -1) return { error: 'not a Firefox password CSV (missing url/password columns)' };

  const creds = load();
  let found = 0;
  let added = 0;
  let updated = 0;
  for (const row of rows.slice(1)) {
    const rawUrl = row[iUrl];
    const password = row[iPass];
    if (!rawUrl || !password) continue;
    let origin;
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      continue;
    }
    found++;
    const username = iUser === -1 ? '' : row[iUser] ?? '';
    const existing = creds.find((c) => c.origin === origin && c.username === username);
    if (existing) {
      if (existing.password !== password) {
        existing.password = password;
        updated++;
      }
    } else {
      creds.push({ id: crypto.randomUUID(), origin, username, password });
      added++;
    }
  }
  save(creds);
  return { found, added, updated };
}

// --- #26: credentials manager ---

function list() {
  return load();
}

// With an id: update that entry; without: add a new one. Origin is normalized
// to a real origin so entries stay comparable; #136's matcher is tolerant of
// looser values but the store should not be the thing producing them.
function upsert({ id, origin, username, password }) {
  if (!vault.isUnlocked()) return false;
  let normOrigin;
  try {
    normOrigin = new URL(origin).origin;
  } catch {
    return false;
  }
  if (!password) return false;
  const creds = load();
  const existing = id ? creds.find((c) => c.id === id) : null;
  if (existing) {
    existing.origin = normOrigin;
    existing.username = username ?? '';
    existing.password = password;
  } else {
    creds.push({ id: crypto.randomUUID(), origin: normOrigin, username: username ?? '', password });
  }
  return save(creds);
}

function removeById(id) {
  if (!vault.isUnlocked()) return false;
  const creds = load();
  const idx = creds.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  creds.splice(idx, 1);
  return save(creds);
}

module.exports = { count, importCsv, list, upsert, removeById };
