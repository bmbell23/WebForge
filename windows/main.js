// WebForge Windows shell (#3, tabs #4, vertical tabs #8): a BaseWindow holding
// one chrome WebContentsView (ui/index.html: left tab sidebar + top nav bar)
// and one content WebContentsView per tab. The chrome view covers the WHOLE
// window; content views are inset (right of the sidebar, below the nav bar)
// and added after it, so they cover chrome's dead area. Only the active tab's
// view is visible. Full tab state is broadcast to the chrome UI on every
// change; it re-renders from that.
const { app, BaseWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const bookmarks = require('./bookmarks');
const vault = require('./vault');
const credentials = require('./credentials');
const hotkeys = require('./hotkeys');

const HOME_URL = 'https://duckduckgo.com/';
const SEARCH_URL = 'https://duckduckgo.com/?q=';
// Keep in sync with ui/index.html's grid.
const SIDEBAR_W = 240;
const TOPBAR_H = 44;
const BM_PANEL_W = 280; // #11 bookmarks panel / #26 passwords panel, right side
let bmPanelOpen = false;
let pwPanelOpen = false; // #26 — shares the right-panel slot with bookmarks

let win, chrome, lockView;
const tabs = new Map(); // id -> WebContentsView
let tabOrder = [];      // ids in sidebar order (pinned group first)
let activeId = null;
let nextTabId = 1;
const pinnedIds = new Set(); // #9
const hotkeyByTab = new Map(); // #16: tabId -> keyId (a tab per bound hotkey)
let locked = true;           // #15: the app is a brick until the vault unlocks

// #16: sidebar ordering — hotkey group first, then pinned, then normal.
function sortTabOrder() {
  const weight = (id) => (hotkeyByTab.has(id) ? 0 : pinnedIds.has(id) ? 1 : 2);
  tabOrder = [...tabOrder].sort((a, b) => weight(a) - weight(b));
}

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
        hotkey: hotkeyByTab.get(id) || null,
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
  lockView?.setBounds({ x: 0, y: 0, width, height });
  const view = tabs.get(activeId);
  if (fullscreen) {
    // #14: the page owns every pixel; chrome collapses to the revealed
    // hover region (or nothing).
    view?.setBounds({ x: 0, y: 0, width, height });
    chrome.setBounds(fsRegionBounds());
    return;
  }
  chrome.setBounds({ x: 0, y: 0, width, height });
  if (view) {
    view.setBounds({
      x: SIDEBAR_W,
      y: TOPBAR_H,
      width: width - SIDEBAR_W - (bmPanelOpen || pwPanelOpen ? BM_PANEL_W : 0),
      height: height - TOPBAR_H,
    });
  }
}

// --- #14: true fullscreen with hover-reveal edges ---
let fullscreen = false;
let fsRevealed = null; // 'tabs' | 'nav' | 'bookmarks' | null
let fsPollTimer = null;

function fsRegionBounds() {
  const { width, height } = win.getContentBounds();
  switch (fsRevealed) {
    case 'tabs':
      return { x: 0, y: 0, width: SIDEBAR_W, height };
    case 'nav':
      return { x: 0, y: 0, width, height: TOPBAR_H + 2 };
    case 'bookmarks':
      return { x: width - BM_PANEL_W, y: 0, width: BM_PANEL_W, height };
    default:
      return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function fsPoll() {
  // #20: the window can die (quit while fullscreen) with this interval still
  // scheduled — every tick then threw "Object has been destroyed" and
  // Electron's modal error dialog respawned 6×/second, bricking the app.
  if (!win || win.isDestroyed()) {
    clearInterval(fsPollTimer);
    fsPollTimer = null;
    return;
  }
  if (!fullscreen || locked) return;
  const { screen } = require('electron');
  const pt = screen.getCursorScreenPoint();
  const wb = win.getBounds();
  const x = pt.x - wb.x;
  const y = pt.y - wb.y;
  const { width, height } = win.getContentBounds();
  const inWindow = x >= 0 && y >= 0 && x <= width && y <= height;
  let want = null;
  if (fsRevealed && inWindow) {
    // Stay open while the cursor is on (or near) the revealed panel.
    const r = fsRegionBounds();
    const S = 24;
    if (x >= r.x - S && x <= r.x + r.width + S && y >= r.y - S && y <= r.y + r.height + S) {
      want = fsRevealed;
    }
  }
  if (!want && inWindow) {
    if (x <= 2) want = 'tabs';
    if (y <= 2) want = 'nav'; // top edge wins the corners
    if (x >= width - 2) want = 'bookmarks';
  }
  if (want !== fsRevealed) {
    fsRevealed = want;
    if (want) {
      win.contentView.addChildView(chrome); // re-add = raise above the page
      if (want === 'bookmarks') pushBookmarks();
    }
    chrome.webContents.send('fs-mode', want);
    layout();
  }
}

function setFullscreenMode(on) {
  if (locked || on === fullscreen) return;
  fullscreen = on;
  fsRevealed = null;
  chrome.webContents.send('fs-mode', null);
  win.setFullScreen(on);
  if (on) {
    fsPollTimer = setInterval(fsPoll, 150);
  } else {
    clearInterval(fsPollTimer);
    fsPollTimer = null;
  }
  layout();
}

// #11: bookmarks panel + star state.
function pushBookmarks() {
  chrome?.webContents.send('bookmarks-updated', bookmarks.all());
}

function toggleBookmarksPanel() {
  bmPanelOpen = !bmPanelOpen;
  if (bmPanelOpen && pwPanelOpen) {
    pwPanelOpen = false;
    chrome?.webContents.send('pw-panel', false);
  }
  chrome?.webContents.send('bookmarks-panel', bmPanelOpen);
  if (bmPanelOpen) pushBookmarks();
  layout();
}

// #26: passwords panel — same right-hand slot as bookmarks.
function pushCreds() {
  chrome?.webContents.send('creds-updated', locked ? [] : credentials.list());
}

function togglePwPanel() {
  pwPanelOpen = !pwPanelOpen;
  if (pwPanelOpen && bmPanelOpen) {
    bmPanelOpen = false;
    chrome?.webContents.send('bookmarks-panel', false);
  }
  chrome?.webContents.send('pw-panel', pwPanelOpen);
  if (pwPanelOpen) pushCreds();
  layout();
}

function toggleStarCurrent() {
  const url = activeWc()?.getURL();
  if (!url) return;
  if (bookmarks.has(url)) bookmarks.remove(url);
  else bookmarks.add({ title: activeWc().getTitle(), url });
  pushBookmarks();
  pushState(); // star state rides on tab state
  scheduleSyncSoon();
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
      hotkey: hotkeyByTab.get(id) || null,
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
  const view = new WebContentsView({
    // #16: hotkey capture inside pages (editability-aware, bound keys only).
    webPreferences: { preload: path.join(__dirname, 'content-preload.js') },
  });
  tabs.set(id, view);
  tabOrder.push(id);

  const wc = view.webContents;
  // Popups (window.open / target=_blank) become tabs, never OS windows.
  // #30: they open FOREGROUND — clicking a link that spawns a tab should put
  // you in that tab (matches every mainstream browser; reverses #4's call).
  // #31: same URL already open → focus that tab instead of spawning a dupe.
  wc.setWindowOpenHandler(({ url: popupUrl }) => {
    openOrFocus(popupUrl, false);
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
  wc.on('dom-ready', () => wc.send('hotkey-keys', hotkeys.keyIds())); // #16

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
  const view = tabs.get(id);
  view.setVisible(true);
  layout();
  // #30: keyboard focus MUST follow activation — if it stays on a hidden view
  // (or nothing), key events vanish and hotkey swapping "stops working".
  view.webContents.focus();
  pushState();
}

function closeTab(id) {
  const view = tabs.get(id);
  if (!view) return;
  if (pinnedIds.has(id)) return; // #9: pinned tabs don't close — unpin first
  const idx = tabOrder.indexOf(id);
  tabs.delete(id);
  hotkeyByTab.delete(id); // #16: the binding survives; only the open tab dies
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

// #31: dedup for link/bookmark-opened tabs. Explicit new tabs (Ctrl+T) and
// session restore bypass this — only "open this URL somewhere" paths dedup.
function findTabByUrl(url) {
  for (const id of tabOrder) {
    if (tabs.get(id).webContents.getURL() === url) return id;
  }
  return null;
}

function openOrFocus(url, background) {
  const existing = findTabByUrl(url);
  if (existing !== null) {
    if (!background) activateTab(existing);
    return existing;
  }
  return createTab(url, background);
}

// #31: intentional duplicate of the active tab (Ctrl+Shift+U).
function duplicateActiveTab() {
  const url = activeWc()?.getURL();
  if (url) createTab(url, false);
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
  sortTabOrder();
  pushState();
}

// #16 redefinition of #9's purge: "normal" = neither pinned nor hotkey.
function closeNormalTabs() {
  const doomed = tabOrder.filter((id) => !pinnedIds.has(id) && !hotkeyByTab.has(id));
  for (const id of doomed) closeTab(id); // closeTab handles activation/last-tab
}

// --- #16: hotkey tabs ---

function broadcastHotkeys() {
  const keys = hotkeys.keyIds();
  for (const view of tabs.values()) view.webContents.send('hotkey-keys', keys);
  chrome?.webContents.send('hotkeys-updated', hotkeys.all());
}

function tabForHotkey(keyId) {
  for (const [tid, kid] of hotkeyByTab) if (kid === keyId) return tid;
  return null;
}

function handleHotkeyPress(keyId) {
  if (locked) return;
  const entry = hotkeys.get(keyId);
  if (!entry) return;
  const tabId = tabForHotkey(keyId);
  if (tabId !== null && tabs.has(tabId)) {
    if (activeId === tabId) {
      // Already in the hotkey tab → the hotkey means "take me home".
      tabs.get(tabId).webContents.loadURL(entry.url);
      tabs.get(tabId).webContents.focus(); // #30
    } else {
      activateTab(tabId);
    }
  } else {
    const newId = createTab(entry.url);
    if (newId !== null) {
      hotkeyByTab.set(newId, keyId);
      sortTabOrder();
      pushState();
    }
  }
}

// Ctrl+Shift+D: current hotkey tab keeps its page but becomes a normal tab;
// the next hotkey press opens a fresh hotkey tab at home.
function detachActiveHotkeyTab() {
  if (locked || !hotkeyByTab.has(activeId)) return;
  hotkeyByTab.delete(activeId);
  sortTabOrder();
  pushState();
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

// #10: ad blocking — Ghostery engine with the FULL prebuilt list set
// (EasyList/EasyPrivacy + uBlock lists incl. Annoyances), plus extra cosmetic
// rules for fandom.com, the user's priority target. Engine is cached in
// userData so later launches (even off-network) reuse it; a first-ever run
// with no network just skips blocking until next launch.
const FANDOM_EXTRA_FILTERS = `
fandom.com##.top-ads-container
fandom.com##.bottom-ads-container
fandom.com##.ad-slot
fandom.com##.gpt-ad
fandom.com##div[class*="ad-slot"]
fandom.com##div[data-ad-bucket]
fandom.com##.global-footer__bottom-ads
fandom.com##.mobile-global-navigation__anchor-ads
fandom.com##.fandom-video-ad
`;

async function setupAdblock() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const blocker = await ElectronBlocker.fromPrebuiltFull(fetch, {
      path: path.join(app.getPath('userData'), 'adblock-engine.bin'),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    try {
      const { parseFilters } = require('@ghostery/adblocker');
      const extra = parseFilters(FANDOM_EXTRA_FILTERS, blocker.config);
      blocker.update({
        newNetworkFilters: extra.networkFilters,
        newCosmeticFilters: extra.cosmeticFilters,
      });
    } catch (e) {
      console.error('webforge: fandom extras failed to load', e);
    }
    blocker.enableBlockingInSession(session.defaultSession);
  } catch (e) {
    console.error('webforge: adblock disabled this run', e);
  }
}

// #13: opportunistic bookmark sync against dockerhost — whole-store
// last-write-wins by updatedAt. Fails silently off the tailnet (work-VPN
// case): purely offline-first, catches up whenever home is reachable.
const SYNC_URL = 'http://100.69.184.113:8013/store/bookmarks';
let syncTimer = null;
let syncing = false;

async function syncBookmarks() {
  if (syncing) return;
  syncing = true;
  try {
    const local = bookmarks.meta();
    const res = await fetch(SYNC_URL, { signal: AbortSignal.timeout(5000) });
    const remote = await res.json();
    const remoteAt = remote.updatedAt || 0;
    if (remoteAt > local.updatedAt) {
      bookmarks.replaceAll(remote.data, remoteAt);
      pushBookmarks();
      pushState();
    } else if (local.updatedAt > remoteAt) {
      await fetch(SYNC_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: bookmarks.all(), updatedAt: local.updatedAt }),
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch {
    // off the tailnet / server down — try again next cycle
  } finally {
    syncing = false;
  }
}

function scheduleSyncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncBookmarks, 5000);
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
  if (!locked) saveSessionNow();
  if (fullscreen) setFullscreenMode(false); // lock screen is never chromeless
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
      if (id === null) continue;
      if (t.pinned) pinnedIds.add(id);
      if (t.hotkey && hotkeys.get(t.hotkey)) hotkeyByTab.set(id, t.hotkey); // #16
    }
    sortTabOrder();
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
  broadcastHotkeys(); // #16: chrome badges + per-tab bound-key lists
  syncBookmarks(); // #13: catch up whenever a session starts
}

// Keyboard shortcuts via a hidden application menu — accelerators fire no
// matter which webContents (page or chrome UI) has keyboard focus.
function setupShortcuts() {
  const menu = Menu.buildFromTemplate(menuTemplate());
  Menu.setApplicationMenu(menu);
  // #23: Menu.setApplicationMenu alone doesn't reliably attach a menu bar to
  // a BaseWindow on Windows — without this, the menu (and every accelerator)
  // can silently not exist in the packaged app.
  win.setMenu(menu);
}

function menuTemplate() {
  return [
      {
        label: 'WebForge',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
          { label: 'Duplicate Tab', accelerator: 'CmdOrCtrl+Shift+U', click: () => locked || duplicateActiveTab() },
          { label: 'Pin/Unpin Tab', accelerator: 'CmdOrCtrl+Shift+P', click: () => togglePin(activeId) },
          { label: 'Close Normal Tabs', accelerator: 'CmdOrCtrl+Shift+W', click: () => closeNormalTabs() },
          { label: 'Detach Hotkey Tab', accelerator: 'CmdOrCtrl+Shift+D', click: () => detachActiveHotkeyTab() },
          { label: 'Bookmarks Panel', accelerator: 'CmdOrCtrl+B', click: () => locked || toggleBookmarksPanel() },
          { label: 'Passwords Panel', accelerator: 'CmdOrCtrl+Shift+K', click: () => locked || togglePwPanel() },
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
          { label: 'Full Screen', accelerator: 'F11', click: () => setFullscreenMode(!fullscreen) },
          { type: 'separator' },
          { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
    ];
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

// #16: hotkey IPC — key presses arrive from content preloads AND the chrome UI.
ipcMain.on('webforge-key', (_e, keyId) => handleHotkeyPress(String(keyId)));
ipcMain.on('set-hotkey', (_e, { keyId, url, title }) => {
  if (locked) return;
  hotkeys.set(String(keyId), { url, title });
  broadcastHotkeys();
  pushState();
});
ipcMain.on('remove-hotkey', (_e, keyId) => {
  if (locked) return;
  const tabId = tabForHotkey(String(keyId));
  if (tabId !== null) hotkeyByTab.delete(tabId); // open tab becomes normal
  hotkeys.remove(String(keyId));
  broadcastHotkeys();
  sortTabOrder();
  pushState();
});

// #11: bookmarks IPC.
ipcMain.on('toggle-bookmarks-panel', () => toggleBookmarksPanel());
ipcMain.on('toggle-star', () => toggleStarCurrent());
ipcMain.on('open-bookmark', (_e, { url, background }) => {
  // #31: an already-open copy of the bookmark wins over navigating/spawning.
  const existing = findTabByUrl(url);
  if (existing !== null) {
    if (!background) activateTab(existing);
    return;
  }
  if (background) createTab(url, true);
  else activeWc()?.loadURL(url);
});
ipcMain.on('remove-bookmark', (_e, id) => {
  bookmarks.remove(id);
  pushBookmarks();
  pushState();
  scheduleSyncSoon();
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

// #23: password import must be reachable from the UI, not just the menu.
ipcMain.on('import-passwords', () => {
  if (!locked) importPasswordsCsv();
});

// #26: credentials manager IPC.
ipcMain.on('toggle-pw-panel', () => locked || togglePwPanel());
ipcMain.handle('creds-save', (_e, cred) => {
  if (locked) return false;
  const ok = credentials.upsert(cred || {});
  if (ok) pushCreds();
  return ok;
});
ipcMain.handle('creds-delete', (_e, id) => {
  if (locked) return false;
  const ok = credentials.removeById(String(id));
  if (ok) pushCreds();
  return ok;
});

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
    scheduleSyncSoon();
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
  setupAdblock(); // async — engine attaches to the session when ready
  createWindow();
  setupShortcuts();
  setupAutoUpdate();
  setInterval(syncBookmarks, 10 * 60 * 1000); // #13: periodic catch-up
});

app.on('before-quit', () => {
  clearInterval(fsPollTimer); // #20: never let the poll outlive the window
  fsPollTimer = null;
  saveSessionNow(); // flush any pending debounce
});
app.on('window-all-closed', () => app.quit());

// #20: a stray throw must never brick the browser in a modal-dialog storm —
// log it and keep running instead of Electron's default uncaught dialog.
process.on('uncaughtException', (err) => {
  console.error('webforge: uncaught exception', err);
});
