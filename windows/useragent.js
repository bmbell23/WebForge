// #134: what User-Agent we tell websites we are.
//
// Electron's default UA is Chromium's own string with two extra tokens spliced
// in — the app name and the Electron version:
//
//   … (KHTML, like Gecko) WebForge/0.1.142 Chrome/132.0.0.0 Electron/34.5.8 Safari/537.36
//
// The engine really is Chromium 132, so sites that refuse us (Chase, and any
// bank with a "supported browsers" allowlist) are not detecting a missing
// capability — they are pattern-matching a brand they don't recognise and
// bailing out. Brave and Edge present as plain Chrome for the same reason.
//
// We derive the string by REMOVING those two tokens from whatever Electron
// generated, rather than hardcoding a UA of our own. That matters: a hardcoded
// string is correct on the day it's written and then silently rots into
// claiming an old Chrome every time we bump Electron, which is worse than not
// spoofing at all. Subtracting keeps `Chrome/NNN` truthful for free.
//
// Electron-free so the string surgery is testable without a display (see
// useragent.test.js).

// Both tokens are `Name/version`, always preceded by a space in Chromium's
// format. Taking the leading space with them is what keeps the result from
// containing a double space where the token used to be.
const DROP = [/ WebForge\/\S+/gi, / Electron\/\S+/gi];

/**
 * Strip WebForge's and Electron's tokens from a User-Agent string.
 * Anything else — platform, AppleWebKit, Chrome and Safari tokens — is left
 * exactly as Chromium wrote it.
 */
function cleanUserAgent(ua) {
  if (typeof ua !== 'string' || !ua) return '';
  let out = ua;
  for (const re of DROP) out = out.replace(re, '');
  // Defensive: if a future Electron formats the tokens differently and the
  // removal leaves ragged spacing, don't ship a UA with double spaces in it —
  // that alone looks synthetic to a sniffer.
  return out.replace(/\s{2,}/g, ' ').trim();
}

module.exports = { cleanUserAgent };
