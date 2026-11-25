"""
Mount the relay into a server you already run.

This is the deployment PROTOCOL.md actually recommends, and it matters more
than :mod:`driverkit.serve_relay`. The argument for SSE over WebSocket was that
the relay belongs *inside* an existing server — "write a line, flush" works in
any HTTP library — and an embedded relay inherits that server's socket, its
TLS, its auth, its deploy and its supervision. A second process inherits none
of it and has to be given each one again.

    from fastapi import FastAPI
    from driverkit.relay import Relay
    from driverkit.asgi import relay_asgi

    relay = Relay()
    app = FastAPI()
    app.mount("/dk", relay_asgi(relay))        # or mount at "/" — both work

Written against the ASGI spec by hand, with no Starlette import, because
:mod:`driverkit` promises zero runtime dependencies and a relay that pulled in
a web framework to be embedded in a web framework would be a strange thing to
ship.

TWO THINGS THE SPEC MAKES YOU DO ON PURPOSE:

``Relay.handle`` BLOCKS. A ``POST /dk/tabs/:tab/call`` returns when the tab's
``result`` frame arrives, which is the whole design — the HTTP request does not
start the call, it *is* the call. Calling that from a coroutine directly would
stall the event loop for up to the relay's deadline and take the host app down
with it, so every call goes through :func:`asyncio.to_thread`. That is also why
the relay keeps its own lock rather than assuming one thread.

SSE IS STREAMED, not returned. The body goes out as a sequence of
``http.response.body`` messages with ``more_body: True`` and no
``Content-Length``; a single final message would buffer a stream that never
ends. The peer hanging up arrives as ``http.disconnect`` on ``receive``, which
is what closes the stream — and closing it is what evicts the tab from the
registry and fails its calls in flight as ``tab-went-away`` instead of letting
each sit out its own deadline.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, MutableMapping

from .relay import ABORT_BODY, MAX_BODY, Relay, Response, bad_request, too_large

__all__ = ["relay_asgi"]

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

_PREFIX = "/dk"


def relay_asgi(
    relay: Relay,
    *,
    fallback: ASGIApp | None = None,
    close_on_shutdown: bool = True,
) -> ASGIApp:
    """A plain ASGI 3 application serving the relay's ``/dk/*`` surface.

    ``fallback`` is called for any request the relay does not own, which lets
    this be mounted at ``/`` in front of an app rather than beside it. With no
    fallback a non-``/dk`` path is a 404 — the same choice the standalone server
    makes, and the reason :meth:`Relay.handle` returns ``None`` instead of
    404ing by itself: whether an unknown path is an error is the host's
    business, not the relay's.

    ``close_on_shutdown`` closes the relay on the ASGI ``lifespan.shutdown``
    event, so tabs are hung up and calls in flight fail as ``tab-went-away``
    rather than hanging until the process is killed. Note that most frameworks
    do NOT forward lifespan events into a sub-application mounted with
    ``app.mount(...)``; if you mounted this, call ``relay.close()`` from your
    own shutdown hook.
    """

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope.get("type")

        if kind == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    if close_on_shutdown:
                        await asyncio.to_thread(relay.close)
                    await send({"type": "lifespan.shutdown.complete"})
                    return

        if kind != "http":
            # No WebSocket surface exists, by design: PROTOCOL.md carries these
            # frames on plain chunked HTTP so that both ends need no library.
            if fallback is not None:
                await fallback(scope, receive, send)
                return
            if kind == "websocket":
                await send({"type": "websocket.close", "code": 1000})
            return

        path = _path(scope)
        # The trailing slash is required, exactly as in `Relay.handle`, so a
        # host app that owns `/dk` itself keeps it.
        if not path.startswith(_PREFIX + "/"):
            if fallback is not None:
                await fallback(scope, receive, send)
                return
            await _send_response(
                send, bad_request(404, "this app serves /dk/* only", error="not-found")
            )
            return

        body, over = await _read_body(receive)
        if over:
            # Never handed to the relay. A body this size is a bug or an
            # attack, not a call. The reading of it happens anyway — see
            # `_read_body` — so that the sender gets to read this answer.
            await _send_response(send, too_large())
            return

        client = scope.get("client")
        peer = client[0] if client else None
        query = (scope.get("query_string") or b"").decode("latin-1")
        # ASGI gives headers as a list of raw byte pairs, repeats included,
        # which is exactly the shape `Relay.handle` wants: a repeated `Cookie`
        # (HTTP/2 splits it) must be joined rather than have one copy win, or a
        # jar with several entries silently loses the credential.
        headers = scope.get("headers") or ()

        response = await asyncio.to_thread(
            relay.handle, scope.get("method", "GET"), path, query, body, peer, headers
        )
        if response is None:
            # Unreachable in practice: the prefix test above is the same one
            # `handle` applies. Left as a 404 rather than a fallback because the
            # request body has already been consumed by now, and handing a
            # half-read request to the host app is worse than answering it.
            await _send_response(
                send, bad_request(404, "this app serves /dk/* only", error="not-found")
            )
            return

        if response.stream is None:
            await _send_response(send, response)
            return
        await _send_stream(response, receive, send)

    return app


def _path(scope: Scope) -> str:
    """The path as the relay's router expects it, ``/dk/...``.

    A mount rewrites the scope: the framework matches a prefix, moves it to
    ``root_path`` and leaves the remainder in ``path``, so a request for
    ``/dk/tabs`` arrives here as ``path="/tabs"`` with ``root_path="/dk"``.
    Routing on ``path`` alone would then 404 every request when mounted and
    work perfectly when not, which is the kind of bug that gets diagnosed as
    "the relay is broken" for an afternoon. So the two are rejoined when the
    path alone does not already carry the prefix, and both deployments route the
    same way.
    """
    path = scope.get("path") or "/"
    if path.startswith(_PREFIX):
        return path
    root = (scope.get("root_path") or "").rstrip("/")
    if root:
        joined = root + path
        if joined.startswith(_PREFIX):
            return joined
    return path


async def _read_body(receive: Receive) -> tuple[bytes, bool]:
    """The whole request body, or ``(b"", True)`` once it is over the limit.

    Over the limit it stops BUFFERING but keeps READING, counting the overflow
    instead of keeping it, so memory stays flat however big the upload is and
    the 413 can still be sent once the sender has finished. Answering before
    then is what resets the connection mid-upload, and a sender that takes
    ECONNRESET never reads the status — so it cannot learn why it failed, and
    retries identically.

    Above :data:`ABORT_BODY` that courtesy is the attack succeeding, so the
    draining stops and the response goes out regardless; the ASGI server owns
    the socket from there.
    """
    chunks: list[bytes] = []
    size = 0
    over = False
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return b"", over
        chunk = message.get("body") or b""
        size += len(chunk)
        if size > MAX_BODY:
            over = True
            chunks.clear()
        elif not over:
            chunks.append(chunk)
        if not message.get("more_body") or size > ABORT_BODY:
            break
    return b"".join(chunks), over


async def _send_response(send: Send, response: Response) -> None:
    headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in response.headers]
    headers.append((b"content-length", str(len(response.body)).encode("ascii")))
    await send({"type": "http.response.start", "status": response.status, "headers": headers})
    await send({"type": "http.response.body", "body": response.body, "more_body": False})


async def _send_stream(response: Response, receive: Receive, send: Send) -> None:
    stream = response.stream
    assert stream is not None
    headers = [
        (k.encode("latin-1"), v.encode("latin-1"))
        for k, v in response.headers
        # An ASGI server owns connection management; the spec says not to send
        # hop-by-hop headers and `Connection` is one. The ping comments are what
        # keep this stream alive, not a header.
        if k.lower() != "connection"
    ]
    # No Content-Length on purpose: the length of a stream that never ends is
    # not knowable, and a client that waited for one would hang forever.
    await send({"type": "http.response.start", "status": response.status, "headers": headers})

    hangup = asyncio.ensure_future(_watch_disconnect(receive, stream))
    chunks = stream.chunks()
    try:
        while True:
            # One blocking `next` per chunk, on a worker thread. The generator
            # waits on a queue with a ping timeout, so this is a real block of
            # up to `ping_s` and must not happen on the event loop.
            chunk = await asyncio.to_thread(next, chunks, None)
            if chunk is None:
                break
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
    except (asyncio.CancelledError, OSError):
        raise
    finally:
        # Closing is what evicts the tab and fails its calls in flight at once,
        # so it must happen on every exit path including a cancelled task.
        stream.close()
        hangup.cancel()
        chunks.close()
    await send({"type": "http.response.body", "body": b"", "more_body": False})


async def _watch_disconnect(receive: Receive, stream: Any) -> None:
    """Close the stream when the peer hangs up.

    This is the ASGI equivalent of a socket going readable-at-EOF. Without it
    the writer would only learn of a dead peer when its next write failed,
    which on an idle stream is a ping interval away — twenty seconds in which a
    closed tab is still listed by ``/dk/tabs`` and a call to it waits out the
    whole deadline instead of failing at once.
    """
    try:
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                stream.close()
                return
    except asyncio.CancelledError:
        raise
    except Exception:
        # A server that refuses further `receive` calls after the response
        # started is within its rights; the write path will notice the peer
        # soon enough.
        stream.close()
