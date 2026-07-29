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

// --- #70: assigning a bookmark to a Persona -----------------------------
// A bookmark 'belongs' to a Persona by way of a rule that matches its URL.
// The origin is the useful granularity: assigning one Jira ticket should route
// all of Jira.
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Which Persona claims this URL, and by which rule? */
function claimFor(url) {
  for (const p of all()) {
    if (p.id === UNASSIGNED) continue;
    const rule = (p.rules || []).find((r) => matches(url, r));
    if (rule) return { personaId: p.id, name: p.name, rule };
  }
  return null;
}

/**
 * Route `url`'s origin to `personaId`.
 * Never creates a second claim: forUrl() returns the FIRST match, so a
 * duplicate rule would be dead weight and the bookmark would appear not to
 * move. An existing claim is relocated instead, and a claim broader than the
 * origin needs `force` because dropping it re-routes other sites too.
 */
function assign(url, personaId, opts = {}) {
  const origin = originOf(url);
  if (!origin) return { ok: false, error: 'That URL has no usable origin.' };
  const target = personaId === UNASSIGNED ? null : get(personaId);
  if (personaId !== UNASSIGNED && !target) return { ok: false, error: 'No such Persona.' };

  const claim = claimFor(url);
  if (claim && claim.personaId === personaId) {
    return { ok: true, unchanged: true, rule: claim.rule, name: claim.name };
  }
  if (claim) {
    const broader = claim.rule.replace(/\*+$/, '').length < origin.length;
    if (broader && !opts.force) {
      return {
        ok: false,
        needsConfirm: true,
        from: claim.name,
        rule: claim.rule,
        error:
          `"${claim.rule}" is broader than ${origin}, so removing it also un-routes ` +
          `everything else it matches.`,
      };
    }
    const owner = get(claim.personaId);
    owner.rules = owner.rules.filter((r) => r !== claim.rule);
  }
  if (target) {
    if (!target.rules.includes(origin)) target.rules.push(origin);
  }
  save();
  return { ok: true, moved: Boolean(claim), from: claim?.name || null, rule: origin };
}

module.exports = {
  UNASSIGNED, all, get, activeId, setActive, add, remove, update, forUrl, matches,
  originOf, claimFor, assign,
};
