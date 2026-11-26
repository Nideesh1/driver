"""
A fake relay, served over real HTTP on an ephemeral port.

Nothing is mocked at the ``urllib`` level on purpose. The client's job is
almost entirely "speak HTTP correctly", so a test that patches out HTTP tests
the half that was never in doubt and would pass just as happily against a
client that sent the wrong method, forgot the content type, mishandled a
chunked SSE body, or read an outcome off a status code.

The tab behind it is a small port of the toy app in
``packages/driverkit/test/registry.test.ts`` — two descents, a lane each, one row
per page, and the rule that a machine may not move a descent out of
``pruning``. Reusing that app means the Python tests pin the same behaviours
the TypeScript tests pin, rather than a second, friendlier fiction. Two verbs
are added that the TS toy does not have, ``select-where`` and
``accept-selected``, because the ``describe``/``commit`` pairing is the thing
``kind`` and ``count`` exist for and it cannot be exercised without a pair.
"""

from __future__ import annotations

import json
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TAB = "01a2-tab"
PAGE = 1

MANIFEST = {
    "version": "deadbeef0001",
    "app": "toy",
    "verbs": [
        {
            "name": "goto",
            "describe": "open a descent",
            "kind": "describe",
            "args": {"id": {"type": "string", "describe": "descent id"}},
            "refuses": ["no-such-descent"],
        },
        {
            "name": "select-where",
            "describe": "select every descent in a lane",
            # The predicate goes in and the count comes back. The agent never
            # learns an id it did not need, and never makes a call per row.
            "kind": "describe",
            "args": {
                "lane": {
                    "type": "string",
                    "describe": "lane to select",
                    "oneOf": ["doing", "pruning", "held"],
                },
                "limit": {"type": "number", "describe": "stop after this many", "optional": True},
            },
        },
        {
            "name": "accept-selected",
            # Takes NO predicate: it acts on whatever select-where selected, so
            # a count is always seen before data moves.
            "describe": "accept every selected descent",
            "kind": "commit",
            "refuses": ["nothing-selected"],
        },
        {
            "name": "set-lane",
            "describe": "move a descent to a lane",
            "kind": "commit",
            "args": {
                "id": {"type": "string", "describe": "descent id"},
                "lane": {
                    "type": "string",
                    "describe": "target lane",
                    "oneOf": ["doing", "pruning", "held"],
                },
                "because": {
                    "type": "string",
                    "describe": "why, for the audit log",
                    "optional": True,
                },
            },
            "refuses": ["no-such-descent", "machine-may-not-leave-pruning"],
        },
        {"name": "scroll", "describe": "show the next page of rows", "kind": "read"},
        {
            "name": "set-zoom",
            "describe": "zoom the board",
            "kind": "read",
            "args": {"factor": {"type": "number", "describe": "1 is normal"}},
        },
        # No `kind`: an app written before the field existed. The client must
        # make no safety claim about it in either direction.
        {"name": "refresh", "describe": "reload the board"},
    ],
}


class Tab:
    """The toy app's live state, and the verb bodies that move it."""

    def __init__(self) -> None:
        self.lanes = {"01a2": "pruning", "01b7": "doing"}
        self.accepted: list[str] = []
        self.rev = 1
        self.where = "descents"
        self.selected: list[str] = []
        self.page_index = 0

    def snapshot(self) -> dict:
        ids = list(self.lanes)
        start = self.page_index * PAGE
        snap = {
            "where": self.where,
            "rev": self.rev,
            "rows": [{"id": i, "lane": self.lanes[i]} for i in ids[start : start + PAGE]],
            "page": {"index": self.page_index, "size": PAGE, "total": len(ids)},
        }
        if self.selected:
            snap["selected"] = list(self.selected)
        return snap

    def call(self, name: str, args: dict, rev: int | None) -> dict:
        def no(refused: str, hint: str | None, snapshot: dict) -> dict:
            out = {"ok": False, "refused": refused, "snapshot": snapshot}
            if hint is not None:
                out["hint"] = hint
            return out

        verb = next((v for v in MANIFEST["verbs"] if v["name"] == name), None)
        if verb is None:
            known = ", ".join(sorted(v["name"] for v in MANIFEST["verbs"]))
            return no("unknown-verb", f"no verb named `{name}`. known: {known}", self.snapshot())

        before = self.snapshot()
        # Staleness first, exactly as the core does it: if the screen moved, an
        # argument complaint would describe a row the agent never saw.
        if rev is not None and rev != before["rev"]:
            return no("stale", f"you acted on rev {rev} but the screen is at rev {before['rev']}; read again", before)

        for arg_name, spec in (verb.get("args") or {}).items():
            value = args.get(arg_name)
            if value is None:
                if not spec.get("optional"):
                    return no("bad-argument", f"missing argument `{arg_name}`", before)
                continue
            if "oneOf" in spec and value not in spec["oneOf"]:
                accepted = ", ".join(json.dumps(v) for v in spec["oneOf"])
                return no("bad-argument", f"argument `{arg_name}` must be one of {accepted}", before)

        if name == "goto":
            if args["id"] not in self.lanes:
                return no("no-such-descent", f"no descent `{args['id']}`", before)
            self.where = f"descent {args['id']}"
            self.selected = [args["id"]]
            self.rev += 1
        elif name == "select-where":
            matching = [i for i, lane in self.lanes.items() if lane == args["lane"]]
            limit = int(args["limit"]) if args.get("limit") is not None else len(matching)
            self.selected = matching[:limit]
            self.rev += 1
            # The count is the point of the verb, and it reports what it
            # MATCHED, which may exceed what it selected under a limit.
            return {
                "ok": True,
                "count": len(matching),
                "note": f"{len(self.selected)} selected of {len(matching)} matching",
                "snapshot": self.snapshot(),
            }
        elif name == "accept-selected":
            if not self.selected:
                return no("nothing-selected", "select something first", before)
            self.accepted += self.selected
            self.rev += 1
        elif name == "set-lane":
            if args["id"] not in self.lanes:
                return no("no-such-descent", f"no descent `{args['id']}`", before)
            if self.lanes[args["id"]] == "pruning" and args["lane"] != "pruning":
                return no(
                    "machine-may-not-leave-pruning",
                    "pruning is the human gate; only a person moves a descent out of it",
                    before,
                )
            self.lanes[args["id"]] = args["lane"]
            self.rev += 1
        elif name == "scroll":
            if (self.page_index + 1) * PAGE < len(self.lanes):
                self.page_index += 1
                self.rev += 1
        elif name in ("set-zoom", "refresh"):
            self.rev += 1

        return {"ok": True, "snapshot": self.snapshot()}


class FakeRelay:
    """Serves the five agent-facing endpoints, plus knobs for the failure paths
    a client has to survive."""

    def __init__(self) -> None:
        self.tab = Tab()
        self.hits: Counter[str] = Counter()
        self.last_body: dict | None = None
        #: The request headers of the most recent request, so a test can check
        #: what the client asked for and not merely which path it hit.
        self.last_headers: dict[str, str] = {}
        #: "ok" | "garbage" (valid HTTP, invalid JSON) | "wrong-shape" (200,
        #: JSON, not one of our shapes) | "500" (no WireResult in the body) |
        #: "refusal-on-409" (a relay wrongly using 4xx to mean "the app said
        #: no", which the status contract forbids) | "timeout" |
        #: "tab-went-away" | "no-such-tab" (the three relay refusals, forced on
        #: a tab that does exist, so a test can reach them with a manifest
        #: already loaded)
        self.mode = "ok"
        #: The specified listing is the {"tabs": [...]} envelope. A bare array
        #: is what a relay written against the earlier prose would send.
        self.tabs_envelope = True
        #: Frames the /watch stream writes, then closes.
        self.watch_frames: list[str] = []

        relay = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # keep the test output readable
                pass

            def _send(self, code: int, payload, raw: bytes | None = None):
                body = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _send_sse(self, frames: list[str]):
                # No Content-Length: an SSE body is a stream whose length is
                # not known up front, so the connection closing is what ends
                # it. A client that waited for a length would hang forever.
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                for frame in frames:
                    self.wfile.write(frame.encode())
                    self.wfile.flush()
                self.close_connection = True

            def do_GET(self):
                relay.hits[self.path] += 1
                relay.last_headers = {k.lower(): v for k, v in self.headers.items()}
                if relay.mode == "garbage":
                    return self._send(200, None, raw=b"<html>not json at all</html>")
                if relay.mode == "wrong-shape":
                    # 200, valid JSON, not one of our shapes: something that is
                    # answering on this port but is not a driverkit relay.
                    return self._send(200, {"hello": "world"})
                if relay.mode == "500":
                    return self._send(500, {"error": "boom"})
                if self.path == "/dk/tabs":
                    rows = [
                        {
                            "tab": TAB,
                            "app": "toy",
                            "title": "Descents — toy",
                            "url": "/app/descents",
                            "manifestVersion": MANIFEST["version"],
                            "rev": relay.tab.rev,
                            "since": "2026-11-25T18:04:11Z",
                        },
                        {
                            "tab": "other-tab",
                            "app": "toy",
                            "title": "Settings — toy",
                            "url": "/app/settings",
                            "manifestVersion": "cafe00000002",
                            "rev": 3,
                            "since": "2026-11-25T18:05:02Z",
                        },
                    ]
                    return self._send(200, {"tabs": rows} if relay.tabs_envelope else rows)
                if self.path == f"/dk/tabs/{TAB}/manifest":
                    return self._send(200, MANIFEST)
                if self.path == f"/dk/tabs/{TAB}/snapshot":
                    return self._send(200, relay.tab.snapshot())
                if self.path == f"/dk/tabs/{TAB}/watch":
                    return self._send_sse(relay.watch_frames)
                return self._send(404, {"error": "no such path"})

            def do_POST(self):
                relay.hits[self.path] += 1
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                relay.last_body = body

                if not self.path.startswith("/dk/tabs/") or not self.path.endswith("/call"):
                    return self._send(404, {"error": "no such path"})
                if self.path != f"/dk/tabs/{TAB}/call":
                    # A relay refusal: the shape holds and `snapshot` is absent,
                    # because nothing ran and nobody looked.
                    return self._send(200, {"ok": False, "refused": "no-such-tab"})
                if relay.mode in ("timeout", "tab-went-away", "no-such-tab"):
                    hints = {
                        "timeout": "the tab did not answer within 15s",
                        "tab-went-away": "the stream closed before the answer came back",
                        "no-such-tab": "no tab with that id is connected",
                    }
                    return self._send(
                        200, {"ok": False, "refused": relay.mode, "hint": hints[relay.mode]}
                    )

                result = relay.tab.call(body.get("name"), body.get("args") or {}, body.get("rev"))
                status = 409 if relay.mode == "refusal-on-409" and not result["ok"] else 200
                return self._send(status, result)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        # A short poll interval only so `shutdown()` returns promptly: the
        # default 0.5s is paid once per test and turns a fast suite into a slow
        # one for no reason.
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def snapshot_frame(where: str, rev: int) -> str:
    """One `snapshot` push frame, in the shape the frames section gives."""
    payload = {"t": "snapshot", "snapshot": {"where": where, "rev": rev, "rows": []}}
    return f"data: {json.dumps(payload)}\n\n"
