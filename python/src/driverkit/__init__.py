"""
driverkit — the Python half.

Four things live here, and they are the whole backend side of PROTOCOL.md:

* :class:`driverkit.Driverkit`, a synchronous client for the relay's
  agent-facing HTTP surface, returning the same four shapes the TypeScript core
  defines.
* :mod:`driverkit.mcp_server`, which turns a tab's manifest into an MCP tool
  list so any MCP client can drive the app without anybody hand-writing a tool
  per feature.
* :class:`driverkit.TabAuth`, which is how a relay serving more than one
  person learns which person a request is from — and, on the app backend's
  side, the minter that says so. It grants nothing; see
  :mod:`driverkit.auth`.
* :class:`driverkit.Relay`, the relay itself — the one place a browser tab and
  an agent can both reach. A port of ``packages/relay/src/relay.ts``, kept
  behaviour-for-behaviour identical to it, because two relays that differ would
  be worse than either.
* two ways to run that relay: :func:`driverkit.asgi.relay_asgi` mounts it into
  a FastAPI, Starlette or Django app you already run, which is the deployment
  PROTOCOL.md argues for, and :mod:`driverkit.serve_relay` (the
  ``driverkit-relay`` command) runs it alone when there is no such app yet.

``relay_asgi`` is reached through ``driverkit.asgi`` rather than from here, so
that importing the client or the MCP server does not drag in :mod:`asyncio` for
nothing.

The wire contract both sides implement is ``PROTOCOL.md`` at the repository
root. It, and not this code, is the thing to read first.
"""

from .auth import AuthError, Principal, TabAuth, mint_anon_credential
from .client import Driverkit, DriverkitError, ProtocolError, TransportError
from .relay import Relay, Response, Stream
from .render import render_result, render_snapshot
from .types import (
    RELAY_REFUSALS,
    UNKNOWN_OUTCOME,
    VERB_KINDS,
    ArgSpec,
    Manifest,
    Page,
    Result,
    Row,
    Scalar,
    Snapshot,
    Tab,
    VerbKind,
    VerbSpec,
)

__version__ = "0.0.0"

__all__ = [
    "RELAY_REFUSALS",
    "AuthError",
    "Principal",
    "TabAuth",
    "mint_anon_credential",
    "UNKNOWN_OUTCOME",
    "VERB_KINDS",
    "ArgSpec",
    "Driverkit",
    "DriverkitError",
    "Manifest",
    "Page",
    "ProtocolError",
    "Relay",
    "Response",
    "Result",
    "Row",
    "Scalar",
    "Snapshot",
    "Stream",
    "Tab",
    "TransportError",
    "VerbKind",
    "VerbSpec",
    "render_result",
    "render_snapshot",
    "__version__",
]
