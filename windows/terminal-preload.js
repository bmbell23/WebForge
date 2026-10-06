// #206: the terminal window's bridge — the page gets these six calls and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminal', {
  start: (cols, rows) => ipcRenderer.send('terminal:start', cols, rows),
  write: (data) => ipcRenderer.send('terminal:write', data),
  resize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
  copy: (osc52Data) => ipcRenderer.send('terminal:copy', osc52Data),
  onData: (cb) => ipcRenderer.on('terminal:data', (_e, buf) => cb(buf)),
  onStatus: (cb) => ipcRenderer.on('terminal:status', (_e, s) => cb(s)),
});
