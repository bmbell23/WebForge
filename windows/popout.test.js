// #235: run with `node popout.test.js`.
const assert = require('assert');
const { unpopout } = require('./popout');

let n = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };
const MM = 'http://co-sf-pe-042.colorado.datadirectnet.com:8065';

eq(unpopout(`${MM}/_popout/channel/office/channels/agent-bus`), `${MM}/office/channels/agent-bus`, 'channel pop-out');
eq(unpopout(`${MM}/_popout/channel/office/messages/@bianca`), `${MM}/office/messages/@bianca`, 'DM pop-out');
eq(unpopout(`${MM}/_popout/thread/office/abc123def`), `${MM}/office/pl/abc123def`, 'thread pop-out → permalink');
eq(unpopout(`${MM}/_popout/thread/office/abc123def?x=1#y`), `${MM}/office/pl/abc123def`, 'query and hash dropped');
eq(unpopout(`${MM}/_popout/something/new`), `${MM}/`, 'unknown pop-out → the site root');
eq(unpopout(`${MM}/_popout/channel/office`), `${MM}/`, 'channel without a path → root');
eq(unpopout(`${MM}/office/channels/town-square`), `${MM}/office/channels/town-square`, 'a normal page is untouched');
eq(unpopout('https://example.com/a/_popout/b'), 'https://example.com/a/_popout/b', 'only a leading /_popout/');
eq(unpopout('file:///C:/x/_popout/y'), 'file:///C:/x/_popout/y', 'non-http untouched');
eq(unpopout('not a url'), 'not a url', 'junk untouched');
eq(unpopout(null), null, 'null untouched');

console.log(`popout (#235): ${n} passed`);
