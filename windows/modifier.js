// #150: which modifier key means "WebForge", per platform.
//
// On Windows and Linux that's Ctrl. On macOS it's ⌘ — and this is not cosmetic:
// macOS *has* a Control key, it is a different physical key, and reacting to it
// would make every chord fire on the wrong one while ⌘ did nothing. The mirror
// trap is Windows, where `meta` is the Windows key and must never trigger us.
// So a chord is "the primary modifier is down AND the other one is not".
//
// Three places used to ask this question independently — `before-input-event`
// in main, and the two preloads — each spelling it `input.control` / `e.ctrlKey`.
// They now all come here, because a modifier layer that disagrees with itself
// fails silently: keys simply stop working, with nothing logged.
//
// Electron-free on purpose (see CLAUDE.md): the build host has no macOS, so the
// only way to prove the darwin behaviour is to make the platform a parameter and
// test both.
'use strict';

// Accepts EITHER an Electron before-input-event `input` ({control, meta, alt,
// shift}) OR a DOM KeyboardEvent ({ctrlKey, metaKey, altKey, shiftKey}). The
// two shapes describe the same thing and every call site has one or the other.
function read(ev) {
  if (!ev || typeof ev !== 'object') return { control: false, meta: false, alt: false, shift: false };
  const pick = (a, b) => !!(ev[a] === undefined ? ev[b] : ev[a]);
  return {
    control: pick('control', 'ctrlKey'),
    meta: pick('meta', 'metaKey'),
    alt: pick('alt', 'altKey'),
    shift: pick('shift', 'shiftKey'),
  };
}

// `primary` is ours; `foreign` is the same-role key on the other platform, which
// must never stand in for it.
function state(ev, platform) {
  const m = read(ev);
  const darwin = (platform || process.platform) === 'darwin';
  return {
    primary: darwin ? m.meta : m.control,
    foreign: darwin ? m.control : m.meta,
    alt: m.alt,
    shift: m.shift,
  };
}

// The app's chord: primary alone. Shift is deliberately allowed — Ctrl+Shift+Tab
// and friends are real bindings.
function isChord(ev, platform) {
  const s = state(ev, platform);
  return s.primary && !s.foreign && !s.alt;
}

// Same, but shift must be up. The preloads' guarded keys (Ctrl+X, Ctrl+S, Ctrl+J)
// use this so they don't swallow Shift variants the page may want.
function isChordExact(ev, platform) {
  const s = state(ev, platform);
  return s.primary && !s.foreign && !s.alt && !s.shift;
}

// No modifier that could change the meaning of the key (F11, Escape). Shift is
// unconstrained, matching the behaviour these call sites already had.
function isBare(ev, platform) {
  const s = state(ev, platform);
  return !s.primary && !s.foreign && !s.alt;
}

// Alt/Option alone — Alt+Left/Right navigation, Alt+F4.
function isAltOnly(ev, platform) {
  const s = state(ev, platform);
  return s.alt && !s.primary && !s.foreign;
}

// The persisted hotkey id, e.g. "Ctrl+K" or "Ctrl+Alt+K".
//
// The literal "Ctrl+" is a STORAGE FORMAT, not a physical key. It stays "Ctrl+"
// on macOS even though the user pressed ⌘, because these ids are written to the
// vault and reconciled against Android through the sync service — a Mac that
// stored "Cmd+K" would silently stop matching the same binding everywhere else.
// The platform difference belongs in which key produces the id, never in the id.
function keyId(ev, rawKey, platform) {
  const s = state(ev, platform);
  return (s.primary ? 'Ctrl+' : '') + (s.alt ? 'Alt+' : '') + (rawKey || '');
}

// #41's leader chord, and deliberately NOT the primary modifier on macOS:
// ⌘+Space is Spotlight, owned by the OS, so globalShortcut registration would
// either fail or fight it. Control+Space is free on both platforms and keeps the
// muscle memory identical, at the cost of being the one chord on macOS that
// isn't ⌘. Worth revisiting on real hardware.
const LEADER_ACCELERATOR = 'Control+Space';

function isLeaderChord(ev) {
  const m = read(ev);
  return m.control && !m.alt && !m.meta;
}

module.exports = {
  read,
  state,
  isChord,
  isChordExact,
  isBare,
  isAltOnly,
  keyId,
  isLeaderChord,
  LEADER_ACCELERATOR,
};
