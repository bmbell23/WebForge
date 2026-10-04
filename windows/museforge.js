// #179: "Create outfit in MuseForge…" on a right-clicked image.
//
// MuseForge's Studio (MuseForge#206) has a page that makes an outfit from a
// picture. We only hand it the address; the Studio shows the picture, asks for
// confirmation, and spends nothing until Brandon presses its button. His Studio
// login cookie covers access in the new tab.
//
// Electron-free on purpose (see CLAUDE.md), so node can test it.
'use strict';

const OUTFIT_PAGE = 'http://100.69.184.113:8005/library/outfit/from-image';

/** Only an absolute http(s) image can be handed over; data:, blob: and file: can't be fetched by the Studio. */
function canSend(src) {
  try {
    const u = new URL(String(src || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The Studio address for an image plus the optional name and description. */
function outfitUrl(src, name, text) {
  if (!canSend(src)) return null;
  const q = new URLSearchParams({ src: String(src) });
  const n = String(name || '').trim();
  const t = String(text || '').trim();
  if (n) q.set('name', n);
  if (t) q.set('text', t);
  return `${OUTFIT_PAGE}?${q.toString()}`;
}

/**
 * #191: the Studio's from-image form redirects to /approvals#fig-outfit-<name>
 * once the outfit is queued. Reaching it in the Create Outfit tab means "done":
 * WebForge takes you back to the page you came from. Pinned by
 * shared/outfit-done-fixtures.tsv, which the Android test reads too.
 */
function isDone(url) {
  try {
    const u = new URL(String(url || ''));
    const page = new URL(OUTFIT_PAGE);
    return u.origin === page.origin && (u.pathname === '/approvals' || u.pathname.startsWith('/approvals/'));
  } catch {
    return false;
  }
}

// --- #195: Create straight from the dialog, no tab ---
// The Studio's form POSTs to the same address: src (it fetches the picture
// itself), name, text. Its only guard is the login cookie, which WebForge
// already holds from browsing the Studio. 2 figures × $0.035 (the Studio's
// SHEET_CANDIDATES × PRICE).
const PRICE_LABEL = '~$0.07';

/** The form body, or null for a picture the Studio can't fetch. */
function createForm(src, name, text) {
  if (!canSend(src)) return null;
  return new URLSearchParams({
    src: String(src),
    name: String(name || '').trim(),
    text: String(text || '').trim(),
  }).toString();
}

/**
 * What the Studio's answer means. It redirects (303) to /approvals#fig-outfit-<name>
 * once the jobs are queued, and to /login?next=… when this device isn't logged
 * in. Anything else is an error. Pinned by shared/outfit-create-fixtures.tsv.
 */
function createResult(status, location) {
  let path = '';
  try { path = new URL(String(location || ''), OUTFIT_PAGE).pathname; } catch { /* no usable Location */ }
  if (status >= 300 && status < 400) {
    if (path === '/approvals' || path.startsWith('/approvals/')) return 'queued';
    if (path === '/login') return 'login';
  }
  return 'error';
}

module.exports = { OUTFIT_PAGE, PRICE_LABEL, canSend, outfitUrl, isDone, createForm, createResult };
