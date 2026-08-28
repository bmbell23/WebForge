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
    html: `<form><input type="text" name="username"><button>Next</button></form>`,
    expect: 'user',
    check: 'document.querySelector(\'input[name="username"]\').value',
    checkIs: USER,
  },
  {
    name: '#144: with the username budget spent, the field is left alone',
    html: `<form><input type="text" name="username" id="u"><button>Next</button></form>`,
    mayFillUsername: false,
    expect: false,
    check: `document.getElementById('u').value`,
    checkIs: '',
  },
  {
    name: '#144: budget spent still fills a real password form',
    html: `<form><input type="text" name="username"><input type="password" id="p"></form>`,
    mayFillUsername: false,
    expect: 'filled',
    check: `document.getElementById('p').value`,
    checkIs: PASS,
  },
  {
    name: 'a page with no login form does nothing',
    html: `<h1>hello</h1><input type="search">`,
    expect: false,
  },
  // --- #144 regression cases. The case above passed while the bug was live,
  // because type="search" never matched the faulty predicate. These use
  // type="text" — the type that is actually everywhere — which is exactly what
  // the original check should have done.
  {
    name: '#144: an ordinary text box on a page with no login form is NOT touched',
    html: `<h1>Search</h1><input type="text" id="q" placeholder="Search the site">`,
    expect: false,
    check: `document.getElementById('q').value`,
    checkIs: '',
  },
  {
    name: '#144: a comment box is not treated as a username field',
    html: `<textarea id="c"></textarea><input type="text" id="subject" placeholder="Subject">`,
    expect: false,
    check: `document.getElementById('subject').value`,
    checkIs: '',
  },
  {
    name: '#144: a bare unlabelled text input is not a username field',
    html: `<form><input type="text" name="q"></form>`,
    expect: false,
  },
  {
    name: 'a two-step login with autocomplete=username still fills',
    html: `<form><input type="text" autocomplete="username" id="u"><button>Next</button></form>`,
    expect: 'user',
    check: `document.getElementById('u').value`,
    checkIs: USER,
  },
  {
    name: 'a two-step login identified by name="username" still fills',
    html: `<form><input type="text" name="username" id="u"><button>Next</button></form>`,
    expect: 'user',
    check: `document.getElementById('u').value`,
    checkIs: USER,
  },
  {
    name: 'a two-step login identified by an email placeholder still fills',
    html: `<form><input type="text" id="u" placeholder="Email address"><button>Next</button></form>`,
    expect: 'user',
    check: `document.getElementById('u').value`,
    checkIs: USER,
  },
  // --- #144 round 2: the username must come from BESIDE the password field.
  // Reported as "bbell randomly on some sites, like my work github instance":
  // a header search box sits earlier in the DOM than the login form, and the
  // whole-page search handed it the username.
  {
    name: '#144r2: a header search box does NOT get the username',
    html: `<header><input type="text" id="search" name="q" aria-label="Search GitHub"></header>
           <form><input type="text" id="realuser" name="login" autocomplete="username">
           <input type="password" id="pw"></form>`,
    expect: 'filled',
    check: `document.getElementById('search').value + '|' + document.getElementById('realuser').value`,
    checkIs: `|${USER}`,
  },
  {
    name: '#144r2: with no <form>, the nearby field wins over a distant one',
    html: `<div><input type="text" id="far" name="q"></div>
           <div><input type="text" id="near"><input type="password"></div>`,
    expect: 'filled',
    check: `document.getElementById('far').value + '|' + document.getElementById('near').value`,
    checkIs: `|${USER}`,
  },
  {
    name: '#144r2: a username BELOW the password is still found',
    html: `<form><input type="password"><input type="text" id="u" name="username"></form>`,
    expect: 'filled',
    check: `document.getElementById('u').value`,
    checkIs: USER,
  },
  {
    name: '#144r2: two login forms on a page do not cross-contaminate',
    html: `<form id="f1"><input type="text" id="u1"><input type="password" id="p1"></form>
           <form id="f2"><input type="text" id="u2"><input type="password" id="p2"></form>`,
    expect: 'filled',
    // only the FIRST form is touched; the second is left entirely alone
    check: `document.getElementById('u1').value + '|' + document.getElementById('u2').value
            + '|' + document.getElementById('p2').value`,
    checkIs: `${USER}||`,
  },
  {
    name: '#144: autofill never moves focus',
    html: `<input type="text" id="typing"><form><input type="text"><input type="password"></form>
           <script>document.getElementById('typing').focus();</script>`,
    expect: 'filled',
    check: `document.activeElement.id`,
    checkIs: 'typing',
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
    const got = await wc.executeJavaScript(fillScript(USER, PASS, c.mayFillUsername !== false), true);
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
