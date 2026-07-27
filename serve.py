"""Local dev server for THE HEAT GAUGE sandbox.

Serves the static dashboard AND a tiny Anthropic proxy at /api/trend-summary.

Why the proxy exists: the dashboard is a plain static page with no backend, so
there is nowhere safe to put an API key — anything shipped to the browser is
readable by anyone who opens devtools, and this project directory gets pushed to
GitHub. The rolling 5-day trend summary therefore POSTs its prompt here, and
this process makes the Anthropic call using ANTHROPIC_API_KEY from the
environment (the same variable evening_recap_json_only.py already reads). The
key never reaches the browser.

Usage:
    python serve.py [port]        # defaults to 8000

Bound to 127.0.0.1 only — this is a local dev tool, not a public endpoint.
"""

import functools
import http.server
import json
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

# Only models this dashboard actually asks for, so a tampered client payload
# can't redirect spend onto something else.
ALLOWED_MODELS = {"claude-sonnet-4-6", "claude-haiku-4-5"}
DEFAULT_MODEL = "claude-sonnet-4-6"
MAX_TOKENS_CAP = 400
MAX_PROMPT_CHARS = 20000

_client = None
_client_error = None


def get_client():
    """Lazily build the Anthropic client so the static server still runs without a key."""
    global _client, _client_error
    if _client is not None or _client_error is not None:
        return _client
    try:
        import anthropic
    except ImportError:
        _client_error = "the anthropic package is not installed (pip install anthropic)"
        return None
    if not os.environ.get("ANTHROPIC_API_KEY"):
        _client_error = "ANTHROPIC_API_KEY is not set in this process's environment"
        return None
    try:
        _client = anthropic.Anthropic()
    except Exception as exc:
        _client_error = f"could not create the Anthropic client: {exc}"
    return _client


def summarize(prompt, model, max_tokens):
    client = get_client()
    if client is None:
        return None, _client_error
    try:
        # Thinking off + low effort: this is a 1-2 sentence summarization, and on
        # Sonnet 4.6 max_tokens caps thinking and response text together.
        msg = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            thinking={"type": "disabled"},
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    if msg.stop_reason == "refusal":
        return None, "the model declined this request"
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    return (text or None), (None if text else "the model returned no text")


class Handler(http.server.SimpleHTTPRequestHandler):
    # ── static side ──────────────────────────────────────────────────
    def end_headers(self):
        # No-cache so an edited .jsx/.css shows up on a plain refresh.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def send_head(self):
        for h in ("If-Modified-Since", "If-None-Match"):
            while h in self.headers:
                del self.headers[h]
        return super().send_head()

    # ── proxy side ───────────────────────────────────────────────────
    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/api/trend-summary":
            self.send_error(404, "no such endpoint")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_PROMPT_CHARS * 4:
            self._json(400, {"error": "missing or oversized request body"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._json(400, {"error": "request body is not valid JSON"})
            return

        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            self._json(400, {"error": "no prompt supplied"})
            return
        if len(prompt) > MAX_PROMPT_CHARS:
            self._json(400, {"error": "prompt too long"})
            return
        model = str(payload.get("model") or DEFAULT_MODEL)
        if model not in ALLOWED_MODELS:
            self._json(400, {"error": f"model {model!r} is not allowed"})
            return
        try:
            max_tokens = min(int(payload.get("max_tokens") or 150), MAX_TOKENS_CAP)
        except (TypeError, ValueError):
            max_tokens = 150

        text, err = summarize(prompt, model, max_tokens)
        if text is None:
            # 502: the dashboard treats any non-2xx as "fall back to today's summary".
            sys.stderr.write(f"  trend-summary failed: {err}\n")
            self._json(502, {"error": err or "summary unavailable"})
            return
        self._json(200, {"text": text, "model": model})

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    handler = functools.partial(Handler, directory=ROOT)
    with Server(("127.0.0.1", PORT), handler) as httpd:
        key_state = "ANTHROPIC_API_KEY found" if os.environ.get("ANTHROPIC_API_KEY") \
            else "no ANTHROPIC_API_KEY — trend bar will fall back to the latest daily summary"
        print(f"THE HEAT GAUGE on http://localhost:{PORT}/  ({key_state})", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
