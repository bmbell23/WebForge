// #107: deciding whether two URLs are "the same page" for tab de-duplication.
//
// The old test was exact string equality, which meant de-dup silently failed on
// a trailing slash, a `#fragment`, `http` vs `https`, or `www.` — and every path
// that opens a URL went through it, including the sync adoption loop that runs
// every 30 seconds. A tab that redirects on load (http -> https, or gaining a
// trailing slash) stopped matching what the other device published, so it was
// adopted again as a fresh tab. That is the "duplicate tabs I didn't create".
//
// Electron-free so it can be unit-tested with plain `node`.

/**
 * Reduce a URL to a comparison key. Equal keys mean "the same tab".
 *
 * Normalised away: scheme (http/https), a leading `www.`, default ports, a
 * trailing slash, and plain `#anchor` fragments.
 * Kept significant: host, port when non-default, path, the whole query string,
 * and `#/hash-routes`.
 *
 * The `#/` rule is a HEURISTIC, and a deliberate one. Hash-routed apps
 * conventionally use `#/path`, so `app/#/dashboard` and `app/#/settings` are
 * genuinely different pages, while `docs#install` and `docs#intro` are two
 * positions in one document. An app that routes on bare `#names` will be treated
 * as a single page — the wrong answer, but the rarer one.
 *
 * Anything that is not http(s) — file://, view-source:, about: — is returned
 * trimmed but otherwise untouched, so internal pages never normalise into each
 * other.
 */
function canonical(url) {
  if (typeof url !== 'string') return '';
  const raw = url.trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw; // not parseable: compare literally rather than guess
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const isDefaultPort =
    !u.port || (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443');
  const port = isDefaultPort ? '' : `:${u.port}`;
  const path = u.pathname.replace(/\/+$/, ''); // "/docs/" and "/docs" are one page
  const hash = u.hash.startsWith('#/') ? u.hash : ''; // route kept, anchor dropped
  return `${host}${port}${path}${u.search}${hash}`;
}

/** True when both URLs denote the same tab. Empty/unknown never matches. */
function sameTab(a, b) {
  const ka = canonical(a);
  return Boolean(ka) && ka === canonical(b);
}

/**
 * #138: which existing tab already shows `url` — or null to open a new one.
 *
 * `exceptId` is the whole point. A sticky tab (pinned #117 / hotkey #33) that
 * has drifted off its home re-homes itself by opening the destination
 * "somewhere else" and then reloading its own home. But that runs on
 * `did-navigate`, AFTER the drift has landed, so the sticky tab is at that
 * moment the tab displaying the destination — and a plain search picks it as
 * its own rescue target. It then gets sent home, and the page opens nowhere:
 * the flicker-and-nothing-happens report.
 *
 * The caller passes the tab being evicted so it can never be chosen to rescue
 * itself. Note this is a rule about which tab WINS, and this area has now
 * produced three bugs of exactly that kind (#78 livelock, #118 flicker, #138) —
 * every one of them from a rule that lived only inside main.js and so was never
 * tested. Hence living here.
 *
 * @param {Array<{id: *, url: string}>} tabs in display order; first match wins
 */
function pickTab(tabs, url, exceptId) {
  const key = canonical(url);
  if (!key || !Array.isArray(tabs)) return null;
  for (const tab of tabs) {
    if (!tab) continue;
    // Guard with `!== undefined` rather than a truthiness test: tab id 0 is a
    // perfectly good id, and `if (exceptId)` would silently stop excluding it.
    if (exceptId !== undefined && exceptId !== null && tab.id === exceptId) continue;
    if (canonical(tab.url) === key) return tab.id;
  }
  return null;
}

module.exports = { canonical, sameTab, pickTab };
