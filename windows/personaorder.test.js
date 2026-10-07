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
  ['Terminal', 'Work Mattermost', 'Work', 'Mattermost', 'Personal', 'Teams', 'Outlook', 'Discord', 'Slack', 'Finance', 'Unassigned'],
  'key order, then your other Personas, then Unassigned');
eq(ordered.map((p) => p.key || ''), ['`', '!', '@', '#', '$', '%', '^', '&', '*', '(', ''], '#307: Slack and Finance get * and (; Unassigned (11th) has no key');
eq(ordered.filter((p) => !p.slot && p.id !== 'terminal').map((p) => p.id), ['w', 'p', 'f', 'unassigned'], 'stored ids are unchanged');
eq(po.orderPersonas([...stored, { id: 'terminal', name: 'Imposter' }, { id: 'slot-teams', name: 'X' }]).length, 11, 'a stored "terminal" or slot id never doubles up');
eq(po.orderPersonas([]).map((p) => p.key), ['`', '!', '@', '#', '$', '%', '^'], '#297: no Work or Personal: the keys close up, they follow the position');
eq(po.orderPersonas([{ id: 'x', name: ' work ' }]).find((p) => p.key === '@').id, 'x', 'Work found by name, any case');
eq(stored.length, 4, 'input not mutated');

console.log('app slots');
eq(po.slots().map((s) => s.url), [
  'http://co-sf-pe-042.colorado.datadirectnet.com:8065/',
  'http://100.69.184.113:8065/',
  'https://teams.cloud.microsoft/',
  'https://outlook.cloud.microsoft/mail/',
  'https://discord.com/channels/276238974421434368/276238974421434368',
  'https://app.slack.com/client',
], 'defaults (#301: Slack too)');
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
eq(po.leaderPick(k('Digit7'), ordered), 'slot-discord', '& Discord (#282)');
eq(po.leaderPick(k('Digit8'), ordered), 'slot-slack', '#307: * is the 9th (Slack)');
eq(po.leaderPick(k('Digit0'), ordered), null, 'Shift+0 is free');
eq(po.leaderPick(k('Backquote'), ordered), null, '~ is not `');
eq(po.leaderPick(k('Digit1', { shift: false }), ordered), null, 'bare 1 is forge\'s, not a Persona key');
eq(po.leaderPick(k('Digit1', { control: true }), ordered), null, 'Ctrl+Shift+1 is not');
eq(po.leaderPick(k('Digit1', { alt: true }), ordered), null, 'Alt+Shift+1 is not');
eq(po.leaderPick(k('Numpad1'), ordered), null, 'numpad is not');
eq(po.leaderPick({ key: '!', shift: true }, ordered), null, 'matched on code, not key');

console.log('directPick (#224)');
const c = (code, mods = {}) => ({ code, control: true, shift: false, alt: false, meta: false, ...mods });
eq(po.directPick(c('Backquote'), ordered), 'terminal', 'Ctrl+` Terminal');
eq(po.directPick(c('Backquote', { shift: true }), ordered), 'terminal', 'Ctrl+~ Terminal');
eq(po.directPick(c('Digit1'), ordered), 'slot-work-mattermost', 'Ctrl+1 Work Mattermost');
eq(po.directPick(c('Digit2'), ordered), 'w', 'Ctrl+2 Work');
eq(po.directPick(c('Digit3'), ordered), 'slot-personal-mattermost', 'Ctrl+3 Mattermost');
eq(po.directPick(c('Digit4'), () => ordered), 'p', 'Ctrl+4 Personal (list built lazily)');
eq(po.directPick(c('Digit5'), ordered), 'slot-teams', 'Ctrl+5 Teams');
eq(po.directPick(c('Digit6'), ordered), 'slot-outlook', 'Ctrl+6 Outlook');
eq(po.directPick(c('Digit7'), ordered), 'slot-discord', 'Ctrl+7 Discord (#282)');
eq(po.directPick(c('Digit8'), ordered), 'slot-slack', '#307: Ctrl+8 is the 9th');
eq(po.directPick(c('Digit9'), ordered), 'f', '#307: Ctrl+9 is the 10th');
eq(po.directPick(c('Digit0'), ordered), null, 'Ctrl+0 stays Actual Size');
eq(po.directPick(c('Digit0'), ordered), null, 'Ctrl+0 stays Actual Size');
eq(po.directPick(c('Digit1', { shift: true }), ordered), null, 'Ctrl+Shift+1 stays the page\'s');
eq(po.directPick(c('Digit1', { control: false }), ordered), null, 'bare 1 types a 1');
eq(po.directPick(c('Digit1', { alt: true }), ordered), null, 'AltGr is not Ctrl');
eq(po.directPick(c('Numpad1'), ordered), null, 'numpad is not');
let built = 0;
po.directPick(c('KeyA'), () => { built++; return ordered; });
eq(built, 0, 'an ordinary Ctrl chord never builds the list');
eq(po.directPick(c('Digit2'), po.orderPersonas([])), 'slot-personal-mattermost', '#297: no Work Persona: Ctrl+2 picks whoever is in position 3');
eq(po.directPick(c('Digit7'), po.orderPersonas([])), null, '#297: fewer than 8 Personas: the last keys are free');

console.log('F-keys (#251)');
const fk = (code, mods = {}) => ({ code, control: false, shift: false, alt: false, meta: false, ...mods });
eq(po.directPick(fk('F1'), ordered), 'terminal', '#264: F1 Terminal');
eq(po.directPick(fk('F2'), ordered), 'slot-work-mattermost', 'F2 Work Mattermost');
eq(po.directPick(fk('F3'), ordered), 'w', 'F3 Work');
eq(po.directPick(fk('F4'), ordered), 'slot-personal-mattermost', 'F4 Mattermost');
eq(po.directPick(fk('F5'), ordered), 'p', 'F5 Personal');
eq(po.directPick(fk('F6'), ordered), 'slot-teams', 'F6 Teams');
eq(po.directPick(fk('F7'), () => ordered), 'slot-outlook', 'F7 Outlook');
eq(po.directPick(fk('F8'), ordered), 'slot-discord', 'F8 Discord (#282)');
eq(po.directPick(fk('F9'), ordered), 'slot-slack', '#307: F9 is the 9th');
eq(po.directPick(fk('F10'), ordered), 'f', '#307: F10 is the 10th');
eq(po.directPick(fk('F11'), ordered), null, 'F11 stays full screen');
eq(po.directPick(fk('F12'), ordered), null, 'F12 stays DevTools');
eq(po.directPick(fk('F11'), ordered), null, 'F11 stays full screen');
eq(po.directPick(fk('F4', { alt: true }), ordered), null, 'Alt+F4 still closes the window');
eq(po.directPick(fk('F4', { control: true }), ordered), null, 'Ctrl+F4 still closes the tab');
eq(po.directPick(fk('F5', { shift: true }), ordered), null, 'Shift+F5 is not');

console.log('stepPersona (#295)');
eq(po.stepPersona(ordered, 'terminal', 1), 'slot-work-mattermost', 'right from Terminal');
eq(po.stepPersona(ordered, 'slot-work-mattermost', -1), 'terminal', 'left back to Terminal');
eq(po.stepPersona(ordered, 'terminal', -1), 'unassigned', 'left from the first wraps to the last');
eq(po.stepPersona(ordered, 'unassigned', 1), 'terminal', 'right from the last wraps to the first');
eq(po.stepPersona(ordered, 'w', 1), 'slot-personal-mattermost', 'Work → Mattermost');
eq(po.stepPersona(ordered, 'gone', 1), 'terminal', 'unknown current starts at the first');
eq(po.stepPersona([{ id: 'only' }], 'only', 1), null, 'one Persona: nowhere to go');
eq(po.stepPersona(null, 'x', 1), null, 'no list');

console.log('unread (#231)');
eq(po.unreadFromTitle('(3) Town Square - Team Mattermost'), { count: 3, dot: false }, 'Mattermost mentions');
eq(po.unreadFromTitle('(12) Chat | Microsoft Teams'), { count: 12, dot: false }, 'Teams count');
eq(po.unreadFromTitle('(99+) Chat | Microsoft Teams'), { count: 99, dot: false }, '99+');
eq(po.unreadFromTitle('* Town Square - Team Mattermost'), { count: 0, dot: true }, 'Mattermost unread, no mentions');
eq(po.unreadFromTitle('Mail - Brandon Bell - Outlook'), { count: 0, dot: false }, 'nothing');
eq(po.unreadFromTitle('Season (2) review'), { count: 0, dot: false }, 'a number later in the title is not a count');
eq(po.unreadFromTitle('*nix tips'), { count: 0, dot: false }, 'a star without a space is not a dot');
eq(po.unreadFromTitle(undefined), { count: 0, dot: false }, 'no title');
eq(po.unreadBadge(['(3) a', '(2) b', '* c']), '(5)', 'counts add up across tabs');
eq(po.unreadBadge(['* a', 'b']), '•', 'dot without a count');
eq(po.unreadBadge(['a', 'b']), '', 'all read');
eq(po.unreadBadge([]), '', 'no tabs');

console.log('slotFor (#221)');
eq(po.slotFor('http://co-sf-pe-042.colorado.datadirectnet.com:8065/team/channels/town-square'), 'slot-work-mattermost', 'another Work Mattermost page');
eq(po.slotFor('http://100.69.184.113:8065/agents/pl/abc'), 'slot-personal-mattermost', 'another personal Mattermost page');
eq(po.slotFor('https://outlook.cloud.microsoft/calendar/view/week'), 'slot-outlook', 'the whole Outlook site, not just /mail/');
eq(po.slotFor('https://teams.cloud.microsoft/v2/?meetingjoin=true'), 'slot-teams', 'a Teams meeting link');
eq(po.slotFor('https://discord.com/channels/@me/123'), 'slot-discord', '#282: all of discord.com');
eq(po.slotFor('https://discord.com/login'), 'slot-discord', 'Discord sign-in too');
eq(po.slotFor('https://support.discord.com/hc'), null, 'other Discord hosts are not the slot');
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
eq(po.openerHome('slot-discord', ordered), 'p', 'Discord → Personal');
eq(po.openerHome('terminal', ordered), 'unassigned', 'Terminal → Unassigned');
eq(po.openerHome('slot-teams', po.orderPersonas([])), 'unassigned', 'no Work Persona → Unassigned');
eq(po.openerHome(undefined, ordered), 'unassigned', 'unknown opener → Unassigned');

console.log('reordering (#297)');
const ids = (l) => l.map((p) => p.id);
const base = po.orderPersonas(stored);
const saved = ids(base).filter((i) => i !== 'unassigned');
// Teams to position 2
const teamsSecond = ['terminal', 'slot-teams', ...saved.filter((i) => i !== 'terminal' && i !== 'slot-teams')];
const re = po.orderPersonas(stored, po.slots(), teamsSecond);
eq(ids(re).slice(0, 3), ['terminal', 'slot-teams', 'slot-work-mattermost'], 'saved order wins');
eq(po.directPick(c('Digit1'), re), 'slot-teams', 'Ctrl+1 picks Teams after the move');
eq(po.directPick(fk('F2'), re), 'slot-teams', 'F2 picks Teams after the move');
eq(po.leaderPick(k('Digit1'), re), 'slot-teams', '! picks Teams after the move');
eq(po.directPick(c('Digit5'), re), 'p', 'Personal keeps its place relative to the shift: still position 5');
eq(re.find((p) => p.id === 'slot-work-mattermost').key, '@', 'the one it displaced moves down a key');
eq(po.orderPersonas(stored, po.slots(), null).map((p) => p.id), ids(base), 'no saved order = default');
eq(po.orderPersonas(stored, po.slots(), []).map((p) => p.id), ids(base), 'empty saved order = default');
eq(ids(po.orderPersonas(stored, po.slots(), ['ghost', 'w', 'w', 'terminal'])).slice(0, 3), ['w', 'terminal', 'slot-work-mattermost'],
  'unknown ids ignored, duplicates dropped, the rest follow in default order');
eq(ids(po.orderPersonas([...stored, { id: 'n', name: 'New' }], po.slots(), saved)).slice(-3), ['f', 'n', 'unassigned'], 'a new Persona is appended after the placed ones');
eq(ids(po.orderPersonas(stored, po.slots(), ['unassigned', 'w'])).slice(-1), ['unassigned'], 'Unassigned stays last even if saved first');
eq(po.orderPersonas(stored, po.slots(), ['unassigned', 'w'])[0].id, 'w', 'and does not lead');
const few = po.orderPersonas([{ id: 'unassigned', name: 'Unassigned' }], po.slots(), null);
eq(few[few.length - 1].id, 'unassigned', 'few Personas: Unassigned still last');
eq(few[few.length - 1].key, '&', '... and may take the key of its position');
const nine = po.orderPersonas(stored, po.slots(), ['f', ...saved.filter((i) => i !== 'f')]);
eq(nine[0].key, '`', 'any Persona can take position 1');
eq(nine.find((p) => p.id === 'slot-outlook').key, '&', 'position 8 is &');
eq(nine.find((p) => p.id === 'slot-discord').key, '*', '#307: position 9 is *');
eq(nine[nine.length - 1].key, undefined, 'position 11+ has no key');

console.log('movePersona (#297)');
eq(po.movePersona(base, 'slot-teams', -1).slice(4, 7), ['slot-teams', 'p', 'slot-outlook'], 'left swaps with the one before');
eq(po.movePersona(base, 'slot-teams', 1).slice(5, 8), ['slot-outlook', 'slot-teams', 'slot-discord'], 'right swaps with the one after');
eq(po.movePersona(base, 'terminal', -1), null, 'no wrap at the left end');
eq(po.movePersona(base, 'f', 1), null, 'nothing moves past Unassigned');
eq(po.movePersona(base, 'unassigned', -1), null, 'Unassigned cannot move');
eq(po.movePersona(base, 'nope', 1), null, 'unknown id');
eq(po.movePersona(base, 'f', -1).slice(-3), ['f', 'slot-slack', 'unassigned'], 'moves left into the keyed block');
eq(ids(base).length, 11, 'input not mutated');
eq(ids(po.orderPersonas(stored, po.slots(), po.movePersona(base, 'slot-teams', -1))).indexOf('slot-teams'), 4, 'a move round-trips through orderPersonas');


console.log('keyLabel (#297)');
eq(po.keyLabel(base[0]), 'F1 · Ctrl+`', 'position 1');
eq(po.keyLabel(base[2]), 'F3 · Ctrl+2', 'position 3');
eq(po.keyLabel(base[7]), 'F8 · Ctrl+7', 'position 8');
eq(po.keyLabel(base[8]), 'F9 · Ctrl+8', '#307: the 9th');
eq(po.keyLabel({ id: 'x' }), '', 'no key');


console.log('apps (#301)');
const P = [{ id: 'unassigned', name: 'Unassigned' }, { id: 'p', name: 'Personal' }, { id: 'w', name: 'Work' }, { id: 'f', name: 'Finance' }];
const seeded = po.seedApps({});
eq(seeded.map((a) => a.id), ['work-mattermost', 'personal-mattermost', 'teams', 'outlook', 'discord', 'slack'], 'absent: defaults, Slack last');
eq(seeded[5], { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client', home: 'work' }, 'Slack default');
eq(po.seedApps(undefined).length, 6, 'no settings at all seeds too');
const sOver = po.seedApps({ appSlots: { teams: 'https://t.example.com', outlook: 'nope' } });
eq(sOver[2].url, 'https://t.example.com/', 'absent: old URL edits carry over');
eq(sOver[3].url, 'https://outlook.cloud.microsoft/mail/', 'absent: a bad edit keeps the default');
const mine = [{ id: 'a', name: ' A ', url: 'https://a.example.com', home: 'p' }, { id: 'bad', name: 'X', url: 'file:///c:/x', home: '' }, { id: 'a', name: 'dup', url: 'https://d.example.com' }];
eq(po.seedApps({ apps: mine, appSlots: { teams: 'https://t.example.com' } }), [{ id: 'a', name: 'A', url: 'https://a.example.com/', home: 'p' }], 'present: kept, normalized, junk and duplicate ids dropped, no Slack forced');
eq(po.seedApps({ apps: [] }), [], 'present but empty: you removed them all, stays empty');
eq(po.slots(seeded).length, 6, 'slots() takes an apps list');
eq(po.slots([{ id: 'z', name: 'Z', url: 'https://z.example.com' }]).map((a) => a.id), ['z'], 'slots() of a list is that list');

console.log('validateApp');
eq(po.validateApp({ name: 'Zulip', url: 'https://z.example.com' }, seeded), null, 'ok');
eq(po.validateApp({ name: '  ', url: 'https://z.example.com' }, seeded), 'Name must be 1 to 40 characters', 'empty name');
eq(po.validateApp({ name: 'x'.repeat(41), url: 'https://z.example.com' }, seeded), 'Name must be 1 to 40 characters', '41 chars');
eq(po.validateApp({ name: 'x'.repeat(40), url: 'https://z.example.com' }, seeded), null, '40 chars');
for (const bad of ['', 'zulip', 'file:///c:/x.html', 'javascript:1', 'webforge://settings', 'about:blank']) {
  eq(po.validateApp({ name: 'Z', url: bad }, seeded), 'URL must be a web address (http or https)', `bad URL ${bad}`);
}
eq(po.validateApp({ name: 'Other', url: 'https://app.slack.com/other' }, seeded), 'Another app already uses https://app.slack.com', 'duplicate origin');
eq(po.validateApp({ name: 'Other', url: 'http://app.slack.com/' }, seeded), null, 'a different scheme is a different origin');
eq(po.validateApp({ id: 'slack', name: 'Slack', url: 'https://app.slack.com/client2' }, seeded), null, 'an edit is not compared with itself');
eq(po.validateApp({ id: 'teams', name: 'Teams', url: 'https://app.slack.com/' }, seeded), 'Another app already uses https://app.slack.com', 'an edit onto another app\'s origin');

console.log('addApp / editApp / removeApp');
const a1 = po.addApp(seeded, { name: 'Slack', url: 'https://slack.example.com', home: 'personal' });
eq(a1.length, 7, 'added');
eq(a1[6], { id: 'slack-2', name: 'Slack', url: 'https://slack.example.com/', home: 'personal' }, 'unique id: slack-2');
eq(po.addApp(a1, { name: 'Slack', url: 'https://s3.example.com' })[7].id, 'slack-3', 'slack-3');
eq(po.addApp(seeded, { name: 'My  Cool App!', url: 'https://m.example.com' })[6].id, 'my-cool-app', 'slug');
eq(po.addApp(seeded, { name: '!!!', url: 'https://m.example.com' })[6].id, 'app', 'slug fallback');
eq(po.addApp(seeded, { name: 'Z', url: 'nope' }), seeded, 'junk adds nothing');
eq(seeded.length, 6, 'input not mutated');
const e1 = po.editApp(seeded, 'teams', { name: 'MS Teams', url: 'https://t.example.com', home: 'unassigned', id: 'hacked' });
eq(e1[2], { id: 'teams', name: 'MS Teams', url: 'https://t.example.com/', home: 'unassigned' }, 'edited, id permanent');
eq(po.editApp(seeded, 'teams', { name: ' ', url: 'bad' })[2], seeded[2], 'blank name and bad URL keep the old values');
eq(po.editApp(seeded, 'nope', { name: 'Q' }), seeded, 'unknown id');
const r1 = po.removeApp(seeded, 'teams');
eq(r1.map((a) => a.id), ['work-mattermost', 'personal-mattermost', 'outlook', 'discord', 'slack'], 'removed');
eq(po.removeApp(seeded, 'nope').length, 6, 'unknown id removes nothing');
eq(po.addApp(r1, { name: 'Teams', url: 'https://teams.cloud.microsoft/' })[5].id, 'teams', 'a freed id can come back');

console.log('slotFor / openerHome / order with apps');
const withZ = po.addApp(seeded, { name: 'Zulip', url: 'https://chat.z.example.com/#narrow', home: 'f' });
eq(po.slotFor('https://chat.z.example.com/other', withZ), 'slot-zulip', 'a user-added app claims its origin');
eq(po.slotFor('https://chat.z.example.com/other', r1), null, 'nobody claims it without the app');
eq(po.slotFor('https://teams.cloud.microsoft/x', r1), null, 'a removed app no longer claims');
eq(po.slotFor('https://app.slack.com/client/T1/C2', seeded), 'slot-slack', 'Slack claims its site');
const oz = po.orderPersonas(P, withZ);
eq(oz.map((p) => p.id), ['terminal', 'slot-work-mattermost', 'w', 'slot-personal-mattermost', 'p', 'slot-teams', 'slot-outlook', 'slot-discord', 'slot-slack', 'slot-zulip', 'f', 'unassigned'],
  'Slack at 9 and a new app after the defaults, before your other Personas');
eq(oz.find((p) => p.id === 'slot-slack').key, '*', '#307: Slack (9th by default) is *');
eq(oz.find((p) => p.id === 'slot-zulip').url, 'https://chat.z.example.com/#narrow', 'the new slot persona has its URL');
const oneMove = po.movePersona(oz, 'slot-slack', -1);
const oz2 = po.orderPersonas(P, withZ, oneMove);
eq(oz2.find((p) => p.id === 'slot-slack').key, '&', 'Slack moved up one: it takes position 8, key &');
eq(oz2.find((p) => p.id === 'slot-discord').key, '*', 'and Discord drops to 9th, key *');
eq(po.orderPersonas(P, r1, oneMove).some((p) => p.id === 'slot-teams'), false, 'a removed app vanishes from the order');
eq(po.orderPersonas(P, po.removeApp(withZ, 'zulip'), ['slot-zulip', 'w']).map((p) => p.id).includes('slot-zulip'), false, 'a saved id of a removed app is ignored');
eq(po.openerHome('slot-zulip', oz, withZ), 'f', 'home as a Persona id');
eq(po.openerHome('slot-slack', oz, withZ), 'w', 'home as the name work');
eq(po.openerHome('slot-slack', po.orderPersonas([]), withZ), 'unassigned', 'home missing: Unassigned');
eq(po.openerHome('slot-teams', oz, e1), 'unassigned', 'home unassigned');
eq(po.openerHome('slot-gone', oz, withZ), 'unassigned', 'unknown slot: Unassigned');
eq(po.openerHome('slot-teams', oz), 'w', 'default list still works with two args');

console.log(`personaorder: ${n} passed`);
