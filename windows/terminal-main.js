// #206: terminal spike — a bare window that SSHes to DEFAULT_TARGET and runs the
// remote shell (forge). Main-process half: the ssh2 connection and the window.
// electron is required lazily so openSession/buildConfig run under plain node
// (the smoke test does exactly that).
const fs = require('fs');
const os = require('os');
const path = require('path');
// Loaded on first use, so a packaging problem with ssh2 can only break the terminal, never startup.
const ssh2 = () => require('ssh2');
const term = require('./terminal');

const DEFAULT_TARGET = 'brandon@dockerhost';

function agentPath() {
  return process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : null);
}

// First readable key in ~/.ssh that is not passphrase-protected.
function readPrivateKey(home) {
  for (const file of term.keyCandidates(home)) {
    try {
      const buf = fs.readFileSync(file);
      if (!(ssh2().utils.parseKey(buf) instanceof Error)) return buf;
    } catch {}
  }
  return null;
}

// `say(kind, text)` surfaces notices in the terminal; kind is info | warn | error.
function buildConfig(target, say) {
  const t = term.parseTarget(target);
  const home = os.homedir();
  let knownHosts = '';
  try {
    knownHosts = fs.readFileSync(path.join(home, '.ssh', 'known_hosts'), 'utf8');
  } catch {}
  const config = {
    host: t.host,
    port: t.port,
    username: t.username || os.userInfo().username,
    readyTimeout: 15000,
    keepaliveInterval: 20000,
    hostVerifier: (key) => {
      const verdict = term.knownHostsVerdict(knownHosts, t.host, t.port, term.keyTypeOf(key), key.toString('base64'));
      if (verdict === 'mismatch') {
        say('error', `!! HOST KEY FOR ${t.host} HAS CHANGED (${term.fingerprint(key)}) — refusing to connect. Someone may be intercepting this connection; if the change is expected, fix ~/.ssh/known_hosts.`);
        return false;
      }
      if (verdict === 'unknown') say('warn', `host key ${term.fingerprint(key)} not verified: first use; phase 1 will ask`);
      return true;
    },
  };
  const agent = agentPath();
  if (agent) config.agent = agent;
  const privateKey = readPrivateKey(home);
  if (privateKey) config.privateKey = privateKey;
  return config;
}

// Opens a shell. Hooks: onData(Buffer), onStatus(kind, text), onClose().
// Returns { write, resize, end }.
function openSession(target, { cols, rows, onData, onStatus, onClose }) {
  const conn = new (ssh2().Client)();
  let stream = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols, rows }, { env: { COLORTERM: 'truecolor' } }, (err, s) => {
      if (err) {
        onStatus('error', `could not start a shell: ${err.message}`);
        conn.end();
        return;
      }
      stream = s;
      s.on('data', onData);
      s.stderr.on('data', onData);
      s.on('close', () => {
        conn.end();
        close();
      });
    });
  });
  conn.on('error', (err) => {
    const authFailed = /authentication/i.test(err.message);
    onStatus('error', authFailed ? 'authentication failed: no agent key or unencrypted ~/.ssh key was accepted' : `connection error: ${err.message}`);
    close();
  });
  conn.on('close', close);
  onStatus('info', `connecting to ${target}…`);
  conn.connect(buildConfig(target, onStatus));
  return {
    write: (data) => stream?.write(data),
    resize: (c, r) => stream?.setWindow(r, c, 0, 0),
    end: () => {
      closed = true;
      conn.end();
    },
  };
}

let termWin = null;

// opts.focusMain focuses the browser window (the Ctrl+Shift+Tab escape);
// opts.openUrl opens a clicked link as a tab there.
function openTerminalWindow(opts = {}) {
  if (termWin && !termWin.isDestroyed()) {
    if (termWin.isMinimized()) termWin.restore();
    termWin.show();
    termWin.focus();
    termWin.moveTop();
    return termWin;
  }
  const { BrowserWindow, ipcMain, clipboard } = require('electron');
  const w = new BrowserWindow({
    width: 1000,
    height: 640,
    title: 'WebForge Terminal (preview)',
    backgroundColor: '#0c0c0c',
    fullscreen: true, // the browser window is always fullscreen (#37); a smaller window would open behind it
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'terminal-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  termWin = w;
  w.setMenu(null);
  // Every key belongs to the shell: no menu accelerator (Ctrl+W, Ctrl+Shift+T …)
  // may fire from this window. The leader globalShortcut is already released —
  // main.js registers it on the browser window's focus and drops it on blur.
  w.webContents.setIgnoreMenuShortcuts(true);
  w.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && !input.alt && (input.key === 'Tab' || input.key.toLowerCase() === 't')) { // #208: Ctrl+Shift+T toggles back too
      event.preventDefault();
      // #210: hide, don't just focus the browser: both windows are fullscreen and
      // this one was moveTop()ed, so focusing the browser left it buried behind.
      // The session stays connected; opening the terminal again shows it.
      w.hide();
      opts.focusMain?.();
    }
  });

  let session = null; // null while disconnected
  let size = { cols: 80, rows: 24 };
  const send = (channel, payload) => {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  };
  const connect = () => {
    const mine = openSession(DEFAULT_TARGET, {
      ...size,
      onData: (buf) => send('terminal:data', buf),
      onStatus: (kind, text) => send('terminal:status', { kind, text }),
      onClose: () => {
        if (session !== mine) return;
        session = null;
        send('terminal:status', { kind: 'info', text: '[disconnected — press Enter to reconnect]' });
      },
    });
    session = mine;
  };

  const mine = (e) => !w.isDestroyed() && e.sender === w.webContents;
  const onStart = (e, cols, rows) => {
    if (!mine(e)) return;
    size = { cols, rows };
    if (!session) connect();
  };
  const onWrite = (e, data) => {
    if (!mine(e)) return;
    if (session) session.write(data);
    else if (/[\r\n]/.test(data)) connect();
  };
  const onResize = (e, cols, rows) => {
    if (!mine(e)) return;
    size = { cols, rows };
    session?.resize(cols, rows);
  };
  const onCopy = (e, data) => {
    if (!mine(e)) return;
    const text = term.osc52Text(data);
    if (text !== null) clipboard.writeText(text);
  };
  // A clicked link opens as a WebForge tab in this process: no second
  // WebForge.exe, no OS hand-off, none of #148's blank-page path.
  const onLink = (e, url) => {
    if (!mine(e) || !/^https?:\/\//i.test(String(url))) return;
    opts.openUrl?.(String(url));
  };
  ipcMain.on('terminal:link', onLink);
  ipcMain.on('terminal:start', onStart);
  ipcMain.on('terminal:write', onWrite);
  ipcMain.on('terminal:resize', onResize);
  ipcMain.on('terminal:copy', onCopy);

  w.once('ready-to-show', () => {
    w.show();
    w.focus();
    w.moveTop();
  });
  w.on('closed', () => {
    ipcMain.removeListener('terminal:start', onStart);
    ipcMain.removeListener('terminal:write', onWrite);
    ipcMain.removeListener('terminal:resize', onResize);
    ipcMain.removeListener('terminal:copy', onCopy);
    ipcMain.removeListener('terminal:link', onLink);
    session?.end();
    session = null;
    termWin = null;
  });
  w.loadFile(path.join(__dirname, 'ui', 'terminal.html')).catch(() => {});
  return w;
}

module.exports = { openTerminalWindow, openSession, buildConfig, DEFAULT_TARGET };
