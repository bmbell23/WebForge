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

/**
 * Build the fill script for one credential. Values are JSON-escaped, never
 * concatenated raw.
 *
 * `mayFillUsername` (#144) gates the username-only path. The caller allows it
 * once per navigation; afterwards the script still watches for a password field
 * but will not write a username again, so a framework that re-renders and wipes
 * the value cannot drive a refill loop.
 */
function fillScript(username, password, mayFillUsername = true) {
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
      const fill = (el, value) => {
        // #144: write through the NATIVE value setter. Assigning el.value
        // directly is invisible to React/Vue, which re-render from their own
        // state and wipe it — and then the retry schedule fills it again, which
        // is what turned one stray fill into the reported "spam".
        // No focus() here: #144 also stole the caret while the user was typing
        // somewhere else. Autofill must never move focus.
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };

      // The username field beside a password field can be loose about its type —
      // the password next to it is the evidence that this is a login form.
      const userBesidePassword = (el) =>
        el.type === 'email' || el.type === 'text' || el.autocomplete === 'username';

      // #144: with NO password field on the page there is no such evidence, so
      // the bar is much higher. \`type="text"\` used to qualify here, which meant
      // "type the username into the first text box on the page" — search boxes,
      // comment boxes, chat composers. Nothing but an explicit username signal
      // counts now.
      const LOGINISH = /(^|[^a-z])(user(name)?|email|e-mail|login|logon|account|identifier)([^a-z]|$)/i;
      const stronglyUsername = (el) => {
        if (el.autocomplete === 'username' || el.autocomplete === 'email') return true;
        if (el.type === 'email') return true;
        if (el.type !== 'text') return false;
        return [el.name, el.id, el.placeholder, el.getAttribute('aria-label')]
          .some((v) => v && LOGINISH.test(v));
      };

      const pw = inputs.find((el) => el.type === 'password' && visible(el));

      if (!pw) {
        // Two-step logins show the username first and the password only on the
        // next screen. Report 'user' so the caller keeps watching for the
        // password step rather than declaring victory — but the caller fills a
        // username at most ONCE per navigation (#144), so a framework wiping the
        // value can no longer drive a refill loop.
        if (!${JSON.stringify(Boolean(mayFillUsername))}) return false;
        const candidate = inputs.find((el) => stronglyUsername(el) && visible(el));
        if (candidate && !candidate.value && ${JSON.stringify(Boolean(username))}) {
          fill(candidate, ${JSON.stringify(username)});
          return 'user';
        }
        return false;
      }

      if (pw.value) return false; // already filled, by us or by the user

      // #144 round 2: find the username field BESIDE this password field, not
      // the first text box on the page. The pre-#136 code scoped this to
      // \`pw.form\`; the #136 rewrite dropped that and searched the whole
      // document, so on any page carrying both a site-wide search box and a
      // password field — a GitHub Enterprise settings or sudo page, for
      // instance — the header search box got the username and the real field
      // stayed empty. Reproduced exactly before fixing.
      const near = (() => {
        // A form is the authoritative grouping when there is one. Otherwise walk
        // up a BOUNDED number of ancestors: enough to escape the field's own
        // wrapper divs, never so far as to reach the whole page again.
        const scopes = [];
        if (pw.form) scopes.push(pw.form);
        let node = pw.parentElement;
        for (let i = 0; node && i < 5; i++, node = node.parentElement) scopes.push(node);
        for (const scope of scopes) {
          const found = inputs.filter(
            (el) => el !== pw && scope.contains(el) && userBesidePassword(el) && visible(el)
          );
          if (!found.length) continue;
          // Prefer the last candidate ABOVE the password — login forms read
          // username-then-password — falling back to the first one below it.
          const before = found.filter(
            (el) => pw.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING
          );
          return before.length ? before[before.length - 1] : found[0];
        }
        return null;
      })();
      if (near && !near.value) fill(near, ${JSON.stringify(username)});
      fill(pw, ${JSON.stringify(password)});
      return 'filled';
    })()`;
}

module.exports = { fillScript };
