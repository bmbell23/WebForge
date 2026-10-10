// #206/#214: a terminal tab's bridge — the page gets these calls and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminal', {
  start: (cols, rows, target) => ipcRenderer.send('terminal:start', cols, rows, target),
  write: (data) => ipcRenderer.send('terminal:write', data),
  resize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
  copy: (osc52Data) => ipcRenderer.send('terminal:copy', osc52Data),
  openLink: (url) => ipcRenderer.send('terminal:link', url),
  paste: () => ipcRenderer.send('terminal:paste'), // #212
  copyText: (text) => ipcRenderer.send('terminal:copy-text', text),
  onPasteText: (cb) => ipcRenderer.on('terminal:paste-text', (_e, text) => cb(text)),
  onData: (cb) => ipcRenderer.on('terminal:data', (_e, buf) => cb(buf)),
  onStatus: (cb) => ipcRenderer.on('terminal:status', (_e, s) => cb(s)),
  onPrompt: (cb) => ipcRenderer.on('terminal:prompt', (_e, q) => cb(q)), // #214: host-key question
  connections: () => ipcRenderer.invoke('terminal:connections'), // #214: the new-tab picker
  favorite: (target) => ipcRenderer.send('terminal:favorite', target),
  editFavorite: (target, fields) => ipcRenderer.invoke('terminal:edit-favorite', { target, fields }), // #228
  deleteConnection: (target, group) => ipcRenderer.invoke('terminal:delete-connection', { target, group }), // #280
  openFiles: () => ipcRenderer.send('terminal:open-files'), // #322
});
