# Installing it today, building it, running the example

**Nothing is published.** Every version is `0.0.0`; `npm install driverkit` and `pip install driverkit` fetch
something else or nothing. So an app consumes this from a checkout until there is a tagged release.

## The TypeScript side

Seven packages in one workspace (`packages/*`, declared for both npm `workspaces` and `pnpm-workspace.yaml`):

| package | what | runtime deps |
|---|---|---|
| `driverkit` | the core: `mount`, `refusal`, `checkArg`, `RESERVED_REFUSALS`, the types | none |
| `@driverkit/widget` | the corner panel | `@driverkit/agent`, `driverkit` |
| `@driverkit/agent` | `drive`, `backendThink`, the tool/prompt rendering | none |
| `@driverkit/adapters` | reading a rendered DOM | none |
| `@driverkit/browser` | `connect`: the page side of the relay | none |
| `@driverkit/relay` | the relay in TypeScript, plus `TabAuth` and `serve` | none |

`@driverkit/widget` is the only cross-package **value** import in the repository (it imports `drive`); everything
else between packages is `import type`, which type-stripping erases outright.

```sh
npm install              # creates node_modules/driverkit and node_modules/@driverkit/* as links to packages/*
npm run build            # tsc -b tsconfig.build.json  → each package's dist/
npm test                 # runs the build FIRST, then node --experimental-strip-types --test packages/*/test/*.test.ts
npm run typecheck
```

The build is not optional before the tests: each package's `exports` names `dist/`, and the widget resolves
`@driverkit/agent` at runtime through the workspace link, so the widget tests need a built agent on disk. There is
deliberately **no `paths` mapping** — the repository typechecks the way a consumer does, through each package's own
`exports`.

Every package publishes only `dist` + `README.md`, is `"type": "module"`, `sideEffects: false`, with
`exports["."] = { types: "./dist/index.d.ts", default: "./dist/index.js" }` (plus `@driverkit/relay`'s `./serve`).

To consume it from another project before release, in rough order of how little will surprise you: a file
dependency (`"driverkit": "file:../driverkit/packages/core"`) after `npm run build`; `npm pack` in each package you
need and install the tarballs; or `pnpm link`. Whichever you pick, **build first** — `dist/` is gitignored, and an
unbuilt package resolves to nothing.

## The Python side

Stdlib only. Nothing in `dependencies`, because PROTOCOL.md's argument is that the relay belongs inside a server
you already run and a dependency is a reason it cannot be.

```sh
uv pip install -e ./python                 # or: uv pip install ./python
uv pip install -e './python[fastmcp]'      # the UNVERIFIED FastMCP server only — see relay-mcp.md
```

Use `uv` (`uv run`, `uv pip`, `uv venv`), not bare `python3 -m pip`. Console scripts: `driverkit-relay`,
`driverkit-mcp`, `driverkit-fastmcp` (which fails with an install hint, not a traceback, when the extra is absent).
Requires Python ≥ 3.11. Tests: `cd python && python3 -m unittest discover -s tests -t tests`.

Exports from the top-level package: `Relay`, `Driverkit`, `TabAuth`, `Principal`, `mint_anon_credential`,
`render_snapshot`, `render_result`, the types (`Manifest`, `Snapshot`, `Result`, `Tab`, `Page`, `Row`, `ArgSpec`,
`VerbSpec`, `VERB_KINDS`, `RELAY_REFUSALS`, `UNKNOWN_OUTCOME`) and the errors. `relay_asgi` is reached through
`driverkit.asgi` rather than the top level, so importing the client or the MCP server does not drag in `asyncio`
for nothing.

## The example, which needs neither

```sh
export ANTHROPIC_API_KEY=…                   # never written to disk, never logged
python3 examples/contacts/server.py          # DK_PORT=8770 DK_HOST=127.0.0.1 DK_MODEL=… DK_MAX_TOKENS=2048
open http://127.0.0.1:8770/examples/contacts/app/
```

No `npm install`, no build step, no bundler: `tsstrip.py` erases the types out of the library's `.ts` sources as the
server serves them, so a browser imports the library unchanged. One server does three jobs — static files,
`/api/chat` (the `Think` endpoint, where the key lives), and the relay mounted at `/dk` — so one page is drivable
both ways at once, same origin, no CORS. `DK_LLM_IP` connects to a given address while keeping the `Host` header
and TLS SNI on the real name, for a shell where DNS does not work. Without a key the page, table and relay all
work; only the widget doesn't, and it says so in its transcript rather than going quiet.

Its own checks are worth copying as a pattern: `verify_strip.py` (the stripper, against the library's own tests),
`verify_app.py` (the demo fetched over HTTP and driven for real), `verify_chat.py` (the Anthropic translation
against a fake endpoint), `check.mjs` (the demo driven four ways: `driver.call` directly, through `drive()`,
through the widget, and through the relay).

`examples/contacts/app/store.js` holds the store, `visible()` and the verb table with **no DOM imports**, which is
why `check.mjs` can drive the real verbs with no browser in the picture. Do that in your own app too.
