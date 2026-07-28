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
  onTabsUpdated: (cb) => ipcRenderer.on('tabs-updated', (_e, state) => cb(state)),
  onFocusUrl: (cb) => ipcRenderer.on('focus-url', () => cb()),
  // bookmarks (#11)
  toggleStar: () => ipcRenderer.send('toggle-star'),
  toggleBookmarksPanel: () => ipcRenderer.send('toggle-bookmarks-panel'),
  openBookmark: (url, background) => ipcRenderer.send('open-bookmark', { url, background }),
  removeBookmark: (id) => ipcRenderer.send('remove-bookmark', id),
  importBookmarks: () => ipcRenderer.invoke('import-bookmarks'),
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
