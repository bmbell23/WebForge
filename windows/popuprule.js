// #125: does this window.open() actually want a popup WINDOW, or is it just a
// link that happens to go through window.open?
//
// Background. #111 had to stop denying window.open outright: Electron's
// setWindowOpenHandler offers only `deny` (which makes window.open() return
// **null**, so a page that keeps the handle throws on its next line) or `allow`
// (a real OS window). There is no "render as a tab but hand back a live handle".
//
// #111 then allowed a window whenever ANY features string was present, or the
// window was named. Both are everyday link idioms —
//   window.open(url, '_blank', 'noopener')     the standard safe-link pattern
//   window.open(url, 'someName')               a named target
// — so ordinary links started opening separate windows, which is #125.
//
// The line that actually separates the two: a real popup states its GEOMETRY.
// A terminal console or a credential prompt says width/height (or popup=1);
// a link never does. Everything without geometry becomes a tab.
//
// Electron-free so the rule is unit-tested here rather than discovered in use.

/** Parse a window.open features string into a lowercased key→value map. */
function parseFeatures(features) {
  const out = {};
  for (const part of String(features || '').split(',')) {
    const [rawKey, rawValue] = part.split('=');
    const key = (rawKey || '').trim().toLowerCase();
    if (key) out[key] = (rawValue === undefined ? '' : rawValue).trim().toLowerCase();
  }
  return out;
}

const TRUTHY = ['1', 'yes', 'true', ''];

/**
 * True only when the page asked for a popup window.
 *
 * `disposition` is deliberately NOT trusted on its own: Chromium reports
 * 'new-window' from the same features string we are inspecting, so leaning on it
 * would reintroduce the guesswork this module exists to remove.
 */
function wantsRealWindow(details) {
  const f = parseFeatures(details && details.features);
  if (Number.parseInt(f.width, 10) > 0) return true;
  if (Number.parseInt(f.height, 10) > 0) return true;
  if ('popup' in f && TRUTHY.includes(f.popup)) return true;
  return false;
}

module.exports = { wantsRealWindow, parseFeatures };
