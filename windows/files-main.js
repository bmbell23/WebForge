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
function noteShare(dir) {
  const before = savedShares();
  const after = files.rememberShare(before, dir);
  if (after === before || after.join('\n') === before.join('\n')) return;
  try {
    fs.writeFileSync(sharesFile(), JSON.stringify({ shares: after }, null, 2));
  } catch (err) {
    hooks.record?.('files-shares', err);
  }
}

/** The left rail: drives, the usual folders, and shares visited before. */
async function places() {
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
  let drives;
  if (process.platform === 'win32') {
    drives = await files.listDrives((root) => fs.promises.access(root).then(() => true, () => false));
  } else if (process.platform === 'darwin') {
    let vols = [];
    try {
      vols = fs.readdirSync('/Volumes').map((v) => `/Volumes/${v}`);
    } catch (_) {}
    drives = ['/', ...vols];
  } else {
    drives = ['/'];
  }
  return {
    home: get('home'),
    folders,
    drives: drives.map((d) => ({ label: d, path: d })),
    shares: savedShares().map((s) => ({ label: s, path: s })),
  };
}

async function entryFor(dir, dirent) {
  const full = P.join(dir, dirent.name);
  let st = null;
  try {
    st = await fs.promises.stat(full); // follows links and junctions
  } catch (_) {} // locked system files (pagefile.sys) can't be stat'd
  const isDir = st ? st.isDirectory() : dirent.isDirectory();
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
    const entries = files.sortEntries(await Promise.all(dirents.map((d) => entryFor(dir, d))), sort, order);
    if (files.shareRoot(dir)) noteShare(dir);
    return { ok: true, dir, parent: files.parentOf(dir, process.platform), entries, select };
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
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(PREVIEW_BYTES), 0, PREVIEW_BYTES, 0);
      await fh.close();
      const t = files.textPreview(buffer.subarray(0, bytesRead));
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
  ipcMain.handle('files:places', (e) => (ok(e) ? places() : null));
  ipcMain.handle('files:list', (e, a) => (ok(e) ? list(a?.dir, a?.sort, a?.order) : null));
  ipcMain.handle('files:preview', (e, p) => (ok(e) ? preview(p) : null));
  ipcMain.handle('files:open', (e, a) => (ok(e) ? open(a?.path, a?.how) : null));
  ipcMain.on('files:copy-path', (e, p) => {
    if (ok(e) && typeof p === 'string' && p) clipboard.writeText(p);
  });
}

module.exports = { installIpc, list, preview, places };
