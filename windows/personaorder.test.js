// #214 tests:  node windows/personaorder.test.js
const assert = require('assert');
const po = require('./personaorder');

let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

console.log('orderPersonas');
const stored = [
  { id: 'unassigned', name: 'Unassigned' },
  { id: 'p', name: 'Personal' },
  { id: 'f', name: 'Finance' },
  { id: 'w', name: 'Work' },
];
const ordered = po.orderPersonas(stored);
eq(ordered.map((p) => p.name),
  ['Terminal', 'Work Mattermost', 'Work', 'Mattermost', 'Personal', 'Teams', 'Outlook', 'Finance', 'Unassigned'],
  'key order, then your other Personas, then Unassigned');
eq(ordered.map((p) => p.key || ''), ['`', '!', '@', '#', '$', '%', '^', '', ''], 'Unassigned and Finance have no key');
eq(ordered.filter((p) => !p.slot && p.id !== 'terminal').map((p) => p.id), ['w', 'p', 'f', 'unassigned'], 'stored ids are unchanged');
eq(po.orderPersonas([...stored, { id: 'terminal', name: 'Imposter' }, { id: 'slot-teams', name: 'X' }]).length, 9, 'a stored "terminal" or slot id never doubles up');
eq(po.orderPersonas([]).map((p) => p.key), ['`', '!', '#', '%', '^'], 'no Work or Personal: their keys are free');
eq(po.orderPersonas([{ id: 'x', name: ' work ' }]).find((p) => p.key === '@').id, 'x', 'Work found by name, any case');
eq(stored.length, 4, 'input not mutated');

console.log('app slots');
eq(po.slots().map((s) => s.url), [
  'http://co-sf-pe-042.colorado.datadirectnet.com:8065/',
  'http://100.69.184.113:8065/',
  'https://teams.cloud.microsoft/',
  'https://outlook.cloud.microsoft/mail/',
], 'defaults');
const edited = po.slots({ 'work-mattermost': 'https://chat.example.com', teams: 'javascript:alert(1)', outlook: '  ' });
eq(edited[0].url, 'https://chat.example.com/', 'an edited URL wins');
eq(edited[2].url, 'https://teams.cloud.microsoft/', 'a non-http edit keeps the default');
eq(edited[3].url, 'https://outlook.cloud.microsoft/mail/', 'a blank edit keeps the default');
eq(po.orderPersonas(stored, edited)[1].url, 'https://chat.example.com/', 'the slot Persona opens the edited URL');
eq(po.isSlotId('slot-teams'), true, 'slot id');
eq(po.isSlotId('teams'), false, 'not a slot id');

console.log('leaderPick');
const k = (code, mods = {}) => ({ code, shift: true, control: false, alt: false, meta: false, ...mods });
eq(po.leaderPick(k('Backquote', { shift: false }), ordered), 'terminal', '` Terminal');
eq(po.leaderPick(k('Digit1'), ordered), 'slot-work-mattermost', '! Work Mattermost');
eq(po.leaderPick(k('Digit2'), ordered), 'w', '@ Work');
eq(po.leaderPick(k('Digit3'), ordered), 'slot-personal-mattermost', '# Mattermost');
eq(po.leaderPick(k('Digit4'), ordered), 'p', '$ Personal');
eq(po.leaderPick(k('Digit5'), ordered), 'slot-teams', '% Teams');
eq(po.leaderPick(k('Digit6'), ordered), 'slot-outlook', '^ Outlook');
eq(po.leaderPick(k('Digit7'), ordered), null, 'Shift+7 is free');
eq(po.leaderPick(k('Backquote'), ordered), null, '~ is not `');
eq(po.leaderPick(k('Digit1', { shift: false }), ordered), null, 'bare 1 is forge\'s, not a Persona key');
eq(po.leaderPick(k('Digit1', { control: true }), ordered), null, 'Ctrl+Shift+1 is not');
eq(po.leaderPick(k('Digit1', { alt: true }), ordered), null, 'Alt+Shift+1 is not');
eq(po.leaderPick(k('Numpad1'), ordered), null, 'numpad is not');
eq(po.leaderPick({ key: '!', shift: true }, ordered), null, 'matched on code, not key');

console.log('slotFor (#221)');
eq(po.slotFor('http://co-sf-pe-042.colorado.datadirectnet.com:8065/team/channels/town-square'), 'slot-work-mattermost', 'another Work Mattermost page');
eq(po.slotFor('http://100.69.184.113:8065/agents/pl/abc'), 'slot-personal-mattermost', 'another personal Mattermost page');
eq(po.slotFor('https://outlook.cloud.microsoft/calendar/view/week'), 'slot-outlook', 'the whole Outlook site, not just /mail/');
eq(po.slotFor('https://teams.cloud.microsoft/v2/?meetingjoin=true'), 'slot-teams', 'a Teams meeting link');
eq(po.slotFor('http://100.69.184.113:8005/'), null, 'same host, other port is not the slot');
eq(po.slotFor('https://co-sf-pe-042.colorado.datadirectnet.com:8065/'), null, 'other scheme is not the slot');
eq(po.slotFor('https://login.microsoftonline.com/x'), null, 'sign-in pages are nobody\'s');
eq(po.slotFor('not a url'), null, 'junk');
eq(po.slotFor('https://chat.example.com/x', po.slots({ 'work-mattermost': 'https://chat.example.com/' })), 'slot-work-mattermost', 'follows an edited slot URL');

console.log('openerHome (#219)');
eq(po.openerHome('w', ordered), 'w', 'a normal Persona keeps its popups');
eq(po.openerHome('slot-work-mattermost', ordered), 'w', 'Work Mattermost → Work');
eq(po.openerHome('slot-teams', ordered), 'w', 'Teams → Work');
eq(po.openerHome('slot-outlook', ordered), 'w', 'Outlook → Work');
eq(po.openerHome('slot-personal-mattermost', ordered), 'p', 'Mattermost → Personal');
eq(po.openerHome('terminal', ordered), 'unassigned', 'Terminal → Unassigned');
eq(po.openerHome('slot-teams', po.orderPersonas([])), 'unassigned', 'no Work Persona → Unassigned');
eq(po.openerHome(undefined, ordered), 'unassigned', 'unknown opener → Unassigned');

console.log(`personaorder: ${n} passed`);
