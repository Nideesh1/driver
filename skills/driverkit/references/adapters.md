# `@driverkit/adapters` — driving an app that is not tidy

`mount()` wants rows you can read and a monotonic `rev`. Plenty of real apps have neither: the rows live in a
template or inside a third-party grid, and there is no `rev` because there is no store to count. The honest advice
used to be "add a store first", which is advice to refactor before adopting, which in practice means not adopting.

This package reads rows back out of the DOM, derives a `rev` from mutations, and binds verbs to buttons the author
marked. Zero dependencies. Each adapter's source says where it is worse than the real thing.

## The ladder: start at tier 2, finish at tier 1, mix per verb forever

Nothing in driverkit knows which tier a verb came from. One mount can hold a hand-written verb, four clicks and a
DOM-read `visible()` at once, and an agent cannot tell them apart — it sees verb names and a snapshot. **So the
ladder is climbed one verb at a time, not one app at a time.**

| tier | you have | what to write |
|---|---|---|
| 1 | functions (a store, an API client) | verbs directly. This package has nothing to offer you |
| 2 | buttons you can add an attribute to | `data-dk="name"` + `clickHandle("name")`. **Start here** |
| 3 | neither | `rowsFromTable` + `revFromMutations`, or `fromDom` for all of it |

**Tier 1 is where to end up, and not for tidiness.** A verb that calls a function can take a **predicate** and
resolve it where the rows already are (`accept-matching({ state: "due" })` is one call; the same work through the
UI is a thousand clicks and an agent that loses its place), can refuse precisely, can report a `count` before
anything moves, and can declare its `kind` honestly. A click can do none of those.

## Tier 2 — one attribute per control

```html
<button data-dk="next-page" onclick={...}>Next</button>
<button data-dk="accept"    onclick={...}>Accept</button>
```
```ts
import { clickHandle } from "@driverkit/adapters";
{ name: "next-page", kind: "read",   describe: "show the next page", run: clickHandle("next-page") },
{ name: "accept",    kind: "commit", describe: "accept the open invoice", run: clickHandle("accept") },
```

**This is not the brittle-selector approach it resembles.** `data-dk` exists only for this, so restyling, renaming
the component, switching CSS framework and translating the label all leave it untouched. And the agent never sees a
selector — it sees a verb named `accept`, so it cannot ask for a different element or drift onto one.

The two honest costs:

1. **No adapter can declare `kind` for a click.** A click runs whatever the handler does. **Read the handler and
   declare it yourself**; nothing can check that you were right, and `kind` is what stops an agent discovering that
   `accept` is not `select` by doing it to a thousand rows.
2. **A click goes through your UI**, so a rendered-but-disabled button gets clicked, does nothing, and the call
   reports `ok` — a verb that silently does nothing is the worst outcome in this library. `fromDom` refuses on
   `disabled` and `aria-disabled="true"`; pass `refuseWhen` if your app disables controls some other way.

Borrowing an existing attribute (`attribute: "data-testid"`) ties your agent surface to your test suite: whoever
deletes a test id next quarter will not know they broke a verb.

## Tier 3 — read the screen

```ts
import { fromDom } from "@driverkit/adapters";

const dom = fromDom({
  where: "invoices",                              // or a getter, if it moves
  table: "#invoices",                             // or { selector, total, pageIndex, pageSize, idColumn, complete }
  selected: "tr.selected",                        // or a getter returning ids
  clicks: { "next-page": { describe: "show the next page", kind: "read" },
            accept:      { describe: "accept the open invoice", kind: "commit" } },
  verbs: [ /* hand-written ones, mixed in beside the clicks */ ],
});
const driver = mount({ app: "Invoices", ...dom });     // dom.stop() tears the observer down
```

`rev` defaults to observing **the table**, not the document (the whole document bumps on every unrelated animation).
A missing table yields a snapshot with **no** `rows` and a note — never `rows: []`, which would say "there are no
records" while a view is still mounting.

Piecewise: `rowsFromTable(selector, opts)` → `{ rows, page? }`; `revFromMutations(target, opts)` →
`{ rev(), bump(), stop() }` (debounced, monotonic, from 1, `onBump` is where to call `connection.changed()`);
`clickHandle` / `findHandle` / `listHandles`; `collapse(text)` for matching the package's whitespace rules.

Column keys come from `data-dk-col`, else `<th>` text lowercased and hyphenated (`Due Date` → `due-date`), else
`col0`, `col1`. A row's `id` comes from `data-dk-id`, else `opts.idColumn`, else the first cell's text, else `row0`
— warned about loudly, because a positional id is stable only until somebody sorts the table.

## The two things that will bite you at tier 3

### `page` — declare the total, or the agent only learns *that* it is a window

A virtualised grid's DOM looks exactly like a short table's, so nothing here can detect a window. By default a
table read through this package reports `{ index, size }` with **no `total`** — "a window of unknown size", the
weakest honest claim. An agent that gets that cannot conclude a record does not exist; it pages or filters instead.
What it still cannot tell is *how much* it has not seen.

```html
<table id="invoices" data-dk-total="3412" data-dk-page="2">
```

or `{ total, pageIndex }`. `{ complete: true }` omits `page` entirely and asserts the agent sees everything —
something you opt into, never something an adapter falls into. Claiming "unknown window" about a complete table
costs one redundant check; the reverse costs a wrong answer about whether a record exists.

### `rev` from mutations is noisy on purpose

It bumps on **any** change under the target — a tooltip, a ticking timestamp, a spinner, a hover highlight — and
each can turn a fine call into `stale`. That is the right direction to err, and the asymmetry is not close: a false
stale costs one round trip (re-read, same rows, call again, user sees nothing); a **missed** change costs
correctness (the agent holds `rev` 7, the table re-sorted, the call is accepted, and `accept(INV-1)` lands on
whatever is in the row the agent was looking at — nothing refuses and nothing logs).

Which is why the ignore list is short: `style`, `class`, and focus plumbing. Every attribute you add is a class of
change this will now miss. **If your app encodes state in a `class` and reads it back in `visible()`, do not leave
`class` ignored.**

## What this package does not fix

- **No `kind` inference.** You declare it; nothing verifies it.
- **No predicates.** Clicks act on one control at a time, so bulk work stays a tier-1 problem. If an agent has to
  select a thousand rows through your UI, the answer is a function, not a better adapter.
- **No `count`**, so the `describe` → `commit` pairing cannot be completed from the DOM: it only knows how many
  rows are rendered.
- **Nothing outside the main document**: canvas grids, a table in an `<iframe>`, closed shadow roots and native
  `<select>` dropdowns are invisible. Pass your own element for an open shadow root; the rest need a tier-1 verb.

Every browser global is an option (`document`, `MutationObserver`, `timers`) defaulting to the real one — a design
requirement, not a testing shim: the parts of this package that bite are the ones nobody clicks through by hand.
