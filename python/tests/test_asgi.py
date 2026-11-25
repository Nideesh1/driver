"""
The ASGI adapter, driven by a hand-written ASGI server.

No Starlette, no httpx, no TestClient — the adapter was written against the
spec, so the tests speak the spec: a scope dict, a ``receive`` callable and a
``send`` callable, and the messages they exchange asserted by name. A test that
went through a framework's test client would be asserting that the framework
works, and would hide the two things this adapter has to get right — streaming
a body that never ends, and noticing ``http.disconnect``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit.asgi import relay_asgi
from driverkit.relay import Relay


class Exchange:
    """One ASGI request in flight: the messages in, the messages out."""

    def __init__(self, app, scope: dict) -> None:
        self.incoming: asyncio.Queue = asyncio.Queue()
        self.outgoing: asyncio.Queue = asyncio.Queue()
        # Every ASGI server sends one `http.request` even for a GET with no
        # body. The adapter reads the body before routing, so a harness that
        # skipped this would deadlock on the first request.
        if scope.get("type") == "http":
            self.incoming.put_nowait({"type": "http.request", "body": b"", "more_body": False})
        self.task = asyncio.ensure_future(app(scope, self.incoming.get, self.outgoing.put))

    async def next_message(self, timeout: float = 5.0) -> dict:
        return await asyncio.wait_for(self.outgoing.get(), timeout)

    async def start(self, timeout: float = 5.0) -> dict:
        message = await self.next_message(timeout)
        assert message["type"] == "http.response.start", message
        return message

    async def disconnect(self) -> None:
        await self.incoming.put({"type": "http.disconnect"})

    async def finish(self, timeout: float = 5.0) -> tuple[int, dict[str, str], bytes]:
        """Drain a non-streaming response."""
        start = await self.start(timeout)
        body = b""
        while True:
            message = await self.next_message(timeout)
            body += message.get("body") or b""
            if not message.get("more_body"):
                break
        headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
        return start["status"], headers, body

    def cancel(self) -> None:
        self.task.cancel()


class AsgiTest(unittest.IsolatedAsyncioTestCase):
    ping_s = 0.05

    async def asyncSetUp(self) -> None:
        self.relay = Relay(timeout_s=1.0, ping_s=self.ping_s)
        self.app = relay_asgi(self.relay)
        self.addCleanup(self.relay.close)

    def scope(self, method: str, path: str, *, query: str = "", client=("127.0.0.1", 51000), **extra):
        # A scope's `path` never contains the query string — the server has
        # already split them — so the harness splits one off too, letting a
        # test write the URL the way a client would.
        path, _, inline = path.partition("?")
        query = query or inline
        return {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "path": path,
            "raw_path": path.encode(),
            "query_string": query.encode(),
            "headers": [],
            "client": client,
            "server": ("127.0.0.1", 8000),
            "scheme": "http",
            "root_path": "",
            **extra,
        }

    def post(self, path: str, payload, *, query: str = "", **extra) -> Exchange:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        exchange = Exchange(self.app, self.scope("POST", path, query=query, **extra))
        # Replace the empty request message the harness queued by default.
        exchange.incoming.get_nowait()
        exchange.incoming.put_nowait({"type": "http.request", "body": body, "more_body": False})
        return exchange

    async def get_json(self, path: str, *, query: str = "", **extra):
        status, _headers, body = await Exchange(
            self.app, self.scope("GET", path, query=query, **extra)
        ).finish()
        return status, json.loads(body)

    async def post_json(self, path: str, payload, *, query: str = "", **extra):
        status, _headers, body = await self.post(path, payload, query=query, **extra).finish()
        return status, json.loads(body)


class Routing(AsgiTest):
    async def test_the_relay_surface_is_served_through_a_plain_asgi_callable(self):
        status, body = await self.get_json("/dk/tabs")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"tabs": []})

    async def test_a_mounted_app_routes_exactly_as_an_unmounted_one_does(self):
        # `app.mount("/dk", relay_asgi(relay))` rewrites the scope: the matched
        # prefix moves to root_path and `path` holds the remainder. Routing on
        # `path` alone would 404 every request when mounted and work perfectly
        # when not, which is the kind of bug that gets diagnosed as "the relay
        # is broken" for an afternoon.
        status, body = await self.get_json("/tabs", root_path="/dk")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"tabs": []})

        status, _ = await self.get_json("/", root_path="/dk")
        self.assertEqual(status, 404, "the bare prefix is not a relay route")

    async def test_a_path_the_relay_does_not_own_is_a_404_or_the_fallback(self):
        status, body = await self.get_json("/app/descents")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "not-found")

        seen: list[str] = []

        async def fallback(scope, receive, send):
            seen.append(scope["path"])
            await send({"type": "http.response.start", "status": 418, "headers": []})
            await send({"type": "http.response.body", "body": b"mine"})

        app = relay_asgi(self.relay, fallback=fallback)
        status, _headers, body = await Exchange(app, self.scope("GET", "/app/descents")).finish()
        # Mounting at "/" in front of an app, rather than beside it: the relay
        # takes /dk/* and hands everything else along untouched.
        self.assertEqual((status, body, seen), (418, b"mine", ["/app/descents"]))

    async def test_the_loopback_guard_reads_the_peer_out_of_the_scope(self):
        # Per request, not per bind. An embedded relay does not own the socket,
        # so this is the only place the check can live.
        status, body = await self.get_json("/dk/tabs", client=("10.0.0.5", 4000))
        self.assertEqual(status, 403)
        self.assertEqual(body["error"], "forbidden")

        # A scope with no `client` is a peer the relay cannot identify — a Unix
        # socket, or a proxy that dropped the address. "Cannot tell" must not
        # resolve to "allowed".
        status, _ = await self.get_json("/dk/tabs", client=None)
        self.assertEqual(status, 403)

    async def test_a_body_over_the_limit_never_reaches_the_relay(self):
        huge = b'{"name":"goto","pad":"' + b"x" * (6 << 20) + b'"}'
        status, _headers, body = await self.post("/dk/tabs/t1/call", huge).finish()
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)["error"], "too-large")

    async def test_an_oversized_body_is_drained_not_buffered(self):
        # Over the limit the adapter stops keeping the bytes and keeps reading
        # them, so the sender reaches `end` and gets to read the 413. The proof
        # it is not buffering is that the overflow arrives in many messages and
        # the answer is still the pinned one.
        exchange = Exchange(self.app, self.scope("POST", "/dk/tabs/t1/call"))
        exchange.incoming.get_nowait()
        for _ in range(8):
            exchange.incoming.put_nowait(
                {"type": "http.request", "body": b"x" * (1 << 20), "more_body": True}
            )
        exchange.incoming.put_nowait({"type": "http.request", "body": b"x", "more_body": False})
        status, _headers, body = await exchange.finish()
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)["error"], "too-large")
        # And the relay never saw a call: a body this size is a bug or an
        # attack, not a verb.
        self.assertEqual(self.relay.tabs(), [])

    async def test_lifespan_shutdown_closes_the_relay(self):
        # So a reload hangs up the tabs and fails calls in flight as
        # `tab-went-away`, rather than leaving an agent waiting on a process
        # that is already gone.
        exchange = Exchange(self.app, {"type": "lifespan", "asgi": {"version": "3.0"}})
        await exchange.incoming.put({"type": "lifespan.startup"})
        self.assertEqual((await exchange.next_message())["type"], "lifespan.startup.complete")
        await exchange.incoming.put({"type": "lifespan.shutdown"})
        self.assertEqual((await exchange.next_message())["type"], "lifespan.shutdown.complete")
        status, _ = await self.get_json("/dk/tabs")
        self.assertEqual(status, 503)


class Streaming(AsgiTest):
    async def events(self, tab_id: str) -> Exchange:
        exchange = Exchange(self.app, self.scope("GET", "/dk/events", query=f"tab={tab_id}"))
        self.addCleanup(exchange.cancel)
        start = await exchange.start()
        self.assertEqual(start["status"], 200)
        headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
        # No length, because the length of a stream that never ends is not
        # knowable, and a client that waited for one would hang forever.
        self.assertNotIn("content-length", headers)
        self.assertEqual(headers["content-type"], "text/event-stream; charset=utf-8")
        # And no hop-by-hop `Connection` header: an ASGI server owns connection
        # management, and the spec says not to send one.
        self.assertNotIn("connection", headers)
        first = await exchange.next_message()
        # Streamed, one message per chunk, with more_body set. A single final
        # message would buffer a body that never ends.
        self.assertTrue(first["more_body"])
        self.assertEqual(first["body"], b": driverkit\n\n")
        return exchange

    async def next_frame(self, exchange: Exchange, name: str, timeout: float = 5.0) -> dict:
        """The next named SSE frame, skipping the ping comments."""
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            message = await exchange.next_message(max(0.1, deadline - asyncio.get_running_loop().time()))
            text = (message.get("body") or b"").decode()
            if text.startswith(f"event: {name}"):
                return json.loads(text.split("data: ", 1)[1])

    async def test_an_idle_stream_keeps_getting_ping_comments(self):
        exchange = await self.events("t1")
        message = await exchange.next_message()
        self.assertEqual(message["body"], b": ping\n\n")

    async def test_a_whole_call_round_trip_goes_through_the_adapter(self):
        exchange = await self.events("t1")
        status, _ = await self.post_json(
            "/dk/result", {"t": "hello", "tab": "t1", "app": "toy", "snapshot": {"where": "x", "rev": 1}}
        )
        self.assertEqual(status, 202)
        self.assertEqual([t["tab"] for t in self.relay.tabs()], ["t1"])

        # The call blocks on a worker thread while this loop keeps serving the
        # stream and the tab's POST. If `handle` ran on the event loop instead,
        # the answer could never arrive and every call would time out.
        pending = asyncio.ensure_future(self.post_json("/dk/tabs/t1/call", {"name": "goto", "rev": 1}))
        frame = await self.next_frame(exchange, "call")
        self.assertEqual((frame["name"], frame["rev"]), ("goto", 1))

        answer = {"ok": True, "snapshot": {"where": "descent", "rev": 2}}
        await self.post_json("/dk/result?tab=t1", {"t": "result", "id": frame["id"], "result": answer})
        status, body = await pending
        self.assertEqual((status, body), (200, answer))

    async def test_a_disconnect_evicts_the_tab_and_fails_calls_in_flight_at_once(self):
        exchange = await self.events("t1")
        pending = asyncio.ensure_future(self.post_json("/dk/tabs/t1/call", {"name": "goto"}))
        await self.next_frame(exchange, "call")

        # `http.disconnect` is the ASGI shape of a peer hanging up. Without
        # acting on it the writer would only notice on its next write — a ping
        # interval away — and a call would sit out its whole deadline for an
        # answer nobody was going to send.
        await exchange.disconnect()
        status, body = await asyncio.wait_for(pending, 3.0)
        self.assertEqual(status, 200)
        self.assertEqual(body["refused"], "tab-went-away")
        self.assertNotIn("snapshot", body)
        self.assertEqual(self.relay.tabs(), [])

    async def test_watch_streams_through_the_adapter_too(self):
        await self.events("watched")
        await self.post_json(
            "/dk/result?tab=watched",
            {"t": "hello", "tab": "watched", "snapshot": {"where": "descents", "rev": 7}},
        )
        watcher = Exchange(self.app, self.scope("GET", "/dk/tabs/watched/watch"))
        self.addCleanup(watcher.cancel)
        self.assertEqual((await watcher.start())["status"], 200)
        self.assertEqual((await watcher.next_message())["body"], b": driverkit\n\n")
        # The screen the watcher attached to arrives at once, so it never has
        # to fetch /snapshot — which is the poll this endpoint exists to remove.
        self.assertEqual((await self.next_frame(watcher, "snapshot"))["snapshot"]["rev"], 7)

        await self.post_json(
            "/dk/result?tab=watched",
            {"t": "snapshot", "tab": "watched", "snapshot": {"where": "descent", "rev": 8}},
        )
        self.assertEqual((await self.next_frame(watcher, "snapshot"))["snapshot"]["rev"], 8)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class Credentials(unittest.IsolatedAsyncioTestCase):
    """The adapter must carry the headers, because this is the real deployment.

    PROTOCOL.md argues the relay belongs inside a server you already run, and in
    Python that is an ASGI app. A relay whose headers only reached it through
    ``http.server`` would authenticate nobody in the deployment it recommends.
    """

    async def asyncSetUp(self) -> None:
        from driverkit.auth import TabAuth

        self.auth = TabAuth(secret="z" * 40, audience="asgi-test")
        self.relay = Relay(timeout_s=1.0, ping_s=20.0, auth=self.auth)
        self.addCleanup(self.relay.close)
        self.app = relay_asgi(self.relay, close_on_shutdown=False)

    def scope(self, headers: list[tuple[bytes, bytes]]):
        return {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "path": "/dk/tabs",
            "raw_path": b"/dk/tabs",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 51000),
            "server": ("127.0.0.1", 8000),
            "scheme": "http",
            "root_path": "",
        }

    async def get(self, headers):
        status, _h, body = await Exchange(self.app, self.scope(headers)).finish()
        return status, json.loads(body)

    async def test_a_bearer_token_in_the_asgi_scope_identifies_the_caller(self):
        token = self.auth.mint("user:alice").encode()
        status, body = await self.get([(b"authorization", b"Bearer " + token)])
        self.assertEqual((status, body), (200, {"tabs": []}))

        status, body = await self.get([])
        self.assertEqual((status, body["error"]), (401, "no-credential"))

    async def test_a_repeated_cookie_header_is_joined_rather_than_having_one_win(self):
        # HTTP/2 splits `Cookie` into one header per pair, and some proxies pass
        # the split through. Keeping only the first copy would silently drop the
        # credential in a jar with several entries — a bug that appears only in
        # production, only for users with other cookies set.
        token = self.auth.mint("user:alice")
        status, body = await self.get(
            [
                (b"cookie", b"theme=dark"),
                (b"cookie", f"dk_token={token}".encode()),
                (b"cookie", b"seen=1"),
            ]
        )
        self.assertEqual((status, body), (200, {"tabs": []}))

    async def test_a_header_name_in_any_case_is_read(self):
        # ASGI lowercases by spec, but nothing in the relay should depend on a
        # server having done so.
        token = self.auth.mint("user:alice").encode()
        status, _ = await self.get([(b"X-DK-Token", token)])
        self.assertEqual(status, 200)
