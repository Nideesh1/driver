# driverkit

Make a web app drivable by an agent. No pixels, no selectors, no model.

Your app declares what it can do and what is on screen. An agent calls those
verbs by name. The app's own functions run, and the UI moves the way it would
have if somebody had clicked.

```sh
npm i driverkit
```

```ts
import { mount } from "driverkit";

const driver = mount({
  app: "Contacts",
  verbs: [
    { name: "search", kind: "read", describe: "filter the list",
      args: { q: { type: "string", describe: "what to search for" } },
      run: ({ q }) => store.search(q) },

    { name: "select-where", kind: "describe", describe: "select every contact at a company",
      args: { company: { type: "string", describe: "company name" } },
      run: ({ company }) => ({ count: store.select(company) }) },

    { name: "accept-selected", kind: "commit", describe: "accept the current selection",
      refuses: ["nothing-selected"],
      run: (_, ctx) => store.selected.size ? store.accept() : ctx.refuse("nothing-selected") },
  ],
  visible: () => ({
    where: "contacts",
    rev: store.rev,
    rows: store.onScreen(),
    page: { index: store.page, size: 20, total: store.total },
    selected: store.visibleSelection(),
    selectedCount: store.selected.size,
  }),
});
```

That is the whole integration: one new file in your app, one import.

## Entry points

One package, one version, one changelog. Tree-shaking keeps a page free of
what it does not import.

| import | what |
|---|---|
| `driverkit` | the registry: verbs, the screen, one `call` |
| `driverkit/widget` | a chat panel in the corner of your own app |
| `driverkit/agent` | the loop behind it, provider-neutral |
| `driverkit/controls` | three generic verbs over elements you marked `data-dk-control` — see [CONTROLS.md](CONTROLS.md) |
| `driverkit/browser` | the page side of the relay: one SSE stream, held open |
| `driverkit/relay` | the relay — **Node only** |

`driverkit/relay` imports `node:http`, so it is published under a `"node"`
export condition and no other. A browser-targeted build that asks for it fails
at build time with the import named, rather than pulling Node builtins into a
page bundle. There is no browser shim on purpose: a `createRelay` that
resolved to an empty module would silently do nothing, which is worse than a
build error.

Pre-1.0, so one version covers everything — a widget fix bumps this number
too. That is deliberate: there is one number that says which driverkit you are
running, and no matrix of which widget works with which core.

No runtime dependencies. `@types/node` is a types-only dependency, there
because the relay's own `.d.ts` files re-export `node:http` types in their
public surface; nothing is emitted into a page bundle by it.

## The two things it drives

**A chat panel in the corner of your app.** The page holds the driver, so
there is no transport at all — a loop asks a model what to do and calls the
verb. Your API key stays on your backend behind one endpoint.

```ts
import { mountWidget } from "driverkit/widget";
import { backendThink } from "driverkit/agent";

mountWidget(driver, { think: backendThink("/api/chat") });
```

**An agent somewhere else** — another process, another machine, a voice
assistant. Nothing can call *into* a browser tab, so the tab dials out to a
relay and holds the line open. The agent talks to the relay over MCP.

```
agent ──► MCP ──► relay ──► your tab ──► your app's function
```

The relay ships twice, once here and once on PyPI (`pip install driverkit`,
which also carries the MCP server). The two implementations are tested against
each other, frame for frame.

## Status

Early. Treat the APIs as unstable until there is a tagged release.

The full README, the wire protocol, the design arguments and a 3,412-row demo
that is drivable both ways live in the repository.

MIT.
