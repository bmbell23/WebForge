// #72 / #311: the Persona-rule pattern syntax, Electron-free so hotkey scopes
// (#311) and Persona rules share one matcher and it is unit-testable.
// #72: rules accept three syntaxes, all anchored at the start and open-ended
// at the end (so `https://host` still matches `https://host/deep/path`):
//   plain   https://jira.example.com      prefix match (unchanged)
//   glob    https://*.devops.example.com  '*' matches any run of characters
//   regex   /^https:\/\/(ci|cd)\.example\.com/   full regular expression
const reCache = new Map();

function clearCache() {
  reCache.clear();
}

function compile(pattern) {
  if (reCache.has(pattern)) return reCache.get(pattern);
  let re = null;
  const raw = String(pattern).trim();
  const asRegex = raw.match(/^\/(.*)\/([a-z]*)$/); // /body/flags
  try {
    if (asRegex) {
      const flags = asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`;
      re = new RegExp(asRegex[1], flags);
    } else if (raw.includes('*')) {
      const body = raw
        .replace(/\*+$/, '')                       // trailing * is implicit
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')      // escape regex metachars
        .replace(/\*/g, '.*');                     // then let '*' mean anything
      re = new RegExp(`^${body}`, 'i');
    }
  } catch {
    re = null; // a bad pattern matches nothing rather than breaking routing
  }
  reCache.set(pattern, re);
  return re;
}

function matches(url, pattern) {
  if (!url || !pattern) return false;
  const re = compile(pattern);
  if (re) return re.test(String(url));
  const p = String(pattern).trim().replace(/\*+$/, '').toLowerCase();
  return p ? String(url).toLowerCase().startsWith(p) : false;
}

module.exports = { matches, compile, clearCache };
