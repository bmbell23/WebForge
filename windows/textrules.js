// #100: selected text -> URL rules. Highlight `SFAP-107190`, hit Ctrl+J or use
// the context menu, land on the Jira ticket.
//
// Built as a general rule set rather than a Jira special case (user decision):
// each rule is a `pattern` (a regular expression, as a string) and a `template`
// with `$0` for the whole match and `$1`..`$9` for capture groups. The Jira rule
// ships as the default; GitHub issues or anything else are then a table row
// rather than a code change.
//
// Deliberately free of Electron so it can be unit-tested with plain `node` —
// this session repeatedly shipped bugs that were only visible by running the app
// on Windows, which the build host does not have.

// Long selections are pointless to scan and are the easy way to make a
// user-written regex behave pathologically. A key is short; a paragraph is not.
const MAX_SELECTION = 512;

const DEFAULT_RULES = [
  {
    name: 'Jira',
    pattern: '[A-Z][A-Z0-9]+-\\d+',
    template: 'https://ime-ddn.atlassian.net/browse/$0',
  },
];

/**
 * Trim whitespace and the punctuation that a double-click or a sloppy drag drags
 * along, so `SFAP-107190.` or `(SFAP-107190)` still resolve.
 */
function normalizeSelection(text) {
  if (typeof text !== 'string') return '';
  return text
    .slice(0, MAX_SELECTION)
    .trim()
    .replace(/^["'([{<.,;:!?]+/, '')
    .replace(/["')\]}>.,;:!?]+$/, '');
}

// Compiling the same pattern on every keystroke is wasteful, and an invalid
// pattern must not throw — a typo in one rule cannot be allowed to break the
// feature for every other rule.
const cache = new Map();
function compile(pattern) {
  if (cache.has(pattern)) return cache.get(pattern);
  let re = null;
  try {
    re = new RegExp(pattern, 'i'); // case-insensitive: `sfap-1` should work too
  } catch {
    re = null; // invalid rule — skipped, not fatal
  }
  cache.set(pattern, re);
  return re;
}

/**
 * Substitute `$0` (whole match) and `$1`..`$9` (groups) into the template.
 *
 * Values are URL-encoded. For a ticket key that changes nothing, and for
 * anything with spaces or `&` it is the difference between a working URL and a
 * broken one. The trade-off: a capture intended to span path segments will have
 * its slashes encoded.
 */
function expand(template, match) {
  return String(template).replace(/\$([0-9])/g, (whole, digit) => {
    const value = match[Number(digit)];
    return value === undefined ? whole : encodeURIComponent(value);
  });
}

/**
 * First matching rule wins, in list order. Returns { url, rule, matched } or
 * null when nothing matches — callers use null to stay completely inert rather
 * than navigating somewhere useless.
 */
function resolve(text, rules) {
  const cleaned = normalizeSelection(text);
  if (!cleaned) return null;
  const list = Array.isArray(rules) && rules.length ? rules : DEFAULT_RULES;
  for (const rule of list) {
    if (!rule || !rule.pattern || !rule.template) continue;
    const re = compile(rule.pattern);
    if (!re) continue;
    const match = re.exec(cleaned);
    if (!match) continue;
    return { url: expand(rule.template, match), rule, matched: match[0] };
  }
  return null;
}

module.exports = { DEFAULT_RULES, MAX_SELECTION, normalizeSelection, resolve };
