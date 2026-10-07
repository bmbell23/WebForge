// #276: a local shell as a terminal session — node-pty, same interface as
// terminal-main's openSession (onData, onStatus, onClose, onReady; returns
// { write, resize, end }). Electron is only touched by loadPty, so openLocal
// runs under plain node with a fake or real pty injected (localterm.test.js).
const os = require('os');
const path = require('path');
const term = require('./terminal');

// node-pty's ConPTY worker starts from __dirname and only rewrites
// node_modules.asar, not app.asar, so a packaged build ships it outside the
// asar as resources/node-pty (package.json extraResources; asarUnpack breaks on
// our ../shared files entry in electron-builder 25). Loaded on first local session only:
// an SSH-only user never pays for it and a failure only breaks local tabs.
function loadPty() {
  const { app } = require('electron');
  const base = app.isPackaged ? path.join(process.resourcesPath, 'node-pty') : 'node-pty';
  return require(base);
}

// Returns the session handle, or null (after reporting through onStatus + onClose)
// if the target is not a local shell here or the shell could not start.
function openLocal(target, { cols = 80, rows = 24, onData, onStatus, onClose, onReady = () => {} }, pty = null, platform = process.platform) {
  let closed = false;
  const close = (code) => {
    if (closed) return;
    closed = true;
    onClose(code);
  };
  const fail = (text) => {
    onStatus('error', text);
    setImmediate(() => close(null)); // after the caller has the handle, so its onClose can recognize it
    return { write() {}, resize() {}, end: () => { closed = true; } };
  };
  const spec = term.parseLocal(target, platform);
  if (!spec) return fail(`${target} is not a local shell on this system`);
  let proc;
  try {
    const env = { ...process.env };
    if (platform !== 'win32') env.TERM = 'xterm-256color';
    proc = (pty || loadPty()).spawn(spec.file, spec.args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env });
  } catch (err) {
    return fail(`could not start ${spec.label}: ${err.message}`);
  }
  proc.onData((d) => onData(Buffer.from(d)));
  proc.onExit(({ exitCode }) => close(exitCode));
  onReady();
  return {
    write: (data) => { if (!closed) proc.write(data); },
    resize: (c, r) => { if (!closed) { try { proc.resize(c, r); } catch {} } }, // throws once the pty is gone
    end: () => {
      closed = true;
      try { proc.kill(); } catch {}
    },
  };
}

module.exports = { openLocal, loadPty };
