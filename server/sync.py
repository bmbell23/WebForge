"""WebForge sync service (#13): a deliberately tiny last-write-wins JSON store.

Stdlib only — no pip, runs straight on the python:alpine image.
    GET  /health           -> {"status": "ok"}
    GET  /store/bookmarks  -> {"data": <json>|null, "updatedAt": <ms>}
    PUT  /store/bookmarks  <- {"data": <json>, "updatedAt": <ms>}  (LWW: server
                              keeps whatever it's given; clients decide by
                              comparing updatedAt before pushing/pulling)

Exposed only over Tailscale like everything else on dockerhost. v1 syncs
bookmarks, personas and tabs; credentials would need end-to-end encryption
first (see ticket).
"""
import json
import os
import time
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
