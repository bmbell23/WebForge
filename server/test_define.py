"""#286 tests:  cd server && python3 -m unittest test_define -v

The term cases mirror windows/defineterm.test.js and DefineTermTest.kt.
"""
import json
import os
import re
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import sync

VALID = [
    ("word", "word"),
    ("  word  ", "word"),
    ('"quoted,"', "quoted"),
    ("(bracketed)", "bracketed"),
    ("\u201csmart\u201d", "smart"),
    ("Hello!?", "Hello"),
    ("end.", "end"),
    ("ice   cream", "ice cream"),
    ("ice\n\tcream", "ice cream"),
    ("don\u2019t", "don't"),
    ("\u2018tis\u2019", "tis"),
    ("rock'n'roll", "rock'n'roll"),
    ("well-known", "well-known"),
    ("-ing", "ing"),
    ("na\u00efve", "na\u00efve"),
    ("caf\u00e9", "caf\u00e9"),
    ("\u65e5\u672c\u8a9e", "\u65e5\u672c\u8a9e"),
    ("route 66", "route 66"),
    ("a" * 64, "a" * 64),
]
INVALID = [
    "",
    "   ",
    "...",
    '"" ""',
    "a" * 65,
    "two, words",
    "a/b",
    "foo@bar",
    "x=1",
    "The quick brown fox jumps over the lazy dog, then keeps on running far away",
    "tab\u0000bell",
    None,
    42,
]
NAME_RE = re.compile(r"^\d{13}-[0-9a-f]{8}\.json$")


class CleanTerm(unittest.TestCase):
    def test_valid(self):
        for raw, want in VALID:
            with self.subTest(raw=raw[:12]):
                self.assertEqual(sync.clean_term(raw), want)

    def test_invalid(self):
        for raw in INVALID:
            with self.subTest(raw=raw if not isinstance(raw, str) else raw[:12]):
                self.assertIsNone(sync.clean_term(raw))


class WriteTrigger(unittest.TestCase):
    def test_atomic_name_and_content(self):
        with tempfile.TemporaryDirectory() as d:
            name = sync.write_trigger("ephemeral", "https://example.com/a?b=1", d)
            self.assertRegex(name, NAME_RE)
            self.assertEqual(os.listdir(d), [name])  # no .tmp left behind
            with open(os.path.join(d, name)) as fh:
                rec = json.load(fh)
            self.assertEqual(rec["term"], "ephemeral")
            self.assertEqual(rec["source"], "WebForge")
            self.assertEqual(rec["url"], "https://example.com/a?b=1")
            self.assertRegex(rec["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_bad_urls_are_dropped(self):
        with tempfile.TemporaryDirectory() as d:
            for url in (None, "javascript:alert(1)", "file:///etc/passwd",
                        "https://x.com/" + "a" * 2048, 5):
                name = sync.write_trigger("word", url, d)
                with open(os.path.join(d, name)) as fh:
                    self.assertNotIn("url", json.load(fh))

    def test_missing_dir_is_not_created(self):
        with tempfile.TemporaryDirectory() as d:
            gone = os.path.join(d, "triggers")
            with self.assertRaises(sync.DefineNotSetUp):
                sync.write_trigger("word", None, gone)
            self.assertFalse(os.path.exists(gone))


class DefineEndpoint(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = sync.TRIGGER_DIR
        sync.TRIGGER_DIR = self.tmp.name
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), sync.Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        sync.TRIGGER_DIR = self.saved
        self.tmp.cleanup()

    def post(self, raw):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/define", data=raw,
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_ok(self):
        code, body = self.post(json.dumps({"term": "\u201cdon\u2019t\u201d", "url": "https://a.com/"}).encode())
        self.assertEqual(code, 200)
        self.assertRegex(body["queued"], NAME_RE)
        with open(os.path.join(self.tmp.name, body["queued"])) as fh:
            self.assertEqual(json.load(fh)["term"], "don't")

    def test_bad_json_and_term(self):
        self.assertEqual(self.post(b"{nope")[0], 400)
        self.assertEqual(self.post(json.dumps({"term": "a/b"}).encode())[0], 400)
        self.assertEqual(self.post(json.dumps(["word"]).encode())[0], 400)
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_too_big(self):
        raw = json.dumps({"term": "word", "url": "https://a.com/" + "a" * 5000}).encode()
        self.assertEqual(self.post(raw)[0], 413)

    def test_not_set_up(self):
        sync.TRIGGER_DIR = os.path.join(self.tmp.name, "absent")
        code, body = self.post(json.dumps({"term": "word"}).encode())
        self.assertEqual((code, body), (503, {"error": "define is not set up"}))
        self.assertFalse(os.path.exists(sync.TRIGGER_DIR))


if __name__ == "__main__":
    unittest.main()
