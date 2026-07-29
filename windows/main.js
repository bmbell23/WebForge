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
let bmPanelOpen = false;
let pwPanelOpen = false; // #26 — shares the right-panel slot with bookmarks

let win, chrome, lockView;
const tabs = new Map(); // id -> WebContentsView
let tabOrder = [];      // ids in sidebar order (pinned group first)
let activeId = null;
let nextTabId = 1;
const pinnedIds = new Set(); // #9
const hotkeyByTab = new Map(); // #16: tabId -> keyId (a tab per bound hotkey)
const faviconByTab = new Map(); // #45: tabId -> icon URL
const personaByTab = new Map(); // #25: tabId -> personaId
let locked = true;           // #15: the app is a brick until the vault unlocks

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
        persona: personaByTab.get(id) || personas.UNASSIGNED, // #25
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
      bmDialogOpen || settingsOpen || managerOpen ? { x: 0, y: 0, width, height } : fsRegionBounds()
    );
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
    const rawUrl = wc.getURL();
    const isNew = isNewTabUrl(rawUrl); // #43: don't surface the file:// path
    const internal = isInternalUrl(rawUrl)
      ? rawUrl.includes('settings.html') ? 'Settings'
        : rawUrl.includes('about.html') ? 'About'
        : rawUrl.includes('passwords.html') ? 'Saved logins'
        : 'Bookmarks'
      : null;
    return {
      id,
      title: internal || (isNew ? 'New tab' : wc.getTitle() || rawUrl || 'New tab'),
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

function pushPersonas() {
  if (!chrome) return;
  const active = personas.activeId();
  chrome.webContents.send('personas-updated', {
    personas: personas.all().map((p) => ({
      id: p.id,
      name: p.name,
      builtin: Boolean(p.builtin),
      rules: p.rules,
      tabCount: tabOrder.filter((t) => (personaByTab.get(t) || personas.UNASSIGNED) === p.id).length,
    })),
    active,
  });
}

function pushState() {
  if (!chrome) return;
  pushPersonas(); // #25
  chrome.webContents.send('tabs-updated', tabState());
  const wc = activeWc();
  const title = wc?.getTitle();
  win.setTitle(title ? `${title} — WebForge` : 'WebForge');
  saveSessionSoon();
}

function createTab(url = null, background = false, personaId = null) {
  if (locked) return null; // #15
  const id = nextTabId++;
  if (!url) url = newTabUrl(); // #43: default landing page is our search page
  // #25: a tab belongs to whichever persona claims its URL; unclaimed URLs go
  // to Unassigned so the real personas stay clean.
  personaByTab.set(id, personaId || personas.forUrl(url));
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
  wc.setWindowOpenHandler(({ url: popupUrl }) => {
    openOrFocus(popupUrl, false);
    return { action: 'deny' };
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
    const home = hotkeys.get(keyId)?.url;
    if (!home) return;
    const norm = (u) => String(u).replace(/\/+$/, '');
    if (norm(navUrl) === norm(home)) return;
    reHoming = true;
    openOrFocus(navUrl, false);
    wc.loadURL(home); // deterministic — goBack() looped on SPA histories
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
    if (claimed !== personas.UNASSIGNED && claimed !== current) {
      personaByTab.set(id, claimed);
      if (id === activeId) personas.setActive(claimed);
      pushState();
    }
  });
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
  wc.loadURL(url);
  if (background && activeId !== null) pushState();
  else activateTab(id);
  return id;
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  const owner = personaByTab.get(id) || personas.UNASSIGNED;
  if (owner !== personas.activeId()) personas.setActive(owner); // #25
  tabs.get(activeId)?.setVisible(false);
  activeId = id;
  const view = tabs.get(id);
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
  pushState();
}

function closeTab(id) {
  const view = tabs.get(id);
  if (!view) return;
  if (pinnedIds.has(id)) return; // #9: pinned tabs don't close — unpin first
  const idx = tabOrder.indexOf(id);
  tabs.delete(id);
  hotkeyByTab.delete(id); // #16: the binding survives; only the open tab dies
  faviconByTab.delete(id);
  personaByTab.delete(id);
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
        const list = personas.all();
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
    // #38: Ctrl+Shift+Left/Right back/forward (user request).
    if (input.shift && (key === 'arrowleft' || key === 'arrowright')) {
      event.preventDefault();
      const h = activeWc()?.navigationHistory;
      if (key === 'arrowleft') h?.goBack();
      else h?.goForward();
      return;
    }
    if (key === 'tab') {
      event.preventDefault();
      cycleTab(input.shift ? -1 : 1);
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

// #46: "misc" = not pinned, not a hotkey tab, and not matched by any
// user-defined tab group. Ctrl+Shift+X sweeps exactly those.
function closeMiscTabs() {
  const groups = getSettings().tabGroups || [];
  const inGroup = (url) =>
    groups.some((g) => {
      const p = String(g.pattern || '').trim().replace(/\*+$/, '').toLowerCase();
      return p && String(url).toLowerCase().startsWith(p);
    });
  const doomed = tabOrder.filter(
    (id) =>
      !pinnedIds.has(id) &&
      !hotkeyByTab.has(id) &&
      !inGroup(tabs.get(id).webContents.getURL())
  );
  for (const id of doomed) closeTab(id);
}

// #16 redefinition of #9's purge: "normal" = neither pinned nor hotkey.
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
  for (const [tid, kid] of hotkeyByTab) if (kid === keyId) return tid;
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
    const newId = createTab(entry.url);
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
      const id = createTab(t.url, true, t.persona || null);
      if (id === null) continue;
      if (t.pinned) pinnedIds.add(id);
      if (t.hotkey && hotkeys.get(t.hotkey)) hotkeyByTab.set(id, t.hotkey); // #16
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
          { label: 'Close Misc Tabs', accelerator: 'CmdOrCtrl+Shift+X', click: () => locked || closeMiscTabs() },
          { label: 'Detach Hotkey Tab', accelerator: 'CmdOrCtrl+Shift+D', click: () => detachActiveHotkeyTab() },
          { label: 'Bookmarks Panel', accelerator: 'CmdOrCtrl+B', click: () => locked || toggleBookmarksPanel() },
          { label: 'Bookmark Manager', accelerator: 'CmdOrCtrl+Shift+B', click: () => locked || toggleBmManager() },
          { label: 'Settings', accelerator: 'CmdOrCtrl+Shift+S', click: () => locked || toggleSettings() },
          { label: 'Saved Logins', accelerator: 'CmdOrCtrl+Shift+K', click: () => locked || openInternalTab('passwords') },
          { label: 'About WebForge', click: () => locked || openInternalTab('about') },
          { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => locked || starCurrent() },
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
  if (b) openBookmarkDialog({ id: b.id, title: b.title, url: b.url, folder: b.folder || '', exists: true });
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
ipcMain.handle('int:get-bookmarks', () => bookmarks.all());
ipcMain.handle('int:get-hotkeys', () => hotkeys.all(personas.activeId()));
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
ipcMain.handle('int:remove-hotkey', (_e, keyId) => {
  if (locked) return false;
  const tabId = tabForHotkey(String(keyId));
  if (tabId !== null) hotkeyByTab.delete(tabId);
  hotkeys.remove(String(keyId), personas.activeId());
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

app.whenReady().then(() => {
  applyTheme(getSettings().theme); // #24: before any view paints
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
