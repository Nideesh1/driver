#!/usr/bin/env python3
"""
One process that does all three jobs this demo needs.

    ANTHROPIC_API_KEY=… python3 examples/contacts/server.py

  1. **Serves the page**, and the library's TypeScript sources with the types
     stripped on the way out, so `index.html` runs with no build step, no
     bundler and no `npm install`. See `tsstrip.py`: a browser cannot remove
     types, so the server does it per request.

  2. **Proxies `/api/chat`** to the Anthropic Messages API, translating
     driverkit's `Think` contract (`{system, tools, messages}`) to and from it.
     The key is read from the environment and never leaves this process: the
     page talks only to `/api/chat`, which is the whole reason
     `driverkit/agent` has no model client in it.

  3. **Mounts the relay** at `/dk`, reusing `driverkit.relay.Relay` through the
     handler `driverkit.serve_relay` already builds — the SSE writer, the
     hangup watcher and the 413 draining are all subtle and already written. So
     the same page is drivable by the corner widget and by an agent in another
     process, with one port and nothing to start twice.

ENVIRONMENT

    ANTHROPIC_API_KEY   required for /api/chat. Never written, never logged,
                        never sent to the browser.
    DK_MODEL            default claude-sonnet-5-5
    DK_LLM_BASE         default https://api.anthropic.com
    DK_LLM_IP           optional: connect to this address instead of resolving
                        the hostname, while keeping the Host header and the TLS
                        SNI on the real hostname so the certificate validates.
                        For shells where DNS does not work.
    DK_MAX_TOKENS       default 2048. Required by the Messages API.
    DK_PORT             default 8770
    DK_HOST             default 127.0.0.1

WHAT IS DELIBERATELY NOT HERE: any state. The relay holds tabs and the page
holds rows; this file holds a socket and a key. A backend that stored the
`messages` it proxies would be storing the app's row data, because the
snapshots are in them.
"""

from __future__ import annotations

import http.client
import json
import mimetypes
import os
import pathlib
import socket
import ssl
import sys
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent

sys.path.insert(0, str(ROOT / "python" / "src"))
sys.path.insert(0, str(HERE))

from driverkit.relay import Relay, Response, bad_request  # noqa: E402
from driverkit.serve_relay import _handler_class  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

from tsstrip import strip_types  # noqa: E402

# --- configuration --------------------------------------------------------

MODEL = os.environ.get("DK_MODEL") or "claude-sonnet-5-5"
LLM_BASE = (os.environ.get("DK_LLM_BASE") or "https://api.anthropic.com").rstrip("/")
LLM_IP = os.environ.get("DK_LLM_IP") or None
MAX_TOKENS = int(os.environ.get("DK_MAX_TOKENS") or "2048")
PORT = int(os.environ.get("DK_PORT") or "8770")
HOST = os.environ.get("DK_HOST") or "127.0.0.1"
ANTHROPIC_VERSION = "2023-06-01"

#: What may be served. A whitelist, not a blocklist: this process can see the
#: whole repository, and `.py`, `.env` and `.git` are all under the same root.
SERVABLE = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".ts": "text/javascript; charset=utf-8",  # stripped on the way out
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
}

JSON_HEADERS = (
    ("Content-Type", "application/json; charset=utf-8"),
    ("Cache-Control", "no-store"),
)


def _json_response(status: int, payload: object) -> Response:
    return Response(
        status=status,
        headers=JSON_HEADERS,
        body=json.dumps(payload).encode("utf-8"),
    )


# --- the Think contract, as the Messages API wants it ---------------------


def to_anthropic_tools(tools: list[dict]) -> list[dict]:
    """`ToolSpec[]` → Anthropic `tools`.

    A rename and nothing else: `ToolSpec.inputSchema` is already a JSON Schema
    object, and the Messages API calls that field `input_schema`. Verb names go
    through verbatim — they are kebab-case by the core's contract, which the
    API's name pattern allows, and renaming them here would break the loop,
    which looks the returned name up in the manifest.

    The LAST tool carries `cache_control`. A cache breakpoint covers everything
    before it in the request, so one marker on the final tool caches the whole
    tool list; the library's cost argument is that this list is byte-identical
    across every turn and every user, and this is where that either pays or
    does not.
    """
    out = []
    for spec in tools:
        schema = spec.get("inputSchema") or {"type": "object", "properties": {}}
        out.append(
            {
                "name": spec.get("name"),
                "description": spec.get("description") or "",
                "input_schema": schema,
            }
        )
    if out:
        out[-1]["cache_control"] = {"type": "ephemeral"}
    return out


def to_anthropic_messages(turns: list[dict]) -> list[dict]:
    """driverkit `Turn[]` → Anthropic `messages`.

    This is the one translation with a real structural gap in it, so it is
    worth being explicit about. driverkit's `Turn` union has three roles and
    the Messages API has two: there is no `role: "tool"`. A tool result is a
    `tool_result` content block inside a **user** message.

    And consecutive tool turns must be MERGED. One assistant turn may emit
    several calls, which arrive here as several `role: "tool"` turns in a row;
    sending them as several user messages is rejected by the API, because each
    one would be a user turn with no assistant turn between. So they collapse
    into one user message with several `tool_result` blocks, in order. The
    merge only happens into a message that is entirely tool results, so a
    person's own text turn is never absorbed into one.
    """
    out: list[dict] = []
    for turn in turns:
        role = turn.get("role")

        if role == "user":
            out.append({"role": "user", "content": [{"type": "text", "text": turn.get("text") or ""}]})
            continue

        if role == "assistant":
            blocks: list[dict] = []
            if turn.get("text"):
                blocks.append({"type": "text", "text": turn["text"]})
            for call in turn.get("calls") or []:
                blocks.append(
                    {
                        "type": "tool_use",
                        # Echoed back exactly. This id is what pairs the result
                        # below with the call above; a rewritten one is a 400
                        # from the API and a silent desync if it were not.
                        "id": call.get("id"),
                        "name": call.get("name"),
                        "input": call.get("args") or {},
                    }
                )
            if blocks:
                out.append({"role": "assistant", "content": blocks})
            continue

        if role == "tool":
            block = {
                "type": "tool_result",
                "tool_use_id": turn.get("callId"),
                "content": turn.get("text") or "",
            }
            if (
                out
                and out[-1]["role"] == "user"
                and all(b.get("type") == "tool_result" for b in out[-1]["content"])
            ):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
            continue

        raise ValueError(f"unknown turn role {role!r}")

    return out


def from_anthropic(body: dict) -> dict:
    """An Anthropic response → `ThinkResult`.

    `text` blocks join; each `tool_use` block becomes a `ToolCall`. `input` is
    already an object here — unlike the OpenAI shape, there is no JSON string
    to parse and therefore no malformed-arguments case to handle.
    """
    texts: list[str] = []
    calls: list[dict] = []
    for block in body.get("content") or []:
        kind = block.get("type")
        if kind == "text":
            if block.get("text"):
                texts.append(block["text"])
        elif kind == "tool_use":
            calls.append(
                {
                    "id": block.get("id"),
                    "name": block.get("name"),
                    "args": block.get("input") or {},
                }
            )
    result: dict = {}
    if texts:
        result["text"] = "\n\n".join(texts)
    if calls:
        result["calls"] = calls
    return result


# --- talking to the model -------------------------------------------------


def _connection(url: str) -> http.client.HTTPConnection:
    """A connection to `url`'s host, optionally pinned to `DK_LLM_IP`.

    The pin exists because name resolution does not work in every shell, and
    `urllib` has no way to say "this host, that address". So the socket is
    opened to the IP by hand and then wrapped with `server_hostname` set to the
    real hostname: the TLS SNI and the certificate check are against the name,
    not the address, so nothing is weakened — only the lookup is skipped.
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    secure = parts.scheme == "https"
    port = parts.port or (443 if secure else 80)

    if not secure:
        return http.client.HTTPConnection(LLM_IP or host, port, timeout=180)

    context = ssl.create_default_context()
    conn = http.client.HTTPSConnection(host, port, context=context, timeout=180)
    if LLM_IP:
        raw = socket.create_connection((LLM_IP, port), timeout=180)
        # `server_hostname` is the name, so SNI and hostname verification both
        # still happen against the real host. Only the DNS step is bypassed.
        conn.sock = context.wrap_socket(raw, server_hostname=host)
    return conn


def ask_model(payload: dict) -> tuple[int, dict]:
    """POST one Messages request. Returns `(status, parsed body)`."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set, so /api/chat has nothing to call. "
            "The page and the relay work without it; the widget does not."
        )

    url = f"{LLM_BASE}/v1/messages"
    parts = urllib.parse.urlsplit(url)
    conn = _connection(url)
    try:
        conn.request(
            "POST",
            parts.path or "/v1/messages",
            body=json.dumps(payload).encode("utf-8"),
            headers={
                # `conn.host` is the real hostname even when the socket went to
                # an IP, so the Host header below is correct either way.
                "Host": parts.hostname or "",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-api-key": key,
                "anthropic-version": ANTHROPIC_VERSION,
                "User-Agent": "driverkit-contacts-example/0",
            },
        )
        response = conn.getresponse()
        raw = response.read()
        status = response.status
    finally:
        conn.close()

    try:
        return status, json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        # The body is included because a proxy in front of the API answers HTML
        # and the shape of it is the only clue to which proxy. Truncated,
        # because an error page can be a megabyte.
        return status, {"error": {"type": "not-json", "message": raw[:400].decode("utf-8", "replace")}}


def log_usage(usage: dict, calls: int, text: bool) -> None:
    """One line per model round trip, naming the cache numbers.

    A deliverable rather than a debug aid. The library's entire cost argument
    is that `system` and `tools` are byte-identical across turns and therefore
    cacheable; `cache_read_input_tokens` climbing while `input_tokens` stays
    small over a multi-step run is that claim being true, and the first turn's
    `cache_creation_input_tokens` is what it cost to make it true.
    """
    print(
        "chat: "
        f"in={usage.get('input_tokens', 0)} "
        f"cache_write={usage.get('cache_creation_input_tokens', 0)} "
        f"cache_read={usage.get('cache_read_input_tokens', 0)} "
        f"out={usage.get('output_tokens', 0)} "
        f"calls={calls} prose={'yes' if text else 'no'}",
        flush=True,
    )


def handle_chat(body: bytes | None) -> Response:
    """`POST /api/chat` — the `Think` endpoint `backendThink` posts to."""
    try:
        ask = json.loads((body or b"{}").decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as err:
        return _json_response(400, {"error": f"the request body is not JSON: {err}"})

    if not isinstance(ask, dict):
        return _json_response(400, {"error": "the request body must be a JSON object"})

    system = ask.get("system") or ""
    tools = ask.get("tools") or []
    messages = ask.get("messages") or []
    if not isinstance(messages, list) or not messages:
        return _json_response(400, {"error": "`messages` must be a non-empty list"})

    try:
        payload = {
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            # A list of blocks rather than a bare string, which is the only
            # shape that can carry a cache breakpoint. Everything before this
            # marker is cached, and `system` is the first thing in the request.
            "system": [
                {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
            ],
            "tools": to_anthropic_tools(tools),
            "messages": to_anthropic_messages(messages),
        }
    except ValueError as err:
        return _json_response(400, {"error": f"cannot translate the conversation: {err}"})

    try:
        status, reply = ask_model(payload)
    except RuntimeError as err:
        print(f"chat: {err}", flush=True)
        return _json_response(503, {"error": str(err)})
    except (OSError, ssl.SSLError) as err:
        # The usual one here is name resolution. Say so, with the fix, rather
        # than letting a socket error reach the browser as a 500.
        hint = (
            f"cannot reach {LLM_BASE}: {err}. "
            "If this is a DNS failure, set DK_LLM_IP to the host's address."
        )
        print(f"chat: {hint}", flush=True)
        return _json_response(502, {"error": hint})

    if status != 200 or "error" in reply:
        detail = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        message = detail.get("message") or json.dumps(reply)[:400]
        kind = detail.get("type") or "http-error"
        # Logged and returned. Nothing from the request headers is in here, so
        # there is no path by which the key reaches the browser or the log.
        print(f"chat: model refused status={status} type={kind}: {message}", flush=True)
        return _json_response(502, {"error": f"the model endpoint answered {status} ({kind}): {message}"})

    result = from_anthropic(reply)
    log_usage(reply.get("usage") or {}, len(result.get("calls") or []), bool(result.get("text")))
    return _json_response(200, result)


# --- serving files --------------------------------------------------------


def resolve(path: str) -> pathlib.Path | None:
    """A URL path to a file inside the repository, or None.

    Both checks matter: `..` is normalised away by `posixpath` before the join,
    and the result is then confirmed to be under the root, which catches a
    symlink pointing out of the tree.
    """
    clean = urllib.parse.unquote(path)
    if "\x00" in clean:
        return None
    parts = [p for p in clean.split("/") if p not in ("", ".", "..")]
    if any(p.startswith(".") for p in parts):
        return None
    target = (ROOT / "/".join(parts)).resolve()
    try:
        target.relative_to(ROOT)
    except ValueError:
        return None
    if target.is_dir():
        target = target / "index.html"
    return target


def handle_static(path: str) -> Response:
    if path.endswith("/"):
        path += "index.html"
    target = resolve(path)
    if target is None or not target.is_file():
        return bad_request(404, f"no file at {path}", error="not-found")

    suffix = target.suffix.lower()
    kind = SERVABLE.get(suffix)
    if kind is None:
        # A whitelist miss is a 403 and not a 404: the file is there and this
        # server is declining to serve it, and saying so is more useful than
        # pretending the repository is smaller than it is.
        return bad_request(403, f"{suffix or 'this file'} is not served", error="forbidden")

    try:
        raw = target.read_bytes()
    except OSError as err:
        return bad_request(500, str(err), error="unreadable")

    if suffix == ".ts":
        # The whole reason this server exists rather than `python3 -m
        # http.server`. The browser asked for a `.ts` URL — the library's own
        # import specifiers say `.ts` — and gets JavaScript back, with the type
        # annotations removed and every newline kept so a stack trace still
        # points at the right line of the real source.
        try:
            raw = strip_types(raw.decode("utf-8")).encode("utf-8")
        except Exception as err:  # noqa: BLE001
            print(f"strip: {target.relative_to(ROOT)}: {err}", flush=True)
            return bad_request(500, f"cannot strip types from {path}: {err}", error="strip-failed")

    return Response(
        status=200,
        headers=(
            ("Content-Type", kind),
            # No caching, so editing a package source and reloading shows it.
            ("Cache-Control", "no-store"),
        ),
        body=raw,
    )


# --- the one handler -----------------------------------------------------


def build_handler(relay: Relay):
    """Extend the relay's own handler rather than reimplementing it.

    `driverkit.serve_relay` already has the parts that are easy to get wrong —
    the SSE writer that flushes per chunk, the thread that notices a hung-up
    peer so a closed tab fails its calls at once instead of waiting out the
    deadline, and the 413 that drains the body first so the sender can read the
    answer. Subclassing keeps all of it and adds two routes.
    """
    base = _handler_class(relay)

    class Handler(base):  # type: ignore[valid-type,misc]
        server_version = "driverkit-contacts"

        def _serve(self, body: bytes | None) -> None:
            split = urllib.parse.urlsplit(self.path)
            path = split.path

            if path.startswith("/dk/"):
                super()._serve(body)
                return

            if path == "/api/chat":
                if self.command != "POST":
                    self._respond(bad_request(405, "POST /api/chat", error="bad-method"))
                    return
                try:
                    self._respond(handle_chat(body))
                except Exception as err:  # noqa: BLE001
                    # Never a traceback to the browser, and never the payload
                    # in the log: the messages carry the app's rows.
                    print(f"chat: unhandled {type(err).__name__}: {err}", flush=True)
                    self._respond(
                        _json_response(500, {"error": f"the chat proxy failed: {type(err).__name__}"})
                    )
                return

            if self.command not in ("GET", "HEAD"):
                self._respond(bad_request(405, "GET or HEAD", error="bad-method"))
                return

            self._respond(handle_static(path))

    return Handler


def main() -> int:
    mimetypes.init()
    relay = Relay(on_error=lambda err: print(f"relay: {err}", flush=True))
    server = ThreadingHTTPServer((HOST, PORT), build_handler(relay))
    server.daemon_threads = True

    base = f"http://{HOST}:{server.server_address[1]}"
    print(f"contacts demo   {base}/examples/contacts/app/")
    print(f"model           {MODEL} via {LLM_BASE}" + (f" pinned to {LLM_IP}" if LLM_IP else ""))
    print(f"api key         {'present' if os.environ.get('ANTHROPIC_API_KEY') else 'MISSING — the widget will report an error'}")
    print(f"relay           mounted at {base}/dk  (tabs: {base}/dk/tabs)")
    print("typescript      stripped per request by tsstrip.py; no build step")
    print("", flush=True)

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        relay.close()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
