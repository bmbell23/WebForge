// #117 / #33 / #78: should a sticky tab be pulled back to its home?
//
// "Sticky" means a tab that only ever shows its own site: quick-launch tabs
// (#33) and, since #117, pinned tabs. Link clicks and plain navigations are
// already diverted to new tabs before this is consulted; this is the last line
// of defence against an SPA router pushing state past both.
//
// The rule is ORIGIN-level, and that is a scar, not an oversight. From #78:
//
//   "Comparing full URLs livelocked the app: a home that redirects (login,
//    /dashboard -> /dashboard/self) or an SPA firing did-navigate-in-page kept
//    tripping this, and each cycle re-loaded home and re-triggered the redirect
//    — several times a second, for ever."
//
// So a same-origin move is always allowed. Tightening this to exact URLs
// reintroduces that livelock; if that is ever attempted again, do it behind a
// test that loads a redirecting home.
//
// Electron-free, so the rule is unit-testable without a Windows machine.

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * True when `navUrl` has left `homeUrl`'s site and the tab should be re-homed
 * (with the destination opening as its own tab).
 *
 * Unknown or unparseable URLs return false: doing nothing is always safer than
 * yanking a tab based on a URL we could not read.
 */
function shouldRehome(navUrl, homeUrl) {
  const from = originOf(navUrl);
  const to = originOf(homeUrl);
  if (!from || !to) return false;
  return from !== to;
}

module.exports = { originOf, shouldRehome };
