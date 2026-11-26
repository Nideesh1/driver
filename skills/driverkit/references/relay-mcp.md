# Case 2 — an agent somewhere else: the relay and MCP

Nothing can call *into* a browser tab: there is no address for it. So the tab dials out to a **relay** and holds the
line open; the relay is the one place both parties can reach. The agent talks to the relay over MCP, or over the
plain HTTP surface in [protocol.md](protocol.md).

```
agent ──► MCP ──► relay ──► your tab ──► your app's function
```

Same verbs, same screen, same results as the widget. The only difference is how the instruction arrives.

## 1. The page dials out

```ts
import { connect } from "@driverkit/browser";

const connection = connect(driver, {
  relay: "",                       // same origin: one process, one port, no CORS
  app: "Contacts",
  title: document.title,           // only so a human can tell two tabs apart
  token: () => fetchDkToken(),     // a GETTER, not a string — see auth.md
  onError: (err) => console.error("driverkit relay:", err),
});
// every mutation: connection.changed()   (debounced; cheap to over-call)
```

`connection.changed()` is how an agent mid-task learns the human moved and re-reads instead of acting on a dead
`rev`. Call it from the same funnel that bumps `rev`. `watchMs` polls `driver.snapshot().rev` instead and is the
escape hatch for a codebase too scattered to instrument — floored at 500 ms, because `visible()` runs on every
tick. Other options: `tab` (omit and one is minted and remembered in `sessionStorage`, so a reconnect resumes the
same identity), `debounceMs` (250), `backoffMs` / `maxBackoffMs` (500 / 10 000), `anonymous`, `tokenIn`,
`storage`, and injected `EventSource` / `fetch`.

`connection.tab` is a capability. Do not log it or show it.

## 2. The relay — embedded is the recommended deployment

**Mount it into the server you already run.** It then inherits that server's socket, TLS, auth, deploy and
supervision; a second process inherits none of those and has to be given each one again. Zero dependencies, ASGI
written by hand, no Starlette import:

```python
from fastapi import FastAPI
from driverkit.relay import Relay
from driverkit.asgi import relay_asgi

relay = Relay()                              # timeout_s=15, ping_s=20, allow_remote=False
app = FastAPI()
app.mount("/dk", relay_asgi(relay))          # or mount at "/" with fallback=your_app
```

`relay_asgi(relay, *, fallback=None, close_on_shutdown=True)`. Two notes that bite: `Relay.handle` **blocks** — a
`/call` returns when the tab's `result` arrives, because the HTTP request *is* the call — so every call goes
through `asyncio.to_thread`; and most frameworks do **not** forward lifespan events into a sub-app mounted with
`app.mount(...)`, so call `relay.close()` from your own shutdown hook (it hangs tabs up and fails calls in flight
as `tab-went-away` instead of letting each sit out its deadline).

Standalone, when there is no such server yet:

```sh
driverkit-relay                 # 127.0.0.1:7777. --host/--port/--timeout/--ping, env DK_HOST/DK_PORT/DK_TIMEOUT_S
                                # --allow-remote REQUIRES --secret and --audience (auth.md)
```

There is a second, behaviour-identical relay in TypeScript — `createRelay()` / `serve()` from `@driverkit/relay`,
with its own `TabAuth`. The two are tested against each other; pick whichever language your server is in.

## 3. The MCP server

```sh
driverkit-mcp --relay http://127.0.0.1:7777 --tab <id> --token "$DK_TOKEN"
```

- `--tab` may be omitted when exactly one tab is connected; otherwise it refuses and prints the tabs (titles and
  URLs) so a human can be asked which. Guessing would mean driving somebody's other screen.
- `--token` is the credential naming the person whose tabs this server may see; a relay with no auth needs none.
  Prefer `DK_TOKEN` in the environment — an argument is visible in `ps` to every user on the box.
- Stdio, JSON-RPC 2.0, hand-rolled (no `mcp` package), so the Python half stays dependency-free. Stdio needs no
  authentication of its own: the client launched the process.
- The tool list is **generated from the tab's manifest**, so nothing in the package knows the name of a single
  verb. It renders the same sentences about the same verbs as the in-page loop does — a verb described one way
  through MCP and another way in the widget would be a bug. Two tools are not verbs: `read_screen` and
  `list_tabs`.

In an MCP client's config:

```json
{ "mcpServers": { "driverkit": {
    "command": "driverkit-mcp",
    "args": ["--relay", "http://127.0.0.1:7777", "--tab", "7f3a-…"],
    "env": { "DK_TOKEN": "dkt1.…" } } } }
```

### MCP over HTTP is unverified

`driverkit.fastmcp_server` (`driverkit-fastmcp`, extra `driverkit[fastmcp]`) wraps the same core in FastMCP so the
server is reachable over HTTP with FastMCP's own `TokenVerifier` in front of it. **It has never been executed —
not once.** Its docstring lists the five things to check after installing the extra (FastMCP import paths,
`Tool` subclassing with a hand-written schema, `get_access_token()`, `mcp.run(transport="http")`, expired-token
behaviour). Do not put it in front of anybody's browser until somebody has. Its design property, worth preserving
through any fix: the token the agent authenticated with is the token the server presents to the relay — it mints,
swaps and widens nothing, so it cannot reach a tab the caller could not reach directly. The one exception is the
manifest, fetched once at start-up with the operator's own token, which is the static half and identical for
everybody.

## 4. Or just use the HTTP surface

```python
from driverkit import Driverkit

dk = Driverkit("http://127.0.0.1:7777", token=my_token)
tab = dk.tabs()[0].id                        # only this principal's tabs are listed
dk.manifest(tab)                             # cache it; `version` says when you may not any more
result = dk.call(tab, "select-where", {"company": "Acme"})   # the Result, with the screen after it ran
for snapshot in dk.watch(tab):               # SSE: follow a screen somebody else is driving
    ...
```

`render_snapshot` / `render_result` turn those into the same text a model sees in-page. The client does not refresh
a token (it cannot mint): a lapsed one arrives as `TransportError` on a 401, which is a transport failure and not a
refusal — nothing was asked of any tab.

Raw, for a shell check:

```sh
curl -s http://127.0.0.1:7777/dk/tabs
curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"select-where","args":{"company":"Acme Industrial"}}' \
  http://127.0.0.1:7777/dk/tabs/<tab>/call
```

A chunked body is decoded by both relays now (`examples/contacts/README.md` still warns otherwise — that note is
stale), but it is the first thing to suspect on a `400 bad-request` for a `/call` that plainly had a `name`.
[protocol.md](protocol.md) has the rest of the status rules — including why a `timeout` or
`tab-went-away` on a commit means the outcome is **unknown**, and the screen must be read before any retry.
