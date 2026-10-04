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

module.exports = { OUTFIT_PAGE, canSend, outfitUrl };
