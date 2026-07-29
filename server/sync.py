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
        tmp = os.path.join(DATA_DIR, f"{key}.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(record, fh)
        os.replace(tmp, os.path.join(DATA_DIR, f"{key}.json"))
        return self._send(200, {"updatedAt": record["updatedAt"]})

    def log_message(self, fmt, *args):  # keep container logs readable
        print(f"{self.address_string()} {fmt % args}")


if __name__ == "__main__":
    print(f"webforge-sync listening on :{PORT}, data in {DATA_DIR}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
