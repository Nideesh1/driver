"""
driverkit — the client for the relay's agent-facing HTTP surface.

Five calls, exactly the five in PROTOCOL.md's "The HTTP surface the agent
uses". There is deliberately nothing else: the two remaining endpoints
(``/dk/events``, ``/dk/result``) belong to the tab, and a client that reached
for them would be impersonating the browser rather than driving it.

Synchronous on purpose. A human-driven session makes a handful of calls a
minute and every call is a round trip the agent is waiting on anyway, so an
event loop would buy nothing and cost every caller a colour.

The error policy is the one decision worth reading before using this:

    A refusal is a value. A transport failure is an exception.

``call()`` returns ``Result(ok=False, refused=...)`` for every answer the tab
actually gave — stale, bad-argument, unknown-verb, a business rule saying no.
Those are outcomes an agent is expected to handle, and the TS core already
refuses to raise for them (see ``Result`` in types.ts and the test named "a
refusal is an ordinary result, not an exception"). Raising here would re-break
that at the language boundary and push every caller into a try/except around
the app's own business rules. What does raise is the relay being unreachable or
answering with something that is not a Result — because there is then no
outcome to report, only a broken pipe.

A relay refusal sits between the two and is a third thing: ``no-such-tab``,
``tab-went-away`` and ``timeout`` arrive as ordinary ``WireResult`` bodies, so
they are returned rather than raised, but their ``snapshot`` is absent because
nothing ran and nobody looked. ``Result.relay_refusal`` names them and
``Result.landed`` / ``Result.outcome_unknown`` say what a caller may conclude.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator, Mapping

from .types import Manifest, Result, Scalar, Snapshot, Tab

__all__ = ["Driverkit", "DriverkitError", "TransportError", "ProtocolError"]

DEFAULT_TIMEOUT = 15.0


class DriverkitError(Exception):
    """Base class, so a caller can catch everything this module raises."""


class TransportError(DriverkitError):
    """The relay could not be reached, or answered with an HTTP error that
    carried no Result."""


class ProtocolError(DriverkitError):
    """The relay answered, but not with something this client can read:
    malformed JSON, or JSON of the wrong shape."""


class Driverkit:
    """A client for one relay.

    ``relay_url`` is the relay's base URL (``http://127.0.0.1:7777``). The
    ``/dk`` prefix belongs to the protocol, not the deployment, so it is added
    here and a caller never writes it.

    ``token`` is a tab token, minted by the app's backend, naming the person
    whose tabs this client may see. It is sent as ``Authorization: Bearer`` and
    it is what makes ``tabs()`` list that person's tabs and nobody else's. A
    relay with no auth configured — the unconfigured loopback one — needs none,
    which is why this is optional and why omitting it is the dev-loop path.

    A token minted with a ``tab`` claim narrows this client to that one tab:
    ``tabs()`` then lists only it and every other call refuses anything else as
    ``no-such-tab``. That is the right credential for an MCP server configured
    to drive one known tab, and it is free there, because the tab id is already
    in its configuration.

    A token expires. This client does not refresh one — it has no way to mint —
    so a long-lived process should pass a fresh ``Driverkit`` or set
    ``client.token`` when its own session management says to. A lapsed token
    arrives as :class:`TransportError` on an HTTP 401, which is a transport
    failure and not a refusal: nothing was asked of any tab.

    ``headers`` is anything else the app in front of the relay requires.
    """

    def __init__(
        self,
        relay_url: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        token: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.relay_url = relay_url.rstrip("/")
        self.timeout = timeout
        self.token = token
        self.headers = dict(headers or {})

    # ---- the four endpoints ------------------------------------------------

    def tabs(self) -> list[Tab]:
        """``GET /dk/tabs`` — the connected tabs.

        The specified shape is the ``{"tabs": [...]}`` envelope, so that a
        later field can be added beside ``tabs`` without breaking a parser. A
        bare list is also accepted, for relays written against the earlier
        prose, which named this endpoint's columns but not its envelope.
        """
        body = self._get("/dk/tabs")
        if isinstance(body, Mapping):
            body = body.get("tabs", [])
        if not isinstance(body, list):
            raise ProtocolError(f"GET /dk/tabs: expected a list of tabs, got {type(body).__name__}")
        return [Tab.from_dict(t) for t in body if isinstance(t, Mapping)]

    def manifest(self, tab: str) -> Manifest:
        """``GET /dk/tabs/:tab/manifest`` — the static half. Cache it; the
        ``version`` field is how you find out you may not any more."""
        body = self._get(f"/dk/tabs/{urllib.parse.quote(tab, safe='')}/manifest")
        if not isinstance(body, Mapping) or "verbs" not in body:
            raise ProtocolError("manifest response is not a Manifest")
        return Manifest.from_dict(body)

    def snapshot(self, tab: str) -> Snapshot:
        """``GET /dk/tabs/:tab/snapshot`` — the dynamic half. Never cache it:
        a person at the keyboard can move the screen between any two calls."""
        body = self._get(f"/dk/tabs/{urllib.parse.quote(tab, safe='')}/snapshot")
        if not isinstance(body, Mapping) or "rev" not in body:
            raise ProtocolError("snapshot response is not a Snapshot")
        return Snapshot.from_dict(body)

    def watch(self, tab: str, *, timeout: float | None = None) -> Iterator[Snapshot]:
        """``GET /dk/tabs/:tab/watch`` — snapshots as they happen, as an
        iterator that blocks between them.

        This is the agent's end of the ``snapshot`` push frame. Without it that
        frame reaches the relay and stops there, and the shared-presence case
        it exists for — a human and an agent watching one screen — is
        unreachable through a request/response surface. Polling ``snapshot()``
        is the lower-effort alternative and is right for a script that acts and
        stops; it is wrong for an agent sitting beside a person, which would
        have to poll fast to feel live and pay for every poll.

        ::

            for screen in dk.watch(tab):
                print(screen.where, screen.rev)   # the person just moved

        ``timeout`` is the socket read timeout and defaults to **None**, not to
        the client's usual one. A live stream is idle most of the time by
        design, so the ordinary timeout would tear it down between two of the
        person's clicks. The relay's 20s ping comments are what prove it is
        still there; pass a timeout comfortably above that interval if you want
        a dead-connection deadline, and expect ``TransportError``.

        The iterator ends when the relay closes the stream. It does not
        reconnect: an agent that reconnects silently can be watching a screen
        for minutes after the tab it cared about went away, and "the stream
        ended" is information its caller needs.
        """
        request = urllib.request.Request(
            self.relay_url + f"/dk/tabs/{urllib.parse.quote(tab, safe='')}/watch",
            method="GET",
        )
        request.add_header("Accept", "text/event-stream")
        # No caching proxy should ever hold a frame of this back.
        request.add_header("Cache-Control", "no-cache")
        self._authorize(request)
        for key, value in self.headers.items():
            request.add_header(key, value)

        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as err:
            with err:
                err.read()
            raise TransportError(
                f"GET {request.full_url}: HTTP {err.code} {err.reason}"
            ) from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise TransportError(f"{request.full_url}: {err}") from err

        with response:
            try:
                for frame in _sse_frames(response):
                    snapshot = _snapshot_frame(frame)
                    if snapshot is not None:
                        yield snapshot
            except (TimeoutError, OSError) as err:
                raise TransportError(f"{request.full_url}: the stream broke: {err}") from err

    def call(
        self,
        tab: str,
        name: str,
        args: Mapping[str, Scalar] | None = None,
        rev: int | None = None,
        screen: str | None = None,
    ) -> Result:
        """``POST /dk/tabs/:tab/call`` — run a verb, get the screen back.

        ``rev`` is your claim about what you were looking at. Pass the ``rev``
        from the snapshot you read and a call made against a screen that has
        since moved comes back refused as ``stale`` instead of landing on a row
        you never saw. Omitting it opts out of that check, which is right for a
        verb whose effect does not depend on what is on screen (``scroll``) and
        wrong for one that names a row.

        ``screen`` is the other half of that claim and is checked first: the
        ``Snapshot.screen`` you believed you were on. A paging call sent with
        no ``rev`` once landed on a screen the agent had never seen, paged a
        different company's contact list and answered ``ok`` — "you are
        somewhere else" is a better answer than "the number moved", and the two
        have different fixes. Comes back refused as ``wrong-screen``, naming
        both screens. Omitting it opts out, like ``rev``.

        Returns a Result either way. Only the relay being unreachable, or
        answering with something that is not a Result, raises.
        """
        payload: dict[str, Any] = {"name": name, "args": dict(args or {})}
        if rev is not None:
            # Sent only when asked for. An explicit `"rev": null` would be a
            # claim about the screen, and the claim we want to make is none.
            payload["rev"] = rev
        if screen:
            # Same rule, and an empty string is not a claim either: it is not
            # the id of any screen, so sending it would ask the app to refuse a
            # call over a field the caller left blank.
            payload["screen"] = screen

        body = self._post(f"/dk/tabs/{urllib.parse.quote(tab, safe='')}/call", payload)
        if not isinstance(body, Mapping) or "ok" not in body:
            raise ProtocolError(f"call response is not a Result: {body!r}")
        return Result.from_dict(body)

    # ---- transport --------------------------------------------------------

    def _authorize(self, request: urllib.request.Request) -> None:
        """Attach the bearer token, if there is one.

        Added before ``headers`` so an explicit ``Authorization`` in
        ``headers=`` wins: a caller spelling the header out by hand has a
        reason, and silently overriding it would be the library disagreeing
        with the person who configured it. Never logged, never put in a URL —
        ``urllib`` does not log, and the query string is where a token goes to
        be written into somebody's access log.
        """
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")

    def _get(self, path: str) -> Any:
        return self._request(urllib.request.Request(self.relay_url + path, method="GET"))

    def _post(self, path: str, payload: Mapping[str, Any]) -> Any:
        request = urllib.request.Request(
            self.relay_url + path,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
        )
        request.add_header("Content-Type", "application/json")
        return self._request(request)

    def _request(self, request: urllib.request.Request) -> Any:
        request.add_header("Accept", "application/json")
        self._authorize(request)
        for key, value in self.headers.items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as err:
            # A non-2xx status means the request never produced a WireResult at
            # all — malformed JSON, an unroutable path, a broken relay. The
            # status contract is explicit that a refusal arrives as 200 with
            # `ok: false`, and that a relay must not use 4xx to mean "the app
            # said no". So this is a transport failure even when the body looks
            # like a Result: honouring such a body would quietly bless the
            # conflation the contract forbids, and the two want opposite
            # handling — retry elsewhere versus rephrase and retry.
            with err:
                detail = _first_line(err.read())
            raise TransportError(
                f"{request.get_method()} {request.full_url}: HTTP {err.code} {err.reason}"
                + (f": {detail}" if detail else "")
            ) from err
        except urllib.error.URLError as err:
            raise TransportError(f"{request.full_url} is unreachable: {err.reason}") from err
        except TimeoutError as err:
            raise TransportError(f"{request.full_url} timed out after {self.timeout}s") from err
        except OSError as err:  # a connection dropped mid-read
            raise TransportError(f"{request.full_url}: {err}") from err

        try:
            return json.loads(raw)
        except (ValueError, UnicodeDecodeError) as err:
            raise ProtocolError(
                f"{request.full_url} returned {len(raw)} bytes that are not JSON"
            ) from err


def _sse_frames(stream: Any) -> Iterator[dict[str, str]]:
    """Parse an SSE body into one dict of fields per frame.

    Small enough to hand-roll, and hand-rolled for the same reason the relay
    chose SSE over WebSocket: this is plain chunked HTTP with ``field: value``
    lines and a blank line between frames, so the whole parser is this
    function. Three details are the ones that bite:

    * A line beginning with ``:`` is a comment. That is what the relay's 20s
      keepalive is, and treating it as data would deliver a junk frame every
      twenty seconds.
    * ``data:`` may appear more than once in a frame and the values join with
      newlines. JSON payloads rarely need it, but a parser that keeps only the
      last line silently truncates the day one does.
    * An unterminated final frame is dropped rather than delivered. A
      half-written snapshot is not a screen.
    """
    fields: dict[str, str] = {}
    data: list[str] = []
    for raw_line in stream:
        line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
        if line.startswith(":"):
            continue
        if line == "":
            if data or fields:
                fields["data"] = "\n".join(data)
                yield fields
            fields, data = {}, []
            continue
        name, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if name == "data":
            data.append(value)
        else:
            fields[name] = value


def _snapshot_frame(frame: Mapping[str, str]) -> Snapshot | None:
    """A ``snapshot`` frame as a Snapshot, or None for anything else.

    Both the wrapped shape from the frames section, ``{"t": "snapshot",
    "snapshot": {...}}``, and a bare snapshot object are accepted. A frame that
    is not JSON, or is some other ``t``, is skipped rather than raised on:
    PROTOCOL.md says unknown frames are ignored so a new one can be added
    without a version bump, and a watcher that dies on an unrecognised frame
    turns that additive promise into an outage.
    """
    payload = _loads_or_none(frame.get("data", ""))
    if not isinstance(payload, Mapping):
        return None
    if payload.get("t") == "snapshot" or "snapshot" in payload:
        inner = payload.get("snapshot")
        return Snapshot.from_dict(inner) if isinstance(inner, Mapping) else None
    if "rev" in payload and "where" in payload:
        return Snapshot.from_dict(payload)
    return None


def _loads_or_none(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None


def _first_line(raw: bytes, limit: int = 200) -> str:
    """A scrap of an error body, for the exception message. Truncated, because
    a relay that fell over may answer with a whole HTML error page."""
    text = raw.decode("utf-8", "replace").strip().splitlines()
    return text[0][:limit] if text else ""
