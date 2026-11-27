"""
An MCP server over one driverkit tab.

**This is the server that runs today, and it has no dependencies.** The tool
generation it exposes lives in :mod:`driverkit.mcp_core`, shared with
:mod:`driverkit.fastmcp_server`; this file is the transport and nothing else.
The point of the whole arrangement, stated where the core states it: the tool
list is generated from the tab's manifest, so nothing in this package knows the
name of a single verb.

**Transport.** This hand-rolls MCP stdio over JSON-RPC 2.0 rather than using
the ``mcp`` package. The surface needed is ``initialize``,
``notifications/initialized``, ``tools/list``, ``tools/call`` and ``ping``, and
implementing it directly keeps the Python half dependency-free, which matches
the TS core's own promise of zero runtime dependencies. ``handle()`` is a pure
dict-to-dict function so the protocol can be tested without a subprocess.

**Authentication.** Stdio has none and needs none: the client launched this
process, so the trust boundary is the operating system's and there is nothing
on a wire to authenticate. What this server does need is a credential *of its
own* for the relay, naming the person whose tabs it may drive — see ``--token``.
An agent-facing server reachable over HTTP is a different problem and is what
:mod:`driverkit.fastmcp_server` is for; it is not hand-rolled here, because an
HTTP authentication scheme nobody else implements is one nobody else audits.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Mapping, TextIO

from .client import Driverkit, DriverkitError
from .mcp_core import (
    LIST_TABS,
    READ_SCREEN,
    TabTools,
    arg_schema,
    instructions_for,
    pick_tab,
    render_tabs,
    tools_for,
    verb_tool,
)
from .types import Manifest

__all__ = [
    "PROTOCOL_VERSION",
    "SERVER_NAME",
    "SERVER_VERSION",
    "LIST_TABS",
    "READ_SCREEN",
    "arg_schema",
    "verb_tool",
    "tools_for",
    "render_tabs",
    "pick_tab",
    "McpServer",
    "main",
]

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "driverkit"
SERVER_VERSION = "0.0.0"


# ---- the server ----------------------------------------------------------


class McpServer:
    """JSON-RPC 2.0 over stdio, in front of :class:`driverkit.mcp_core.TabTools`.

    Everything about *what* the tools are lives in the core. This class decides
    only what goes on the wire, which is why it is the half that can be tested
    with a dict and no subprocess.
    """

    def __init__(self, client: Driverkit, tab: str) -> None:
        self.client = client
        self.tab = tab
        self.tools = TabTools(client, tab)

    def manifest(self) -> Manifest:
        return self.tools.manifest()

    # -- JSON-RPC ---------------------------------------------------------

    def handle(self, message: Mapping[str, Any]) -> dict[str, Any] | None:
        """One JSON-RPC message in, at most one out.

        Returns ``None`` for a notification. A JSON-RPC notification has no
        ``id`` and must get no reply at all — answering one is the most common
        way a hand-rolled MCP server hangs a client, which sees a response it
        has no pending request for.
        """
        message_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        is_notification = "id" not in message

        try:
            if method == "initialize":
                result = self._initialize(params)
            elif method in ("notifications/initialized", "notifications/cancelled"):
                return None
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": self.tools.tools()}
            elif method == "tools/call":
                result = self._tools_call(params)
            else:
                if is_notification:
                    return None
                return _error(message_id, -32601, f"method not found: {method}")
        except DriverkitError as err:
            # A transport failure is a JSON-RPC error, not a tool result:
            # nothing ran, so there is no outcome to report to the model. A
            # refusal takes the other path — see _tools_call.
            if is_notification:
                return None
            return _error(message_id, -32603, f"driverkit: {err}")
        except Exception as err:  # pragma: no cover - last line of defence
            if is_notification:
                return None
            return _error(message_id, -32603, f"{type(err).__name__}: {err}")

        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": message_id, "result": result}

    def _initialize(self, params: Mapping[str, Any]) -> dict[str, Any]:
        manifest = self.manifest()
        return {
            # The client's requested version is not echoed back blindly: the
            # spec says the server states what it actually speaks and lets the
            # client disconnect if that is unacceptable.
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": f"{SERVER_NAME}/{manifest.app}", "version": SERVER_VERSION},
            "instructions": instructions_for(manifest),
        }

    def _tools_call(self, params: Mapping[str, Any]) -> dict[str, Any]:
        """``tools/call`` — the core does the work, this wraps it in MCP content.

        The ``isError`` reasoning is all in :meth:`TabTools.call`, where both
        servers read it. Repeating it here would be a second opinion about what
        counts as an error, and the one that drifts is the one that turns an
        unknown commit into a retried commit.
        """
        outcome = self.tools.call(str(params.get("name")), params.get("arguments") or {})
        return _content(outcome.text, is_error=outcome.is_error)

    # -- stdio ------------------------------------------------------------

    def serve(self, stdin: TextIO | None = None, stdout: TextIO | None = None) -> None:
        """Read newline-delimited JSON-RPC from stdin, write replies to stdout.

        Nothing but JSON-RPC may ever reach stdout — a stray ``print`` corrupts
        the stream — so diagnostics go to stderr.
        """
        source = stdin if stdin is not None else sys.stdin
        sink = stdout if stdout is not None else sys.stdout

        for line in source:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                _write(sink, _error(None, -32700, "parse error"))
                continue
            if not isinstance(message, Mapping):
                _write(sink, _error(None, -32600, "invalid request"))
                continue
            reply = self.handle(message)
            if reply is not None:
                _write(sink, reply)


def _content(text: str, *, is_error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _error(message_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


def _write(sink: TextIO, payload: Mapping[str, Any]) -> None:
    sink.write(json.dumps(payload) + "\n")
    sink.flush()


# ---- entry point ---------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="driverkit-mcp",
        description="Expose one driverkit tab to an MCP client.",
    )
    parser.add_argument("--relay", default="http://127.0.0.1:7777", help="relay base URL")
    parser.add_argument(
        "--token",
        default=os.environ.get("DK_TOKEN"),
        help="the tab token this server presents to the relay (env DK_TOKEN). Minted by the "
        "app's backend; it names the person whose tabs this server may see. A relay with no "
        "auth configured needs none. Prefer the env var: an argument is visible in `ps`.",
    )
    parser.add_argument(
        "--tab",
        default=None,
        help="tab id to drive. Omit it for the tab the person is looking at: with several "
        "connected, the focused one is used, and if that is ambiguous this refuses and prints "
        "the tabs rather than guessing.",
    )
    args = parser.parse_args(argv)

    client = Driverkit(args.relay, token=args.token)
    tab = args.tab
    if tab is None:
        try:
            tabs = client.tabs()
        except DriverkitError as err:
            print(f"driverkit: {err}", file=sys.stderr)
            return 1
        # `pick_tab` holds the whole rule, including the cases where it declines
        # to answer; see it for the four of them. Guessing here would mean
        # driving somebody's other screen. Note the listing is already scoped
        # to this token's principal, so "connected" here means "connected and
        # yours".
        chosen = pick_tab(tabs)
        if chosen is None:
            # ASKED, NOT GUESSED, and the listing is the question. A person who
            # is told which tabs are open and which one they are looking at can
            # answer in one line; a server that picked the first one gives them
            # nothing to notice until a commit lands in the wrong window.
            print(
                "driverkit: cannot tell which tab you mean, so pass --tab. "
                + (
                    "More than one tab is focused or none of them reports focus"
                    if tabs
                    else "No tabs are connected"
                )
                + ". connected:\n"
                + render_tabs(tabs, ""),
                file=sys.stderr,
            )
            return 1
        tab = chosen.id

    McpServer(client, tab).serve()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
