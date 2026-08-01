// WebForge Windows shell (#3, tabs #4, vertical tabs #8): a BaseWindow holding
// one chrome WebContentsView (ui/index.html: left tab sidebar + top nav bar)
// and one content WebContentsView per tab. The chrome view covers the WHOLE
// window; content views are inset (right of the sidebar, below the nav bar)
// and added after it, so they cover chrome's dead area. Only the active tab's
// view is visible. Full tab state is broadcast to the chrome UI on every
// change; it re-renders from that.
const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // #57: stable device id

// #38: two-finger back/forward on a precision touchpad is Chromium's
// "overscroll history navigation", which Electron ships DISABLED — that's why
// the gesture did nothing while mouse buttons and Alt+arrows worked. Must be
// set before app ready.
app.commandLine.appendSwitch(
  'enable-features',
  'OverscrollHistoryNavigation,TouchpadOverscrollHistoryNavigation'
);
const bookmarks = require('./bookmarks');
const vault = require('./vault');
const credentials = require('./credentials');
const hotkeys = require('./hotkeys');
const personas = require('./personas'); // #25
const errorlog = require('./errorlog'); // #75
const tabnav = require('./tabnav'); // #113/#114 — unit-tested, Electron-free
const textrules = require('./textrules'); // #100 — ditto

// #43: new tabs land on our own search page; Google is the default engine.
const ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
};
const NEWTAB_FILE = path.join(__dirname, 'ui', 'newtab.html');
// #40: WebForge's own pages open as ordinary tabs (no more full-window
// overlays fighting the view stack).
const INTERNAL_PAGES = {
  settings: path.join(__dirname, 'ui', 'settings.html'),
  manager: path.join(__dirname, 'ui', 'manager.html'),
  about: path.join(__dirname, 'ui', 'about.html'), // #61
  passwords: path.join(__dirname, 'ui', 'passwords.html'), // #63
  certerror: path.join(__dirname, 'ui', 'certerror.html'), // #108
  neterror: path.join(__dirname, 'ui', 'neterror.html'), // #108
  auth: path.join(__dirname, 'ui', 'auth.html'), // #111
};
const fileUrl = (p) => `file://${p.replace(/\\/g, '/')}`;
const isInternalUrl = (u) =>
  typeof u === 'string' && Object.values(INTERNAL_PAGES).some((p) => u.startsWith(fileUrl(p)));
const searchEngine = () => (ENGINES[getSettings().searchEngine] ? getSettings().searchEngine : 'google');
const newTabUrl = () => `file://${NEWTAB_FILE.replace(/\\/g, '/')}?e=${searchEngine()}`;
const isNewTabUrl = (u) => typeof u === 'string' && u.startsWith('file://') && u.includes('newtab.html');
// Keep in sync with ui/index.html's grid.
const SIDEBAR_W = 240;
const TOPBAR_H = 44;
const BM_PANEL_W = 280; // #11 bookmarks panel / #26 passwords panel, right side
const FIND_H = 38; // #101: find bar, docked under the nav bar
let bmPanelOpen = false;
let pwPanelOpen = false; // #26 — shares the right-panel slot with bookmarks
let findOpen = false; // #101

let win, chrome, lockView;
const tabs = new Map(); // id -> WebContentsView
let tabOrder = [];      // ids in sidebar order (pinned group first)
let activeId = null;
let nextTabId = 1;
const pinnedIds = new Set(); // #9
const hotkeyByTab = new Map(); // #16: tabId -> keyId (a tab per bound hotkey)
const faviconByTab = new Map(); // #45: tabId -> icon URL
const personaByTab = new Map(); // #25: tabId -> personaId
// #78: restored tabs stay unloaded until first activated — spawning a renderer
// and fetching a page for every saved tab is what made startup take seconds.
const lazyTabs = new Map(); // tabId -> { url, title }
// #114: tabs whose very first (deferred) load is in flight. Their did-navigate
// re-homes the tab but must not drag the active Persona along with it.
const firstLoad = new Set();
const lastActiveAt = new Map(); // #79: tabId -> ms, for inactivity expiry
// #101: Ctrl+Shift+T — closed tabs, most recent last. Capped so a long session
// can't grow it without bound; pinned tabs never reach here (closeTab refuses).
const closedTabs = [];
const CLOSED_STACK_MAX = 25;
let locked = true;           // #15: the app is a brick until the vault unlocks

// #25: switch persona — land on one of its tabs, creating one if it has none.
function switchPersona(personaId) {
  if (locked || !personas.get(personaId)) return;
  personas.setActive(personaId);
  const mine = tabOrder.filter((t) => (personaByTab.get(t) || personas.UNASSIGNED) === personaId);
  if (mine.length) {
    // #83: land on the tab you were last using in this Persona, not the first
    // in list order. NOTE: never blank activeId here — activateTab hides the
    // outgoing view through it, and nulling it left two views visible at once.
    const target = mine.includes(activeId)
      ? activeId
      : mine.reduce((best, id) => ((lastActiveAt.get(id) || 0) > (lastActiveAt.get(best) || 0) ? id : best), mine[0]);
    activateTab(target);
  } else {
    createTab(null, false, personaId);
  }
  broadcastHotkeys(); // #71: badges must follow the Persona's bindings
  pushState();
}

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
        url: lazyTabs.get(id)?.url || tabs.get(id).webContents.getURL(),
        title: lazyTabs.get(id)?.title || tabs.get(id).webContents.getTitle(), // #78
        pinned: pinnedIds.has(id),
        hotkey: hotkeyByTab.get(id) || null,
        persona: personaByTab.get(id) || personas.UNASSIGNED, // #25
        lastActiveAt: lastActiveAt.get(id) || Date.now(), // #79
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
  return ENGINES[searchEngine()] + encodeURIComponent(t); // #43
}

const activeWc = () => tabs.get(activeId)?.webContents;

function layout() {
  const { width, height } = win.getContentBounds();
  lockView?.setBounds({ x: 0, y: 0, width, height });
  const view = tabs.get(activeId);
  if (fullscreen) {
    // #14: the page owns every pixel; chrome collapses to the revealed
    // hover region (or nothing). #32: unless an overlay (bookmark dialog /
    // settings) is open — then chrome needs the full window to show it.
    view?.setBounds({ x: 0, y: 0, width, height });
    chrome.setBounds(
      bmDialogOpen || settingsOpen || managerOpen || bmPanelOpen || pwPanelOpen
        ? { x: 0, y: 0, width, height }
        : fsRegionBounds()
    );
    return;
  }
  chrome.setBounds({ x: 0, y: 0, width, height });
  if (view) {
    // #101: an open find bar takes a strip under the nav rather than floating
    // over the page — the page view is a separate native view and would draw
    // straight over anything the chrome painted in its region.
    const top = TOPBAR_H + (findOpen ? FIND_H : 0);
    view.setBounds({
      x: SIDEBAR_W,
      y: top,
      width: width - SIDEBAR_W - (bmPanelOpen || pwPanelOpen ? BM_PANEL_W : 0),
      height: height - top,
    });
  }
}

// --- #14: true fullscreen with hover-reveal edges ---
let fullscreen = false;
let fsRevealed = null; // 'tabs' | 'nav' | 'bookmarks' | null
let fsPollTimer = null;

function fsRegionBounds() {
  const { width, height } = win.getContentBounds();
  // #101: find beats a hover-reveal — you asked for the bar, so it stays put
  // until you close it, even as the mouse wanders off the top edge.
  if (findOpen) return { x: 0, y: 0, width, height: FIND_H };
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
  // #101: while the find bar owns the top strip, the hover-reveal stays out of
  // it — otherwise moving the mouse would swap the bar for the nav mid-search.
  if (findOpen) return;
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
    // #32: exiting fullscreen must put the page back above the full-window
    // chrome view, or the sidebar-less area renders as blank chrome.
    const view = tabs.get(activeId);
    if (view && !bmDialogOpen && !settingsOpen && !managerOpen) win.contentView.addChildView(view);
  }
  layout();
}

// #24: app settings — plain JSON in userData (sync-ready shape).
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settingsCache = null;
function getSettings() {
  if (!settingsCache) {
    try {
      settingsCache = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch {
      settingsCache = {};
    }
  }
  return settingsCache;
}
function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settingsCache));
  } catch {}
}
function applyTheme(theme) {
  // nativeTheme.themeSource drives prefers-color-scheme in every webContents,
  // so the chrome CSS reacts with no further wiring.
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
}

// #40: internal pages (settings, bookmark manager) are ORDINARY TABS now.
// Reuse the existing tab if one is already open rather than piling up copies.
const managerOpen = false; // overlays retired; kept false for the layout guards
const internalTabs = new Map(); // page -> tabId (authoritative; URLs race load)
function openInternalTab(page) {
  const target = INTERNAL_PAGES[page] && fileUrl(INTERNAL_PAGES[page]);
  if (!target) return;
  const known = internalTabs.get(page);
  if (known != null && tabs.has(known)) {
    activateTab(known);
    return;
  }
  // Fallback for tabs restored from a previous session (no id recorded yet).
  for (const id of tabOrder) {
    if (tabs.get(id).webContents.getURL().startsWith(target)) {
      internalTabs.set(page, id);
      activateTab(id);
      return;
    }
  }
  const id = createTab(target, false);
  if (id !== null) internalTabs.set(page, id);
}

function toggleBmManager() {
  openInternalTab('manager');
}

const settingsOpen = false; // #40: overlay retired — settings is a tab
function toggleSettings() {
  openInternalTab('settings');
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

// --- #101: find in page (Ctrl+F) ---
// The bar lives in the chrome UI; main owns the state because layout() has to
// give it room and Electron's find API hangs off the page's webContents.
function openFind() {
  if (locked) return;
  const wasOpen = findOpen;
  findOpen = true;
  // In fullscreen the page owns every pixel and chrome sits underneath it —
  // raise chrome or the bar is invisible while very much capturing your keys.
  if (fullscreen) {
    win.contentView.addChildView(chrome);
    // The chrome renderer lays itself out from data-fs; without this it would
    // try to draw the whole sidebar-and-nav grid into a 38px-tall viewport.
    chrome.webContents.send('fs-mode', 'find');
  }
  chrome.webContents.send('find-bar', { open: true, refocus: !wasOpen });
  layout();
  chrome.webContents.focus();
}

function closeFind({ refocus = true } = {}) {
  if (!findOpen) return;
  findOpen = false;
  activeWc()?.stopFindInPage('clearSelection');
  chrome.webContents.send('find-bar', { open: false });
  if (fullscreen) chrome.webContents.send('fs-mode', fsRevealed);
  layout();
  // Hand the top of the screen back to the page we borrowed it from.
  if (fullscreen && !fsRevealed) {
    const view = tabs.get(activeId);
    if (view) win.contentView.addChildView(view);
  }
  if (refocus) activeWc()?.focus();
}

function runFind(text, { forward = true, again = false } = {}) {
  const wc = activeWc();
  if (!wc) return;
  if (!text) {
    // Emptying the box clears the highlights instead of searching for "".
    wc.stopFindInPage('clearSelection');
    chrome.webContents.send('find-result', { matches: 0, active: 0 });
    return;
  }
  wc.findInPage(text, { forward, findNext: again });
}

// #29: starring opens a dialog (title + folder picker) instead of instantly
// toggling; re-starring an existing bookmark opens it prefilled for editing.
let bmDialogOpen = false;
function setChromeRaised(on) {
  if (on) {
    win.contentView.addChildView(chrome);
  } else {
    const view = tabs.get(activeId);
    if (view) win.contentView.addChildView(view);
  }
}

// #37: overlays and the fullscreen hover-reveal fight over the chrome view's
// CSS mode — clear any active reveal before showing an overlay.
function clearFsReveal() {
  if (!fsRevealed) return;
  fsRevealed = null;
  chrome.webContents.send('fs-mode', null);
}

function openBookmarkDialog(prefill) {
  bmDialogOpen = true;
  clearFsReveal();
  setChromeRaised(true);
  pushBookmarks(); // dialog needs the folder list
  chrome.webContents.send('bm-edit', prefill);
  layout(); // #32: in fullscreen, chrome must expand to show the dialog
  chrome.webContents.focus();
}

function closeBookmarkDialog() {
  if (!bmDialogOpen) return;
  bmDialogOpen = false;
  if (!settingsOpen && !managerOpen) setChromeRaised(false);
  chrome.webContents.send('bm-edit', null);
  layout(); // #32: re-collapse chrome if we're fullscreen
  activeWc()?.focus();
}

function starCurrent() {
  const wc = activeWc();
  const url = wc?.getURL();
  if (!url) return;
  const existing = bookmarks.all().find((b) => b.url === url);
  openBookmarkDialog({
    id: existing?.id || null,
    title: existing?.title || wc.getTitle() || url,
    url,
    folder: existing?.folder || '',
    exists: Boolean(existing),
    claim: personas.claimFor(url), // #70
    personas: orderedPersonas().map((p) => ({ id: p.id, name: p.name })),
  });
}

function visibleTabs() {
  // #25: the sidebar only ever shows the ACTIVE persona's tabs.
  const active = personas.activeId();
  return tabOrder.filter((id) => (personaByTab.get(id) || personas.UNASSIGNED) === active);
}

function tabState() {
  return visibleTabs().map((id) => {
    const wc = tabs.get(id).webContents;
    const pending = lazyTabs.get(id); // #78: not loaded yet — use saved values
    const rawUrl = pending ? pending.url : wc.getURL();
    const isNew = isNewTabUrl(rawUrl); // #43: don't surface the file:// path
    const internal = isInternalUrl(rawUrl)
      ? rawUrl.includes('settings.html') ? 'Settings'
        : rawUrl.includes('about.html') ? 'About'
        : rawUrl.includes('passwords.html') ? 'Saved logins'
        : 'Bookmarks'
      : null;
    return {
      id,
      title:
        internal ||
        (isNew ? 'New tab' : (pending ? pending.title : wc.getTitle()) || rawUrl || 'New tab'),
      url: isNew || internal ? '' : rawUrl,
      loading: wc.isLoading(),
      active: id === activeId,
      pinned: pinnedIds.has(id),
      hotkey: hotkeyByTab.get(id) || null,
      favicon: faviconByTab.get(id) || null, // #45
      starred: bookmarks.has(wc.getURL()),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  });
}

// #71: Unassigned is the fallback, not a destination — put it last so the
// Personas you actually use get Ctrl+Space 1, 2, 3. Display and the digit
// shortcuts share this ordering so the numbers you see are the numbers you press.
function orderedPersonas() {
  const list = personas.all();
  return [
    ...list.filter((p) => p.id !== personas.UNASSIGNED),
    ...list.filter((p) => p.id === personas.UNASSIGNED),
  ];
}

// #57: other devices' tabs in the Persona we're currently looking at.
function remoteTabsForActive() {
  const active = personas.activeId();
  const out = [];
  for (const [id, dev] of Object.entries(remoteDevices)) {
    const list = (dev.personas || {})[active] || [];
    if (list.length) out.push({ device: dev.name || id, at: dev.at || 0, tabs: list.slice(0, 40) });
  }
  return out;
}

function pushPersonas() {
  if (!chrome) return;
  const active = personas.activeId();
  chrome.webContents.send('personas-updated', {
    personas: orderedPersonas().map((p) => ({
      id: p.id,
      name: p.name,
      builtin: Boolean(p.builtin),
      rules: p.rules,
    })),
    active,
  });
}

// #78: a loading page fires start/stop/title/favicon/navigate in quick
// succession, and each one rebuilt and shipped the whole tab list. Coalesce.
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushStateNow();
  }, 40);
}

function pushStateNow() {
  if (!chrome) return;
  pushPersonas(); // #25
  chrome.webContents.send('tabs-updated', tabState());
  chrome.webContents.send('remote-tabs', remoteTabsForActive()); // #57
  const wc = activeWc();
  const title = wc?.getTitle();
  win.setTitle(title ? `${title} — WebForge` : 'WebForge');
  saveSessionSoon();
}

// #111 round 2: which window.open() calls deserve a real window.
//
// The first attempt keyed only on `disposition === 'new-window'` and did not fix
// the reported page. Chromium only reports 'new-window' when the features string
// asks for a popup — `window.open(url, 'authWindow')` with NO features is
// reported as a plain foreground-tab, so it kept being denied, kept returning
// null, and kept breaking the page that needed the handle.
//
// A NAMED window is the giveaway: nobody names a window they do not intend to
// address later. `_blank` is excluded because that is just "open a tab".
function wantsRealWindow(details) {
  if (details.disposition === 'new-window') return true;
  if (details.features && String(details.features).trim().length > 0) return true;
  const name = String(details.frameName || '').trim();
  return name.length > 0 && !['_blank', '_self', '_parent', '_top'].includes(name);
}

// #111: translate a window.open() features string into BrowserWindow options.
// Sizes are clamped — a page asking for a 20×20 or 9000px window gets something
// usable instead. Web preferences deliberately match a normal tab: the page
// preload, no node integration, context isolation on. A popup is web content
// and must never be more privileged than the tab that opened it.
function popupWindowOptions(features) {
  const parsed = {};
  for (const part of String(features || '').split(',')) {
    const [key, value] = part.split('=').map((s) => (s || '').trim());
    if (key) parsed[key.toLowerCase()] = value;
  }
  const num = (key, min, max, fallback) => {
    const n = parseInt(parsed[key], 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    width: num('width', 240, 2400, 900),
    height: num('height', 180, 1600, 700),
    autoHideMenuBar: true,
    show: false, // shown in did-create-window, after ready-to-show
    // #111 round 2: the likely reason the first fix looked like nothing
    // happened. The app always launches fullscreen (#37), and an unparented
    // window can be created BEHIND a fullscreen one — indistinguishable from
    // never opening. A child window always renders above its parent.
    // `parent` accepts a BaseWindow (BrowserWindowConstructorOptions extends
    // BaseWindowConstructorOptions), which is what `win` is.
    // Deliberately NOT modal: a terminal popup must stay usable alongside the
    // page that launched it.
    parent: win,
    webPreferences: {
      preload: path.join(__dirname, 'content-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  };
}

function createTab(url = null, background = false, personaId = null, opts = {}) {
  if (locked) return null; // #15
  const id = nextTabId++;
  if (!url) url = newTabUrl(); // #43: default landing page is our search page
  const lazy = Boolean(opts.lazy);
  if (lazy) lazyTabs.set(id, { url, title: opts.title || url }); // #78
  lastActiveAt.set(id, opts.lastActiveAt || Date.now()); // #79
  openedAt.set(id, opts.openedAt || Date.now()); // #57
  // #96: URL RULES DECIDE FIRST. An explicitly-passed persona (session restore,
  // a tab adopted from another device) used to win, so a Gerrit tab could be
  // created as Unassigned and only jump to Work when it first navigated —
  // which looked like tabs re-homing themselves when you clicked them.
  const claimed = personas.forUrl(url);
  personaByTab.set(id, claimed !== personas.UNASSIGNED ? claimed : personaId || personas.UNASSIGNED);
  // #95: this URL is open again, so stop publishing "closed" for it — otherwise
  // the other device keeps being told to kill a tab that is sitting right here.
  closedFacts.delete(url);
  const view = new WebContentsView({
    // #41: hotkeys fire from the main process now (Ctrl+Space leader), so no
    // page-side key capture — and no need for subframe node integration (#39).
    // #40: our own pages get the privileged bridge; web content never does.
    webPreferences: {
      preload: isInternalUrl(url)
        ? path.join(__dirname, 'internal-preload.js')
        : path.join(__dirname, 'content-preload.js'),
    },
  });
  tabs.set(id, view);
  tabOrder.push(id);

  const wc = view.webContents;
  // Popups (window.open / target=_blank) become tabs, never OS windows.
  // #30: they open FOREGROUND — clicking a link that spawns a tab should put
  // you in that tab (matches every mainstream browser; reverses #4's call).
  // #31: same URL already open → focus that tab instead of spawning a dupe.
  // #111: a deliberate popup — window.open() WITH features — becomes a real
  // window. Denying it made window.open() return null, so any page that kept
  // the handle (`w.document.write(...)`, `w.focus()`, `w.location = …`) threw on
  // the next line and its flow died: that is why credential prompts and terminal
  // launchers produced nothing at all. target=_blank still becomes a tab (#30).
  wc.setWindowOpenHandler((details) => {
    const real = wantsRealWindow(details);
    // #111 round 2: log every decision. The first fix keyed only on
    // disposition === 'new-window' and did not work, and there is no Windows
    // machine here to observe on — so the app has to say what it decided.
    errorlog.record(
      'window-open',
      `decision=${real ? 'window' : 'tab'} disposition=${details.disposition} ` +
        `frameName="${details.frameName}" features="${details.features}" ` +
        `fullscreen=${fullscreen} url=${details.url}`
    );
    if (real) {
      return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(details.features) };
    }
    openOrFocus(details.url, false);
    return { action: 'deny' };
  });
  // #111: popups are web content too — same chords, and the #108 error pages
  // instead of another blank rectangle when one fails to load.
  wc.on('did-create-window', (child) => {
    const cwc = child.webContents;
    wireChords(cwc); // #22
    wireLoadFailures(cwc); // #108
    child.setMenu(null); // a popup has no business showing our app menu
    // #111 round 2: the app ALWAYS launches fullscreen (#37), and a popup that
    // opens behind a fullscreen window looks exactly like a popup that never
    // opened. `parent` (set in popupWindowOptions) keeps it above the main
    // window; this is the belt to that pair of braces.
    child.once('ready-to-show', () => {
      child.show();
      child.moveTop();
      child.focus();
    });
  });
  // #33: hotkey tabs are STICKY — page-initiated navigation (link clicks)
  // opens elsewhere instead of navigating the hotkey tab away. Programmatic
  // loads (hotkey go-home, address bar, bookmarks) don't fire will-navigate,
  // so they still steer this tab. Known caveat: form submissions are
  // indistinguishable from link clicks here.
  wc.on('will-navigate', (event, navUrl) => {
    if (hotkeyByTab.has(id)) {
      event.preventDefault();
      openOrFocus(navUrl, false);
    }
  });
  // #33 round 4 — the invariant the user actually asked for: a hotkey tab is
  // ONLY ever its own site. Clicks are cancelled at the source by
  // content-preload.js and will-navigate covers plain navigations, but SPA
  // routers can still slip a pushState past both. This is the last line of
  // defence: any drift off home gets re-homed and the destination becomes its
  // own tab. Guarded so the re-home can't re-trigger itself.
  let reHoming = false;
  const enforceHome = (navUrl, isMainFrame) => {
    if (isMainFrame === false || reHoming || locked) return;
    const keyId = hotkeyByTab.get(id);
    if (!keyId) return;
    // #78: resolve in THIS tab's Persona. Calling hotkeys.get(keyId) with no
    // Persona was a leftover from #25 and read the Unassigned bucket.
    const home = hotkeys.get(keyId, personaByTab.get(id))?.url;
    if (!home) return;
    // #78: only enforce across ORIGINS. Comparing full URLs livelocked the
    // app: a home that redirects (login, /dashboard -> /dashboard/self) or an
    // SPA firing did-navigate-in-page kept tripping this, and each cycle
    // re-loaded home and re-triggered the redirect — several times a second,
    // for ever. Link clicks are already caught in-page by content-preload.
    const originOf = (u) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    const from = originOf(navUrl);
    const to = originOf(home);
    if (!from || !to || from === to) return;
    reHoming = true;
    openOrFocus(navUrl, false);
    wc.loadURL(home);
    setTimeout(() => {
      reHoming = false;
    }, 800);
  };
  wc.on('did-navigate', (_e2, navUrl) => enforceHome(navUrl, true));
  wc.on('did-navigate-in-page', (_e2, navUrl, isMainFrame) => enforceHome(navUrl, isMainFrame));
  for (const ev of [
    'did-navigate',
    'did-navigate-in-page',
    'page-title-updated',
    'did-start-loading',
    'did-stop-loading',
  ]) {
    wc.on(ev, pushState);
  }
  wc.on('page-favicon-updated', (_e2, icons) => { // #45
    if (icons?.length) {
      faviconByTab.set(id, icons[0]);
      pushState();
    }
  });
  wc.on('did-navigate', (_e2, navUrl) => {
    // Re-home the tab if it navigated into another persona's territory (#25).
    const claimed = personas.forUrl(navUrl);
    const current = personaByTab.get(id);
    // #114: the first load of a lazily-restored tab is not the user navigating
    // anywhere — following it switched Persona under a cycling user.
    const wasFirstLoad = firstLoad.delete(id);
    if (claimed !== personas.UNASSIGNED && claimed !== current) {
      personaByTab.set(id, claimed);
      if (id === activeId && !wasFirstLoad) personas.setActive(claimed);
      pushState();
    }
  });
  // #101: findInPage results come back asynchronously per webContents; only the
  // active tab's may reach the bar, or a background tab still settling would
  // overwrite the count you are looking at.
  wc.on('found-in-page', (_e2, result) => {
    if (id !== activeId || !findOpen) return;
    chrome?.webContents.send('find-result', {
      matches: result.matches,
      active: result.activeMatchOrdinal,
    });
  });
  // #100: right-click a matching selection. WebForge has no context menu at all
  // today, so this shows one ONLY when a rule matches — right-click stays inert
  // otherwise, exactly as before. (A general context menu with copy/paste is
  // worth having, but that is its own ticket, not a rider on this one.)
  wc.on('context-menu', (_e2, params) => {
    if (locked) return;
    const hit = textrules.resolve(params.selectionText, textRules());
    if (!hit) return;
    const label = hit.rule.name ? `Open ${hit.matched} in ${hit.rule.name}` : `Open ${hit.matched}`;
    Menu.buildFromTemplate([
      { label, click: () => openFromSelection(params.selectionText) },
    ]).popup({ window: win });
  });
  wireLoadFailures(wc); // #108 — also applied to popups by #111
  wc.on('did-finish-load', () => tryAutofill(wc)); // #12
  wc.on('dom-ready', () => {
    wc.send('sticky-mode', hotkeyByTab.has(id)); // #33
    // #36 round 2: hide scrollbars on PAGES too (user: "most certainly not
    // gone") — scrolling itself is untouched.
    wc.insertCSS(
      '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}'
    ).catch(() => {});
  });
  wireChords(wc); // #22

  win.contentView.addChildView(view);
  view.setVisible(false);
  if (!lazy) wc.loadURL(url); // #78: lazy tabs load on first activation
  if (background && activeId !== null) pushState();
  else activateTab(id);
  return id;
}

function activateTab(id, opts = {}) {
  if (!tabs.has(id)) {
    errorlog.record('activateTab', new Error(`no such tab id=${id} (known: ${[...tabs.keys()].join(',')})`));
    return;
  }
  // #101: close the find bar before activeId moves, so stopFindInPage lands on
  // the tab that was actually searched and its highlights don't linger.
  if (findOpen) closeFind({ refocus: false });
  const owner = personaByTab.get(id) || personas.UNASSIGNED;
  if (owner !== personas.activeId()) personas.setActive(owner); // #25
  const leaving = activeId; // #82 — must be captured BEFORE the reassignment
  // #83: hide every other view, not just the outgoing one. Relying on a single
  // setVisible(false) meant any missed bookkeeping left two views stacked and
  // z-order picked the winner — the 'wrong tab' the user was seeing.
  for (const [tid, v] of tabs) {
    if (tid !== id) v.setVisible(false);
  }
  activeId = id;
  const view = tabs.get(id);
  lastActiveAt.set(id, Date.now()); // #79: expiry is measured from last use
  const pending = lazyTabs.get(id); // #78
  if (pending) {
    lazyTabs.delete(id);
    // #114: a restored tab loading for the FIRST time fires did-navigate, which
    // re-homes it by Persona rule — and that used to call personas.setActive,
    // swapping the whole visible tab set out mid-cycle. Re-homing the tab is
    // right; dragging the workspace along because a background tab finally
    // loaded is not. The tab still moves; only the follow is suppressed.
    firstLoad.add(id);
    view.webContents.loadURL(pending.url);
  }
  view.setVisible(true);
  // #32: overlay raises leave chrome stacked above content, whose empty
  // region then covers the page ("black tabs"). Keep the active view on top
  // whenever no chrome overlay is meant to be showing.
  if (!fsRevealed && !bmDialogOpen && !settingsOpen && !managerOpen) {
    win.contentView.addChildView(view);
  }
  layout();
  // #30: keyboard focus MUST follow activation — if it stays on a hidden view
  // (or nothing), key events vanish and hotkey swapping "stops working".
  view.webContents.focus();
  // #82: dispose of the new tab we just walked away from.
  // #114: but NOT while cycling. Deleting a tab mid-cycle shifts every index
  // after it, so the next Ctrl+Tab press stepped from a stale position and
  // landed somewhere unrelated. Disposal is right for a deliberate switch and
  // wrong while touring tabs.
  if (!opts.cycling && leaving !== null && leaving !== id && tabs.has(leaving) && isUnusedNewTab(leaving)) {
    closeTab(leaving);
  }
  pushState();
}

function closeTab(id, opts = {}) {
  const view = tabs.get(id);
  if (!view) return;
  if (pinnedIds.has(id)) return; // #9: pinned tabs don't close — unpin first
  // #57: a close is a fact other devices must learn about — unless we're only
  // applying someone else's close, which must not echo back.
  if (!opts.remote) {
    const url = tabUrlOf(id);
    if (shareable(url)) {
      closedFacts.set(url, Date.now());
      setTimeout(syncTabs, 400); // #95: propagate the close right away
      // #101: remember it for Ctrl+Shift+T. shareable() already screens out
      // new-tab and internal file:// pages, which nobody wants to "reopen",
      // and remote closes are excluded so another device can't stuff our stack.
      closedTabs.push({ url, personaId: personaByTab.get(id) || null });
      if (closedTabs.length > CLOSED_STACK_MAX) closedTabs.shift();
    }
  }
  const idx = tabOrder.indexOf(id);
  tabs.delete(id);
  hotkeyByTab.delete(id); // #16: the binding survives; only the open tab dies
  faviconByTab.delete(id);
  personaByTab.delete(id);
  lazyTabs.delete(id);
  lastActiveAt.delete(id);
  openedAt.delete(id);
  for (const [page, tid] of internalTabs) if (tid === id) internalTabs.delete(page);
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
    // #95: tabUrlOf, not getURL() — a lazily-restored tab (#78) has an empty
    // webContents URL until it is first shown, so it was invisible here. Tab
    // adoption then re-created it every sync, and clicking a bookmark for a
    // restored-but-unopened tab opened a second copy.
    if (tabUrlOf(id) === url) return id;
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

// --- #101: the browser basics that were never wired ---

// Ctrl+Shift+R. The existing Ctrl+R / F5 call .reload(), which honours the HTTP
// cache — there was no way to bypass it at all.
function hardReload() {
  if (locked) return;
  activeWc()?.reloadIgnoringCache();
}

// Ctrl+= / Ctrl+- / Ctrl+0. Electron zoom levels are 1.2^level, so ±1 a step
// lands close to Chrome's 120% / 144% ladder. Clamped to roughly 40%–250%.
const ZOOM_MIN = -5;
const ZOOM_MAX = 5;
function zoomBy(delta) {
  const wc = activeWc();
  if (!wc || locked) return;
  const next = delta === 0 ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, wc.getZoomLevel() + delta));
  wc.setZoomLevel(next);
}

// Ctrl+P. Electron's print() throws rather than rejecting on some Windows
// configurations, so it is guarded — a missing printer must not kill the app.
function printPage() {
  if (locked) return;
  try {
    activeWc()?.print({}, () => {});
  } catch (err) {
    errorlog.record('print', err);
  }
}

// Ctrl+U. view-source: only means anything for real web pages; running it on
// our own file:// chrome pages would just expose the app's internals.
function viewSource() {
  if (locked) return;
  const url = activeWc()?.getURL();
  if (!url || !/^https?:\/\//i.test(url)) return;
  createTab(`view-source:${url}`, false);
}

// Ctrl+Shift+T. Walks back through recently closed tabs, most recent first.
function reopenClosedTab() {
  if (locked) return;
  const last = closedTabs.pop();
  if (!last) return;
  createTab(last.url, false, last.personaId);
}

function cycleTab(dir) {
  // #75: cycle within the ACTIVE Persona only — walking the global tabOrder
  // jumped into other Personas' tabs and yanked the workspace out from under
  // the user, which reads as "Ctrl+Tab does nothing sensible".
  const next = tabnav.nextInOrder(visibleTabs(), activeId, dir);
  if (next === null) return;
  // #114: `cycling` stops activateTab from destroying the tab we are stepping
  // off. Without it, every step off a new-tab page removed an entry from
  // tabOrder and the NEXT press computed its position against a shorter list —
  // which is what made Ctrl+Tab jump around instead of stepping in order.
  activateTab(next, { cycling: true });
}

// #113: Ctrl+Tab as Alt+Tab — flip to the most recently used OTHER tab, so two
// tabs you are working between stay one keystroke apart no matter where they sit
// in the sidebar. Resolves by identity rather than position, so it is immune to
// the list shifting (#114).
function flipTab() {
  // visibleTabs() keeps this inside the active Persona (#75). lastActiveAt is
  // already maintained for idle-tab expiry (#79) and updated on every
  // activation, so it is an accurate most-recently-used ordering for free.
  const target = tabnav.mostRecent(visibleTabs(), activeId, lastActiveAt);
  if (target === null) return;
  activateTab(target, { cycling: true });
}

// #22: navigation-critical chords intercepted at the input level on every
// webContents — menu accelerators are unreliable for Ctrl+Tab on Windows,
// and this works regardless of which view has focus.
// #41: leader-key hotkey mode — Ctrl+Space arms a 3s window; the next
// non-modifier key fires its hotkey binding. Replaces bare-key firing.
let leaderUntil = 0;

// #41 round 2: arm the leader from a globalShortcut while our window is
// focused. before-input-event only reaches a view that HAS keyboard focus, so
// when focus sat nowhere (chrome dead space, overlay just closed) the chord
// was silently missed. Registered on focus / released on blur so it never
// takes Ctrl+Space away from other apps.
function armLeader() {
  if (locked) return;
  leaderUntil = leaderUntil > Date.now() ? 0 : Date.now() + 3000; // toggle
  // Make sure SOMETHING focused hears the next key.
  if (leaderUntil) (managerOpen || settingsOpen ? chrome.webContents : activeWc())?.focus();
}

function wireLeaderShortcut() {
  const { globalShortcut } = require('electron');
  const register = () => {
    try {
      if (!globalShortcut.isRegistered('Control+Space')) {
        globalShortcut.register('Control+Space', armLeader);
      }
    } catch {}
  };
  const release = () => {
    try {
      globalShortcut.unregister('Control+Space');
    } catch {}
  };
  win.on('focus', register);
  win.on('blur', release);
  app.on('will-quit', release);
  if (win.isFocused()) register();
}

// #42: Esc closes the topmost open thing, from wherever focus happens to be.
function handleEscape() {
  if (findOpen) return closeFind(); // #101: the find bar is the topmost thing
  if (bmDialogOpen) return closeBookmarkDialog();
  if (bmPanelOpen) return toggleBookmarksPanel();
  if (pwPanelOpen) return togglePwPanel();
  if (fsRevealed) {
    clearFsReveal();
    layout();
  }
}

function wireChords(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const rawKey = input.key || '';
    if (input.control && !input.alt && !input.meta && (rawKey === ' ' || rawKey.toLowerCase() === 'space')) {
      event.preventDefault();
      armLeader(); // globalShortcut usually beats us here; harmless either way
      return;
    }
    if (leaderUntil > Date.now()) {
      if (['control', 'shift', 'alt', 'meta'].includes(rawKey.toLowerCase())) return;
      event.preventDefault();
      leaderUntil = 0;
      if (rawKey.toLowerCase() === 'escape' || locked) return;
      // #25: bare digits switch Persona (reserved — see hotkeys.set).
      if (/^[1-9]$/.test(rawKey) && !input.control && !input.alt) {
        const list = orderedPersonas();
        const target = list[Number(rawKey) - 1];
        if (target) switchPersona(target.id);
        return;
      }
      handleHotkeyPress((input.control ? 'Ctrl+' : '') + (input.alt ? 'Alt+' : '') + rawKey);
      return;
    }
    // #32: F11 at the input level — the menu accelerator only fired reliably
    // on a maximized window.
    if (rawKey.toLowerCase() === 'f11' && !input.control && !input.alt && !input.meta) {
      event.preventDefault();
      if (!locked) setFullscreenMode(!fullscreen);
      return;
    }
    if (rawKey.toLowerCase() === 'escape' && !input.control && !input.alt && !input.meta) {
      if (!locked) handleEscape(); // #42 — don't preventDefault: pages use Esc too
      return;
    }
    // #38: Alt+Left/Right — the browser-standard back/forward I never wired.
    if (input.alt && !input.control && !input.meta) {
      const k = rawKey.toLowerCase();
      // #68: Alt+F4 was being eaten before it reached Windows' close path.
      // Own it here so it always works; before-quit flushes the session.
      if (k === 'f4') {
        event.preventDefault();
        win.close();
        return;
      }
      if (k === 'arrowleft') {
        event.preventDefault();
        activeWc()?.navigationHistory.goBack();
      } else if (k === 'arrowright') {
        event.preventDefault();
        activeWc()?.navigationHistory.goForward();
      }
      return;
    }
    if (!input.control || input.alt || input.meta) return;
    const key = rawKey.toLowerCase();
    // #101: Ctrl+Shift+Left/Right is the standard word-wise text-selection
    // chord and used to be swallowed here for back/forward (#38). Stealing it
    // meant selection could not work in WebForge at all. Alt+Left / Alt+Right
    // above are the browser-standard back/forward and still do the job, so the
    // binding was pure duplication. Deliberately NOT handled — let it through.
    if (key === 'tab') {
      event.preventDefault();
      // #113: Ctrl+Tab flips between the two most recently used tabs, the way
      // Alt+Tab does; Ctrl+Shift+Tab steps to the next tab in sidebar order.
      // "Previous tab" is deliberately gone — Ctrl+PageUp still walks backwards.
      if (input.shift) cycleTab(1);
      else flipTab();
    } else if (key === 'f4') {
      event.preventDefault();
      closeTab(activeId);
    } else if (key === 'pagedown') {
      event.preventDefault();
      cycleTab(1);
    } else if (key === 'pageup') {
      event.preventDefault();
      cycleTab(-1);
    }
  });
}

// #9: pinned tabs.
function togglePin(id) {
  if (!tabs.has(id)) return;
  if (pinnedIds.has(id)) pinnedIds.delete(id);
  else pinnedIds.add(id);
  sortTabOrder();
  pushState();
}

function closeNormalTabs() {
  const doomed = tabOrder.filter((id) => !pinnedIds.has(id) && !hotkeyByTab.has(id));
  for (const id of doomed) closeTab(id); // closeTab handles activation/last-tab
}

// --- #16: hotkey tabs ---

// #33: tell each tab whether it's a sticky hotkey tab (drives the preload's
// click interception). Call after anything that changes hotkeyByTab.
function pushStickyModes() {
  for (const [tid, view] of tabs) {
    view.webContents.send('sticky-mode', hotkeyByTab.has(tid));
  }
}

function broadcastHotkeys() {
  // #41: tabs no longer need the bound-key list (firing is leader-driven in
  // main); chrome still needs the map for badges and the binding UX.
  // #25: bindings are scoped to the active persona.
  chrome?.webContents.send('hotkeys-updated', hotkeys.all(personas.activeId()));
}

function tabForHotkey(keyId) {
  // #71: scoped to the ACTIVE persona. A flat lookup found another Persona's
  // tab bound to the same key and dragged the user over to it, which is what
  // made per-Persona hotkeys look broken.
  const active = personas.activeId();
  for (const [tid, kid] of hotkeyByTab) {
    if (kid === keyId && (personaByTab.get(tid) || personas.UNASSIGNED) === active) return tid;
  }
  return null;
}

function handleHotkeyPress(keyId) {
  if (locked) return;
  const entry = hotkeys.get(keyId, personas.activeId()); // #25
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
    // #71: honour a routing rule when one claims this URL, otherwise keep the
    // tab in the Persona the user is actually working in — landing it in
    // Unassigned would switch them out from under their own hotkey.
    const claimed = personas.forUrl(entry.url);
    const owner = claimed === personas.UNASSIGNED ? personas.activeId() : claimed;
    const newId = createTab(entry.url, false, owner);
    if (newId !== null) {
      hotkeyByTab.set(newId, keyId);
      sortTabOrder();
      pushStickyModes(); // #33
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
  pushStickyModes(); // #33
  pushState();
}

function createWindow() {
  win = new BaseWindow({
    width: 1280,
    height: 840,
    title: 'WebForge',
    fullscreen: true, // #37: always launch fullscreen (user decision)
    // #7: match the chrome theme so resize flashes aren't white in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f2f2f4',
  });
  fullscreen = true;
  fsPollTimer = setInterval(fsPoll, 150); // edge-reveal live from launch

  // #38: mouse XButton1/XButton2 + touchpad back/forward gestures.
  win.on('app-command', (_e, cmd) => {
    if (locked) return;
    if (cmd === 'browser-backward') activeWc()?.navigationHistory.goBack();
    if (cmd === 'browser-forward') activeWc()?.navigationHistory.goForward();
  });
  wireLeaderShortcut(); // #41
  win.on('blur', () => closeStrayNewTabs()); // #82: Alt+Tab away disposes of it

  chrome = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.contentView.addChildView(chrome);
  chrome.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Chrome renders from pushed state; re-push once it's ready to receive.
  chrome.webContents.on('did-finish-load', pushState);
  chrome.webContents.on('did-finish-load', pushTabGroups); // #34
  wireChords(chrome.webContents); // #22

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
    // Off-VPN / corporate-proxy safety: the filter-list CDN may be blocked or
    // black-holed, and a bare fetch would hang indefinitely. The cached engine
    // in userData is used first, so this only matters on a cold cache.
    const timedFetch = (url, opts = {}) =>
      fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    const blocker = await ElectronBlocker.fromPrebuiltFull(timedFetch, {
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
const PERSONA_SYNC_URL = 'http://100.69.184.113:8013/store/personas'; // #88
const TABS_SYNC_URL = 'http://100.69.184.113:8013/store/tabs'; // #57
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

// #88: Persona definitions are shared with the phone; which one is *active*
// stays per-device. Last-write-wins on the definition set, like bookmarks.
let personaSyncing = false;
async function syncPersonas() {
  if (personaSyncing) return;
  personaSyncing = true;
  try {
    const localAt = personas.updatedAt();
    const res = await fetch(PERSONA_SYNC_URL, { signal: AbortSignal.timeout(5000) });
    const remote = await res.json();
    const remoteAt = remote.updatedAt || 0;
    if (remoteAt > localAt && Array.isArray(remote.data) && remote.data.length) {
      personas.replaceAll(remote.data, remoteAt);
      for (const tid of tabOrder) {
        personaByTab.set(tid, personas.forUrl(tabs.get(tid).webContents.getURL()));
      }
      pushState();
    } else if (localAt > remoteAt) {
      await fetch(PERSONA_SYNC_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: personas.all(), updatedAt: localAt }),
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch {
    // off the tailnet — local definitions stand
  } finally {
    personaSyncing = false;
  }
}

// #57: cross-device tabs. Each device publishes its own per-Persona tab list
// under a stable device id; every device reads the others'. Phase 1 is
// deliberately NON-DESTRUCTIVE — a remote close never closes anything here.
// Full mirroring comes once the undo / recently-closed net exists, because a
// mis-tap on the phone would otherwise destroy a desktop tab irrecoverably.
function deviceId() {
  const s = getSettings();
  if (!s.deviceId) {
    s.deviceId = `win-${crypto.randomUUID().slice(0, 8)}`;
    saveSettings();
  }
  return s.deviceId;
}

let remoteDevices = {}; // deviceId -> { name, personas: {pid: [{url,title}]}, at }
let tabsSyncing = false;

// #57 phase 2: state changes are timestamped FACTS, never snapshots — a
// snapshot can't tell "you closed it" from "I opened it while offline".
const openedAt = new Map();      // tabId -> ms this tab was opened here
const closedFacts = new Map();   // url -> ms we closed it (tombstone to publish)
const recentlyClosed = [];       // #57: anything a REMOTE instruction closed
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;

function tabUrlOf(id) {
  const pending = lazyTabs.get(id);
  return pending ? pending.url : tabs.get(id)?.webContents.getURL() || '';
}

function shareable(url) {
  return Boolean(url) && !isNewTabUrl(url) && !isInternalUrl(url);
}

function localTabPayload() {
  const byPersona = {};
  for (const id of tabOrder) {
    const url = tabUrlOf(id);
    if (!shareable(url)) continue;
    const pid = personaByTab.get(id) || personas.UNASSIGNED;
    const pending = lazyTabs.get(id);
    (byPersona[pid] ||= {}).open ||= {};
    byPersona[pid].open[url] = {
      title: pending ? pending.title : tabs.get(id).webContents.getTitle() || url,
      at: openedAt.get(id) || Date.now(),
      dev: deviceId(),
    };
  }
  // our tombstones ride along so other devices learn about closes
  const cutoff = Date.now() - TOMBSTONE_TTL;
  for (const [url, at] of closedFacts) {
    if (at < cutoff) {
      closedFacts.delete(url);
      continue;
    }
    const pid = personas.forUrl(url);
    (byPersona[pid] ||= {}).closed ||= {};
    byPersona[pid].closed[url] = at;
  }
  return byPersona;
}

/**
 * #57: apply the merged view. A URL is open iff its open stamp beats its
 * tombstone. Never touches the tab you're on, pinned tabs or hotkey tabs.
 */
function applyRemoteTabState(merged) {
  // #95: every Persona, not just the active one. Scoping this to `merged[active]`
  // meant background workspaces sat frozen — they neither adopted nor closed
  // anything until you happened to switch to them. Tombstones are flattened
  // across Personas too, because a URL is a URL and Persona ids are the one
  // thing that genuinely does diverge between devices.
  const closedAnywhere = new Map();
  for (const block of Object.values(merged)) {
    for (const [url, at] of Object.entries(block.closed || {})) {
      if (at > (closedAnywhere.get(url) || 0)) closedAnywhere.set(url, at);
    }
  }

  for (const id of [...tabOrder]) {
    const url = tabUrlOf(id);
    if (!shareable(url)) continue;
    const closedAt = closedAnywhere.get(url) || 0;
    const mineAt = openedAt.get(id) || 0;
    if (closedAt <= mineAt) continue; // our copy is newer — keep it

    if (id === activeId || pinnedIds.has(id) || hotkeyByTab.has(id)) {
      // "unless I'm literally on the tab right now" — resurrect it instead,
      // which republishes a newer open stamp and revives it everywhere.
      openedAt.set(id, Date.now());
      continue;
    }
    const pending = lazyTabs.get(id);
    const title = (pending ? pending.title : tabs.get(id).webContents.getTitle()) || url;
    recentlyClosed.unshift({ url, title, at: Date.now() });
    recentlyClosed.length = Math.min(recentlyClosed.length, 25);
    closeTab(id, { remote: true }); // don't re-broadcast someone else's close
  }

  // Tabs opened elsewhere and still alive appear here too.
  const known = new Set(personas.all().map((p) => p.id));
  for (const [pid, block] of Object.entries(merged)) {
    for (const [url, info] of Object.entries(block.open || {})) {
      if ((closedAnywhere.get(url) || 0) > info.at) continue;
      if (info.dev === deviceId()) continue; // our own echo
      if (findTabByUrl(url) !== null) continue;
      // #96: our own URL rules decide where it lands; the publisher's Persona
      // id is only the fallback, and only if we recognize it at all.
      const claimed = personas.forUrl(url);
      const target = claimed !== personas.UNASSIGNED
        ? claimed
        : (known.has(pid) ? pid : personas.UNASSIGNED);
      const id = createTab(url, true, target, { lazy: true, title: info.title, openedAt: info.at });
      if (id !== null) openedAt.set(id, info.at);
    }
  }
}

async function syncTabs() {
  if (tabsSyncing || locked) return;
  tabsSyncing = true;
  try {
    const res = await fetch(TABS_SYNC_URL, { signal: AbortSignal.timeout(5000) });
    const remote = await res.json();
    const devices = (remote.data && remote.data.devices) || {};
    const me = deviceId();
    remoteDevices = Object.fromEntries(Object.entries(devices).filter(([k]) => k !== me));

    // #57: merge every device's facts per Persona, latest stamp wins per URL.
    const merged = {};
    for (const [devId, dev] of Object.entries(devices)) {
      for (const [pid, block] of Object.entries(dev.personas || {})) {
        const m = (merged[pid] ||= { open: {}, closed: {} });
        for (const [url, info] of Object.entries(block.open || {})) {
          if (!m.open[url] || info.at > m.open[url].at) m.open[url] = { ...info, dev: info.dev || devId };
        }
        for (const [url, at] of Object.entries(block.closed || {})) {
          if (at > (m.closed[url] || 0)) m.closed[url] = at;
        }
      }
    }
    applyRemoteTabState(merged);

    devices[me] = { name: 'Windows', personas: localTabPayload(), at: Date.now() };
    await fetch(TABS_SYNC_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { devices }, updatedAt: Date.now() }),
      signal: AbortSignal.timeout(5000),
    });
    pushState();
  } catch {
    // off the tailnet — nothing to do, we publish again next cycle
  } finally {
    tabsSyncing = false;
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
  locked = true; // #37: locking no longer exits fullscreen (we live there now)
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
      // #78: restore unloaded — the page is fetched when you first click it.
      const id = createTab(t.url, true, t.persona || null, {
        lazy: true,
        title: t.title,
        lastActiveAt: t.lastActiveAt, // #79: age survives the restart
      });
      if (id === null) continue;
      if (t.pinned) pinnedIds.add(id);
      // #116: resolve in THIS tab's Persona. hotkeys.get() with no Persona reads
      // the Unassigned bucket (#25), so every hotkey bound inside a real Persona
      // failed this check and the restored tab silently stopped counting as a
      // hotkey tab — losing Ctrl+Shift+X protection, sticky mode (#33),
      // enforceHome and expiry immunity all at once. Same leftover #78 fixed in
      // enforceHome; it survived here. personaByTab is the authority because
      // createTab has already applied #96's URL-rule claim.
      if (t.hotkey && hotkeys.get(t.hotkey, personaByTab.get(id))) hotkeyByTab.set(id, t.hotkey); // #16
    }
    sortTabOrder();
    pushStickyModes(); // #33
    activateTab(tabOrder[Math.min(session.active ?? 0, tabOrder.length - 1)]);
  } else {
    const legacy = loadLegacyPinned();
    for (const u of legacy) {
      const id = createTab(u, true);
      if (id !== null) pinnedIds.add(id);
    }
    if (!tabOrder.length) createTab();
    else activateTab(tabOrder[0]);
  }
  pushState();
  broadcastHotkeys(); // #16: chrome badges + per-tab bound-key lists
  // #96: re-home anything a rule now claims — restored sessions can hold tabs
  // filed before their Persona's rules existed.
  for (const tid of tabOrder) {
    const claimed = personas.forUrl(tabUrlOf(tid));
    if (claimed !== personas.UNASSIGNED) personaByTab.set(tid, claimed);
  }
  syncBookmarks(); // #13: catch up whenever a session starts
  syncPersonas(); // #88
  syncTabs(); // #57
  sweepStaleTabs(); // #79: a machine left off overnight cleans up on return
  flushPendingExternalUrl(); // #106: a link that arrived while we were locked
}

// --- #100: selected text -> URL rules ---------------------------------------

const textRules = () => {
  const list = getSettings().textRules;
  return Array.isArray(list) && list.length ? list : textrules.DEFAULT_RULES;
};

function saveTextRules(list) {
  const s = getSettings();
  s.textRules = Array.isArray(list) ? list.filter((r) => r && r.pattern && r.template) : [];
  saveSettings();
  return textRules();
}

/**
 * Open whatever the selection resolves to. Silent when nothing matches — a
 * hotkey that navigates somewhere useless is worse than one that does nothing.
 */
function openFromSelection(text) {
  if (locked) return false;
  const hit = textrules.resolve(text, textRules());
  if (!hit) return false;
  openOrFocus(hit.url, false); // new foreground tab; Persona rules still apply (#96)
  return true;
}

// --- #108: TLS certificate errors and failed loads --------------------------
//
// Before this, an untrusted certificate meant Electron cancelled the load in
// silence and the user got a white page — indistinguishable from a broken site.
// Every mainstream browser shows an interstitial and lets you decide.
//
// The rule this code exists to honour: NEVER trust a certificate the user has
// not explicitly accepted, and never trust one blanket-style. Exceptions are
// stored per host AND pinned to the certificate's fingerprint, so accepting a
// self-signed cert today does not silently trust a DIFFERENT cert on that host
// tomorrow — cert substitution is the exact attack the warning exists to catch.

const certExceptions = () => {
  const list = getSettings().certExceptions;
  return Array.isArray(list) ? list : [];
};

function isCertTrusted(host, fingerprint) {
  if (!host) return false;
  return certExceptions().some((e) => {
    if (e.host !== host) return false;
    // A pinned exception must match the exact certificate — that is the point:
    // accepting one self-signed cert must not bless a DIFFERENT one later.
    // An unpinned entry (we never saw the certificate; see cert-proceed) can
    // only be host-wide, and is labelled as such in Settings.
    return e.fingerprint ? e.fingerprint === fingerprint : true;
  });
}

function addCertException(host, fingerprint) {
  if (!host || isCertTrusted(host, fingerprint)) return;
  const s = getSettings();
  s.certExceptions = [...certExceptions(), { host, fingerprint: fingerprint || null, addedAt: Date.now() }];
  saveSettings();
}

function removeCertException(host, fingerprint) {
  const s = getSettings();
  s.certExceptions = certExceptions().filter(
    (e) => !(e.host === host && (!fingerprint || e.fingerprint === fingerprint))
  );
  saveSettings();
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

// What the interstitial needs, keyed by the webContents showing it — the page
// itself is a file:// URL and cannot be told anything through its own location.
const pendingCertError = new Map(); // wcId -> details shown by the interstitial
const lastCertError = new Map(); // wcId -> details captured from certificate-error

// Chromium's certificate failures. Anything in this band means "the load died
// because of the certificate", which is what tells did-fail-load to show the
// interstitial instead of the generic network error page.
// -200..-219 are the ERR_CERT_* family; -501 is ERR_INSECURE_RESPONSE.
const isCertErrorCode = (code) => (code <= -200 && code >= -219) || code === -501;

function certDetailsFrom(url, error, certificate) {
  return {
    url,
    host: hostOf(url),
    error: String(error || 'unknown'),
    fingerprint: certificate?.fingerprint || '',
    subject: certificate?.subjectName || certificate?.subject?.commonName || '',
    issuer: certificate?.issuerName || certificate?.issuer?.commonName || '',
    validStart: certificate?.validStart ? certificate.validStart * 1000 : null,
    validExpiry: certificate?.validExpiry ? certificate.validExpiry * 1000 : null,
  };
}

function showCertError(wc, details) {
  pendingCertError.set(wc.id, details);
  wc.loadFile(INTERNAL_PAGES.certerror).catch((err) => errorlog.record('showCertError', err));
}

// Chromium error codes worth explaining in plain English; anything else falls
// back to the raw description rather than pretending we know what it means.
const NET_ERRORS = {
  '-2': 'The request failed.',
  '-6': "The file couldn't be found.",
  '-7': 'The connection timed out.',
  '-15': 'The connection was interrupted.',
  '-21': 'The network changed while the page was loading.',
  '-100': 'The connection was closed unexpectedly.',
  '-101': 'The connection was reset.',
  '-102': 'The connection was refused — nothing is listening there.',
  '-105': "That hostname couldn't be resolved. Check the address, or whether you're on the right network.",
  '-106': 'The internet connection appears to be offline.',
  '-109': 'That host is unreachable.',
  '-118': 'The connection timed out while being established.',
  '-137': "That hostname couldn't be resolved.",
  '-324': 'The server closed the connection without sending any data.',
};

const pendingNetError = new Map(); // wcId -> details

function showNetError(wc, url, errorCode, errorDescription) {
  pendingNetError.set(wc.id, {
    url,
    code: errorCode,
    description: errorDescription || '',
    explanation: NET_ERRORS[String(errorCode)] || '',
  });
  wc.loadFile(INTERNAL_PAGES.neterror).catch((err) => errorlog.record('showNetError', err));
}

// #108: a failed load used to render nothing at all — white page, no clue
// whether the site or the browser was broken. Main frame only: a subresource
// that fails must not blow away a page that otherwise loaded.
// #111: lifted out of createTab so popup windows get error pages too.
function wireLoadFailures(wc) {
  wc.on('did-fail-load', (_e, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED — a navigation the user replaced
    if (isCertErrorCode(errorCode)) {
      // Prefer the real certificate details captured in certificate-error;
      // fall back to a bare record so the page still names the host and code.
      const details = lastCertError.get(wc.id) || certDetailsFrom(failedUrl, errorDescription, null);
      details.url = failedUrl || details.url;
      details.host = hostOf(details.url);
      showCertError(wc, details);
      return;
    }
    showNetError(wc, failedUrl, errorCode, errorDescription);
  });
}

// --- #111 round 3: HTTP authentication (Basic / Digest / proxy) -------------
//
// Electron does NOT show a credential dialog on its own. A 401 fires the `login`
// event and waits for the app to answer; with no handler, Electron cancels the
// auth, the request goes out unauthenticated, and the server's own "you must log
// in" body renders instantly. That is not a blocked popup — it only looks like
// one, which is what made this take three rounds to pin down.

const pendingAuth = new Map(); // realmKey -> { win, callbacks: [], info }
const authWindowRealm = new Map(); // authWindow wcId -> realmKey

const realmKeyOf = (info) => `${info.scheme}://${info.host}:${info.port}/${info.realm || ''}`;

function promptForAuth(info, callback) {
  const key = realmKeyOf(info);
  // One dialog per realm. A page with ten protected images fires ten login
  // events; without this the user would be answering ten identical prompts.
  const existing = pendingAuth.get(key);
  if (existing) {
    existing.callbacks.push(callback);
    return;
  }

  const authWin = new BrowserWindow({
    width: 460,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Sign in',
    show: false,
    // Same lesson as the popup work: the app is always fullscreen (#37), and an
    // unparented window can open behind it and look like nothing happened.
    parent: win,
    modal: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f2f2f4',
    webPreferences: { preload: path.join(__dirname, 'internal-preload.js') },
  });
  authWin.setMenu(null);

  const entry = { win: authWin, callbacks: [callback], info, answered: false };
  pendingAuth.set(key, entry);
  authWindowRealm.set(authWin.webContents.id, key);

  authWin.once('ready-to-show', () => {
    authWin.show();
    authWin.focus();
  });
  // Closing the dialog any other way (X, Esc, parent closing) must still answer
  // every queued callback, or those requests hang until they time out.
  authWin.on('closed', () => finishAuth(key, null));
  authWin.loadFile(INTERNAL_PAGES.auth).catch((err) => errorlog.record('promptForAuth', err));
}

/** creds === null cancels. Every queued callback is answered exactly once. */
function finishAuth(key, creds) {
  const entry = pendingAuth.get(key);
  if (!entry || entry.answered) return;
  entry.answered = true;
  pendingAuth.delete(key);
  authWindowRealm.delete(entry.win?.webContents?.id);
  for (const cb of entry.callbacks) {
    try {
      if (creds) cb(creds.username, creds.password);
      else cb(); // no arguments = cancel the authentication
    } catch (err) {
      errorlog.record('finishAuth', err);
    }
  }
  entry.callbacks.length = 0;
}

app.on('login', (event, _wc, details, authInfo, callback) => {
  // Taking this event over is what makes the dialog possible at all.
  event.preventDefault();
  const info = {
    host: authInfo.host || '',
    port: authInfo.port || 0,
    realm: authInfo.realm || '',
    scheme: authInfo.scheme || 'basic',
    isProxy: Boolean(authInfo.isProxy),
    url: details?.url || '',
  };
  errorlog.record(
    'http-auth',
    `challenge host=${info.host}:${info.port} realm="${info.realm}" ` +
      `scheme=${info.scheme} proxy=${info.isProxy} url=${info.url}`
  );
  promptForAuth(info, callback);
});

ipcMain.handle('int:auth-details', (e) => {
  const key = authWindowRealm.get(e.sender.id);
  const entry = key && pendingAuth.get(key);
  if (!entry) return null;
  const { info } = entry;
  const origin = `https://${info.host}`;
  // Offer a saved login if the vault happens to be unlocked — the credential
  // store already exists (#12/#26), so making the user retype is just rude.
  let prefill = null;
  if (!locked) {
    try {
      const match = credentials.forOrigin(origin)[0] || credentials.forOrigin(`http://${info.host}`)[0];
      if (match) prefill = { username: match.username, password: match.password };
    } catch (err) {
      errorlog.record('auth-prefill', err);
    }
  }
  return { ...info, prefill, canSave: !locked };
});

ipcMain.handle('int:auth-submit', (e, { username, password, save }) => {
  const key = authWindowRealm.get(e.sender.id);
  const entry = key && pendingAuth.get(key);
  if (!entry) return false;
  if (save && !locked) {
    try {
      credentials.upsert({ origin: `https://${entry.info.host}`, username, password });
      pushCreds();
    } catch (err) {
      errorlog.record('auth-save', err);
    }
  }
  const winToClose = entry.win;
  finishAuth(key, { username: String(username || ''), password: String(password || '') });
  if (winToClose && !winToClose.isDestroyed()) winToClose.destroy();
  return true;
});

ipcMain.handle('int:auth-cancel', (e) => {
  const key = authWindowRealm.get(e.sender.id);
  const entry = key && pendingAuth.get(key);
  finishAuth(key, null);
  if (entry?.win && !entry.win.isDestroyed()) entry.win.destroy();
  return true;
});

// The only place a certificate is ever trusted. Registered once, app-wide.
app.on('certificate-error', (event, wc, url, error, certificate, callback) => {
  const host = hostOf(url);
  const fingerprint = certificate?.fingerprint || '';
  // Remember why this failed so did-fail-load can explain it. certificate-error
  // fires for subresources too, so the decision happens here but the interstitial
  // is left to did-fail-load, which knows whether the MAIN frame died.
  try {
    lastCertError.set(wc.id, certDetailsFrom(url, error, certificate));
  } catch {
    // a destroyed webContents has no id — nothing to record, nothing to show
  }
  if (isCertTrusted(host, fingerprint)) {
    event.preventDefault();
    callback(true); // this exact certificate, on this exact host, accepted before
    return;
  }
  callback(false); // refuse — the interstitial does the explaining
});

// --- #106: default browser — being handed URLs by the OS -------------------

// Windows launches `WebForge.exe <url>` (see installer.nsh's ProgID command).
// Electron's own switches and the app path share argv, so match on shape rather
// than position — `electron .` in dev puts a directory in argv[1] too.
function urlFromArgv(argv) {
  return (argv || []).find((a) => typeof a === 'string' && /^https?:\/\//i.test(a)) || null;
}

// A URL can arrive before the vault is unlocked, and createTab() refuses while
// locked — so it would vanish silently. Hold it until onUnlocked() runs.
let pendingExternalUrl = null;

function openExternalUrl(url) {
  if (!url) return;
  if (locked) {
    pendingExternalUrl = url;
    return;
  }
  // openOrFocus so a link to something already open focuses that tab (#31), and
  // createTab applies the Persona URL rules on the way in (#96).
  openOrFocus(url, false);
}

function flushPendingExternalUrl() {
  const url = pendingExternalUrl;
  pendingExternalUrl = null;
  if (url) openExternalUrl(url);
}

// Claim the protocols from the app side too, so our registration doesn't depend
// solely on the installer having run. Windows 11 protects the actual UserChoice
// behind a hash, so this cannot and does not steal the default — it only makes
// the claim consistent. Guarded because a failure here must never block startup.
function claimProtocols() {
  if (process.platform !== 'win32') return;
  for (const scheme of ['http', 'https']) {
    try {
      app.setAsDefaultProtocolClient(scheme);
    } catch (err) {
      errorlog.record('claimProtocols', err);
    }
  }
}

function isDefaultBrowser() {
  try {
    return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
  } catch {
    return false;
  }
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
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => openNewTab() }, // #82
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
          { label: 'Duplicate Tab', accelerator: 'CmdOrCtrl+Shift+U', click: () => locked || duplicateActiveTab() },
          { label: 'Pin/Unpin Tab', accelerator: 'CmdOrCtrl+Shift+P', click: () => togglePin(activeId) },
          { label: 'Close All But Pinned & Hotkey Tabs', accelerator: 'CmdOrCtrl+Shift+X', click: () => locked || closeNormalTabs() },
          { label: 'Close All But Pinned & Hotkey Tabs', accelerator: 'CmdOrCtrl+Shift+W', visible: false, click: () => locked || closeNormalTabs() },
          { label: 'Detach Hotkey Tab', accelerator: 'CmdOrCtrl+Shift+D', click: () => detachActiveHotkeyTab() },
          { label: 'Bookmarks Panel', accelerator: 'CmdOrCtrl+B', click: () => locked || toggleBookmarksPanel() },
          { label: 'Bookmark Manager', accelerator: 'CmdOrCtrl+Shift+B', click: () => locked || toggleBmManager() },
          { label: 'Settings', accelerator: 'CmdOrCtrl+Shift+S', click: () => locked || toggleSettings() },
          { label: 'Saved Logins', accelerator: 'CmdOrCtrl+Shift+K', click: () => locked || openInternalTab('passwords') },
          { label: 'About WebForge', click: () => locked || openInternalTab('about') },
          { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => locked || starCurrent() },
          { label: 'Lock WebForge', accelerator: 'CmdOrCtrl+Shift+L', click: () => showLock() },
          { label: 'Import Passwords (CSV)…', click: () => locked || importPasswordsCsv() },
          // #113: keep these in step with wireChords, or the menu advertises
          // behaviour the app no longer has.
          { label: 'Recent Tab', accelerator: 'Control+Tab', click: () => flipTab() },
          { label: 'Next Tab', accelerator: 'Control+Shift+Tab', click: () => cycleTab(1) },
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
          // #101: the basics that were missing.
          { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => hardReload() },
          { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: () => openFind() },
          { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => reopenClosedTab() },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoomBy(1) },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => zoomBy(1) },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-1) },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoomBy(0) },
          { label: 'Print', accelerator: 'CmdOrCtrl+P', click: () => printPage() },
          { label: 'View Source', accelerator: 'CmdOrCtrl+U', click: () => viewSource() },
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
// #101: find bar — the UI lives in the chrome renderer, the search runs here.
ipcMain.on('find-run', (_e, { text, forward, again }) => runFind(String(text || ''), { forward, again }));
ipcMain.on('find-close', () => closeFind());
ipcMain.on('stop', () => activeWc()?.stop());
ipcMain.on('new-tab', () => openNewTab()); // #82
ipcMain.on('close-tab', (_e, id) => closeTab(id));
// #115: Ctrl+X from any renderer that decided the user was not typing. The
// editable-field check lives in the preloads, where focus is known exactly.
ipcMain.on('close-active-tab', () => {
  if (!locked && activeId !== null) closeTab(activeId);
});
// #100: Ctrl+J — the selection comes from the renderer, because
// before-input-event is synchronous and cannot read the page's selection.
ipcMain.on('open-text-rule', (_e, text) => openFromSelection(String(text || '')));
ipcMain.handle('int:get-text-rules', () => textRules());
ipcMain.handle('int:save-text-rules', (_e, list) => saveTextRules(list));
ipcMain.on('activate-tab', errorlog.guard('activate-tab', (_e, id) => activateTab(Number(id))));
ipcMain.on('toggle-pin', (_e, id) => togglePin(id));
// #25: persona IPC
ipcMain.on('switch-persona', (_e, id) => switchPersona(String(id)));
ipcMain.handle('int:get-personas', () => ({ personas: personas.all(), active: personas.activeId() }));
ipcMain.handle('int:add-persona', (_e, name) => {
  const p = personas.add(name);
  pushState();
  return p;
});
ipcMain.handle('int:update-persona', (_e, { id, name, rules }) => {
  const ok = personas.update(String(id), { name, rules });
  // Re-home every tab against the new rules so edits take effect immediately.
  for (const tid of tabOrder) {
    const claimed = personas.forUrl(tabs.get(tid).webContents.getURL());
    personaByTab.set(tid, claimed);
  }
  pushState();
  return ok;
});
ipcMain.handle('int:delete-persona', (_e, id) => {
  const ok = personas.remove(String(id));
  // Its tabs fall back to Unassigned rather than disappearing.
  for (const [tid, pid] of personaByTab) {
    if (pid === String(id)) personaByTab.set(tid, personas.UNASSIGNED);
  }
  pushState();
  return ok;
});
// #82: a new tab is scratch space — it exists only while you're on it. Any
// tab still showing the new-tab page hasn't been used (typing a URL navigates
// it, so it stops qualifying), and leaving it means you didn't want it.
function isUnusedNewTab(id) {
  if (pinnedIds.has(id) || hotkeyByTab.has(id)) return false;
  const view = tabs.get(id);
  if (!view) return false;
  const pending = lazyTabs.get(id);
  return isNewTabUrl(pending ? pending.url : view.webContents.getURL());
}

function closeStrayNewTabs(exceptId = null) {
  if (locked) return;
  for (const id of [...tabOrder]) {
    if (id === exceptId) continue;
    if (tabOrder.length <= 1) break; // never leave the window tabless
    if (isUnusedNewTab(id)) closeTab(id);
  }
}

// Ctrl+T / the + button: reuse this Persona's new tab rather than stacking.
function openNewTab() {
  if (locked) return;
  const active = personas.activeId();
  const existing = tabOrder.find(
    (id) => (personaByTab.get(id) || personas.UNASSIGNED) === active && isUnusedNewTab(id)
  );
  if (existing !== undefined) {
    activateTab(existing);
    return;
  }
  createTab(null, false);
}

// #79: close normal tabs left untouched for too long. Pinned and hotkey tabs
// are exempt (same survivors as Ctrl+Shift+X), the active tab never expires,
// and the last tab standing is always kept.
const EXPIRY_CHOICES = { off: 0, '1h': 1, '8h': 8, '24h': 24, '7d': 168 };
function expiryHours() {
  const v = getSettings().tabExpiry;
  return v in EXPIRY_CHOICES ? EXPIRY_CHOICES[v] : 24; // default: the user's ask
}

function sweepStaleTabs() {
  if (locked) return;
  const hours = expiryHours();
  if (!hours) return;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const doomed = tabOrder.filter(
    (id) =>
      id !== activeId &&
      !pinnedIds.has(id) &&
      !hotkeyByTab.has(id) &&
      (lastActiveAt.get(id) || Date.now()) < cutoff
  );
  if (!doomed.length || doomed.length >= tabOrder.length) return;
  for (const id of doomed) closeTab(id);
}

// #46: close every tab in a sidebar group (chrome knows the grouping).
ipcMain.on('close-tabs', (_e, ids) => {
  if (locked || !Array.isArray(ids)) return;
  for (const id of ids) closeTab(Number(id));
});

// #16: hotkey IPC — key presses arrive from content preloads AND the chrome UI.
ipcMain.on('webforge-key', (_e, keyId) => handleHotkeyPress(String(keyId)));
// #33: a sticky hotkey tab cancelled a link click — open it as its own tab.
ipcMain.on('open-in-new-tab', (_e, url) => {
  if (!locked && typeof url === 'string') openOrFocus(url, false);
});
ipcMain.on('set-hotkey', (_e, { keyId, url, title }) => {
  if (locked) return;
  if (!hotkeys.set(String(keyId), { url, title }, personas.activeId())) return; // digits reserved
  broadcastHotkeys();
  pushState();
});
ipcMain.on('remove-hotkey', (_e, keyId) => {
  if (locked) return;
  const tabId = tabForHotkey(String(keyId));
  if (tabId !== null) hotkeyByTab.delete(tabId); // open tab becomes normal
  hotkeys.remove(String(keyId), personas.activeId());
  broadcastHotkeys();
  sortTabOrder();
  pushStickyModes(); // #33
  pushState();
});

// #11: bookmarks IPC.
ipcMain.on('toggle-bookmarks-panel', () => toggleBookmarksPanel());
ipcMain.on('toggle-star', () => locked || starCurrent());

// #29: bookmark edit dialog IPC.
ipcMain.on('bm-edit-request', (_e, id) => {
  if (locked) return;
  const b = bookmarks.all().find((x) => x.id === id);
  if (b) {
    openBookmarkDialog({
      id: b.id, title: b.title, url: b.url, folder: b.folder || '', exists: true,
      claim: personas.claimFor(b.url), // #70
      personas: orderedPersonas().map((p) => ({ id: p.id, name: p.name })),
    });
  }
});
ipcMain.on('bm-save', (_e, { id, title, url, folder }) => {
  if (locked) return;
  if (id) bookmarks.update(id, { title, url, folder });
  else bookmarks.add({ title, url, folder });
  closeBookmarkDialog();
  pushBookmarks();
  pushState();
  scheduleSyncSoon();
});
ipcMain.on('bm-close', () => closeBookmarkDialog());
ipcMain.on('open-bookmark', errorlog.guard('open-bookmark', (_e, { url, background }) => {
  // #31: an already-open copy of the bookmark wins over navigating/spawning.
  const existing = findTabByUrl(url);
  if (existing !== null) {
    if (!background) activateTab(existing);
  } else if (background) {
    createTab(url, true);
  } else {
    activeWc()?.loadURL(url);
  }
  // #76: get out of the way. In fullscreen an open panel covers the WHOLE
  // window, so without this the page loaded behind it and the click looked
  // like it did nothing. Background opens keep the panel up on purpose.
  if (!background) {
    if (bmPanelOpen) toggleBookmarksPanel();
    if (fsRevealed) {
      clearFsReveal();
      layout();
    }
    activeWc()?.focus();
  }
}));
ipcMain.on('remove-bookmark', (_e, id) => {
  bookmarks.remove(id);
  closeBookmarkDialog(); // no-op unless the dialog's Remove triggered this
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

// #40: IPC for WebForge's own pages (settings + bookmark manager tabs).
function pushInternalBookmarks() {
  for (const view of tabs.values()) {
    if (isInternalUrl(view.webContents.getURL())) view.webContents.send('int:bookmarks');
  }
}
ipcMain.handle('int:get-settings', () => ({ ...getSettings(), searchEngine: searchEngine() }));
ipcMain.handle('int:set-theme', (_e, t) => {
  getSettings().theme = String(t);
  saveSettings();
  applyTheme(String(t));
  return true;
});
ipcMain.handle('int:set-tab-expiry', (_e, choice) => {
  if (!(choice in EXPIRY_CHOICES)) return false;
  getSettings().tabExpiry = choice;
  saveSettings();
  sweepStaleTabs();
  return true;
});
ipcMain.handle('int:set-engine', (_e, engine) => {
  if (!ENGINES[engine]) return false;
  getSettings().searchEngine = engine;
  saveSettings();
  return true;
});
ipcMain.handle('int:save-tab-groups', (_e, list) => {
  getSettings().tabGroups = (Array.isArray(list) ? list : [])
    .map((g) => ({ name: String(g?.name || '').trim(), pattern: String(g?.pattern || '').trim() }))
    .filter((g) => g.name && g.pattern);
  saveSettings();
  pushTabGroups();
  return true;
});
// --- #108: interstitial IPC. The pages are file:// and know nothing about the
// navigation that failed, so they ask for it by their own webContents id. ---
ipcMain.handle('int:cert-details', (e) => pendingCertError.get(e.sender.id) || null);
ipcMain.handle('int:net-details', (e) => pendingNetError.get(e.sender.id) || null);

// The only path that ever records a trust decision, and it is only reachable
// from the interstitial's Proceed button — i.e. an explicit human choice.
ipcMain.handle('int:cert-proceed', (e) => {
  const details = pendingCertError.get(e.sender.id);
  // #112: this used to `return false` on a missing fingerprint and the page
  // ignored the result, so a refusal looked exactly like a dead button. Say why.
  if (!details?.host) {
    errorlog.record('cert-proceed', 'refused: no pending certificate error for this view');
    return { ok: false, reason: 'This warning is no longer active. Reload the page and try again.' };
  }
  // No fingerprint means we never saw the certificate itself, so the exception
  // cannot be pinned. Still let the user through — a Proceed that silently does
  // nothing is worse — but record it unpinned so Settings can say so honestly.
  addCertException(details.host, details.fingerprint || null);
  pendingCertError.delete(e.sender.id);
  e.sender.loadURL(details.url).catch((err) => errorlog.record('cert-proceed', err));
  return { ok: true };
});

ipcMain.handle('int:cert-back', (e) => {
  pendingCertError.delete(e.sender.id);
  const nav = e.sender.navigationHistory;
  if (nav?.canGoBack()) nav.goBack();
  else e.sender.loadURL(newTabUrl());
  return true;
});

ipcMain.handle('int:net-retry', (e) => {
  const details = pendingNetError.get(e.sender.id);
  if (!details?.url) return false;
  pendingNetError.delete(e.sender.id);
  e.sender.loadURL(details.url).catch((err) => errorlog.record('net-retry', err));
  return true;
});

// Settings: make stored exceptions auditable and revocable.
ipcMain.handle('int:cert-exceptions', () => certExceptions());
ipcMain.handle('int:cert-revoke', (_e, { host, fingerprint }) => {
  removeCertException(host, fingerprint);
  return certExceptions();
});

// #106: report, don't pretend to set — the switch is the user's to make.
ipcMain.handle('int:default-browser-status', () => ({ isDefault: isDefaultBrowser() }));
ipcMain.handle('int:open-default-apps', async () => {
  const { shell } = require('electron');
  try {
    // Deep-links straight to our entry in Windows 11's Default apps page.
    await shell.openExternal(`ms-settings:defaultapps?registeredAppMachine=WebForge`);
    return true;
  } catch {
    try {
      await shell.openExternal('ms-settings:defaultapps');
      return true;
    } catch (err) {
      errorlog.record('open-default-apps', err);
      return false;
    }
  }
});

ipcMain.handle('int:sync-status', async () => {
  // #13: let the user SEE that sync works instead of asking someone to curl it.
  const local = bookmarks.all().length;
  try {
    const res = await fetch(SYNC_URL, { signal: AbortSignal.timeout(4000) });
    const remote = await res.json();
    return {
      reachable: true,
      local,
      remote: Array.isArray(remote.data) ? remote.data.length : 0,
      updatedAt: remote.updatedAt || 0,
    };
  } catch {
    return { reachable: false, local };
  }
});
ipcMain.handle('int:get-creds', () => (locked ? [] : credentials.list()));
ipcMain.handle('int:save-cred', (_e, cred) => {
  if (locked) return false;
  return credentials.upsert(cred || {});
});
ipcMain.handle('int:delete-cred', (_e, id) => (locked ? false : credentials.removeById(String(id))));
ipcMain.handle('int:about', () => {
  let shared = { sections: [] };
  try {
    // shared/about.json is one level up from windows/ in the repo, and beside
    // the app resources once packaged.
    const candidates = [
      path.join(__dirname, '..', 'shared', 'about.json'),
      path.join(process.resourcesPath || '', 'shared', 'about.json'),
      path.join(__dirname, 'shared', 'about.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        shared = JSON.parse(fs.readFileSync(c, 'utf8'));
        break;
      }
    }
  } catch {}
  return {
    version: app.getVersion(),
    // Measured, not asserted — these come from the running process.
    runtime: {
      'WebForge': app.getVersion(),
      'Chromium (engine)': process.versions.chrome,
      'Electron': process.versions.electron,
      'Node.js': process.versions.node,
      'V8': process.versions.v8,
      'Platform': `${process.platform} ${process.arch}`,
      'Release channel': 'self-hosted (dockerhost :8012)',
    },
    sections: shared.sections || [],
  };
});
ipcMain.handle('int:claim-for', (_e, url) => personas.claimFor(String(url || '')));
ipcMain.handle('int:assign-persona', (_e, { url, personaId, force }) => {
  if (locked) return { ok: false, error: 'Locked.' };
  const res = personas.assign(String(url || ''), String(personaId || ''), { force: Boolean(force) });
  if (res.ok) {
    // Rules changed — re-home every open tab so routing takes effect at once.
    for (const tid of tabOrder) {
      personaByTab.set(tid, personas.forUrl(tabs.get(tid).webContents.getURL()));
    }
    pushState();
  }
  return res;
});
ipcMain.handle('int:get-bookmarks', () => bookmarks.all());
ipcMain.handle('int:get-hotkeys', () => hotkeys.all(personas.activeId()));
// #74: the whole picture, so misfiled bindings are visible and fixable.
ipcMain.handle('int:recently-closed', () => recentlyClosed.slice(0, 25)); // #57
ipcMain.handle('int:restore-closed', (_e, url) => {
  if (locked || !url) return false;
  closedFacts.delete(String(url)); // stop republishing the tombstone
  const id = createTab(String(url), false);
  return id !== null;
});
ipcMain.handle('int:get-errors', () => errorlog.read());
ipcMain.handle('int:clear-errors', () => {
  errorlog.clear();
  return true;
});
ipcMain.handle('int:get-all-hotkeys', () => ({
  byPersona: hotkeys.allByPersona(),
  personas: orderedPersonas().map((p) => ({ id: p.id, name: p.name })),
  active: personas.activeId(),
}));
ipcMain.handle('int:move-hotkey', (_e, { keyId, from, to, force }) => {
  if (locked) return { ok: false, error: 'Locked.' };
  const res = hotkeys.move(String(keyId), String(from), String(to), { force: Boolean(force) });
  if (res.ok) {
    broadcastHotkeys();
    pushState();
  }
  return res;
});
ipcMain.handle('int:save-bookmark', (_e, b) => {
  if (locked || !b?.url) return false;
  if (b.id) bookmarks.update(b.id, b);
  else bookmarks.add(b);
  afterBookmarkChange();
  return true;
});
ipcMain.handle('int:delete-bookmark', (_e, id) => {
  bookmarks.remove(String(id));
  afterBookmarkChange();
  return true;
});
ipcMain.handle('int:move-bookmarks', (_e, { ids, folder }) => {
  const n = bookmarks.moveMany(ids, folder);
  afterBookmarkChange();
  return n;
});
ipcMain.handle('int:rename-folder', (_e, { from, to }) => {
  const n = bookmarks.renameFolder(from, to);
  afterBookmarkChange();
  return n;
});
ipcMain.handle('int:delete-folder', (_e, folder) => {
  const n = bookmarks.deleteFolder(folder);
  afterBookmarkChange();
  return n;
});
ipcMain.handle('int:set-hotkey', (_e, { keyId, url, title }) => {
  if (locked) return false;
  if (!hotkeys.set(String(keyId), { url, title }, personas.activeId())) return false;
  broadcastHotkeys();
  pushState();
  return true;
});
ipcMain.handle('int:remove-hotkey', (_e, arg) => {
  if (locked) return false;
  const keyId = typeof arg === 'object' && arg ? arg.keyId : arg;
  const personaId = typeof arg === 'object' && arg && arg.personaId ? arg.personaId : personas.activeId();
  const tabId = tabForHotkey(String(keyId));
  if (tabId !== null) hotkeyByTab.delete(tabId);
  hotkeys.remove(String(keyId), personaId);
  broadcastHotkeys();
  sortTabOrder();
  pushStickyModes();
  pushState();
  return true;
});
// Sidebar drag & drop (#29): move a bookmark into a folder.
ipcMain.on('move-bookmark', (_e, { id, folder }) => {
  if (locked) return;
  bookmarks.moveMany([id], folder || '');
  afterBookmarkChange();
});
ipcMain.on('int:open-about', () => locked || openInternalTab('about'));
ipcMain.on('int:open-passwords', () => locked || openInternalTab('passwords')); // #63
ipcMain.on('int:open-url', (_e, { url, background }) => {
  if (!locked && typeof url === 'string') openOrFocus(url, Boolean(background));
});

// Anything that mutates bookmarks refreshes every surface + queues a sync.
function afterBookmarkChange() {
  pushBookmarks();
  pushInternalBookmarks();
  pushState();
  scheduleSyncSoon();
}

// #29: bookmark manager IPC.
ipcMain.on('toggle-bm-manager', () => locked || toggleBmManager());

// #24: settings IPC.
ipcMain.on('toggle-settings', () => locked || toggleSettings());
ipcMain.on('set-theme', (_e, theme) => {
  getSettings().theme = String(theme);
  saveSettings();
  applyTheme(String(theme));
});

// #34: user-defined tab groups ({name, pattern}, trailing-* prefix match).
function pushTabGroups() {
  chrome?.webContents.send('tab-groups', getSettings().tabGroups || []);
}
ipcMain.on('groups-save', (_e, list) => {
  getSettings().tabGroups = (Array.isArray(list) ? list : [])
    .map((g) => ({ name: String(g?.name || '').trim(), pattern: String(g?.pattern || '').trim() }))
    .filter((g) => g.name && g.pattern);
  saveSettings();
  pushTabGroups();
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

// #106: exactly one WebForge, or being the default browser is actively harmful —
// every clicked link would spawn a second copy with its own session file, its own
// vault lock state, and two instances racing on the last-write-wins sync store.
// Must be requested before anything else initialises.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  // A URL passed to this process reaches the primary via 'second-instance'.
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = urlFromArgv(argv);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    openExternalUrl(url);
  });
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return; // losing the lock means this process is a no-op
  applyTheme(getSettings().theme); // #24: before any view paints
  // #73: park any pre-Persona hotkeys in the first real Persona, deterministically.
  const firstReal = personas.all().find((p) => p.id !== personas.UNASSIGNED);
  hotkeys.migrateInto(firstReal ? firstReal.id : personas.UNASSIGNED);
  setupAdblock(); // async — engine attaches to the session when ready
  createWindow();
  setupShortcuts();
  setupAutoUpdate();
  claimProtocols(); // #106
  // #106: a cold start from a clicked link. showLock() runs inside
  // createWindow(), so this is queued and flushed by onUnlocked().
  openExternalUrl(urlFromArgv(process.argv));
  setInterval(syncBookmarks, 10 * 60 * 1000); // #13: periodic catch-up
  setInterval(syncPersonas, 10 * 60 * 1000); // #88
  setInterval(syncTabs, 30 * 1000); // #95: 30s, matching Android — a minute felt dead
  setInterval(sweepStaleTabs, 5 * 60 * 1000); // #79
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
  errorlog.record('uncaughtException', err); // #75: visible in Settings
});
process.on('unhandledRejection', (err) => {
  errorlog.record('unhandledRejection', err);
});
