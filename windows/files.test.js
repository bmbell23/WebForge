// #322 unit tests. Plain node, no framework:  node windows/files.test.js
const assert = require('assert');
const files = require('./files');

let run = 0;
const pending = [];
const test = (name, fn) => {
  const done = () => {
    run++;
    console.log(`  ok  ${name}`);
  };
  const r = fn();
  if (r && r.then) pending.push(r.then(done));
  else done();
};

test('kinds: Brandon\'s editor list is text; media, pdf and pages open in-app', () => {
  for (const n of ['a.yaml', 'b.yml', 'c.txt', 'README.md', 'x.sh', 'd.json', 'e.conf', 'f.ini', 'g.log', 'h.py', 'i.js', 'j.ps1', 'k.toml', 'l.xml', 'm.csv']) {
    assert.strictEqual(files.kindOf(n), 'text', n);
  }
  assert.strictEqual(files.kindOf('Photo.JPG'), 'image');
  assert.strictEqual(files.kindOf('clip.mp4'), 'video');
  assert.strictEqual(files.kindOf('song.flac'), 'audio');
  assert.strictEqual(files.kindOf('manual.pdf'), 'pdf');
  assert.strictEqual(files.kindOf('index.html'), 'page');
  assert.strictEqual(files.opensInApp('report.docx'), false);
  assert.strictEqual(files.opensInApp('setup.exe'), false);
  assert.strictEqual(files.opensInApp('archive.zip'), false);
});

test('names without an extension: dotfiles and Dockerfile are text, others go to the system', () => {
  assert.strictEqual(files.extOf('.bashrc'), '');
  assert.strictEqual(files.kindOf('.bashrc'), 'text');
  assert.strictEqual(files.kindOf('Dockerfile'), 'text');
  assert.strictEqual(files.kindOf('Makefile'), 'text');
  assert.strictEqual(files.kindOf('somebinary'), 'other');
  assert.strictEqual(files.extOf('archive.tar.gz'), 'gz');
});

test('hidden: dotfiles and Windows system names, case-insensitive', () => {
  assert.ok(files.isHidden('.git'));
  assert.ok(files.isHidden('desktop.ini'));
  assert.ok(files.isHidden('$RECYCLE.BIN'));
  assert.ok(files.isHidden('NTUSER.DAT{abc}.TM.blf'));
  assert.ok(files.isHidden('AppData'));
  assert.ok(!files.isHidden('Documents'));
});

test('type column reads like Explorer', () => {
  assert.strictEqual(files.typeLabel({ name: 'src', dir: true }), 'File folder');
  assert.strictEqual(files.typeLabel({ name: 'a.png' }), 'PNG image');
  assert.strictEqual(files.typeLabel({ name: 'a.yaml' }), 'YAML file');
  assert.strictEqual(files.typeLabel({ name: 'a.pdf' }), 'PDF document');
  assert.strictEqual(files.typeLabel({ name: 'a.exe' }), 'EXE file');
  assert.strictEqual(files.typeLabel({ name: 'LICENSE' }), 'File');
});

test('sizes: blank for folders, one decimal under 10', () => {
  assert.strictEqual(files.formatSize(undefined), '');
  assert.strictEqual(files.formatSize(0), '0 B');
  assert.strictEqual(files.formatSize(1023), '1023 B');
  assert.strictEqual(files.formatSize(1536), '1.5 KB');
  assert.strictEqual(files.formatSize(50 * 1024 * 1024), '50 MB');
  assert.strictEqual(files.formatSize(3.25 * 1024 ** 3), '3.3 GB');
});

test('sort: folders first in every order, numeric names, ties by name', () => {
  const list = [
    { name: 'file10.txt', size: 5, mtime: 3 },
    { name: 'zeta', dir: true, mtime: 1 },
    { name: 'file2.txt', size: 5, mtime: 9 },
    { name: 'Alpha', dir: true, mtime: 2 },
    { name: 'big.iso', size: 900, mtime: 1 },
  ];
  const names = (l) => l.map((e) => e.name);
  assert.deepStrictEqual(names(files.sortEntries(list, 'name', 'asc')), ['Alpha', 'zeta', 'big.iso', 'file2.txt', 'file10.txt']);
  assert.deepStrictEqual(names(files.sortEntries(list, 'name', 'desc')), ['zeta', 'Alpha', 'file10.txt', 'file2.txt', 'big.iso']);
  assert.deepStrictEqual(names(files.sortEntries(list, 'size', 'desc')), ['zeta', 'Alpha', 'big.iso', 'file10.txt', 'file2.txt']);
  assert.strictEqual(files.sortEntries(list, 'modified', 'desc')[2].name, 'file2.txt');
  assert.deepStrictEqual(names(list).length, 5, 'the input is not mutated');
  assert.strictEqual(list[0].name, 'file10.txt');
});

test('parents: drive, share and posix roots have none', () => {
  assert.strictEqual(files.parentOf('C:\\Users\\bbell', 'win32'), 'C:\\Users');
  assert.strictEqual(files.parentOf('C:\\Users', 'win32'), 'C:\\');
  assert.strictEqual(files.parentOf('C:\\', 'win32'), null);
  assert.strictEqual(files.parentOf('\\\\nas\\media\\Movies', 'win32'), '\\\\nas\\media\\');
  assert.strictEqual(files.parentOf('\\\\nas\\media', 'win32'), null);
  assert.strictEqual(files.parentOf('\\\\nas\\media\\', 'win32'), null);
  assert.strictEqual(files.parentOf('/home/brandon', 'linux'), '/home');
  assert.strictEqual(files.parentOf('/', 'linux'), null);
});

test('typed paths are cleaned up', () => {
  assert.strictEqual(files.normalizeInput(' "C:/Users/bbell/" ', 'win32'), 'C:\\Users\\bbell');
  assert.strictEqual(files.normalizeInput('d:', 'win32'), 'D:\\');
  assert.strictEqual(files.normalizeInput('c:\\', 'win32'), 'C:\\');
  assert.strictEqual(files.normalizeInput('//nas/media/', 'win32'), '\\\\nas\\media');
  assert.strictEqual(files.normalizeInput('\\\\nas\\\\media\\Movies', 'win32'), '\\\\nas\\media\\Movies');
  assert.strictEqual(files.normalizeInput('~\\Downloads', 'win32', 'C:\\Users\\bbell'), 'C:\\Users\\bbell\\Downloads');
  assert.strictEqual(files.normalizeInput('/tmp/', 'linux'), '/tmp');
  assert.strictEqual(files.normalizeInput('/', 'linux'), '/');
  assert.strictEqual(files.normalizeInput('   ', 'win32'), '');
});

test('shares: root found from any depth, remembered most-recent first', () => {
  assert.strictEqual(files.shareRoot('\\\\nas\\media\\Movies\\x.mkv'), '\\\\nas\\media');
  assert.strictEqual(files.shareRoot('C:\\Users'), null);
  let list = files.rememberShare([], '\\\\nas\\media\\Movies');
  list = files.rememberShare(list, '\\\\pc\\c$');
  list = files.rememberShare(list, '\\\\NAS\\Media\\Music');
  assert.deepStrictEqual(list, ['\\\\NAS\\Media', '\\\\pc\\c$']);
  assert.deepStrictEqual(files.rememberShare(list, 'C:\\x'), list);
});

test('text preview: first N lines, binary refused', () => {
  const p = files.textPreview(Buffer.from('a\r\nb\nc\nd'), 2);
  assert.deepStrictEqual(p, { text: 'a\nb', more: true });
  assert.strictEqual(files.textPreview(Buffer.from([0x50, 0x4b, 0x00, 0x03])), null);
  const reg = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Windows Registry Editor\r\n[HKEY]', 'utf16le')]);
  assert.deepStrictEqual(files.textPreview(reg), { text: 'Windows Registry Editor\n[HKEY]', more: false });
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hi', 'utf16le').swap16()]);
  assert.strictEqual(files.textPreview(be).text, 'hi');
  assert.strictEqual(files.textPreview(Buffer.from('\uFEFFkey: 1', 'utf8')).text, 'key: 1');
});

test('drives: only the roots that answer, slow ones time out', () =>
  files
    .listDrives(
      (root) => (root === 'Z:\\' ? new Promise(() => {}) : root === 'C:\\' || root === 'M:\\'),
      50
    )
    .then((d) => assert.deepStrictEqual(d, ['C:\\', 'M:\\'])));

Promise.all(pending).then(
  () => console.log(`files: ${run} tests passed`),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
