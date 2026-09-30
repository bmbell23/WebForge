// #131: is the chrome UI actually keyboard-navigable?
//
// Loads the REAL ui/index.html with the REAL preload in Electron, pushes tab and
// bookmark state through the same IPC the app uses, and then checks what a
// keyboard can reach. Unit tests cover the surface logic (focusring.test.js); this
// covers the part that was actually missing — that the rows are focusable at
// all. Before #131 this file contained zero tabindex attributes, so every
// assertion below would have failed.
//
//   xvfb-run -a windows/node_modules/electron/dist/electron --no-sandbox \
//     scripts/focus-dom-check.js
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const DIR = path.join(__dirname, '..', 'windows');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 1200, height: 800, show: false });
  const chrome = new WebContentsView({
    webPreferences: { preload: path.join(DIR, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  win.contentView.addChildView(chrome);
  chrome.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  const wc = chrome.webContents;
  await wc.loadFile(path.join(DIR, 'ui', 'index.html'));
  await wait(400);

  // Feed it real state through the real channels.
  // tabState() sends a FLAT ARRAY, not {tabs, active} — checked against main.js
  // rather than assumed. Getting this wrong made the harness report 0 tab rows
  // and blame the UI.
  wc.send('tabs-updated', [
    { id: 1, title: 'First tab', url: 'https://a.test', active: false, pinned: false, hotkey: null, favicon: null },
    { id: 2, title: 'Second tab', url: 'https://b.test', active: true, pinned: false, hotkey: null, favicon: null },
    { id: 3, title: 'Third tab', url: 'https://c.test', active: false, pinned: false, hotkey: null, favicon: null },
  ]);
  wc.send('bookmarks-updated', [
    { id: 'b1', title: 'Bookmark one', url: 'https://one.test', folder: '' },
    { id: 'b2', title: 'Bookmark two', url: 'https://two.test', folder: '' },
  ]);
  wc.send('bookmarks-panel', true);
  await wait(500);

  const js = (code) => wc.executeJavaScript(code);

  const tabCount = await js('document.querySelectorAll("#tablist .tab").length');
  check('tab rows rendered', tabCount >= 3, `got ${tabCount}`);

  const focusableTabs = await js('document.querySelectorAll(\'#tablist .tab[tabindex="0"]\').length');
  // `=== tabCount` alone passes when BOTH are zero — which is exactly how this
  // check first reported success against an empty list. Require a real count.
  check('every tab row is focusable (tabindex=0)',
    tabCount > 0 && focusableTabs === tabCount, `${focusableTabs} of ${tabCount}`);

  const bmCount = await js('document.querySelectorAll("#bmlist .bm").length');
  const focusableBms = await js('document.querySelectorAll(\'#bmlist .bm[tabindex="0"]\').length');
  check('every bookmark row is focusable', bmCount > 0 && focusableBms === bmCount,
    `${focusableBms} of ${bmCount}`);

  // Ctrl+L -> 'tabs' must land on the ACTIVE tab, not the top of the list.
  wc.send('focus-surface', 'tabs');
  await wait(250);
  const landed = await js(
    'JSON.stringify({cls: document.activeElement.className, txt: (document.activeElement.textContent||"").slice(0,20)})'
  );
  check('focus-surface "tabs" lands on the ACTIVE tab', /active/.test(landed), landed);

  // #131 round 2: Tab is now THE mechanism, so it has to be proved, not assumed.
  // Real sendInputEvent presses, not synthetic KeyboardEvents — a dispatched
  // event would exercise our handlers while telling us nothing about whether the
  // browser's own focus traversal can actually reach these rows.
  wc.send('focus-surface', 'url');
  await wait(250);
  const seen = [];
  for (let i = 0; i < 12; i++) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await wait(90);
    seen.push(await js('(document.activeElement.id || document.activeElement.className || document.activeElement.tagName)'));
  }
  check('Tab from the address bar reaches a tab row',
    seen.some((s) => /\btab\b/.test(String(s))), JSON.stringify(seen));
  check('Tab reaches a bookmark row too',
    seen.some((s) => /\bbm\b/.test(String(s))), JSON.stringify(seen));
  check('Tab actually moves focus (more than one distinct target)',
    new Set(seen).size > 2, JSON.stringify(seen));

  // Enter must activate. The IPC arriving is the proof.
  const activated = new Promise((res) => ipcMain.once('activate-tab', (_e, id) => res(id)));
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  const gotId = await Promise.race([activated, wait(800).then(() => null)]);
  check('Enter on a focused tab row activates it', gotId !== null, `ipc id=${gotId}`);

  // Address bar.
  wc.send('focus-surface', 'url');
  await wait(250);
  check('focus-surface "url" focuses the address bar',
    (await js('document.activeElement.id')) === 'url');

  // Bookmarks.
  wc.send('focus-surface', 'bookmarks');
  await wait(250);
  check('focus-surface "bookmarks" focuses a bookmark row',
    /\bbm\b/.test(await js('document.activeElement.className')),
    await js('document.activeElement.className'));

  // 'page' must RELEASE focus, or the chrome keeps a ring for keys it won't get.
  wc.send('focus-surface', 'page');
  await wait(250);
  const after = await js('document.activeElement === document.body || document.activeElement === null');
  check('focus-surface "page" releases focus in the chrome', after === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
