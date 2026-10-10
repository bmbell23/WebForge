// #322: the Files page's main-process side. Every disk read the page makes
// comes through these handlers, and they answer only the Files page itself
// (`isFilesSender`), never a website. PR 1 is read-only: list, preview, open.

const fs = require('fs');
const path = require('path');
const files = require('./files');
const { fileUrl } = require('./fileurl');

const P = process.platform === 'win32' ? path.win32 : path.posix;
const PREVIEW_BYTES = 64 * 1024;

let hooks = {};

function sharesFile() {
  return path.join(require('electron').app.getPath('userData'), 'files.json');
}
function savedShares() {
  try {
    const s = JSON.parse(fs.readFileSync(sharesFile(), 'utf8')).shares;
    return Array.isArray(s) ? s.filter((x) => typeof x === 'string') : [];
  } catch (_) {
    return [];
  }
}
/** True when `dir`'s share is new to the rail. */
function noteShare(dir) {
  const before = savedShares();
  const after = files.rememberShare(before, dir);
  if (after === before || after.join('\n') === before.join('\n')) return false;
  const isNew = !before.some((s) => s.toLowerCase() === after[0].toLowerCase());
  try {
    fs.writeFileSync(sharesFile(), JSON.stringify({ shares: after }, null, 2));
  } catch (err) {
    hooks.record?.('files-shares', err);
  }
  return isNew;
}

// A dead mapped drive blocks a thread-pool worker for as long as Windows takes
// to give up, whatever our timeout says, so drives are probed once and again
// only on an explicit Refresh.
let drivesCache = null;
async function drives(fresh) {
  if (drivesCache && !fresh) return drivesCache;
  if (process.platform === 'win32') {
    drivesCache = await files.listDrives((root) => fs.promises.access(root).then(() => true, () => false));
  } else if (process.platform === 'darwin') {
    let vols = [];
    try {
      vols = fs.readdirSync('/Volumes').map((v) => `/Volumes/${v}`);
    } catch (_) {}
    drivesCache = ['/', ...vols];
  } else {
    drivesCache = ['/'];
  }
  return drivesCache;
}

/** `fn` over `items`, at most `n` at a time (a big share must not flood the thread pool). */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** The left rail: drives, the usual folders, and shares visited before. */
async function places(fresh) {
  const { app } = require('electron');
  const get = (name) => {
    try {
      return app.getPath(name);
    } catch (_) {
      return null;
    }
  };
  const folders = [
    ['Home', get('home')],
    ['Desktop', get('desktop')],
    ['Documents', get('documents')],
    ['Downloads', get('downloads')],
    ['Pictures', get('pictures')],
    ['Music', get('music')],
    ['Videos', get('videos')],
  ]
    .filter(([, p]) => p)
    .map(([label, p]) => ({ label, path: p }));
  return {
    home: get('home'),
    folders,
    drives: (await drives(fresh)).map((d) => ({ label: d, path: d })),
    shares: savedShares().map((s) => ({ label: s, path: s })),
  };
}

async function entryFor(dir, dirent) {
  const full = P.join(dir, dirent.name);
  let st = null;
  try {
    st = await fs.promises.stat(full); // follows links and junctions
  } catch (_) {} // locked system files (pagefile.sys) can't be stat'd
  // A junction we may not read (C:\Documents and Settings) fails stat; it is
  // still a folder, and opening it reports access denied.
  const isDir = st ? st.isDirectory() : dirent.isDirectory() || dirent.isSymbolicLink();
  const e = {
    name: dirent.name,
    path: full,
    dir: isDir,
    size: isDir || !st ? null : st.size,
    mtime: st ? st.mtimeMs : null,
    hidden: files.isHidden(dirent.name),
  };
  e.type = files.typeLabel(e);
  e.sizeLabel = files.formatSize(e.size);
  e.kind = isDir ? 'folder' : files.kindOf(e.name);
  return e;
}

/**
 * A folder's contents, sorted. Given a FILE, lists its folder with that file
 * selected, which is what a `?path=` deep link to a file means.
 */
async function list(target, sort, order) {
  const typed = files.normalizeInput(target, process.platform, require('electron').app.getPath('home'));
  if (!typed) return { ok: false, error: 'No path given.' };
  let dir = P.resolve(typed);
  let select = null;
  try {
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) {
      select = P.basename(dir);
      dir = P.dirname(dir);
    }
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const entries = files.sortEntries(await mapLimit(dirents, 16, (d) => entryFor(dir, d)), sort, order);
    const newShare = files.shareRoot(dir) ? noteShare(dir) : false;
    return { ok: true, dir, parent: files.parentOf(dir, process.platform), entries, select, newShare };
  } catch (err) {
    return { ok: false, dir, parent: files.parentOf(dir, process.platform), error: err.message || String(err) };
  }
}

/** What the preview pane shows for one item. */
async function preview(p) {
  if (typeof p !== 'string' || !p) return null;
  let st;
  try {
    st = await fs.promises.stat(p);
  } catch (err) {
    return { kind: 'error', error: err.message };
  }
  const base = { name: P.basename(p), size: files.formatSize(st.isDirectory() ? null : st.size), mtime: st.mtimeMs };
  if (st.isDirectory()) return { ...base, kind: 'folder' };
  const kind = files.kindOf(p);
  if (kind === 'image' || kind === 'video' || kind === 'audio') return { ...base, kind, url: fileUrl(p) };
  if (kind === 'text' || kind === 'page') {
    try {
      const fh = await fs.promises.open(p, 'r');
      let read;
      try {
        read = await fh.read(Buffer.alloc(PREVIEW_BYTES), 0, PREVIEW_BYTES, 0);
      } finally {
        await fh.close();
      }
      const t = files.textPreview(read.buffer.subarray(0, read.bytesRead));
      if (t) return { ...base, kind: 'text', text: t.text, more: t.more || st.size > PREVIEW_BYTES };
    } catch (err) {
      return { ...base, kind: 'info', error: err.message };
    }
  }
  return { ...base, kind: 'info', type: files.typeLabel({ name: base.name }) };
}

/** Open a file: in a WebForge tab when Chromium can show it, else the system app. */
async function open(p, how) {
  if (typeof p !== 'string' || !p) return { ok: false };
  const { shell } = require('electron');
  if (how !== 'system' && files.opensInApp(p)) {
    hooks.openInApp?.(fileUrl(p));
    return { ok: true, where: 'tab' };
  }
  const err = await shell.openPath(p); // '' on success
  return err ? { ok: false, error: err } : { ok: true, where: 'system' };
}

let installed = false;
function installIpc(h) {
  hooks = h || {};
  if (installed) return; // ipcMain.handle throws on a second registration
  installed = true;
  const { ipcMain, clipboard } = require('electron');
  const ok = (e) => Boolean(hooks.isFilesSender?.(e));
  ipcMain.handle('files:places', (e, fresh) => (ok(e) ? places(Boolean(fresh)) : null));
  ipcMain.handle('files:list', (e, a) => (ok(e) ? list(a?.dir, a?.sort, a?.order) : null));
  ipcMain.handle('files:preview', (e, p) => (ok(e) ? preview(p) : null));
  ipcMain.handle('files:open', (e, a) => (ok(e) ? open(a?.path, a?.how) : null));
  ipcMain.on('files:copy-path', (e, p) => {
    if (ok(e) && typeof p === 'string' && p) clipboard.writeText(p);
  });
}

module.exports = { installIpc, list, preview, places };
