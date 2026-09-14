// #145: what to do with a login we just watched the user submit.
//
// Deciding this wrongly is worse than not having the feature. Two entries for
// one account means autofill picks the stale one half the time; silently
// overwriting means a typo can destroy a working credential. So the decision is
// a pure function with tests, and main only carries out what it returns.
//
// Electron-free (house pattern), and it deliberately reuses credmatch so
// "which entry is this?" is answered the same way here as it is when filling —
// a second, subtly different matcher is exactly how the two halves drift apart.

const credmatch = require('./credmatch');

/**
 * @param {Array} entries  the saved credential store
 * @param {{origin: string, username: string, password: string}} submitted
 * @returns {{action: 'none'|'save'|'update'|'add', entry?: object, id?: string}}
 *   none   — already stored exactly; say nothing
 *   save   — nothing known for this site; offer to save
 *   update — same username, different password; offer to UPDATE that entry
 *   add    — site known but this username is new; offer to add alongside
 */
function decide(entries, submitted) {
  const origin = String(submitted?.origin || '').trim();
  const password = String(submitted?.password || '');
  // A blank password is not a login. Neither is a form we could not attribute
  // to a site — without an origin we cannot store it or match it later.
  if (!origin || !password) return { action: 'none' };
  const username = String(submitted?.username ?? '');

  const candidates = credmatch.matchFor(entries || [], origin).map((m) => m.entry);
  if (!candidates.length) return { action: 'save' };

  // Compare usernames case-insensitively: sites treat "BBell" and "bbell" as one
  // account, and storing both would put two entries behind one login.
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const existing = candidates.find((c) => same(c.username, username));

  if (!existing) return { action: 'add' };
  if (existing.password === password) return { action: 'none' }; // nothing changed
  return { action: 'update', entry: existing, id: existing.id };
}

/** Human wording for the prompt. "Update" must never read as "Save" (#145). */
function promptFor(decision, origin) {
  const site = (() => {
    try {
      return new URL(origin).hostname.replace(/^www\./, '');
    } catch {
      return origin;
    }
  })();
  switch (decision.action) {
    case 'save':
      return { title: `Save login for ${site}?`, confirm: 'Save' };
    case 'update':
      // Naming the account matters: with several logins for one site, "Update
      // password?" alone does not say WHICH one is about to change.
      return {
        title: `Update the saved password for ${decision.entry.username || site}?`,
        confirm: 'Update',
      };
    case 'add':
      return { title: `Save this additional login for ${site}?`, confirm: 'Save' };
    default:
      return null;
  }
}

module.exports = { decide, promptFor };
