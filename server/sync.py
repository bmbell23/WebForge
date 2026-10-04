"""WebForge sync service (#13): a deliberately tiny last-write-wins JSON store.

Stdlib only — no pip, runs straight on the python:alpine image.
    GET  /health           -> {"status": "ok"}
    GET  /store/bookmarks  -> {"data": <json>|null, "updatedAt": <ms>}
    PUT  /store/bookmarks  <- {"data": <json>, "updatedAt": <ms>}  (LWW: server
                              keeps whatever it's given; clients decide by
                              comparing updatedAt before pushing/pulling)

    POST /logs/<device>    <- {"version": str, "entries": [{"at", "where", "body"}]}
                              (#171: appended as JSON lines to logs/<device>.log)
    GET  /logs/<device>?tail=N -> {"lines": [<entry>, ...]}  (last N, default 200)

Exposed only over Tailscale like everything else on dockerhost. v1 syncs
bookmarks, personas and tabs; credentials would need end-to-end encryption
first (see ticket).
"""
import json
import os
import re
import time
from urllib.parse import parse_qs, urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("DATA_DIR", "/data")
PORT = int(os.environ.get("PORT", "8013"))
# #88/#57: personas + per-persona tab sets ride the same store.
ALLOWED_KEYS = {"bookmarks", "personas", "tabs"}
MAX_BODY = 10_000_000


# #151: keep the last few versions of each key before overwriting it.
#
# On 2026-09-23 a fresh install pushed empty default Personas over the real set.
# The client bug is fixed (windows/syncdecide.js), but this store is last-write-
# wins by design and `os.replace` made the previous version unrecoverable in the
# same instant. That wipe was survivable only by accident, because tabs.json
# happened to still key tabs by the lost Persona ids.
#
# A few copies on disk turn "restore yesterday's personas" into a `cp`. These
# files are small (personas.json is ~500 bytes; bookmarks.json ~100KB), so the
# cost of keeping them is nothing next to the cost of not having them.
HISTORY_KEEP = 10


def _keep_history(key, dest):
    """Snapshot the current value of `key` into DATA_DIR/history/ before it is
    overwritten. Never allowed to fail a PUT — losing a backup is bad, refusing
    the user's write because a backup failed is worse."""
    try:
        if not os.path.exists(dest):
            return
        hist = os.path.join(DATA_DIR, "history")
        os.makedirs(hist, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        snap = os.path.join(hist, f"{key}.{stamp}.json")
        if not os.path.exists(snap):  # same-second PUTs collapse; that's fine
            with open(dest, "rb") as src, open(snap, "wb") as out:
                out.write(src.read())
        old = sorted(
            f for f in os.listdir(hist)
            if f.startswith(f"{key}.") and f.endswith(".json")
        )
        for stale in old[:-HISTORY_KEEP]:
            try:
                os.remove(os.path.join(hist, stale))
            except OSError:
                pass
    except Exception as exc:  # noqa: BLE001 — a backup must never block a write
        print(f"history snapshot failed for {key}: {exc}")


# #171: the Windows app's errors.log, shipped here so a bug can be read on the
# server instead of off Brandon's screen. Append-only, one JSON line per entry,
# and each device's file rotates to .1 past LOG_ROTATE so it cannot fill the disk.
LOG_DIR = os.path.join(DATA_DIR, "logs")
LOG_MAX_BODY = 1_000_000
LOG_ROTATE = 5_000_000
DEVICE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _log_device(path):
    parts = urlsplit(path).path.strip("/").split("/")
    if len(parts) == 2 and parts[0] == "logs":
        return parts[1] if DEVICE_RE.match(parts[1]) else ""
    return None


def append_log(device, body):
    """Append a batch to logs/<device>.log. Returns the number written."""
    entries = body.get("entries") if isinstance(body, dict) else None
    if not isinstance(entries, list):
        raise ValueError("entries must be a list")
    version = str(body.get("version") or "")[:40]
    received = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    os.makedirs(LOG_DIR, exist_ok=True)
    dest = os.path.join(LOG_DIR, f"{device}.log")
    if os.path.exists(dest) and os.path.getsize(dest) > LOG_ROTATE:
        os.replace(dest, dest + ".1")
    written = 0
    with open(dest, "a") as fh:
        for e in entries:
            if not isinstance(e, dict):
                continue
            line = {
                "at": str(e.get("at") or "")[:40],
                "received": received,
                "version": version,
                "where": str(e.get("where") or "")[:200],
                "body": str(e.get("body") or ""),
            }
            fh.write(json.dumps(line) + "\n")
            written += 1
    return written


def tail_log(device, n):
    dest = os.path.join(LOG_DIR, f"{device}.log")
    if not os.path.exists(dest):
        return []
    with open(dest) as fh:
        lines = fh.readlines()[-n:]
    out = []
    for raw in lines:
        try:
            out.append(json.loads(raw))
        except ValueError:
            pass
    return out


class Handler(BaseHTTPRequestHandler):
    def _key(self):
        parts = self.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "store" and parts[1] in ALLOWED_KEYS:
            return parts[1]
        return None

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"status": "ok"})
        device = _log_device(self.path)
        if device is not None:
            if not device:
                return self._send(400, {"error": "bad device"})
            q = parse_qs(urlsplit(self.path).query)
            try:
                n = max(1, min(int((q.get("tail") or ["200"])[0]), 5000))
            except ValueError:
                n = 200
            return self._send(200, {"lines": tail_log(device, n)})
        key = self._key()
        if not key:
            return self._send(404, {"error": "not found"})
        path = os.path.join(DATA_DIR, f"{key}.json")
        if not os.path.exists(path):
            return self._send(200, {"data": None, "updatedAt": 0})
        try:
            with open(path) as fh:
                return self._send(200, json.load(fh))
        except Exception:
            return self._send(500, {"error": "corrupt store"})

    def do_POST(self):
        device = _log_device(self.path)
        if device is None:
            return self._send(404, {"error": "not found"})
        if not device:
            return self._send(400, {"error": "bad device"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > LOG_MAX_BODY:
            return self._send(413, {"error": "bad size"})
        try:
            body = json.loads(self.rfile.read(length))
            written = append_log(device, body)
        except ValueError:
            return self._send(400, {"error": "bad json"})
        return self._send(200, {"written": written})

    def do_PUT(self):
        key = self._key()
        if not key:
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "bad size"})
        try:
            body = json.loads(self.rfile.read(length))
        except Exception:
            return self._send(400, {"error": "bad json"})
        record = {
            "data": body.get("data"),
            "updatedAt": int(body.get("updatedAt") or time.time() * 1000),
        }
        os.makedirs(DATA_DIR, exist_ok=True)
        dest = os.path.join(DATA_DIR, f"{key}.json")
        _keep_history(key, dest)
        tmp = os.path.join(DATA_DIR, f"{key}.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(record, fh)
        os.replace(tmp, dest)
        return self._send(200, {"updatedAt": record["updatedAt"]})

    def log_message(self, fmt, *args):  # keep container logs readable
        print(f"{self.address_string()} {fmt % args}")


if __name__ == "__main__":
    print(f"webforge-sync listening on :{PORT}, data in {DATA_DIR}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
