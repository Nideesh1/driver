---
name: driverkit
description: Make a web app drivable by an agent with driverkit — the app declares verbs, an agent calls them by name, no pixels and no selectors. Use when the user wants to let an agent or chatbot operate their own app ("let Claude drive this UI", "add an agent panel to my app"), write or review a driverkit verb list, mount() a driver, add the @driverkit/widget chat panel and its /api/chat endpoint, drive a tab from another process through the relay and MCP, set up tab-token auth for a multi-user deployment, adopt an app that has no store with @driverkit/adapters, or troubleshoot a tab that connects and does nothing.
allowed-tools: Bash(npm test*) Bash(npm run build*) Bash(curl -s http://127.0.0.1:*) Bash(python3 -m unittest*)
---

# driverkit

driverkit makes an app drivable by naming what it can do. The app declares **verbs** (a name, typed arguments, a
function it already had) and a **snapshot** (what a person could see right now), and an agent calls the verbs by
name. No screenshots — an image costs ~7× the tokens and still cannot say what a button does. No selectors —
nothing breaks when a class is renamed. No model and no API key in the library.

Two integrations, same verbs: a **chat panel in the corner of the app** (`@driverkit/widget`, no transport at all,
the key stays on the app's backend) and an **agent in another process** (the tab dials out to a **relay**, the agent
talks to the relay over MCP). Packages: `driverkit` (core `mount()`), `@driverkit/widget`, `@driverkit/agent`,
`@driverkit/adapters`, `@driverkit/browser`, `@driverkit/relay`, and `driverkit` on PyPI (relay + MCP + auth).
`PROTOCOL.md` at the repo root is the wire contract and is the thing to read first.

## State of the library — say this before recommending it

- **Unpublished.** Nothing is on npm or PyPI; versions are all `0.0.0`. `npm install driverkit` and
  `pip install driverkit` do not work yet. Install from a checkout — [packaging.md](references/packaging.md).
- **Never used on a real app.** The only integration that exists is `examples/contacts`, written by the author.
  Expect to be the first person to hit any given edge.
- **Proven:** both paths driven end to end — the widget against a live Anthropic model in a real browser, and the
  relay path from another process — plus 462 TS tests and the Python suite, with the two relay implementations
  (TS and Python) tested against each other.
- **Not proven:** `driverkit.fastmcp_server` (MCP over HTTP) **has never been executed once** — its own docstring
  lists the five things a human must check. Auth is unit-tested but has never run in a multi-user deployment.
  The APIs are unstable; treat a verb rename as a breaking change to stored prompts.

## Pick the path

| The user wants to ... | Do | Details |
|---|---|---|
| **write or review a verb list for their app** (the hard part) | read the repo, then draft verbs | [authoring-verbs.md](references/authoring-verbs.md) |
| see that procedure run on a messy app | a worked draft, verb by verb, with the `kind` reasoning | [worked-example.md](references/worked-example.md) |
| write `visible()` honestly (`rev`, `page`, `selected`) | the snapshot contract and its three `page` states | [snapshot.md](references/snapshot.md) |
| **adopt an app with more than one screen** | `Verb.screen`, `Snapshot.screen`, `CallOptions.screen`, `instructions` | [screens.md](references/screens.md) |
| a chat panel inside their own app (case 1) | `mountWidget(driver, { think: backendThink("/api/chat") })` + that endpoint | [widget.md](references/widget.md) |
| drive the app from another process, a voice assistant, Claude Desktop (case 2) | relay (standalone or ASGI-mounted) + `driverkit-mcp` | [relay-mcp.md](references/relay-mcp.md) |
| deploy for more than one person | signed tab tokens the app's backend mints; anonymous visitors | [auth.md](references/auth.md) |
| adopt an app with no store, or only buttons | the three-tier ladder, `clickHandle`, `fromDom` | [adapters.md](references/adapters.md) |
| write another client, or debug the wire | frames, the status table, `/watch`, reserved refusals | [protocol.md](references/protocol.md) |
| install it today, build it, run the example | workspace build, `dist`, type stripping, uv | [packaging.md](references/packaging.md) |
| fix "the tab connects and nothing happens" | | [troubleshooting.md](references/troubleshooting.md) |

Read the matching reference before editing code.

## The verb list is the whole job

Installing driverkit is ten minutes. **Writing the verb list is a judgement call over somebody's codebase**, and
getting it wrong is what costs them. In short, and at length in [authoring-verbs.md](references/authoring-verbs.md):

1. **Find the actions that already exist as functions** — a store, an API client, a `lib/` layer. Those are tier-1
   verbs. The ones trapped inside JSX click handlers are tier-2 ([adapters.md](references/adapters.md)).
2. **Name them as intents in the user's vocabulary**, not as wrappers over internals: `park`, not `setLane`. An
   illegal move should be **inexpressible**, not refused.
3. **Declare `kind` on every verb**, and get `commit` right. A `commit` mislabelled `read` tells an agent an
   irreversible call is free to try. `read` means changes no data and reports no count — navigation is a read —
   and `describe` is about what is **selected**, not what is filtered. Pair `describe` (takes the predicate,
   reports a `count`) with `commit` (takes no predicate, acts on the selection) so a number is always seen before
   data moves, and mark a `commit` the app can undo `reversible: true` so the capitals go on meaning something.
4. **Bulk work takes a predicate, never a repeated id.** `select-where({ company })`, not `select(id)` ×1000.
5. **`visible()` returns the real on-screen window** — same filters, same page, with `page` and `selectedCount`,
   and never more rows than the person can see.

## Rules

- Ask before adding dependencies or editing app code. Add them the way the project already does
  (`uv add` / `uv pip` in Python — never bare `pip`; `npm i` / `pnpm add`).
- **Never put an API key in the page.** `think` posts to the app's own backend, which already authenticates this
  person and already holds the key. A `widget` option that took a key would be a widget that leaks one.
- Nothing per-user or per-screen may go in the static half (`app`, verb `describe`, `instructions`, the backend's
  `system`). One user-specific string there busts the prompt cache for everybody and the library stops being cheap.
- **The tool list must not vary with the live screen.** Declare the mapping statically with `Verb.screen` and let
  the core refuse `wrong-screen`; a verb list that changed on navigation would bust the prefix every time the
  person moved. The app's own briefing goes in `MountOptions.instructions`, never in every snapshot's `note`.
- Keep the snapshot to a screenful. A snapshot near the relay's 1 MiB body limit is a bug in `visible()`.
- Never fill `Snapshot.selected` with every selected id — on-screen ids only, with `selectedCount` for the size.
- A verb may not be named — or refuse with — a reserved slug: `stale`, `wrong-screen`, `unknown-verb`,
  `bad-argument`, `unmounted`, `threw`, `no-such-tab`, `tab-went-away`, `timeout`, `declined-by-user`. `mount()`
  throws on a reserved verb name or a reserved declared refusal. `wrong-screen` is the one an app is most likely to
  have invented for itself; `Verb.screen` replaces that guard — [screens.md](references/screens.md).
- A tab id is a capability. Do not log it, print it in the UI, or paste it into a chat.
- `allow_remote` without `auth=` or `resolve_principal=` refuses to start. That is deliberate; do not work around it.
- `timeout` and `tab-went-away` on a `commit` mean the outcome is **unknown**. Read the screen before retrying.

## Common recipes

The whole integration — one new file in the app, one import:

```ts
import { mount } from "driverkit";

const driver = mount({
  app: "Contacts",
  verbs: [
    { name: "search", kind: "read", describe: "filter the list",
      args: { q: { type: "string", describe: "what to search for" } },
      run: ({ q }) => store.search(q) },
    { name: "select-where", kind: "describe", describe: "select every contact at a company",
      args: { company: { type: "string", describe: "company name", oneOf: [...COMPANIES] } },
      run: ({ company }) => ({ count: store.select(company) }) },      // the count a commit turns on
    { name: "accept-selected", kind: "commit", describe: "accept the current selection",
      refuses: ["nothing-selected"],
      run: (_, ctx) => store.selected.size ? store.accept() : ctx.refuse("nothing-selected") },
  ],
  visible: () => ({
    screen: "contacts",                     // the stable id; `where` is the prose about it
    where: "the contacts list", rev: store.rev, rows: store.onScreen(),
    page: { index: store.page, size: 20, total: store.total },
    selected: store.visibleSelection(), selectedCount: store.selected.size,
  }),
});
```

Case 1 — the panel (commits are confirmed with the person by default):
```ts
import { mountWidget } from "@driverkit/widget";
import { backendThink } from "@driverkit/agent";
mountWidget(driver, { think: backendThink("/api/chat") });   // you must write /api/chat — widget.md
```

Case 2 — from outside (`relay: ""` = same origin, so one process and no CORS):
```ts
import { connect } from "@driverkit/browser";
connect(driver, { relay: "", app: "Contacts", token: () => fetchToken() });  // a getter, never a string
```
```sh
driverkit-relay                      # or mount driverkit.asgi.relay_asgi into the server you already run
driverkit-mcp --relay http://127.0.0.1:7777 --tab <id>
```

## Check it works

- `npm test` (builds first — the widget needs a built `@driverkit/agent` on disk) and, in `python/`,
  `python3 -m unittest discover -s tests -t tests`.
- Run the example: `python3 examples/contacts/server.py` with `ANTHROPIC_API_KEY` set, then
  `http://127.0.0.1:8770/examples/contacts/app/`. No npm install and no bundler — the server strips types as it
  serves. Without a key the page, table and relay still work; only the widget says so in its transcript.
- `curl -s http://127.0.0.1:7777/dk/tabs` lists connected tabs (only the caller's own, once auth is on).
- `driver.manifest()` in the console is exactly what the model is told the app can do. Read it as a stranger would.
