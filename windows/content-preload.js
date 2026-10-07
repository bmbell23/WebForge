// Injected into every content tab.
//
// #33 round 3: hotkey tabs are "sticky" — they must never navigate away from
// their bound site. Chasing navigation after the fact loses against SPA
// routers (Gerrit's PolyGerrit pushes state without firing will-navigate, and
// bouncing it back just flickered). So intercept the CLICK instead, in the
// capture phase, before the page's own handlers see it: cancel the click and
// hand the href to main, which opens it in a new foreground tab.
const { contextBridge, ipcRenderer } = require('electron');

// #150-modifier-copy-start
// Which physical modifier means "WebForge": Ctrl on Windows/Linux, ⌘ on macOS —
// where Control is a DIFFERENT key that must not fire our chords, and on Windows
// the Meta (Windows) key must not either. A copy of modifier.js's isChordExact,
// because a sandboxed preload cannot require a local file (proved in #150; the
// same reason installGuardedKeys is duplicated). modifier.test.js pins all three
// copies to the module and to each other — edit them together or it goes red.
const appChord = (e) => {
  const mac = process.platform === 'darwin';
  const primary = mac ? e.metaKey : e.ctrlKey;
  const foreign = mac ? e.ctrlKey : e.metaKey;
  return !!primary && !foreign && !e.altKey && !e.shiftKey;
};
// #150-modifier-copy-end

// #112: the interstitials (#108) are loaded INTO an existing content tab, and a
// tab's preload is fixed at creation from its first URL — so a tab opened on
// https:// keeps THIS preload when it is navigated to certerror.html. The pages
// were calling a `wf` bridge that therefore did not exist: nothing rendered and
// Proceed did nothing.
//
// So expose a bridge here — but a deliberately tiny one, and only for our own
// interstitial documents. Web content must never receive the full privileged
// internal-preload API (#40); that is the whole reason two preloads exist.
// Gating on a file:// URL is sound because web pages cannot navigate themselves
// to file://, so a real site can never reach this branch.
const INTERSTITIALS = ['certerror.html', 'neterror.html'];
const isInterstitial =
  location.protocol === 'file:' &&
  INTERSTITIALS.some((name) => location.pathname.endsWith(`/ui/${name}`));

if (isInterstitial) {
  contextBridge.exposeInMainWorld('wf', {
    certDetails: () => ipcRenderer.invoke('int:cert-details'),
    certProceed: () => ipcRenderer.invoke('int:cert-proceed'),
    certBack: () => ipcRenderer.invoke('int:cert-back'),
    netDetails: () => ipcRenderer.invoke('int:net-details'),
    netRetry: () => ipcRenderer.invoke('int:net-retry'),
  });
}

// #115/#109: keys that belong to the app ONLY when you are not typing.
//
// Ctrl+X is Cut and Ctrl+S is Save — claiming either outright would break them in
// every text field on every site. That is the mistake #38 made with
// Ctrl+Shift+Arrow, which #101 had to reverse.
//
// The decision is made HERE rather than in the main process on reported focus
// state: main would always be a round-trip behind, and a stale report would eat a
// Cut. At keydown the renderer knows exactly what is focused, so nothing can go
// stale.
//
// Duplicated across the three preloads rather than shared: Electron sandboxes
// renderers by default, and a sandboxed preload can only require `electron` and a
// couple of node built-ins — never a local file. closekey.test.js asserts the
// three copies stay byte-identical.
function installGuardedKeys(handlers) {
  const editable = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    // Buttons and checkboxes are inputs too, but nobody cuts text from them.
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(
      (el.type || 'text').toLowerCase()
    );
  };
  window.addEventListener(
    'keydown',
    (e) => {
      if (!appChord(e)) return; // #150
      const handler = handlers[(e.key || '').toLowerCase()];
      if (!handler) return;
      // composedPath()[0] sees INTO shadow roots, where e.target is retargeted
      // to the host — the same trap the sticky-click handler hit (#33).
      const focused = e.composedPath?.()[0] || document.activeElement;
      if (editable(focused) || editable(document.activeElement)) return; // let the page have it
      e.preventDefault();
      handler();
    },
    true
  );
}

// #109: Ctrl+S starts hinting; Ctrl+X closes the tab. Both yield to typing.
installGuardedKeys({
  x: () => ipcRenderer.send('close-active-tab'),
  s: hintsStart,
});

// #243: Esc takes focus out of a text field, so the keys above (and the site's
// own shortcuts) work again. The page goes first: if it used the Esc itself
// (preventDefault, e.g. closing an autocomplete or a dialog), focus stays put,
// but a second Esc within a second always leaves the field. Checked after the
// event has finished dispatching, so every page listener still gets its say.
let lastEsc = 0;
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
  const now = Date.now();
  const again = now - lastEsc < 1000;
  lastEsc = now;
  setTimeout(() => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return;
    const tag = el.tagName;
    const field =
      el.isContentEditable ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (tag === 'INPUT' &&
        !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(
          (el.type || 'text').toLowerCase()
        ));
    if (!field) return;
    if (e.defaultPrevented && !again) return; // the page's Esc; the next one is ours
    el.blur();
  }, 0);
}, true); // capture: a site that stops the event's propagation can't hide it from us

// #247: Ctrl+Shift+Up/Down step through the Persona's tabs, like Ctrl+PageUp/
// PageDown. In a text field the chord stays the field's (paragraph selection,
// the #38/#101 lesson); Esc (#243) gets you out of the field first.
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    let el = e.composedPath?.()[0] || document.activeElement;
    if (el === document.body) el = null;
    const tag = el && el.tagName;
    const field =
      el &&
      (el.isContentEditable ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (tag === 'INPUT' &&
          !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(
            (el.type || 'text').toLowerCase()
          )));
    if (field) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('cycle-tab', e.key === 'ArrowDown' ? 1 : -1);
  },
  true
);

// #100: Ctrl+J opens the current selection through the URL rules. Read here
// because before-input-event in the main process is synchronous and cannot ask
// the page what is selected. Main stays silent when nothing matches.
window.addEventListener(
  'keydown',
  (e) => {
    if (!appChord(e)) return; // #150
    if ((e.key || '').toLowerCase() !== 'j') return;
    const text = String(window.getSelection?.() || '');
    if (!text.trim()) return; // nothing selected: leave the key to the page
    e.preventDefault();
    ipcRenderer.send('open-text-rule', text);
  },
  true
);

// #145: watch a login being submitted so main can offer to save or update it.
//
// This only ever REPORTS what was typed; it never stores anything and never
// decides anything. Main compares it with the vault (credsave.js) and asks you
// first — a store that updated itself would be a new way to lose a working
// password.
//
// Runs in the page, because a form submission is a DOM event that the main
// process cannot see. Shadow roots are walked for the same reason autofill
// walks them (#129): SSO portals put their forms inside one.
(() => {
  const passwordFields = (root, depth, out) => {
    if (!root || depth > 12) return out;
    for (const el of root.querySelectorAll('input')) {
      if (el.type === 'password') out.push(el);
      if (el.shadowRoot) passwordFields(el.shadowRoot, depth + 1, out);
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) passwordFields(el.shadowRoot, depth + 1, out);
    }
    return out;
  };

  // The username that goes WITH a password field — the same "beside it, not the
  // first box on the page" rule autofill had to learn the hard way (#144).
  const usernameFor = (pw) => {
    const userish = (el) =>
      el.type === 'email' || el.type === 'text' || el.autocomplete === 'username';
    const scopes = [];
    if (pw.form) scopes.push(pw.form);
    let node = pw.parentElement;
    for (let i = 0; node && i < 5; i++, node = node.parentElement) scopes.push(node);
    for (const scope of scopes) {
      const found = Array.from(scope.querySelectorAll('input')).filter(
        (el) => el !== pw && userish(el) && el.value
      );
      if (!found.length) continue;
      const before = found.filter(
        (el) => pw.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING
      );
      return (before.length ? before[before.length - 1] : found[0]).value;
    }
    return '';
  };

  const report = () => {
    const pw = passwordFields(document, 0, []).find((el) => el.value);
    if (!pw) return;
    ipcRenderer.send('login-submitted', {
      origin: location.origin,
      username: usernameFor(pw),
      password: pw.value,
    });
  };

  // A real submit is the clearest signal.
  window.addEventListener('submit', report, true);

  // ...but plenty of sign-in forms are buttons and fetch(), never submitting.
  // A click on anything that looks like the submit control is the fallback.
  // Deliberately generous: main discards anything that turns out not to be a
  // login, and the cost of missing a real one is the feature silently not
  // working — the failure the user reported in the first place.
  window.addEventListener(
    'click',
    (e) => {
      const el = e.target && e.target.closest && e.target.closest('button, input[type=submit], [role=button]');
      if (el) setTimeout(report, 0); // after the page's own handler reads the field
    },
    true
  );

  // Enter inside a password field submits on most sign-in forms.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target && e.target.type === 'password') setTimeout(report, 0);
    },
    true
  );
})();

let sticky = false;
ipcRenderer.on('sticky-mode', (_e, on) => {
  sticky = Boolean(on);
});

document.addEventListener(
  'click',
  (e) => {
    if (!sticky || e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // Gerrit (PolyGerrit) and other web-component apps put their links inside
    // shadow roots, so e.target is retargeted to the shadow HOST and
    // closest('a') finds nothing — which is why interception silently missed.
    // composedPath() walks INTO the shadow trees.
    const a =
      e.composedPath?.().find((n) => n?.tagName === 'A' && n.getAttribute?.('href')) ||
      e.target?.closest?.('a[href]');
    if (!a) return;
    const href = a.href;
    // Same-page anchors and script hrefs aren't navigation — leave them be.
    if (!href || !/^https?:/i.test(href)) return;
    if (href.split('#')[0] === location.href.split('#')[0]) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('open-in-new-tab', href);
  },
  true
);

// --- #109: keyboard link hints ------------------------------------------------
//
// Ctrl+S labels every clickable thing in view; typing a label activates it.
// The point is browsing without reaching for the mouse.
//
// Ctrl+S rather than the Ctrl+Space leader (the original #109 decision): one
// keystroke, at the cost of sharing a key with Save — which the guard above
// hands back whenever you are actually typing.
//
// Runs ONLY in the top document (v1 scope): content-preload is injected into
// subframes too, and each cross-origin frame would need its own label namespace
// to avoid two elements answering to the same key.
//
// Labels live in a CLOSED shadow root so page CSS cannot restyle, hide or
// displace them — a page that styles `div {display:none}` must not be able to
// blind the feature.
const HINT_ALPHABET = 'asdfghjkl;'.split(''); // home row, no reaching

/**
 * One label per target, all the SAME length — which is what guarantees no label
 * is a prefix of another. A prefix would be untypeable: you could never finish
 * "a" without "as" also matching.
 *
 * Length grows with the count, so a dense page still gets full coverage. Two
 * characters cover 100 targets, three cover 1000; capping at two would have left
 * anything past the hundredth element silently unlabelled — caught by
 * hints.test.js before it shipped.
 */
function hintLabels(count) {
  const a = HINT_ALPHABET;
  if (count <= 0) return [];
  let len = 1;
  while (Math.pow(a.length, len) < count) len += 1;
  const out = [];
  const build = (prefix) => {
    if (out.length >= count) return;
    if (prefix.length === len) {
      out.push(prefix);
      return;
    }
    for (const c of a) {
      build(prefix + c);
      if (out.length >= count) return;
    }
  };
  build('');
  return out;
}

const HINT_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
  '[role=button]', '[role=link]', '[role=checkbox]', '[role=tab]', '[role=menuitem]',
  '[onclick]', '[contenteditable=""]', '[contenteditable=true]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Every hintable element, INCLUDING those inside open shadow roots.
 *
 * #129: `document.querySelectorAll` stops at shadow boundaries, so on a
 * web-component app (Gerrit's PolyGerrit and friends) every link lives somewhere
 * this could not see and hinting silently found nothing. #33 learned the same
 * lesson for click interception; the collector repeated it.
 *
 * Closed shadow roots remain unreachable — nothing can see into those.
 */
function hintCollect(root, out) {
  for (const el of root.querySelectorAll('*')) {
    if (el.matches(HINT_SELECTOR)) out.push(el);
    if (el.shadowRoot) hintCollect(el.shadowRoot, out); // open roots only
  }
  return out;
}

/**
 * The deepest element actually painted at a point, piercing shadow boundaries.
 *
 * #129: `document.elementFromPoint` returns the shadow HOST, so comparing it to
 * an element inside that host fails in BOTH directions (neither `contains` the
 * other across the boundary) and every shadow target would be judged covered.
 */
function hintTopmostAt(x, y) {
  let hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const deeper = hit.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  return hit;
}

function hintTargets() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const seen = new Set();
  const out = [];
  for (const el of hintCollect(document, [])) {
    if (el.disabled || seen.has(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    // Hit-test the centre: a cookie banner or sticky header covering an element
    // must not earn it a label the user cannot actually click.
    const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const hit = hintTopmostAt(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      // Across a shadow boundary `contains` is false both ways, so also accept a
      // hit that shares this element's shadow root — it is the same widget.
      const sameRoot = el.getRootNode() === hit.getRootNode();
      if (!sameRoot) continue;
    }
    seen.add(el);
    out.push({ el, rect: r });
  }
  return out;
}

let hintSession = null;

function hintsCancel() {
  if (!hintSession) return;
  window.removeEventListener('keydown', hintSession.onKey, true);
  window.removeEventListener('scroll', hintSession.onScroll, true);
  window.removeEventListener('resize', hintSession.onScroll, true);
  hintSession.host.remove();
  hintSession = null;
}

function hintsPaint() {
  if (!hintSession) return;
  const { root } = hintSession;
  root.querySelectorAll('.h').forEach((n) => n.remove());
  hintSession.targets = hintTargets();
  hintSession.labels = hintLabels(hintSession.targets.length);
  hintSession.typed = '';
  hintSession.targets.forEach((t, i) => {
    const tag = document.createElement('div');
    tag.className = 'h';
    tag.dataset.label = hintSession.labels[i];
    tag.textContent = hintSession.labels[i].toUpperCase();
    tag.style.left = `${Math.max(0, t.rect.left)}px`;
    tag.style.top = `${Math.max(0, t.rect.top)}px`;
    root.appendChild(tag);
  });
}

function hintsActivate(el) {
  const tag = el.tagName;
  // Typing targets take focus; everything else is a click.
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
    el.focus();
  } else {
    el.click();
  }
}

function hintsStart() {
  if (window.top !== window) return; // v1: top document only
  hintsCancel();
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent =
    '.h{position:fixed;transform:translate(-2px,-2px);background:#ffd54a;color:#111;' +
    'font:700 11px/1.1 ui-monospace,monospace;padding:2px 4px;border-radius:3px;' +
    'border:1px solid #a9822a;box-shadow:0 1px 3px rgba(0,0,0,.5);pointer-events:none}' +
    '.h.dim{opacity:.25}';
  root.appendChild(style);
  document.documentElement.appendChild(host);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hintsCancel(); return; }
    const ch = (e.key || '').toLowerCase();
    if (ch.length !== 1 || !HINT_ALPHABET.includes(ch)) {
      // Any key outside the alphabet ends hinting rather than swallowing it.
      hintsCancel();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    hintSession.typed += ch;
    const typed = hintSession.typed;
    const exact = hintSession.labels.indexOf(typed);
    if (exact >= 0) {
      const target = hintSession.targets[exact].el;
      hintsCancel();
      hintsActivate(target);
      return;
    }
    let any = false;
    for (const tag of root.querySelectorAll('.h')) {
      const match = tag.dataset.label.startsWith(typed);
      tag.classList.toggle('dim', !match);
      any = any || match;
    }
    if (!any) hintsCancel(); // nothing can match — stop pretending
  };
  const onScroll = () => {
    if (!hintSession) return;
    cancelAnimationFrame(hintSession.raf || 0);
    hintSession.raf = requestAnimationFrame(hintsPaint); // labels must not drift
  };

  hintSession = { host, root, onKey, onScroll, typed: '', targets: [], labels: [] };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);
  hintsPaint();
  if (!hintSession.targets.length) hintsCancel(); // nothing to label
}

// #128: hide the cursor while typing, and when the mouse sits still.
//
// A stylesheet rather than `documentElement.style.cursor`: every link and button
// sets its own cursor and would win the cascade, so the pointer would keep
// reappearing over exactly the things you are reading past.
//
// Installed in ALL THREE preloads — the cursor belongs to whichever view it is
// over (page, app chrome, internal pages), and hiding in only one means it pops
// back the instant it crosses a boundary. Duplicated for the same reason as
// installGuardedKeys: a sandboxed preload cannot require a local file, and
// closekey.test.js asserts the copies stay identical.
function installCursorHiding(idleMs) {
  let styleEl = null;
  let hidden = false;
  let timer = null;

  const ensureStyle = () => {
    if (styleEl && styleEl.isConnected) return styleEl;
    const parent = document.head || document.documentElement;
    if (!parent) return null; // too early — the next event will retry
    styleEl = document.createElement('style');
    styleEl.textContent = '*,*::before,*::after{cursor:none !important}';
    styleEl.disabled = true;
    parent.appendChild(styleEl);
    return styleEl;
  };

  const hide = () => {
    if (hidden) return;
    const el = ensureStyle();
    if (!el) return;
    el.disabled = false;
    hidden = true;
  };

  const show = () => {
    clearTimeout(timer);
    timer = setTimeout(hide, idleMs); // still => hidden again
    if (!hidden) return;
    if (styleEl) styleEl.disabled = true;
    hidden = false;
  };

  // Typing and keybinds hide it at once; anything the MOUSE does brings it back.
  window.addEventListener('keydown', hide, true);
  for (const ev of ['mousemove', 'mousedown', 'wheel']) {
    window.addEventListener(ev, show, true);
  }
  timer = setTimeout(hide, idleMs);
}

installCursorHiding(3000);
