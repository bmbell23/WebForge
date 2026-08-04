const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webforge', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  // #126: ticket-key box — same channel Ctrl+J uses (#100).
  openTextRule: (text) => ipcRenderer.send('open-text-rule', text),
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
