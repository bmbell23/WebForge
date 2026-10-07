// #235: Mattermost's pop-out pages (/_popout/…) get their state from the
// window that opened them. After a restart there is no opener, so a restored
// pop-out tab never loads. Restore it as the ordinary page it showed instead.
// Electron-free, tested in popout.test.js.

/**
 * The normal page behind a Mattermost pop-out URL, or the URL unchanged.
 *   /_popout/channel/<team>/channels/<ch>  →  /<team>/channels/<ch>
 *   /_popout/channel/<team>/messages/@<u>  →  /<team>/messages/@<u>
 *   /_popout/thread/<team>/<postId>        →  /<team>/pl/<postId>
 *   any other /_popout/…                   →  the site's root
 */
function unpopout(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return url;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.pathname.startsWith('/_popout/')) return url;
  const parts = u.pathname.split('/').filter(Boolean).slice(1); // drop "_popout"
  const [kind, team, ...rest] = parts;
  let path = '/';
  if (kind === 'channel' && team && rest.length) path = `/${team}/${rest.join('/')}`;
  else if (kind === 'thread' && team && rest.length === 1) path = `/${team}/pl/${rest[0]}`;
  return u.origin + path;
}

module.exports = { unpopout };
