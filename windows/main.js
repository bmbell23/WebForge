// WebForge Windows shell (#3, tabs #4, vertical tabs #8): a BaseWindow holding
// one chrome WebContentsView (ui/index.html: left tab sidebar + top nav bar)
// and one content WebContentsView per tab. The chrome view covers the WHOLE
// window; content views are inset (right of the sidebar, below the nav bar)
// and added after it, so they cover chrome's dead area. Only the active tab's
// view is visible. Full tab state is broadcast to the chrome UI on every
// change; it re-renders from that.
const { app, BaseWindow, BrowserWindow, WebContentsView, Notification, clipboard, ipcMain, dialog, Menu, nativeTheme, session, powerMonitor } = require('electron');
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
const logship = require('./logship'); // #171 — Electron-free, ships errorlog to :8013
const { ensurePreloadRegistration } = require('./preloadshim'); // #21
const navloop = require('./navloop'); // #238
const tabnav = require('./tabnav'); // #113/#114 — unit-tested, Electron-free
const textrules = require('./textrules'); // #100 — ditto
const taburl = require('./taburl'); // #107 — ditto
const taborder = require('./taborder'); // #107 — ditto
const { cleanTabName } = require('./tabname'); // #236 — ditto
const ctxmenu = require('./ctxmenu'); // #133 — ditto
const stickytab = require('./stickytab'); // #117 — ditto
const popuprule = require('./popuprule'); // #125 — ditto
const reader = require('./reader'); // #232 — ditto
const useragent = require('./useragent'); // #134 — ditto
const credmatch = require('./credmatch'); // #136 — ditto
const credsave = require('./credsave'); // #145 — ditto
const modifier = require('./modifier'); // #150 — ditto (Ctrl on Windows, ⌘ on macOS)
const syncdecide = require('./syncdecide'); // #151 — ditto (nothing never overwrites something)
const repaint = require('./repaint'); // #148 — ditto (when to force a frame)
const focusring = require('./focusring'); // #131 — ditto (chrome surface vs page view)
const museforge = require('./museforge'); // #179 — Electron-free (the Studio's outfit-from-image address)
const ytdlp = require('./ytdlp'); // #156 — ditto (what the download button sends)
const adultlist = require('./adultlist'); // #203 — ditto (your adult-site list)
const stash = require('./stash'); // #177 — ditto (Add to Stash body + job wording)
const autofillFrames = require('./autofillframes'); // #141
const terminalMain = require('./terminal-main'); // #206 — terminal spike (ssh2; needs no native helpers)
const termHold = require('./terminal').holdDecision; // #214
const personaorder = require('./personaorder'); // #214
const termhosts = require('./termhosts'); // #214

// #134: banks and other sites with a "supported browsers" allowlist refuse to
// let you sign in when the UA says Electron, even though the engine below is
// stock Chromium. Drop the WebForge/Electron tokens so we read as plain Chrome.
// Set on `app` (not a session) and before ready, so EVERY session and every
// WebContentsView inherits it — including tabs created much later.
app.userAgentFallback = useragent.cleanUserAgent(app.userAgentFallback);

// #43: new tabs land on our own search page; Google is the default engine.
// #133: display names for the "Search <engine> for …" context item.
const ENGINE_NAMES = {
  google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', brave: 'Brave',
};
const ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
};
// #121: the new-tab page moved to shared/ so Android loads the SAME file — two
// copies of one page would drift, as two copies of one behaviour repeatedly have
// in this repo. Resolved with the candidate list already proven for
// shared/about.json below: repo layout in dev, resources or the asar once packaged.
const NEWTAB_FILE = (() => {
  const candidates = [
    path.join(__dirname, '..', 'shared', 'newtab.html'),
    path.join(process.resourcesPath || '', 'shared', 'newtab.html'),
    path.join(__dirname, 'shared', 'newtab.html'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[candidates.length - 1];
})();
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
// #214: a terminal tab. `?host=` connects straight away; without it the page is
// the host picker. Never synced, saved, or offered to Ctrl+Shift+T.
const TERMINAL_FILE = path.join(__dirname, 'ui', 'terminal.html');
const terminalUrl = (target) => fileUrl(TERMINAL_FILE) + (target ? `?host=${encodeURIComponent(target)}` : '');
const isTerminalUrl = (u) => typeof u === 'string' && u.startsWith(fileUrl(TERMINAL_FILE));
const isTerminalTab = (id) => personaByTab.get(id) === personas.TERMINAL;
// #214: an app slot's tab (Mattermost, Teams, Outlook): one pinned page that
// never re-homes, syncs or restores. View tabs = terminal or app slot.
const isSlotTab = (id) => personaorder.isSlotId(personaByTab.get(id));
const isViewTab = (id) => isTerminalTab(id) || isSlotTab(id);
// Where a page opened from a terminal or app slot lands: never in the view itself.
const pageHome = (pid) => (personas.isBuiltinView(pid) ? personas.UNASSIGNED : pid);
// #221: who claims a URL: an app slot for its own site, else the Persona rules.
const claimOf = (url) => personaorder.slotFor(url, appSlots()) || personas.forUrl(url);
const searchEngine = () => (ENGINES[getSettings().searchEngine] ? getSettings().searchEngine : 'google');
const newTabUrl = () => `file://${NEWTAB_FILE.replace(/\\/g, '/')}?e=${searchEngine()}`;
const isNewTabUrl = (u) => typeof u === 'string' && u.startsWith('file://') && u.includes('newtab.html');
// Keep in sync with ui/index.html's grid.
const SIDEBAR_W = 240;
const TOPBAR_H = 44;
const BM_PANEL_W = 280; // #11 bookmarks panel / #26 passwords panel, right side
const FIND_H = 38; // #101: find bar, docked under the nav bar
// #107 part B: the slow/flickering switches are not diagnosed yet, and guessing
// at a fix for a performance complaint is how you ship a change that helps
// nothing. Record the switches that are actually slow, with the context needed
// to tell the candidates apart — tab count, whether the tab had to load for the
// first time (#78), and whether a sync was mid-flight (#57). Declared up here
// with the other constants because both users sit far above its old position.
const SLOW_SWITCH_MS = 120;
// #118: for spotting the tab flicker — two activations in quick succession.
let lastActivationAt = 0;
let lastActivationId = null;
// #123: update progress, surfaced in Settings so the flow is never silent again.
let updateState = { status: 'idle', at: 0 };
let updateCheckNow = null; // set once the updater is wired (packaged builds only)
let bmPanelOpen = false;
let pwPanelOpen = false; // #26 — shares the right-panel slot with bookmarks
let findOpen = false; // #101
let loginPromptOpen = false; // #145
let ytdlpOpen = false; // #156: the download picker holds the window like the login prompt
let outfitOpen = false; // #179: the MuseForge outfit dialog, same pattern
let outfitReturn = null; // #191: { tabId, openerId } while a Create Outfit tab is open

let win, chrome, lockView;
const tabs = new Map(); // id -> WebContentsView
let tabOrder = [];      // ids in sidebar order (pinned group first)
let activeId = null;
let nextTabId = 1;
const pinnedIds = new Set(); // #9
// #117: a pinned tab is sticky like a quick-launch tab, so it needs a home to be
// sticky TO. Hotkey tabs get theirs from the binding; a pin captures whatever
// the tab was showing when it was pinned. Persisted in the session, or
// stickiness would silently die on restart — the #116 failure mode.
const pinnedHome = new Map(); // tabId -> url

// #117: the two kinds of tab that only ever show their own site.
const isStickyTab = (id) => hotkeyByTab.has(id) || pinnedIds.has(id);

/** Where a sticky tab belongs: its binding's URL, or the URL it was pinned on. */
function stickyHomeUrl(id) {
  const keyId = hotkeyByTab.get(id);
  if (keyId) {
    // #78/#116: resolve in THIS tab's Persona — a persona-less lookup reads the
    // Unassigned bucket and silently finds nothing.
    const home = hotkeys.get(keyId, personaByTab.get(id))?.url;
    if (home) return home;
  }
  return pinnedHome.get(id) || null;
}
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
const customTitles = new Map(); // #236: tabId -> user-chosen name (display only; sync and unread use the page title)
// #226: tabId -> ms of the last time you actually LOOKED at it. Unlike
// lastActiveAt it is never set at creation, so a tab synced in the background
// from the phone can't hijack Ctrl+Tab.
const lastVisitAt = new Map();
// #148: which views have actually produced a frame. A view created while the
// window was hidden (external link into a minimised WebForge) never paints, and
// showing it is not enough to make it — hence forceRepaint below.
const everPainted = new Set(); // tabId
const lastBounds = new Map(); // #148: tabId -> the bounds layout() last applied
const hiddenAt = new Map(); // #216: tabId -> ms it was last hidden, so a quick flip skips the repaint
let windowWasHidden = false; // #216: minimised/hidden since the last return, vs a plain focus
let blurredAt = 0; // #216: a long blur counts as hidden — occlusion fires no minimise
// #101: Ctrl+Shift+T — closed tabs, most recent last. Capped so a long session
// can't grow it without bound; pinned tabs never reach here (closeTab refuses).
const closedTabs = [];
const CLOSED_STACK_MAX = 25;
let locked = true;           // #15: the app is a brick until the vault unlocks

// #25: switch persona — land on one of its tabs, creating one if it has none.
function switchPersona(personaId) {
  const startedAt = Date.now(); // #107 part B
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
  const elapsed = Date.now() - startedAt; // #107 part B
  if (elapsed > SLOW_SWITCH_MS) {
    errorlog.record(
      'slow-persona-switch',
      `${elapsed}ms to=${personaId} tabs=${tabs.size} inPersona=${mine.length} syncing=${tabsSyncing}`
    );
  }
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
  // #176: adult tabs are never written to the session, so a restart can't bring one back.
  // #214: terminal sessions don't restore. #221: app slot tabs do, now that a slot holds several.
  const kept = tabOrder.filter((id) => !isAdultTab(id) && !isTerminalTab(id));
  return {
    tabs: kept
      .map((id) => ({
        url: realUrl(id, lazyTabs.get(id)?.url || tabs.get(id).webContents.getURL()), // #232: never a reader data: URL
        title: lazyTabs.get(id)?.title || tabs.get(id).webContents.getTitle(), // #78
        pinned: pinnedIds.has(id),
        pinHome: pinnedHome.get(id) || null, // #117: or stickiness dies on restart
        hotkey: hotkeyByTab.get(id) || null,
        persona: personaByTab.get(id) || personas.UNASSIGNED, // #25
        lastActiveAt: lastActiveAt.get(id) || Date.now(), // #79
        customTitle: customTitles.get(id) || null, // #236
      }))
      .filter((t) => t.url),
    active: Math.max(0, kept.indexOf(activeId)),
  };
}
// #216: every state push asked for a save, and Teams/Outlook/Mattermost retitle
// their tabs with each unread count, so the session was re-encrypted and
// rewritten constantly. Only what restore depends on (urls, pins, hotkeys,
// Personas, order, active) triggers a write now; titles and last-used times
// ride along with the next one, and quit always writes.
let savedSessionKey = null;
function sessionKey(snap) {
  return JSON.stringify([snap.active, snap.tabs.map((t) => [t.url, t.pinned, t.pinHome, t.hotkey, t.persona, t.customTitle])]); // #236: a rename must reach disk
}
function saveSessionSoon() {
  if (locked) return;
  clearTimeout(saveSessionTimer);
  // #147: sessionSnapshot() reads every tab's webContents; on quit those are
  // already gone. Nothing to save at that point anyway — the session was
  // flushed synchronously on the way out.
  saveSessionTimer = setTimeout(() => {
    if (!alive()) return;
    const snap = sessionSnapshot();
    const key = sessionKey(snap);
    if (key === savedSessionKey) return;
    vault.writeFile('session', snap);
    savedSessionKey = key;
  }, 3000);
}
function saveSessionNow() {
  if (locked) return;
  clearTimeout(saveSessionTimer);
  const snap = sessionSnapshot();
  vault.writeFile('session', snap);
  savedSessionKey = sessionKey(snap);
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

// #148: make a view produce a frame when the compositor otherwise won't.
//
// `invalidate()` is the intended lever. The nudge is the fallback: a genuine
// 1px geometry change, reverted next tick, which Chromium cannot elide the way
// it elides a setBounds to identical bounds. AUTOFILL-style flag so the heavier
// option can be turned on without another round trip if invalidate isn't enough
// on real Windows — I cannot test the on-screen effect from this host.
const REPAINT_NUDGE = true;

// #148 round 5: chrome was never in any of this.
//
// Every round so far has forced a repaint on the active TAB and nothing else.
// But the report is "the screen is just white" and "full black" — the whole
// window. If only the page view were blank, the sidebar and nav bar would still
// be there, because chrome is a separate WebContentsView drawing its own
// pixels. A window-wide blank means chrome is not painting either, and no fix
// so far has even touched it.
//
// No visibility toggle here: chrome is always meant to be visible, and hiding
// it is exactly the class of mistake that broke typing in 0.1.160. Invalidate
// and a geometry nudge only.
function forceRepaintChrome() {
  if (!win || win.isDestroyed() || !chrome) return;
  const wc = chrome.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.invalidate();
  } catch (err) {
    errorlog.record('forceRepaintChrome.invalidate', err);
  }
  if (!REPAINT_NUDGE) return;
  try {
    const current = chrome.getBounds();
    const nudged = repaint.nudgeBounds(current);
    if (!repaint.isDistinct(current, nudged)) return;
    chrome.setBounds(nudged);
    setImmediate(() => {
      if (!win || win.isDestroyed() || !chrome) return;
      try {
        chrome.setBounds(current);
      } catch (err) {
        errorlog.record('forceRepaintChrome.restore', err);
      }
    });
  } catch (err) {
    errorlog.record('forceRepaintChrome.nudge', err);
  }
}

function forceRepaint(id, ctx, attempt = 0) {
  const view = tabs.get(id);
  if (!view || !win || win.isDestroyed()) return;
  const wc = view.webContents;
  if (!wc || wc.isDestroyed()) return;

  const full = { everPainted: everPainted.has(id), ...ctx };
  const levers = repaint.leversFor(full, attempt);
  if (!levers.length) return;
  const { reason } = repaint.shouldForce(full);

  for (const lever of levers) {
    try {
      if (lever === 'visibility') {
        // THE ONE THAT MATTERS. A renderer started under a hidden window is
        // already flagged visible in the bookkeeping, so nothing re-pushes the
        // state when the window appears and it never produces a frame. Only a
        // real transition re-pushes it — hence false, then true on a later tick
        // so the two are not coalesced into nothing.
        if (id === activeId) {
          view.setVisible(false);
          setImmediate(() => {
            if (!win || win.isDestroyed() || !tabs.has(id) || id !== activeId) return;
            try {
              view.setVisible(true);
              // Focus does NOT survive the view being hidden, and a focusless
              // page swallows every key (#30). leversFor already keeps this
              // lever away from activateTab, where focus() runs right after;
              // this is the second line of defence for the paths that remain.
              view.webContents.focus();
            } catch (err) {
              errorlog.record('forceRepaint.visible', err);
            }
          });
        }
      } else if (lever === 'invalidate') {
        wc.invalidate();
      } else if (lever === 'nudge' && REPAINT_NUDGE) {
        const current = view.getBounds();
        const nudged = repaint.nudgeBounds(current);
        if (repaint.isDistinct(current, nudged)) {
          view.setBounds(nudged);
          setImmediate(() => {
            if (!win || win.isDestroyed() || !tabs.has(id)) return;
            try {
              view.setBounds(current);
            } catch (err) {
              errorlog.record('forceRepaint.restore', err);
            }
          });
        }
      } else if (lever === 'capture') {
        // capturePage cannot be satisfied without a frame, so asking for one
        // obliges the renderer to produce it. Heaviest lever; result discarded.
        wc.capturePage().catch(() => {});
      }
    } catch (err) {
      errorlog.record(`forceRepaint.${lever}`, err);
    }
  }

  errorlog.record(
    'repaint',
    new Error(`forced tab=${id} attempt=${attempt} reason=${reason} levers=${levers.join(',')}`)
  ); // #148 diagnostics
  diagnoseRepaint(id, attempt);
  // Having been shown under a genuinely visible window and given the full
  // treatment, it counts as painted. Deliberately NOT set while the window is
  // hidden or minimised — that is exactly the state where showing a view paints
  // nothing, and claiming otherwise would suppress the repaint it still needs.
  if (win.isVisible() && !win.isMinimized()) everPainted.add(id);
}

// #148 round 4: I have now been wrong about this mechanism twice, and on this
// display-less host I could not reproduce the fault at all — a probe showed the
// renderer's visibilityState recovering correctly on win.show(), which argues
// against the theory this round's fix is built on.
//
// So rather than guess a fourth time, make the app report what is actually
// true at the moment a repaint is forced. Runs only on a forced repaint, never
// on the hot path, and every part is guarded: a diagnostic must never be able
// to break the thing it is diagnosing.
//
// Read it in Settings → errors.
function diagnoseRepaint(id, attempt) {
  const view = tabs.get(id);
  if (!view || !win || win.isDestroyed()) return;
  const wc = view.webContents;
  if (!wc || wc.isDestroyed()) return;

  const bounds = (() => {
    try {
      return JSON.stringify(view.getBounds());
    } catch {
      return '?';
    }
  })();
  const winState = `visible=${win.isVisible()} minimised=${win.isMinimized()} focused=${win.isFocused()}`;

  // What the RENDERER believes, which is the question the fix turns on.
  // NOT with userGesture — round 4 passed `true` here, which fakes a user
  // gesture into the page on every diagnostic run. Diagnostics must observe,
  // never act.
  wc.executeJavaScript('document.visibilityState + "|" + document.hasFocus()')
    .then((pageState) => {
      // And whether it can actually produce a frame: a capture that comes back
      // uniform is a renderer drawing nothing, which distinguishes "no frame"
      // from "frame arrived but something covers it".
      return wc.capturePage().then((img) => {
        let painted = 'capture-failed';
        try {
          const size = img.getSize();
          const bmp = img.toBitmap();
          if (!bmp || !bmp.length) painted = 'empty';
          else {
            // A FULL scan, capped once enough variety is found. A sparse stride
            // was tried first and reported a page of text as uniform — it
            // stepped straight over the glyphs. Verified against three fixtures:
            // blank -> 1, a solid colour block -> 1, a text page -> >64.
            const seen = new Set();
            for (let i = 0; i + 4 <= bmp.length; i += 4) {
              seen.add(bmp.readUInt32LE(i));
              if (seen.size > 64) break;
            }
            // One colour does NOT by itself mean "nothing painted" — a solid
            // page is legitimately uniform — so report the colour too. Uniform
            // AND equal to our background is the blank case.
            const first = bmp.subarray(0, 4).join(',');
            painted =
              seen.size > 64
                ? `${size.width}x${size.height} colours=many`
                : `${size.width}x${size.height} colours=${seen.size} rgba=${first}`;
          }
        } catch (err) {
          painted = `bitmap-error:${err.message}`;
        }
        // #148 round 5: report CHROME too. Until now the log would have said
        // the page view was fine while the sidebar beside it was blank, and
        // nothing would have pointed at the difference.
        let chromeState = 'chrome=?';
        try {
          if (chrome && !chrome.webContents.isDestroyed()) {
            chromeState = `chromeBounds=${JSON.stringify(chrome.getBounds())} chromeLoading=${chrome.webContents.isLoading()}`;
          }
        } catch {
          chromeState = 'chrome=unreadable';
        }
        errorlog.record(
          'repaint-state',
          new Error(
            `tab=${id} attempt=${attempt} ${winState} bounds=${bounds} page=${pageState} frame=${painted} ${chromeState}`
          )
        );
      });
    })
    .catch((err) => errorlog.record('repaint-state', new Error(`tab=${id} diagnose failed: ${err.message}`)));
}

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
      bmDialogOpen || settingsOpen || managerOpen || bmPanelOpen || pwPanelOpen || loginPromptOpen || ytdlpOpen || outfitOpen
        ? { x: 0, y: 0, width, height }
        : fsRegionBounds()
    );
    return;
  }
  chrome.setBounds({ x: 0, y: 0, width, height });
  if (view) {
    // #101: an open find bar takes a strip beside the nav rather than floating
    // over the page — the page view is a separate native view and would draw
    // straight over anything the chrome painted in its region.
    // #119: the nav bar lives at the BOTTOM, so both it and the find bar come
    // off the bottom of the page view and the page starts at y = 0.
    const reserved = TOPBAR_H + (findOpen ? FIND_H : 0);
    const next = {
      x: SIDEBAR_W,
      y: 0,
      width: width - SIDEBAR_W - (bmPanelOpen || pwPanelOpen ? BM_PANEL_W : 0),
      height: height - reserved,
    };
    // #148: remember what we applied. A setBounds to IDENTICAL geometry is a
    // no-op in Chromium — it never reaches the compositor — so knowing whether
    // the geometry actually moved is what tells forceRepaint whether a frame is
    // already coming or whether it has to provoke one itself.
    lastBounds.set(activeId, next);
    view.setBounds(next);
  }
}

/** #148: did layout() actually move this view since last time? */
function boundsChangedFor(id) {
  const view = tabs.get(id);
  if (!view) return false;
  const before = lastBounds.get(id);
  layout();
  return repaint.isDistinct(before, lastBounds.get(id));
}

// --- #14: true fullscreen with hover-reveal edges ---
let fullscreen = false;
let fsRevealed = null; // 'tabs' | 'nav' | 'bookmarks' | null
let fsPollTimer = null;

function fsRegionBounds() {
  const { width, height } = win.getContentBounds();
  // #101: find beats a hover-reveal — you asked for the bar, so it stays put
  // until you close it, even as the mouse wanders off the edge.
  // #119: anchored to the bottom now, following the nav bar.
  if (findOpen) return { x: 0, y: height - FIND_H, width, height: FIND_H };
  switch (fsRevealed) {
    case 'tabs':
      return { x: 0, y: 0, width: SIDEBAR_W, height };
    case 'nav':
      // #119: the nav reveals from the BOTTOM edge.
      return { x: 0, y: height - (TOPBAR_H + 2), width, height: TOPBAR_H + 2 };
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
    if (y >= height - 2) want = 'nav'; // #119: bottom edge, and it wins the corners
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
  // #131: opening the panel puts focus IN it, and closing it hands focus back to
  // the page. Previously Ctrl+B only changed what was on screen — you still
  // needed the mouse to use it, which is the whole complaint.
  // setImmediate so the rows exist: pushBookmarks re-renders the list.
  setImmediate(() => focusTheSurface(bmPanelOpen ? 'bookmarks' : focusring.PAGE));
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
  if (!settingsOpen && !managerOpen && !ytdlpOpen && !outfitOpen) setChromeRaised(false);
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
    personas: routablePersonas().map((p) => ({ id: p.id, name: p.name })),
  });
}

function visibleTabs() {
  // #25: the sidebar only ever shows the ACTIVE persona's tabs.
  const active = personas.activeId();
  return tabOrder.filter((id) => (personaByTab.get(id) || personas.UNASSIGNED) === active);
}

// #107: the ONE definition of "the order tabs appear in". Both the sidebar
// (through tabState) and the cycling chords use it, so they cannot disagree —
// which is exactly what made Ctrl+PageUp/PageDown appear to hop around the
// screen: it walked tabOrder, which knows nothing about hotkey-key sorting (#44)
// or group buckets (#34), while the sidebar drew something else entirely.
function displayOrderedIds() {
  const items = visibleTabs().map((id) => ({
    id,
    url: tabUrlOf(id),
    hotkey: hotkeyByTab.get(id) || null,
    pinned: pinnedIds.has(id),
  }));
  // personas.matches is the same pattern algorithm the sidebar uses (#72),
  // reused rather than reimplemented.
  return taborder.displayOrder(items, getSettings().tabGroups || [], personas.matches).map((t) => t.id);
}

function tabState() {
  return displayOrderedIds().map((id) => {
    const wc = tabs.get(id).webContents;
    const pending = lazyTabs.get(id); // #78: not loaded yet — use saved values
    const rawUrl = realUrl(id, pending ? pending.url : wc.getURL()); // #232: the address bar shows the article, not the reader's data: URL
    const isNew = isNewTabUrl(rawUrl); // #43: don't surface the file:// path
    const internal = isInternalUrl(rawUrl)
      ? rawUrl.includes('settings.html') ? 'Settings'
        : rawUrl.includes('about.html') ? 'About'
        : rawUrl.includes('passwords.html') ? 'Saved logins'
        : 'Bookmarks'
      : null;
    const pageTitle =
      internal ||
      (isNew ? 'New tab' : (pending ? pending.title : wc.getTitle()) || rawUrl || 'New tab');
    return {
      id,
      title: customTitles.get(id) || pageTitle, // #236: the user's name wins in the sidebar
      pageTitle, // #236: the real title, shown as the row tooltip
      url: isNew || internal ? '' : rawUrl,
      loading: wc.isLoading(),
      active: id === activeId,
      pinned: pinnedIds.has(id),
      hotkey: hotkeyByTab.get(id) || null,
      favicon: faviconByTab.get(id) || null, // #45
      starred: bookmarks.has(rawUrl), // #232
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  });
}

// #71: Unassigned is the fallback, not a destination, so it goes last.
// #214: keyed Personas and app slots come first, in key order (` ! @ # $ % ^).
// personaorder.js holds the rule, under test.
function orderedPersonas() {
  return personaorder.orderPersonas(personas.all(), appSlots());
}
// Personas a URL can be routed to: not Terminal or the app slots, which have no rules.
const routablePersonas = () => orderedPersonas().filter((p) => !personas.isBuiltinView(p.id));

// #214: app slots. Their URLs are local settings (settings.appSlots = {id: url}),
// editable in Settings › App slots, never synced.
const appSlots = () => personaorder.slots(getSettings().appSlots);
function applySlots() {
  personas.setSlots(personaorder.orderPersonas([], appSlots()).filter((p) => p.slot));
}
function saveSlots(urls) {
  const before = new Map(appSlots().map((s) => [s.id, s.url]));
  const clean = {};
  for (const s of personaorder.DEFAULT_SLOTS) {
    const u = personaorder.slotUrl(urls && urls[s.id]);
    if (u && u !== s.url) clean[s.id] = u;
  }
  getSettings().appSlots = clean;
  saveSettings();
  applySlots();
  // An open slot tab follows a CHANGED URL; the rest keep their calls and drafts.
  for (const tid of tabOrder) {
    const p = isSlotTab(tid) && personas.get(personaByTab.get(tid));
    if (p && tabs.has(tid) && !lazyTabs.has(tid) && before.get(p.slot) !== p.url) tabs.get(tid).webContents.loadURL(p.url);
  }
  pushPersonas();
  return appSlots();
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

// #216: the sidebar re-renders on every message, and most pushes change
// nothing in a given channel. Send a channel only when its payload differs.
const lastSent = new Map(); // channel -> JSON last sent
function sendIfChanged(channel, payload) {
  const json = JSON.stringify(payload);
  if (lastSent.get(channel) === json) return;
  lastSent.set(channel, json);
  chrome.webContents.send(channel, payload);
}

// #231: an app slot's unread badge, from its tabs' titles ("(3) …", "* …").
function slotUnread(pid) {
  const titles = tabOrder
    .filter((t) => personaByTab.get(t) === pid)
    .map((t) => (lazyTabs.has(t) ? lazyTabs.get(t).title : tabs.get(t)?.webContents.getTitle()));
  return personaorder.unreadBadge(titles);
}

function pushPersonas() {
  if (!chrome) return;
  const active = personas.activeId();
  sendIfChanged('personas-updated', {
    personas: orderedPersonas().map((p) => ({
      id: p.id,
      name: p.name,
      builtin: Boolean(p.builtin),
      rules: p.rules,
      key: p.key || '', // #214: the key after Ctrl+Space
      unread: p.slot ? slotUnread(p.id) : '', // #231
    })),
    active,
  });
}

// #147: every deferred callback in this file can outlive the thing it touches.
// #20 was this exact bug in fsPoll — the window died with the interval still
// scheduled, and "Object has been destroyed" fired every tick until Electron's
// modal error dialog made the app unusable. That fix guarded one callback; this
// is the guard as a shared rule, because the next timer added would have had to
// remember on its own, and pushState did not.
let quitting = false; // #219
function alive() {
  if (!win || win.isDestroyed()) return false;
  if (!chrome || chrome.webContents.isDestroyed()) return false;
  return true;
}

// #78: a loading page fires start/stop/title/favicon/navigate in quick
// succession, and each one rebuilt and shipped the whole tab list. Coalesce.
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushStateNow();
  }, 100); // #216: was 40ms; a loading page still lands in one or two pushes
}

function pushStateNow() {
  // #147: `chrome` being non-null said nothing about whether its WebContents —
  // or the window — was still alive. Quitting inside the 40ms coalescing window
  // threw here, and a throw in this function means the sidebar silently stops
  // updating until the next successful push.
  if (!alive()) return;
  pushPersonas(); // #25
  sendIfChanged('tabs-updated', tabState()); // #216
  sendIfChanged('remote-tabs', remoteTabsForActive()); // #57
  const wc = activeWc();
  const title = customTitles.get(activeId) || wc?.getTitle(); // #236
  win.setTitle(title ? `${title} — WebForge` : 'WebForge');
  saveSessionSoon();
}

// #111/#219: a popup's page is web content and must never be more privileged
// than a normal tab, whoever opened it: the page preload, no node integration,
// context isolation on. Applied when a tab adopts a window.open() page.
const POPUP_PREFS = Object.freeze({
  preload: path.join(__dirname, 'content-preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
});

// --- #133: the right-click menu ----------------------------------------------
//
// Before this the only context menu was #100's, which returned early unless the
// selection matched a text rule — so right-clicking a link, an image or a text
// box produced nothing at all.
//
// WHICH items appear lives in ctxmenu.js (unit-tested: six conditional sections,
// and a wrong branch shows up as a silently missing item). This half only maps
// each id to what it does.
function contextMenuFor(wc, params) {
  const selection = String(params.selectionText || '').trim();
  const hit = selection && !params.isEditable ? textrules.resolve(selection, textRules()) : null;
  const nav = wc.navigationHistory;
  // #219: a link opened from here lands in this tab's Persona (an app slot's home).
  const fromId = [...tabs].find(([, v]) => v.webContents === wc)?.[0];
  const home = personaorder.openerHome(personaByTab.get(fromId), orderedPersonas());

  const actions = {
    'link.open': () => openOrFocus(params.linkURL, false, undefined, home),
    'link.openBackground': () => openOrFocus(params.linkURL, true, undefined, home),
    'link.copy': () => clipboard.writeText(params.linkURL),
    // There is no downloads surface yet — Electron's default Save As dialog is
    // what makes this item honest. A real downloads UI is its own ticket.
    'link.save': () => wc.downloadURL(params.linkURL),
    'image.open': () => openOrFocus(params.srcURL, false, undefined, home),
    'image.copy': () => wc.copyImageAt(params.x, params.y),
    'image.copyAddress': () => clipboard.writeText(params.srcURL),
    'image.save': () => wc.downloadURL(params.srcURL),
    'rule.open': () => openFromSelection(selection), // #100, same resolver as Ctrl+J
    'selection.copy': () => wc.copy(),
    'selection.search': () =>
      openOrFocus(ENGINES[searchEngine()] + encodeURIComponent(selection), false),
    'edit.undo': () => wc.undo(),
    'edit.redo': () => wc.redo(),
    'edit.cut': () => wc.cut(),
    'edit.copy': () => wc.copy(),
    'edit.paste': () => wc.paste(),
    'edit.selectAll': () => wc.selectAll(),
    'nav.back': () => nav.goBack(),
    'nav.forward': () => nav.goForward(),
    'nav.reload': () => wc.reload(),
    'page.viewSource': () => viewSource(),
    'page.inspect': () => wc.inspectElement(params.x, params.y),
    'page.ytdlp': () => openYtdlpPicker(wc.getURL(), wc.getTitle()), // #156
    'link.ytdlp': () => openYtdlpPicker(params.linkURL, String(params.linkText || '').trim()), // #156
    'image.outfit': () => openOutfitDialog(params.srcURL), // #179
    'media.stash': () => sendToStash('media', params.srcURL, wc), // #177
    'page.stashVideo': () => sendToStash('video', wc.getURL(), wc),
    'page.stashGallery': () => sendToStash('gallery', wc.getURL(), wc),
  };

  const items = ctxmenu.build(params, {
    ruleLabel: hit ? (hit.rule.name ? `Open ${hit.matched} in ${hit.rule.name}` : `Open ${hit.matched}`) : null,
    engineName: ENGINE_NAMES[searchEngine()] || 'the web',
    canGoBack: nav.canGoBack(),
    canGoForward: nav.canGoForward(),
    pageYtdlp: ytdlp.downloadable(wc.getURL()), // #156
    linkYtdlp: ytdlp.downloadable(params.linkURL || ''),
    imageOutfit: museforge.canSend(params.srcURL), // #179
    mediaStash: stash.canSend(params.srcURL), // #177
    pageStash: stash.canSend(wc.getURL()),
  });

  return items.map((item) =>
    item.type === 'separator'
      ? { type: 'separator' }
      : {
          label: item.label,
          enabled: item.enabled !== false,
          click: actions[item.id] || (() => errorlog.record('context-menu', `no action for ${item.id}`)),
        }
  );
}

function createTab(url = null, background = false, personaId = null, opts = {}) {
  if (locked) return null; // #15
  const id = nextTabId++;
  // #214: a new tab in the Terminal Persona is a terminal (the host picker).
  if (!url && personaId === personas.TERMINAL) url = terminalUrl(null);
  // #214: an app slot's tab opens the slot's page and stays in the slot.
  const slot = personaorder.isSlotId(personaId) ? personas.get(personaId) : null;
  if (!url && slot) url = slot.url;
  if (!url) url = newTabUrl(); // #43: default landing page is our search page
  const terminal = isTerminalUrl(url);
  const lazy = Boolean(opts.lazy);
  if (lazy) lazyTabs.set(id, { url, title: opts.title || url }); // #78
  lastActiveAt.set(id, opts.lastActiveAt || Date.now()); // #79
  openedAt.set(id, opts.openedAt || Date.now()); // #57
  // #96: URL RULES DECIDE FIRST. An explicitly-passed persona (session restore,
  // a tab adopted from another device) used to win, so a Gerrit tab could be
  // created as Unassigned and only jump to Work when it first navigated —
  // which looked like tabs re-homing themselves when you clicked them.
  const claimed = claimOf(url); // #221: a slot's own site lands in the slot
  personaByTab.set(
    id,
    terminal
      ? personas.TERMINAL
      : slot
        ? personaId
        : claimed !== personas.UNASSIGNED
          ? claimed
          : pageHome(personaId || personas.UNASSIGNED)
  );
  // #95: this URL is open again, so stop publishing "closed" for it — otherwise
  // the other device keeps being told to kill a tab that is sitting right here.
  closedFacts.delete(url);
  // #219: a popup's page arrives already made (Electron's createWindow hook);
  // the tab adopts it so window.opener keeps working for sign-in popups.
  const adopt = opts.adopt || null;
  const view = new WebContentsView(adopt ? { webContents: adopt.webContents, webPreferences: { ...adopt.webPreferences, ...POPUP_PREFS } } : {
    // #41: hotkeys fire from the main process now (Ctrl+Space leader), so no
    // page-side key capture — and no need for subframe node integration (#39).
    // #40: our own pages get the privileged bridge; web content never does.
    webPreferences: {
      preload: terminal
        ? path.join(__dirname, 'terminal-preload.js') // #214
        : isInternalUrl(url)
          ? path.join(__dirname, 'internal-preload.js')
          : path.join(__dirname, 'content-preload.js'),
    },
  });
  // #148: an unpainted view defaults to black, which is what made the
  // external-link bug look like a crash rather than a missing frame. This does
  // not fix the missing frame — forceRepaint does — but a blank white page is a
  // far less alarming failure than a black window if one ever slips through.
  try {
    view.setBackgroundColor(terminal ? '#0c0c0c' : '#ffffff');
  } catch (err) {
    errorlog.record('setBackgroundColor', err);
  }
  tabs.set(id, view);
  // #219: a popup goes right after the tab that opened it.
  const after = opts.after !== undefined ? tabOrder.indexOf(opts.after) : -1;
  if (after >= 0) tabOrder.splice(after + 1, 0, id);
  else tabOrder.push(id);

  const wc = view.webContents;
  if (terminal) {
    terminalMain.attach(wc); // #214: its ssh session lives and dies with the tab
    // A terminal tab never becomes a web page: that page would inherit window.terminal.
    wc.on('will-navigate', (event) => event.preventDefault());
  }
  // Popups (window.open / target=_blank) become tabs, never OS windows.
  // #30: they open FOREGROUND — clicking a link that spawns a tab should put
  // you in that tab (matches every mainstream browser; reverses #4's call).
  // #31: same URL already open → focus that tab instead of spawning a dupe.
  // #111: a deliberate popup — window.open() WITH features — must not be
  // denied: that made window.open() return null, so any page that kept the
  // handle (`w.document.write(...)`, `w.focus()`, `w.location = …`) threw on the
  // next line and its flow died (credential prompts, terminal launchers).
  // #219: it is allowed, but as a TAB: createWindow adopts the new page into a
  // tab, so the handle (and window.opener for sign-in popups) still works.
  // Every new window lands in the opener's Persona (an app slot's home Persona).
  wc.setWindowOpenHandler((details) => {
    const real = popuprule.wantsRealWindow(details); // #125
    const home = personaorder.openerHome(personaByTab.get(id), orderedPersonas());
    // #111 round 2: log every decision. The first fix keyed only on
    // disposition === 'new-window' and did not work, and there is no Windows
    // machine here to observe on — so the app has to say what it decided.
    errorlog.record(
      'window-open',
      `decision=${real ? 'adopted-tab' : 'tab'} disposition=${details.disposition} ` +
        `frameName="${details.frameName}" features="${details.features}" ` +
        `fullscreen=${fullscreen} url=${details.url}`
    );
    if (locked) return { action: 'deny' };
    if (real) {
      return {
        action: 'allow',
        outlivesOpener: true, // closing the opener tab doesn't take the popup tab with it
        overrideBrowserWindowOptions: { webPreferences: { ...POPUP_PREFS } },
        createWindow: (options) => {
          const tid = createTab(details.url || 'about:blank', false, home, { adopt: options, after: id });
          return tid === null ? undefined : tabs.get(tid).webContents; // null only if locked mid-open
        },
      };
    }
    openOrFocus(details.url, false, undefined, home);
    return { action: 'deny' };
  });
  // #33: hotkey tabs are STICKY — page-initiated navigation (link clicks)
  // opens elsewhere instead of navigating the hotkey tab away. Programmatic
  // loads (hotkey go-home, address bar, bookmarks) don't fire will-navigate,
  // so they still steer this tab. Known caveat: form submissions are
  // indistinguishable from link clicks here.
  wc.on('will-navigate', (event, navUrl) => {
    if (isStickyTab(id)) { // #117: pinned tabs divert like hotkey tabs
      event.preventDefault();
      openOrFocus(navUrl, false, undefined, personaorder.openerHome(personaByTab.get(id), orderedPersonas())); // #219
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
    // #117: pinned tabs are sticky too, and get their home from the pin.
    const home = stickyHomeUrl(id);
    if (!home) return;
    // #78: only enforce across ORIGINS — comparing full URLs livelocked the app.
    // The rule and the reasoning now live in stickytab.js, under test.
    if (!stickytab.shouldRehome(navUrl, home)) return;
    // #118: a re-home ACTIVATES another tab. If that lands mid-switch it looks
    // exactly like the reported flicker, so make it visible in diagnostics.
    errorlog.record('sticky-rehome', `tab=${id} left ${home} for ${navUrl}`);
    reHoming = true;
    // #138: exclude THIS tab. enforceHome runs on did-navigate, so the drift has
    // already landed and this tab is currently the one showing navUrl — without
    // the exclusion openOrFocus picked it as its own rescue target, opened
    // nothing, and the loadURL below then threw the page away. That is the
    // "bookmark flickers and never opens" report.
    openOrFocus(navUrl, false, id, personaorder.openerHome(personaByTab.get(id), orderedPersonas())); // #219
    wc.loadURL(home);
    setTimeout(() => {
      reHoming = false;
    }, 800);
  };
  wc.on('did-navigate', (_e2, navUrl) => enforceHome(navUrl, true));
  wc.on('did-navigate-in-page', (_e2, navUrl, isMainFrame) => {
    enforceHome(navUrl, isMainFrame);
    // #145: plenty of sign-ins never fire a full did-navigate — an SPA router
    // pushState()s to the landing page. Without this the prompt simply never
    // appeared on those sites.
    if (isMainFrame !== false) settleLogin(id, wc, navUrl);
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
  // #148 round 5: the external-link force fires from activateTab, before
  // loadURL has produced anything, so it kicks an empty renderer. Kick it once
  // more when there IS something to draw.
  //
  // Round 4 ran this on EVERY did-stop-loading, which meant a bounds nudge, a
  // capturePage, an executeJavaScript and a full-bitmap scan on every single
  // page load. On a site that navigates constantly (Gerrit) that is relentless,
  // and 0.1.160 broke typing app-wide. Whatever the precise mechanism — I could
  // not reproduce it on this display-less host — touching the page on every
  // navigation to chase a bug that only happens on FIRST paint was never
  // justified. So: only a view that has never painted, and only once.
  // #238: a tab that keeps navigating itself (the Outlook "flashing white")
  // gets one log record a minute with its recent URLs, so the PC log can say
  // whether it is reloading, re-routing in-page, or bouncing between URLs.
  const noteNav = navloop.createNavLoop();
  wc.on('did-start-navigation', (details, legacyUrl, legacyInPage, legacyMainFrame) => {
    const d = details && typeof details === 'object' && 'url' in details ? details : null;
    const isMain = d ? d.isMainFrame : legacyMainFrame;
    if (!isMain) return;
    const url = d ? d.url : legacyUrl;
    const inPage = d ? d.isSameDocument : legacyInPage;
    const report = noteNav(url, inPage ? 'in-page' : 'load');
    if (report) errorlog.record('nav-loop', `tab=${id} persona=${personaByTab.get(id)} active=${id === activeId}\n${report}`);
  });
  wc.on('did-stop-loading', () => {
    if (id !== activeId || !win || win.isDestroyed()) return;
    if (!win.isVisible() || win.isMinimized()) return;
    if (everPainted.has(id)) return; // the ordinary case: leave the page alone
    forceRepaint(id, { becameVisible: true, boundsChanged: false }, 1);
  });
  wc.on('page-favicon-updated', (_e2, icons) => { // #45
    if (icons?.length) {
      faviconByTab.set(id, icons[0]);
      pushState();
    }
  });
  wc.on('did-navigate', (_e2, navUrl) => {
    if (id === activeId) syncAdultShield(); // #245: walking onto (or off) an adult site
    if (!String(navUrl).startsWith('data:')) readerTabs.delete(id); // #232: back/forward/link out of the reader view
    if (outfitReturn && outfitReturn.tabId === id && museforge.isDone(navUrl)) finishOutfit(); // #191
    settleLogin(id, wc, navUrl); // #145: did a submitted login just succeed?
    // Re-home the tab if it navigated into another persona's territory (#25).
    const claimed = claimOf(navUrl); // #221: a tab that walks onto a slot's site joins the slot
    const current = personaByTab.get(id);
    // #114: the first load of a lazily-restored tab is not the user navigating
    // anywhere — following it switched Persona under a cycling user.
    const wasFirstLoad = firstLoad.delete(id);
    // #214: a terminal or app slot tab stays put (Teams bounces through sign-in pages).
    if (claimed !== personas.UNASSIGNED && claimed !== current && !personas.isBuiltinView(current)) {
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
  // #133: a full context menu, assembled from what was actually right-clicked.
  wc.on('context-menu', (_e2, params) => {
    if (locked) return;
    contextMenuOpen = true; // #176: a right-click menu isn't leaving the tab
    Menu.buildFromTemplate(contextMenuFor(wc, params)).popup({
      window: win,
      callback: () => {
        contextMenuOpen = false;
      },
    });
  });
  wireLoadFailures(wc); // #108 — also applied to popups by #111
  // #12, reworked in #136. One shot at did-finish-load filled almost nothing in
  // practice: on an SPA the password field does not exist yet, and a two-step
  // login (Google, Microsoft, most banks) only renders it after you submit the
  // username — long after the document finished loading. So each of these
  // events starts a short bounded retry schedule instead of a single attempt.
  wc.on('did-finish-load', () => scheduleAutofill(wc));
  wc.on('did-navigate-in-page', () => scheduleAutofill(wc)); // SPA route change
  wc.on('dom-ready', () => {
    wc.send('sticky-mode', isStickyTab(id)); // #33, #117
    // #36 round 2: hide scrollbars on PAGES too (user: "most certainly not
    // gone") — scrolling itself is untouched.
    wc.insertCSS(
      '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}'
    ).catch(() => {});
  });
  wireChords(wc); // #22

  win.contentView.addChildView(view);
  view.setVisible(false);
  // #219: a page that closes itself (window.close() from a popup) takes its tab with it.
  wc.once('destroyed', () => {
    if (quitting || locked || !alive()) return;
    if (tabs.get(id) === view) closeTab(id, { gone: true });
  });
  if (!lazy && !adopt) wc.loadURL(url); // #78: lazy tabs load on first activation; #219: an adopted page is already loading
  if (background && activeId !== null) pushState();
  else activateTab(id);
  return id;
}

function activateTab(id, opts = {}) {
  const startedAt = Date.now();
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
  if (leaving !== id && tabs.has(leaving)) terminalMain.clearHold(tabs.get(leaving).webContents); // #214
  if (leaving !== id && tabs.has(leaving)) hiddenAt.set(leaving, Date.now()); // #216
  // #83: hide every other view, not just the outgoing one. Relying on a single
  // setVisible(false) meant any missed bookkeeping left two views stacked and
  // z-order picked the winner — the 'wrong tab' the user was seeing.
  for (const [tid, v] of tabs) {
    if (tid !== id) v.setVisible(false);
  }
  activeId = id;
  syncAdultShield(); // #245
  const view = tabs.get(id);
  lastActiveAt.set(id, Date.now()); // #79: expiry is measured from last use
  lastVisitAt.set(id, Date.now()); // #226
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
  //
  // #118: but the OLD wording skipped the raise entirely while an overlay or a
  // fullscreen hover-reveal was up — and clicking a tab in the sidebar always
  // means a reveal is up, because the sidebar IS the left-edge reveal region.
  // The newly activated view could therefore stay below the outgoing one in
  // z-order. Now the active view is always raised above the other PAGE views,
  // and chrome is put back on top afterwards when it is meant to be showing —
  // which preserves #32's fix rather than trading one for the other.
  const chromeOnTop = fsRevealed || bmDialogOpen || settingsOpen || managerOpen || loginPromptOpen || ytdlpOpen || outfitOpen; // #145/#156/#179
  win.contentView.addChildView(view);
  if (chromeOnTop) win.contentView.addChildView(chrome);
  // #148: boundsChangedFor runs layout() and reports whether the geometry moved.
  // If it didn't, setBounds was a no-op and this view may show the last frame it
  // had — or none at all — until something provokes the compositor.
  const moved = boundsChangedFor(id);
  const since = hiddenAt.get(id); // #216
  forceRepaint(id, { becameVisible: true, boundsChanged: moved, hiddenMs: since === undefined ? undefined : Date.now() - since });
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
  // #176: and any adult tab other than the one now in front, cycling or not.
  // nextInOrder/mostRecent resolve from activeId, so the shorter list can't
  // throw the next Ctrl+Tab off the way #114's index walk did.
  closeAdultTabs(id);
  pushState();
  // #118: the flicker signature is two activations in quick succession — the
  // view genuinely bouncing between tabs rather than merely repainting. Log only
  // that case, so diagnostics stay readable instead of one line per switch.
  const sinceLast = startedAt - lastActivationAt;
  if (lastActivationId !== null && lastActivationId !== id && sinceLast < 600) {
    errorlog.record(
      'tab-bounce',
      `${lastActivationId} -> ${id} after ${sinceLast}ms chromeOnTop=${chromeOnTop}`
    );
  }
  lastActivationAt = startedAt;
  lastActivationId = id;

  const elapsed = Date.now() - startedAt; // #107 part B
  if (elapsed > SLOW_SWITCH_MS) {
    errorlog.record(
      'slow-activate',
      `${elapsed}ms tabs=${tabs.size} inPersona=${visibleTabs().length} ` +
        `firstLoad=${Boolean(pending)} syncing=${tabsSyncing}`
    );
  }
}

function closeTab(id, opts = {}) {
  const view = tabs.get(id);
  if (!view) return;
  if (pinnedIds.has(id) && !opts.adult && !opts.gone) return; // #219: a destroyed page can't stay pinned; #9: pinned tabs don't close — unpin first (#176: adult ones do)
  if (outfitReturn && (id === outfitReturn.tabId || id === outfitReturn.openerId)) outfitReturn = null; // #191
  pinnedIds.delete(id);
  // #57: a close is a fact other devices must learn about — unless we're only
  // applying someone else's close, which must not echo back.
  // #219: a page that closed itself is already destroyed (getURL would throw),
  // and a popup closing itself isn't a close worth syncing or reopening.
  if (!opts.remote && !opts.gone) {
    const url = tabUrlOf(id);
    // #214: an app slot is reopened by its key, and the phone must not lose its own Teams tab.
    if (shareable(url) && !isViewTab(id)) {
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
  pinnedHome.delete(id); // #117: no stale homes for dead tabs
  faviconByTab.delete(id);
  personaByTab.delete(id);
  readerTabs.delete(id); // #232
  lazyTabs.delete(id);
  lastActiveAt.delete(id);
  customTitles.delete(id); // #236
  lastVisitAt.delete(id); // #226
  everPainted.delete(id); // #148
  hiddenAt.delete(id); // #216
  lastBounds.delete(id); // #148
  openedAt.delete(id);
  for (const [page, tid] of internalTabs) if (tid === id) internalTabs.delete(page);
  tabOrder = tabOrder.filter((t) => t !== id);
  win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close(); // #219: it may have closed itself
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
// #120: re-home every open tab against the current Persona rules.
//
// Two rules, both learned the hard way:
//  - tabUrlOf(), never webContents.getURL(). A lazily-restored tab (#78) has an
//    EMPTY webContents URL until first shown, so getURL() fed forUrl('') and
//    every unopened tab was reassigned to Unassigned. Same trap as #95/#116.
//  - PROMOTE, never demote. A URL matching no rule keeps the Persona it already
//    has, matching the #96 loop in onUnlocked.
//
// This existed inline in three places (persona sync, editing a Persona's rules,
// and #70's bookmark assignment) and all three had both defects. One copy now.
function rehomeAllTabs() {
  for (const tid of tabOrder) {
    const claimed = claimOf(tabUrlOf(tid)); // #221
    if (claimed !== personas.UNASSIGNED && !isViewTab(tid)) personaByTab.set(tid, claimed); // #214
  }
}

// #107: compare CANONICAL forms, not raw strings. Exact equality meant a
// trailing slash, a #anchor, http-vs-https or a www. prefix counted as a
// different page — so a tab that redirected on load stopped matching what the
// other device published, and the 30s sync adoption loop opened it again.
// #95: tabUrlOf, not getURL() — a lazily-restored tab (#78) has an empty
// webContents URL until it is first shown, so it was invisible here. Tab
// adoption then re-created it every sync, and clicking a bookmark for a
// restored-but-unopened tab opened a second copy.
// #138: `exceptId` excludes a tab from being its own answer; the selection rule
// itself now lives in taburl.pickTab, under test.
function findTabByUrl(url, exceptId) {
  return taburl.pickTab(
    tabOrder.map((id) => ({ id, url: tabUrlOf(id) })),
    url,
    exceptId
  );
}

// #138: `exceptId` must be threaded through — a sticky tab re-homing itself
// calls this to put the destination SOMEWHERE ELSE, and without the exclusion
// "somewhere else" could be the very tab it is about to send home.
function openOrFocus(url, background, exceptId, personaId = null) {
  const existing = findTabByUrl(url, exceptId);
  if (existing !== null) {
    if (!background) activateTab(existing);
    return existing;
  }
  return createTab(url, background, personaId); // #219: personaId = where it came from
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

// #232: reader mode (Ctrl+Alt+R, the 📖 button). The article is extracted in the
// page with Mozilla's Readability and shown in the SAME tab as a data: URL with
// baseURLForDataURL = the article, so relative images resolve and Back returns
// to the page. readerTabs remembers which tabs show one (tabId -> article URL);
// realUrl() keeps that data: URL out of the address bar, session, sync and bookmarks.
const readerTabs = new Map();
const realUrl = (id, url) => (readerTabs.has(id) && String(url).startsWith('data:') ? readerTabs.get(id) : url);
let readerLibs = null;
function readerSources() {
  if (!readerLibs) {
    readerLibs = [
      fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8'),
      fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8'),
    ];
  }
  return readerLibs;
}
// No generic toast exists in the chrome, so failures are an OS notification
// (as yt-dlp/Stash use) plus an errorlog line.
function readerNotice(message) {
  errorlog.record('reader', message);
  if (Notification.isSupported()) new Notification({ title: 'Reader mode', body: message }).show();
}
async function toggleReader() {
  if (locked) return;
  const id = activeId;
  const wc = activeWc();
  if (!wc || wc.isDestroyed()) return;
  if (readerTabs.has(id) && wc.getURL().startsWith('data:')) {
    const original = readerTabs.get(id);
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else wc.loadURL(original);
    return;
  }
  const url = tabUrlOf(id);
  if (lazyTabs.has(id) || isViewTab(id) || isInternalUrl(url) || isNewTabUrl(url) || !/^https?:\/\//i.test(url)) {
    readerNotice('Reader mode only works on web pages.');
    return;
  }
  try {
    const [readability, readerable] = readerSources();
    const article = await wc.executeJavaScript(reader.readerScript(readability, readerable));
    if (!article || !article.ok) {
      readerNotice((article && article.reason) || 'Could not find an article on this page.');
      return;
    }
    if (wc.isDestroyed() || activeId !== id || tabUrlOf(id) !== url) return; // navigated away while extracting
    readerTabs.set(id, article.url);
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(reader.readerHtml(article, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')), {
      baseURLForDataURL: article.url,
    });
  } catch (err) {
    errorlog.record('reader', err);
    readerNotice('Reader mode failed on this page.');
  }
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
  // #107: if it is open again already, focus it rather than making a twin.
  const existing = findTabByUrl(last.url);
  if (existing !== null) {
    activateTab(existing);
    return;
  }
  createTab(last.url, false, last.personaId);
}

// #214: Ctrl+Shift+T, Ctrl+Shift+Tab and the >_ button go to the Terminal
// Persona (it opens the host picker when it has no tabs yet). Already there,
// they open another terminal tab.
function openTerminal() {
  if (locked) return;
  if (personas.activeId() === personas.TERMINAL) createTab(null, false, personas.TERMINAL);
  else switchPersona(personas.TERMINAL);
}

// #214: a connection clicked in the panel opens as a new terminal tab.
function openConnection(target) {
  if (locked || !termhosts.validTarget(target)) return;
  createTab(terminalUrl(String(target)), false, personas.TERMINAL);
}

function pushConnections() {
  if (!alive()) return;
  chrome.webContents.send('terminal-connections', terminalMain.connections());
}

function cycleTab(dir) {
  // #75: cycle within the ACTIVE Persona only — walking the global tabOrder
  // jumped into other Personas' tabs and yanked the workspace out from under
  // the user, which reads as "Ctrl+Tab does nothing sensible".
  // #107: walk the order the SIDEBAR shows, not tabOrder. Ctrl+PageUp/PageDown
  // (and Ctrl+Shift+Tab) now move strictly up and down the visible list.
  const next = tabnav.nextInOrder(displayOrderedIds(), activeId, dir);
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
  // #226: across EVERY Persona (terminal and app slots too), so Ctrl+Tab flips
  // between, say, a terminal and Mattermost. Was inside the active Persona
  // only (#75); Ctrl+PageUp/PageDown still are.
  const target = tabnav.mostRecent(tabOrder, activeId, lastVisitAt);
  if (target === null) return;
  const before = personas.activeId();
  activateTab(target, { cycling: true }); // switches Persona when the tab lives elsewhere (#25)
  if (personas.activeId() !== before) broadcastHotkeys(); // badges follow the Persona, as in switchPersona
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
let lastTermArm = 0; // #214
function armLeader() {
  if (locked) return;
  // #214: in a terminal tab Ctrl+Space holds one key instead (see wireChords).
  // A second Ctrl+Space passes both on — forge turns the pair into a literal one.
  const twc = !managerOpen && !settingsOpen && isTerminalTab(activeId) ? activeWc() : null;
  if (twc && terminalMain.isTerminal(twc)) {
    leaderUntil = 0;
    // globalShortcut and before-input-event can both report one press; that
    // must not read as the double Ctrl+Space that passes a literal one on.
    if (Date.now() - lastTermArm < 60) return;
    lastTermArm = Date.now();
    if (terminalMain.holding(twc)) terminalMain.passDoublePrefix(twc);
    else terminalMain.setHold(twc, true);
    twc.focus();
    return;
  }
  leaderUntil = leaderUntil > Date.now() ? 0 : Date.now() + 3000; // toggle
  // Make sure SOMETHING focused hears the next key.
  if (leaderUntil) (managerOpen || settingsOpen ? chrome.webContents : activeWc())?.focus();
}

function wireLeaderShortcut() {
  const { globalShortcut } = require('electron');
  const register = () => {
    try {
      if (!globalShortcut.isRegistered(modifier.LEADER_ACCELERATOR)) {
        globalShortcut.register(modifier.LEADER_ACCELERATOR, armLeader);
      }
    } catch {}
  };
  const release = () => {
    try {
      globalShortcut.unregister(modifier.LEADER_ACCELERATOR);
    } catch {}
  };
  win.on('focus', register);
  win.on('blur', release);
  app.on('will-quit', release);
  if (win.isFocused()) register();
}

// #131: keyboard access to the chrome surfaces. Without this there is no way to
// reach the tab sidebar or bookmarks panel at all unless you use the mouse.
let focusSurface = focusring.PAGE;

function focusTheSurface(surface) {
  if (locked) return;
  focusSurface = surface;
  if (!focusring.isChromeSurface(surface)) {
    // Back to the page. Clearing the chrome's own focus ring matters — a
    // lingering ring on an unfocused sidebar is worse than none, because it
    // says "your keys go here" when they do not.
    chrome?.webContents.send('focus-surface', focusring.PAGE);
    activeWc()?.focus();
    return;
  }
  // The chrome view sits BEHIND the page view (activateTab raises the page), so
  // it must be focused explicitly before the renderer can move focus within it.
  // Verified in #103's probe: a covered view does take focus.
  chrome?.webContents.focus();
  chrome?.webContents.send('focus-surface', surface);
}

// #42: Esc closes the topmost open thing, from wherever focus happens to be.
function handleEscape() {
  // #131: if focus is parked in the chrome, Esc hands it back to the page before
  // closing anything. Otherwise the keyboard can be trapped in the sidebar, and
  // a navigation aid you cannot leave is worse than not having it.
  if (focusring.isChromeSurface(focusSurface)) return focusTheSurface(focusring.escapeTarget());
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
    // #150: the leader stays on Control on every platform — see modifier.js.
    if (modifier.isLeaderChord(input) && (rawKey === ' ' || rawKey.toLowerCase() === 'space')) {
      event.preventDefault();
      armLeader(); // globalShortcut usually beats us here; harmless either way
      return;
    }
    // #224: Ctrl+` and Ctrl+1–6 jump straight to a Persona or app, from any
    // page or terminal (the shell never sees them). Ctrl+Space + key still works.
    const direct = personaorder.directPick(input, orderedPersonas);
    if (direct) {
      event.preventDefault();
      leaderUntil = 0;
      if (terminalMain.isTerminal(wc)) terminalMain.setHold(wc, false);
      if (!locked) switchPersona(direct);
      return;
    }
    // #214: a terminal tab. Every key belongs to the shell except the held key
    // after Ctrl+Space (Persona switch, or prefix + key for forge) and the few
    // tab chords below. Ctrl+L, Ctrl+S, Ctrl+B, Alt+arrows and Esc are the shell's.
    if (terminalMain.isTerminal(wc)) {
      if (terminalMain.holding(wc)) {
        const d = termHold(input, (i) => personaorder.leaderPick(i, orderedPersonas()));
        if (d.kind === 'wait') return;
        if (d.kind === 'persona') {
          event.preventDefault();
          terminalMain.setHold(wc, false);
          if (!locked) switchPersona(d.id);
          return;
        }
        terminalMain.passHeldKey(wc); // xterm encodes the key; main sends the prefix in front of it
        return;
      }
      const k = rawKey.toLowerCase();
      const chord = modifier.isChord(input) && !input.alt;
      if (k === 'f11' && modifier.isBare(input)) {
        event.preventDefault();
        if (!locked) setFullscreenMode(!fullscreen);
      } else if (k === 'f4' && modifier.isAltOnly(input)) {
        event.preventDefault();
        win.close();
      } else if (chord && k === 'tab') {
        event.preventDefault();
        if (input.shift) openTerminal();
        else flipTab();
      } else if (chord && input.shift && k === 't') {
        event.preventDefault();
        openTerminal(); // another terminal tab
      } else if (chord && !input.shift && k === 'f4') {
        event.preventDefault();
        closeTab(activeId);
      } else if (chord && !input.shift && (k === 'pagedown' || k === 'pageup')) {
        event.preventDefault();
        cycleTab(k === 'pagedown' ? 1 : -1);
      }
      return;
    }
    if (leaderUntil > Date.now()) {
      if (['control', 'shift', 'alt', 'meta'].includes(rawKey.toLowerCase())) return;
      event.preventDefault();
      leaderUntil = 0;
      if (rawKey.toLowerCase() === 'escape' || locked) return;
      // #214: ` ! @ # $ % ^ pick a Persona or app slot (personaorder.KEYMAP,
      // matched on the physical key). #217: digits are bookmark hotkeys like any other key.
      const pick = personaorder.leaderPick(input, orderedPersonas());
      if (pick) {
        switchPersona(pick);
        return;
      }
      handleHotkeyPress(modifier.keyId(input, rawKey)); // #150: same id on every platform
      return;
    }
    // #32: F11 at the input level — the menu accelerator only fired reliably
    // on a maximized window.
    // #131 round 2: there is deliberately NO focus-cycling key.
    //
    // Round 1 added F6 because that is the browser convention. The user's answer
    // was blunt and correct: a convention nobody reaches for is not a feature.
    // Ctrl+L focuses the address bar and plain Tab walks the chrome from there —
    // which works only because the rows now have tabindex, and needs no new
    // binding at all. Esc returns to the page.
    if (rawKey.toLowerCase() === 'f11' && modifier.isBare(input)) {
      event.preventDefault();
      if (!locked) setFullscreenMode(!fullscreen);
      return;
    }
    if (rawKey.toLowerCase() === 'escape' && modifier.isBare(input)) {
      if (!locked) handleEscape(); // #42 — don't preventDefault: pages use Esc too
      return;
    }
    // #236: F2 renames the active tab, inline in the sidebar.
    if (rawKey.toLowerCase() === 'f2' && modifier.isBare(input)) {
      event.preventDefault();
      if (!locked && activeId != null && alive()) chrome.webContents.send('rename-tab-start', activeId);
      return;
    }
    // #38: Alt+Left/Right — the browser-standard back/forward I never wired.
    if (modifier.isAltOnly(input)) {
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
    // #232: Ctrl+Alt+R — reader mode. isChord rejects Alt, so it is matched before that gate.
    if (modifier.isChord({ ...input, alt: false }) && input.alt && !input.shift && rawKey.toLowerCase() === 'r') {
      event.preventDefault();
      toggleReader();
      return;
    }
    if (!modifier.isChord(input)) return; // #150: Ctrl on Windows, ⌘ on macOS
    const key = rawKey.toLowerCase();
    // #131/#103/#109 diagnostics. Ctrl+S (link hints), Ctrl+L and Ctrl+B are all
    // reported as unreliable, and the causes are mutually exclusive:
    //   nothing logged            -> the chord never reached WebForge at all
    //   logged with view=chrome   -> focus was in the sidebar/nav, so the PAGE's
    //                               preload (which owns Ctrl+S) never saw it
    //   logged with view=page     -> it reached the page and the preload dropped
    //                               it: the not-while-typing guard, or focus
    //                               inside an iframe, where the preload does not
    //                               run
    // One line distinguishes three different bugs. Cheaper than another guess.
    if (key === 's' || key === 'l' || key === 'b') {
      const which = wc === chrome?.webContents ? 'chrome' : 'page';
      errorlog.record(
        'chord',
        new Error(`Ctrl+${input.shift ? 'Shift+' : ''}${key} view=${which} locked=${locked} surface=${focusSurface}`)
      );
    }
    // #101: Ctrl+Shift+Left/Right is the standard word-wise text-selection
    // chord and used to be swallowed here for back/forward (#38). Stealing it
    // meant selection could not work in WebForge at all. Alt+Left / Alt+Right
    // above are the browser-standard back/forward and still do the job, so the
    // binding was pure duplication. Deliberately NOT handled — let it through.
    if (key === 'tab') {
      event.preventDefault();
      // #113: Ctrl+Tab flips between the two most recently used tabs, the way
      // Alt+Tab does; Ctrl+PageDown steps to the next tab in sidebar order.
      // "Previous tab" is deliberately gone — Ctrl+PageUp still walks backwards.
      // #214: Ctrl+Shift+Tab goes to the Terminal Persona.
      if (input.shift) openTerminal();
      else flipTab();
    } else if (key === 'l' && !input.shift) {
      // #103: Ctrl+L did nothing. The menu item's code was correct — and a probe
      // confirmed a covered view CAN take focus — so the fault was the
      // accelerator never arriving: #23's warning that a BaseWindow's menu
      // accelerators can silently not exist, plus any page that binds Ctrl+L
      // itself gets it first. Owning it here fixes both, and preventDefault
      // stops the page swallowing it.
      //
      // `!input.shift` is NOT optional: isChord deliberately permits shift (for
      // Ctrl+Shift+Tab), so without it Ctrl+Shift+L — Lock WebForge — landed
      // here instead and locking silently stopped working. Shipped that in
      // 0.1.167.
      event.preventDefault();
      focusTheSurface('url');
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
  if (pinnedIds.has(id)) {
    pinnedIds.delete(id);
    pinnedHome.delete(id); // #117: unpinning restores ordinary behaviour at once
  } else {
    pinnedIds.add(id);
    pinnedHome.set(id, tabUrlOf(id)); // #117: whatever it shows now is its home
  }
  sortTabOrder();
  pushStickyModes(); // #117: the preload must learn it now intercepts clicks here
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
    view.webContents.send('sticky-mode', isStickyTab(tid)); // #117
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
    // #132: the key means "take me to THAT URL", whether or not the tab is
    // already in front. It used to only re-home when you were already there, so
    // pressing it from another tab just switched to wherever the tab had drifted
    // — and an SPA drifts constantly, because enforceHome tolerates same-origin
    // movement by design (#78, to avoid the livelock full-URL comparison caused).
    // That contradicted #33's own invariant that a quick-launch tab is ONLY ever
    // its own site. Accepted cost: using the key merely to switch to the tab now
    // also resets it.
    if (activeId !== tabId) activateTab(tabId);
    const wc = tabs.get(tabId).webContents;
    // Skip the reload when it is already showing the bound URL, so repeat presses
    // are not a needless page load.
    if (taburl.canonical(tabUrlOf(tabId)) !== taburl.canonical(entry.url)) {
      wc.loadURL(entry.url);
    }
    wc.focus(); // #30
  } else {
    // #71: honour a routing rule when one claims this URL, otherwise keep the
    // tab in the Persona the user is actually working in — landing it in
    // Unassigned would switch them out from under their own hotkey.
    const claimed = personas.forUrl(entry.url);
    const owner = claimed === personas.UNASSIGNED ? pageHome(personas.activeId()) : claimed; // #214
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
  // #214: terminal tabs' IPC, once. Links from a session open as browser tabs.
  terminalMain.installIpc({ openUrl: (url) => openExternalUrl(url), onConnectionsChanged: pushConnections });
  win.on('blur', () => closeStrayNewTabs()); // #82: Alt+Tab away disposes of it
  win.on('blur', () => terminalMain.clearAllHolds()); // #214: a held Ctrl+Space doesn't survive leaving
  // #176: leaving the window closes every adult tab — alt-tab, clicking another
  // app, minimize, hide. Blur is re-checked after a beat so a focus hop that
  // never really left the window (a native menu, a dialog of ours) doesn't count.
  // #245: but HIDE first, synchronously, while the window can still paint. A
  // background window doesn't repaint, so whatever it showed when it lost focus
  // is what Alt+Tab, the taskbar preview and the first moment back all show.
  win.on('blur', () => {
    clearTimeout(adultBlurTimer);
    const veiled = tabs.has(activeId) && isAdultTab(activeId) ? activeId : null;
    if (veiled !== null) tabs.get(veiled).setVisible(false);
    adultBlurTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      if (!win.isFocused() && !contextMenuOpen) closeAdultTabs(null, 'window blur');
      else if (veiled !== null && veiled === activeId && tabs.has(veiled)) tabs.get(veiled).setVisible(true); // a menu hop: never left
    }, 250);
  });
  win.on('minimize', () => closeAdultTabs(null, 'minimize'));
  win.on('hide', () => closeAdultTabs(null, 'hide'));

  chrome = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.contentView.addChildView(chrome);
  chrome.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Chrome renders from pushed state; re-push once it's ready to receive.
  chrome.webContents.on('did-finish-load', () => {
    lastSent.clear(); // #216: a fresh page has seen nothing yet
    pushState();
  });
  chrome.webContents.on('did-finish-load', pushTabGroups); // #34
  wireChords(chrome.webContents); // #22

  win.on('resize', layout);
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  // #148 round 1: restore/show/focus were missing from this set. A view sized
  // while the window was still minimised gets stale bounds from
  // getContentBounds(). Keeping these — they are necessary.
  //
  // #148 round 2: but NOT sufficient, which is why the bug survived. layout()'s
  // only lever is setBounds, and setBounds to unchanged geometry is a no-op in
  // Chromium — it never reaches the compositor. Coming back from minimise at the
  // same size therefore provoked nothing at all. Alt-tab "fixed" it by changing
  // occlusion, which IS a compositor event. So the window returning must also
  // force a frame, not merely re-assert geometry.
  const onWindowReturn = () => {
    // #216: restore, show and focus all land here, and focus fires on every
    // alt-tab. Only a window that was really minimised/hidden needs provoking.
    const wasHidden = windowWasHidden || (blurredAt > 0 && Date.now() - blurredAt >= repaint.EVICT_MS);
    // Only a return the user can actually see uses the flag up. restore/show can
    // fire while the window is still minimised, and then the later focus must force.
    if (win.isVisible() && !win.isMinimized()) {
      windowWasHidden = false;
      blurredAt = 0;
    }
    // #148 round 5: chrome first. It draws the sidebar and nav bar, and a
    // window-wide blank means it is as stalled as the page is.
    if (wasHidden) forceRepaintChrome();
    if (activeId === null || !tabs.has(activeId)) return layout();
    const moved = boundsChangedFor(activeId);
    forceRepaint(activeId, { windowReturned: true, windowWasHidden: wasHidden, boundsChanged: moved });
  };
  win.on('minimize', () => (windowWasHidden = true));
  win.on('hide', () => (windowWasHidden = true));
  win.on('blur', () => (blurredAt = Date.now()));
  // Sleep and screen lock hide nothing as far as the window knows, but they are
  // exactly where frames get dropped.
  powerMonitor.on('resume', () => (windowWasHidden = true));
  powerMonitor.on('unlock-screen', () => (windowWasHidden = true));
  win.on('restore', onWindowReturn);
  win.on('show', onWindowReturn);
  win.on('focus', onWindowReturn);

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
      errorlog.record('adblock: fandom extras failed to load', e);
    }
    ensurePreloadRegistration(session.defaultSession); // #21: Electron 34 lacks the API Ghostery 2.x calls
    blocker.enableBlockingInSession(session.defaultSession);
  } catch (e) {
    // #21: this used to console.error, which is invisible in a packaged build.
    errorlog.record('adblock: disabled this run', e);
  }
}

// #13: opportunistic bookmark sync against dockerhost — whole-store
// last-write-wins by updatedAt. Fails silently off the tailnet (work-VPN
// case): purely offline-first, catches up whenever home is reachable.
const SYNC_URL = 'http://100.69.184.113:8013/store/bookmarks';
const PERSONA_SYNC_URL = 'http://100.69.184.113:8013/store/personas'; // #88
const TABS_SYNC_URL = 'http://100.69.184.113:8013/store/tabs'; // #57
const ADULT_SYNC_URL = 'http://100.69.184.113:8013/store/adult'; // #203
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
    // #151: an empty store never overwrites a populated one, in either
    // direction. Bookmarks had NO emptiness guard on either side — 467
    // bookmarks were one unlucky timestamp away from the Persona incident.
    const { action } = syncdecide.decide({
      localAt: local.updatedAt,
      remoteAt,
      localWeight: syncdecide.bookmarkWeight(bookmarks.all()),
      remoteWeight: syncdecide.bookmarkWeight(remote.data),
    });
    if (action === 'pull') {
      bookmarks.replaceAll(remote.data, remoteAt);
      pushBookmarks();
      pushState();
    } else if (action === 'push') {
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
    // #151: this is where the 2026-09-23 wipe happened. The old code guarded
    // the PULL against empty remote data but left the PUSH wide open, so a
    // first run — whose defaults were stamped Date.now() — overwrote every
    // Persona rule in the fleet. decide() applies the guard both ways.
    const { action } = syncdecide.decide({
      localAt,
      remoteAt,
      localWeight: syncdecide.personaWeight(personas.all()),
      remoteWeight: syncdecide.personaWeight(remote.data),
    });
    if (action === 'pull') {
      personas.replaceAll(remote.data, remoteAt);
      rehomeAllTabs(); // #120
      pushState();
    } else if (action === 'push') {
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

// #203: your adult-site list ({added, removed}) on top of the built-in one.
// Shared with the phone, last-write-wins like personas.
function adultUser() {
  const a = getSettings().adultUser;
  return { ...adultlist.clean(a), updatedAt: (a && a.updatedAt) || 0 };
}
function applyAdultUser() {
  ytdlp.setUser(adultUser());
  closeAdultTabs(activeId, 'list changed'); // the tab you're on goes when you leave it (#176)
}
function saveAdultUser(user, updatedAt = Date.now()) {
  getSettings().adultUser = { ...adultlist.clean(user), updatedAt };
  saveSettings();
  applyAdultUser();
  pushState();
  return adultView();
}
const adultView = () => ({ ...adultUser(), builtins: ytdlp.builtins() });
// An empty list is a real choice here (it is the default), so #151's "nothing
// never overwrites something" is judged by whether you ever edited it: a fresh
// install is stamped 0 and never pushes; an edit, even one that empties it, does.
const adultWeight = (at) => (Number(at) > 0 ? 1 : 0);

let adultSyncing = false;
let adultResync = false; // an edit landed mid-sync: run again with it
async function syncAdult() {
  if (adultSyncing) { adultResync = true; return; }
  adultSyncing = true;
  try {
    const res = await fetch(ADULT_SYNC_URL, { signal: AbortSignal.timeout(5000) });
    const remote = await res.json();
    const remoteAt = remote.updatedAt || 0;
    const local = adultUser(); // read after the fetch, so an edit made meanwhile is what we compare
    const { action } = syncdecide.decide({
      localAt: local.updatedAt,
      remoteAt,
      localWeight: adultWeight(local.updatedAt),
      remoteWeight: remote.data && typeof remote.data === 'object' ? adultWeight(remoteAt) : 0,
    });
    if (action === 'pull') {
      saveAdultUser(remote.data, remoteAt);
    } else if (action === 'push') {
      await fetch(ADULT_SYNC_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: adultlist.clean(local), updatedAt: local.updatedAt }),
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch {
    // off the tailnet: the local list stands
  } finally {
    adultSyncing = false;
    if (adultResync) { adultResync = false; syncAdult(); }
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
  return pending ? pending.url : realUrl(id, tabs.get(id)?.webContents.getURL() || '');
}

function shareable(url) {
  // #176: adult tabs never reach the other device, the close tombstones, or
  // Ctrl+Shift+T — every path that remembers a tab goes through here.
  // #232: a reader view is a data: URL — it must never be synced, restored or reopened.
  return Boolean(url) && url !== 'about:blank' && !String(url).startsWith('data:') && !isNewTabUrl(url) && !isInternalUrl(url) && !isTerminalUrl(url) && !ytdlp.isAdult(url); // #214
}

function localTabPayload() {
  const byPersona = {};
  for (const id of tabOrder) {
    const url = tabUrlOf(id);
    if (!shareable(url) || isViewTab(id)) continue; // #214: the phone has no app slots
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
      if (ytdlp.isAdult(url)) continue; // #176: an older build on the other device may still send one
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
  syncTimer = setTimeout(() => alive() && syncBookmarks(), 5000); // #147
}

// #12: automatic login fill — user decision: "everything once I'm in".
// Exact-origin match; fills the first saved login for the page's origin into
// the first empty password form found. Silent no-op when locked or unmatched.
// #136: when to retry, in ms after the triggering event. A two-step login can
// take several seconds of the user typing before the password field appears, so
// the tail is long — but the schedule is FINITE and per-navigation on purpose.
// An open-ended watcher that types a password into whatever field turns up next
// is not a nicer version of this feature; it is a way to leak a credential into
// a form the user never meant to fill.
const AUTOFILL_RETRIES_MS = [0, 300, 800, 1800, 3500, 6000, 9000];
const autofillTimers = new WeakMap();
// #144: how many times a username may be written when there is NO password
// field on the page. Exactly once per navigation. Framework-controlled inputs
// re-render and wipe a raw value write, so an unbounded schedule refilled the
// same field over and over — that is what made a single stray fill look like
// the field was being spammed.
const usernameFills = new WeakMap();

// #144 round 3: the two-step-login fill is OFF.
//
// It is the only path that writes to a page with no password field on it, which
// makes it a standing guess about "does this page want a username" — and three
// rounds of tightening that guess (loose type=text, then strong field signals)
// still put text into fields on a GitHub Enterprise instance. A login-form
// heuristic that is wrong on real pages is not a convenience, it is the app
// typing into your work.
//
// Password forms are unaffected: a page with a visible password field still
// fills username-and-password, scoped to that field's own form. What is lost is
// pre-filling the username on the FIRST screen of a two-step login (Google,
// Microsoft) — you type the username there yourself, and the password step
// still fills automatically.
//
// Re-enabling needs evidence the PAGE is a sign-in page (URL, form action, or
// submit-button text), not merely evidence that a field looks login-ish. That
// is its own ticket; flipping this constant without it just restarts the cycle.
const AUTOFILL_TWO_STEP = false;

function cancelAutofill(wc) {
  for (const t of autofillTimers.get(wc) || []) clearTimeout(t);
  autofillTimers.set(wc, []);
}

function scheduleAutofill(wc) {
  if (locked || wc.isDestroyed()) return;
  cancelAutofill(wc); // a new navigation supersedes the old page's attempts
  const url = wc.getURL();
  usernameFills.set(wc, 0); // #144: budget is per navigation, so reset it here
  const timers = AUTOFILL_RETRIES_MS.map((delay) =>
    setTimeout(async () => {
      // Bail if we drifted to a different page mid-schedule — otherwise a
      // credential picked for page A could be typed into page B.
      if (wc.isDestroyed() || wc.getURL() !== url) return cancelAutofill(wc);
      // #144: once the username step has happened, later attempts are told not
      // to write a username at all. The schedule keeps running so the password
      // step is still caught — suppressing the write is not the same as giving
      // up on the login, and cancelling here would have been the latter.
      const mayFillUsername = AUTOFILL_TWO_STEP && (usernameFills.get(wc) || 0) < 1;
      const result = await tryAutofill(wc, mayFillUsername);
      if (result === 'filled') return cancelAutofill(wc); // done
      if (result === 'user') usernameFills.set(wc, 1);
    }, delay)
  );
  autofillTimers.set(wc, timers);
}

// --- #145: offer to save or update a login after signing in ---
//
// Two rules shape this, both learned rather than assumed:
//  * Submitting is not succeeding. Prompting on submit fills the store with
//    typos and rejected passwords — exactly the stale-credential problem this
//    is meant to end. So a candidate is held until the page navigates away from
//    the form, which is the usual evidence a sign-in was accepted.
//  * The prompt lives in the chrome UI, not a native dialog, so it cannot steal
//    focus from the page mid-login (#144's lesson).
const pendingLogin = new Map(); // tabId -> {origin, username, password, url}

/** Which tab sent this IPC? Content preloads have no id of their own. */
function tabIdForSender(sender) {
  for (const [id, view] of tabs) {
    if (view.webContents === sender) return id;
  }
  return null;
}

ipcMain.on('login-submitted', (e, data) => {
  if (locked) return; // nothing is captured while the vault is shut
  const id = tabIdForSender(e.sender);
  if (id === null) return;
  const origin = String(data?.origin || '');
  const password = String(data?.password || '');
  if (!origin || !password) {
    errorlog.record('login-capture', `ignored: origin=${Boolean(origin)} password=${Boolean(password)}`);
    return;
  }
  errorlog.record('login-capture', `held ${origin} user=${data?.username ? 'yes' : 'empty'}`);
  pendingLogin.set(id, {
    origin,
    username: String(data?.username || ''),
    password,
    url: e.sender.getURL(), // the form's page, so we can tell when we leave it
  });
});

/** Is a usable password field on screen? Then we are still being asked to log in. */
function hasVisiblePasswordField(wc) {
  return wc
    .executeJavaScript(
      `(() => {
        const seen = [];
        const walk = (root, d) => {
          if (!root || d > 8) return;
          for (const el of root.querySelectorAll('input')) {
            if (el.type === 'password') seen.push(el);
            if (el.shadowRoot) walk(el.shadowRoot, d + 1);
          }
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, d + 1);
        };
        walk(document, 0);
        return seen.some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 24 && r.height > 8;
        });
      })()`,
      true
    )
    .catch(() => false);
}

/** Called on navigation: did a held login just look successful? */
async function settleLogin(id, wc, navUrl) {
  const pending = pendingLogin.get(id);
  if (!pending || locked) return;
  errorlog.record('login-capture', `navigated ${pending.url} -> ${navUrl}`);
  // Still on the same page — a failed sign-in usually re-renders in place, so
  // this is not yet evidence of anything. Keep holding.
  if (taburl.canonical(navUrl) === taburl.canonical(pending.url)) {
    errorlog.record('login-capture', 'same page — sign-in not confirmed yet, still holding');
    return;
  }

  // #145 round 3: "the URL changed" is NOT the same as "you got in". A rejected
  // password very often navigates too — /login -> /login?error=1, or a bounce
  // through the identity provider and back to a fresh sign-in form. Treating
  // that as success consumed the held credential on the FAILED attempt, so when
  // the right password went in afterwards there was frequently nothing left to
  // compare and no prompt appeared. That is the reported symptom.
  //
  // A visible password field on the page we landed on is much better evidence:
  // sites do not ask for a password again once you are in.
  if (await hasVisiblePasswordField(wc)) {
    // Keep holding, and re-anchor to where we are now so the NEXT navigation is
    // judged against this page rather than the original one.
    pendingLogin.set(id, { ...pending, url: navUrl });
    errorlog.record('login-capture', 'landed on another password form — sign-in failed, still holding');
    // ...but a landing page can render a password field for a moment on its way
    // to being logged in, and if no further navigation follows we would hold
    // forever and never prompt. One bounded re-check covers that without
    // turning this into a polling loop.
    // #147's rule: a deferred callback must not touch anything that can die.
    setTimeout(async () => {
      if (!alive() || wc.isDestroyed() || locked) return;
      const held = pendingLogin.get(id);
      // Only if nothing else moved on in the meantime.
      if (!held || taburl.canonical(wc.getURL()) !== taburl.canonical(navUrl)) return;
      if (await hasVisiblePasswordField(wc)) return; // genuinely still a login page
      pendingLogin.delete(id);
      errorlog.record('login-capture', 're-check: password form gone, treating as signed in');
      offerToSave(id, held);
    }, 2500);
    return;
  }

  pendingLogin.delete(id);
  offerToSave(id, pending);
}

/** Decide what to offer for a login we believe succeeded, and show the dialog. */
function offerToSave(id, held) {
  const decision = credsave.decide(credentials.list(), held);
  errorlog.record('login-capture', `decision=${decision.action} for ${held.origin}`);
  if (decision.action === 'none') return;
  const prompt = credsave.promptFor(decision, held.origin);
  if (!prompt) return;
  // The chrome UI renders it; nothing is written until the answer comes back.
  // #145 round 2: this is a centred dialog over a dimmed page, modelled on the
  // bookmark dialog (#29/#32) — the pattern this app already has for "chrome
  // needs the whole window for a moment". The first version was a docked strip,
  // and in fullscreen it painted the screen black: chrome was given the full
  // window but never RAISED above the page and no reveal mode was set, so
  // body[data-fs] hid every child and all you saw was chrome's backdrop.
  loginPromptOpen = true;
  clearFsReveal();
  setChromeRaised(true);
  layout(); // #32: in fullscreen, chrome must expand to show the dialog
  errorlog.record('login-capture', `prompting: ${prompt.confirm} — ${prompt.title}`);
  chrome?.webContents.send('login-prompt', {
    id: `${id}:${Date.now()}`,
    title: prompt.title,
    confirm: prompt.confirm,
    action: decision.action,
    entryId: decision.id || null,
    origin: held.origin,
    username: held.username,
    password: held.password,
  });
  chrome.webContents.focus(); // so Esc and the buttons are reachable
}

ipcMain.on('login-prompt-answer', (_e, answer) => {
  // Put the window back the way it was first, whatever the answer is.
  loginPromptOpen = false;
  if (!bmDialogOpen && !settingsOpen && !managerOpen && !ytdlpOpen && !outfitOpen) setChromeRaised(false);
  layout();
  activeWc()?.focus();
  if (locked || !answer || !answer.accepted) return;
  const ok = credentials.upsert({
    id: answer.action === 'update' ? answer.entryId : undefined,
    origin: answer.origin,
    username: answer.username,
    password: answer.password,
  });
  if (!ok) return errorlog.record('login-save', `upsert refused for ${answer.origin}`);
  pushCreds();
});

// Returns 'filled' | 'user' | false — see autofill-inject.js.
async function tryAutofill(wc, mayFillUsername = true) {
  if (locked || wc.isDestroyed()) return false;
  // #136: was an exact-string origin match, so a login saved for
  // https://www.chase.com could never fill on chase.com or secure.chase.com.
  // credmatch ranks origin > host > registrable domain and refuses unsafe folds.
  // #141: wc.executeJavaScript only reached the top document, and banks and
  // hosted SSO (Schwab) put the whole login form in an iframe. autofillframes
  // runs the filler in each frame with the credential for THAT frame's URL,
  // and only in frames on the same site as the page you navigated to.
  // The injected filler lives in autofill-inject.js so the DOM harness in
  // scripts/autofill-dom-check.js can run exactly what ships.
  let mainFrame;
  try {
    mainFrame = wc.mainFrame;
  } catch {
    return false;
  }
  return autofillFrames.fillFrames(mainFrame, credentials.list(), mayFillUsername).catch(() => false);
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
  // #145: a prompt in flight must not survive a lock — it holds a plaintext
  // password, and its reserved strip would otherwise be stuck on screen.
  pendingLogin.clear();
  loginPromptOpen = false;
  ytdlpOpen = false; // #156
  outfitOpen = false; // #179
  vault.lock();
  // Tear the whole session down — nothing sensitive stays rendered or mapped.
  for (const id of [...tabOrder]) {
    const view = tabs.get(id);
    win.contentView.removeChildView(view);
    view.webContents.close();
  }
  tabs.clear();
  hiddenAt.clear(); // #216
  tabOrder = [];
  pinnedIds.clear();
  activeId = null;
  win.setTitle('WebForge — locked');
  sendIfChanged('tabs-updated', []); // #216: through the dedupe, or unlock could skip its first push

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
      const custom = cleanTabName(t.customTitle); // #236
      if (custom) customTitles.set(id, custom);
      if (t.pinned) {
        pinnedIds.add(id);
        // #117: fall back to the tab's own URL for pins made before this shipped,
        // so existing pinned tabs become sticky rather than staying inert.
        pinnedHome.set(id, t.pinHome || t.url);
      }
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
    const claimed = claimOf(tabUrlOf(tid)); // #221
    if (claimed !== personas.UNASSIGNED && !isViewTab(tid)) personaByTab.set(tid, claimed); // #214
  }
  syncBookmarks(); // #13: catch up whenever a session starts
  syncPersonas(); // #88
  syncAdult(); // #203
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
      // #136: was an exact-origin lookup plus a hand-rolled http fallback, so a
      // realm on a sibling host never prefilled. credmatch subsumes both.
      const match = credmatch.bestMatch(credentials.list(), origin);
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

// #148: run `fn` once the window is genuinely on screen and sized, so anything
// it creates is laid out against real geometry rather than a pending request.
function whenWindowReady(fn) {
  if (!win || win.isDestroyed()) return;
  let ran = false; // both listeners below can fire; the work must happen once
  const go = () => {
    if (ran || !win || win.isDestroyed()) return;
    ran = true;
    layout(); // geometry is real by now; re-sync every view before adding more
    // #148 round 5: this is THE external-link path, and the window has just
    // come up. Kick chrome before creating the tab — if chrome is the blank
    // surface, forcing the new page view alone can never make the window look
    // right, which is consistent with every round of this ticket so far.
    forceRepaintChrome();
    fn();
  };
  if (win.isVisible() && !win.isMinimized()) return setImmediate(go);
  win.once('show', () => setImmediate(go));
  win.once('restore', () => setImmediate(go));
}

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
          // behaviour the app no longer has. #206: Ctrl+Shift+Tab moved to the terminal.
          { label: 'Recent Tab', accelerator: 'Control+Tab', click: () => flipTab() },
          { label: 'Next Tab', accelerator: 'Control+PageDown', click: () => cycleTab(1) },
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
          { label: 'Reader Mode', accelerator: 'CmdOrCtrl+Alt+R', click: () => toggleReader() }, // #232
          { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: () => openFind() },
          { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Alt+T', click: () => reopenClosedTab() }, // #208: Ctrl+Shift+T is the terminal now
          { label: 'Terminal', accelerator: 'Control+Shift+T', click: () => openTerminal() }, // #214: the Terminal Persona (Ctrl+Shift+Tab too)
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
  if (!url) return;
  if (isViewTab(activeId)) openExternalUrl(url); // #214: the address bar never replaces a session or app slot
  else activeWc()?.loadURL(url);
});
ipcMain.on('go-back', () => activeWc()?.navigationHistory.goBack());
ipcMain.on('toggle-reader', () => toggleReader()); // #232
ipcMain.on('go-forward', () => activeWc()?.navigationHistory.goForward());
ipcMain.on('reload', () => { if (!isTerminalTab(activeId)) activeWc()?.reload(); }); // #214: would orphan the session
// #174: home takes the CURRENT tab to the home page, so Back returns you to
// where you were. Windows home is the new-tab page; Android's is the Dashboard.
ipcMain.on('open-terminal', () => openTerminal()); // #208: the >_ button
// #214: the connections panel (the Terminal Persona's bookmarks).
ipcMain.on('open-connection', (_e, target) => openConnection(target));
ipcMain.on('favorite-connection', (_e, target) => {
  terminalMain.toggleFavorite(target);
  pushConnections();
});
// #228: edit a Favorite (name / user / host / port) from the panel.
ipcMain.handle('edit-connection', (_e, { target, fields } = {}) => {
  const r = terminalMain.editFavorite(target, fields);
  pushConnections();
  return r;
});
ipcMain.on('get-connections', () => pushConnections());
ipcMain.on('go-home', () => {
  const wc = activeWc();
  if (isViewTab(activeId)) createTab(null, false); // #214: home leaves a terminal or app slot, it doesn't replace it
  else if (wc) wc.loadURL(newTabUrl());
  else openNewTab();
});
// #101: find bar — the UI lives in the chrome renderer, the search runs here.
ipcMain.on('find-run', (_e, { text, forward, again }) => runFind(String(text || ''), { forward, again }));
ipcMain.on('find-close', () => closeFind());
ipcMain.on('stop', () => activeWc()?.stop());
ipcMain.on('new-tab', () => openNewTab()); // #82
ipcMain.on('close-tab', (_e, id) => closeTab(id));
// #236: rename a tab (empty/whitespace clears it back to the page title).
ipcMain.on('rename-tab', (_e, id, name) => {
  if (!tabs.has(id)) return;
  const clean = cleanTabName(name);
  if (clean) customTitles.set(id, clean);
  else customTitles.delete(id);
  pushState();
});
// #115: Ctrl+X from any renderer that decided the user was not typing. The
// editable-field check lives in the preloads, where focus is known exactly.
ipcMain.on('close-active-tab', () => {
  if (!locked && activeId !== null) closeTab(activeId);
});
// #100: Ctrl+J — the selection comes from the renderer, because
// before-input-event is synchronous and cannot read the page's selection.
ipcMain.on('open-text-rule', (_e, text) => openFromSelection(String(text || '')));
ipcMain.handle('int:get-text-rules', () => textRules());
ipcMain.handle('int:get-adult', () => adultView()); // #203
ipcMain.handle('int:save-adult', (_e, user) => { const v = saveAdultUser(user); syncAdult(); return v; });
ipcMain.handle('int:add-adult', (_e, typed) => {
  const entry = adultlist.normalize(typed);
  if (!entry) return { entry: null, view: adultView() };
  const u = adultUser();
  const removed = u.removed.filter((e) => e !== entry); // a switched-off built-in comes back on
  const added = ytdlp.builtins().includes(entry) ? u.added : [...u.added, entry];
  const view = saveAdultUser({ added, removed });
  syncAdult();
  return { entry, view };
});
ipcMain.handle('int:save-text-rules', (_e, list) => saveTextRules(list));
ipcMain.on('activate-tab', errorlog.guard('activate-tab', (_e, id) => activateTab(Number(id))));
ipcMain.on('toggle-pin', (_e, id) => togglePin(id));
// #25: persona IPC
ipcMain.on('switch-persona', (_e, id) => switchPersona(String(id)));
// #214: in key order, with each Persona's key; Terminal and the app slots are not editable here.
ipcMain.handle('int:get-personas', () => ({
  personas: orderedPersonas().filter((p) => !personas.isBuiltinView(p.id)),
  active: personas.activeId(),
}));
ipcMain.handle('int:get-slots', () => ({ slots: appSlots(), defaults: personaorder.DEFAULT_SLOTS, keys: personaorder.KEYMAP }));
ipcMain.handle('int:save-slots', (_e, urls) => saveSlots(urls));
ipcMain.handle('int:add-persona', (_e, name) => {
  const p = personas.add(name);
  pushState();
  return p;
});
ipcMain.handle('int:update-persona', (_e, { id, name, rules }) => {
  const ok = personas.update(String(id), { name, rules });
  // Re-home every tab against the new rules so edits take effect immediately.
  rehomeAllTabs(); // #120
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
// --- #176: adult tabs close the moment you leave them ---
// Brandon: "We can never leave an adult tab open when navigating away from it."
// Leaving = activating any other tab (click, Ctrl+Tab, hotkey, Persona, new
// tab) or the window losing focus, minimizing or hiding. Downloads are sent to
// the Dashboard and run there, so closing the tab never stops one.
let contextMenuOpen = false;
let adultBlurTimer = null;
let sweepingAdult = false;

function isAdultTab(id) {
  return ytdlp.isAdult(tabUrlOf(id));
}

// #245: while an adult tab is showing, Windows keeps the window out of Alt+Tab
// and taskbar thumbnails and out of screenshots (SetWindowDisplayAffinity).
let adultShield = false;
function syncAdultShield() {
  const want = activeId !== null && tabs.has(activeId) && isAdultTab(activeId);
  if (want === adultShield || !win || win.isDestroyed()) return;
  adultShield = want;
  try {
    win.setContentProtection(want);
  } catch (err) {
    errorlog.record('adult-shield', err);
  }
}

function closeAdultTabs(exceptId = null, why = 'switched tab') {
  if (locked || sweepingAdult) return;
  // The active tab goes LAST: by then every other adult tab is gone, so the
  // neighbour it hands off to can't be a lazy adult tab that loads only to die.
  // #191: opening or returning to the Create Outfit tab spares the page it came
  // from (often adult itself), so the Studio can send you back there. Any other
  // way of leaving still closes both.
  const spared = outfitReturn && exceptId === outfitReturn.tabId ? outfitReturn.openerId : null;
  const doomed = tabOrder
    .filter((id) => id !== exceptId && id !== spared && isAdultTab(id))
    .sort((a, b) => (a === activeId) - (b === activeId));
  if (!doomed.length) return;
  sweepingAdult = true; // closing the active tab activates a neighbour, which sweeps again
  try {
    for (const id of doomed) if (tabs.has(id)) closeTab(id, { adult: true });
  } finally {
    sweepingAdult = false;
  }
  // Adult closes show up as a count, not URLs.
  errorlog.record('adult-close', `${doomed.length} tab(s) closed: ${why}`);
  // #193: a focused, edited URL box keeps its text unless the tab changed, so an
  // adult address could outlive its tab there. Make the box let go, then resend.
  chrome?.webContents.send('url-reset');
  pushState();
}

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
    (id) =>
      (personaByTab.get(id) || personas.UNASSIGNED) === active &&
      (isUnusedNewTab(id) || terminalMain.isPicker(tabs.get(id).webContents)) // #214: reuse an unused picker
  );
  if (existing !== undefined) {
    activateTab(existing);
    return;
  }
  // #214: Terminal → host picker. #221: an app slot → another tab on the slot's page.
  createTab(null, false, personas.isBuiltinView(active) ? active : null);
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
      !isViewTab(id) && // #214: an idle shell is still a live session; an app slot is pinned
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
  if (personas.isBuiltinView(personas.activeId())) return; // #214: Terminal and app slots hold no bookmarks
  if (!hotkeys.set(String(keyId), { url, title }, personas.activeId())) return;
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

// --- #156: send the current page to the Dashboard's yt-dlp ---
// The button opens a picker in the chrome (a centred dialog, raised exactly as
// the login prompt is); the answer comes back here and the download runs in the
// background. The Dashboard answers only when yt-dlp has FINISHED (up to 10
// minutes), so nothing waits on it: you get a "sending" notice now and a
// "saved"/"failed" one when it returns, and the tab stays yours meanwhile.
ipcMain.on('ytdlp-open', () => {
  const wc = activeWc();
  openYtdlpPicker(wc?.getURL() || '', wc?.getTitle() || '');
});

// --- #179: "Create outfit in MuseForge…" ---
// Asks for an optional name and description in the chrome UI (Electron has no
// prompt()), then opens the Studio's from-image page in a new tab. The Studio
// confirms and spends; we only build the address.
function openOutfitDialog(src) {
  if (locked || !museforge.canSend(src)) return;
  if (outfitOpen || bmDialogOpen || ytdlpOpen || loginPromptOpen) return; // #195: one dialog answers Enter at a time
  outfitOpen = true;
  clearFsReveal();
  setChromeRaised(true);
  layout();
  chrome?.webContents.send('outfit-prompt', { src });
  chrome.webContents.focus();
}

ipcMain.on('outfit-answer', (_e, a) => {
  const wasOpen = outfitOpen; // #195: an answer with no dialog showing spends nothing
  outfitOpen = false;
  if (!bmDialogOpen && !settingsOpen && !managerOpen && !loginPromptOpen && !ytdlpOpen) setChromeRaised(false);
  layout();
  activeWc()?.focus();
  if (locked || !wasOpen || !a || !a.go) return;
  if (a.go === 'create') { createOutfitInBackground(a.src, a.name, a.text); return; } // #195
  openOutfitTab(a.src, a.name, a.text);
});

// #179/#191: the Studio's prefilled page in a tab, with the way back remembered.
function openOutfitTab(src, name, text, openerId = activeId) {
  const url = museforge.outfitUrl(src, name, text);
  if (!url || locked) return;
  // #191: remember where you came from. Set BEFORE createTab, because opening
  // the tab activates it and runs the adult sweep, which must already spare the
  // opener; createTab takes nextTabId as the new tab's id.
  outfitReturn = { tabId: nextTabId, openerId };
  if (createTab(url, false) !== outfitReturn?.tabId) outfitReturn = null;
}

// #195: Create without leaving the page. The Studio's form takes the picture's
// address and fetches it itself; the tabs' session already holds its login
// cookie. Logged out on this PC → the prefilled page opens instead, so you can
// log in and land on it.
const outfitCreating = new Set(); // #195: pictures with a Create in flight; each press costs money
async function createOutfitInBackground(src, name, text) {
  const body = museforge.createForm(src, name, text);
  if (!body) return;
  const openerId = activeId; // the login fallback returns here, even if you moved on meanwhile
  const say = (message) => {
    errorlog.record('outfit', message);
    if (Notification.isSupported()) new Notification({ title: 'Create Outfit', body: message }).show();
  };
  if (outfitCreating.has(src)) { say('Already creating an outfit from this picture'); return; }
  outfitCreating.add(src);
  try {
    const jar = await session.defaultSession.cookies.get({ url: museforge.OUTFIT_PAGE });
    const r = await fetch(museforge.OUTFIT_PAGE, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(jar.length ? { Cookie: jar.map((c) => `${c.name}=${c.value}`).join('; ') } : {}),
      },
      body,
      signal: AbortSignal.timeout(60000), // the Studio fetches the picture before answering
    });
    const result = museforge.createResult(r.status, r.headers.get('location'));
    if (result === 'queued') say('Outfit queued: 2 figures in Approvals');
    else if (result === 'login') { say('Log in to the Studio first'); openOutfitTab(src, name, text, openerId); }
    else say(`Create Outfit failed: HTTP ${r.status} ${(await r.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  } catch (err) {
    say(`Create Outfit failed: ${String(err.message || err).slice(0, 200)}`);
  } finally {
    outfitCreating.delete(src);
  }
}

// #191: the Create Outfit tab reached the Studio's "queued" page: back to the
// page you came from. Switching there closes the Studio tab (it is adult); the
// explicit close is a belt-and-braces for a non-adult Studio address. (If the
// opener closed first, closeTab already cleared outfitReturn and you stay put.)
function finishOutfit() {
  const r = outfitReturn;
  outfitReturn = null;
  if (!r) return;
  setTimeout(() => {
    if (locked) return;
    if (tabs.has(r.openerId)) activateTab(r.openerId);
    if (tabs.has(r.tabId)) closeTab(r.tabId, { adult: true });
  }, 0);
}

// The ⤓ button sends the page; the context menu sends the page or a link.
// #177: for the page you are on, the picker also offers 🖼 Gallery when the
// page links a few full-size images; what the reader found is kept for the send.
let pickerMeta = null; // { url, meta }
let pickerReading = false;
async function openYtdlpPicker(url, title) {
  if (locked || ytdlpOpen || pickerReading) return; // a double-click must not open two
  if (!ytdlp.downloadable(url)) {
    chrome?.webContents.send('ytdlp-status', { ok: false, message: 'Only web pages can be sent to yt-dlp.' });
    return;
  }
  const wc = activeWc();
  let meta = null;
  if (wc && wc.getURL() === url) {
    pickerReading = true;
    try { meta = await readStashMeta(wc); } finally { pickerReading = false; }
    if (locked || activeWc() !== wc) return; // locked or moved on while the page was read
  }
  pickerMeta = meta ? { url, meta } : null;
  ytdlpOpen = true;
  clearFsReveal();
  setChromeRaised(true);
  layout();
  const gallery = meta && stash.isGallery(meta) ? meta.image_urls.length : 0;
  chrome?.webContents.send('ytdlp-picker', { url, title: title || url, gallery, ...ytdlp.defaults(url) });
  chrome.webContents.focus();
}

// --- #177: Add to Stash ---
// shared/stash-page.js reads the page (the phone runs the same file); the
// Dashboard downloads, scans and tags, and answers with a job we poll. The
// ⤓ button shows ⏳ meanwhile. Closing the tab never stops it: the job is on
// the server, and the poll holds only the job id.
async function readStashMeta(wc) {
  const src = stash.readerSource();
  if (!src || !wc || wc.isDestroyed()) return {};
  let timer;
  try {
    const run = wc.executeJavaScript(src, true);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { errorlog.record('stash', 'page reader timed out; sending without page details'); resolve({}); }, 2000);
    });
    return (await Promise.race([run, timeout])) || {};
  } catch (err) {
    errorlog.record('stash', `page reader failed: ${String(err.message || err).slice(0, 200)}`);
    return {};
  } finally {
    clearTimeout(timer);
  }
}

async function sendToStash(kind, url, wc, meta = null) {
  if (locked) return;
  const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : url;
  const body = stash.body(kind, url, pageUrl, meta || (await readStashMeta(wc)));
  if (!body) {
    chrome?.webContents.send('ytdlp-status', { ok: false, message: 'Only web pages and files can be sent to Stash.' });
    return;
  }
  const note = (message, ok) => {
    chrome?.webContents.send('ytdlp-status', ok === undefined ? { message } : { ok, message });
    if (ok !== undefined && Notification.isSupported()) new Notification({ title: 'Stash', body: message }).show();
  };
  errorlog.record('stash', `sending ${kind}: ${url} (${body.meta.performers.length} performers, ${(body.meta.image_urls || []).length} images)`);
  chrome?.webContents.send('ytdlp-status', { ok: true, pending: true, message: `Sending ${kind} to Stash…` });
  try {
    const r = await fetch(stash.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.job) throw new Error(j.error || `HTTP ${r.status}`);
    const deadline = Date.now() + 60 * 60 * 1000;
    let last = '';
    for (;;) {
      await new Promise((res) => setTimeout(res, 3000));
      let s = null;
      try {
        const g = await fetch(`${stash.ENDPOINT}/${encodeURIComponent(j.job)}`, { signal: AbortSignal.timeout(15000) });
        s = await g.json().catch(() => null);
        if (g.status === 404) throw new Error('the Dashboard forgot the job (restarted?); the file may still have saved');
      } catch (err) {
        if (/forgot the job/.test(err.message)) throw err;
        // A blip: keep polling until the deadline.
      }
      const message = stash.statusText(kind, s);
      if (stash.finished(s)) {
        errorlog.record('stash', `${s.state}: ${message}`);
        note(message, s.state === 'done');
        return;
      }
      if (message !== last) { note(message); last = message; }
      if (Date.now() > deadline) throw new Error('still running after an hour; check the Dashboard');
    }
  } catch (err) {
    const message = `Stash ${kind} failed: ${String(err.message || err).slice(0, 300)}`;
    errorlog.record('stash', message);
    note(message, false);
  }
}

ipcMain.on('ytdlp-answer', (_e, a) => {
  ytdlpOpen = false;
  if (!bmDialogOpen && !settingsOpen && !managerOpen && !loginPromptOpen && !outfitOpen) setChromeRaised(false);
  layout();
  activeWc()?.focus();
  if (locked || !a || !a.send || !ytdlp.downloadable(a.url)) return;
  if (a.choice && a.choice.format === 'gallery') { // #177
    const wc = activeWc();
    const meta = pickerMeta && pickerMeta.url === a.url ? pickerMeta.meta : null;
    sendToStash('gallery', a.url, wc && wc.getURL() === a.url ? wc : null, meta);
    return;
  }
  const body = ytdlp.body(a.url, a.choice);
  const label = `${body.format === 'audio' ? 'audio' : 'video'}${body.kids ? ' (kids)' : body.adult ? ' (adult)' : ''}`;
  errorlog.record('ytdlp', `sending ${label}: ${body.url}`);
  chrome?.webContents.send('ytdlp-status', { ok: true, pending: true, message: `Sending ${label} to yt-dlp…` });
  fetch(ytdlp.ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(11 * 60 * 1000), // the server gives up at 10
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      return j.message || 'Download complete';
    })
    .then((message) => {
      errorlog.record('ytdlp', `done: ${message}`);
      chrome?.webContents.send('ytdlp-status', { ok: true, message });
      if (Notification.isSupported()) new Notification({ title: 'yt-dlp', body: message }).show();
    })
    .catch((err) => {
      const message = `yt-dlp failed: ${String(err.message || err).slice(0, 300)}`;
      errorlog.record('ytdlp', message);
      chrome?.webContents.send('ytdlp-status', { ok: false, message });
      if (Notification.isSupported()) new Notification({ title: 'yt-dlp', body: message }).show();
    });
});

// #29: bookmark edit dialog IPC.
ipcMain.on('bm-edit-request', (_e, id) => {
  if (locked) return;
  const b = bookmarks.all().find((x) => x.id === id);
  if (b) {
    openBookmarkDialog({
      id: b.id, title: b.title, url: b.url, folder: b.folder || '', exists: true,
      claim: personas.claimFor(b.url), // #70
      personas: routablePersonas().map((p) => ({ id: p.id, name: p.name })),
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
  } else if (background || isStickyTab(activeId)) {
    // #138: never navigate a sticky tab (pinned #117 / hotkey #33) to a
    // bookmark. It used to load here and then get re-homed a moment later,
    // which is precisely the flicker — the page appeared in the pinned tab and
    // was thrown away. Being sticky MEANS "this tab is only ever its own site",
    // so a bookmark belongs in its own tab. Opening it directly also skips the
    // load-then-undo entirely, rather than merely surviving it.
    createTab(url, background);
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

// #123: update visibility. The flow existed since #5 but reported nothing, so a
// broken check looked exactly like "no update available".
ipcMain.handle('int:update-state', () => ({
  ...updateState,
  packaged: app.isPackaged, // an unpackaged dev run never checks at all
  current: app.getVersion(),
}));
ipcMain.handle('int:update-check', () => {
  if (!updateCheckNow) return false; // not packaged — nothing to check
  updateCheckNow();
  return true;
});
ipcMain.handle('int:update-restart', () => {
  try {
    require('electron-updater').autoUpdater.quitAndInstall();
    return true;
  } catch (err) {
    errorlog.record('update-restart', err);
    return false;
  }
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
    rehomeAllTabs(); // #120
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
  // #107: focus an existing tab for this URL instead of duplicating it.
  const existing = findTabByUrl(String(url));
  if (existing !== null) {
    activateTab(existing);
    return true;
  }
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
  personas: routablePersonas().map((p) => ({ id: p.id, name: p.name })),
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
  if (locked || personas.isBuiltinView(personas.activeId())) return false; // #214
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

  // #123: this used to be `on('error', () => {})` and `.catch(() => {})` — every
  // failure was swallowed, so a broken update check was indistinguishable from
  // "no update available". The user manually installed ~15 builds in one session
  // without ever seeing a prompt, and nothing anywhere recorded why.
  const setUpdateState = (status, extra = {}) => {
    updateState = { status, at: Date.now(), ...extra };
    chrome?.webContents.send('update-state', updateState);
  };
  autoUpdater.on('error', (err) => {
    errorlog.record('update-error', err);
    setUpdateState('error', { message: String(err?.message || err) });
  });
  autoUpdater.on('checking-for-update', () => setUpdateState('checking'));
  autoUpdater.on('update-not-available', (info) => {
    errorlog.record('update', `up to date (${info?.version || 'unknown'})`);
    setUpdateState('current', { version: info?.version });
  });
  autoUpdater.on('update-available', (info) => {
    errorlog.record('update', `available: ${info?.version} — downloading`);
    setUpdateState('downloading', { version: info?.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (p) => {
    setUpdateState('downloading', { percent: Math.round(p?.percent || 0) });
  });

  // #5: don't re-prompt a version the user already declined — the downloaded
  // update still applies on next quit (electron-updater's autoInstallOnAppQuit).
  let promptedVersion = null;
  autoUpdater.on('update-downloaded', (info) => {
    errorlog.record('update', `downloaded ${info?.version} — prompting`);
    // #123: the state persists even if the dialog is dismissed, so Settings can
    // still offer "Restart to apply" afterwards.
    setUpdateState('ready', { version: info?.version });
    if (info.version === promptedVersion) return;
    promptedVersion = info.version;
    // #123: the app is ALWAYS fullscreen (#37), and a dialog that opens behind
    // the window is indistinguishable from no dialog — the #111 round-2 failure.
    // Raise and focus before asking.
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (err) {
      errorlog.record('update-focus', err);
    }
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
  // #123: a failed check is logged rather than silently discarded. Off the
  // tailnet this is expected and harmless — but it must be visible, not assumed.
  const check = () =>
    autoUpdater.checkForUpdates().catch((err) => {
      errorlog.record('update-check-failed', err);
      setUpdateState('error', { message: String(err?.message || err) });
    });
  updateCheckNow = check;

  // #5: a long-running window must notice releases staged after launch —
  // startup + every 4h + on window focus. Focus checks are throttled to one
  // per 2 min (#6: 10 min made a freshly staged release feel broken; a check
  // against the LAN endpoint costs nothing).
  check();
  setInterval(() => alive() && check(), 4 * 60 * 60 * 1000); // #147
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
    // #148: restore()/show() are REQUESTS to the window manager, not completed
    // state changes. Creating the tab in this same tick sized it against the
    // pre-restore geometry, so it painted black until something else forced a
    // relayout. Let the window actually come up first.
    whenWindowReady(() => openExternalUrl(url));
  });
}

app.whenReady().then(() => {
  ytdlp.setUser(adultUser()); // #203: before any tab is restored or swept
  applySlots(); // #214: before the active Persona (maybe an app slot) is read
  if (!isPrimaryInstance) return; // losing the lock means this process is a no-op
  setupLogShipping(); // #171: first, so startup errors reach the server too
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
  whenWindowReady(() => openExternalUrl(urlFromArgv(process.argv))); // #148
  setInterval(syncBookmarks, 10 * 60 * 1000); // #13: periodic catch-up
  setInterval(syncPersonas, 10 * 60 * 1000); // #88
  setInterval(syncAdult, 10 * 60 * 1000); // #203
  setInterval(syncTabs, 30 * 1000); // #95: 30s, matching Android — a minute felt dead
  setInterval(sweepStaleTabs, 5 * 60 * 1000); // #79
  setInterval(recordPerf, 10 * 60 * 1000); // #216
});

// #216: the slowdown report came with no numbers to check it against. Every 10
// minutes, log tab counts and CPU/memory per process type, so the next round
// can compare instead of guess. Lands in errors.log and the server's copy (#171).
function recordPerf() {
  if (!alive()) return;
  try {
    const byType = {};
    for (const m of app.getAppMetrics()) {
      const t = (byType[m.type] ||= { n: 0, cpu: 0, mb: 0 });
      t.n += 1;
      t.cpu += m.cpu?.percentCPUUsage || 0;
      t.mb += (m.memory?.workingSetSize || 0) / 1024; // KB -> MB
    }
    const procs = Object.entries(byType)
      .map(([type, t]) => `${type}=${t.n}/${t.cpu.toFixed(1)}%/${Math.round(t.mb)}MB`)
      .join(' ');
    const terminals = [...tabs.keys()].filter(isTerminalTab).length;
    errorlog.record('perf', `tabs=${tabs.size} unloaded=${lazyTabs.size} terminals=${terminals} ${procs}`);
  } catch (err) {
    errorlog.record('perf', err);
  }
}

app.on('before-quit', () => {
  quitting = true; // #219: tabs dying at shutdown are not pages closing themselves
  clearInterval(fsPollTimer); // #20: never let the poll outlive the window
  fsPollTimer = null;
  // #147: #20 cleared the one timer that existed then. Everything deferred
  // since — the 40ms pushState coalesce, the 500ms session debounce, the
  // bookmark sync — could still fire after the window went away. The alive()
  // guard makes that harmless; cancelling here means it does not happen at all.
  clearTimeout(pushTimer);
  pushTimer = null;
  clearTimeout(saveSessionTimer);
  clearTimeout(syncTimer);
  saveSessionNow(); // flush any pending debounce
  clearTimeout(shipTimer);
  shipper?.flush(); // #171: best effort; whatever doesn't make it is in errors.log
  errorlog.flush(); // #216: the log writes on a timer now; quit won't wait for it
});
app.on('window-all-closed', () => app.quit());

// --- #171: errors.log also goes to the sync server ---
// It used to live only on the PC, so every Windows bug meant reading Settings →
// Diagnostics back to us. Now each entry lands in data/logs/<device>.log on
// dockerhost. Sends are debounced, retried on the next flush when they fail,
// and capped in memory (logship.js); the local file is still written first.
const LOGS_URL = 'http://100.69.184.113:8013/logs/';
let shipper = null;
let shipTimer = null;

function setupLogShipping() {
  const os = require('os');
  shipper = logship.create({
    url: LOGS_URL + logship.deviceName(os.hostname()),
    version: app.getVersion(),
    fetch: (...a) => fetch(...a),
  });
  errorlog.onRecord((entry) => {
    shipper.push(entry);
    clearTimeout(shipTimer);
    shipTimer = setTimeout(() => shipper.flush(), 2000);
  });
  setInterval(() => shipper.flush(), 60 * 1000); // retries what failed
  const { screen } = require('electron');
  errorlog.record(
    'session',
    `start v${app.getVersion()} electron=${process.versions.electron} ` +
      `os=${os.release()} displays=${screen.getAllDisplays().length}`
  );
}

// #20: a stray throw must never brick the browser in a modal-dialog storm —
// log it and keep running instead of Electron's default uncaught dialog.
process.on('uncaughtException', (err) => {
  errorlog.record('uncaughtException', err); // #75: visible in Settings
  errorlog.flush(); // #216: the log is buffered now, and this may be the last thing we do
});
process.on('unhandledRejection', (err) => {
  errorlog.record('unhandledRejection', err);
  errorlog.flush(); // #216
});
