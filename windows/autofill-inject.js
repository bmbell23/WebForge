// #136: the script injected into a page to fill a login form.
//
// Lives in its own module for one reason: it is the half of autofill that a
// node unit test cannot reach (it needs a real DOM), so it is verified instead
// by scripts/autofill-dom-check.js, which loads synthetic login pages in a real
// Chromium and asserts the outcomes. Keeping the source in one exported
// function is what lets the harness run EXACTLY what ships, rather than a
// copy that can drift.
//
// Returns from the injected code:
//   'filled' — username (if any) and password are in; we are done
//   'user'   — a two-step login: username in, password field not on screen yet
//   false    — nothing to do here (no visible form, or already filled)

/** Build the fill script for one credential. Values are JSON-escaped, never concatenated raw. */
function fillScript(username, password) {
  return `(() => {
      // #129 lesson, again: querySelector cannot see into shadow roots, and the
      // sites that need autofill most (SSO portals, web-component apps) put the
      // form inside one. Walk open roots the way the Ctrl+S hint collector does.
      const inputs = [];
      const walk = (root, depth) => {
        if (!root || depth > 12) return;
        for (const el of root.querySelectorAll('input')) {
          inputs.push(el);
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        }
      };
      walk(document, 0);

      // A field nobody can see is not the login form. Pages routinely carry a
      // hidden dummy password input (anti-autofill, or a leftover); filling it
      // would look like success and stop us retrying for the real one.
      const visible = (el) => {
        if (el.disabled || el.readOnly) return false;
        // checkVisibility catches what computed style alone misses:
        // content-visibility, and ancestors that are display:none.
        if (el.checkVisibility && !el.checkVisibility()) return false;
        const r = el.getBoundingClientRect();
        // NOT "> 0": a field styled width:0;height:0 still measures a few px of
        // border, which is how a decoy slipped through the first run of
        // scripts/autofill-dom-check.js. A password box a human can actually
        // type into is far bigger than this floor; real ones are ~150x30.
        if (r.width < 24 || r.height < 8) return false;
        // The classic off-screen hiding trick (left:-9999px). Deliberately not
        // "must be in the viewport" — a legitimate form can sit below the fold.
        if (r.right < 0 || r.bottom < 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
      };
      const fire = (el) => {
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const userish = (el) =>
        el.type === 'email' || el.type === 'text' || el.autocomplete === 'username';

      const pw = inputs.find((el) => el.type === 'password' && visible(el));
      const user = inputs.find((el) => userish(el) && visible(el));

      // Two-step logins show the username first and the password only on the
      // next screen. Fill what exists, and report 'user' so the caller keeps
      // watching for the password step rather than declaring victory.
      if (!pw) {
        if (user && !user.value && ${JSON.stringify(Boolean(username))}) {
          user.value = ${JSON.stringify(username)}; fire(user);
          return 'user';
        }
        return false;
      }
      if (pw.value) return false; // already filled, by us or by the user
      if (user && !user.value) { user.value = ${JSON.stringify(username)}; fire(user); }
      pw.value = ${JSON.stringify(password)}; fire(pw);
      return 'filled';
    })()`;
}

module.exports = { fillScript };
