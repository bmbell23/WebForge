// Injected into every content tab (#16): captures single-key hotkeys
// vim/Gmail-style — ONLY when the page's focus is not in an editable element,
// and ONLY for keys that are actually bound (main pushes the bound-key list),
// so normal typing and unbound keys reach the page untouched. Bound keys are
// swallowed (preventDefault) before the page sees them.
const { ipcRenderer } = require('electron');

let bound = new Set();
ipcRenderer.on('hotkey-keys', (_e, keys) => {
  bound = new Set(Array.isArray(keys) ? keys : []);
});

const keyIdOf = (e) => (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + e.key;

window.addEventListener(
  'keydown',
  (e) => {
    if (e.repeat || e.metaKey) return;
    if (e.key.length !== 1) return; // printable characters only
    const t = e.target;
    const editable =
      t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
    if (editable) return;
    const id = keyIdOf(e);
    if (!bound.has(id)) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('webforge-key', id);
  },
  true
);
