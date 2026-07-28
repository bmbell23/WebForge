// WebForge Windows shell (#3, tabs #4, vertical tabs #8): a BaseWindow holding
// one chrome WebContentsView (ui/index.html: left tab sidebar + top nav bar)
// and one content WebContentsView per tab. The chrome view covers the WHOLE
// window; content views are inset (right of the sidebar, below the nav bar)
// and added after it, so they cover chrome's dead area. Only the active tab's
// view is visible. Full tab state is broadcast to the chrome UI on every
// change; it re-renders from that.
const { app, BaseWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const bookmarks = require('./bookmarks');
const vault = require('./vault');
const credentials = require('./credentials');

const HOME_URL = 'https://duckduckgo.com/';
const SEARCH_URL = 'https://duckduckgo.com/?q=';
// Keep in sync with ui/index.html's grid.
const SIDEBAR_W = 240;
const TOPBAR_H = 44;
const BM_PANEL_W = 280; // #11 bookmarks panel, right side
let bmPanelOpen = false;

let win, chrome, lockView;
const tabs = new Map(); // id -> WebContentsView
let tabOrder = [];      // ids in sidebar order (pinned group first)
let activeId = null;
let nextTabId = 1;
const pinnedIds = new Set(); // #9
let locked = true;           // #15: the app is a brick until the vault unlocks

// #15: the whole session (tabs + pinned flags + active tab) persists
// AES-encrypted in the vault, saved (debounced) on every state change and
// restored after unlock. Supersedes #9's plaintext pinned.json (migrated
// below, then deleted).
let saveSessionTimer = null;
function sessionSnapshot() {
  return {
    tabs: tabOrder
      .map((id) => ({
        url: tabs.get(id).webContents.getURL(),
        pinned: pinnedIds.has(id),
      }))
      .filter((t) => t.url),
    active: Math.max(0, tabOrder.indexOf(activeId)),
  };
}
function saveSessionSoon() {
  if (locked) return;
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(() => vault.writeFile('session', sessionSnapshot()), 500);
}
function saveSessionNow() {
  if (locked) return;
  clearTimeout(saveSessionTimer);
  vault.writeFile('session', sessionSnapshot());
}
function loadLegacyPinned() {
  const f = path.join(app.getPath('userData'), 'pinned.json');
  try {
    const urls = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.rmSync(f, { force: true });
    return Array.isArray(urls) ? urls.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

// Address-bar input → URL. Same rules as the Android shell: explicit scheme
// passes through; something host-shaped gets https://; anything else searches.
function resolveInput(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (!t.includes(' ') && t.includes('.')) return `https://${t}`;
  return SEARCH_URL + encodeURIComponent(t);
}

const activeWc = () => tabs.get(activeId)?.webContents;

function layout() {
  const { width, height } = win.getContentBounds();
  chrome.setBounds({ x: 0, y: 0, width, height });
  lockView?.setBounds({ x: 0, y: 0, width, height });
  const view = tabs.get(activeId);
  if (view) {
    view.setBounds({
      x: SIDEBAR_W,
      y: TOPBAR_H,
      width: width - SIDEBAR_W - (bmPanelOpen ? BM_PANEL_W : 0),
      height: height - TOPBAR_H,
    });
  }
}

// #11: bookmarks panel + star state.
function pushBookmarks() {
  chrome?.webContents.send('bookmarks-updated', bookmarks.all());
}

function toggleBookmarksPanel() {
  bmPanelOpen = !bmPanelOpen;
  chrome?.webContents.send('bookmarks-panel', bmPanelOpen);
  if (bmPanelOpen) pushBookmarks();
  layout();
}

function toggleStarCurrent() {
  const url = activeWc()?.getURL();
  if (!url) return;
  if (bookmarks.has(url)) bookmarks.remove(url);
  else bookmarks.add({ title: activeWc().getTitle(), url });
  pushBookmarks();
  pushState(); // star state rides on tab state
}

function tabState() {
  return tabOrder.map((id) => {
    const wc = tabs.get(id).webContents;
    return {
      id,
      title: wc.getTitle() || wc.getURL() || 'New tab',
      url: wc.getURL(),
      loading: wc.isLoading(),
      active: id === activeId,
      pinned: pinnedIds.has(id),
      starred: bookmarks.has(wc.getURL()),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  });
}

function pushState() {
  if (!chrome) return;
  chrome.webContents.send('tabs-updated', tabState());
  const wc = activeWc();
  const title = wc?.getTitle();
  win.setTitle(title ? `${title} — WebForge` : 'WebForge');
  saveSessionSoon();
}

function createTab(url = HOME_URL, background = false) {
  if (locked) return null; // #15
  const id = nextTabId++;
  const view = new WebContentsView();
  tabs.set(id, view);
  tabOrder.push(id);

  const wc = view.webContents;
  // Popups (window.open / target=_blank) land in a background tab (#4)
  // instead of hijacking the current view or spawning an OS window.
  wc.setWindowOpenHandler(({ url: popupUrl }) => {
    createTab(popupUrl, true);
    return { action: 'deny' };
  });
  for (const ev of [
    'did-navigate',
    'did-navigate-in-page',
    'page-title-updated',
    'did-start-loading',
    'did-stop-loading',
  ]) {
    wc.on(ev, pushState);
  }
  wc.on('did-finish-load', () => tryAutofill(wc)); // #12

  win.contentView.addChildView(view);
  view.setVisible(false);
  wc.loadURL(url);
  if (background && activeId !== null) pushState();
  else activateTab(id);
  return id;
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  tabs.get(activeId)?.setVisible(false);
  activeId = id;
  tabs.get(id).setVisible(true);
  layout();
  pushState();
}

function closeTab(id) {
  const view = tabs.get(id);
  if (!view) return;
  if (pinnedIds.has(id)) return; // #9: pinned tabs don't close — unpin first
  const idx = tabOrder.indexOf(id);
  tabs.delete(id);
  tabOrder = tabOrder.filter((t) => t !== id);
  win.contentView.removeChildView(view);
  view.webContents.close();
  if (activeId === id) {
    activeId = null;
    if (tabOrder.length === 0) createTab(); // the window always has ≥1 tab
    else activateTab(tabOrder[Math.min(idx, tabOrder.length - 1)]);
  } else {
    pushState();
  }
}

function cycleTab(dir) {
  if (tabOrder.length < 2) return;
  const idx = tabOrder.indexOf(activeId);
  activateTab(tabOrder[(idx + dir + tabOrder.length) % tabOrder.length]);
}

// #9: pinned tabs.
function togglePin(id) {
  if (!tabs.has(id)) return;
  if (pinnedIds.has(id)) pinnedIds.delete(id);
  else pinnedIds.add(id);
  // Keep the pinned group at the top of the sidebar (stable within groups).
  tabOrder = [
    ...tabOrder.filter((t) => pinnedIds.has(t)),
    ...tabOrder.filter((t) => !pinnedIds.has(t)),
  ];
  pushState();
}

function purgeUnpinned() {
  const doomed = tabOrder.filter((id) => !pinnedIds.has(id));
  for (const id of doomed) closeTab(id); // closeTab handles activation/last-tab
}

function createWindow() {
  win = new BaseWindow({
    width: 1280,
    height: 840,
    title: 'WebForge',
    // #7: match the chrome theme so resize flashes aren't white in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#10203c' : '#dde3ec',
  });

  chrome = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.contentView.addChildView(chrome);
  chrome.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Chrome renders from pushed state; re-push once it's ready to receive.
  chrome.webContents.on('did-finish-load', pushState);

  win.on('resize', layout);
  win.on('maximize', layout);
  win.on('unmaximize', layout);

  showLock(); // #15: nothing exists until the vault opens
}

// #12: automatic login fill — user decision: "everything once I'm in".
// Exact-origin match; fills the first saved login for the page's origin into
// the first empty password form found. Silent no-op when locked or unmatched.
function tryAutofill(wc) {
  if (locked || wc.isDestroyed()) return;
  let origin;
  try {
    origin = new URL(wc.getURL()).origin;
  } catch {
    return;
  }
  const match = credentials.forOrigin(origin)[0];
  if (!match) return;
  wc.executeJavaScript(
    `(() => {
      const pw = document.querySelector('input[type="password"]');
      if (!pw || pw.value) return false;
      const scope = pw.form || document;
      const user = scope.querySelector(
        'input[autocomplete="username"], input[type="email"], input[type="text"]'
      );
      const fire = (el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (user && !user.value) { user.value = ${JSON.stringify(match.username)}; fire(user); }
      pw.value = ${JSON.stringify(match.password)}; fire(pw);
      return true;
    })()`,
    true
  ).catch(() => {});
}

async function importPasswordsCsv() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Firefox passwords (about:logins → Export passwords)',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return;
  const result = credentials.importCsv(filePaths[0]);
  if (result.error) {
    dialog.showMessageBox(win, { type: 'error', message: `Import failed: ${result.error}` });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    message: `Imported ${result.added} logins (${result.updated} updated, ${credentials.count()} total).`,
    detail: 'The CSV on disk is PLAINTEXT — delete it now that it lives in the encrypted vault?',
    buttons: ['Delete the CSV (recommended)', 'Keep it'],
    defaultId: 0,
  });
  if (response === 0) {
    try {
      fs.rmSync(filePaths[0], { force: true });
    } catch {}
  }
}

// --- #15: lock screen + session restore ---

function showLock() {
  if (lockView) return;
  locked ? null : saveSessionNow();
  locked = true;
  vault.lock();
  // Tear the whole session down — nothing sensitive stays rendered or mapped.
  for (const id of [...tabOrder]) {
    const view = tabs.get(id);
    win.contentView.removeChildView(view);
    view.webContents.close();
  }
  tabs.clear();
  tabOrder = [];
  pinnedIds.clear();
  activeId = null;
  win.setTitle('WebForge — locked');
  chrome.webContents.send('tabs-updated', []);

  lockView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.contentView.addChildView(lockView); // last added = on top of everything
  lockView.webContents.loadFile(path.join(__dirname, 'ui', 'lock.html'));
  layout();
  lockView.webContents.focus();
}

function onUnlocked() {
  locked = false;
  if (lockView) {
    win.contentView.removeChildView(lockView);
    lockView.webContents.close();
    lockView = null;
  }
  win.setTitle('WebForge');
  // Restore the previous session; fall back to legacy pinned.json, then Home.
  const session = vault.readFile('session');
  if (session?.tabs?.length) {
    for (const t of session.tabs) {
      const id = createTab(t.url, true);
      if (t.pinned && id !== null) pinnedIds.add(id);
    }
    activateTab(tabOrder[Math.min(session.active ?? 0, tabOrder.length - 1)]);
  } else {
    const legacy = loadLegacyPinned();
    for (const u of legacy) {
      const id = createTab(u, true);
      if (id !== null) pinnedIds.add(id);
    }
    if (!tabOrder.length) createTab(HOME_URL);
    else activateTab(tabOrder[0]);
  }
  pushState();
}

// Keyboard shortcuts via a hidden application menu — accelerators fire no
// matter which webContents (page or chrome UI) has keyboard focus.
function setupShortcuts() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'WebForge',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
          { label: 'Pin/Unpin Tab', accelerator: 'CmdOrCtrl+Shift+P', click: () => togglePin(activeId) },
          { label: 'Close Unpinned Tabs', accelerator: 'CmdOrCtrl+Shift+W', click: () => purgeUnpinned() },
          { label: 'Bookmarks Panel', accelerator: 'CmdOrCtrl+B', click: () => locked || toggleBookmarksPanel() },
          { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => locked || toggleStarCurrent() },
          { label: 'Lock WebForge', accelerator: 'CmdOrCtrl+Shift+L', click: () => showLock() },
          { label: 'Import Passwords (CSV)…', click: () => locked || importPasswordsCsv() },
          { label: 'Next Tab', accelerator: 'Control+Tab', click: () => cycleTab(1) },
          { label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: () => cycleTab(-1) },
          {
            label: 'Focus Address Bar',
            accelerator: 'CmdOrCtrl+L',
            click: () => {
              chrome.webContents.focus();
              chrome.webContents.send('focus-url');
            },
          },
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeWc()?.reload() },
          { label: 'Reload', accelerator: 'F5', visible: false, click: () => activeWc()?.reload() },
          { type: 'separator' },
          { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
    ])
  );
}

ipcMain.on('navigate', (_e, input) => {
  const url = resolveInput(input);
  if (url) activeWc()?.loadURL(url);
});
ipcMain.on('go-back', () => activeWc()?.navigationHistory.goBack());
ipcMain.on('go-forward', () => activeWc()?.navigationHistory.goForward());
ipcMain.on('reload', () => activeWc()?.reload());
ipcMain.on('stop', () => activeWc()?.stop());
ipcMain.on('new-tab', () => createTab());
ipcMain.on('close-tab', (_e, id) => closeTab(id));
ipcMain.on('activate-tab', (_e, id) => activateTab(id));
ipcMain.on('toggle-pin', (_e, id) => togglePin(id));

// #11: bookmarks IPC.
ipcMain.on('toggle-bookmarks-panel', () => toggleBookmarksPanel());
ipcMain.on('toggle-star', () => toggleStarCurrent());
ipcMain.on('open-bookmark', (_e, { url, background }) => {
  if (background) createTab(url, true);
  else activeWc()?.loadURL(url);
});
ipcMain.on('remove-bookmark', (_e, id) => {
  bookmarks.remove(id);
  pushBookmarks();
  pushState();
});
// #15: vault IPC (used by ui/lock.html).
ipcMain.handle('vault-status', () => ({
  initialized: vault.isInitialized(),
  unlocked: vault.isUnlocked(),
}));
ipcMain.handle('vault-setup', (_e, pw) => {
  const ok = vault.setup(String(pw ?? ''));
  if (ok) onUnlocked();
  return ok;
});
ipcMain.handle('vault-unlock', (_e, pw) => {
  const ok = vault.unlock(String(pw ?? ''));
  if (ok) onUnlocked();
  return ok;
});
ipcMain.handle('vault-reset', () => {
  vault.reset();
  return true;
});
ipcMain.on('lock-now', () => showLock());

ipcMain.handle('import-bookmarks', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Firefox bookmarks (HTML export or JSON backup)',
    filters: [{ name: 'Bookmarks', extensions: ['html', 'json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  try {
    const result = bookmarks.importFile(filePaths[0]);
    pushBookmarks();
    pushState();
    return result;
  } catch (e) {
    return { error: String(e.message || e) };
  }
});

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
  // startup + every 4h + on window focus. Focus checks are throttled to one
  // per 2 min (#6: 10 min made a freshly staged release feel broken; a check
  // against the LAN endpoint costs nothing).
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
  let lastFocusCheck = Date.now();
  win.on('focus', () => {
    if (Date.now() - lastFocusCheck < 2 * 60 * 1000) return;
    lastFocusCheck = Date.now();
    check();
  });
}

app.whenReady().then(() => {
  createWindow();
  setupShortcuts();
  setupAutoUpdate();
});

app.on('before-quit', () => saveSessionNow()); // flush any pending debounce
app.on('window-all-closed', () => app.quit());
