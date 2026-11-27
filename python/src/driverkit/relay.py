"""
driverkit — the relay, in Python, stdlib only.

This is a port of ``packages/driverkit/src/relay/relay.ts``, frame for frame and status
for status. It exists because the backend half of a driverkit deployment is
often already Python: PROTOCOL.md's argument for SSE is that *the relay belongs
inside a server you already run*, and "already run" is a FastAPI or Django
process far more often than it is a Node one. Two relays that differ would be
worse than either, so where this file and the TypeScript one could plausibly
diverge there is a comment saying which way it went.

Two properties are worth stating before the code, because both are easy to
break with a change that looks like a cleanup:

    THE RELAY GRANTS NO AUTHORITY. It forwards a verb name to a tab that is
    already logged in as a person. It never decides whether a call is allowed,
    never rewrites args, never interprets ``rev``. Every refusal it originates
    is about reachability — "no tab", "the tab went away", "the tab never
    answered" — and never about the verb. The moment the relay has an opinion
    about a verb there are two sets of rules and one of them is wrong.

    EVERY ANSWER FROM ``/call`` IS A ``WireResult``, AND THE BODY IS
    AUTHORITATIVE. An agent gets the same shape at 200 whether the tab refused,
    the tab vanished, or the tab id was a typo. A 4xx there would conflate a
    transport failure with a business rule, and those want opposite handling:
    one is retry-elsewhere, the other is rephrase-and-retry. So a non-2xx from
    this relay means no ``WireResult`` was produced at all — malformed body,
    unroutable path — and never "the app said no".

    A relay refusal carries NO ``snapshot``. The three it can originate are a
    closed set (:data:`driverkit.types.RELAY_REFUSALS`), and in none of them did
    anything run or anybody look. Inventing an empty snapshot would tell an
    agent the app has no rows, which is a lie about the app rather than about
    the call. :meth:`Result.to_dict` omits an absent snapshot, which is why the
    refusals here are built through it rather than as hand-written dicts.

    A TAB BELONGS TO A PRINCIPAL, AND THE REGISTRY KEY SAYS SO. Tabs are
    stored under ``(principal, tab id)``, not under the tab id alone. That is
    not a check, it is a shape: there is no lookup by bare tab id anywhere in
    this file, so a caller cannot reach another principal's tab through a code
    path somebody adds next year and forgets to guard. It also removes the
    question of what to do when two people mint the same tab id — nothing, they
    are two tabs — and with it an existence oracle for other people's ids.

    Isolation is NOT authorisation. A credential buys its holder nothing they
    could not already do in their own browser; it tells the relay which
    hundredth of its registry to show them. See :mod:`driverkit.auth`.

CHOICES PROTOCOL.md LEAVES TO THE RELAY, carried over from the TS version so
the two cannot drift:

  - A second ``/dk/events`` stream for a known tab id SUPERSEDES the first. The
    id is minted by the tab so a reconnect resumes identity; treating the
    second stream as a new tab would defeat the only reason the id exists.
  - Calls in flight CARRY ACROSS that supersede. A tab that was mid-verb when
    its stream blinked can still POST the result on the new one, and failing
    those would turn a recovered hiccup into an error the agent must handle.
  - ``hello`` UPSERTS FIELD BY FIELD. It arrives again after every reconnect
    and the app may have navigated in between, so the later one wins on each
    field it carries and leaves the others alone.
  - Everything in ``hello`` but ``tab`` is OPTIONAL, which leaves a real
    window: a tab enters the registry when its stream opens and ``hello`` lands
    a moment later on a separate POST. During it ``/manifest`` answers 404
    rather than an empty verb list, because an empty list is a false claim that
    the app has no verbs.
  - Watchers live OUTSIDE the tab record. A tab record dies with its stream and
    a watcher must survive the page reloading — that reload is one of the
    things it is watching for.

TRANSPORT IS SOMEBODY ELSE'S PROBLEM. :meth:`Relay.handle` takes five plain
values and returns a :class:`Response`, so it can be driven by
:mod:`driverkit.serve_relay` (``http.server``), by
:func:`driverkit.asgi.relay_asgi`, or by a test with no socket at all. The TS
version made its ``dispatch`` pure for the same reason: a relay whose
correctness is asserted by calling internals would pass with a missing blank
line between SSE frames, and that blank line is the entire framing.

THREADS. ``handle`` blocks: a ``POST /dk/tabs/:tab/call`` is not a ticket to
poll, it *is* the call, and it returns when the matching ``result`` frame
arrives. So every adapter must call it on a thread of its own, and an SSE
response must be streamed from a thread of its own too — an endless body on a
single-threaded server is every other request hanging. The registry below is
guarded by one re-entrant lock and no lock is ever held across a blocking wait;
see :class:`Stream` for why writing to a stream cannot block.

Zero runtime dependencies: this module imports only the standard library.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Mapping, Sequence
from urllib.parse import parse_qsl, unquote

from .auth import LOCAL_PRINCIPAL, AuthError, Principal, TabAuth
from .types import RELAY_REFUSALS, Result

__all__ = [
    "Relay",
    "Response",
    "Stream",
    "MAX_BODY",
    "SSE_HEADERS",
    "bad_request",
    "TabAuth",
    "Principal",
]

#: The body size limit PROTOCOL.md pins: 1 MiB, and over it is a 413. A
#: snapshot approaching that size is a bug in the app's ``visible()``, not a
#: limit to raise — the whole design says an agent sees a screenful. Enforced by
#: the adapters, which are the only code that knows how many bytes arrived.
MAX_BODY = 1 << 20

#: The backstop above which an oversized body stops being read at all.
#:
#: Between ``MAX_BODY`` and here, an adapter keeps READING and discarding so it
#: can answer the 413 after the sender has finished. That is not politeness:
#: hanging up mid-upload resets the connection, the sender gets ECONNRESET on
#: its own socket before it reads anything back, and a sender that cannot learn
#: WHY it failed retries identically — which is the opposite of what a limit is
#: for. Above this, reading all of it politely is the attack succeeding, so the
#: connection is dropped and the sender is left to guess.
ABORT_BODY = 64 << 20

SSE_HEADERS: tuple[tuple[str, str], ...] = (
    ("Content-Type", "text/event-stream; charset=utf-8"),
    ("Cache-Control", "no-cache, no-transform"),
    ("Connection", "keep-alive"),
    # Nginx buffers proxied responses by default, which turns a live stream
    # into one that arrives when it ends. The ping comments keep the connection
    # open; this keeps the bytes moving.
    ("X-Accel-Buffering", "no"),
)

_JSON_HEADERS: tuple[tuple[str, str], ...] = (
    ("Content-Type", "application/json; charset=utf-8"),
    # A tab id is a capability, so nothing here is cacheable by anything.
    ("Cache-Control", "no-store"),
)

#: The 401's challenge header. ``Bearer`` names the scheme an agent should use;
#: the realm is fixed, because a realm that named the app or the principal
#: would be a 401 that leaks who else is here.
_AUTH_HEADERS: tuple[tuple[str, str], ...] = _JSON_HEADERS + (
    ("WWW-Authenticate", 'Bearer realm="driverkit"'),
)

#: The hint on every ``no-such-tab``, whatever the real reason.
#:
#: One string, with no tab id in it, because the four reasons an agent can get
#: this — never minted, closed, somebody else's, outside a tab-bound
#: credential's reach — must be one answer. A hint that said "no tab `abc` is
#: connected" for one and something else for another would make the endpoint
#: the membership test the status code was carefully chosen not to be.
NO_SUCH_TAB_HINT = "no such tab is connected"

#: The principal every request is, with auth off.
_LOCAL = Principal(id=LOCAL_PRINCIPAL)

_OPENING = b": driverkit\n\n"
_PING = b": ping\n\n"


# --- what an adapter gets back ---------------------------------------------


@dataclass(frozen=True)
class Response:
    """One answer, either a whole body or an open stream — never both.

    ``headers`` excludes ``Content-Length``; the adapter adds it for a body
    response and must *not* add one for a stream, whose length is unknowable up
    front. A client that waited for a length on an SSE body would hang forever.
    """

    status: int
    headers: tuple[tuple[str, str], ...] = _JSON_HEADERS
    body: bytes = b""
    stream: "Stream | None" = None

    @property
    def streaming(self) -> bool:
        return self.stream is not None


class Stream:
    """An open SSE response: a queue of chunks, drained by whoever owns the socket.

    Writes never block and never raise. That is the property the locking rests
    on — :meth:`Relay.handle` and the ingest path write frames to streams while
    holding the registry lock, and if a write could block on a slow consumer
    then one wedged reader would freeze the whole relay. The cost is that a
    consumer which stops reading grows a queue; it is bounded in practice by
    the fact that a tab with no reader is a tab whose socket is about to be
    closed, and :meth:`close` drops the queue.

    The keep-alive is produced here rather than by a timer thread: the consumer
    waits at most ``ping_s`` for a chunk and emits a ``: ping`` comment when
    nothing arrives. PROTOCOL.md asks for a comment every 20s on an *idle*
    stream, and this is that, with no per-stream thread and no timer to leak.
    (The TS relay runs a fixed interval instead, so it also pings a busy
    stream. The difference is invisible to a client: a comment carries nothing
    and a conforming reader drops it.)
    """

    __slots__ = ("_q", "_ping_s", "_closed", "_on_close", "_lock")

    def __init__(self, ping_s: float) -> None:
        self._q: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._ping_s = ping_s
        self._closed = False
        self._on_close: list[Callable[[], None]] = []
        self._lock = threading.Lock()
        # A first comment byte makes the browser fire `open` now rather than
        # when the first real frame happens to arrive, and `open` is where the
        # page sends `hello`. Without it a freshly loaded tab is connected but
        # unidentifiable until somebody tries to drive it.
        self._q.put(_OPENING)

    @property
    def closed(self) -> bool:
        return self._closed

    def write(self, chunk: bytes) -> bool:
        """Queue one chunk. False means the stream is gone — see ``send`` in the
        TS relay, where a failed write is what turns into ``tab-went-away``."""
        with self._lock:
            if self._closed:
                return False
            self._q.put(chunk)
            return True

    def on_close(self, fn: Callable[[], None]) -> None:
        with self._lock:
            already = self._closed
            if not already:
                self._on_close.append(fn)
        if already:
            fn()

    def close(self) -> None:
        """Hang up. Idempotent: a shutdown path that throws on a second call is
        one that gets wrapped in try/except everywhere it is used."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            callbacks, self._on_close = self._on_close, []
            self._q.put(None)
        for fn in callbacks:
            fn()

    def chunks(self) -> Iterator[bytes]:
        """The bytes to write to the socket, blocking between them.

        Ends when the stream is closed. Single-consumer: the adapter that owns
        the socket is the only caller.
        """
        while True:
            try:
                chunk = self._q.get(timeout=self._ping_s)
            except queue.Empty:
                # A comment line, per PROTOCOL.md: it carries nothing, and a
                # comment cannot be mistaken for a frame by a client that has
                # never heard of it. That is what lets the keep-alive exist
                # without a version bump.
                yield _PING
                continue
            if chunk is None:
                return
            yield chunk


# --- the registry -----------------------------------------------------------


@dataclass
class _Pending:
    """One call waiting for its ``result`` frame.

    An :class:`threading.Event` rather than a polled deadline: the call returns
    the instant the frame lands, and a relay that polled would add half its
    interval to every round trip an agent makes.
    """

    event: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None
    #: Who asked, which tab and verb they asked for, and when the relay took
    #: the call -- everything ``on_audit`` needs, carried on the record because
    #: two of the five places a call can be settled are nowhere near the
    #: dispatch: a stream closing, and the relay shutting down.
    principal: str = ""
    tab: str = ""
    verb: str = ""
    started: float = 0.0


@dataclass
class _Tab:
    tab: str
    #: Who this tab belongs to. The other half of the registry key, kept on the
    #: record too so a summary and a watcher fan-out can find it without
    #: carrying the key around.
    principal: str
    #: ISO 8601, formatted once at connect rather than on every listing.
    since: str
    stream: Stream
    pending: dict[str, _Pending] = field(default_factory=dict)
    # Stored as the raw dicts the tab sent, NOT as parsed dataclasses.
    # PROTOCOL.md promises a field may be added without a version bump, and
    # that promise is only kept if every hop forwards what it does not
    # understand. Re-serialising a `Manifest` here would silently drop a
    # `kind`, or a `count`, or whatever the next field turns out to be.
    app: str | None = None
    title: str | None = None
    url: str | None = None
    #: Where the tab said its person's attention is: ``focused``, ``visible``
    #: or ``hidden``. Stored as the tab sent it and never computed — the relay
    #: cannot see ``document.hasFocus()``, which is the whole reason the page
    #: reports it.
    focus: str | None = None
    manifest: dict[str, Any] | None = None
    snapshot: dict[str, Any] | None = None


class Relay:
    """The one place both parties can reach.

    ``timeout_s`` is how long ``POST /dk/tabs/:tab/call`` waits for the matching
    ``result``. PROTOCOL.md has no queue on purpose: a call either reaches a
    connected tab or fails cleanly, and the deadline is the other half of that
    promise. Without it a tab whose JavaScript died — stream still open, event
    loop wedged — holds the agent's request forever, which is the one failure
    mode worse than a refusal, because an agent cannot retry what has not
    returned. It is the relay's property, not the protocol's, and **the default
    is 60 seconds** — the same number the TypeScript relay uses, because
    PROTOCOL.md's own rule is that two conforming relays disagreeing on a
    default is worse than either choice.

    **Why 60 and not the 15 this used to be.** 15s was tuned for a button
    click, where it is a margin of three hundred times. It is no margin at all
    for the verb an adopter reaches for this library to drive — a report fetch,
    an export, a cross-system lookup — and a legitimate 20-second fetch came
    back ``timeout``, which PROTOCOL.md defines as **outcome unknown**: a
    commit that answers that way may already have run and the agent is told
    not to retry it. The deadline was converting successes into the most
    expensive answer in the system, and the two errors are not symmetric.
    Firing late costs latency; firing early costs a task nobody can safely
    resume.

    **Why not much longer.** The deadline is the only thing that answers an
    agent when a tab is alive but wedged — ``tab-went-away`` covers a tab that
    died, and nothing else covers one that is merely stuck. Past about a minute
    an intermediary gives up first: proxies and load balancers cut an idle
    response at 30 to 60 seconds, so a longer server-side deadline is answered
    by a socket error at the client, which is an unknown outcome with no slug
    and no ``Result`` shape at all. A verb that genuinely needs longer wants a
    handle-and-poll pair of verbs, not a bigger number here.

    ``allow_remote`` serves requests that did not come from loopback. Off by
    default, and that default is the security model rather than a convenience.
    A tab's own session is what the app checks, so a relay someone else can
    reach is that person driving your logged-in session — not a scoped token
    they could be given, your actual account. There is nothing to revoke
    because nothing was ever granted.

    ``auth`` is a :class:`driverkit.auth.TabAuth` and is how the relay learns
    which person a request is from. ``resolve_principal`` is the other door:
    a function from the request's headers to a principal id, for a relay
    embedded in an app that already has sessions and can simply say who the
    caller is. It is consulted first and falling through it (returning ``None``)
    hands the request to ``auth``.

    With neither configured, auth is OFF and every request resolves to one
    principal — the unconfigured loopback relay one developer runs, where
    scoping by principal is a no-op and nothing needs setting up.

    **``allow_remote`` without one of them raises.** That combination is the
    one this whole file exists to prevent: an exposed relay with no notion of
    who is calling publishes a hundred people's logged-in sessions to each
    other and to anybody who can reach the port. It used to be reachable by
    setting one flag that reads like a convenience, so now it is not reachable
    at all — turning on remote access means naming how callers are identified,
    in the same call, or the relay refuses to exist.

    ``on_error`` is called with anything raised while writing to a stream.

    ``on_audit`` is where this relay's own audit records go: one mapping per
    ``/call`` it handled, with the keys ``at``, ``ms``, ``principal``, ``tab``,
    ``verb`` and ``outcome``, identical in name and meaning to the
    ``RelayAuditEvent`` the TypeScript relay emits.

    It exists for the one fact an in-page audit hook cannot know and this relay
    cannot help knowing: WHICH PRINCIPAL asked. A driver sees a call and has no
    idea whether it came from the panel in front of a person, a cron job, or
    somebody else's agent holding a token; the relay resolved the credential, so
    it is the only place in the library where "who" is a fact rather than a
    guess.

    And it says no more than that. It does not report what the verb DID: the
    driver decided that, in another process, and a copy of somebody else's
    decision is a second source of truth that can disagree with the first — a
    relay logging ``ok`` for a call whose tab died mid-commit would be asserting
    an outcome nobody observed. So ``outcome`` is the RELAY's verdict and is one
    of ``delivered`` (the tab answered; what it answered is in the driver's own
    record), ``no-such-tab``, ``tab-went-away`` or ``timeout``. The last three
    are the calls no other log will ever mention, because they never reached, or
    never returned from, a driver. **Count commits from the drivers' records**
    and read this one for who asked; that is the line that keeps the two from
    being two countings of one call.

    It is called and not awaited, and a throw goes to ``on_error``: a 500
    because the logging backend is down would turn an audit trail into an
    outage.
    """

    def __init__(
        self,
        timeout_s: float = 60.0,
        ping_s: float = 20.0,
        allow_remote: bool = False,
        on_error: Callable[[BaseException], None] | None = None,
        *,
        auth: TabAuth | None = None,
        resolve_principal: Callable[[Mapping[str, str]], str | None] | None = None,
        on_audit: Callable[[Mapping[str, Any]], None] | None = None,
    ) -> None:
        if allow_remote and auth is None and resolve_principal is None:
            # Raised in the constructor, before a socket exists, for the same
            # reason `serve()` refuses a non-loopback host there: a
            # misconfiguration that surfaced later is one somebody forgot to
            # check, and the failure mode of forgetting is a listening public
            # port that drives strangers' browsers.
            raise ValueError(
                "driverkit: allow_remote needs auth= or resolve_principal=. A relay that "
                "serves non-loopback callers and cannot tell them apart is every connected "
                'tab offered to every caller. Read "Who is allowed to do this" in '
                "PROTOCOL.md, then pass auth=TabAuth(secret=..., audience=...)."
            )
        self.timeout_s = timeout_s
        self.ping_s = ping_s
        self.allow_remote = allow_remote
        self._auth = auth
        self._resolve = resolve_principal
        self._on_error = on_error or (lambda _err: None)
        self._on_audit = on_audit

        # One re-entrant lock over the whole registry. A lock per tab would be
        # the obvious refinement and would buy nothing: every critical section
        # here is a dict lookup and a queue put, and the one operation that
        # blocks — waiting for a `result` — deliberately holds no lock at all.
        self._lock = threading.RLock()
        #: Connected tabs, keyed by ``(principal, tab id)``.
        #:
        #: The pair, never the bare id. Two principals using the same tab id
        #: string are two tabs and neither can see the other, so there is no
        #: collision to resolve and no refusal that would tell a prober which
        #: ids are taken. Every lookup in this file goes through
        #: :meth:`_owned`, which is the only place the pair is assembled.
        self._tabs: dict[tuple[str, str], _Tab] = {}
        #: ``GET /dk/tabs/:tab/watch`` subscribers, keyed the same way.
        #:
        #: A set, because PROTOCOL.md requires every watcher to get the frames:
        #: two agents beside one human is the shared-presence case, and a
        #: single-slot registry would silently make the second one blind rather
        #: than refuse it.
        #:
        #: Kept OUTSIDE the tab record on purpose — see the module docstring.
        self._watchers: dict[tuple[str, str], set[Stream]] = {}
        #: The rev last broadcast per tab, so a refusal that moved nothing is quiet.
        self._broadcast: dict[tuple[str, str], int] = {}
        self._next_call = 1
        self._closed = False

    # ---- the public surface ------------------------------------------------

    def tabs(self) -> list[dict[str, Any]]:
        """The connected tabs, as ``GET /dk/tabs`` reports them.

        Rows rather than :class:`driverkit.types.Tab` instances, because this is
        the wire shape and ``Tab.to_dict`` fills absent strings with ``""``.
        The pre-``hello`` window is real, and a row claiming ``app: ""`` is a
        worse answer than a row that simply does not mention the app yet. Parse
        these with ``Tab.from_dict`` if you want the dataclass.
        """
        with self._lock:
            return [self._summary(t) for t in self._tabs.values()]

    def tabs_for(self, principal: str, tab: str | None = None) -> list[dict[str, Any]]:
        """The tabs ONE principal owns — what ``GET /dk/tabs`` actually serves.

        :meth:`tabs` stays the whole registry because it is the operator's
        in-process view: a process that embeds the relay may legitimately want
        to know what is connected. Nothing reachable over HTTP uses it. The
        cross-principal listing was the inventory of other people's sessions —
        titles, URLs and all — that this split exists to remove.

        ``tab`` narrows further, for a credential bound to one tab.
        """
        with self._lock:
            return [
                self._summary(t)
                for t in self._tabs.values()
                if t.principal == principal and (tab is None or t.tab == tab)
            ]

    def close(self) -> None:
        """Hang up every stream and fail every call in flight. Idempotent."""
        with self._lock:
            self._closed = True
            tabs, self._tabs = list(self._tabs.values()), {}
            watchers = [s for group in self._watchers.values() for s in group]
            self._watchers.clear()
            self._broadcast.clear()
            for tab in tabs:
                for pending in tab.pending.values():
                    self._settle(
                        pending,
                        self._refusal("tab-went-away", "the relay is shutting down"),
                        "tab-went-away",
                    )
                tab.pending.clear()
        for stream in [*(t.stream for t in tabs), *watchers]:
            try:
                stream.close()
            except Exception as err:  # pragma: no cover - close() does not raise
                self._on_error(err)

    def handle(
        self,
        method: str,
        path: str,
        query: Mapping[str, str] | Sequence[tuple[str, str]] | str | None = None,
        body: bytes | None = None,
        peer: str | None = None,
        headers: Mapping[str, str] | Sequence[tuple[str, str]] | None = None,
    ) -> Response | None:
        """Handle one request, or return ``None`` when the path is not ours.

        ``None`` rather than a 404 is what makes embedding possible: deciding
        that an unknown path is an error is the host server's business, and a
        relay that answered 404 for everything could not sit in front of the app
        it was embedded in. The standalone server turns ``None`` into a 404
        itself, because there it *is* the whole process.

        ``body`` is the raw request bytes, unparsed, because reading them is
        where a malformed call turns into a 400 rather than into a refusal.
        ``peer`` is the remote address of *this* request; see the loopback guard.
        ``headers`` is where the caller's credential is read from, and is
        optional so that a test or an adapter with nothing to say about identity
        still compiles — with auth off there is nothing to read.
        """
        # Exactly the TS relay's test: the trailing slash is required, so a
        # host app owning `/dkstuff` or even `/dk` itself is left alone.
        if not path.startswith("/dk/"):
            return None

        if self._closed:
            return _json(503, {"error": "relay closed"})

        if not self.allow_remote and not _is_loopback(peer):
            # Refused here rather than by not binding, because an embedded
            # relay does not own the listening socket and so cannot choose an
            # interface. "Bind to loopback" is advice it is unable to follow,
            # and taken as the whole story it leaves a relay inside a public app
            # server with no guard at all. The check has to live where the
            # requests are.
            return _json(
                403,
                {
                    # `forbidden`, as the status table pins it. The slug names
                    # the outcome rather than the reason, because with
                    # allow_remote on and the app's own auth in front, the next
                    # thing to refuse a caller here is not loopback at all.
                    "error": "forbidden",
                    "hint": "this relay drives a logged-in browser session; set allow_remote "
                    "and put your app's own auth in front of it",
                },
            )

        params = _query(query)
        head = _headers(headers)
        method = (method or "GET").upper()

        # Identity BEFORE routing. A caller who cannot be identified is told
        # that and nothing else — not which methods a path takes, not whether
        # the path exists. Authenticating after routing is how an unauthorised
        # caller gets to map the surface.
        who = self._whoami(head, params)
        if isinstance(who, Response):
            return who

        # --- the two the tab uses -------------------------------------------
        if path == "/dk/events":
            if method != "GET":
                return _bad_method("GET")
            tab_id = params.get("tab")
            if not tab_id:
                return bad_request(400, "GET /dk/events needs ?tab=")
            if who.tab is not None and who.tab != tab_id:
                # 403 and not `no-such-tab`, and the difference is the point.
                # The oracle rule is about ADDRESSING somebody else's tab; this
                # caller is opening its own and presented a credential bound to
                # a different id, which it already knows. Telling it so leaks
                # nothing and is the only answer it can act on.
                return _json(
                    403,
                    {
                        "error": "forbidden",
                        "hint": "this credential is bound to another tab id",
                    },
                )
            return self._open_stream(who, tab_id)

        if path == "/dk/result":
            if method != "POST":
                return _bad_method("POST")
            frame = _loads(body)
            if not isinstance(frame, Mapping):
                return bad_request(400, "expected a JSON frame", "bad-frame")
            if frame.get("t") not in ("hello", "result", "snapshot"):
                return bad_request(400, f"unknown frame `t`: {frame.get('t')!r}", "bad-frame")
            return self._ingest(who, frame, params.get("tab"))

        # --- the four the agent uses ----------------------------------------
        if path == "/dk/tabs":
            if method != "GET":
                return _bad_method("GET")
            # The caller's own tabs, and never anybody else's. A listing of
            # every connected tab is an inventory of other people's sessions
            # with their titles and URLs attached, which is the single worst
            # thing on this surface and was the default.
            return _json(200, {"tabs": self.tabs_for(who.id, who.tab)})

        parts = [p for p in path.split("/") if p]  # dk, tabs, :tab, leaf
        if len(parts) == 4 and parts[1] == "tabs":
            tab_id = unquote(parts[2])
            leaf = parts[3]

            if leaf in ("manifest", "snapshot"):
                if method != "GET":
                    return _bad_method("GET")
                with self._lock:
                    tab = self._owned(who, tab_id)
                    value = (tab.manifest if leaf == "manifest" else tab.snapshot) if tab else None
                # Not Result-shaped, and that asymmetry is on purpose. A Result
                # is the outcome of a CALL; these two read state, and wrapping
                # "there is no such tab" in a fake {ok:false, snapshot} would
                # hand the agent a snapshot that describes nothing. Only /call
                # promises one shape, because only /call is the thing an agent
                # must be able to handle uniformly.
                if tab is None:
                    # A tab somebody else owns answers exactly this, byte for
                    # byte, so the endpoint cannot be used to probe for other
                    # people's tab ids. Note this is checked BEFORE the
                    # `no-manifest` case below: a foreign tab that has sent no
                    # manifest must not answer `no-manifest`, which would
                    # confirm it exists.
                    return _json(404, {"error": "no-such-tab", "hint": NO_SUCH_TAB_HINT})
                if value is None:
                    return _json(
                        404,
                        {"error": f"no-{leaf}", "hint": f"tab `{tab_id}` has sent no {leaf}"},
                    )
                return _json(200, value)

            if leaf == "watch":
                if method != "GET":
                    return _bad_method("GET")
                with self._lock:
                    known = self._owned(who, tab_id) is not None
                # 404 for a tab that is not connected, rather than an open
                # stream that may never carry anything. Consistent with
                # /snapshot, and it is the answer that tells a client to re-read
                # /dk/tabs instead of waiting on a subscription to a screen that
                # does not exist.
                if not known:
                    return _json(404, {"error": "no-such-tab", "hint": NO_SUCH_TAB_HINT})
                return self._open_watch(who, tab_id)

            if leaf == "call":
                if method != "POST":
                    return _bad_method("POST")
                return self._call(who, tab_id, body)

        return bad_request(404, f"no driverkit route {method} {path}", "no-route")

    # ---- the tab's end -----------------------------------------------------

    def _open_stream(self, who: Principal, tab_id: str) -> Response:
        """Open a tab's stream and BIND the tab to the caller's principal.

        The binding happens here, at first contact, rather than on ``hello``.
        PROTOCOL.md already describes the window between a stream opening and
        its ``hello`` landing on a separate POST; binding at ``hello`` would
        make that window one in which a tab exists and belongs to nobody, and
        an unowned tab is one every principal either can or cannot see, both of
        which are wrong. Binding at open leaves no such state.

        What this means for a credential that expires MID-SESSION: nothing. The
        binding is the relay's record and lasts as long as the stream, not as
        long as the token. A relay that hung up at ``exp`` would disconnect
        every tab in the deployment once per token lifetime, mid-verb, while a
        person watched — and the fix people reach for, a longer lifetime, is
        strictly worse because it also widens the window a leaked token is
        useful in. Short tokens plus a binding that outlives them gives both.

        The credential is still needed for ``POST /dk/result``, which is a new
        request and carries its own; see ``connect``'s token getter, which is a
        function for exactly this reason.
        """
        stream = Stream(self.ping_s)
        key = (who.id, tab_id)
        with self._lock:
            existing = self._tabs.get(key)
            if existing is not None:
                # A second stream for a known id is a reconnect, not a new tab:
                # the id is minted by the tab precisely so it survives one.
                # Carry the known facts and the calls in flight across — a tab
                # that was mid-verb when its stream blinked can still POST the
                # result on the new one, and failing those calls would turn a
                # recovered hiccup into an error the agent has to handle.
                tab = _Tab(
                    tab=tab_id,
                    principal=who.id,
                    since=existing.since,
                    stream=stream,
                    pending=existing.pending,
                    app=existing.app,
                    title=existing.title,
                    url=existing.url,
                    manifest=existing.manifest,
                    snapshot=existing.snapshot,
                )
            else:
                tab = _Tab(tab=tab_id, principal=who.id, since=_now(), stream=stream)
            self._tabs[key] = tab

        if existing is not None:
            existing.stream.close()

        def gone() -> None:
            with self._lock:
                # Only drop the registry entry if it is still OURS. A reconnect
                # replaces the record first and then ends the old stream, so the
                # old close fires afterwards and would otherwise delete the live
                # tab.
                if self._tabs.get(key) is not tab:
                    return
                del self._tabs[key]
                # Fail what is in flight instead of letting each call sit out
                # its own deadline. The answer is already known — nobody is
                # going to reply — and "no queue" means the agent learns that
                # now, while it still has the context to try something else.
                for pending in tab.pending.values():
                    self._settle(
                        pending,
                        self._refusal("tab-went-away", f"tab `{tab_id}` closed its stream"),
                        "tab-went-away",
                    )
                tab.pending.clear()

        stream.on_close(gone)
        return Response(200, SSE_HEADERS, stream=stream)

    def _ingest(
        self, who: Principal, frame: Mapping[str, Any], tab_from_query: str | None
    ) -> Response:
        """One tab→relay frame, and the answer to the POST that carried it.

        The statuses are the pinned ones, and the split between them is the
        point: ``400 unplaceable`` and ``400 bad-frame`` say the frame could
        never have been accepted by anybody, so the tab has a bug;
        ``409 no-such-tab`` says the frame was fine and the relay's state made
        it unacceptable, so reconnecting and retrying is reasonable. Answering
        both with one slug would make a tab author guess which they had.

        Every tab→relay frame carries ``tab``, because ``POST /dk/result`` has
        no path parameter and the relay serves many tabs at once. A ``?tab=`` on
        the URL is accepted too, and a tab may send both — but ``hello`` is the
        frame that defines the identity, so its own field wins there.

        **A tab may not answer another tab's call**, and two things enforce it.
        A tab the caller does not own is not found at all (:meth:`_owned`), so
        the cross-PERSON case is the same 409 as a tab that is not connected.
        Within one person, who legitimately has several tabs open, the pending
        map is per-tab-record and call ids are unique across the relay, so a
        ``result`` for a call issued to another of their tabs finds nothing to
        settle and is dropped as a late answer. A credential carrying a ``tab``
        claim closes that case cryptographically as well; without one, the
        pending map is what holds, which is a weaker statement and is said here
        rather than left to be assumed.
        """
        kind = frame.get("t")
        tab_id = frame.get("tab") if kind == "hello" else (tab_from_query or frame.get("tab"))
        if not tab_id or not isinstance(tab_id, str):
            # Unplaceable, and that is a 400: no state of this relay could have
            # accepted it, because a frame that names nobody cannot be routed
            # even in principle. `POST /dk/result` has no path parameter and the
            # relay serves many tabs at once.
            return bad_request(400, "no tab id: pass ?tab= or a `tab` field", "unplaceable")
        with self._lock:
            tab = self._owned(who, tab_id)
            if tab is None:
                # 409, not 400: the frame is fine and the relay's state is what
                # makes it unacceptable. The tab may reasonably reconnect — it
                # probably just did, and its `hello` lost a race with this.
                #
                # A tab that belongs to someone else lands here too, with the
                # same body, which is the oracle rule applied to the tab's own
                # endpoint: "not yours" and "not connected" must be one answer.
                return _json(409, {"error": "no-such-tab", "hint": NO_SUCH_TAB_HINT})

            if kind == "hello":
                # Upsert, not insert. `hello` arrives again after every
                # reconnect, and the app may have navigated in between, so the
                # later one wins on every field it carries and leaves the rest
                # alone.
                for name in ("app", "title", "url", "focus", "manifest"):
                    if name in frame and frame[name] is not None:
                        setattr(tab, name, frame[name])
                snapshot = frame.get("snapshot")
                if isinstance(snapshot, Mapping):
                    tab.snapshot = dict(snapshot)
                    self._push(tab)
                return _accepted()

            if kind == "snapshot":
                snapshot = frame.get("snapshot")
                if not isinstance(snapshot, Mapping):
                    # Same reasoning as a `result` that is not an object: the
                    # discriminator was checked and the payload was not, which
                    # is exactly the assumption a relay is not entitled to make.
                    return bad_request(
                        400, "a `snapshot` frame needs a `snapshot` object", "bad-frame"
                    )
                tab.snapshot = dict(snapshot)
                # The same upsert rule `hello` uses, on the two fields a push
                # may now carry. `url` is here because it had no other way of
                # ever being right: it came from `hello` alone, and a
                # single-page app navigates without reconnecting, so a tab's
                # url in `/dk/tabs` was whatever it had been at page load.
                # Absent leaves the stored value alone, which is what keeps a
                # tab connected by a hand-written loop — or by a driverkit
                # older than this field — reading exactly as it did.
                for name in ("url", "focus"):
                    if frame.get(name) is not None:
                        setattr(tab, name, frame[name])
                # Always forwarded, even at an unchanged rev. This frame is the
                # tab SAYING the page moved, and second-guessing it here would
                # make the relay the thing that decides what counts as a change
                # — which is the app's judgement, carried in `rev`, not the
                # relay's.
                self._push(tab, force=True)
                return _accepted()

            # kind == "result"
            call_id = frame.get("id")
            result = frame.get("result")
            if not isinstance(result, Mapping):
                # Rejected BEFORE the pending call is touched, and that order is
                # the whole fix. Settling it with whatever this was would answer
                # the agent a body that is not a `WireResult`, and that is the
                # one promise /call makes. Leaving the call pending means it
                # ends as an honest `timeout` — "no answer arrived" is exactly
                # what happened, and the tab is told its frame was the problem.
                #
                # The cause is worth naming because it is a general trap: the
                # frame's discriminator `t` was validated and the frame's
                # payload was trusted, which is an assumption a relay is not
                # entitled to make about anything on the wire.
                return bad_request(400, "a `result` frame needs a `result` object", "bad-frame")
            pending = tab.pending.pop(str(call_id), None)
            # An id the relay is not waiting on is DROPPED, not an error. It
            # means the call already timed out and the tab answered late;
            # resurrecting it would deliver an answer to a request that has
            # already been responded to — and a 4xx would make a slow verb look
            # like a broken one.
            if pending is None:
                return _accepted(f"no call `{call_id}` in flight")
            # Forwarded byte for byte. A `stale` refusal the driver produced
            # must reach the agent as the driver wrote it, hint and snapshot
            # included — that hint is how the agent knows to re-read instead of
            # retrying the same dead rev.
            snapshot = result.get("snapshot")
            if isinstance(snapshot, Mapping):
                tab.snapshot = dict(snapshot)
                # Watchers hear about an agent's change too, not only a human's.
                # /watch exists so a watcher need not poll; one that learned
                # only about human-caused moves would still have to poll for the
                # rest, which is the cost the endpoint was added to remove.
                # Deduped on `rev`, so a refusal that moved nothing stays quiet.
                self._push(tab)
            # `delivered`, and nothing more. The tab answered; what it
            # answered is the driver's own record to make, in the process where
            # it was decided.
            self._settle(pending, dict(result), "delivered")
            return _accepted()

    # ---- the agent's end ---------------------------------------------------

    def _call(self, who: Principal, tab_id: str, body: bytes | None) -> Response:
        parsed = _loads(body)
        name = parsed.get("name") if isinstance(parsed, Mapping) else None
        if not isinstance(name, str) or not name:
            # A body with no `name` is MALFORMED, not refused: there is no verb
            # to have said no, so dressing it as a WireResult would teach an
            # agent to look for a `bad-request` slug the closed set does not
            # contain, and would make it rephrase a request that never reached
            # an app.
            return bad_request(400, "a call needs a `name`")
        assert isinstance(parsed, Mapping)

        # Before the lookup, so `ms` is the time the agent actually waited and
        # not the time minus whatever the registry cost.
        started = time.time()

        with self._lock:
            tab = self._owned(who, tab_id)
            if tab is None:
                # Shaped like every other answer. An agent holding a tab id from
                # a closed window gets a refusal it can read with the same code
                # path it uses for "that row is not deletable".
                #
                # And a tab belonging to another principal gets THIS, not a 403:
                # a refusal an agent reads as "that window is gone", identical
                # in status, slug and hint to one for an id that was never
                # minted. A 403 here would turn `/call` into a membership test
                # for other people's tab ids.
                # Recorded, and this is the half of the trail the driver cannot
                # have: nothing reached a tab, so no `on_audit` anywhere else in
                # the library will ever hear about this call. An agent working
                # through tab ids it does not own leaves its marks only here.
                self._audit(who.id, tab_id, name, started, "no-such-tab")
                return _json(
                    200,
                    self._refusal("no-such-tab", NO_SUCH_TAB_HINT + "; GET /dk/tabs to list them"),
                )
            call_id = f"c-{self._next_call}"
            self._next_call += 1
            pending = _Pending(
                principal=who.id, tab=tab_id, verb=name, started=started
            )
            tab.pending[call_id] = pending
            frame: dict[str, Any] = {"t": "call", "id": call_id, "name": name}
            args = parsed.get("args")
            if isinstance(args, Mapping):
                frame["args"] = dict(args)
            rev = parsed.get("rev")
            # Forwarded only when the agent sent one. Defaulting it would
            # silently opt an agent into a staleness check it did not ask for;
            # dropping it would silently opt it out of one it did. Neither is
            # the relay's call.
            if isinstance(rev, (int, float)) and not isinstance(rev, bool):
                frame["rev"] = rev
            screen = parsed.get("screen")
            # `screen` on exactly the same terms, and with the same restraint:
            # this relay does not know which screen the tab is on, does not
            # compare it and does not refuse it. It is the agent's claim and the
            # driver's check. An empty string is dropped rather than forwarded,
            # because it is not the id of any screen and no app should be asked
            # to refuse a call over a field left blank. Behaviourally identical
            # to the TypeScript relay, which is the standing promise about these
            # two files.
            if isinstance(screen, str) and screen:
                frame["screen"] = screen
            plan = parsed.get("plan")
            # `plan` on the same terms again, and here the restraint is not even
            # a choice: the token is opaque to everything but the core that
            # minted it, so a relay has nothing to compare it against and could
            # only ever get the comparison wrong. Dropped when blank, like
            # `screen`, because an empty string is not a token and the core's
            # refusal should name the field the agent actually left out.
            # Behaviourally identical to the TypeScript relay, which is the
            # standing promise about these two files.
            if isinstance(plan, str) and plan:
                frame["plan"] = plan
            sent = tab.stream.write(_sse(frame))
            if not sent:
                tab.pending.pop(call_id, None)
                self._audit(who.id, tab_id, name, started, "tab-went-away")
                return _json(200, self._refusal("tab-went-away", f"writing to tab `{tab_id}` failed"))

        # NO LOCK HELD. This is the blocking half of the relay, and holding
        # anything across it would mean one wedged tab freezes every other.
        if not pending.event.wait(self.timeout_s):
            with self._lock:
                # The deadline and the frame can race. If the answer landed in
                # that window it is the answer, and discarding it to report a
                # timeout would be inventing a failure.
                if pending.result is None:
                    tab.pending.pop(call_id, None)
                    # NOT a promise the call did not happen. The tab may have
                    # run the verb and died before answering, so a `commit`
                    # that times out has an unknown outcome and the agent must
                    # read the screen before retrying. The relay says only "no
                    # answer arrived"; guessing further here is how every client
                    # ends up inventing a different guess.
                    self._settle(
                        pending,
                        self._refusal(
                            "timeout",
                            f"tab `{tab_id}` did not answer `{name}` within {self.timeout_s}s",
                        ),
                        "timeout",
                    )
        assert pending.result is not None
        # 200 even for a refusal. The HTTP layer succeeded: the question was
        # asked and answered. `ok: false` is the answer, not a transport
        # failure, and conflating the two is how an agent ends up retrying a
        # refusal it should have read.
        return _json(200, pending.result)

    def _open_watch(self, who: Principal, tab_id: str) -> Response:
        """Subscribe an agent to a tab's ``snapshot`` frames.

        The same SSE shape the tab's own stream uses, down to the opening
        comment and the ping, so a client needs one parser for both directions
        rather than two that drift.
        """
        stream = Stream(self.ping_s)
        key = (who.id, tab_id)
        with self._lock:
            self._watchers.setdefault(key, set()).add(stream)
            tab = self._tabs.get(key)
            known = tab.snapshot if tab else None
            if known is not None:
                # The current snapshot goes out immediately. A watcher that
                # attached to an idle screen would otherwise know nothing at all
                # until the next click, and would have to fetch /snapshot anyway
                # — which is the poll the endpoint exists to remove.
                stream.write(_sse({"t": "snapshot", "tab": tab_id, "snapshot": known}))

        def gone() -> None:
            with self._lock:
                live = self._watchers.get(key)
                if live is None:
                    return
                live.discard(stream)
                if not live:
                    del self._watchers[key]

        stream.on_close(gone)
        return Response(200, SSE_HEADERS, stream=stream)

    # ---- who is calling ----------------------------------------------------

    def _whoami(self, headers: Mapping[str, str], params: Mapping[str, str]) -> "Principal | Response":
        """The caller's principal, or the 401 to answer instead.

        Three doors, in this order:

        1. **Auth off.** Neither ``auth`` nor ``resolve_principal`` configured:
           everything is one principal and nothing is scoped. This is the
           unconfigured loopback relay a single developer runs, and it needs no
           tokens, no keys and no setup — the combination ``allow_remote``
           makes impossible is the one where this is also exposed.
        2. **``resolve_principal``.** The embedded case: an app that already
           has sessions answers from its own middleware. Returning ``None``
           falls through, so it can handle its logged-in users and leave
           anonymous visitors to the token path.
        3. **The credential.** See :func:`_credential` for where it is read
           from and :mod:`driverkit.auth` for what it proves.

        **No credential and a bad credential are different answers**, and
        neither is "anonymous". A request with nothing to present gets
        ``no-credential``; one whose credential does not check out gets
        ``bad-credential`` *for every reason it might not check out*. Silently
        treating an unreadable credential as a fresh anonymous visitor was the
        tempting shape and is the wrong one twice over: a user whose token
        lapsed would quietly become a stranger and lose their own tabs, and an
        agent with a misconfigured key would be told "you have no tabs" rather
        than "your key is wrong". Anonymous is a credential of its own kind, so
        it is never what the absence of one means.
        """
        if self._auth is None and self._resolve is None:
            return _LOCAL

        if self._resolve is not None:
            try:
                resolved = self._resolve(headers)
            except Exception as err:
                # A host hook that throws must not become a 500 that mentions
                # the app's internals, and must certainly not become an
                # authenticated request. It is an unidentified caller.
                self._on_error(err)
                resolved = None
            if resolved:
                return Principal(id=str(resolved))

        if self._auth is None:
            return _unauthorized("no-credential", "this relay identifies callers by session")

        credential = _credential(headers, params)
        if not credential:
            return _unauthorized(
                "no-credential",
                "present a tab token: Authorization: Bearer, X-DK-Token, the dk_token cookie, "
                "or ?dk_token= (the last of those ends up in proxy access logs)",
            )
        try:
            return self._auth.principal(credential)
        except AuthError:
            # ONE slug for every way a credential can fail, and the hint is
            # fixed. "The signature verified but the audience was wrong" tells
            # a forger that the forgery worked; "expired" and "not yet valid"
            # tell a prober the clock. A legitimate client's move is the same
            # in every case — mint a fresh token, retry once — so the
            # distinction buys it nothing and buys an attacker a test harness.
            # The reason is never logged either: it would be a log line about a
            # credential.
            return _unauthorized("bad-credential", "present a fresh tab token")

    def _owned(self, who: Principal, tab_id: str) -> "_Tab | None":
        """The caller's tab, or ``None``. The ONLY way this file finds a tab.

        ``None`` covers three cases on purpose — no such tab, somebody else's
        tab, and a tab outside what a tab-bound credential may address — and
        every caller turns it into the same ``no-such-tab``. Collapsing them
        here rather than at each endpoint is what makes the property hold for
        an endpoint added later: there is no lookup by bare tab id to reach
        for. Called with the lock.
        """
        if who.tab is not None and who.tab != tab_id:
            return None
        return self._tabs.get((who.id, tab_id))

    # ---- plumbing ----------------------------------------------------------

    def _push(self, tab: _Tab, force: bool = False) -> None:
        """Fan a tab's current snapshot out to its watchers. Called with the lock."""
        snapshot = tab.snapshot
        if snapshot is None:
            return
        rev = snapshot.get("rev")
        key = (tab.principal, tab.tab)
        if not force and self._broadcast.get(key, object()) == rev:
            return
        if isinstance(rev, int):
            self._broadcast[key] = rev
        chunk = _sse({"t": "snapshot", "tab": tab.tab, "snapshot": snapshot})
        # A copy, because a watcher that has hung up removes itself from the set
        # through its own close callback, which runs on another thread.
        for stream in list(self._watchers.get(key, ())):
            try:
                stream.write(chunk)
            except Exception as err:  # pragma: no cover - write() does not raise
                self._on_error(err)

    def _settle(self, pending: _Pending, result: dict[str, Any], outcome: str) -> None:
        """Answer a waiting call once, saying what the RELAY decided.

        ``outcome`` is required rather than derived from ``result``, for the
        reason the TypeScript relay's is: a relay refusal is recognisable from a
        ``WireResult`` only by its missing ``snapshot``, and an audit record
        must not rest on an invariant the wire can violate. Required also means
        a sixth place to settle a call cannot be added without saying what it
        is.

        One record per call, from the one place a call can be answered: the
        ``pending.result is not None`` guard above is what makes it one, because
        the deadline and a late ``result`` frame race and the loser must not log
        a second outcome for a call already answered.
        """
        if pending.result is not None:
            return
        pending.result = result
        pending.event.set()
        self._audit(pending.principal, pending.tab, pending.verb, pending.started, outcome)

    def _audit(self, principal: str, tab: str, verb: str, started: float, outcome: str) -> None:
        """Hand one record to the host, and survive the host.

        Byte for byte the same event the TypeScript relay emits -- same five
        field names, same four outcomes, ``at`` and ``ms`` in milliseconds since
        the epoch because that is what ``Date.now()`` is and an operator reading
        both logs must not have to convert one. A throw goes to ``on_error``,
        where everything else this relay cannot help goes: a 500 because the
        logging backend is down would turn an audit trail into an outage.
        """
        if self._on_audit is None:
            return
        at = time.time()
        try:
            self._on_audit(
                {
                    "at": int(at * 1000),
                    "ms": int((at - started) * 1000),
                    "principal": principal,
                    "tab": tab,
                    "verb": verb,
                    "outcome": outcome,
                }
            )
        except Exception as err:
            self._on_error(err)

    def _refusal(self, refused: str, hint: str) -> dict[str, Any]:
        """A refusal the relay originated: one of a closed set, and with NO
        ``snapshot``.

        The missing field is the whole signal. ``Result`` requires a snapshot
        because a driver mounted in a page always has one; the relay often does
        not — a call to a tab that never connected has no screen behind it at
        all — so the shape holds and ``snapshot`` goes missing, which is the
        truthful thing to say: nothing ran and nobody looked.

        An invented snapshot would be worse than a missing one in both
        directions. An empty one tells an agent the app has no rows, which is a
        lie about the app rather than about the call. A sentinel like
        ``{"where": "(not connected)"}`` is still a snapshot, so some client
        eventually renders it to a model as though it were a screen. Absence
        cannot be mistaken for either. The TS relay carried such a sentinel in
        its first draft and it was removed for exactly this reason; this is the
        one place the port must not be creative.
        """
        assert refused in RELAY_REFUSALS, f"{refused!r} is not a relay refusal"
        # Built through Result rather than by hand, because Result.to_dict is
        # already the code that omits an absent snapshot — and a second place
        # that decides what a refusal looks like is a second place to get it
        # wrong.
        return Result(ok=False, refused=refused, hint=hint).to_dict()

    def _summary(self, tab: _Tab) -> dict[str, Any]:
        """One row of ``GET /dk/tabs``. Called with the lock."""
        out: dict[str, Any] = {"tab": tab.tab}
        if tab.app is not None:
            out["app"] = tab.app
        if tab.title is not None:
            out["title"] = tab.title
        if tab.url is not None:
            out["url"] = tab.url
        # Forwarded exactly as the tab said it, including not at all. Absence
        # is "the tab did not say", which a client must not read as "not the
        # one". The relay has no opinion here and originates no value, for the
        # same reason it does not interpret ``rev``.
        if tab.focus is not None:
            out["focus"] = tab.focus
        if isinstance(tab.manifest, Mapping):
            # The version, not the manifest. Listing tabs is the cheap call an
            # agent makes often; inlining every manifest would make it the
            # expensive one, and the version is all a cache needs to learn its
            # copy went stale.
            out["manifestVersion"] = tab.manifest.get("version")
        if isinstance(tab.snapshot, Mapping) and "rev" in tab.snapshot:
            out["rev"] = tab.snapshot["rev"]
        out["since"] = tab.since
        return out


# --- small helpers ----------------------------------------------------------


def bad_request(status: int, hint: str, error: str = "bad-request") -> Response:
    """A non-2xx with ``{"error", "hint"}`` — deliberately NOT ``WireResult``-shaped.

    The slugs are the ones PROTOCOL.md's status table pins, and the ``400`` /
    ``409`` split behind them is the distinction worth keeping: **400 means the
    frame could never have been accepted by anyone; 409 means the frame was fine
    and the relay's state is what made it unacceptable.** A tab that gets a 409
    may reasonably reconnect and retry. A tab that gets a 400 has a bug. Reusing
    one slug for both takes that away, which is why ``bad-request`` is no longer
    the answer to everything.

    Exported because the adapters need it: a body over :data:`MAX_BODY` never
    reaches :meth:`Relay.handle`, and the answer to it must look like every
    other transport failure.
    """
    return _json(status, {"error": error, "hint": hint})


def _unauthorized(error: str, hint: str) -> Response:
    """A 401 with the challenge header, so an agent is told HOW to authenticate.

    401 rather than 403, and the split is worth keeping: a 401 says "present a
    different credential and this will work", which is actionable, while the
    403 the loopback guard answers says "nothing you can present will help".
    An agent that cannot tell them apart either retries a hopeless request or
    gives up on a fixable one.
    """
    return Response(
        401,
        _AUTH_HEADERS,
        json.dumps({"error": error, "hint": hint}).encode("utf-8"),
    )


def _credential(headers: Mapping[str, str], params: Mapping[str, str]) -> str | None:
    """The caller's credential, from the four places it can arrive.

    In order, and the order is the order of preference:

    1. ``Authorization: Bearer`` — what an agent, an MCP server or any HTTP
       client should use. Standard, and not logged by anything by default.
    2. ``X-DK-Token`` — for a client whose ``Authorization`` header is already
       spoken for by the app the relay is embedded in.
    3. The ``dk_token`` cookie (``__Host-`` prefixed or not) — the one that
       works for ``EventSource``, which cannot set a header at all. In the
       deployment PROTOCOL.md recommends, where the relay is same-origin with
       the app, this is the best option available to a page: the app sets the
       cookie and the browser attaches it to the stream request with no token
       anywhere in a URL.
    4. ``?dk_token=`` — the last resort, for a cross-origin ``EventSource``
       where no cookie will be sent. **A query parameter ends up in every
       reverse proxy's access log**, which is the one place a token must not
       be. It is accepted because refusing it would mean cross-origin pages
       could not connect at all, and it is listed last and documented as a
       liability. Short token lifetimes are what make a logged one survivable.
    """
    raw = headers.get("authorization", "")
    if raw[:7].lower() == "bearer ":
        return raw[7:].strip() or None

    direct = headers.get("x-dk-token")
    if direct and direct.strip():
        return direct.strip()

    cookie = headers.get("cookie")
    if cookie:
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name in ("dk_token", "__Host-dk_token") and value.strip():
                return unquote(value.strip())

    return params.get("dk_token") or None


def _headers(
    headers: Mapping[str, str] | Sequence[tuple[str, str]] | None,
) -> dict[str, str]:
    """Request headers, lowercased, in the many shapes an adapter has them.

    A repeated header is joined with ``", "`` rather than having one copy win.
    ``Cookie`` is the one that arrives repeated in practice (HTTP/2 splits it),
    and keeping only the first would silently drop the credential in a jar with
    several entries.
    """
    if not headers:
        return {}
    pairs = headers.items() if isinstance(headers, Mapping) else headers
    out: dict[str, str] = {}
    for key, value in pairs:
        # BOTH halves may be bytes. ASGI hands over raw byte pairs, and
        # `str(b"authorization")` is the seven-character string
        # `b'authorization'` — which matches nothing, silently, so every
        # credential in the deployment PROTOCOL.md recommends would be
        # invisible and every caller would be told it presented none.
        name = (key.decode("latin-1") if isinstance(key, bytes) else str(key)).lower()
        text = value.decode("latin-1") if isinstance(value, bytes) else str(value)
        if name in out:
            # `Cookie` joins with `; ` and everything else with `, `. That is
            # not cosmetic: a cookie jar is `;`-separated, so joining its copies
            # with a comma produces one pair whose VALUE is the rest of the jar,
            # and the credential inside it is unreachable.
            out[name] = out[name] + ("; " if name == "cookie" else ", ") + text
        else:
            out[name] = text
    return out


def too_large(limit: int = MAX_BODY) -> Response:
    """The pinned answer to a body over the limit. Used by the adapters.

    Read :data:`ABORT_BODY` before changing how an adapter gets here: the status
    is worthless if the sender never reads it.
    """
    return bad_request(413, f"a request body over {limit} bytes is a bug, not a call", "too-large")


def _accepted(note: str | None = None) -> Response:
    """The pinned answer to a frame the relay took: ``202 {"ok": true}``.

    202, not 200, and with nothing in the body but that. The answer to a call
    travels to the AGENT, not back up this POST, so a payload here would be an
    invitation to build a second, divergent return path.
    """
    return _json(202, {"ok": True} if note is None else {"ok": True, "note": note})


def _bad_method(allowed: str) -> Response:
    return bad_request(405, f"{allowed} only", "bad-method")


def _json(status: int, payload: Any) -> Response:
    return Response(status, _JSON_HEADERS, json.dumps(payload).encode("utf-8"))


def _sse(frame: Mapping[str, Any]) -> bytes:
    """One SSE frame.

    The event name matters: the page listens for `call` specifically, so an
    unnamed `message` would be silently dropped by ``EventSource``. So would a
    frame missing the blank line that terminates it.
    """
    return f"event: {frame['t']}\ndata: {json.dumps(frame)}\n\n".encode("utf-8")


def _loads(body: bytes | None) -> Any:
    """The request body as JSON, or ``None`` when it is not JSON at all.

    An empty body parses as ``{}``, matching the TS relay: a POST with no body
    is a malformed *call*, which is reported by the missing ``name`` rather than
    by a different status.
    """
    if body is None or not body.strip():
        return {}
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return None


def _query(query: Mapping[str, str] | Sequence[tuple[str, str]] | str | None) -> dict[str, str]:
    """Normalise the many shapes an adapter has a query string in."""
    if query is None:
        return {}
    if isinstance(query, str):
        return dict(parse_qsl(query.lstrip("?"), keep_blank_values=True))
    if isinstance(query, Mapping):
        return {str(k): str(v) for k, v in query.items()}
    return {str(k): str(v) for k, v in query}


def _is_loopback(address: str | None) -> bool:
    """Whether this peer is proven local.

    An unknown peer is NOT, which is the whole point: a Unix socket, a proxy
    that did not pass the address along, or an ASGI scope with no ``client``
    are all cases where the relay cannot tell, and "cannot tell" must not
    resolve to "allowed".
    """
    if not address:
        return False
    address = address.strip("[]")
    if "%" in address:  # fe80::1%en0 — a scoped v6 address
        address = address.split("%", 1)[0]
    return (
        address == "::1"
        or address == "::ffff:127.0.0.1"
        or address.startswith("127.")
        or address.startswith("::ffff:127.")
    )


def _now() -> str:
    """ISO 8601 with a ``Z``, the spelling ``GET /dk/tabs`` shows.

    A string on purpose: nothing computes with it, and it is read by a human
    choosing between two tabs.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
