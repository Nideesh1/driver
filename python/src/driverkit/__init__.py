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
  an agent can both reach. A port of ``packages/driverkit/src/relay/relay.ts``, kept
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
from .render import SLOW_MS, render_duration, render_result, render_snapshot
from .types import (
    APPROVAL_REFUSALS,
    RELAY_REFUSALS,
    UNKNOWN_OUTCOME,
    VERB_KINDS,
    ArgSpec,
    FlowSpec,
    FlowStep,
    Manifest,
    Page,
    Result,
    Row,
    Scalar,
    ScreenSpec,
    Snapshot,
    Tab,
    VerbKind,
    VerbSpec,
)

# Read from the INSTALLED distribution rather than hand-written here, so it
# cannot disagree with what pip reports. It used to be a literal, and 0.1.0
# shipped with `__version__ == "0.0.0"`: the release rewrites
# `pyproject.toml` and had no reason to know a second copy existed. A number
# with one source cannot drift.
#
# The fallback is for a source checkout that was never installed -- running
# out of `python/src` with `PYTHONPATH`, which is exactly what this repo's
# own test suite does. "0.0.0" is the honest answer there: it is the
# placeholder in `pyproject.toml`, and a checkout has no release version.
try:  # pragma: no cover - trivial, and the except arm is the tested one
    from importlib.metadata import PackageNotFoundError, version as _version

    __version__ = _version("driverkit")
except Exception:  # PackageNotFoundError, or no metadata at all
    __version__ = "0.0.0"

__all__ = [
    "APPROVAL_REFUSALS",
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
    "FlowSpec",
    "FlowStep",
    "Manifest",
    "Page",
    "ProtocolError",
    "Relay",
    "Response",
    "Result",
    "Row",
    "Scalar",
    "ScreenSpec",
    "Snapshot",
    "Stream",
    "Tab",
    "TransportError",
    "VerbKind",
    "VerbSpec",
    "SLOW_MS",
    "render_duration",
    "render_result",
    "render_snapshot",
    "__version__",
]
