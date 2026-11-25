"""
driverkit — who the caller is, and nothing more than that.

This module answers exactly one question: **which person is on the other end of
this request?** It never answers "may they do this", because the relay has no
power to grant and nothing to scope. PROTOCOL.md's core property is unchanged
by everything in this file:

    THE RELAY GRANTS NO AUTHORITY. It forwards a verb to a tab that is already
    logged in as a person, and that tab's own session is what the app checks.

So a credential here is not a permission. It buys the holder no ability they
did not already have in their own browser. What it buys the *relay* is the
ability to keep a hundred people's tabs apart: to list only your tabs, to route
only your calls, and to make somebody else's tab id indistinguishable from one
that was never minted. Isolation, not authorisation.

WHY SIGNED TOKENS AND NOT A CALLBACK TO THE APP
-----------------------------------------------

The alternative considered was delegated introspection: the relay takes the
browser's credentials and asks the app ``GET /dk/whoami`` who they belong to.
It was rejected, and the reason is not the round trip.

To ask the app who a browser is, the relay must hold that browser's session
cookie and replay it. A relay that collects and replays user cookies is a
credential-handling component — it holds, for a hundred users at once,
something it could use to do anything any of them could do. That is precisely
the authority this design exists not to have, and it cannot be audited away:
the capability is inherent in the data the component holds. An HMAC key, by
contrast, can only *verify*. It mints nothing the relay can act with.

Three smaller costs finish the argument. Introspection makes the app a hard
dependency of every connect, so the app being slow is tabs failing to appear.
It needs a cache to be affordable, and a cache of "who is this browser" is a
session store — the user database the relay was not supposed to need. And the
deployment PROTOCOL.md recommends is a relay *embedded in the app's own
server*, where introspection is a process calling itself over HTTP.

What tokens cost, said plainly: a shared secret to distribute and rotate, no
revocation inside a token's lifetime, and a dependence on two machines' clocks
agreeing. Short lifetimes are what make the first two tolerable, and
:data:`DEFAULT_SKEW_S` is what makes the third.

For the embedded case there is a third door that needs no secret at all:
``Relay(resolve_principal=...)``, a function from request headers to a
principal id. An app with its own session middleware already knows the answer
and can simply say it. That hook is in :mod:`driverkit.relay`, not here,
because it involves no cryptography.

THE TOKEN
---------

::

    dkt1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "dkt1." + payload))>

The algorithm is in the *prefix*, not in the payload, and that is a deliberate
departure from JWT. A JWT names its own algorithm in a header the verifier has
not authenticated yet, which is the root of both the ``alg: none`` family of
bugs and the HMAC/RSA confusion family. Here there is nothing to negotiate: a
credential either starts with ``dkt1.`` and is HMAC-SHA256, or it is not a
credential. A future ``dkt2`` would be a new prefix, which is a visible,
greppable change rather than a field an attacker can set.

Claims, all of them required unless marked:

``sub``
    The principal. An opaque string the app chooses — a user id, not an email
    and not a display name, because it ends up in the relay's registry keys and
    nothing should be tempted to render it.
``aud``
    The audience: which relay this token is for. Checked exactly. Without it a
    secret shared by staging and production — which is what happens the first
    time somebody copies an env file — makes a staging token a production
    token.
``iat``, ``exp``
    Unix seconds. ``exp`` is honoured with :data:`DEFAULT_SKEW_S` of slack and
    an ``iat`` far in the future is refused, because a token minted by a
    machine whose clock is wrong is not evidence of anything.
``kid``
    Which key signed it. Read before verification and used to *select* the key;
    an attacker may change it freely and will then fail the MAC. Unknown kid is
    a refusal, never a fallback to trying every key.
``tab`` (optional)
    Binds the credential to one tab id. See :meth:`TabAuth.mint`.

ANONYMOUS
---------

An unauthenticated visitor is not an error, and "anonymous" is not one bucket.
An anonymous credential is ``anon1.<base64url(32 random bytes)>``, minted by
the page and kept in ``sessionStorage`` beside the tab id, and the principal it
resolves to is::

    anon:<sha256("driverkit-anon-v1." + secret)[:16].hex()>

Keyless on purpose. Deriving it with the relay's HMAC key would mean every
anonymous visitor's identity changed the day a key rotated, and the keying
would buy nothing: the only party who could correlate a principal id with a
secret is the party already holding the secret.

What it is: proof that this is the same browser that opened this tab, which is
all that isolation needs. Unguessable in the useful direction — the id is a
SHA-256 image of 256 random bits, so it cannot be worked back to the secret.
Independent per visitor, which is the requirement.

What it is not: an identity. It is a bearer capability, and whoever holds the
string *is* that principal. It does not survive the tab closing, deliberately.
It confers nothing at the app, which still sees an anonymous browser session.
An operator with real users should mint real tokens and set
``anonymous=False``; anonymous exists so that a visitor who has not logged in
still gets a working widget, not so that a login can be skipped.

Stdlib only: :mod:`hmac`, :mod:`hashlib`, :mod:`secrets`, :mod:`base64`,
:mod:`json`. No ``cryptography``, no ``PyJWT``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Mapping

__all__ = [
    "AuthError",
    "Principal",
    "TabAuth",
    "LOCAL_PRINCIPAL",
    "TOKEN_PREFIX",
    "ANON_PREFIX",
    "ANON_ID_PREFIX",
    "MIN_SECRET_BYTES",
    "DEFAULT_TTL_S",
    "DEFAULT_SKEW_S",
    "mint_anon_credential",
    "anon_principal_id",
]

#: The version prefix that *is* the algorithm. See the module docstring.
TOKEN_PREFIX = "dkt1"

#: The anonymous credential's prefix.
ANON_PREFIX = "anon1"

#: What an anonymous principal id starts with, so a host app reading the relay's
#: registry can tell one from a real user id without parsing.
ANON_ID_PREFIX = "anon:"

#: The principal every request resolves to when auth is off — the unconfigured
#: loopback relay one developer runs. One principal means the scoping below is
#: a no-op and the single-developer path is byte-for-byte what it was.
LOCAL_PRINCIPAL = "local"

#: Shortest key accepted. A 16-character shared secret makes the HMAC theatre,
#: and the moment to say so is at construction rather than in a post-mortem.
MIN_SECRET_BYTES = 32

#: How long a freshly minted token lasts. Short, because short lifetime is what
#: substitutes for the revocation a stateless token cannot have. The page asks
#: for a new one on every reconnect, so this does not need to cover a session.
DEFAULT_TTL_S = 120.0

#: Clock slack on ``exp``, and the window by which an ``iat`` may lead now.
#:
#: Sixty seconds, not five minutes. Skew tolerance is a direct extension of
#: every token's lifetime, so a five-minute window on a two-minute token would
#: more than treble the time a leaked one stays useful. Sixty seconds covers
#: two hosts with working NTP, which is the case this is for; a fleet whose
#: clocks are minutes apart has a problem that a wider window hides rather than
#: solves.
DEFAULT_SKEW_S = 60.0

_ANON_DOMAIN = b"driverkit-anon-v1."


class AuthError(Exception):
    """A credential did not check out.

    Deliberately carries no machine-readable reason. The relay answers every
    instance of this with one slug — ``bad-credential`` — because the
    distinctions a caller might want are exactly the distinctions an attacker
    wants: "the signature verified but the audience was wrong" tells a forger
    that the forgery worked. A legitimate client's response is the same in every
    case (mint a fresh token, retry once), so the split buys it nothing.

    The message is for a developer reading a log on the *minting* side, and the
    relay never puts it on the wire.
    """


@dataclass(frozen=True)
class Principal:
    """Who a request is from.

    ``id`` is the registry key half that makes isolation structural: a tab is
    stored under ``(principal.id, tab_id)``, so one principal cannot reach
    another's tab by any code path, including one somebody adds later and
    forgets to guard.

    ``tab`` is the optional binding from the credential. When it is set the
    caller may address that tab and no other, which is how an MCP server for
    one tab gets a credential that can only drive that tab.
    """

    id: str
    tab: str | None = None
    anonymous: bool = False


def anon_principal_id(credential: str) -> str:
    """The principal id an ``anon1.`` credential resolves to.

    Pure, keyless and stable: the same browser secret is the same principal
    across a key rotation, a relay restart and a second relay in the same
    deployment.
    """
    secret = credential.split(".", 1)[1] if "." in credential else ""
    digest = hashlib.sha256(_ANON_DOMAIN + secret.encode("utf-8")).digest()
    return ANON_ID_PREFIX + digest[:16].hex()


def mint_anon_credential() -> str:
    """A fresh anonymous credential. Called by the page, not by the relay.

    256 bits from :mod:`secrets`, because this string is the whole of an
    anonymous visitor's isolation: anybody who can guess it is that visitor.
    """
    return f"{ANON_PREFIX}.{_b64u(secrets.token_bytes(32))}"


class TabAuth:
    """Verification, and the minter the app's backend uses.

    The app's backend is the only thing that knows who a browser is, so it is
    the only thing that may mint. Give it the same ``keys`` and ``audience``
    the relay has and it needs nothing else — no relay client, no callback, no
    shared database.

    ``keys`` maps a key id to a secret. Rotation is additive:

    1. Generate the new key and add it to the **relay's** ``keys``. Deploy. The
       relay now accepts both; nothing mints with the new one yet.
    2. Point the minter at it (``active_kid``). Deploy.
    3. After ``ttl_s + skew_s`` has passed, drop the old key from the relay.

    Doing it in that order is the whole of it: a key the relay does not know
    yet is a key that refuses every token signed with it, and a key dropped
    before the last token signed with it expires logs a hundred people out at
    once.

    ``anonymous`` accepts ``anon1.`` credentials. On by default so that an
    unauthenticated visitor is not an error; turn it off in an app where every
    user is logged in, because then an anonymous credential can only be
    somebody probing.

    ``require_tab_binding`` refuses any ``dkt1`` token without a ``tab`` claim.
    Off by default — see :meth:`mint` for what the binding buys and what it
    costs.
    """

    def __init__(
        self,
        *,
        audience: str,
        keys: Mapping[str, bytes | str] | None = None,
        secret: bytes | str | None = None,
        active_kid: str | None = None,
        ttl_s: float = DEFAULT_TTL_S,
        skew_s: float = DEFAULT_SKEW_S,
        anonymous: bool = True,
        require_tab_binding: bool = False,
    ) -> None:
        if keys and secret is not None:
            raise ValueError("driverkit: pass keys= or secret=, not both")
        if secret is not None:
            # Sugar for the single-key case, which is every deployment until the
            # first rotation. It still gets a kid, so the token a single-key
            # relay mints is shaped exactly like the token a rotating one does
            # and rotation needs no format change.
            keys = {"k1": secret}
        if not keys:
            raise ValueError("driverkit: TabAuth needs keys= or secret=")
        if not audience:
            # No default, because a default audience is an audience nobody
            # chose, and two relays that both accept "driverkit" are one relay
            # as far as a stolen token is concerned.
            raise ValueError("driverkit: TabAuth needs an audience naming this relay")

        self._keys: dict[str, bytes] = {}
        for kid, value in keys.items():
            raw = value.encode("utf-8") if isinstance(value, str) else bytes(value)
            if len(raw) < MIN_SECRET_BYTES:
                raise ValueError(
                    f"driverkit: key {kid!r} is {len(raw)} bytes; at least {MIN_SECRET_BYTES} "
                    "are needed. `python3 -c \"import secrets;print(secrets.token_hex(32))\"`"
                )
            if not kid or "." in kid:
                raise ValueError(f"driverkit: {kid!r} is not a usable key id")
            self._keys[kid] = raw

        self.audience = audience
        self.ttl_s = float(ttl_s)
        self.skew_s = float(skew_s)
        self.anonymous = bool(anonymous)
        self.require_tab_binding = bool(require_tab_binding)
        self.active_kid = active_kid or next(iter(self._keys))
        if self.active_kid not in self._keys:
            raise ValueError(f"driverkit: active_kid {self.active_kid!r} is not in keys")

    # ---- minting, for the app's backend ------------------------------------

    def mint(
        self,
        principal: str,
        *,
        tab: str | None = None,
        ttl_s: float | None = None,
        now: float | None = None,
    ) -> str:
        """A token saying ``principal`` is who the bearer is.

        ``tab`` binds the token to one tab id, and whether to use it is the one
        real judgement call here.

        It costs a round trip. The tab mints its own id — PROTOCOL.md requires
        that, so a reconnect resumes identity — which means the backend cannot
        know the id at page-render time. Binding therefore turns one template
        variable into "the page asks the backend for a token *after* the JS has
        picked an id", and re-asks on every reconnect that changes it.

        **It is not strictly safer, and the asymmetry is worth understanding
        before choosing.** Both cases assume a stolen token, which is the only
        case either addresses.

        *Unbound.* The thief cannot read or drive the victim's tabs. They can
        register a tab *they* control under the victim's principal. It runs in
        their browser, where their own session is what the app checks, so they
        gain no authority — but the victim's agent now sees a tab that is not
        the victim's and may drive it, typing the victim's data onto the
        attacker's screen. Call it injection: an extra tab, the real ones
        untouched.

        *Bound to tab T.* The thief cannot do that. What they can do is open a
        stream for T — and a second stream for a known ``(principal, tab)`` is a
        RECONNECT, which supersedes the first. So the victim's own page is hung
        up on and the thief's becomes that tab, until the victim's
        ``EventSource`` reconnects and supersedes back. Calls land on whichever
        stream is current. That is a takeover of the exact tab the agent is
        already driving, which is worse than an extra tab in the list, and it is
        not a reason to skip binding so much as a reason not to believe the
        binding is the whole defence.

        The property that actually bounds both is **the token not leaking**:
        deliver it in a ``__Host-`` cookie rather than a query parameter, keep
        the lifetime short, and read the residual-weakness note in PROTOCOL.md
        about what a short lifetime does and does not bound.

        A credential for an **agent** should be bound whenever the agent drives
        one known tab. There it is free — the agent has the tab id already — and
        the supersede hazard does not apply, because an agent never opens a tab
        stream.
        """
        if not principal:
            raise ValueError("driverkit: a token needs a principal")
        if principal.startswith(ANON_ID_PREFIX):
            # Otherwise a backend bug could mint a signed token claiming to be
            # an anonymous principal, and the two kinds would stop being
            # distinguishable — which is the one thing `Principal.anonymous`
            # is for.
            raise ValueError(f"driverkit: {ANON_ID_PREFIX!r} is reserved for anonymous visitors")
        issued = time.time() if now is None else now
        life = self.ttl_s if ttl_s is None else float(ttl_s)
        payload: dict[str, object] = {
            "sub": principal,
            "aud": self.audience,
            "iat": int(issued),
            "exp": int(issued + life),
            "kid": self.active_kid,
        }
        if tab:
            payload["tab"] = tab
        # Compact and sorted, so the same claims are the same bytes. Nothing
        # depends on it today; a test that pins a token does, and a reader
        # comparing two tokens by eye does.
        body = _b64u(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        return f"{TOKEN_PREFIX}.{body}.{_b64u(self._mac(self.active_kid, body))}"

    # ---- verification, for the relay ---------------------------------------

    def principal(self, credential: str, *, now: float | None = None) -> Principal:
        """The principal a credential proves, or :class:`AuthError`.

        Anonymous first, because it needs no key and cannot be confused with a
        token: the prefixes are disjoint and both are checked exactly.
        """
        credential = (credential or "").strip()
        if not credential:
            raise AuthError("empty credential")

        if credential.startswith(ANON_PREFIX + "."):
            if not self.anonymous:
                raise AuthError("anonymous credentials are not accepted by this relay")
            secret = credential[len(ANON_PREFIX) + 1 :]
            if len(secret) < 32:
                # 32 base64url characters is 24 bytes. A short anonymous secret
                # is a guessable principal, and a guessable anonymous principal
                # is the shared bucket this design exists to avoid.
                raise AuthError("an anonymous secret must be at least 32 characters")
            return Principal(id=anon_principal_id(credential), tab=None, anonymous=True)

        parts = credential.split(".")
        if len(parts) != 3 or parts[0] != TOKEN_PREFIX:
            raise AuthError("not a dkt1 token")
        _, body, signature = parts

        claims = _loads(_b64u_decode(body))
        if not isinstance(claims, dict):
            raise AuthError("the payload is not a JSON object")

        kid = claims.get("kid")
        if not isinstance(kid, str) or kid not in self._keys:
            # Refused, never retried against the other keys. "Try them all"
            # turns a rotation window into a period where every key is live for
            # every token, which is the opposite of what rotating is for.
            raise AuthError("unknown key id")

        want = self._mac(kid, body)
        got = _b64u_decode(signature)
        # Constant time, and length-safe: compare_digest on unequal lengths is
        # false without leaking where they diverged.
        if not hmac.compare_digest(want, got):
            raise AuthError("the signature does not verify")

        # Everything below this line is reading an AUTHENTICATED payload. The
        # order matters: nothing from `claims` was trusted above except `kid`,
        # which only selects the key the MAC is then checked with.
        if claims.get("aud") != self.audience:
            raise AuthError("the token is for another audience")

        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            raise AuthError("the token names no principal")
        if sub.startswith(ANON_ID_PREFIX):
            raise AuthError(f"a signed token may not claim an {ANON_ID_PREFIX!r} principal")

        moment = time.time() if now is None else now
        exp = claims.get("exp")
        iat = claims.get("iat")
        if not _is_number(exp) or not _is_number(iat):
            raise AuthError("the token has no usable iat/exp")
        if float(exp) + self.skew_s < moment:
            raise AuthError("the token has expired")
        if float(iat) - self.skew_s > moment:
            # A token from the future is not evidence. Accepting it would let a
            # minter with a wrong clock issue credentials that outlive their
            # stated lifetime by however far the clock is out.
            raise AuthError("the token was issued in the future")

        tab = claims.get("tab")
        if tab is not None and (not isinstance(tab, str) or not tab):
            raise AuthError("the tab claim is not a tab id")
        if self.require_tab_binding and not tab:
            raise AuthError("this relay requires a tab-bound token")

        return Principal(id=sub, tab=tab, anonymous=False)

    def _mac(self, kid: str, body: str) -> bytes:
        # The prefix is inside the MAC, so a `dkt2` with a different meaning
        # cannot be produced by relabelling a `dkt1` payload.
        return hmac.new(
            self._keys[kid], f"{TOKEN_PREFIX}.{body}".encode("utf-8"), hashlib.sha256
        ).digest()


# ---- small helpers ---------------------------------------------------------


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64u_decode(text: str) -> bytes:
    """Unpadded base64url, with anything undecodable raised as an AuthError.

    Strict, so that ``dkt1.<json>.<sig>`` with a payload that merely *looks*
    like base64 is a refusal rather than a mojibake principal id.
    """
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except Exception as err:  # binascii.Error, and ValueError on odd input
        raise AuthError("not base64url") from err


def _loads(raw: bytes) -> object:
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as err:
        raise AuthError("the payload is not JSON") from err


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
