// Personas (#25): named workspaces that tabs are routed into by URL rules.
// Tabs-only isolation — cookies/logins stay shared (user decision 2026-07-29).
// Unmatched URLs land in the built-in "Unassigned" persona so the real ones
// stay clean.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const UNASSIGNED = 'unassigned';

let cached = null;
const file = () => path.join(app.getPath('userData'), 'personas.json');

function defaults() {
  return {
    personas: [
      { id: UNASSIGNED, name: 'Unassigned', builtin: true, rules: [] },
      { id: crypto.randomUUID(), name: 'Personal', rules: [] },
      { id: crypto.randomUUID(), name: 'Work', rules: [] },
    ],
    active: UNASSIGNED,
    updatedAt: Date.now(),
  };
}

function load() {
  if (!cached) {
    try {
      cached = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      cached = defaults();
      save();
    }
    if (!Array.isArray(cached.personas) || !cached.personas.length) cached = defaults();
    // Unassigned must always exist and must always be first.
    if (!cached.personas.some((p) => p.id === UNASSIGNED)) {
      cached.personas.unshift({ id: UNASSIGNED, name: 'Unassigned', builtin: true, rules: [] });
    }
  }
  return cached;
}

function save() {
  cached.updatedAt = Date.now();
  try {
    fs.writeFileSync(file(), JSON.stringify(cached));
  } catch {}
}

const all = () => load().personas;
const get = (id) => all().find((p) => p.id === id) || null;

function activeId() {
  const a = load().active;
  return get(a) ? a : UNASSIGNED;
}

function setActive(id) {
  if (!get(id)) return false;
  load().active = id;
  save();
  return true;
}

function add(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const p = { id: crypto.randomUUID(), name: clean, rules: [] };
  load().personas.push(p);
  save();
  return p;
}

function remove(id) {
  if (id === UNASSIGNED) return false; // built-in, always present
  const list = load().personas;
  const i = list.findIndex((p) => p.id === id);
  if (i === -1) return false;
  list.splice(i, 1);
  if (cached.active === id) cached.active = UNASSIGNED;
  save();
  return true;
}

function update(id, fields) {
  const p = get(id);
  if (!p) return false;
  if (typeof fields.name === 'string' && fields.name.trim() && id !== UNASSIGNED) {
    p.name = fields.name.trim();
  }
  if (Array.isArray(fields.rules)) {
    p.rules = fields.rules.map((r) => String(r).trim()).filter(Boolean);
  }
  save();
  return true;
}

// Prefix match, case-insensitive, trailing '*' optional — same semantics as
// the tab-group patterns this generalises (#34).
function matches(url, pattern) {
  if (!url || !pattern) return false;
  const p = String(pattern).trim().replace(/\*+$/, '').toLowerCase();
  return p ? String(url).toLowerCase().startsWith(p) : false;
}

/** Which persona owns this URL? Unassigned when no rule claims it. */
function forUrl(url) {
  for (const p of all()) {
    if (p.id === UNASSIGNED) continue;
    if (p.rules.some((r) => matches(url, r))) return p.id;
  }
  return UNASSIGNED;
}

module.exports = { UNASSIGNED, all, get, activeId, setActive, add, remove, update, forUrl, matches };
