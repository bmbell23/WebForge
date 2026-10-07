// #214: the order Personas are shown in, and the key after Ctrl+Space that
// picks each one. Electron-free so it is tested (personaorder.test.js) and
// shared by the picker and the leader keys.
//
// Terminal is built in and Windows-only: it is never stored in personas.json,
// so the sync service and the phone never see it. App slots (Mattermost,
// Teams, Outlook, Discord) are the same kind of thing: one pinned tab each, stored in
// local settings, never synced. Unassigned is the fallback, so it goes last
// (#71). Ids never change; only the display order does.
const TERMINAL = 'terminal';
const UNASSIGNED = 'unassigned';
const SLOT_PREFIX = 'slot-';

const TERMINAL_PERSONA = Object.freeze({ id: TERMINAL, name: 'Terminal', builtin: true, terminal: true, rules: [] });

// #297: the keys FOLLOW THE POSITION. The list is the key map: position 1 gets `
// (Backquote, F1), position 2 gets ! (Digit1, Ctrl+1, F2) ... position 8 gets &
// (Digit7, F8). Positions 9+ have no key. Ctrl+Space then the physical key.
const KEYS = Object.freeze([
  { key: '`', code: 'Backquote', shift: false },
  { key: '!', code: 'Digit1', shift: true },
  { key: '@', code: 'Digit2', shift: true },
  { key: '#', code: 'Digit3', shift: true },
  { key: '$', code: 'Digit4', shift: true },
  { key: '%', code: 'Digit5', shift: true },
  { key: '^', code: 'Digit6', shift: true },
  { key: '&', code: 'Digit7', shift: true }, // #282
]);

// Brandon's default order (2026-10-06), used until you reorder:
//   Terminal, Work Mattermost, Work, Mattermost, Personal, Teams, Outlook, Discord
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
]);

// The default order with its keys, as before #297 (Settings and docs still read it).
const KEYMAP = DEFAULT_ORDER.map((e, i) => ({ ...KEYS[i], ...e }));

const DEFAULT_SLOTS = Object.freeze([
  // `home`: the Persona a page opened FROM the slot lands in (#219).
  { id: 'work-mattermost', name: 'Work Mattermost', url: 'http://co-sf-pe-042.colorado.datadirectnet.com:8065/', home: 'work' },
  { id: 'personal-mattermost', name: 'Mattermost', url: 'http://100.69.184.113:8065/', home: 'personal' },
  { id: 'teams', name: 'Teams', url: 'https://teams.cloud.microsoft/', home: 'work' },
  { id: 'outlook', name: 'Outlook', url: 'https://outlook.cloud.microsoft/mail/', home: 'work' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/channels/276238974421434368/276238974421434368', home: 'personal' },
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

// The app slots with your edited URLs (settings.appSlots = {id: url}) laid over
// the defaults. A blank or broken edit keeps the default.
function slots(overrides) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  return DEFAULT_SLOTS.map((s) => ({ ...s, url: slotUrl(o[s.id]) || s.url }));
}

const slotPersona = (s) => ({ id: SLOT_PREFIX + s.id, name: s.name, builtin: true, slot: s.id, url: s.url, rules: [] });
const isSlotId = (id) => typeof id === 'string' && id.startsWith(SLOT_PREFIX);

// #297: `savedOrder` (settings.personaOrder, an array of ids) wins: the ids that
// still exist, in that order, then everything else in the default order (so a new
// Persona lands after the ones you placed), then Unassigned, always last. Each
// entry in the first 8 places carries the key for its position (`key`, `code`,
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
  const m = /^Digit([1-7])$/.exec((p && p.code) || '');
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
// createTab). A normal Persona keeps it; an app slot sends it to its home Persona
// (Work or Personal, by name); the Terminal, or a slot whose home is missing,
// sends it to Unassigned.
function openerHome(pid, ordered) {
  if (pid === TERMINAL) return UNASSIGNED;
  if (!isSlotId(pid)) return pid || UNASSIGNED;
  const def = DEFAULT_SLOTS.find((s) => SLOT_PREFIX + s.id === pid);
  const home = def && (ordered || []).find((p) => !p.slot && p.id !== TERMINAL && p.id !== UNASSIGNED &&
    String(p.name || '').trim().toLowerCase() === def.home);
  return home ? home.id : UNASSIGNED;
}

// #224: the same targets as one chord, no leader: Ctrl+` (Shift allowed, so
// Ctrl+~ too) and Ctrl+1–7, by physical key. `ordered` is a function so the
// Persona list is only built when the chord actually matches.
// #251/#264: bare F-keys, in the Ctrl+Space key order: F1 is the Terminal
// (Ctrl+`), F2–F8 are Ctrl+1–7.
const DIRECT = /^(Backquote|Digit[1-7])$/; // #297: the key of whoever holds that position
const FKEY = /^F([1-8])$/;
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
  slots, slotUrl, isSlotId, orderPersonas, leaderPick, unreadFromTitle, unreadBadge, directPick, slotFor, openerHome, stepPersona, movePersona, keyLabel,
};
