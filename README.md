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

## Adding it to your app

The procedure is **[`INTEGRATING.md`](INTEGRATING.md)** — one file, written to be followed cold, by an agent or by
you, with the app open:

```
1  npm i driverkit                              (pre-release: from a checkout, for now)
2  draft the verb list     →  src/driverkit.ts  most of the work, and all of the judgement
3  prune it                ←  a drafted list is a proposal. Which actions to expose is a product decision
4  import it once             in the app's entry point
5  write /api/chat            the in-page panel does not work without it
6  write ~5 eval cases        and run them. Until this, nobody knows whether step 2 worked
```

The rest of this README is the argument for the design — why verbs and not pixels, what makes bulk work safe,
what the agent actually sees. Read it to decide whether you want this; read `INTEGRATING.md` to do it.

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
import { mountWidget } from "driverkit/widget";
import { backendThink } from "driverkit/agent";

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
| `read` | changes no data and reports no count. Navigation is a read |
| `describe` | changes what is **selected**, changes no data, reports a `count` |
| `commit` | changes data. `reversible: true` says the app can undo it |

`read` does not promise that nothing changes, because the commonest verb in a
multi-screen app moves the person's screen out from under them. The two
promises worth making are the ones that decide whether the next call is safe —
no data moved, and no count left pending — and both are true of a navigation.

`describe` is about selection and not about filtering. A search box changes
what is filtered and reports no count, so none of what makes `describe` safe
applies to it: the count is the number a following `commit` turns on, and the
pair is the safety mechanism. A verb that narrows a list and leaves nothing
pending is a `read`.

A `describe` verb takes a predicate and resolves it **inside the app**, where
the rows already are, and returns how many matched. A `commit` verb takes no
predicate at all and acts on the current selection. Two calls, so a count is
always seen before data moves — and selecting a thousand rows is one call
rather than a thousand.

The widget asks before every commit, and shows the count the `describe`
reported. One commit is one question, however many rows it covers.

A `commit` the app can put back says `reversible: true`, and is told to the
model in plain words rather than capitals. Changing a page size and accepting
3,412 contacts were both just `commit`, so both got the same shouted banner —
and a banner that fires on a page size is a banner a model learns to read past,
the same way a person learns to click Yes without reading.

## What the agent sees

The verbs are static — the same for every user on every day — so they are sent
once and cached. The screen is dynamic and small by construction: an agent is
never shown more than the person at the keyboard, same filters, same page. A
hundred rows on screen is a hundred rows in the prompt whether the table holds
a hundred or a million.

Every call returns the screen *after* it ran, so acting and observing are one
round trip instead of two.

## Apps with more than one screen

The verb list must **not** change with the screen: one that did would bust the
cached prompt prefix on every navigation, which is the whole cost argument. So
every verb is offered everywhere, and the mapping is declared once in the half
that gets cached.

```ts
{ name: "sort-companies", kind: "read", screen: "companies", … }

visible: () => ({
  screen: "contacts",                                   // the stable id, compared with ===
  where: "the contacts list, filtered to “Acme”",       // prose, for a human
  rev: store.rev,
})
```

A call made off a verb's screen is refused as `wrong-screen`, naming the screen
you are on *and* the one the verb wants. An agent can also say which screen it
believed it was on — `driver.call("next-page", {}, { screen: "contacts" })` —
and get the same refusal when the person has clicked away mid-run; a paging
call with no such claim used to page a different list and answer `ok`.
`wrong-screen` is reserved, so an app may not name a verb or a refusal of its
own that, and `mount()` says so.

The app's own briefing goes in `MountOptions.instructions`, which reaches
`Manifest.instructions` and therefore both ways in — the in-page system prompt
and an agent arriving over the relay or MCP. A host embedding the app can add
its own `instructions` to `drive()` or the widget; the app's is folded in
first, so the host's is the one a model follows if they disagree.

## Apps that are not tidy

### Your app has no store

`visible()` returns a `Snapshot`. Where it comes from is your app's business,
and driverkit deliberately ships no reader for any particular shape — there
used to be `rowsFromTable`, `revFromMutations` and `fromDom`, and each one was
a guess at how an app holds its data, which is the thing this library exists
not to do. If your rows only exist as rendered markup, the ten lines that read
them are yours and they are short:

```ts
const rows = () =>
  [...document.querySelectorAll("#contacts tbody tr")].map((tr) => {
    const cell = (n) => tr.children[n].textContent.trim();
    return { id: tr.dataset.dkId, name: cell(0), company: cell(1), status: cell(2) };
  });

// `rev` must move whenever anything an agent reads changes, and must never go
// backwards. A counter your own code bumps is better than anything derived
// from the DOM; a MutationObserver is the fallback when you have nowhere to
// put one.
let rev = 1;
new MutationObserver(() => { rev += 1; }).observe(
  document.querySelector("#contacts"), { childList: true, subtree: true, characterData: true },
);

mount({ app: "Contacts", verbs, visible: () => ({ where: "contacts", rev, rows: rows() }) });
```

Ten lines you can read beats an import that works for four table shapes and
silently reports the wrong `id` column for the fifth. Two things to get right,
both of which a reader would have had to guess for you:

* **`id` is what an agent passes back.** Use the id your own records have, not
  a row number — a positional id is stable until somebody sorts the table.
* **Zero rows is a claim.** `rows: []` says "there are no records". If your
  table has not rendered yet, omit `rows` entirely and say so in `note`;
  absent means "this snapshot carries no row information", which is a
  different answer and the honest one.

### Your actions only exist inside click handlers

Mark the button yourself and the verb clicks it — a handle you chose, not a
selector somebody guessed:

```tsx
<button data-dk="bulk-accept" onClick={/* whatever lives here */}>
```

```ts
const clickHandle = (name) => () => {
  const el = document.querySelector(`[data-dk="${name}"]`);
  if (!el) throw new Error(`driverkit: no handle ${name}`);
  el.click();
};

{ name: "bulk-accept", kind: "commit", describe: "accept every pending contact",
  run: clickHandle("bulk-accept") }
```

Four lines, shorter than the import that used to provide them. The cost is
real and no library can carry it for you: a click runs whatever the handler
does, so you have to read the handler to declare `kind` — and a rendered but
disabled button accepts a click, does nothing, and the call reports `ok`. Check
`disabled` before clicking if you have any.

### Somebody asks for the thing nobody wrote a verb for

A verb list is a set of shortcuts, and shortcuts are incomplete by
construction. `driverkit/controls` is the other layer: mark the elements an
agent may use, and it gets three generic verbs — `press`, `type-into`,
`commit-control` — over whatever is on screen right now.

```html
<button data-dk-control="next-page"  data-dk-kind="read">Next</button>
<input  data-dk-control="search"     data-dk-kind="describe" placeholder="Search" />
<button data-dk-control="accept-all" data-dk-kind="commit">Accept all</button>
```

```ts
import { controlsFromDom } from "driverkit/controls";

const dk = controlsFromDom({ root: "#app", rows: "#contacts" });

mount({
  app: "Contacts",
  verbs: [...myShortcuts, ...dk.verbs],
  visible: () => dk.withControls(myVisible()),
});
```

This is enumeration, not inference: it lists the marks you made and nothing
else — no label matching, no roles, no "did you mean", because a near miss is
how an agent presses Delete when it meant Dismiss. A shortcut is still how
bulk work is safe (one call, four hundred rows, one count); a control is how
the four hundred and first request gets done at all.

It is also the only part of the library that resolves a name to an element in
order to act, and `data-dk-kind` is a claim nothing here can check — mark a
Delete button `read` and it is pressed without a question. Read
[`CONTROLS.md`](packages/driverkit/CONTROLS.md), which argues the whole design
and lists what it does not do, before importing it.

## Entry points

One package. One install, one version, one changelog.

```sh
npm i driverkit
```

| import | what |
|---|---|
| `driverkit` | the registry: verbs, the screen, one `call` |
| `driverkit/widget` | the chat panel |
| `driverkit/agent` | the loop behind it, provider-neutral |
| `driverkit/controls` | the generic verbs over marked controls |
| `driverkit/browser` | the page side of the relay |
| `driverkit/relay` | the relay, in TypeScript — **Node only** |
| `driverkit` (PyPI) | the relay and the MCP server, in Python |

This was six packages, which for a library whose contract is one function was
a table of contents pretending to be an architecture. Subpaths cost nothing a
bundler cannot shake out: import `driverkit/widget` and your bundle contains
the widget and the core, not the relay.

`driverkit/relay` imports `node:http`, and that is the one thing a browser
bundler cannot swallow — it is the reason for the original split. It is
published under a `"node"` condition and no other, so a browser-targeted build
asking for it fails at build time, with the import named, rather than pulling
Node builtins into a page. There is deliberately no browser shim: a
`createRelay` that resolved to an empty module would silently do nothing,
which is worse than a build error.

The same goes for TypeScript, which is worth knowing before it surprises you:
under `moduleResolution: "bundler"` — the conditions a bundler applies —
`import { createRelay } from "driverkit/relay"` is a `TS2307`, because that
code could not have been bundled either. Server code that imports the relay
wants `moduleResolution: "nodenext"`, under which every entry above resolves.

The accepted cost of one package is one version: a widget fix bumps the
version of the core, and of everything else. Before 1.0 that is a feature —
there is one number to say which driverkit you are running, and no matrix of
which widget works with which core.

No runtime dependencies (`@types/node` is types-only, for the relay's own
declarations). The wire protocol is written down in
[`PROTOCOL.md`](PROTOCOL.md), and the relay has two independent
implementations that are tested against each other.

## Try it before you integrate it

A contacts app with 3,412 rows across six screens, the widget in the corner,
and the relay mounted on the same server — so one page is drivable both ways,
by the panel and by an outside agent.

```sh
docker compose up --build
```

then open <http://127.0.0.1:8770/examples/contacts/app/>.

**No API key is needed to see it work.** Every screen, the router and the
relay run without one. Only `/api/chat` does not, and when it cannot reach a
model the widget says so in its own transcript rather than going quiet — so
you can click through the whole app, watch the relay list your tab, and decide
whether any of this is worth a key.

To let the widget talk to a model, put the key in the environment of the shell
that runs compose:

```sh
ANTHROPIC_API_KEY=... docker compose up --build
```

It is never written to a file and never reaches the browser: the page talks
only to `/api/chat`, which is the reason `driverkit/agent` ships no model
client of its own.

Then ask the panel for something that takes more than one step — *"open Acme
Industrial, tell me how many of its contacts are pending, then accept them"* —
and watch the real UI navigate, filter, select 112 rows, and stop at the
approval gate before it changes anything.

<details>
<summary>Without Docker</summary>

The demo needs `python3` and a built `packages/driverkit/dist`, and nothing
else:

```sh
npm install && npm run build
export ANTHROPIC_API_KEY=...        # optional, as above
python3 examples/contacts/server.py
```
</details>

## Status

Early. The protocol, the registry and both relays are covered by tests and the
end-to-end path has been driven for real, from a browser and from outside it.
Treat the APIs as unstable until there is a tagged release.

```sh
npm test          # TypeScript
cd python && python3 -m unittest discover -s tests -t tests
```

MIT.
