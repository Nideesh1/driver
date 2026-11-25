# driverkit

Make a web app drivable by an agent. No pixels, no selectors, no model.

Your app declares what it can do and what is on screen. An agent calls those
verbs by name. The app's own functions run, and the UI moves the way it would
have if somebody had clicked.

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

That is the whole integration. One new file in your app, one import.

## Why not a screenshot, and why not a selector

Driving a web app from the outside usually means one of two things. Reading
pixels tells you where a button is but not what it does, and costs roughly
seven times the tokens of the same screen as text. Guessing CSS selectors
breaks the next time somebody renames a class.

Neither is necessary when the app is willing to say what it can do. A verb is
a name, an argument list, and a function the app already had — so there is no
selector to rot, and the agent is told what a call will refuse before it makes
it.

## The two things it drives

**A chat panel in the corner of your app.** The page holds the driver, so
there is no transport at all — a loop asks a model what to do and calls the
verb. Your API key stays on your backend behind one endpoint.

```ts
import { mountWidget } from "@driverkit/widget";
import { backendThink } from "@driverkit/agent";

mountWidget(driver, { think: backendThink("/api/chat") });
```

**An agent somewhere else — another process, another machine, a voice
assistant.** Nothing can call *into* a browser tab, so the tab dials out to a
relay and holds the line open. The agent talks to the relay over MCP.

```
agent ──► MCP ──► relay ──► your tab ──► your app's function
```

```sh
pip install driverkit
driverkit-relay          # or mount it in the server you already run
driverkit-mcp --tab <id>
```

Same verbs, same screen, same results. The only difference is how the
instruction arrives.

## What makes bulk work safe

Ask an agent to "select every contact at Acme and accept the top thousand" and
two things can go wrong. It can try to select a thousand rows one call at a
time, and it can accept the wrong thousand.

So a verb declares what it does to the world:

| kind | means |
|---|---|
| `read` | changes nothing |
| `describe` | changes what is selected or filtered, reports a `count` |
| `commit` | changes data, may be irreversible |

A `describe` verb takes a predicate and resolves it **inside the app**, where
the rows already are, and returns how many matched. A `commit` verb takes no
predicate at all and acts on the current selection. Two calls, so a count is
always seen before data moves — and selecting a thousand rows is one call
rather than a thousand.

The widget asks before every commit, and shows the count the `describe`
reported. One commit is one question, however many rows it covers.

## What the agent sees

The verbs are static — the same for every user on every day — so they are sent
once and cached. The screen is dynamic and small by construction: an agent is
never shown more than the person at the keyboard, same filters, same page. A
hundred rows on screen is a hundred rows in the prompt whether the table holds
a hundred or a million.

Every call returns the screen *after* it ran, so acting and observing are one
round trip instead of two.

## Apps that are not tidy

If your actions already exist as functions, a verb calls them. If they only
exist inside a JSX click handler, mark the button yourself and the verb clicks
it — a handle you chose, not a selector somebody guessed:

```tsx
<button data-dk="bulk-accept" onClick={/* whatever lives here */}>
```

```ts
import { clickHandle, rowsFromTable, revFromMutations } from "@driverkit/adapters";

{ name: "bulk-accept", kind: "commit", run: clickHandle("bulk-accept") }
```

`@driverkit/adapters` also reads a rendered table into rows and derives a
change counter from DOM mutations, so an app with no store at all can be
driven today and cleaned up later, one verb at a time.

## Packages

| package | what |
|---|---|
| `driverkit` | the registry: verbs, the screen, one `call` |
| `@driverkit/widget` | the chat panel |
| `@driverkit/agent` | the loop behind it, provider-neutral |
| `@driverkit/adapters` | reading a rendered DOM |
| `@driverkit/browser` | the page side of the relay |
| `@driverkit/relay` | the relay, in TypeScript |
| `driverkit` (PyPI) | the relay and the MCP server, in Python |

No runtime dependencies in any of them. The wire protocol is written down in
[`PROTOCOL.md`](PROTOCOL.md), and the relay has two independent
implementations that are tested against each other.

## Running the example

A contacts app with 3,412 rows, the widget in the corner, and the relay
mounted on the same server — so one page is drivable both ways.

```sh
npm install && npm run build
export ANTHROPIC_API_KEY=...
python3 examples/contacts/server.py
```

## Status

Early. The protocol, the registry and both relays are covered by tests and the
end-to-end path has been driven for real, from a browser and from outside it.
Treat the APIs as unstable until there is a tagged release.

```sh
npm test          # TypeScript
cd python && python3 -m unittest discover -s tests -t tests
```

MIT.
