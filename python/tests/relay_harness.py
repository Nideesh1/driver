"""
A browser tab, played by hand, and the two HTTP verbs an agent uses.

Deliberately not :class:`driverkit.Driverkit`. The relay tests must fail when
the relay breaks, and a test that drives both sides of a contract with one
codebase passes happily when both ends agree on the wrong thing — which is how
two implementations of one protocol end up mutually incompatible. So the tab
here is a raw :mod:`http.client` connection reading real chunked SSE, and the
agent's side is raw :mod:`urllib`. ``test_relay_endtoend.py`` does it the other
way on purpose, with the real client against the real relay.

Nothing is mocked at the socket level, for the same reason the TypeScript suite
runs against a real ``node:http`` server: a relay whose correctness is asserted
by calling its internal functions passes with a missing blank line between
frames, and that blank line is the entire framing.
"""

from __future__ import annotations

import http.client
import json
import os
import queue
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit.serve_relay import serve  # noqa: E402

SNAP: dict[str, Any] = {"where": "descents", "rev": 7, "rows": [{"id": "01a2", "lane": "pruning"}]}

HELLO: dict[str, Any] = {
    "app": "toy",
    "title": "Descents — toy",
    "url": "/app/descents",
    "manifest": {
        "version": "abc123",
        "app": "toy",
        "verbs": [{"name": "goto", "describe": "open one"}],
    },
    "snapshot": SNAP,
}


class SseClient:
    """One open SSE stream, parsed on a reader thread.

    Events are buffered per name rather than delivered to a listener
    registered at the right moment. The TypeScript suite registers listeners
    because that is what ``EventSource`` offers; a queue is the same assertion
    without the race, and a dropped frame shows up as a timeout rather than as
    a test that happened to pass.
    """

    def __init__(self, url: str, headers: dict[str, str] | None = None) -> None:
        parts = urllib.parse.urlsplit(url)
        self._conn = http.client.HTTPConnection(parts.hostname or "127.0.0.1", parts.port or 80, timeout=10)
        target = parts.path + (f"?{parts.query}" if parts.query else "")
        self._conn.putrequest("GET", target, skip_accept_encoding=True)
        self._conn.putheader("Accept", "text/event-stream")
        for name, value in (headers or {}).items():
            self._conn.putheader(name, value)
        self._conn.endheaders()
        # Kept before `getresponse`, because the relay answers an SSE request
        # with `Connection: close` and `http.client` reacts by dropping its own
        # reference to the socket — the body keeps arriving through a file
        # object layered over the same descriptor. Without a handle of our own
        # there is then nothing to hang up with, and "the tab closed" becomes
        # untestable.
        self._sock = self._conn.sock
        self.response = self._conn.getresponse()
        self.status = self.response.status
        self.headers = {k.lower(): v for k, v in self.response.getheaders()}
        #: Comment lines, without the leading ``:``. The opening ``driverkit``
        #: and every ``ping`` land here.
        self.comments: list[str] = []
        self._events: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._lock = threading.Lock()
        self.closed = threading.Event()
        self._thread = threading.Thread(target=self._read, daemon=True)
        if self.status == 200:
            self._thread.start()

    def _bucket(self, name: str) -> "queue.Queue[dict[str, Any]]":
        with self._lock:
            return self._events.setdefault(name, queue.Queue())

    def _read(self) -> None:
        name: str | None = None
        data: list[str] = []
        try:
            for raw in self.response:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line.startswith(":"):
                    self.comments.append(line[1:].strip())
                    continue
                if line == "":
                    if data:
                        self._bucket(name or "message").put(json.loads("\n".join(data)))
                    name, data = None, []
                    continue
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "data":
                    data.append(value)
                elif field == "event":
                    name = value
        except (OSError, ValueError, AttributeError, http.client.HTTPException):
            # The socket was pulled out from under this thread, which is the
            # ordinary way an SSE stream ends. `http.client` tears its own
            # buffers down on the way and is not thread-safe about it, hence
            # AttributeError in the list.
            pass
        finally:
            self.closed.set()

    def next_event(self, name: str, timeout: float = 5.0) -> dict[str, Any]:
        try:
            return self._bucket(name).get(timeout=timeout)
        except queue.Empty:
            raise AssertionError(f"no `{name}` frame arrived within {timeout}s") from None

    def seen(self, name: str) -> int:
        return self._bucket(name).qsize()

    def close(self) -> None:
        """Hang up the way a closed tab does: drop the socket, say nothing.

        ``shutdown`` before ``close`` because the reader thread is blocked in
        ``recv`` on this socket, and on macOS closing a descriptor another
        thread is already waiting on does not wake it — the test would then pay
        two seconds per tab to find out the stream it just killed is dead.
        """
        try:
            if self._sock is not None:
                self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        for closeable in (self._sock, self._conn):
            try:
                closeable.close()
            except OSError:
                pass
        self.closed.wait(timeout=2)


class Tab:
    """The tab's half of the protocol: a stream it holds open, and POSTs.

    ``token`` is the credential a page presents. It rides in a HEADER on both
    halves here — the real ``EventSource`` cannot set one and uses a cookie or
    a query parameter instead, and the relay accepts all four, but a test that
    only ever exercised the query parameter would not notice the header path
    breaking. ``cookie=`` and ``query_token=`` cover the other two.
    """

    def __init__(
        self,
        url: str,
        tab_id: str,
        token: str | None = None,
        *,
        cookie: str | None = None,
        query_token: str | None = None,
    ) -> None:
        self.url = url
        self.id = tab_id
        self.token = token
        stream = f"{url}/dk/events?tab={urllib.parse.quote(tab_id, safe='')}"
        if query_token is not None:
            stream += f"&dk_token={urllib.parse.quote(query_token, safe='')}"
        headers: dict[str, str] = {}
        if token is not None:
            headers["X-DK-Token"] = token
        if cookie is not None:
            headers["Cookie"] = f"dk_token={cookie}"
        self.es = SseClient(stream, headers)

    def _post(self, frame: dict[str, Any]) -> tuple[int, Any]:
        return post_json(
            f"{self.url}/dk/result?tab={urllib.parse.quote(self.id, safe='')}",
            frame,
            token=self.token,
        )

    def hello(self, **extra: Any) -> tuple[int, Any]:
        return self._post({"t": "hello", "tab": self.id, **HELLO, **extra})

    def answer(self, call_id: str, result: dict[str, Any]) -> tuple[int, Any]:
        return self._post({"t": "result", "id": call_id, "result": result})

    def push(self, snapshot: dict[str, Any]) -> tuple[int, Any]:
        return self._post({"t": "snapshot", "tab": self.id, "snapshot": snapshot})

    def close(self) -> None:
        self.es.close()


class RawConnection:
    """One keep-alive connection a test drives request by request.

    ``urllib`` opens a fresh connection per request, which is precisely what
    hides the bug this class exists to catch: a body the relay failed to read
    is still in the socket when the NEXT request is parsed off it, so it
    becomes that request. One connection per request means nobody ever sees the
    second request, and the corruption looks like nothing worse than a wrong
    status on the first.

    It also sends ``Transfer-Encoding: chunked`` by hand. ``http.client`` only
    chunks when it is handed a body of unknown length, and spelling the framing
    out here is the point: this is the shape of request that arrives from any
    client that streams a body without counting it first — Node's
    ``http.request`` with no ``content-length`` among them, which is exactly
    what ``packages/relay/test/sse-client.ts`` is.
    """

    def __init__(self, url: str, timeout: float = 10.0) -> None:
        parts = urllib.parse.urlsplit(url)
        self.conn = http.client.HTTPConnection(
            parts.hostname or "127.0.0.1", parts.port or 80, timeout=timeout
        )

    def post_chunked(self, target: str, payload: Any, chunk_size: int = 7) -> tuple[int, Any]:
        """POST ``payload`` as JSON in chunks of ``chunk_size`` bytes.

        Deliberately a tiny chunk size. A single-chunk body is the easy case,
        and a decoder that only ever sees one chunk can be wrong about the CRLF
        that follows each one without anybody noticing; a dozen chunks
        exercises the per-chunk framing the way a real streaming sender does.
        """
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.conn.putrequest("POST", target, skip_accept_encoding=True)
        self.conn.putheader("Content-Type", "application/json")
        self.conn.putheader("Transfer-Encoding", "chunked")
        self.conn.endheaders()
        for at in range(0, len(body), chunk_size):
            piece = body[at : at + chunk_size]
            self.conn.send(b"%x\r\n%s\r\n" % (len(piece), piece))
        self.conn.send(b"0\r\n\r\n")
        return self._read()

    def send_raw(self, target: str, headers: dict[str, str], body: bytes) -> tuple[int, Any]:
        """A request whose framing is exactly these bytes, however broken."""
        self.conn.putrequest("POST", target, skip_accept_encoding=True)
        for name, value in headers.items():
            self.conn.putheader(name, value)
        self.conn.endheaders()
        self.conn.send(body)
        return self._read()

    def get(self, target: str) -> tuple[int, Any]:
        self.conn.putrequest("GET", target, skip_accept_encoding=True)
        self.conn.endheaders()
        return self._read()

    def _read(self) -> tuple[int, Any]:
        response = self.conn.getresponse()
        raw = response.read()  # Fully, so the connection stays reusable.
        return response.status, _loads(raw)

    def close(self) -> None:
        try:
            self.conn.close()
        except OSError:
            pass


def get_json(url: str, token: str | None = None) -> tuple[int, Any]:
    return _request(urllib.request.Request(url, method="GET"), token)


def post_json(url: str, payload: Any, token: str | None = None) -> tuple[int, Any]:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    return _request(request, token)


def _request(request: urllib.request.Request, token: str | None = None) -> tuple[int, Any]:
    """``(status, parsed body)``, with a non-2xx returned rather than raised.

    These tests assert on statuses — 200 for a refusal, 400 for a malformed
    call, 404 for an unknown tab — so an exception on 4xx would hide the thing
    being tested.
    """
    if token is not None:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, _loads(response.read())
    except urllib.error.HTTPError as err:
        with err:
            return err.code, _loads(err.read())


def _loads(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", "replace")


def call_async(url: str, tab_id: str, body: Any, token: str | None = None) -> "Async":
    """Start ``POST /call`` on a thread, because it blocks until the tab answers.

    That blocking is the design — the request does not start the call, it *is*
    the call — so a test that wants to answer it has to be somewhere else.
    """
    return Async(
        lambda: post_json(
            f"{url}/dk/tabs/{urllib.parse.quote(tab_id, safe='')}/call", body, token=token
        )
    )


class Async:
    """A one-shot background call, so a test can be both parties."""

    def __init__(self, fn: Callable[[], Any]) -> None:
        self.value: Any = None
        self.error: BaseException | None = None
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(fn,), daemon=True)
        self._thread.start()

    def _run(self, fn: Callable[[], Any]) -> None:
        try:
            self.value = fn()
        except BaseException as err:  # noqa: BLE001 - re-raised in result()
            self.error = err
        finally:
            self._done.set()

    def result(self, timeout: float = 20.0) -> Any:
        if not self._done.wait(timeout):
            raise AssertionError(f"a background call did not finish within {timeout}s")
        if self.error is not None:
            raise self.error
        return self.value

    @property
    def done(self) -> bool:
        return self._done.is_set()


def wait_for(check: Callable[[], Any], timeout: float = 5.0) -> None:
    """Poll a condition instead of sleeping a guessed interval."""
    until = time.monotonic() + timeout
    while True:
        if check():
            return
        if time.monotonic() > until:
            raise AssertionError("timed out waiting for a condition")
        time.sleep(0.005)


def up(case: Any, **options: Any) -> Any:
    """A relay on an ephemeral port nobody else will touch, torn down after."""
    options.setdefault("ping_s", 20.0)
    running = serve(port=0, host="127.0.0.1", **options)
    case.addCleanup(running.stop)
    return running
