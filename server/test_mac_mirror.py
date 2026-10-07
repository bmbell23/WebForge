"""#315 tests:  python3 server/test_mac_mirror.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import mac_mirror as m  # noqa: E402

# the real v0.1.221 manifest, shortened hashes
YML = """version: 0.1.221
files:
  - url: WebForge-0.1.221-arm64.zip
    sha512: aaa==
    size: 129052137
  - url: WebForge-0.1.221-x64.zip
    sha512: bbb==
    size: 132858552
  - url: WebForge-0.1.221-arm64.dmg
    sha512: ccc==
    size: 133278421
  - url: WebForge-0.1.221-x64.dmg
    sha512: ddd==
    size: 137074401
path: WebForge-0.1.221-arm64.zip
sha512: aaa==
releaseDate: '2026-10-07T12:10:37.048Z'
"""


def rel(tag, names, **kw):
    return {'tag_name': tag, 'assets': [{'name': n, 'browser_download_url': f'https://x/{tag}/{n}'} for n in names], **kw}


class Manifest(unittest.TestCase):
    def test_parses_version_and_files(self):
        man = m.parse_manifest(YML)
        self.assertEqual(man['version'], '0.1.221')
        self.assertEqual([f['url'] for f in man['files']], [
            'WebForge-0.1.221-arm64.zip', 'WebForge-0.1.221-x64.zip',
            'WebForge-0.1.221-arm64.dmg', 'WebForge-0.1.221-x64.dmg'])
        self.assertEqual(man['files'][2], {'url': 'WebForge-0.1.221-arm64.dmg', 'sha512': 'ccc==', 'size': '133278421'})

    def test_top_level_sha512_does_not_leak_into_last_file(self):
        self.assertEqual(m.parse_manifest(YML)['files'][-1]['sha512'], 'ddd==')

    def test_refuses_paths(self):
        for bad in ('../evil.dmg', 'sub/x.dmg', '.hidden'):
            with self.assertRaises(ValueError):
                m.parse_manifest(f'version: 1\nfiles:\n  - url: {bad}\n')


class Pick(unittest.TestCase):
    def test_newest_with_manifest_wins(self):
        r = m.newest_mac_release([
            rel('v0.1.222', ['notes.txt']),  # Actions still building
            rel('v0.1.221', ['latest-mac.yml', 'a.dmg']),
            rel('v0.1.220', ['latest-mac.yml']),
        ])
        self.assertEqual(r['tag'], 'v0.1.221')
        self.assertEqual(r['assets']['a.dmg'], 'https://x/v0.1.221/a.dmg')

    def test_skips_drafts_and_none(self):
        self.assertIsNone(m.newest_mac_release([rel('v1', ['latest-mac.yml'], draft=True)]))
        self.assertIsNone(m.newest_mac_release([]))

    def test_version_order_is_numeric(self):
        self.assertGreater(m.vkey('0.1.221'), m.vkey('0.1.99'))
        self.assertEqual(m.vkey(None), (0,))


class Prune(unittest.TestCase):
    def test_removes_old_versions_and_partials_keeps_manifest(self):
        names = ['latest-mac.yml', 'WebForge-0.1.221-arm64.dmg', 'WebForge-0.1.220-arm64.dmg', 'x.dmg.part']
        self.assertEqual(m.stale_files(names, {'WebForge-0.1.221-arm64.dmg'}),
                         ['WebForge-0.1.220-arm64.dmg', 'x.dmg.part'])


if __name__ == '__main__':
    unittest.main(verbosity=1)
