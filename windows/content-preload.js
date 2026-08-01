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

// #115: Ctrl+X closes the tab — but ONLY when you are not typing, because
// Ctrl+X is Cut and claiming it outright would break cut in every text field on
// every site. That is precisely the mistake #38 made with Ctrl+Shift+Arrow,
// which #101 had to reverse.
//
// The decision is made HERE rather than in the main process on reported focus
// state: main would always be a round-trip behind, and a stale report would eat
// a Cut. At keydown the renderer knows exactly what is focused, so nothing can
// go stale.
//
// Duplicated across the three preloads rather than shared: Electron
// sandboxes renderers by default, and a sandboxed preload can only require
// `electron` and a couple of node built-ins — never a local file.
function installCloseTabKey(send) {
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
      if ((e.key || '').toLowerCase() !== 'x') return;
      // composedPath()[0] sees INTO shadow roots, where e.target is retargeted
      // to the host — the same trap the sticky-click handler below hit (#33).
      const focused = e.composedPath?.()[0] || document.activeElement;
      if (editable(focused) || editable(document.activeElement)) return; // let Cut happen
      e.preventDefault();
      send();
    },
    true
  );
}

installCloseTabKey(() => ipcRenderer.send('close-active-tab'));

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
