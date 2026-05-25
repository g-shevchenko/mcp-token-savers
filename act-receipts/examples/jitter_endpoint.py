"""Minimal /test/jitter endpoint — reproduces AB2 from the article.

A controlled-jitter target: emits one fresh `data-time="<unix-ms>"`
attribute on every request, with the rest of the page byte-stable.
The whole point is to let you run AB2 against a known-jitter target
to see act_receipt.v1's dom_region_hash noise-stripping in action.

Usage:
    pip install starlette uvicorn
    python3 jitter_endpoint.py
    # then in another shell:
    curl http://127.0.0.1:3030/test/jitter | head

Run AB2 against this endpoint with your own browser-MCP fork.

Standard-library-only fallback if you don't want Starlette: see
`jitter_endpoint_stdlib.py` below — but it's slightly less convenient
for a normal dev loop.

License: MIT
"""
from __future__ import annotations

import time

PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>/test/jitter</title>
</head>
<body>
  <h1 id="hello">Hello</h1>
  <div data-time="{ms}" data-stable="stable content"></div>
  <p>The data-time attribute above changes on every request. Everything
  else is byte-stable. A receipt's dom_region_hash strips data-time before
  hashing, so 5/5 receipts produce byte-identical canonical form. A raw
  HTML capture sees 5 different bytes -> 5 different hashes.</p>
</body>
</html>
"""


def render() -> str:
    return PAGE_TEMPLATE.format(ms=int(time.time() * 1000))


def starlette_app():
    """Run with: uvicorn jitter_endpoint:starlette_app --port 3030"""
    try:
        from starlette.applications import Starlette
        from starlette.responses import HTMLResponse
        from starlette.routing import Route
    except ImportError as exc:
        raise SystemExit(
            "starlette is required for the Starlette adapter — "
            "`pip install starlette uvicorn`, or use the stdlib fallback below."
        ) from exc

    async def jitter(request):
        return HTMLResponse(render())

    return Starlette(routes=[Route("/test/jitter", jitter)])


def stdlib_main(port: int = 3030):
    """Standard-library fallback — no dependencies."""
    import http.server
    import socketserver

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/test/jitter":
                body = render().encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *args, **kwargs):
            return  # silent

    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        print(f"jitter endpoint running on http://127.0.0.1:{port}/test/jitter")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nshutting down")


if __name__ == "__main__":
    # Default: stdlib server (no extra deps required).
    stdlib_main()
