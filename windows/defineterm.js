// #286: which selected text is a definable word or short phrase.
//
// The SAME rule lives in server/sync.py (clean_term) and
// android/.../DefineTerm.kt. Keep all three in step; each has the same tests.
//
//   1. smart quotes become plain ones (don’t -> don't)
//   2. whitespace runs collapse to one space
//   3. leading/trailing quotes, brackets, , . ; : ! ? … and hyphens are dropped
//   4. valid only at 1-64 characters, each a letter, digit, space, ' or -

const MAX_TERM = 64;
const WS = '[ \\t\\n\\r\\f\\v\\u00a0]';
const EDGE = '[ \\t\\n\\r\\f\\v\\u00a0"\'`,.;:!?()\\[\\]{}<>«»…-]';
const EDGE_RE = new RegExp(`^${EDGE}+|${EDGE}+$`, 'g');
const WS_RE = new RegExp(`${WS}+`, 'g');
const VALID_RE = /^[\p{L}\p{Nd} '-]+$/u;

/** The cleaned term, or null when the selection is not a word/short phrase. */
function cleanTerm(s) {
  if (typeof s !== 'string') return null;
  const t = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(WS_RE, ' ')
    .replace(EDGE_RE, '');
  if (!t || [...t].length > MAX_TERM || !VALID_RE.test(t)) return null;
  return t;
}

module.exports = { cleanTerm, MAX_TERM };
