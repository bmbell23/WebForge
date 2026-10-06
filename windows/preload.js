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

// #150: the chrome UI (ui/index.html) is a plain page — it can neither require
// modifier.js nor see `process`, and it needs to build hotkey ids when you bind
// a key. So the id format lives here and crosses the bridge, keeping ONE copy
// rather than a second one in the HTML that would drift on macOS and silently
// stop matching main's. modifier.test.js pins these to the module too.
//
// "Ctrl+" is a storage format, not a physical key: these ids go to the vault and
// reconcile against Android through sync, so a Mac must store "Ctrl+K" for ⌘K.
const appKeyId = (e, key) => {
  const primary = process.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  return (primary ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (key || '');
};
// The OTHER platform's modifier — the Windows key on Windows, Control on macOS.
const appForeign = (e) => !!(process.platform === 'darwin' ? e.ctrlKey : e.metaKey);

contextBridge.exposeInMainWorld('webforge', {
  // A KeyboardEvent isn't serialisable across the bridge, so callers pass a
  // plain {ctrlKey, metaKey, altKey} object.
  keyId: (ev, key) => appKeyId(ev || {}, key),
  isForeignModifier: (ev) => appForeign(ev || {}),
  navigate: (input) => ipcRenderer.send('navigate', input),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  toggleReader: () => ipcRenderer.send('toggle-reader'), // #232
  goHome: () => ipcRenderer.send('go-home'), // #174
  openTerminal: () => ipcRenderer.send('open-terminal'), // #208
  // #214: the Terminal Persona's connections panel.
  openConnection: (target) => ipcRenderer.send('open-connection', target),
  favoriteConnection: (target) => ipcRenderer.send('favorite-connection', target),
  editConnection: (target, fields) => ipcRenderer.invoke('edit-connection', { target, fields }), // #228
  getConnections: () => ipcRenderer.send('get-connections'),
  onConnections: (cb) => ipcRenderer.on('terminal-connections', (_e, g) => cb(g)),
  // #126: ticket-key box — same channel Ctrl+J uses (#100).
  openTextRule: (text) => ipcRenderer.send('open-text-rule', text),
  // #127: direct-template quick boxes (Amazon). Reuses the channel
  // content-preload already uses for sticky-tab link diversion.
  openInNewTab: (url) => ipcRenderer.send('open-in-new-tab', url),
  // find in page (#101)
  findRun: (text, opts) => ipcRenderer.send('find-run', { text, ...opts }),
  findClose: () => ipcRenderer.send('find-close'),
  onFindBar: (cb) => ipcRenderer.on('find-bar', (_e, s) => cb(s)),
  onFindResult: (cb) => ipcRenderer.on('find-result', (_e, r) => cb(r)),
  stop: () => ipcRenderer.send('stop'),
  newTab: () => ipcRenderer.send('new-tab'),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  activateTab: (id) => ipcRenderer.send('activate-tab', id),
  togglePin: (id) => ipcRenderer.send('toggle-pin', id),
  closeTabs: (ids) => ipcRenderer.send('close-tabs', ids), // #46
  switchPersona: (id) => ipcRenderer.send('switch-persona', id), // #25
  onPersonas: (cb) => ipcRenderer.on('personas-updated', (_e, d) => cb(d)),
  onRemoteTabs: (cb) => ipcRenderer.on('remote-tabs', (_e, l) => cb(l)), // #57
  onTabsUpdated: (cb) => ipcRenderer.on('tabs-updated', (_e, state) => cb(state)),
  onFocusUrl: (cb) => ipcRenderer.on('focus-url', () => cb()),
  // #131: which chrome surface should take keyboard focus ('page' means release it).
  onFocusSurface: (cb) => ipcRenderer.on('focus-surface', (_e, s) => cb(s)),
  // bookmarks (#11)
  toggleStar: () => ipcRenderer.send('toggle-star'),
  toggleBookmarksPanel: () => ipcRenderer.send('toggle-bookmarks-panel'),
  openBookmark: (url, background) => ipcRenderer.send('open-bookmark', { url, background }),
  removeBookmark: (id) => ipcRenderer.send('remove-bookmark', id),
  moveBookmark: (id, folder) => ipcRenderer.send('move-bookmark', { id, folder }),
  importBookmarks: () => ipcRenderer.invoke('import-bookmarks'),
  importPasswords: () => ipcRenderer.send('import-passwords'), // #23
  // credentials manager (#26)
  togglePwPanel: () => ipcRenderer.send('toggle-pw-panel'),
  saveCred: (cred) => ipcRenderer.invoke('creds-save', cred),
  deleteCred: (id) => ipcRenderer.invoke('creds-delete', id),
  onPwPanel: (cb) => ipcRenderer.on('pw-panel', (_e, open) => cb(open)),
  onCredsUpdated: (cb) => ipcRenderer.on('creds-updated', (_e, list) => cb(list)),
  // #145: main asks whether to save/update a login it saw submitted.
  onLoginPrompt: (cb) => ipcRenderer.on('login-prompt', (_e, p) => cb(p)),
  answerLoginPrompt: (a) => ipcRenderer.send('login-prompt-answer', a),
  // #156: the download button, its picker, and the outcome notices.
  ytdlpOpen: () => ipcRenderer.send('ytdlp-open'),
  ytdlpAnswer: (a) => ipcRenderer.send('ytdlp-answer', a),
  onYtdlpPicker: (cb) => ipcRenderer.on('ytdlp-picker', (_e, p) => cb(p)),
  onOutfitPrompt: (cb) => ipcRenderer.on('outfit-prompt', (_e, p) => cb(p)), // #179
  outfitAnswer: (a) => ipcRenderer.send('outfit-answer', a),
  onYtdlpStatus: (cb) => ipcRenderer.on('ytdlp-status', (_e, s) => cb(s)),
  onUrlReset: (cb) => ipcRenderer.on('url-reset', () => cb()), // #193
  // bookmark manager (#29)
  toggleBmManager: () => ipcRenderer.send('toggle-bm-manager'),
  onBmManager: (cb) => ipcRenderer.on('bm-manager', (_e, open) => cb(open)),
  // bookmark edit dialog (#29)
  editBookmark: (id) => ipcRenderer.send('bm-edit-request', id),
  saveBookmark: (b) => ipcRenderer.send('bm-save', b),
  assignPersona: (url, personaId, force) => ipcRenderer.invoke('int:assign-persona', { url, personaId, force }), // #70
  closeBookmarkDialog: () => ipcRenderer.send('bm-close'),
  onBookmarkEdit: (cb) => ipcRenderer.on('bm-edit', (_e, data) => cb(data)),
  // settings (#24)
  toggleSettings: () => ipcRenderer.send('toggle-settings'),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  // tab groups (#34)
  saveTabGroups: (list) => ipcRenderer.send('groups-save', list),
  onTabGroups: (cb) => ipcRenderer.on('tab-groups', (_e, list) => cb(list)),
  onBookmarksPanel: (cb) => ipcRenderer.on('bookmarks-panel', (_e, open) => cb(open)),
  onFsMode: (cb) => ipcRenderer.on('fs-mode', (_e, mode) => cb(mode)), // #14
  // hotkeys (#16)
  sendKey: (keyId) => ipcRenderer.send('webforge-key', keyId),
  setHotkey: (keyId, url, title) => ipcRenderer.send('set-hotkey', { keyId, url, title }),
  removeHotkey: (keyId) => ipcRenderer.send('remove-hotkey', keyId),
  onHotkeysUpdated: (cb) => ipcRenderer.on('hotkeys-updated', (_e, map) => cb(map)),
  onBookmarksUpdated: (cb) => ipcRenderer.on('bookmarks-updated', (_e, list) => cb(list)),
  // vault (#15)
  vaultStatus: () => ipcRenderer.invoke('vault-status'),
  vaultSetup: (pw) => ipcRenderer.invoke('vault-setup', pw),
  vaultUnlock: (pw) => ipcRenderer.invoke('vault-unlock', pw),
  vaultReset: () => ipcRenderer.invoke('vault-reset'),
  lockNow: () => ipcRenderer.send('lock-now'),
});

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

installGuardedKeys({ x: () => ipcRenderer.send('close-active-tab') });

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
