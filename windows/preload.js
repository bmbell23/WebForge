const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webforge', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  onUrlChanged: (cb) => ipcRenderer.on('url-changed', (_e, url) => cb(url)),
});
