// #214: the order Personas are shown and numbered in. Electron-free so it is
// tested (personaorder.test.js) and shared by the picker and the leader keys.
//
// Terminal is built in and Windows-only: it is never stored in personas.json,
// so the sync service and the phone never see it. Unassigned is the fallback,
// so it goes last (#71). Ids never change; only the display order does.
const TERMINAL = 'terminal';
const UNASSIGNED = 'unassigned';

const TERMINAL_PERSONA = Object.freeze({ id: TERMINAL, name: 'Terminal', builtin: true, terminal: true, rules: [] });

function orderPersonas(list) {
  const stored = (list || []).filter((p) => p.id !== TERMINAL);
  return [
    TERMINAL_PERSONA,
    ...stored.filter((p) => p.id !== UNASSIGNED),
    ...stored.filter((p) => p.id === UNASSIGNED),
  ];
}

// Ctrl+Space then Shift+digit picks a Persona by its number. Matched on the
// physical key (`code`), so `!@#$` live wherever the layout puts them.
// Returns the 1-based number, or 0 when the key is not a Persona key.
function personaDigit(input, max = 9) {
  if (!input || !input.shift || input.control || input.alt || input.meta) return 0;
  const m = /^Digit([1-9])$/.exec(input.code || '');
  const n = m ? Number(m[1]) : 0;
  return n && n <= max ? n : 0;
}

module.exports = { TERMINAL, UNASSIGNED, TERMINAL_PERSONA, orderPersonas, personaDigit };
