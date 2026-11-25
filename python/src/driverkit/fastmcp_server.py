"""
An authenticated MCP server over one driverkit tab, built on FastMCP.

    *** THIS MODULE HAS NEVER BEEN EXECUTED. ***

``uv`` panics in macOS SystemConfiguration on the machine this was written on
and DNS was unreliable, so ``fastmcp`` could not be installed and nothing here
has run even once. It is written against the real FastMCP 2.x API from
knowledge of it, and it is the half of this package a human must verify before
trusting. :mod:`driverkit.mcp_server` is the server that runs today, has no
dependencies, and is tested; nothing here replaces it or is imported by it.

What a human must check, after ``uv add 'driverkit[fastmcp]'``:

1. ``from fastmcp.server.auth.auth import TokenVerifier`` and the
   ``AccessToken`` import below both resolve, and ``AccessToken``'s field names
   are the ones used in :meth:`TabTokenVerifier.verify_token`. These have moved
   between FastMCP versions more than once.
2. Subclassing ``fastmcp.tools.tool.Tool`` with an explicit ``parameters``
   JSON Schema and an ``async def run`` is still how a tool with a
   hand-written schema is registered. If FastMCP now wants
   ``Tool.from_function`` only, the fix is to build a function per verb and
   attach the schema — the schema itself comes from
   :func:`driverkit.mcp_core.tools_for` either way and does not change.
3. ``get_access_token()`` returns the verified token inside a tool call, and
   ``.token`` is the raw credential string. The pass-through in
   :meth:`_VerbTool.run` is the whole security model of this file.
4. ``mcp.run(transport="http", ...)`` serves at the path and with the auth
   challenge a client expects, and an unauthenticated request is refused with
   a 401 rather than reaching a tool.
5. That an expired token is refused, and that the refusal reaches the client as
   an auth error rather than as a tool result.

WHY FASTMCP'S AUTH AND NOT A SCHEME OF OUR OWN
----------------------------------------------

Stdio needs no authentication: the client launched the process, so the trust
boundary is the operating system's. An MCP server reachable over HTTP is a
different thing — it is an agent-facing endpoint that can drive a person's
logged-in browser — and it needs real authentication. FastMCP has that:
``TokenVerifier``, the ``auth=`` parameter, the ``get_access_token()``
dependency, a 401 with a challenge, and OAuth resource-server behaviour on top.
Hand-rolling any of it would mean an HTTP authentication scheme nobody else
implements and therefore nobody else audits, which is the opposite of what a
security-sensitive surface wants.

What is plugged into it is driverkit's own token format, as a custom
``TokenVerifier``. FastMCP ships a ``JWTVerifier``, and using it would mean the
tokens were JWTs — which would mean the *relay* verified JWTs, which would mean
``PyJWT`` or ``cryptography`` in the relay. The relay is stdlib-only on purpose
(PROTOCOL.md's whole argument is that it belongs inside a server you already
run, in any language, with no dependencies), so the format is HMAC-SHA256 with
a fixed algorithm prefix and the verifier here is twenty lines over
:meth:`driverkit.auth.TabAuth.principal`. One token format, two consumers.

THE SERVER HOLDS NO CREDENTIAL OF ITS OWN FOR THE CALLER'S WORK
---------------------------------------------------------------

The important property, and the one to preserve through any change above: the
token the agent authenticated with is the token this server presents to the
relay. It does not mint, swap or widen anything. So this server cannot reach a
tab the caller could not reach by talking to the relay directly, and a bug in
it cannot become a privilege escalation — there is no privilege here to
escalate to. A proxy that held an operator's credential and used it on behalf
of whoever authenticated would be exactly the ambient-authority component that
PROTOCOL.md's "the relay grants no authority" exists to keep out of the design.

The one exception is the MANIFEST, fetched once at startup with the operator's
own ``DK_TOKEN`` so the tool list exists before anybody connects. That is the
app's verb table — the static half, identical for every user, describing what
the app can do and nothing about anybody's screen. No snapshot, no tab listing
and no call is ever made with that credential.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

from .auth import TabAuth
from .client import Driverkit, DriverkitError
from .mcp_core import TabTools, instructions_for, tools_for

__all__ = ["FASTMCP_AVAILABLE", "TabTokenVerifier", "build_server", "main"]

#: Whether ``fastmcp`` imported. The module itself always imports, so that
#: ``driverkit`` is usable — and testable — on a machine where ``fastmcp`` is
#: not installed, which is the machine this was written on. Every entry point
#: below raises a message that says what to install.
FASTMCP_AVAILABLE = True

try:  # pragma: no cover - depends on an optional dependency
    from fastmcp import FastMCP
    from fastmcp.exceptions import ToolError
    from fastmcp.server.auth.auth import TokenVerifier
    from fastmcp.server.dependencies import get_access_token
    from fastmcp.tools.tool import Tool, ToolResult
    from mcp.server.auth.provider import AccessToken
except Exception:  # noqa: BLE001 - ImportError, and anything a broken install raises
    FASTMCP_AVAILABLE = False

    # Placeholders so the class definitions below are syntactically reachable.
    # They are never instantiated: `_require_fastmcp` is called first by every
    # path that would.
    class _Missing:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            _require_fastmcp()

    FastMCP = _Missing  # type: ignore[assignment,misc]
    Tool = _Missing  # type: ignore[assignment,misc]
    ToolResult = _Missing  # type: ignore[assignment,misc]
    ToolError = RuntimeError  # type: ignore[assignment,misc]
    TokenVerifier = _Missing  # type: ignore[assignment,misc]
    AccessToken = _Missing  # type: ignore[assignment,misc]

    def get_access_token() -> Any:  # type: ignore[misc]
        _require_fastmcp()


_INSTALL_HINT = (
    "driverkit: this server needs `fastmcp`, which is an optional extra:\n"
    "    uv add 'driverkit[fastmcp]'\n"
    "The stdio server in driverkit.mcp_server needs nothing and is the one that "
    "runs today: `driverkit-mcp --tab <id>`."
)


def _require_fastmcp() -> None:
    if not FASTMCP_AVAILABLE:
        raise RuntimeError(_INSTALL_HINT)


class TabTokenVerifier(TokenVerifier):  # type: ignore[misc]
    """FastMCP's ``TokenVerifier`` over a driverkit tab token.

    This is the whole of the authentication: a bearer token arrives, FastMCP
    hands it here, and :meth:`driverkit.auth.TabAuth.principal` says whose it
    is or refuses it. The same ``TabAuth`` the relay has, with the same keys and
    the same audience, so there is one credential an agent needs and not two.

    Returning ``None`` is how FastMCP is told to refuse. Every way a credential
    can fail returns the same ``None`` with nothing logged, for the reason
    :class:`driverkit.auth.AuthError` gives: the distinctions a caller might
    want are the distinctions an attacker wants.

    ``client_id`` carries the principal. It is the field FastMCP surfaces to a
    tool, and the principal is the only thing a tool here needs to know.
    """

    def __init__(self, auth: TabAuth) -> None:
        super().__init__()
        self._auth = auth

    async def verify_token(self, token: str) -> "AccessToken | None":
        try:
            principal = self._auth.principal(token)
        except Exception:  # noqa: BLE001 - AuthError, and never distinguished
            return None
        return AccessToken(
            token=token,
            client_id=principal.id,
            # No scopes, and that absence is the design rather than an omission.
            # A scope would be an authority this server granted, and it grants
            # none: what the caller may do is what their own browser session may
            # do, which the app checks and nothing here can widen. See
            # PROTOCOL.md, "Who is allowed to do this".
            scopes=[],
            expires_at=None,
        )


class _VerbTool(Tool):  # type: ignore[misc]
    """One manifest verb as one FastMCP tool.

    The schema is :func:`driverkit.mcp_core.tools_for`'s, unchanged, because
    that function is the only description of the app's verbs that exists and a
    second translation here would be a second one to get wrong.

    Each call builds its own :class:`driverkit.Driverkit` from the CALLER'S
    token. Not a client held on the server: a shared client would hold one
    credential and serve every authenticated caller with it, which is the
    confused-deputy shape this file's docstring is about. One client per call
    costs a connection and buys the property that this server cannot reach what
    its caller cannot.
    """

    relay_url: str
    tab: str | None
    verb: str

    async def run(self, arguments: dict[str, Any]) -> "ToolResult":
        access = get_access_token()
        if access is None:  # pragma: no cover - FastMCP refuses before this
            raise ToolError("unauthenticated")

        client = Driverkit(self.relay_url, token=access.token)
        try:
            tab = self.tab or _only_tab(client)
            outcome = TabTools(client, tab).call(self.verb, arguments)
        except DriverkitError as err:
            # A transport failure, not a tool result: nothing ran, so there is
            # no outcome to report to the model. `ToolError` is FastMCP's
            # `isError`, which is what that means.
            raise ToolError(f"driverkit: {err}") from err

        if outcome.is_error:
            # True only when the call provably never landed. A refusal and a
            # `timeout` both come back as ordinary text — see
            # `TabTools.call`, where the reasoning lives for both servers.
            raise ToolError(outcome.text)
        return ToolResult(content=outcome.text)


def _only_tab(client: Driverkit) -> str:
    """The caller's one tab, or an error naming the others.

    Reached only when the server was started without ``--tab`` and the caller's
    token binds none. The listing is already scoped to the caller's principal by
    the relay, so "the only tab" means "the only one of theirs" — two people
    driving two tabs each both get their own, and neither sees the other's in
    the error message.
    """
    tabs = client.tabs()
    if len(tabs) == 1:
        return tabs[0].id
    if not tabs:
        raise ToolError("driverkit: no tab of yours is connected to this relay")
    # Guessing would mean driving somebody's other screen — and here "somebody"
    # may be the same person, which is no better.
    raise ToolError(
        "driverkit: this server drives one tab and you have "
        f"{len(tabs)} connected: {', '.join(t.id for t in tabs)}. Use a tab-bound token, "
        "or run a server per tab."
    )


def build_server(
    *,
    relay_url: str,
    auth: TabAuth,
    tab: str | None = None,
    bootstrap_token: str | None = None,
) -> "FastMCP":
    """A FastMCP server whose tools are this app's verbs.

    ``bootstrap_token`` fetches the MANIFEST once, at startup, so a tool list
    exists before any agent connects. It is the operator's own credential and
    it is used for nothing else — see the module docstring: the manifest is the
    app's verb table, identical for every user, and carries nothing about
    anybody's screen. Every snapshot, every tab listing and every call uses the
    caller's own token.

    ``tab`` fixes which tab this server drives. Omit it and each call resolves
    the caller's single tab, which fails usefully when they have two. A
    tab-bound token is the better answer where the agent knows its tab: the
    relay then refuses anything else as ``no-such-tab`` and this server is not
    the thing enforcing it.
    """
    _require_fastmcp()

    manifest = Driverkit(relay_url, token=bootstrap_token).manifest(tab) if tab else None
    if manifest is None:
        # Without a tab there is nothing to ask for a manifest, so the operator
        # must say which tab this server is for. Deferring would mean a server
        # that advertises no tools until somebody calls one, which no client
        # recovers from.
        raise ValueError(
            "driverkit: build_server needs a tab to read the manifest from. The manifest is "
            "the app's static verb table; a server cannot advertise tools without it."
        )

    mcp = FastMCP(
        name=f"driverkit/{manifest.app}",
        instructions=instructions_for(manifest),
        auth=TabTokenVerifier(auth),
    )

    for schema in tools_for(manifest):
        mcp.add_tool(
            _VerbTool(
                name=schema["name"],
                description=schema["description"],
                parameters=schema["inputSchema"],
                relay_url=relay_url,
                tab=tab,
                verb=schema["name"],
            )
        )
    return mcp


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - unexecuted
    """The ``driverkit-fastmcp`` console script.

    Not wired into ``[project.scripts]`` as the default anything. ``uv add
    driverkit`` installs ``driverkit-mcp``, which works; this appears only when
    the ``fastmcp`` extra is installed, and a run without it fails with the
    install hint rather than a traceback about a missing module.
    """
    parser = argparse.ArgumentParser(
        prog="driverkit-fastmcp",
        description="Expose one driverkit tab to authenticated MCP clients over HTTP.",
        epilog="UNVERIFIED: see this module's docstring for what to check first.",
    )
    parser.add_argument("--relay", default=os.environ.get("DK_RELAY", "http://127.0.0.1:7777"))
    parser.add_argument("--tab", default=os.environ.get("DK_TAB"), help="the tab to drive")
    parser.add_argument(
        "--audience",
        default=os.environ.get("DK_AUDIENCE"),
        help="the audience of the tokens this server accepts (env DK_AUDIENCE). The same "
        "value the relay is configured with: one token, two consumers.",
    )
    parser.add_argument("--host", default=os.environ.get("DK_MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DK_MCP_PORT", "7788")))
    parser.add_argument(
        "--stdio",
        action="store_true",
        help="serve over stdio instead of HTTP. Authentication is then the operating "
        "system's, as it is for driverkit-mcp.",
    )
    args = parser.parse_args(argv)

    if not FASTMCP_AVAILABLE:
        print(_INSTALL_HINT, file=sys.stderr)
        return 2

    secret = os.environ.get("DK_SECRET")
    if not secret or not args.audience:
        # env, not an argument: an argument is visible in `ps` to every user on
        # the box.
        print(
            "driverkit-fastmcp: set DK_SECRET and --audience/DK_AUDIENCE to the same values "
            "the relay has. Without them this server would accept any caller, and it is "
            "reachable over HTTP.",
            file=sys.stderr,
        )
        return 2
    if not args.tab:
        print("driverkit-fastmcp: --tab is required; see build_server.", file=sys.stderr)
        return 2

    try:
        mcp = build_server(
            relay_url=args.relay,
            auth=TabAuth(secret=secret, audience=args.audience),
            tab=args.tab,
            bootstrap_token=os.environ.get("DK_TOKEN"),
        )
    except (ValueError, DriverkitError) as err:
        print(f"driverkit-fastmcp: {err}", file=sys.stderr)
        return 2

    if args.stdio:
        mcp.run()
    else:
        mcp.run(transport="http", host=args.host, port=args.port)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
