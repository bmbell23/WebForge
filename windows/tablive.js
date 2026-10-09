// #170: the root of "links stop working from anywhere until restart".
//
// A sign-in popup (e.g. OpenBao's vaultOIDCWindow) is adopted as a tab (#219)
// and closes itself when sign-in finishes. Its view stays in `tabs` while
// closeTab runs, but `view.webContents` is already gone. tabUrlOf did
// `tabs.get(id)?.webContents.getURL()`: the `?.` guarded the view, not the
// webContents, so it threw "Cannot read properties of undefined (reading
// 'getURL')". closeTab threw before removing the tab, the dead tab stayed in
// tabOrder forever, and every later walk of the tab list threw too: opening a
// link (openOrFocus → findTabByUrl), session saves, tab switches, sidebar
// pushes. PC log, 2026-10-09 17:49:42Z onward: ~70 uncaughtExceptions in 2.5
// minutes, until a restart.
//
// Electron-free, so the rule is unit-testable without a Windows machine.

/** The view's webContents if it is still alive, else null. Never throws. */
function liveWc(view) {
  const wc = view && view.webContents;
  if (!wc) return null;
  try {
    return wc.isDestroyed() ? null : wc;
  } catch {
    return null;
  }
}

/** URL of a live view, '' for a dead or missing one. Never throws. */
function liveUrl(view) {
  const wc = liveWc(view);
  if (!wc) return '';
  try {
    return wc.getURL() || '';
  } catch {
    return '';
  }
}

module.exports = { liveWc, liveUrl };
