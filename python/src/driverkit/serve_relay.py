"""
Run the relay on its own.

    driverkit-relay
    DK_PORT=7777 driverkit-relay
    python -m driverkit.serve_relay --port 7777

Most deployments should not use this. PROTOCOL.md's argument for SSE is that
the relay belongs inside a server you already run — one real deployment has it in a Rust
kernel — and an extra process is an extra thing to supervise. If you have a
FastAPI, Starlette or Django app, mount :func:`driverkit.asgi.relay_asgi`
instead and the relay shares that process's socket, lifecycle and auth. This
file exists for the case where there is no such server yet: a local dev loop,
or a static page you want to drive today.

Why ``ThreadingHTTPServer`` and not ``HTTPServer``: ``/dk/events`` is a body
that never ends, and ``POST /dk/tabs/:tab/call`` blocks until the tab answers.
On the single-threaded server the first open tab would wedge every other
request forever — the relay would deadlock against itself on the very first
connection, before any agent made a call. One thread per connection is not an
optimisation here, it is the only way the surface works at all.
"""

from __future__ import annotations

import argparse
import os
import select
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from .auth import TabAuth
from .relay import ABORT_BODY, MAX_BODY, Relay, Response, bad_request, too_large

__all__ = ["RelayServer", "serve", "main"]

#: Host values that need no ``allow_remote``, spelled as a person would type one.
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "")

#: Returned by the body readers to mean "this request has already been answered".
#:
#: A sentinel rather than ``None`` because ``None`` is a real body value here —
#: ``_serve(None)`` is how a GET says "there was no body" — and conflating the
#: two would make a 413 or a 400 fall through into the router and be answered
#: twice on one connection.
_ANSWERED: Any = object()

#: The longest chunk-size or trailer line this relay will buffer.
#:
#: A size line is a handful of hex digits; this is generous by three orders of
#: magnitude and exists only so a sender that never sends a newline cannot make
#: the relay buffer until the process dies.
_MAX_FRAMING_LINE = 8 << 10


def _handler_class(relay: Relay) -> type[BaseHTTPRequestHandler]:
    class RelayHTTPRequestHandler(BaseHTTPRequestHandler):
        # HTTP/1.1 so a client may keep the connection alive between the many
        # small requests an agent makes. A streaming response opts out of that
        # per response; see `_stream`.
        protocol_version = "HTTP/1.1"
        server_version = "driverkit-relay"

        def log_message(self, *args: Any) -> None:
            # Silent by default: the paths carry tab ids, and PROTOCOL.md says a
            # tab id is a capability — "do not log it anywhere a tab id becomes
            # a password". An access log of /dk/tabs/<id>/call is exactly that.
            pass

        def do_GET(self) -> None:
            self._serve(None)

        def do_POST(self) -> None:
            body = self._request_body()
            if body is _ANSWERED:
                return
            self._serve(body)  # type: ignore[arg-type]

        def _request_body(self) -> Any:
            """The request body, or :data:`_ANSWERED` when this request is finished.

            Reading the body is not optional even when the route is going to
            refuse the request, and that is the whole reason this is a method
            rather than two lines in ``do_POST``. On a keep-alive connection the
            bytes of an unread body are still in the socket when the next
            request is parsed off it, so they become that request — and a
            browser or a Node client POSTing JSON gets
            ``Parse Error: Expected HTTP/, RTSP/ or ICE/`` on a connection that
            was fine a moment ago. The first request's answer is wrong and
            every later one on that socket is destroyed.

            Which is exactly what ``Transfer-Encoding: chunked`` did here.
            ``Content-Length`` is absent on a chunked request — that is the
            point of chunking — so the old
            ``int(self.headers.get("Content-Length") or 0)`` read ZERO bytes,
            the relay answered a call with no ``name`` (400), and the
            undrained chunk framing was then parsed as the next request.
            ``relay_asgi`` never showed it because an ASGI server de-chunks
            before the app sees a byte; ``http.server`` does not de-chunk
            anything, so the only implementation that had to care is this one.

            Nothing exotic sends chunked, either: any client that streams a
            body without counting it first does, which includes Node's own
            ``http.request`` whenever ``content-length`` is not set by hand —
            and ``packages/driverkit/test/sse-client.ts`` is such a client.
            """
            encodings = [
                part.strip().lower()
                for part in (self.headers.get("Transfer-Encoding") or "").split(",")
                if part.strip()
            ]
            if "chunked" in encodings:
                return self._chunked_body()

            raw = self.headers.get("Content-Length")
            try:
                length = int(raw) if raw is not None and raw != "" else 0
            except ValueError:
                # A length we cannot parse means we cannot know where this body
                # ends, so the connection cannot be reused — there is no way to
                # find the start of the next request. 400 and hang up, for the
                # same reason as unparseable chunk framing below.
                return self._unframable(f"{raw!r} is not a Content-Length")
            if length < 0:
                return self._unframable(f"{raw!r} is not a Content-Length")
            if length > MAX_BODY:
                self._refuse_oversized(length)
                return _ANSWERED
            try:
                body = self.rfile.read(length) if length else b""
            except OSError:
                self.close_connection = True
                return _ANSWERED
            return body

        def _chunked_body(self) -> Any:
            """Decode ``Transfer-Encoding: chunked`` under the same two limits.

            The limits are the interesting part. With a ``Content-Length`` the
            size is known before a byte is read, so :data:`MAX_BODY` is checked
            once up front. Chunked has no length, so the only way to know is to
            add the chunks up as they arrive — which means the decision is
            reached partway through a body that is already being read.

            So, matching :meth:`_refuse_oversized` and
            :func:`driverkit.asgi._read_body` rather than inventing a third
            behaviour: past :data:`MAX_BODY` what has been buffered is dropped
            and the rest is read and counted so the sender gets to READ the
            413, since a sender that takes ECONNRESET instead never learns why
            it failed and retries byte for byte. Past :data:`ABORT_BODY` that
            courtesy is the attack succeeding, so the connection goes.
            """
            kept: list[bytes] = []
            size = 0
            over = False
            while True:
                head = self._framing_line()
                if head is None:
                    return self._unframable("a chunk size line that never ended")
                # Chunk extensions (`1a;name=value`) are legal and carry nothing
                # this relay wants, so they are cut off rather than refused.
                digits = head.split(b";", 1)[0].strip()
                try:
                    chunk = int(digits, 16)
                except ValueError:
                    return self._unframable(f"{digits!r} is not a chunk size")
                if chunk < 0:
                    return self._unframable(f"{digits!r} is not a chunk size")
                if chunk == 0:
                    break
                size += chunk
                if size > ABORT_BODY:
                    self.close_connection = True
                    return _ANSWERED
                if size > MAX_BODY and not over:
                    over = True
                    kept.clear()
                piece = self._read_exactly(chunk, keep=not over)
                if piece is None:
                    # The sender stopped mid-chunk. There is nobody left to
                    # answer and the framing is unrecoverable either way.
                    self.close_connection = True
                    return _ANSWERED
                if not over:
                    kept.append(piece)
                # Every chunk is followed by its own CRLF. A chunk that is not
                # must not be guessed at: the next bytes would be read as a
                # size line and the whole body would shift.
                if self._framing_line() not in (b"", None):
                    return self._unframable("a chunk not terminated by CRLF")

            # Trailers, then the blank line that ends them. Read and discarded:
            # nothing in PROTOCOL.md travels in a trailer, but leaving them in
            # the socket is the same keep-alive corruption as leaving the body.
            while True:
                trailer = self._framing_line()
                if trailer is None:
                    return self._unframable("trailers that never ended")
                if trailer == b"":
                    break

            if over:
                self.close_connection = True
                self._respond(too_large())
                return _ANSWERED
            return b"".join(kept)

        def _framing_line(self) -> bytes | None:
            """One CRLF-terminated framing line without its terminator.

            ``None`` means the line was missing, truncated or absurdly long. The
            cap matters: a sender that never sends a newline would otherwise
            have this method buffer until the process died, and a size line is
            a handful of bytes.
            """
            try:
                line = self.rfile.readline(_MAX_FRAMING_LINE + 1)
            except OSError:
                return None
            if not line or len(line) > _MAX_FRAMING_LINE or not line.endswith(b"\n"):
                return None
            return line.rstrip(b"\r\n")

        def _read_exactly(self, count: int, *, keep: bool) -> bytes | None:
            """``count`` bytes, or ``None`` if the sender stopped first.

            ``keep=False`` counts them and throws them away, so an oversized
            body costs flat memory however big it is — the same trade
            :meth:`_refuse_oversized` makes.
            """
            out = bytearray() if keep else None
            remaining = count
            while remaining > 0:
                try:
                    piece = self.rfile.read(min(remaining, 1 << 16))
                except OSError:
                    return None
                if not piece:
                    return None
                if out is not None:
                    out += piece
                remaining -= len(piece)
            return bytes(out) if out is not None else b""

        def _unframable(self, why: str) -> Any:
            """400 and hang up: a body whose end we cannot find.

            400 rather than 413 or 500 because PROTOCOL.md's split is that a
            400 is a frame no relay could ever have accepted. Framing this
            broken is exactly that, and it is a bug in the sender.

            The connection closes because it has to. Every byte after the point
            the framing stopped making sense is of unknown purpose, so there is
            no position at which to start reading the next request, and a
            keep-alive socket whose next request boundary is unknown can only
            produce nonsense.
            """
            self.close_connection = True
            self._respond(bad_request(400, f"request body framing: {why}"))
            return _ANSWERED

        def _refuse_oversized(self, length: int) -> None:
            """Answer 413 — and make sure the sender can actually read it.

            The obvious implementation answers at once without reading the
            body, and it does not work. The sender is still writing when the
            connection closes, so it takes ECONNRESET/EPIPE on its own socket
            and never reads the response at all. A sender that cannot learn WHY
            it failed retries byte for byte, which is the opposite of what a
            limit is for.

            So the body is read and thrown away first, counted rather than
            buffered so memory stays flat however big it is, and the 413 goes
            out after the last byte has arrived. Above `ABORT_BODY` that
            politeness is the attack succeeding, so there the connection is
            dropped and the sender is left to guess.

            A test with a body just over the limit cannot tell these apart: it
            fits in one socket write, so the sender is finished before the
            response is written and reads it either way. The limit has to be
            exceeded by megabytes for the difference to show up.
            """
            self.close_connection = True
            if length > ABORT_BODY:
                return
            remaining = length
            while remaining > 0:
                try:
                    chunk = self.rfile.read(min(remaining, 1 << 16))
                except OSError:
                    return
                if not chunk:
                    # The sender gave up early. Nothing to answer to.
                    return
                remaining -= len(chunk)
            self._respond(too_large())

        # PUT and DELETE exist only to be refused — `handle` answers 405 on
        # every real route and 404 otherwise — but they still read the body
        # first. A refusal that leaves the body in the socket corrupts the next
        # request on it exactly as the chunked POST did, and "the route said no"
        # is not a reason the connection has to die with it.
        def do_PUT(self) -> None:
            body = self._request_body()
            if body is _ANSWERED:
                return
            self._serve(body)

        def do_DELETE(self) -> None:
            body = self._request_body()
            if body is _ANSWERED:
                return
            self._serve(body)

        def _serve(self, body: bytes | None) -> None:
            split = urlsplit(self.path)
            peer = self.client_address[0] if self.client_address else None
            # `self.headers` is an `email.message.Message`, whose `.items()`
            # yields every copy of a repeated header rather than collapsing
            # them. That matters for `Cookie`, which is the one header that
            # legitimately arrives more than once and the one the browser's
            # credential rides in.
            response = relay.handle(
                self.command, split.path, split.query, body, peer, self.headers.items()
            )
            if response is None:
                # Standalone, so an unknown path IS an error — unlike the
                # embedded case, where `handle` returning None means "not mine,
                # let the app answer".
                self._respond(
                    bad_request(404, "this process serves /dk/* only", error="not-found")
                )
                return
            self._respond(response)

        def _respond(self, response: Response) -> None:
            if response.stream is not None:
                self._stream(response)
                return
            self.send_response(response.status)
            for name, value in response.headers:
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(response.body)))
            self.end_headers()
            self.wfile.write(response.body)

        def _stream(self, response: Response) -> None:
            stream = response.stream
            assert stream is not None
            self.send_response(response.status)
            for name, value in response.headers:
                # The Connection header from SSE_HEADERS is dropped here. An SSE
                # body has no length known up front, and on HTTP/1.1 a body
                # without a Content-Length is delimited by the connection
                # closing — so this response cannot be a keep-alive one however
                # much the generic header wants it to be. A client that waited
                # for a length would hang forever.
                if name.lower() == "connection":
                    continue
                self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

            watcher = threading.Thread(
                target=self._watch_for_hangup, args=(stream,), daemon=True
            )
            watcher.start()
            try:
                for chunk in stream.chunks():
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
                # The peer went away mid-write. That is the ordinary end of a
                # stream, not an error: a person closed a tab.
                pass
            finally:
                stream.close()

        def _watch_for_hangup(self, stream: Any) -> None:
            """Close the stream when the peer hangs up.

            Needed because nothing else notices. The writer above only learns
            of a dead peer when it next writes, and on an idle stream that is
            one ping interval away — twenty seconds in which a closed tab is
            still listed by ``/dk/tabs`` and a call to it waits out the whole
            deadline instead of failing at once as ``tab-went-away``. So one
            thread per stream sits in ``select`` on the socket: a readable
            socket with nothing to read is EOF.

            The 0.25s timeout is not a poll of the peer — ``select`` returns the
            moment the socket becomes readable. It is only so this thread
            notices that the stream ended on its own and exits rather than
            holding a file descriptor open.
            """
            conn = self.connection
            while not stream.closed:
                try:
                    readable, _, _ = select.select([conn], [], [], 0.25)
                except (OSError, ValueError):
                    break
                if not readable:
                    continue
                try:
                    peeked = conn.recv(1, socket.MSG_PEEK)
                except (OSError, ValueError):
                    peeked = b""
                if not peeked:
                    stream.close()
                # Bytes we did not ask for: a pipelined request on a connection
                # that is now a one-way stream. Nothing useful to do with it,
                # and it is not a hangup, so stop watching rather than read it.
                break

    return RelayHTTPRequestHandler


class RelayServer:
    """A running standalone relay. ``serve()`` returns one of these."""

    def __init__(self, server: ThreadingHTTPServer, relay: Relay) -> None:
        self.server = server
        self.relay = relay
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    @property
    def url(self) -> str:
        host = self.server.server_address[0]
        if ":" in str(host):
            host = f"[{host}]"
        return f"http://{host}:{self.port}"

    def start(self) -> "RelayServer":
        """Serve in a background thread and return at once."""
        if self._thread is None:
            self._thread = threading.Thread(
                target=self.server.serve_forever,
                kwargs={"poll_interval": 0.02},
                daemon=True,
            )
            self._thread.start()
        return self

    def serve_forever(self) -> None:
        self.server.serve_forever(poll_interval=0.2)

    def stop(self) -> None:
        """Hang up every stream, then stop listening. Idempotent.

        The relay is closed first on purpose: ``shutdown()`` waits for the
        serving loop, and a thread writing an endless SSE body is not going to
        return until somebody ends that body.
        """
        self.relay.close()
        if self._thread is not None:
            # Only when it is actually serving: `shutdown()` waits for the
            # serving loop to acknowledge, and a loop that never started never
            # will — it would hang here rather than report a misconfiguration.
            self.server.shutdown()
            self._thread.join(timeout=5)
            self._thread = None
        self.server.server_close()


def serve(
    port: int = 7777,
    host: str = "127.0.0.1",
    *,
    timeout_s: float = 15.0,
    ping_s: float = 20.0,
    allow_remote: bool = False,
    auth: TabAuth | None = None,
    resolve_principal: Any = None,
    on_error: Any = None,
    on_audit: Any = None,
    start: bool = True,
) -> RelayServer:
    """Bind a relay to ``host:port``. ``port=0`` takes an ephemeral one.

    Loopback by default, and changing it takes TWO deliberate acts: a host here
    and ``allow_remote`` as well. That is not redundancy. Binding ``0.0.0.0`` is
    something people do by reflex to reach a dev server from a phone; here it
    would publish the ability to drive the logged-in session of whoever has a
    tab open. Requiring the second flag means nobody arrives at a remotely
    drivable browser by muscle memory.

    Raised, not returned, and raised before any socket exists: a
    misconfiguration that surfaced later would be one somebody forgot to check,
    and the failure mode of forgetting is a listening public port.
    """
    # `auth` and `resolve_principal` are passed straight through; `Relay`
    # itself refuses `allow_remote` without one of them, so there is no second
    # copy of that rule to fall out of step with the first.
    if host not in LOOPBACK_HOSTS and not allow_remote:
        raise ValueError(
            f"driverkit: refusing to bind {host} without allow_remote. A reachable relay is "
            "someone else driving your logged-in browser session. Read "
            '"Who is allowed to do this" in PROTOCOL.md, put your app\'s own auth in front of '
            "the relay, then pass allow_remote=True."
        )

    relay = Relay(
        timeout_s=timeout_s,
        ping_s=ping_s,
        allow_remote=allow_remote,
        on_error=on_error,
        # Passed straight through, like `auth`: the relay owns the record's
        # shape and this function owns the socket. See `Relay.__init__`.
        on_audit=on_audit,
        auth=auth,
        resolve_principal=resolve_principal,
    )
    server = ThreadingHTTPServer((host, port), _handler_class(relay))
    # Threads must not outlive the process: a dangling SSE writer would keep a
    # `driverkit-relay` alive after Ctrl-C and look like a hang.
    server.daemon_threads = True
    running = RelayServer(server, relay)
    return running.start() if start else running


def _env_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError:
        raise SystemExit(f"driverkit-relay: {name}={raw!r} is not a number") from None


def main(argv: list[str] | None = None) -> int:
    """The ``driverkit-relay`` console script."""
    parser = argparse.ArgumentParser(
        prog="driverkit-relay",
        description="The driverkit relay: the one place a browser tab and an agent can both reach.",
        epilog="Prefer mounting driverkit.asgi.relay_asgi into a server you already run.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("DK_HOST", "127.0.0.1"),
        help="interface to bind (env DK_HOST, default 127.0.0.1). Anything but loopback "
        "also needs --allow-remote.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("DK_PORT", "7777")),
        help="port to bind (env DK_PORT, default 7777). 0 takes an ephemeral one.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=_env_float("DK_TIMEOUT_S", 15.0),
        help="seconds a call waits for the tab's result (env DK_TIMEOUT_S, default 15)",
    )
    parser.add_argument(
        "--ping",
        type=float,
        default=_env_float("DK_PING_S", 20.0),
        help="seconds between keep-alive comments on an idle stream (env DK_PING_S, default 20)",
    )
    parser.add_argument(
        "--allow-remote",
        action="store_true",
        default=os.environ.get("DK_ALLOW_REMOTE") == "1",
        help="serve callers that are not on loopback (env DK_ALLOW_REMOTE=1). Needs --secret "
        "and --audience: a relay that serves strangers and cannot tell them apart offers "
        "every connected tab to every one of them, so this refuses to start without them.",
    )
    parser.add_argument(
        "--secret",
        default=os.environ.get("DK_SECRET"),
        help="the HMAC key the app's backend mints tab tokens with (env DK_SECRET). "
        "At least 32 bytes. Required with --allow-remote. Prefer the env var: an "
        "argument is visible in `ps` to every user on the box.",
    )
    parser.add_argument(
        "--audience",
        default=os.environ.get("DK_AUDIENCE"),
        help="the audience this relay accepts tokens for (env DK_AUDIENCE). Name it after "
        "the deployment, so a staging token is not a production token.",
    )
    parser.add_argument(
        "--no-anonymous",
        action="store_true",
        default=os.environ.get("DK_NO_ANONYMOUS") == "1",
        help="refuse anonymous credentials (env DK_NO_ANONYMOUS=1). Right for an app where "
        "every user is logged in: an anonymous credential there can only be somebody probing.",
    )
    parser.add_argument(
        "--require-tab-binding",
        action="store_true",
        default=os.environ.get("DK_REQUIRE_TAB_BINDING") == "1",
        help="refuse a tab token that does not name the tab it is for "
        "(env DK_REQUIRE_TAB_BINDING=1).",
    )
    args = parser.parse_args(argv)

    auth: TabAuth | None = None
    if args.secret or args.audience:
        if not args.secret or not args.audience:
            print(
                "driverkit-relay: --secret and --audience go together. The secret verifies a "
                "token; the audience says which relay it was minted for.",
                file=sys.stderr,
            )
            return 2
        try:
            auth = TabAuth(
                secret=args.secret,
                audience=args.audience,
                anonymous=not args.no_anonymous,
                require_tab_binding=args.require_tab_binding,
            )
        except ValueError as err:
            print(str(err), file=sys.stderr)
            return 2

    try:
        running = serve(
            auth=auth,
            port=args.port,
            host=args.host,
            timeout_s=args.timeout,
            ping_s=args.ping,
            allow_remote=args.allow_remote,
            on_error=lambda err: print(f"driverkit relay: {err}", file=sys.stderr),
            start=False,
        )
    except ValueError as err:
        print(str(err), file=sys.stderr)
        return 2
    except OSError as err:
        print(f"driverkit-relay: cannot bind {args.host}:{args.port}: {err}", file=sys.stderr)
        return 2

    # stderr, so stdout stays free for anything a caller wants to pipe.
    print(f"driverkit relay on {running.url}  (tabs: {running.url}/dk/tabs)", file=sys.stderr)
    if args.allow_remote:
        print(
            "driverkit relay: allow_remote is ON. Callers are identified by tab token "
            f"(audience {args.audience!r})"
            + ("; anonymous credentials refused." if args.no_anonymous else "; anonymous allowed.")
            + " Each caller sees only its own tabs.",
            file=sys.stderr,
        )
    elif auth is not None:
        print(
            "driverkit relay: tab tokens required, loopback only.",
            file=sys.stderr,
        )
    try:
        running.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        running.stop()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
