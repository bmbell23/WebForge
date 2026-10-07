// #214: the order Personas are shown in, and the key after Ctrl+Space that
// picks each one. Electron-free so it is tested (personaorder.test.js) and
// shared by the picker and the leader keys.
//
// Terminal is built in and Windows-only: it is never stored in personas.json,
// so the sync service and the phone never see it. App slots (Mattermost,
// Teams, Outlook, Discord, Slack; #301: now your own list, settings.apps) are the same
// kind of thing: one pinned tab each, stored in local settings, never synced. Unassigned is the fallback, so it goes last
// (#71). Ids never change; only the display order does.
const TERMINAL = 'terminal';
const UNASSIGNED = 'unassigned';
const SLOT_PREFIX = 'slot-';

const TERMINAL_PERSONA = Object.freeze({ id: TERMINAL, name: 'Terminal', builtin: true, terminal: true, rules: [] });

// #297: the keys FOLLOW THE POSITION. The list is the key map: position 1 gets `
// (Backquote, F1), position 2 gets ! (Digit1, Ctrl+1, F2) ... position 10 gets (
// (Digit9, F10, #307). Positions 11+ have no key. Ctrl+Space then the physical key.
const KEYS = Object.freeze([
  { key: '`', code: 'Backquote', shift: false },
  { key: '!', code: 'Digit1', shift: true },
  { key: '@', code: 'Digit2', shift: true },
  { key: '#', code: 'Digit3', shift: true },
  { key: '$', code: 'Digit4', shift: true },
  { key: '%', code: 'Digit5', shift: true },
  { key: '^', code: 'Digit6', shift: true },
  { key: '&', code: 'Digit7', shift: true }, // #282
  { key: '*', code: 'Digit8', shift: true }, // #307
  { key: '(', code: 'Digit9', shift: true }, // #307 (Ctrl+0 stays Actual Size)
]);

// Brandon's default order (2026-10-06), used until you reorder:
//   Terminal, Work Mattermost, Work, Mattermost, Personal, Teams, Outlook, Discord, Slack
// `persona` entries find a stored Persona by name; `slot` entries are app slots.
const DEFAULT_ORDER = Object.freeze([
  { terminal: true },
  { slot: 'work-mattermost' },
  { persona: 'work' },
  { slot: 'personal-mattermost' },
  { persona: 'personal' },
  { slot: 'teams' },
  { slot: 'outlook' },
  { slot: 'discord' }, // #282
  { slot: 'slack' }, // #301: position 9, so no key until you move it up
]);

// The default order with its keys, as before #297 (Settings and docs still read it).
// #301: only the first KEYS.length entries have a key.
const KEYMAP = DEFAULT_ORDER.slice(0, KEYS.length).map((e, i) => ({ ...KEYS[i], ...e }));

const DEFAULT_SLOTS = Object.freeze([
  // `home`: the Persona a page opened FROM the slot lands in (#219).
  { id: 'work-mattermost', name: 'Work Mattermost', url: 'http://co-sf-pe-042.colorado.datadirectnet.com:8065/', home: 'work' },
  { id: 'personal-mattermost', name: 'Mattermost', url: 'http://100.69.184.113:8065/', home: 'personal' },
  { id: 'teams', name: 'Teams', url: 'https://teams.cloud.microsoft/', home: 'work' },
  { id: 'outlook', name: 'Outlook', url: 'https://outlook.cloud.microsoft/mail/', home: 'work' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/channels/276238974421434368/276238974421434368', home: 'personal' },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client', home: 'work' }, // #301
]);

// An http(s) URL, or null.
function slotUrl(s) {
  try {
    const u = new URL(String(s || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// #301: an app as stored in settings.apps, or null when it can't be one. `home` is
// a Persona id or one of the names 'work'/'personal' ('' = Unassigned).
function normalizeApp(a) {
  if (!a || typeof a !== 'object') return null;
  const id = String(a.id || '').trim();
  const name = String(a.name || '').trim();
  const url = slotUrl(a.url);
  if (!id || !name || !url) return null;
  return { id, name, url, home: String(a.home || '').trim() };
}

function normalizeApps(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const a = normalizeApp(raw);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

// #301: the apps list. A stored settings.apps array wins (normalized). Otherwise
// the defaults, with the old URL edits (settings.appSlots = {id: url}) laid over
// them; a blank or broken edit keeps the default.
function seedApps(settings) {
  const st = settings && typeof settings === 'object' ? settings : {};
  if (Array.isArray(st.apps)) return normalizeApps(st.apps);
  const o = st.appSlots && typeof st.appSlots === 'object' ? st.appSlots : {};
  return DEFAULT_SLOTS.map((s) => ({ ...s, url: slotUrl(o[s.id]) || s.url }));
}

// The app slots: an apps array as is (normalized), else (legacy) a {id: url}
// override object over the defaults.
function slots(appsOrOverrides) {
  return Array.isArray(appsOrOverrides) ? normalizeApps(appsOrOverrides) : seedApps({ appSlots: appsOrOverrides });
}

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

// #301: why `app` can't be saved next to `apps`, or null. An app with an id that
// is already in `apps` is an edit and is not compared with itself.
function validateApp(app, apps) {
  const name = String((app && app.name) || '').trim();
  if (name.length < 1 || name.length > 40) return 'Name must be 1 to 40 characters';
  const url = slotUrl(app && app.url);
  if (!url) return 'URL must be a web address (http or https)';
  const origin = originOf(url);
  const other = (apps || []).find((a) => a.id !== (app && app.id) && originOf(a.url) === origin);
  return other ? `Another app already uses ${origin}` : null;
}

const slugOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

// #301: `apps` plus a new one (ids are permanent: slug of the name, then -2, -3...).
// Does not validate; call validateApp first. Returns `apps` unchanged for junk.
function addApp(apps, fields) {
  const list = apps || [];
  const base = slugOf(fields && fields.name);
  let id = base;
  for (let n = 2; list.some((a) => a.id === id); n++) id = `${base}-${n}`;
  const app = normalizeApp({ ...fields, id });
  return app ? [...list, app] : list;
}

// #301: `apps` with app `id`'s name/url/home replaced; the id never changes. A
// field that would be invalid (blank name, bad URL) keeps its old value.
function editApp(apps, id, fields) {
  return (apps || []).map((a) => {
    if (a.id !== id) return a;
    const f = fields || {};
    return normalizeApp({
      ...a,
      name: f.name !== undefined && String(f.name).trim() ? f.name : a.name,
      url: f.url !== undefined && slotUrl(f.url) ? f.url : a.url,
      home: f.home !== undefined ? f.home : a.home,
      id: a.id,
    }) || a;
  });
}

const removeApp = (apps, id) => (apps || []).filter((a) => a.id !== id);

const slotPersona = (s) => ({ id: SLOT_PREFIX + s.id, name: s.name, builtin: true, slot: s.id, url: s.url, rules: [] });
const isSlotId = (id) => typeof id === 'string' && id.startsWith(SLOT_PREFIX);

// #297: `savedOrder` (settings.personaOrder, an array of ids) wins: the ids that
// still exist, in that order, then everything else in the default order (so a new
// Persona lands after the ones you placed), then Unassigned, always last. Each
// entry in the first 10 places carries the key for its position (`key`, `code`,
// `shift`) for the picker and the leader.
function orderPersonas(list, slotList = slots(), savedOrder = null) {
  const stored = (list || []).filter((p) => p.id !== TERMINAL && !isSlotId(p.id));
  const byName = (name) =>
    stored.find((p) => p.id !== UNASSIGNED && String(p.name || '').trim().toLowerCase() === name);
  const defaults = [];
  for (const e of DEFAULT_ORDER) {
    let p = null;
    if (e.terminal) p = TERMINAL_PERSONA;
    else if (e.slot) {
      const s = slotList.find((x) => x.id === e.slot);
      p = s && slotPersona(s);
    } else p = byName(e.persona);
    if (p) defaults.push(p);
  }
  // #301: apps you added are not in DEFAULT_ORDER; they follow the defaults.
  for (const s of slotList) if (!DEFAULT_ORDER.some((e) => e.slot === s.id)) defaults.push(slotPersona(s));
  const known = new Map();
  for (const p of defaults) known.set(p.id, p);
  for (const p of stored) if (p.id !== UNASSIGNED && !known.has(p.id)) known.set(p.id, p);
  const out = [];
  const used = new Set();
  const take = (id) => {
    if (used.has(id) || !known.has(id)) return;
    used.add(id);
    out.push(known.get(id));
  };
  if (Array.isArray(savedOrder)) savedOrder.forEach(take);
  defaults.forEach((p) => take(p.id));
  for (const p of stored) take(p.id);
  out.push(...stored.filter((p) => p.id === UNASSIGNED));
  return out.map((p, i) => (i < KEYS.length ? { ...p, ...KEYS[i] } : p));
}

// #297: `ordered` with `id` swapped one place left (dir < 0) or right, as an id
// array for settings.personaOrder. No wrap. Unassigned can't move and nothing
// moves past it. null when there is no move.
function movePersona(ordered, id, dir) {
  const ids = (ordered || []).map((p) => p.id);
  const i = ids.indexOf(id);
  if (i < 0 || id === UNASSIGNED) return null;
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= ids.length || ids[j] === UNASSIGNED) return null;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}

// #297: what picks an entry, for Settings: "F3 · Ctrl+2". '' when it has no key.
function keyLabel(p) {
  const m = /^Digit([1-9])$/.exec((p && p.code) || '');
  if (m) return `F${Number(m[1]) + 1} · Ctrl+${m[1]}`;
  return p && p.code === 'Backquote' ? 'F1 · Ctrl+`' : '';
}

// #221: the app slot whose site `url` is on (same scheme, host and port as the
// slot's URL), or null. A slot claims its whole site, so a second Mattermost
// channel or an Outlook calendar page opens as another tab in the slot.
function slotFor(url, slotList = slots()) {
  let origin;
  try {
    origin = new URL(String(url || '')).origin;
  } catch {
    return null;
  }
  if (!origin || origin === 'null') return null;
  const hit = slotList.find((s) => {
    try {
      return new URL(s.url).origin === origin;
    } catch {
      return false;
    }
  });
  return hit ? SLOT_PREFIX + hit.id : null;
}

// #219: where a page opened from Persona `pid` belongs (URL rules still win in
// createTab). A normal Persona keeps it; an app slot sends it to its home (#301: a
// Persona id, or the name 'work'/'personal', or any name); the Terminal, or a slot
// whose home is missing or 'unassigned', sends it to Unassigned.
function openerHome(pid, ordered, appList = slots()) {
  if (pid === TERMINAL) return UNASSIGNED;
  if (!isSlotId(pid)) return pid || UNASSIGNED;
  const def = appList.find((s) => SLOT_PREFIX + s.id === pid);
  const want = def ? String(def.home || '').trim() : '';
  if (!want || want.toLowerCase() === UNASSIGNED) return UNASSIGNED;
  const real = (ordered || []).filter((p) => !p.slot && p.id !== TERMINAL && p.id !== UNASSIGNED);
  const home = real.find((p) => p.id === want) ||
    real.find((p) => String(p.name || '').trim().toLowerCase() === want.toLowerCase());
  return home ? home.id : UNASSIGNED;
}

// #224: the same targets as one chord, no leader: Ctrl+` (Shift allowed, so
// Ctrl+~ too) and Ctrl+1–9, by physical key. `ordered` is a function so the
// Persona list is only built when the chord actually matches.
// #251/#264: bare F-keys, in the Ctrl+Space key order: F1 is the Terminal
// (Ctrl+`), F2–F10 are Ctrl+1–9.
const DIRECT = /^(Backquote|Digit[1-9])$/; // #297: the key of whoever holds that position
const FKEY = /^F([1-9]|10)$/; // #307: F11 full screen and F12 DevTools stay
function directPick(input, ordered) {
  if (!input) return null;
  const f = FKEY.exec(input.code || '');
  if (f) {
    if (input.control || input.alt || input.meta || input.shift) return null; // Alt+F4, Ctrl+F4 stay
    const list = typeof ordered === 'function' ? ordered() : ordered;
    const want = f[1] === '1' ? 'Backquote' : `Digit${Number(f[1]) - 1}`;
    const hit = (list || []).find((p) => p.code === want);
    return hit ? hit.id : null;
  }
  if (!input.control || input.alt || input.meta || !DIRECT.test(input.code || '')) return null;
  if (input.shift && input.code !== 'Backquote') return null; // Ctrl+Shift+digit stays the page's
  const list = typeof ordered === 'function' ? ordered() : ordered;
  const hit = (list || []).find((p) => p.code === input.code);
  return hit ? hit.id : null;
}

// #295: Ctrl+Alt+Left/Right. The Persona `dir` (±1) places from `currentId` in
// picker order, wrapping at the ends. A current id not in the list starts from
// the first entry. null when there's nowhere else to go.
function stepPersona(ordered, currentId, dir) {
  const ids = (ordered || []).map((p) => p.id);
  if (ids.length < 2) return null;
  const i = ids.indexOf(currentId);
  if (i < 0) return ids[0];
  return ids[(i + (dir < 0 ? -1 : 1) + ids.length) % ids.length];
}

// #231: what a page title says about unread messages. Teams and Mattermost
// lead with "(3) …" for a count; Mattermost leads with "* " when there are
// unread messages but no mentions. Returns { count, dot }.
function unreadFromTitle(title) {
  const t = String(title || '').trimStart();
  const m = /^\((\d{1,5})\+?\)\s/.exec(t);
  if (m) return { count: Number(m[1]), dot: false };
  return { count: 0, dot: /^\*\s/.test(t) };
}

// #231: one badge for a slot's tabs: counts add up, a dot only shows with no count.
function unreadBadge(titles) {
  let count = 0;
  let dot = false;
  for (const t of titles || []) {
    const u = unreadFromTitle(t);
    count += u.count;
    dot = dot || u.dot;
  }
  return count ? `(${count})` : dot ? '•' : '';
}

// The Persona the key after Ctrl+Space picks, by physical key (`code`) so the
// symbols live wherever the layout puts them. null when it picks nothing.
function leaderPick(input, ordered) {
  if (!input || input.control || input.alt || input.meta) return null;
  const hit = (ordered || []).find((p) => p.code && p.code === input.code && Boolean(input.shift) === p.shift);
  return hit ? hit.id : null;
}

module.exports = {
  TERMINAL, UNASSIGNED, TERMINAL_PERSONA, KEYS, DEFAULT_ORDER, KEYMAP, DEFAULT_SLOTS,
  slots, slotUrl, seedApps, normalizeApp, validateApp, addApp, editApp, removeApp, isSlotId, orderPersonas, leaderPick, unreadFromTitle, unreadBadge, directPick, slotFor, openerHome, stepPersona, movePersona, keyLabel,
};
