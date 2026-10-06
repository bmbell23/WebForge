// #236: clean a user-typed tab name. Electron-free so it can be unit-tested
// with plain `node` (see tabname.test.js).
const MAX_TAB_NAME = 120;

// Returns the trimmed name (newlines/tabs collapsed to single spaces, capped at
// MAX_TAB_NAME), or null when nothing is left — null means "clear the custom name".
function cleanTabName(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim().slice(0, MAX_TAB_NAME).trim();
  return t || null;
}

module.exports = { cleanTabName, MAX_TAB_NAME };
