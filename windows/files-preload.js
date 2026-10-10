// #322: the Files page's bridge — the page gets these calls and nothing else.
// Main answers them only for the Files page (files-main.js, isFilesSender).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('files', {
  places: () => ipcRenderer.invoke('files:places'),
  list: (dir, sort, order) => ipcRenderer.invoke('files:list', { dir, sort, order }),
  preview: (path) => ipcRenderer.invoke('files:preview', path),
  open: (path, how) => ipcRenderer.invoke('files:open', { path, how }),
  copyPath: (path) => ipcRenderer.send('files:copy-path', path),
});
