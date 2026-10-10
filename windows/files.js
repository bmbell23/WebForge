// #322: the Files page's rules: what kind a file is, where it opens, how the
// list sorts, and how a typed path is cleaned up. Electron-free, so all of it
// is unit-tested on this Linux build host (files.test.js); main.js does the
// actual disk reads.

const path = require('path');

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
const VIDEO = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv'];
const AUDIO = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'];
// Brandon (2026-10-10): these open in WebForge's own text editor (PR 2); until
// then, as a plain-text tab. "And similar" = config and code he edits by hand.
const TEXT = [
  'txt', 'md', 'markdown', 'yaml', 'yml', 'json', 'jsonc', 'conf', 'cfg', 'ini', 'log', 'env',
  'sh', 'bash', 'zsh', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'ps1', 'psm1', 'psd1',
  'bat', 'cmd', 'toml', 'xml', 'csv', 'tsv', 'css', 'sql', 'properties', 'gitignore',
  'dockerignore', 'editorconfig', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'rb', 'php', 'lua', 'service', 'timer', 'rules', 'reg',
];
const TEXT_NAMES = ['dockerfile', 'makefile', 'readme', 'license', 'changelog', 'vagrantfile', 'procfile'];
const PAGE = ['html', 'htm'];

// Windows hides these by attribute, which Node can't read; dotfiles are the
// Unix convention. Both are shown, just dimmed (Brandon: hidden always shown).
const HIDDEN_NAMES = [
  'desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information', 'pagefile.sys',
  'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'recovery', '$windows.~bt', '$winreagent',
  'config.msi', 'documents and settings', 'programdata', 'appdata', 'ntuser.dat',
];

/** Lower-case extension without the dot; '' for none. `.bashrc` has none. */
function extOf(name) {
  const n = String(name || '');
  const dot = n.lastIndexOf('.');
  return dot > 0 ? n.slice(dot + 1).toLowerCase() : '';
}

/** image | video | audio | pdf | text | page | other. */
function kindOf(name) {
  const ext = extOf(name);
  if (IMAGE.includes(ext)) return 'image';
  if (VIDEO.includes(ext)) return 'video';
  if (AUDIO.includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (PAGE.includes(ext)) return 'page';
  if (TEXT.includes(ext)) return 'text';
  const lower = String(name || '').toLowerCase();
  if (!ext && (TEXT_NAMES.includes(lower) || lower.startsWith('.'))) return 'text';
  return 'other';
}

/** Opens as a WebForge tab (Chromium renders it), or in the system's own app. */
function opensInApp(name) {
  return kindOf(name) !== 'other';
}

function isHidden(name) {
  const n = String(name || '').toLowerCase();
  return n.startsWith('.') || n.startsWith('ntuser.dat') || HIDDEN_NAMES.includes(n);
}

const KIND_WORD = { image: 'image', video: 'video', audio: 'audio', pdf: 'document', page: 'web page', text: 'file' };

/** The Type column, Explorer-style: "File folder", "PNG image", "YAML file". */
function typeLabel(entry) {
  if (entry.dir) return 'File folder';
  const ext = extOf(entry.name);
  if (!ext) return 'File';
  return `${ext.toUpperCase()} ${KIND_WORD[kindOf(entry.name)] || 'file'}`;
}

/** The Size column: blank for folders and unknowns, otherwise B/KB/MB/GB/TB. */
function formatSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Folders first, always; then by `key` (name | modified | type | size) in
 * `dir` (asc | desc), ties by name. Unknown sizes/dates sort as smallest.
 */
function sortEntries(list, key = 'name', dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : -Infinity);
  const cmp = {
    name: byName,
    modified: (a, b) => num(a.mtime) - num(b.mtime) || byName(a, b),
    size: (a, b) => num(a.size) - num(b.size) || byName(a, b),
    type: (a, b) => typeLabel(a).localeCompare(typeLabel(b)) || byName(a, b),
  }[key] || byName;
  return [...list].sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : sign * cmp(a, b)));
}

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** `\\server\share` for any path inside a share, else null. */
function shareRoot(p) {
  const m = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/.exec(String(p || ''));
  return m ? `\\\\${m[1]}\\${m[2]}` : null;
}

/** The folder above `p`, or null at a drive, share or filesystem root. */
function parentOf(p, platform) {
  const P = pathFor(platform);
  const s = String(p || '');
  if (!s) return null;
  const share = platform === 'win32' && shareRoot(s);
  if (share && share.toLowerCase() === s.replace(/[\\/]+$/, '').toLowerCase()) return null;
  const up = P.dirname(s);
  return up === s || P.resolve(up) === P.resolve(s) ? null : up;
}

/**
 * A path as typed into the path box: quotes and spaces trimmed, `C:` becomes
 * `C:\`, forward slashes become backslashes on Windows, and `~` is home.
 * Returns '' when there's nothing usable.
 */
function normalizeInput(typed, platform, home) {
  let s = String(typed || '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!s) return '';
  if (home && (s === '~' || s.startsWith('~/') || s.startsWith('~\\'))) s = home + s.slice(1);
  if (platform !== 'win32') return s.length > 1 ? s.replace(/\/+$/, '') : s;
  s = s.replace(/\//g, '\\');
  if (/^[a-z]:$/i.test(s)) return `${s.toUpperCase()}\\`;
  if (/^[a-z]:\\/i.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.startsWith('\\\\')) return `\\\\${s.slice(2).replace(/\\+/g, '\\').replace(/\\$/, '')}`;
  return /^[A-Z]:\\$/.test(s) ? s : s.replace(/\\+$/, '');
}

/** Every Windows drive root that answers, mapped network drives included. */
async function listDrives(exists, timeoutMs = 1500) {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
  const probe = (root) =>
    Promise.race([
      Promise.resolve().then(() => exists(root)).catch(() => false),
      // A disconnected network drive can block for many seconds.
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  const roots = letters.map((l) => `${l}:\\`);
  const ok = await Promise.all(roots.map(probe));
  return roots.filter((_, i) => ok[i]);
}

/** Remember a share for the left rail: most recent first, no duplicates, capped. */
function rememberShare(list, p, max = 10) {
  const root = shareRoot(p);
  if (!root) return list;
  const rest = (list || []).filter((s) => s.toLowerCase() !== root.toLowerCase());
  return [root, ...rest].slice(0, max);
}

/**
 * First `maxLines` lines of a text buffer, or null when it looks binary.
 * UTF-16 with a BOM (regedit exports, PowerShell `>` output) is text too.
 */
function textPreview(buf, maxLines = 200) {
  if (!buf) return null;
  let str;
  if (buf[0] === 0xff && buf[1] === 0xfe) str = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) str = Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  else if (buf.includes(0)) return null;
  else str = buf.toString('utf8').replace(/^\uFEFF/, '');
  const lines = str.split(/\r?\n/);
  return { text: lines.slice(0, maxLines).join('\n'), more: lines.length > maxLines };
}

/** `reg query HKCU\Network /s` → every mapped drive, connected or not: [{ letter, remote }]. */
function parseMappedDrives(stdout) {
  const out = [];
  let letter = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const key = /^HKEY_CURRENT_USER\\Network\\([A-Za-z])\s*$/i.exec(line.trim());
    if (key) {
      letter = key[1].toUpperCase();
      continue;
    }
    const val = /^RemotePath\s+REG_\w+\s+(.+)$/i.exec(line.trim());
    if (val && letter) {
      out.push({ letter, remote: val[1].trim() });
      letter = null;
    }
  }
  return out;
}

/** Win32_LogicalDisk as JSON (one object or an array) → { 'C': { volume, remote } }. */
function parseLogicalDisks(json) {
  let list;
  try {
    list = JSON.parse(String(json || '').trim() || '[]');
  } catch (_) {
    return {};
  }
  const out = {};
  for (const d of Array.isArray(list) ? list : [list]) {
    const m = /^([A-Za-z]):/.exec((d && d.DeviceID) || '');
    if (m) out[m[1].toUpperCase()] = { volume: d.VolumeName || '', remote: d.ProviderName || '' };
  }
  return out;
}

/** Explorer's names: "OS (C:)", "Local Disk (D:)", "brighton (\\10.0.0.197) (B:)". */
function driveLabel(letter, info = {}) {
  const share = /^\\\\([^\\]+)\\(.+?)\\?$/.exec(info.remote || '');
  if (share) return `${share[2].split('\\').pop()} (\\\\${share[1]}) (${letter}:)`;
  return `${info.volume || 'Local Disk'} (${letter}:)`;
}

/**
 * The Drives section: every drive that answered plus every mapped drive that
 * didn't, in letter order. A disconnected one browses its UNC path instead,
 * which Windows reconnects when it can.
 */
function buildDrives(answering, mapped, disks = {}) {
  const up = new Set((answering || []).map((r) => r[0].toUpperCase()));
  const remoteOf = {};
  for (const m of mapped || []) remoteOf[m.letter] = m.remote;
  const letters = [...new Set([...up, ...Object.keys(remoteOf)])].sort();
  return letters.map((l) => {
    const remote = remoteOf[l] || (disks[l] && disks[l].remote) || '';
    const offline = !up.has(l);
    return {
      label: driveLabel(l, { volume: disks[l] && disks[l].volume, remote }),
      path: offline && remote ? remote : `${l}:\\`,
      offline,
    };
  });
}

module.exports = {
  parseMappedDrives,
  parseLogicalDisks,
  driveLabel,
  buildDrives,
  extOf,
  kindOf,
  opensInApp,
  isHidden,
  typeLabel,
  formatSize,
  sortEntries,
  shareRoot,
  parentOf,
  normalizeInput,
  listDrives,
  rememberShare,
  textPreview,
};
