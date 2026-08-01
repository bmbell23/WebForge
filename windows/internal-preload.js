// #40: privileged bridge for WebForge's OWN pages (settings, bookmark
// manager) which run as real tabs. Only internal file:// pages get this
// preload — web content keeps the unprivileged content-preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wf', {
  // settings
  getSettings: () => ipcRenderer.invoke('int:get-settings'),
  setTheme: (t) => ipcRenderer.invoke('int:set-theme', t),
  setEngine: (e) => ipcRenderer.invoke('int:set-engine', e),
  setTabExpiry: (c) => ipcRenderer.invoke('int:set-tab-expiry', c), // #79
  saveTabGroups: (list) => ipcRenderer.invoke('int:save-tab-groups', list),
  syncStatus: () => ipcRenderer.invoke('int:sync-status'),
  // selected-text URL rules (#100)
  getTextRules: () => ipcRenderer.invoke('int:get-text-rules'),
  saveTextRules: (list) => ipcRenderer.invoke('int:save-text-rules', list),
  // default browser (#106)
  defaultBrowserStatus: () => ipcRenderer.invoke('int:default-browser-status'),
  openDefaultApps: () => ipcRenderer.invoke('int:open-default-apps'),
  // certificate + network interstitials (#108)
  certDetails: () => ipcRenderer.invoke('int:cert-details'),
  certProceed: () => ipcRenderer.invoke('int:cert-proceed'),
  certBack: () => ipcRenderer.invoke('int:cert-back'),
  certExceptions: () => ipcRenderer.invoke('int:cert-exceptions'),
  certRevoke: (host, fingerprint) => ipcRenderer.invoke('int:cert-revoke', { host, fingerprint }),
  netDetails: () => ipcRenderer.invoke('int:net-details'),
  netRetry: () => ipcRenderer.invoke('int:net-retry'),
  // HTTP auth dialog (#111)
  authDetails: () => ipcRenderer.invoke('int:auth-details'),
  authSubmit: (username, password, save) =>
    ipcRenderer.invoke('int:auth-submit', { username, password, save }),
  authCancel: () => ipcRenderer.invoke('int:auth-cancel'),
  about: () => ipcRenderer.invoke('int:about'), // #61
  openAbout: () => ipcRenderer.send('int:open-about'),
  openPasswords: () => ipcRenderer.send('int:open-passwords'), // #63
  // credentials (#47 — moved here from the chrome panel)
  getCreds: () => ipcRenderer.invoke('int:get-creds'),
  saveCred: (c) => ipcRenderer.invoke('int:save-cred', c),
  deleteCred: (id) => ipcRenderer.invoke('int:delete-cred', id),
  // personas (#25)
  getPersonas: () => ipcRenderer.invoke('int:get-personas'),
  addPersona: (name) => ipcRenderer.invoke('int:add-persona', name),
  updatePersona: (p) => ipcRenderer.invoke('int:update-persona', p),
  deletePersona: (id) => ipcRenderer.invoke('int:delete-persona', id),
  claimFor: (url) => ipcRenderer.invoke('int:claim-for', url), // #70
  assignPersona: (url, personaId, force) => ipcRenderer.invoke('int:assign-persona', { url, personaId, force }),
  // bookmarks
  getBookmarks: () => ipcRenderer.invoke('int:get-bookmarks'),
  getHotkeys: () => ipcRenderer.invoke('int:get-hotkeys'),
  saveBookmark: (b) => ipcRenderer.invoke('int:save-bookmark', b),
  deleteBookmark: (id) => ipcRenderer.invoke('int:delete-bookmark', id),
  moveBookmarks: (ids, folder) => ipcRenderer.invoke('int:move-bookmarks', { ids, folder }),
  renameFolder: (from, to) => ipcRenderer.invoke('int:rename-folder', { from, to }),
  deleteFolder: (folder) => ipcRenderer.invoke('int:delete-folder', folder),
  setHotkey: (keyId, url, title) => ipcRenderer.invoke('int:set-hotkey', { keyId, url, title }),
  removeHotkey: (keyId, personaId) => ipcRenderer.invoke('int:remove-hotkey', { keyId, personaId }),
  getAllHotkeys: () => ipcRenderer.invoke('int:get-all-hotkeys'), // #74
  getErrors: () => ipcRenderer.invoke('int:get-errors'), // #75
  clearErrors: () => ipcRenderer.invoke('int:clear-errors'),
  moveHotkey: (keyId, from, to, force) => ipcRenderer.invoke('int:move-hotkey', { keyId, from, to, force }),
  openUrl: (url, background) => ipcRenderer.send('int:open-url', { url, background }),
  importBookmarks: () => ipcRenderer.invoke('import-bookmarks'),
  importPasswords: () => ipcRenderer.send('import-passwords'),
  onBookmarksChanged: (cb) => ipcRenderer.on('int:bookmarks', () => cb()),
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
