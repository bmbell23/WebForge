// #206/#214: the terminal's main-process half — ssh2 connections, one per
// terminal tab, and the Terminal Persona's saved hosts. #214 retired the
// separate window: a terminal session is a tab (a WebContentsView on
// ui/terminal.html) in the Terminal Persona, and main.js owns the tab.
// electron is required lazily so openSession/buildConfig run under plain node
// (the smoke test does exactly that).
const fs = require('fs');
const os = require('os');
const path = require('path');
// Loaded on first use, so a packaging problem with ssh2 can only break the terminal, never startup.
const ssh2 = () => require('ssh2');
const term = require('./terminal');
const termhosts = require('./termhosts');

const DEFAULT_TARGET = 'brandon@dockerhost';

function agentPath() {
  return process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : null);
}

function readKey(file) {
  try {
    const buf = fs.readFileSync(file);
    return ssh2().utils.parseKey(buf) instanceof Error ? null : buf;
  } catch {
    return null;
  }
}

// The config's IdentityFile first, then the first readable key in ~/.ssh that
// is not passphrase-protected.
function readPrivateKey(home, identityFile) {
  if (identityFile) {
    const k = readKey(identityFile.replace(/^~(?=[\\/])/, home));
    if (k) return k;
  }
  for (const file of term.keyCandidates(home)) {
    const k = readKey(file);
    if (k) return k;
  }
  return null;
}

function sshConfigText(home = os.homedir()) {
  try {
    return fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8');
  } catch {
    return '';
  }
}

// `say(kind, text)` surfaces notices in the terminal; kind is info | warn | error.
// `ask(question, cb)` asks a y/N question in the terminal (#214's host-key prompt).
function buildConfig(target, say, ask = (_q, cb) => cb(false)) {
  const home = os.homedir();
  const t = term.parseTarget(target);
  // #214: a ~/.ssh/config alias resolves the way OpenSSH would resolve it.
  const r = termhosts.resolveHost(termhosts.parseSshConfig(sshConfigText(home)), t.host);
  const host = r.host;
  const port = t.port !== 22 ? t.port : r.port || 22;
  const knownHostsFile = path.join(home, '.ssh', 'known_hosts');
  let knownHosts = '';
  try {
    knownHosts = fs.readFileSync(knownHostsFile, 'utf8');
  } catch {}
  const config = {
    host,
    port,
    username: t.username || r.username || os.userInfo().username,
    readyTimeout: 90000, // #214: long enough to answer the host-key question
    keepaliveInterval: 20000,
    hostVerifier: (key, verify) => {
      const verdict = term.knownHostsVerdict(knownHosts, host, port, term.keyTypeOf(key), key.toString('base64'));
      if (verdict === 'match') return verify(true);
      if (verdict === 'mismatch') {
        say('error', `!! HOST KEY FOR ${host} HAS CHANGED (${term.fingerprint(key)}) — refusing to connect. Someone may be intercepting this connection; if the change is expected, fix ~/.ssh/known_hosts.`);
        return verify(false);
      }
      // #214: unknown host — ask once; yes saves it, so it never asks again.
      ask(`${host}${port === 22 ? '' : `:${port}`} is not a known host. Its ${term.keyTypeOf(key)} key is ${term.fingerprint(key)}.\r\nTrust it and save it to ~/.ssh/known_hosts? [y/N] `, (yes) => {
        if (yes) {
          try {
            fs.mkdirSync(path.dirname(knownHostsFile), { recursive: true });
            const sep = knownHosts && !knownHosts.endsWith('\n') ? '\n' : '';
            fs.appendFileSync(knownHostsFile, `${sep}${term.knownHostsLine(host, port, key)}\n`);
            knownHosts += `${sep}${term.knownHostsLine(host, port, key)}\n`;
          } catch (err) {
            say('warn', `trusted for this session only: could not write known_hosts (${err.message})`);
          }
        }
        verify(Boolean(yes));
      });
      return undefined;
    },
  };
  const agent = agentPath();
  if (agent) config.agent = agent;
  const privateKey = readPrivateKey(home, r.identityFile);
  if (privateKey) config.privateKey = privateKey;
  return config;
}

// Opens a shell. Hooks: onData(Buffer), onStatus(kind, text), onClose(),
// onReady(), ask(question, cb). Returns { write, resize, end }.
function openSession(target, { cols, rows, onData, onStatus, onClose, onReady = () => {}, ask }) {
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
      onReady();
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
  try {
    conn.connect(buildConfig(target, onStatus, ask));
  } catch (err) {
    onStatus('error', `connection error: ${err.message}`);
    close();
  }
  return {
    write: (data) => stream?.write(data),
    resize: (c, r) => stream?.setWindow(r, c, 0, 0),
    end: () => {
      closed = true;
      conn.end();
    },
  };
}

// --- #214: saved hosts (Favorites + use counts) -----------------------------
let hostsCache = null;
function hostsFile() {
  return path.join(require('electron').app.getPath('userData'), 'terminal-hosts.json');
}
function loadHosts() {
  if (!hostsCache) {
    try {
      hostsCache = JSON.parse(fs.readFileSync(hostsFile(), 'utf8'));
    } catch {
      hostsCache = { favorites: [DEFAULT_TARGET], uses: {} }; // forge is one click away on day one
    }
    if (!Array.isArray(hostsCache.favorites)) hostsCache.favorites = [];
    if (!hostsCache.uses || typeof hostsCache.uses !== 'object') hostsCache.uses = {};
  }
  return hostsCache;
}
function saveHosts() {
  try {
    fs.writeFileSync(hostsFile(), JSON.stringify(hostsCache));
  } catch {}
}
function connections() {
  const h = loadHosts();
  const cfg = termhosts.configHosts(termhosts.parseSshConfig(sshConfigText()));
  return termhosts.connectionGroups({ favorites: h.favorites, uses: h.uses, configHosts: cfg });
}
function toggleFavorite(target) {
  const t = String(target || '').trim();
  if (!t) return;
  const h = loadHosts();
  h.favorites = h.favorites.includes(t) ? h.favorites.filter((f) => f !== t) : [...h.favorites, t];
  saveHosts();
}
function recordUse(target) {
  const h = loadHosts();
  h.uses[target] = (h.uses[target] || 0) + 1;
  saveHosts();
}

// --- #214: one session per terminal tab ------------------------------------
// webContents id -> { wc, target, session, size, hold, prefix, answer }
//   hold    Ctrl+Space pressed; the next key decides (see term.holdDecision)
//   prefix  the next write from the page goes out behind Ctrl+Space
//   answer  a pending y/N question; the next key answers it
const tabs = new Map();
let hooks = {};

function stateFor(e) {
  return tabs.get(e.sender.id) || null;
}

function send(st, channel, payload) {
  if (!st.wc.isDestroyed()) st.wc.send(channel, payload);
}

function connect(st) {
  if (!st.target) return;
  const mine = openSession(st.target, {
    ...st.size,
    onData: (buf) => send(st, 'terminal:data', buf),
    onStatus: (kind, text) => send(st, 'terminal:status', { kind, text }),
    onReady: () => {
      recordUse(st.target);
      hooks.onConnectionsChanged?.();
    },
    ask: (question, cb) => {
      send(st, 'terminal:prompt', question);
      st.answer = cb;
    },
    onClose: () => {
      if (st.session !== mine) return;
      st.session = null;
      st.answer = null;
      send(st, 'terminal:status', { kind: 'info', text: '[disconnected — press Enter to reconnect]' });
    },
  });
  st.session = mine;
}

// Called by main.js for every terminal tab it creates.
function attach(wc) {
  const st = { wc, target: null, session: null, size: { cols: 80, rows: 24 }, hold: false, prefix: false, answer: null };
  tabs.set(wc.id, st);
  // Every key belongs to the shell: no menu accelerator (Ctrl+W, Ctrl+T …) may
  // fire from a terminal tab. main.js's before-input-event still sees them.
  wc.setIgnoreMenuShortcuts(true);
  wc.once('destroyed', () => {
    tabs.delete(st.wc.id);
    st.session?.end();
    st.session = null;
  });
}

const isTerminal = (wc) => Boolean(wc && tabs.has(wc.id));
const holding = (wc) => Boolean(wc && tabs.get(wc.id)?.hold);

function setHold(wc, on) {
  const st = wc && tabs.get(wc.id);
  if (st) st.hold = on;
}

// The held key is not a Persona key: it goes to the session behind the prefix.
function passHeldKey(wc) {
  const st = wc && tabs.get(wc.id);
  if (!st) return;
  st.hold = false;
  st.prefix = true;
}

// Ctrl+Space twice: pass both on; forge turns them into one literal Ctrl+Space.
function passDoublePrefix(wc) {
  const st = wc && tabs.get(wc.id);
  if (!st) return;
  st.hold = false;
  st.prefix = false;
  st.session?.write(term.CTRL_SPACE + term.CTRL_SPACE);
}

let installed = false;
function installIpc(h) {
  hooks = h || {};
  if (installed) return; // ipcMain.handle throws on a second registration
  installed = true;
  const { ipcMain, clipboard } = require('electron');
  ipcMain.on('terminal:start', (e, cols, rows, target) => {
    const st = stateFor(e);
    if (!st) return;
    st.size = { cols, rows };
    if (!st.target && typeof target === 'string' && target.trim()) {
      st.target = target.trim();
      st.prefix = false; // a Ctrl+Space pressed on the picker is not meant for the shell
    }
    if (st.target && !st.session) connect(st);
  });
  ipcMain.on('terminal:write', (e, data) => {
    const st = stateFor(e);
    if (!st) return;
    if (st.answer) {
      const yes = /^[yY]/.test(data);
      const cb = st.answer;
      st.answer = null;
      send(st, 'terminal:status', { kind: yes ? 'info' : 'warn', text: yes ? 'trusted' : 'not trusted — disconnecting' });
      cb(yes);
      return;
    }
    if (st.prefix) {
      st.prefix = false;
      data = term.CTRL_SPACE + data;
    }
    if (st.session) st.session.write(data);
    else if (/[\r\n]/.test(data)) connect(st);
  });
  ipcMain.on('terminal:resize', (e, cols, rows) => {
    const st = stateFor(e);
    if (!st) return;
    st.size = { cols, rows };
    st.session?.resize(cols, rows);
  });
  ipcMain.on('terminal:copy', (e, data) => {
    if (!stateFor(e)) return;
    const text = term.osc52Text(data);
    if (text !== null) clipboard.writeText(text);
  });
  // A clicked link opens as a WebForge tab in this process: no second
  // WebForge.exe, no OS hand-off, none of #148's blank-page path.
  ipcMain.on('terminal:link', (e, url) => {
    if (!stateFor(e) || !/^https?:\/\//i.test(String(url))) return;
    hooks.openUrl?.(String(url));
  });
  // #212: paste and copy-selection go through main.
  ipcMain.on('terminal:paste', (e) => {
    const st = stateFor(e);
    if (st) send(st, 'terminal:paste-text', clipboard.readText());
  });
  ipcMain.on('terminal:copy-text', (e, text) => {
    if (stateFor(e) && typeof text === 'string' && text) clipboard.writeText(text);
  });
  // #214: the new-tab picker reads the same groups as the connections panel.
  ipcMain.handle('terminal:connections', (e) => (stateFor(e) ? connections() : null));
  ipcMain.on('terminal:favorite', (e, target) => {
    if (!stateFor(e)) return;
    toggleFavorite(target);
    hooks.onConnectionsChanged?.();
  });
}

module.exports = {
  openSession, buildConfig, DEFAULT_TARGET,
  attach, installIpc, isTerminal, holding, setHold, passHeldKey, passDoublePrefix,
  connections, toggleFavorite,
};
