const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webforge', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
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
