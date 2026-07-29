// #40: privileged bridge for WebForge's OWN pages (settings, bookmark
// manager) which run as real tabs. Only internal file:// pages get this
// preload — web content keeps the unprivileged content-preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wf', {
  // settings
  getSettings: () => ipcRenderer.invoke('int:get-settings'),
  setTheme: (t) => ipcRenderer.invoke('int:set-theme', t),
  setEngine: (e) => ipcRenderer.invoke('int:set-engine', e),
  saveTabGroups: (list) => ipcRenderer.invoke('int:save-tab-groups', list),
  syncStatus: () => ipcRenderer.invoke('int:sync-status'),
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
