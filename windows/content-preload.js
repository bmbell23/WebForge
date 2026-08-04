// Injected into every content tab.
//
// #33 round 3: hotkey tabs are "sticky" — they must never navigate away from
// their bound site. Chasing navigation after the fact loses against SPA
// routers (Gerrit's PolyGerrit pushes state without firing will-navigate, and
// bouncing it back just flickered). So intercept the CLICK instead, in the
// capture phase, before the page's own handlers see it: cancel the click and
// hand the href to main, which opens it in a new foreground tab.
const { contextBridge, ipcRenderer } = require('electron');

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
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
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

// #100: Ctrl+J opens the current selection through the URL rules. Read here
// because before-input-event in the main process is synchronous and cannot ask
// the page what is selected. Main stays silent when nothing matches.
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    if ((e.key || '').toLowerCase() !== 'j') return;
    const text = String(window.getSelection?.() || '');
    if (!text.trim()) return; // nothing selected: leave the key to the page
    e.preventDefault();
    ipcRenderer.send('open-text-rule', text);
  },
  true
);

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

function hintTargets() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(HINT_SELECTOR)) {
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
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) continue;
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

