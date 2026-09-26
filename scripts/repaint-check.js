// #148: exercise the real repaint path against a real WebContentsView.
//
// What this CAN prove: invalidate() is callable and doesn't throw, the nudge
// applies a distinct geometry and reverts it exactly, and the whole sequence
// runs clean against a view created while the window was hidden — the state
// the black-page bug happens in.
//
// What it CANNOT prove: that a frame reaches the screen. That is a compositor
// behaviour on a real display, and this host has none. Do not read a pass here
// as "the bug is fixed".
//
//   xvfb-run -a windows/node_modules/electron/dist/electron --no-sandbox \
//     scripts/repaint-check.js
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const repaint = require(path.join(__dirname, '..', 'windows', 'repaint.js'));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  // Deliberately hidden: this is the external-link-into-a-minimised-window case.
  const win = new BaseWindow({ width: 900, height: 700, show: false });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  const wc = view.webContents;
  view.setBounds({ x: 240, y: 0, width: 660, height: 660 });
  await wc.loadURL('data:text/html,<body style="background:#0a0">painted');

  check('a view created while the window is hidden reports not visible',
    win.isVisible() === false);

  // The policy must want a repaint here — never painted.
  const d = repaint.shouldForce({ everPainted: false, becameVisible: true, boundsChanged: false });
  check('policy forces a repaint for a never-painted view', d.force === true, d.reason);

  let threw = null;
  try { wc.invalidate(); } catch (e) { threw = e; }
  check('invalidate() does not throw on a real WebContentsView', threw === null, threw && threw.message);

  // The nudge must apply AND revert exactly — a nudge that leaks geometry
  // would shrink the page by a pixel on every tab switch.
  const before = view.getBounds();
  const nudged = repaint.nudgeBounds(before);
  check('nudge is distinct from current bounds', repaint.isDistinct(before, nudged));
  view.setBounds(nudged);
  const during = view.getBounds();
  check('nudge actually applied', repaint.isDistinct(before, during),
    `${JSON.stringify(before)} -> ${JSON.stringify(during)}`);
  view.setBounds(before);
  const after = view.getBounds();
  check('bounds restored exactly — no cumulative drift',
    !repaint.isDistinct(before, after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  // And the sequence must survive the window actually coming up.
  win.show();
  await new Promise((r) => setTimeout(r, 200));
  let threw2 = null;
  try {
    wc.invalidate();
    view.setBounds(repaint.nudgeBounds(view.getBounds()));
    view.setBounds(before);
  } catch (e) { threw2 = e; }
  check('full force sequence runs clean after the window is shown',
    threw2 === null && !repaint.isDistinct(before, view.getBounds()), threw2 && threw2.message);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('NOTE: this proves the path runs, NOT that a frame reaches a screen.');
  win.destroy();
  app.exit(fail ? 1 : 0);
});
