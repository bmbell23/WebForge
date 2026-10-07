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
// #280: `hidden` targets are left out of Frequent and ssh config, never Favorites.
function connectionGroups({ favorites = [], uses = {}, configHosts: cfg = [], names = {}, hidden = [] } = {}) {
  const gone = new Set(hidden);
  const seen = new Set(favorites);
  // #241: a Favorite also hides the bare host it was made from (an edited
  // ssh-config "pve01" saved as "root@pve01" shouldn't show twice).
  for (const f of favorites) {
    const h = splitTarget(f)?.host;
    if (h) seen.add(h);
  }
  const frequent = rankFrequent(uses).filter((t) => !seen.has(t) && !gone.has(t));
  for (const t of frequent) seen.add(t);
  return {
    favorites: [...favorites],
    frequent,
    config: cfg.filter((t) => !seen.has(t) && !gone.has(t)),
    names: Object.fromEntries(favorites.filter((t) => names[t]).map((t) => [t, names[t]])), // #228
  };
}

// A target typed by hand: user@host, host:port, [v6]:port. Nothing else.
function validTarget(s) {
  return /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(String(s || '').trim());
}

// #228: a target as its parts. user and port are null when absent; an IPv6
// host comes back without its brackets.
function splitTarget(t) {
  const m = /^(?:([^@]+)@)?(\[[^\]]*\]|[^:]+)(?::(\d+))?$/.exec(String(t || '').trim());
  if (!m) return { user: null, host: '', port: null };
  return {
    user: m[1] || null,
    host: m[2].replace(/^\[(.*)\]$/, '$1'),
    port: m[3] ? Number(m[3]) : null,
  };
}

// #228: the parts back into a target, or null if it would not be valid. An IPv6
// host is always bracketed (validTarget has no other form for it).
function joinTarget({ user, host, port } = {}) {
  const h = String(host || '').trim();
  const u = String(user || '').trim();
  if (!h) return null;
  let p = null;
  if (port !== null && port !== undefined && String(port).trim() !== '') {
    p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  }
  const t = (u ? u + '@' : '') + (h.includes(':') ? `[${h.replace(/^\[|\]$/g, '')}]` : h) + (p ? ':' + p : '');
  return validTarget(t) ? t : null;
}

// #228: edit a Favorite in place. Pure: returns new hosts, never touches the input.
function renameFavorite(hosts, oldTarget, { name, user, host, port } = {}) {
  const favorites = (hosts && hosts.favorites) || [];
  const at = favorites.indexOf(oldTarget);
  if (at < 0) return { ok: false, error: 'That favorite no longer exists.' };
  const target = joinTarget({ user, host, port });
  if (!target) return { ok: false, error: 'Enter a valid host, user and port (1-65535).' };
  if (target !== oldTarget && favorites.includes(target)) return { ok: false, error: `${target} is already a favorite.` };
  const uses = { ...(hosts.uses || {}) };
  const names = { ...(hosts.names || {}) };
  if (target !== oldTarget) {
    if (oldTarget in uses) {
      uses[target] = (uses[target] || 0) + uses[oldTarget];
      delete uses[oldTarget];
    }
    delete names[oldTarget];
  }
  const label = String(name || '').trim();
  if (label && label !== target) names[target] = label;
  else delete names[target];
  const next = [...favorites];
  next[at] = target;
  return { ok: true, hosts: { ...hosts, favorites: next, uses, names }, target };
}

// #280: remove a connection from one group. Pure: returns new hosts, never
// touches the input. 'favorites' forgets the star, name and use count;
// 'frequent' forgets the use count; 'config' hides the ssh-config host.
function removeConnection(hosts, target, group) {
  const h = hosts || {};
  const uses = { ...(h.uses || {}) };
  const names = { ...(h.names || {}) };
  let favorites = [...(h.favorites || [])];
  let hidden = [...(h.hidden || [])];
  if (group === 'favorites') {
    favorites = favorites.filter((f) => f !== target);
    delete names[target];
    delete uses[target];
  } else if (group === 'frequent') {
    delete uses[target];
  } else if (group === 'config') {
    if (!hidden.includes(target)) hidden.push(target);
  }
  return { ...h, favorites, uses, names, hidden };
}

module.exports = { parseSshConfig, configHosts, resolveHost, rankFrequent, connectionGroups, validTarget, splitTarget, joinTarget, renameFavorite, removeConnection };
