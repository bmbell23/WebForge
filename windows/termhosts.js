// #214: the Terminal Persona's "bookmarks" — Favorites, Frequent and the hosts
// in ~/.ssh/config. Electron-free and unit-tested (termhosts.test.js); main.js
// owns the file they are saved in.

// ~/.ssh/config as a list of { patterns, opts } blocks, in file order.
// Keys are lower-cased; the FIRST value of a key wins, as in OpenSSH.
// Match blocks are skipped (we cannot evaluate them), Include is not followed.
function parseSshConfig(text) {
  const blocks = [{ patterns: ['*'], opts: {}, implicit: true }];
  let cur = blocks[0];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = { patterns: value.split(/\s+/).filter(Boolean), opts: {} };
      blocks.push(cur);
    } else if (key === 'match') {
      cur = { patterns: [], opts: {} }; // never applies
      blocks.push(cur);
    } else if (!(key in cur.opts)) {
      cur.opts[key] = value;
    }
  }
  return blocks;
}

function globMatches(pattern, name) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(name);
}

function blockApplies(block, name) {
  let hit = false;
  for (const p of block.patterns) {
    if (p.startsWith('!')) {
      if (globMatches(p.slice(1), name)) return false;
    } else if (globMatches(p, name)) {
      hit = true;
    }
  }
  return hit;
}

// The aliases you can actually pick: Host names without wildcards or negation.
function configHosts(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.implicit) continue;
    for (const p of b.patterns) {
      if (!/[*?!]/.test(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

// What OpenSSH would use for `alias`: HostName, User, Port, IdentityFile.
// Missing values are null; the caller fills in defaults.
function resolveHost(blocks, alias) {
  const opts = {};
  for (const b of blocks) {
    if (!blockApplies(b, alias)) continue;
    for (const [k, v] of Object.entries(b.opts)) if (!(k in opts)) opts[k] = v;
  }
  const port = Number(opts.port);
  return {
    host: opts.hostname ? opts.hostname.replace(/%h/g, alias) : alias,
    username: opts.user || null,
    port: Number.isInteger(port) && port > 0 ? port : null,
    identityFile: opts.identityfile || null,
  };
}

// Most-used first; ties break alphabetically so the list does not shuffle.
function rankFrequent(uses, limit = 8) {
  return Object.entries(uses || {})
    .filter(([t, n]) => t && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

// The three groups the panel and the new-tab picker show. A host appears in
// one group only: Favorites beat Frequent beat ssh config.
function connectionGroups({ favorites = [], uses = {}, configHosts: cfg = [] } = {}) {
  const seen = new Set(favorites);
  const frequent = rankFrequent(uses).filter((t) => !seen.has(t));
  for (const t of frequent) seen.add(t);
  return {
    favorites: [...favorites],
    frequent,
    config: cfg.filter((t) => !seen.has(t)),
  };
}

// A target typed by hand: user@host, host:port, [v6]:port. Nothing else.
function validTarget(s) {
  return /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(String(s || '').trim());
}

module.exports = { parseSshConfig, configHosts, resolveHost, rankFrequent, connectionGroups, validTarget };
