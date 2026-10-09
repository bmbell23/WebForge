// #170: the modal dialogs that hold the chrome view full-window and ON TOP of
// the page. While any is "open" in main, every click lands on chrome, so a flag
// that main still believes is set after the chrome UI has dropped the dialog
// leaves an invisible layer over the whole window: pages and the sidebar both
// stop taking clicks until restart. Seven hand-copied lists of these flags had
// drifted apart in main.js; this is now the one list, and the one rule for
// noticing a flag the UI no longer agrees with.
//
// Electron-free, so the rule is unit-testable without a Windows machine.

/** flag name -> the chrome UI element that shows it (gets class "open"). */
const DIALOG_IDS = {
  bmDialog: 'bmdialog',
  loginPrompt: 'loginprompt',
  ytdlp: 'ytdlp',
  outfit: 'outfit',
  quick: 'quick',
};

/** Is any modal flag set? `flags` is { name: boolean }. */
function anyOpen(flags) {
  return Object.values(flags || {}).some(Boolean);
}

/**
 * Flags main holds that the chrome UI does not show. `uiOpen` is the list of
 * element ids with class "open". Flags with no known element are never stale.
 */
function staleFlags(flags, uiOpen) {
  const open = new Set(uiOpen || []);
  return Object.entries(flags || {})
    .filter(([name, on]) => on && DIALOG_IDS[name] && !open.has(DIALOG_IDS[name]))
    .map(([name]) => name);
}

/**
 * A flag is only cleared after it was stale on two checks in a row, so a dialog
 * whose IPC is still in flight to the chrome UI is never torn down.
 * Returns { heal: [names], pending: Set } for the next round.
 */
function confirmStale(stale, pending) {
  const prev = pending || new Set();
  const heal = stale.filter((n) => prev.has(n));
  return { heal, pending: new Set(stale) };
}

/** Selector the chrome UI is asked about. */
const OPEN_SELECTOR = Object.values(DIALOG_IDS).map((id) => `#${id}.open`).join(',');

module.exports = { DIALOG_IDS, OPEN_SELECTOR, anyOpen, staleFlags, confirmStale };
