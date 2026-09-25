// #150: do the preloads actually BOOT?
//
// Run:  xvfb-run -a windows/node_modules/electron/dist/electron --no-sandbox \\
//         scripts/preload-boot-check.js
//
// Electron sandboxes renderers by default, so a preload can require `electron`
// and a couple of node built-ins — NEVER a local file. #150 added
// `require('./modifier')` to all three preloads; every unit test still passed,
// because the unit tests import the module directly and never load a preload.
// In a real renderer all three would have died on load, taking the whole UI
// with them — the #65 failure exactly: silent, total, and invisible to `node`.
//
// So this loads each preload the way the app does and asserts the bridge exists.
// the chrome UI's hotkey-id path actually works through the bridge. A preload
// that throws is silent — the bridge just never appears, which is how #65
// bricked startup, so unit tests alone are not enough here.
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const DIR = path.join(__dirname, '..', 'windows');

// Unpackaged dev runs always emit this; it is not a fault in our code.
const NOISE = /Electron Security Warning|Insecure Content-Security-Policy/;

const CASES = [
  { name: 'preload.js + the real chrome UI', preload: 'preload.js',
    url: 'file://' + path.join(DIR, 'ui', 'index.html'), expect: 'webforge' },
  { name: 'content-preload.js on a web page', preload: 'content-preload.js',
    url: 'data:text/html,<body>content', expect: null },
  { name: 'internal-preload.js on an internal page', preload: 'internal-preload.js',
    url: 'data:text/html,<body>internal', expect: 'wf' },
];

app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 900, height: 700, show: false });
  let fail = 0;
  for (const c of CASES) {
    const errors = [];
    const view = new WebContentsView({
      webPreferences: { preload: path.join(DIR, c.preload), nodeIntegration: false, contextIsolation: true },
    });
    win.contentView.addChildView(view);
    const wc = view.webContents;
    wc.on('preload-error', (_e, p, err) => errors.push(`preload threw: ${err.message}`));
    wc.on('console-message', (_e, lvl, msg) => { if (lvl >= 2 && !NOISE.test(msg)) errors.push('console: ' + msg); });
    await wc.loadURL(c.url);
    const bridge = c.expect ? await wc.executeJavaScript(`typeof window[${JSON.stringify(c.expect)}]`, true) : 'n/a';
    const ok = errors.length === 0 && (!c.expect || bridge === 'object');
    if (ok) console.log(`  ok  ${c.name}`);
    else { fail++; console.log(`  FAIL  ${c.name} — ${JSON.stringify(errors)} bridge=${bridge}`); }
    win.contentView.removeChildView(view);
  }

  // The thing the user actually does: press a key while binding a hotkey, and
  // get an id back. Exercised through the real bridge, not a stub.
  const view = new WebContentsView({
    webPreferences: { preload: path.join(DIR, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  win.contentView.addChildView(view);
  await view.webContents.loadURL('file://' + path.join(DIR, 'ui', 'index.html'));
  const ids = await view.webContents.executeJavaScript(`JSON.stringify({
    ctrl: webforge.keyId({ctrlKey:true, metaKey:false, altKey:false}, 'K'),
    cmd:  webforge.keyId({ctrlKey:false, metaKey:true, altKey:false}, 'K'),
    plain: webforge.keyId({ctrlKey:false, metaKey:false, altKey:false}, 'K'),
    foreignMeta: webforge.isForeignModifier({ctrlKey:false, metaKey:true}),
  })`, true);
  const got = JSON.parse(ids);
  // This host is linux, so Ctrl is primary and Meta is foreign — same as Windows.
  const want = { ctrl: 'Ctrl+K', cmd: 'K', plain: 'K', foreignMeta: true };
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok  chrome UI gets real ids through the bridge: ${ids}`);
  else { fail++; console.log(`  FAIL  bridge ids: got ${ids}, want ${JSON.stringify(want)}`); }

  console.log(fail ? `\n${fail} failed` : '\nall green');
  win.destroy();
  app.exit(fail ? 1 : 0);
});
