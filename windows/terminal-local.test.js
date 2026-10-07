// #276 tests:  node windows/terminal-local.test.js
const assert = require('assert');
const t = require('./terminal');
const { openLocal } = require('./localterm');

let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

console.log('parseLocal');
const env = { COMSPEC: 'C:\\Windows\\system32\\cmd.exe', SHELL: '/usr/bin/fish' };
eq(t.parseLocal('local:powershell', 'win32', env), { shell: 'powershell', file: 'powershell.exe', args: [], label: 'PowerShell' }, 'powershell');
eq(t.parseLocal('local:cmd', 'win32', env), { shell: 'cmd', file: 'C:\\Windows\\system32\\cmd.exe', args: [], label: 'Command Prompt' }, 'cmd uses COMSPEC');
eq(t.parseLocal('local:cmd', 'win32', {}).file, 'cmd.exe', 'cmd without COMSPEC');
eq(t.parseLocal('local:shell', 'darwin', env), { shell: 'shell', file: '/usr/bin/fish', args: ['-l'], label: 'Terminal' }, 'darwin uses SHELL');
eq(t.parseLocal('local:shell', 'darwin', {}).file, '/bin/zsh', 'darwin default zsh');
eq(t.parseLocal('local:shell', 'linux', {}).file, '/bin/bash', 'linux default bash');
eq(t.parseLocal('local:cmd', 'darwin', env), null, 'cmd is not a mac shell');
eq(t.parseLocal('local:powershell', 'linux', env), null, 'powershell is not a linux shell');
eq(t.parseLocal('local:shell', 'win32', env), null, 'shell is not a windows shell');
eq(t.parseLocal('local:zsh', 'darwin', env), null, 'unknown name');
eq(t.parseLocal('local:', 'linux', env), null, 'empty name');
eq(t.parseLocal('brandon@dockerhost', 'linux', env), null, 'ssh target');
eq(t.parseLocal('', 'linux', env), null, 'empty');
eq(t.parseLocal(null, 'linux', env), null, 'null');

console.log('parseTarget');
eq(t.parseTarget('local:powershell').local, 'powershell', 'local target is flagged');
eq(t.parseTarget('brandon@dockerhost'), { username: 'brandon', host: 'dockerhost', port: 22 }, 'ssh target unchanged');

console.log('openLocal with a fake pty');
const makeFake = () => {
  const f = { spawned: null, writes: [], sizes: [], killed: false };
  f.pty = {
    spawn: (file, args, opts) => {
      f.spawned = { file, args, opts };
      const proc = {
        onData: (cb) => { f.data = cb; },
        onExit: (cb) => { f.exit = cb; },
        write: (d) => f.writes.push(d),
        resize: (c, r) => f.sizes.push([c, r]),
        kill: () => { f.killed = true; },
      };
      return proc;
    },
  };
  return f;
};
const hooks = (log) => ({
  cols: 100, rows: 30,
  onData: (b) => log.push(['data', b.toString()]),
  onStatus: (k, x) => log.push(['status', k, x]),
  onClose: (c) => log.push(['close', c]),
  onReady: () => log.push(['ready']),
});

const f = makeFake();
const log = [];
const s = openLocal('local:shell', hooks(log), f.pty, 'linux');
eq(f.spawned.args, ['-l'], 'login shell args');
eq([f.spawned.opts.cols, f.spawned.opts.rows, f.spawned.opts.cwd], [100, 30, require('os').homedir()], 'size and cwd');
eq(f.spawned.opts.env.TERM, 'xterm-256color', 'TERM set off Windows');
eq(log[0], ['ready'], 'ready after spawn');
f.data('hello');
eq(log[1], ['data', 'hello'], 'data flows as a Buffer');
s.write('ls\r');
eq(f.writes, ['ls\r'], 'write passes through');
s.resize(120, 40);
eq(f.sizes, [[120, 40]], 'resize passes through');
f.exit({ exitCode: 3 });
eq(log[2], ['close', 3], 'exit calls onClose with the code');
s.write('late');
eq(f.writes.length, 1, 'no writes after exit');
f.exit({ exitCode: 4 });
eq(log.length, 3, 'close only once');

const fw = makeFake();
openLocal('local:cmd', hooks([]), fw.pty, 'win32');
eq(fw.spawned.opts.env.TERM === undefined || fw.spawned.opts.env.TERM === process.env.TERM, true, 'TERM untouched on Windows');
eq(fw.spawned.args, [], 'cmd has no args');

const fe = makeFake();
const le = [];
const se = openLocal('local:shell', hooks(le), fe.pty, 'linux');
se.end();
eq(fe.killed, true, 'end kills the pty');
fe.exit({ exitCode: 0 });
eq(le.some((x) => x[0] === 'close'), false, 'no onClose after end()');

// failures are reported in the tab, not thrown
const lb = [];
openLocal('local:cmd', hooks(lb), makeFake().pty, 'linux');
eq(lb[0][0] === 'status' && lb[0][1] === 'error', true, 'wrong-platform name is an error status');
const lt = [];
openLocal('local:shell', hooks(lt), { spawn: () => { throw new Error('boom'); } }, 'linux');
eq(lt[0], ['status', 'error', 'could not start Terminal: boom'], 'spawn failure reported');
setImmediate(() => {
  eq(lb[1], ['close', null], 'failure then closes (restart on Enter)');
  eq(lt[1], ['close', null], 'spawn failure then closes');
  console.log(`terminal-local (#276): ${n} passed`);
});
