# Installing it today, building it, running the example

**Nothing is published.** Every version is `0.0.0`; `npm install driverkit` and `pip install driverkit` fetch
something else or nothing. So an app consumes this from a checkout until there is a tagged release.

## The TypeScript side

**One package**, `packages/driverkit`, with a subpath per area. `packages/eval` sits beside it in the workspace
(`packages/*`, declared for both npm `workspaces` and `pnpm-workspace.yaml`) and is a development tool nobody
installs: it serves its own `src` rather than a `dist`, and is deliberately absent from `tsconfig.build.json`.

| import | what | sources |
|---|---|---|
| `driverkit` | the registry: `mount`, `refusal`, `checkArg`, `selectionId`, `RESERVED_REFUSALS`, the types | `src/core/*.ts` |
| `driverkit/widget` | the corner panel | `src/widget/*.ts` |
| `driverkit/agent` | `drive`, `backendThink`, the tool/prompt rendering | `src/agent/*.ts` |
| `driverkit/controls` | `controlsFromDom`: three generic verbs over marked elements | `src/controls/*.ts` |
| `driverkit/browser` | `connect`: the page side of the relay | `src/browser/*.ts` |
| `driverkit/relay`, `driverkit/relay/serve` | the relay in TypeScript, plus `TabAuth` and `serve` | `src/relay/*.ts` |

The areas import each other by relative path, so they are one TypeScript program and there is no build order to
derive. One install and one version for everything: a widget fix bumps the core's version, which pre-1.0 is
deliberate.

`driverkit/relay` is the one entry that is **not** browser-safe — it imports `node:http`, which is what drove the
original six-package split. It is published under a `"node"` export condition and nothing else, so a
browser-targeted bundler asking for the subpath finds no target and fails loudly at build time instead of pulling
`node:http` into a page. There is no `browser` or `default` fallback on purpose: a shim resolving to an empty
module would hand somebody a `createRelay` that silently does nothing. `test/packaging.test.ts` resolves every
subpath under browser conditions and asserts that this one is unreachable. `@types/node` is a real dependency and
not a dev one, because the relay's `.d.ts` files re-export `node:http` types in their public surface.

```sh
npm install              # creates node_modules/driverkit as a link to packages/driverkit
npm run build            # tsc -b tsconfig.build.json  → packages/driverkit/dist/<area>/
npm test                 # runs the build FIRST, then node --experimental-strip-types --test packages/*/test/*.test.ts
npm run typecheck
```

Every test is flat in `packages/driverkit/test/` and reaches into `../src/*.ts` by relative path, so the build is
not strictly needed to run them — except that `test/packaging.test.ts` asks what the package publishes, and that
question needs the built files on disk. It skips itself when they are absent rather than passing vacuously, and a
skipped packaging test is how a packaging regression would get through. There is deliberately **no `paths`
mapping**: the repository typechecks and resolves the way a consumer does, through the package's own `exports`.

The package publishes `dist` + `README.md` + `CONTROLS.md`, is `"type": "module"` and `sideEffects: false` — which
is what lets a bundler prove a page is free of the subpaths it does not import.

To consume it from another project before release, in rough order of how little will surprise you: a file
dependency (`"driverkit": "file:../driverkit/packages/driverkit"`) after `npm run build`; `npm pack` and install
the tarball; or `pnpm link`. Whichever you pick, **build first** — `dist/` is gitignored, and an unbuilt package
resolves to nothing.

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

No `npm install`, no bundler and no import map: the demo's module URLs are relative paths into
`../../../packages/driverkit/dist/<area>/`, and `tsstrip.py` erases the types out of the library's `.ts` sources as the
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
