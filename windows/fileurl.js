// #319: file:// URLs for our own pages, in the exact form Chromium reports them.
// The old hand-rolled `file://${path}` was right on Linux and macOS (`/opt/…`
// supplies the third slash) and wrong on Windows: `file://C:/…` never matched
// the `file:///C:/…` that getURL() returns, so isInternalUrl() was always false
// there and the net-error page counted as "leaving home" (#313's loop, still live).
//
// Electron-free, so the rule is unit-testable without a Windows machine.

const url = require('url');

/** file:// URL for an absolute path. `opts.windows` forces Windows path rules (tests). */
function fileUrl(p, opts) {
  return url.pathToFileURL(p, opts).href;
}

/** Does `u` point at `p` (or at `p` with a query/hash)? */
function isFileUrlOf(u, p, opts) {
  if (typeof u !== 'string') return false;
  const base = fileUrl(p, opts);
  return u === base || u.startsWith(base + '?') || u.startsWith(base + '#');
}

module.exports = { fileUrl, isFileUrlOf };
