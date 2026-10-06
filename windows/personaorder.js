// #214: the order Personas are shown in, and the key after Ctrl+Space that
// picks each one. Electron-free so it is tested (personaorder.test.js) and
// shared by the picker and the leader keys.
//
// Terminal is built in and Windows-only: it is never stored in personas.json,
// so the sync service and the phone never see it. App slots (Mattermost,
// Teams, Outlook) are the same kind of thing: one pinned tab each, stored in
// local settings, never synced. Unassigned is the fallback, so it goes last
// (#71). Ids never change; only the display order does.
const TERMINAL = 'terminal';
const UNASSIGNED = 'unassigned';
const SLOT_PREFIX = 'slot-';

const TERMINAL_PERSONA = Object.freeze({ id: TERMINAL, name: 'Terminal', builtin: true, terminal: true, rules: [] });

// Brandon's key map (2026-10-06), Ctrl+Space then the physical key:
//   ` Terminal   ! Work Mattermost   @ Work   # Personal Mattermost
//   $ Personal   % Teams             ^ Outlook
// `persona` entries find a stored Persona by name; `slot` entries are app slots.
const KEYMAP = [
  { key: '`', code: 'Backquote', shift: false, terminal: true },
  { key: '!', code: 'Digit1', shift: true, slot: 'work-mattermost' },
  { key: '@', code: 'Digit2', shift: true, persona: 'work' },
  { key: '#', code: 'Digit3', shift: true, slot: 'personal-mattermost' },
  { key: '$', code: 'Digit4', shift: true, persona: 'personal' },
  { key: '%', code: 'Digit5', shift: true, slot: 'teams' },
  { key: '^', code: 'Digit6', shift: true, slot: 'outlook' },
];

const DEFAULT_SLOTS = Object.freeze([
  // `home`: the Persona a page opened FROM the slot lands in (#219).
  { id: 'work-mattermost', name: 'Work Mattermost', url: 'http://co-sf-pe-042.colorado.datadirectnet.com:8065/', home: 'work' },
  { id: 'personal-mattermost', name: 'Mattermost', url: 'http://100.69.184.113:8065/', home: 'personal' },
  { id: 'teams', name: 'Teams', url: 'https://teams.cloud.microsoft/', home: 'work' },
  { id: 'outlook', name: 'Outlook', url: 'https://outlook.cloud.microsoft/mail/', home: 'work' },
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

// Key order first, then any other Persona you made, then Unassigned. Each entry
// that has a key carries it (`key`, `code`, `shift`) for the picker and the leader.
function orderPersonas(list, slotList = slots()) {
  const stored = (list || []).filter((p) => p.id !== TERMINAL && !isSlotId(p.id));
  const byName = (name) =>
    stored.find((p) => p.id !== UNASSIGNED && String(p.name || '').trim().toLowerCase() === name);
  const keyed = [];
  const used = new Set();
  for (const k of KEYMAP) {
    let p = null;
    if (k.terminal) p = TERMINAL_PERSONA;
    else if (k.slot) {
      const s = slotList.find((x) => x.id === k.slot);
      p = s && slotPersona(s);
    } else p = byName(k.persona);
    if (!p || used.has(p.id)) continue;
    used.add(p.id);
    keyed.push({ ...p, key: k.key, code: k.code, shift: k.shift });
  }
  return [
    ...keyed,
    ...stored.filter((p) => p.id !== UNASSIGNED && !used.has(p.id)),
    ...stored.filter((p) => p.id === UNASSIGNED),
  ];
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
// Ctrl+~ too) and Ctrl+1–6, by physical key. `ordered` is a function so the
// Persona list is only built when the chord actually matches.
const DIRECT = /^(Backquote|Digit[1-6])$/;
function directPick(input, ordered) {
  if (!input || !input.control || input.alt || input.meta || !DIRECT.test(input.code || '')) return null;
  if (input.shift && input.code !== 'Backquote') return null; // Ctrl+Shift+digit stays the page's
  const list = typeof ordered === 'function' ? ordered() : ordered;
  const hit = (list || []).find((p) => p.code === input.code);
  return hit ? hit.id : null;
}

// The Persona the key after Ctrl+Space picks, by physical key (`code`) so the
// symbols live wherever the layout puts them. null when it picks nothing.
function leaderPick(input, ordered) {
  if (!input || input.control || input.alt || input.meta) return null;
  const hit = (ordered || []).find((p) => p.code && p.code === input.code && Boolean(input.shift) === p.shift);
  return hit ? hit.id : null;
}

module.exports = {
  TERMINAL, UNASSIGNED, TERMINAL_PERSONA, KEYMAP, DEFAULT_SLOTS,
  slots, slotUrl, isSlotId, orderPersonas, leaderPick, directPick, slotFor, openerHome,
};
