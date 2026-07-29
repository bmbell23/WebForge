// #75: the Windows app has been failing silently. `process.on('uncaughtException')`
// only console.error'd, which goes nowhere in a packaged build — so a thrown
// error inside an IPC handler looked exactly like "the button does nothing".
// Persist errors and show them in Settings.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'errors.log');
const MAX = 40_000; // keep the tail; this is a diagnostic aid, not an archive

function record(where, err) {
  const stamp = new Date().toISOString();
  const body = err && err.stack ? err.stack : String(err);
  const entry = `\n[${stamp}] ${where}\n${body}\n`;
  try {
    let existing = '';
    try {
      existing = fs.readFileSync(file(), 'utf8');
    } catch {}
    const combined = (existing + entry).slice(-MAX);
    fs.writeFileSync(file(), combined);
  } catch {
    // never let logging throw
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
  try {
    return fs.readFileSync(file(), 'utf8');
  } catch {
    return '';
  }
}

function clear() {
  try {
    fs.rmSync(file(), { force: true });
  } catch {}
}

module.exports = { record, guard, read, clear };
