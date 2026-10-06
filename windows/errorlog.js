// #75: the Windows app has been failing silently. `process.on('uncaughtException')`
// only console.error'd, which goes nowhere in a packaged build — so a thrown
// error inside an IPC handler looked exactly like "the button does nothing".
// Persist errors and show them in Settings.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'errors.log');
const MAX = 40_000; // keep the tail; this is a diagnostic aid, not an archive

// #171: main hands us the server shipper once it exists; until then entries
// only go to the local file.
let ship = null;
function onRecord(fn) {
  ship = fn;
}

// #216: this used to read and rewrite the whole file synchronously on every
// record, and the repaint diagnostics recorded on every tab switch. Now the
// tail lives in memory and reaches disk on a short timer, off the main thread.
let tail = null; // the file's contents, loaded once
let writeTimer = null;
let dirty = false; // memory is ahead of disk
let writing = Promise.resolve(); // writes queue, so an older one can't land last
const FLUSH_MS = 1000;
function load() {
  if (tail !== null) return;
  try {
    tail = fs.readFileSync(file(), 'utf8');
  } catch {
    tail = '';
  }
}
function flushSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writing = writing
      .then(() => {
        if (!dirty) return undefined;
        dirty = false;
        return fs.promises.writeFile(file(), tail);
      })
      .catch(() => {});
  }, FLUSH_MS);
}
/** Write now, synchronously — for quit, when no timer will get to run. */
// Also covers an async write still in flight: it may have truncated the file,
// so a sync write of the whole tail is the safe end state.
function flush() {
  clearTimeout(writeTimer);
  writeTimer = null;
  if (tail === null) return;
  dirty = false;
  try {
    fs.writeFileSync(file(), tail);
  } catch {}
}

function record(where, err) {
  const stamp = new Date().toISOString();
  const body = err && err.stack ? err.stack : String(err);
  const entry = `\n[${stamp}] ${where}\n${body}\n`;
  try {
    load();
    tail = (tail + entry).slice(-MAX);
    dirty = true;
    flushSoon();
  } catch {
    // never let logging throw
  }
  try {
    if (ship) ship({ at: stamp, where, body });
  } catch {
    // nor let shipping throw
  }
  try {
    console.error(where, err);
  } catch {}
}

/** Run fn, logging (not swallowing silently) anything it throws. */
function guard(where, fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      record(where, err);
      return undefined;
    }
  };
}

function read() {
  load();
  return tail;
}

function clear() {
  clearTimeout(writeTimer);
  writeTimer = null;
  tail = '';
  dirty = false;
  try {
    fs.rmSync(file(), { force: true });
  } catch {}
}

module.exports = { record, guard, read, clear, onRecord, flush };
