// #203: your own adult-site list, on top of the built-in one in
// shared/ytdlp-sites.json. Stored as {added, removed}, synced through the sync
// service's `adult` key, so a new build never loses an edit. Android mirrors
// this in AdultList.kt; shared/adult-entry-fixtures.tsv pins normalize() for both.
// No Electron here.
'use strict';

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * What a typed or pasted entry means, or null if it means nothing.
 *   "https://www.Example.com/x?y" → "example.com"   (the site and its subdomains)
 *   "100.69.184.113:8005/login"   → "100.69.184.113:8005"  (one service)
 *   "*:18005"                     → "*:18005"       (that port on any host)
 */
function normalize(entry) {
  let s = String(entry == null ? '' : entry).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/[/?#].*$/, '');                // path, query, fragment
  s = s.replace(/^[^@]*@/, '');                 // user:pass@
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(s);
  let host = m[1].replace(/\.$/, '');
  const port = m[2];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
    if (host === '*') return `*:${n}`;
    if (!HOST.test(host)) return null;
    return `${host}:${n}`;
  }
  host = host.replace(/^www\./, '');
  if (!HOST.test(host) || (!host.includes('.') && host !== 'localhost')) return null;
  return host;
}

const isOrigin = (e) => /:\d+$/.test(e);

/** A clean {added, removed}: normalized, deduped, nothing in both. */
function clean(user) {
  const u = user && typeof user === 'object' ? user : {};
  const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).map(normalize).filter(Boolean))];
  const removed = uniq(u.removed);
  const added = uniq(u.added).filter((e) => !removed.includes(e));
  return { added, removed };
}

/** The list the matcher uses: built-in, minus what you turned off, plus what you added. */
function effective(base, user) {
  const { added, removed } = clean(user);
  const merge = (list, mine) => [...new Set([...(list || []).filter((e) => !removed.includes(e)), ...mine])];
  return {
    ...base,
    adult: merge(base.adult, added.filter((e) => !isOrigin(e))),
    adultOrigins: merge(base.adultOrigins, added.filter(isOrigin)),
  };
}

/** Built-in entries you can switch off (the words stay built-in). */
const builtins = (base) => [...(base.adult || []), ...(base.adultOrigins || [])];

module.exports = { normalize, clean, effective, builtins, isOrigin };
