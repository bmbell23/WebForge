// #136: verify the REAL injected filler against real login-form DOMs.
//
// credmatch.js decides *which* credential; this checks the other half — whether
// the injected script can actually find and fill a form. That half needs a DOM,
// so it cannot live in the node test suite (see webforge testing pattern). Run:
//
//   xvfb-run -a windows/node_modules/electron/dist/electron --no-sandbox \
//     scripts/autofill-dom-check.js
//
// It imports windows/autofill-inject.js directly, so it exercises exactly the
// code that ships rather than a copy that can drift out of sync.
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const { fillScript } = require(path.join(__dirname, '..', 'windows', 'autofill-inject'));

const USER = 'me@example.com';
// Deliberately hostile: quotes, backslash, backtick and a template-literal
// opener, all of which would break naive string concatenation.
const PASS = 'p\'"\\`${alert(1)}#&';

const CASES = [
  {
    name: 'a plain login form fills',
    html: `<form><input type="text" name="u"><input type="password" name="p"></form>`,
    expect: 'filled',
    check: 'document.querySelector(\'input[name="u"]\').value',
    checkIs: USER,
  },
  {
    name: 'the password value survives quotes, backslashes and ${} intact',
    html: `<form><input type="text"><input type="password"></form>`,
    expect: 'filled',
    check: 'document.querySelector(\'input[type=password]\').value',
    checkIs: PASS,
  },
  {
    name: 'an email field counts as the username field',
    html: `<form><input type="email"><input type="password"></form>`,
    expect: 'filled',
    check: 'document.querySelector(\'input[type=email]\').value',
    checkIs: USER,
  },
  {
    name: 'a form inside a shadow root is found (#129 lesson)',
    html: `<div id="host"></div><script>
      const r = document.getElementById('host').attachShadow({mode:'open'});
      r.innerHTML = '<form><input type="text"><input type="password"></form>';
    </script>`,
    expect: 'filled',
    check: `document.getElementById('host').shadowRoot.querySelector('input[type=password]').value`,
    checkIs: PASS,
  },
  {
    name: 'a form nested TWO shadow roots deep is still found',
    html: `<div id="a"></div><script>
      const r1 = document.getElementById('a').attachShadow({mode:'open'});
      r1.innerHTML = '<div id="b"></div>';
      const r2 = r1.getElementById('b').attachShadow({mode:'open'});
      r2.innerHTML = '<form><input type="text"><input type="password"></form>';
    </script>`,
    expect: 'filled',
  },
  {
    name: 'a HIDDEN dummy password field is ignored, and does not fake success',
    html: `<input type="password" style="display:none" id="decoy">`,
    expect: false,
    check: `document.getElementById('decoy').value`,
    checkIs: '',
  },
  {
    name: 'a zero-size password field is ignored',
    html: `<input type="password" style="width:0;height:0;padding:0;border:0">`,
    expect: false,
  },
  {
    name: 'a password field hidden off-screen (left:-9999px) is ignored',
    html: `<input type="password" style="position:absolute;left:-9999px">`,
    expect: false,
  },
  {
    name: 'a password field inside a display:none ANCESTOR is ignored',
    html: `<div style="display:none"><form><input type="text"><input type="password"></form></div>`,
    expect: false,
  },
  {
    name: 'a normally-sized field below the fold still fills',
    html: `<div style="height:3000px"></div><form><input type="text"><input type="password"></form>`,
    expect: 'filled',
  },
  {
    name: 'the real field is filled even when a hidden decoy comes first',
    html: `<input type="password" style="display:none" id="decoy">
           <form><input type="text"><input type="password" id="real"></form>`,
    expect: 'filled',
    check: `document.getElementById('real').value + '|' + document.getElementById('decoy').value`,
    checkIs: `${PASS}|`,
  },
  {
    name: 'a two-step login fills the username and reports it is not done',
    html: `<form><input type="text" name="u"><button>Next</button></form>`,
    expect: 'user',
    check: 'document.querySelector(\'input[name="u"]\').value',
    checkIs: USER,
  },
  {
    name: 'a page with no login form does nothing',
    html: `<h1>hello</h1><input type="search">`,
    expect: false,
  },
  {
    name: 'a password the user already typed is never overwritten',
    html: `<form><input type="password" id="p" value="typed-by-hand"></form>`,
    expect: false,
    check: `document.getElementById('p').value`,
    checkIs: 'typed-by-hand',
  },
  {
    name: 'a username the user already typed is preserved while the password fills',
    html: `<form><input type="text" id="u" value="someone-else"><input type="password"></form>`,
    expect: 'filled',
    check: `document.getElementById('u').value`,
    checkIs: 'someone-else',
  },
  {
    name: 'a disabled password field is not treated as the login form',
    html: `<input type="password" disabled>`,
    expect: false,
  },
  {
    name: 'input and change events fire so frameworks see the value',
    html: `<form><input type="password" id="p"></form><script>
      window.__seen = [];
      document.getElementById('p').addEventListener('input', () => window.__seen.push('input'));
      document.getElementById('p').addEventListener('change', () => window.__seen.push('change'));
    </script>`,
    expect: 'filled',
    check: 'JSON.stringify(window.__seen)',
    checkIs: '["input","change"]',
  },
];

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 1000, height: 800, show: false });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  const wc = view.webContents;

  let pass = 0;
  let fail = 0;
  for (const c of CASES) {
    await wc.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><body>${c.html}`)
    );
    const got = await wc.executeJavaScript(fillScript(USER, PASS), true);
    let ok = got === c.expect;
    let detail = `returned ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)}`;
    if (ok && c.check) {
      const actual = await wc.executeJavaScript(c.check, true);
      ok = actual === c.checkIs;
      detail = `DOM was ${JSON.stringify(actual)}, expected ${JSON.stringify(c.checkIs)}`;
    }
    if (ok) {
      pass++;
      console.log(`  ok  ${c.name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${c.name}\n        ${detail}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
