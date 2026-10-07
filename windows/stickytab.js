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
// #311: a hotkey binding may carry a `scope` pattern (Persona-rule syntax). With
// one, "home" is the whole scope rather than the origin: in scope stays, out of
// scope re-homes. Same livelock caveat as above does not apply, because scope
// membership is a pure function of the URL (a redirect that stays in scope is
// still in scope).
//
// Electron-free, so the rule is unit-testable without a Windows machine.

const urlpattern = require('./urlpattern');

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
function shouldRehome(navUrl, homeUrl, scope) {
  // #311: a scoped binding decides by pattern, not origin.
  if (typeof scope === 'string' && scope.trim()) {
    if (!navUrl || !/^https?:/i.test(String(navUrl))) return false; // unreadable: leave it
    return !urlpattern.matches(navUrl, scope);
  }
  const from = originOf(navUrl);
  const to = originOf(homeUrl);
  if (!from || !to) return false;
  return from !== to;
}

/** #311: is `url` inside this binding's scope? False when no scope is set. */
function inScope(binding, url) {
  const scope = binding && typeof binding.scope === 'string' ? binding.scope.trim() : '';
  return Boolean(scope) && urlpattern.matches(url, scope);
}

/**
 * #311: the first open hotkey tab whose scope claims `url`.
 * candidates: [{id, scope}]; returns an id or null.
 */
function scopeTabFor(url, candidates) {
  const hit = (candidates || []).find((c) => inScope(c, url));
  return hit ? hit.id : null;
}

module.exports = { originOf, shouldRehome, inScope, scopeTabFor };
