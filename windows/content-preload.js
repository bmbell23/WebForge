// Injected into every content tab.
//
// #33 round 3: hotkey tabs are "sticky" — they must never navigate away from
// their bound site. Chasing navigation after the fact loses against SPA
// routers (Gerrit's PolyGerrit pushes state without firing will-navigate, and
// bouncing it back just flickered). So intercept the CLICK instead, in the
// capture phase, before the page's own handlers see it: cancel the click and
// hand the href to main, which opens it in a new foreground tab.
const { ipcRenderer } = require('electron');

let sticky = false;
ipcRenderer.on('sticky-mode', (_e, on) => {
  sticky = Boolean(on);
});

document.addEventListener(
  'click',
  (e) => {
    if (!sticky || e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target?.closest?.('a[href]');
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
