// #136: deciding WHICH saved login belongs to the page you are looking at.
//
// This used to be `c.origin === origin` — exact string equality — so a login
// saved as https://www.chase.com could never fill on chase.com or
// secure.chase.com. Real sign-in flows hop subdomains constantly, so most
// entries could never match anything.
//
// Three tiers, best first:
//   ORIGIN  scheme + host + port identical            https://a.com → https://a.com
//   HOST    same hostname, scheme may be upgraded     http://a.com  → https://a.com
//   DOMAIN  same registrable domain                   www.a.com     → login.a.com
//
// Electron-free so the rules are unit-testable (credmatch.test.js) — the house
// pattern, and it matters more here than usual: every bug in this file is
// either "my password never fills" or "my password was typed into the wrong
// site", and the second one is a security incident.

// A registrable domain is NOT simply "the last two labels". Under that rule
// barclays.co.uk and hsbc.co.uk both reduce to co.uk and would fill each
// other's forms. These are the multi-label public suffixes common enough to
// matter; the list is deliberately conservative, because a suffix we FAIL to
// list only costs a missed fill, while a wrong fold leaks a password across
// unrelated sites. (Not the full Public Suffix List — see shouldFold below.)
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 're.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in',
  'co.za', 'org.za', 'net.za',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw', 'com.my',
  'com.ph', 'com.vn', 'com.pk', 'com.sa', 'com.eg', 'com.ng', 'com.co',
  'com.pe', 'com.uy', 'com.ec', 've.com', 'com.ua', 'net.ua', 'org.ua',
  'com.pl', 'net.pl', 'org.pl', 'com.ru', 'net.ru', 'org.ru',
  'co.id', 'or.id', 'web.id', 'co.th', 'in.th', 'com.gr', 'com.pt',
]);

const TIER = { ORIGIN: 0, HOST: 1, DOMAIN: 2 };
const TIER_NAME = ['origin', 'host', 'domain'];

const normHost = (h) => String(h || '').toLowerCase().replace(/\.$/, '');

/** Bare IPv4/IPv6 — these have no domain hierarchy to walk up. */
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[.*\]$/.test(host);
}

/**
 * The registrable domain ("example.co.uk"), or null when folding to one would
 * be unsafe or meaningless — IPs, `localhost`, a bare public suffix, or a host
 * that IS already just a suffix. Null means: exact-host matching only.
 */
function baseDomain(host) {
  const h = normHost(host);
  if (!h || isIpLiteral(h)) return null;
  const labels = h.split('.').filter(Boolean);
  if (labels.length < 2) return null; // localhost, intranet single-label names
  const last2 = labels.slice(-2).join('.');
  if (MULTI_SUFFIXES.has(last2)) {
    // Need a third label to own anything under a two-part suffix.
    if (labels.length < 3) return null; // the host IS the suffix
    return labels.slice(-3).join('.');
  }
  return last2;
}

/** Tolerant parse: accepts a full URL, an origin, or a bare host. */
function parts(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    try {
      u = new URL(`https://${raw}`); // bare host, e.g. a hand-typed entry
    } catch {
      return null;
    }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return { scheme: u.protocol, host: normHost(u.hostname), port: u.port, origin: u.origin.toLowerCase() };
}

/**
 * Rank saved entries against the page URL. Returns [{ entry, tier, tierName }]
 * best-first; entries that must not fill here are absent, not ranked last.
 */
function matchFor(entries, url) {
  const page = parts(url);
  if (!page || !Array.isArray(entries)) return [];
  const pageBase = baseDomain(page.host);

  const out = [];
  for (const entry of entries) {
    const saved = parts(entry && entry.origin);
    if (!saved) continue;

    // Never carry a credential saved for https down onto a plaintext page: on
    // http the form post is readable by anyone on the path, and an attacker who
    // can serve http can force exactly this downgrade. The reverse (saved http,
    // page https) is an upgrade and is fine.
    const downgrade = saved.scheme === 'https:' && page.scheme === 'http:';

    let tier = null;
    if (saved.origin === page.origin) tier = TIER.ORIGIN;
    else if (saved.host === page.host && !downgrade) tier = TIER.HOST;
    else if (!downgrade && pageBase && baseDomain(saved.host) === pageBase) tier = TIER.DOMAIN;

    if (tier !== null) out.push({ entry, tier, tierName: TIER_NAME[tier] });
  }

  // Stable: equal tiers keep insertion order, so the store's own order breaks ties.
  return out.map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.tier - b.m.tier || a.i - b.i)
    .map(({ m }) => m);
}

/** The single entry to fill with, or null. */
function bestMatch(entries, url) {
  const [top] = matchFor(entries, url);
  return top ? top.entry : null;
}

module.exports = { matchFor, bestMatch, baseDomain, isIpLiteral, TIER, MULTI_SUFFIXES };
