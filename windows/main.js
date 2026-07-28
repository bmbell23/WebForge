// WebForge Windows shell: a BaseWindow holding two WebContentsViews —
// a thin "chrome" strip (ui/index.html: back/forward/reload + address bar)
// and the page content below it. This is the same layout the future tabbed
// UI (#4) extends: one chrome view, N content views.
const { app, BaseWindow, WebContentsView, ipcMain, dialog } = require('electron');
const path = require('path');

const HOME_URL = 'https://duckduckgo.com/';
const SEARCH_URL = 'https://duckduckgo.com/?q=';
const CHROME_HEIGHT = 44;

let win, chrome, content;

// Address-bar input → URL. Same rules as the Android shell: explicit scheme
// passes through; something host-shaped gets https://; anything else searches.
function resolveInput(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (!t.includes(' ') && t.includes('.')) return `https://${t}`;
  return SEARCH_URL + encodeURIComponent(t);
}

function layout() {
  const { width, height } = win.getContentBounds();
  chrome.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });
  content.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: height - CHROME_HEIGHT });
}

function createWindow() {
  win = new BaseWindow({ width: 1280, height: 840, title: 'WebForge' });

  chrome = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  content = new WebContentsView();

  win.contentView.addChildView(chrome);
  win.contentView.addChildView(content);
  layout();
  win.on('resize', layout);
  win.on('maximize', layout);
  win.on('unmaximize', layout);

  // Keep every navigation in our content view — we ARE the browser.
  content.webContents.setWindowOpenHandler(({ url }) => {
    content.webContents.loadURL(url);
    return { action: 'deny' };
  });

  const pushUrl = () =>
    chrome.webContents.send('url-changed', content.webContents.getURL());
  content.webContents.on('did-navigate', pushUrl);
  content.webContents.on('did-navigate-in-page', pushUrl);

  chrome.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  content.webContents.loadURL(HOME_URL);
}

ipcMain.on('navigate', (_e, input) => {
  const url = resolveInput(input);
  if (url) content.webContents.loadURL(url);
});
ipcMain.on('go-back', () => content.webContents.navigationHistory.goBack());
ipcMain.on('go-forward', () => content.webContents.navigationHistory.goForward());
ipcMain.on('reload', () => content.webContents.reload());

// Self-update: electron-updater against the generic HTTP provider on
// dockerhost (releases/windows/ behind nginx :8012 — see docker-compose.yml).
// Downloads in the background, then offers a restart. Dev runs skip it.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', () => {});

  // #5: don't re-prompt a version the user already declined — the downloaded
  // update still applies on next quit (electron-updater's autoInstallOnAppQuit).
  let promptedVersion = null;
  autoUpdater.on('update-downloaded', (info) => {
    if (info.version === promptedVersion) return;
    promptedVersion = info.version;
    dialog
      .showMessageBox(win, {
        type: 'info',
        title: 'Update ready',
        message: `WebForge v${info.version} has been downloaded. Restart to apply?`,
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  // Off the tailnet / server down → checks just fail quietly.
  const check = () => autoUpdater.checkForUpdates().catch(() => {});

  // #5: a long-running window must notice releases staged after launch —
  // startup + every 4h + on window focus (throttled to one check per 10 min).
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
  let lastFocusCheck = Date.now();
  win.on('focus', () => {
    if (Date.now() - lastFocusCheck < 10 * 60 * 1000) return;
    lastFocusCheck = Date.now();
    check();
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdate();
});

app.on('window-all-closed', () => app.quit());
