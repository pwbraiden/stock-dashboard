#!/usr/bin/env python3
"""Run the dashboard locally: serves public/ and the /api routes from api/index.py."""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "api"))
import index  # noqa: E402

PORT = int(os.environ.get("PORT", "8000"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(ROOT, "public"), **kw)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/api/"):
            return index.handler.do_GET(self)
        return super().do_GET()


if __name__ == "__main__":
    print("Serving on http://localhost:%d" % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
