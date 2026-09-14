// #145: verify the capture side against real login-form DOMs.
//
// The capture code lives in content-preload.js, which cannot be `require`d (it
// pulls in electron and runs against a DOM), so the block is extracted from the
// real shipped source and evaluated in a real Chromium — the same technique
// hints.test.js uses, and the same reason scripts/autofill-dom-check.js exists.
//
//   xvfb-run -a windows/node_modules/electron/dist/electron --no-sandbox \
//     scripts/logincapture-dom-check.js
//
// What matters here is that it reports the username BESIDE the password, not
// the first text box on the page. That mistake cost three rounds in #144, and
// capture would turn it into a corrupted credential rather than a stray fill.
const { app, BaseWindow, WebContentsView } = require('electron');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'windows', 'content-preload.js'),
  'utf8'
);
const from = src.indexOf('  const passwordFields = (root, depth, out) => {');
const to = src.indexOf('  const report = () => {');
if (from === -1 || to === -1) {
  console.error('FAIL: capture block not found in content-preload.js — did it move?');
  process.exit(1);
}
const block = src.slice(from, to);

const CASES = [
  {
    name: 'a plain login form reports both fields',
    html: `<form><input type="text" id="u" value="bbell"><input type="password" value="secret"></form>`,
    expect: { username: 'bbell', password: 'secret' },
  },
  {
    name: 'a header search box is NOT reported as the username (#144 lesson)',
    html: `<header><input type="text" name="q" value="some search"></header>
           <form><input type="text" name="login" value="bbell"><input type="password" value="secret"></form>`,
    expect: { username: 'bbell', password: 'secret' },
  },
  {
    name: 'an email field counts as the username',
    html: `<form><input type="email" value="me@example.com"><input type="password" value="s"></form>`,
    expect: { username: 'me@example.com', password: 's' },
  },
  {
    name: 'a form inside a shadow root is seen',
    html: `<div id="h"></div><script>
      const r = document.getElementById('h').attachShadow({mode:'open'});
      r.innerHTML = '<form><input type="text" value="bbell"><input type="password" value="secret"></form>';
    </script>`,
    expect: { username: 'bbell', password: 'secret' },
  },
  {
    name: 'a password-only form reports an empty username',
    html: `<form><input type="password" value="secret"></form>`,
    expect: { username: '', password: 'secret' },
  },
  {
    name: 'an empty password reports nothing at all',
    html: `<form><input type="text" value="bbell"><input type="password" value=""></form>`,
    expect: null,
  },
  {
    name: 'a page with no password field reports nothing',
    html: `<input type="text" value="typing away">`,
    expect: null,
  },
  {
    name: 'an empty username field is skipped in favour of a filled one',
    html: `<form><input type="text" id="blank" value=""><input type="text" value="bbell">
           <input type="password" value="secret"></form>`,
    expect: { username: 'bbell', password: 'secret' },
  },
];

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 900, height: 700, show: false });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  const wc = view.webContents;

  let pass = 0;
  let fail = 0;
  for (const c of CASES) {
    await wc.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><body>${c.html}`)
    );
    const got = await wc.executeJavaScript(
      `(() => {
        ${block}
        const pw = passwordFields(document, 0, []).find((el) => el.value);
        if (!pw) return null;
        return JSON.stringify({ username: usernameFor(pw), password: pw.value });
      })()`,
      true
    );
    const actual = got ? JSON.parse(got) : null;
    const ok = JSON.stringify(actual) === JSON.stringify(c.expect);
    if (ok) {
      pass++;
      console.log(`  ok  ${c.name}`);
    } else {
      fail++;
      console.log(
        `  FAIL  ${c.name}\n        got ${JSON.stringify(actual)}, expected ${JSON.stringify(c.expect)}`
      );
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
