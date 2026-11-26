# @driverkit/adapters

Make a messy app drivable **without refactoring it first**.

Zero dependencies, like the rest of driverkit.

## Why this package exists

`mount()` asks an app for two things:

```ts
mount({
  app: "Invoices",
  verbs: [...],
  visible: () => ({ where: "invoices", rev: store.rev, rows: store.onScreen() }),
});
```

That `visible` assumes two things an app with a store has and an app without one
does not: rows you can read out of somewhere, and a monotonic `rev` to expose.

Plenty of real apps have neither. The rows live in a template, or inside a grid
widget, or across three components that each own a column. There is no `rev`
because there is no store to count. The honest advice to that app's author used
to be "add a store first", which is advice to refactor before adopting, which in
practice means not adopting.

This package is the escape hatch. It reads the rows back out of the DOM, derives
a `rev` from mutations, and binds verbs to buttons the author marked. None of it
is as good as the real thing — each adapter's source says exactly where it is
worse and why — but all of it works today, on the app as it is.

## Two layers before the ladder

The ladder below is about **shortcuts**: verbs somebody wrote, one per intent,
each the best version of itself that the app can support. It is the layer worth
having and the tiers are about climbing toward the best form of it.

It is also incomplete by construction, and no amount of climbing fixes that. A
verb list covers what its author thought of, and a person will always ask for
something nobody listed — which is not a gap you can close by writing more
verbs, because the set of things people ask for is not a set anybody has.

So there is a second layer, and the two compose in one `mount()`:

| | | |
|---|---|---|
| **controls** | one action, total coverage | press a button, tick a row, type in a field |
| **shortcuts** | one call, many rows | `select-where(company)` — 410 rows, one call, one count |

A shortcut is how bulk work is safe: a predicate resolved inside the app, a
count before anything moves, one question for a thousand rows. A control is how
the request nobody anticipated gets done at all. Neither replaces the other, and
an agent cannot tell which layer a verb came from.

```ts
import { controlsFromDom } from "@driverkit/adapters";

const dk = controlsFromDom({ root: "#app", rows: "#contacts" });

mount({
  app: "Contacts",
  verbs: [...myShortcuts, ...dk.verbs],       // both layers, one mount
  visible: () => dk.withControls(myVisible()),
});
```

```html
<button data-dk-control="next-page"  data-dk-kind="read">Next</button>
<button data-dk-control="accept-all" data-dk-kind="commit">Accept all</button>
```

One attribute per control, plus a `kind` you declare by looking at the handler.
The agent sees a name you chose and never a selector; a name the screen does
not offer is a refusal and never a near miss. Controls on each row are listed
once and addressed by row id, so twenty rows with six controls each is six
entries in the snapshot and not a hundred and twenty.

The model, the manifest/snapshot split, the argument for how `kind` is
defaulted when an author does not declare it, and the honest limits are in
[CONTROLS.md](CONTROLS.md). Read it before marking up a real app — the `kind`
decision is the part that is expensive to get wrong.

## The three-tier adoption ladder

**Start at tier 2. Finish at tier 1. Mix tiers per verb, forever if you like.**

Nothing in driverkit knows which tier a verb came from. A mount can hold one
hand-written verb, four clicks and a DOM-read `visible()` at the same time, and
an agent cannot tell them apart — it sees verb names and a snapshot. So the
ladder is climbed one verb at a time, not one app at a time.

### Tier 1 — you have functions

You can call your app's own code. Write verbs directly; this package has nothing
to offer you.

```ts
mount({
  app: "Invoices",
  verbs: [
    { name: "accept-matching", describe: "accept every invoice matching a filter",
      kind: "commit", args: { state: { type: "string", describe: "state to accept" } },
      run: ({ state }) => invoices.acceptWhere({ state }) },
  ],
  visible: () => ({ where: ui.title, rev: store.rev, rows: store.onScreen() }),
});
```

This is where to end up, and not for tidiness. A verb that calls a function can
take a **predicate** and resolve it inside the app, where the rows already are:
`accept-matching({ state: "due" })` is one call. The same work through the UI is
a thousand clicks, a thousand round trips, and an agent that loses its place
somewhere in the middle. A function can also refuse precisely, report a `count`
before anything moves, and declare its `kind` honestly — none of which a click
can do.

### Tier 2 — you have buttons (start here)

You cannot call your app's code from here, but you can edit its markup. Add one
attribute per control:

```html
<button data-dk="next-page" onclick={...}>Next</button>
<button data-dk="accept"    onclick={...}>Accept</button>
```

```ts
import { clickHandle } from "@driverkit/adapters";

mount({
  app: "Invoices",
  verbs: [
    { name: "next-page", describe: "show the next page of invoices",
      kind: "read", run: clickHandle("next-page") },
    { name: "accept", describe: "accept the open invoice",
      kind: "commit", run: clickHandle("accept") },
  ],
  visible,
});
```

This is the cheapest adoption step that exists — one attribute, no refactor, no
store — which is why it is where to start.

**It is not the brittle-selector approach it resembles.** `data-dk` exists only
for this, so it does not rot the way a borrowed selector rots: restyle the
button, rename the component, change CSS framework, translate the label, and
`data-dk="accept"` is untouched, because none of those are reasons to touch it.
And the agent never sees a selector — it sees a verb named `accept`. It cannot
ask for a different element, be prompted onto one, or drift onto one when the
DOM changes shape.

**The honest cost**, in two parts:

1. A click runs whatever the handler does, so no adapter can declare `kind`.
   **You must look at the handler and declare it yourself**, and nothing here
   can check that you were right. `kind` is what stops an agent discovering that
   `accept` is not `select` by doing it to a thousand rows.
2. A click goes through your UI, so a rendered-but-disabled button gets clicked,
   does nothing, and the call reports `ok`. A verb that silently does nothing is
   the worst outcome in this library. `fromDom` refuses on `disabled` and
   `aria-disabled="true"` by default; if your app disables controls some other
   way, pass `refuseWhen`.

If you borrow an existing attribute (`attribute: "data-testid"`), know that you
have tied your agent surface to your test suite: whoever deletes a test id next
quarter will not know they broke a verb. A separate `data-dk` costs one
attribute and says what it is for.

### Tier 3 — you have neither a store nor functions

Read the screen.

```ts
import { rowsFromTable, revFromMutations } from "@driverkit/adapters";

const rev = revFromMutations("#invoices", { onBump: () => connection.changed() });

mount({
  app: "Invoices",
  verbs: [...],
  visible: () => ({ where: "invoices", rev: rev.rev(), ...rowsFromTable("#invoices") }),
});
```

Or all of it at once, which is the whole point:

```ts
import { fromDom } from "@driverkit/adapters";

const dom = fromDom({
  where: "invoices",
  table: "#invoices",
  selected: "tr.selected",
  clicks: {
    "next-page": { describe: "show the next page of invoices", kind: "read" },
    accept: { describe: "accept the open invoice", kind: "commit" },
  },
});

const driver = mount({ app: "Invoices", ...dom });
```

That literal plus one attribute per button is the entire integration for an app
with no store.

Add `controls: true` and the controls layer comes with it, pointed at the table
`fromDom` already knows about — which is what makes the per-row collapsing work,
so it is worth letting `fromDom` wire it rather than doing it by hand:

```ts
const dom = fromDom({ where: "invoices", table: "#invoices", controls: true, clicks: {...} });
```

### Where controls sit in the ladder

They are not a fourth tier. They are the other axis, and they are available at
every tier:

| | shortcuts | controls |
|---|---|---|
| tier 1, you have functions | verbs that take predicates and count | still useful for the long tail nobody wrote a verb for |
| tier 2, you have buttons | `clickHandle` per named intent | one attribute per control, the whole screen at once |
| tier 3, you have markup | `rowsFromTable` + `revFromMutations` | the same markup, enumerated |

A tier-1 app gets controls with little work, because `data-dk-control` on an
element it already renders is one attribute. A tier-3 app gets them from markup
alone, which is the same claim tier 2 makes and for the same reason. What no
tier gets for free is `kind`: see [CONTROLS.md](CONTROLS.md).

## The two things that will bite you at tier 3

### `page` — tell it the total, or the agent only learns *that* it is a window

`rowsFromTable` reports **only the rows actually rendered**. That is correct: a
`Snapshot` is what a human could see right now, and a virtualised grid showing
40 of 100,000 should report 40.

A virtualised grid's DOM looks exactly like a short table's DOM, so this cannot
detect a window. `Snapshot.page.total` being optional is what makes that
survivable — there are three states, and the adapter uses the third by default:

| | |
|---|---|
| `page` absent | these are all the rows there are |
| `page`, `total` given | a window, and the whole is this big |
| `page`, `total` absent | a window, and the size of the whole is unknown |

So by default a table read through this package reports `{ index, size }` with
no `total`. An agent that gets that cannot conclude a record does not exist — it
knows it is looking through a window, and pages or filters instead. That is the
honest claim, and it reaches the agent rather than your console.

What it still cannot tell is *how much* it has not seen, which is the difference
between "page until you find it" and "it is not among the 3,412 I know about".
So declare the total:

```html
<table id="invoices" data-dk-total="3412" data-dk-page="2">
```

or pass `{ total, pageIndex }`. `rowsFromTable` advises this above 25 rows.

`size` is the rendered count (override with `pageSize` for a paginator whose
last page is short). `index` is `data-dk-page` or `pageIndex` when given, else
`0` — and **a 0 there does not assert "the first page"**; it is what is left
when nothing declared a position, so an undeclared paginator on page 4 reports
0. That misleads an agent about *where* it is, not about *whether* it is seeing
everything, which is the question that produces wrong answers.

**If you know the table is complete, say so:** `{ complete: true }` omits `page`
entirely. Asserting completeness is now something you opt into, not something an
adapter falls into by failing to detect a grid. Claiming "a window of unknown
size" about a complete table costs an agent one redundant check; the reverse
costs it a wrong answer about whether a record exists, with nothing in the
snapshot to contradict it.

### `rev` from mutations is noisy on purpose

`revFromMutations` bumps on **any** change under the target, including ones no
agent cares about: a tooltip, a relative timestamp ticking over, a spinner, a
hover highlight. Each one can turn an otherwise-fine call into `stale`, costing a
re-read and a retry.

That is the right direction to err, and the asymmetry is not close:

- A **false stale** costs one round trip. The agent re-reads, sees the same rows,
  calls again, succeeds. The user sees nothing.
- A **missed change** costs correctness. The agent holds `rev` 7, the table
  re-sorted, `rev` is still 7 so the call is accepted — and `accept(INV-1)` lands
  on whatever is in the row the agent was looking at, which is now a different
  invoice. Nothing refuses and nothing logs.

Which is why the ignore list is short: `style`, `class`, and the focus plumbing.
Every attribute you add to it is a class of change this will now miss. In
particular, if your app encodes state in a `class` and reads it back in
`visible()`, do **not** leave `class` ignored.

## API

| | |
|---|---|
| `rowsFromTable(selector, opts?)` | `{ rows, page? }` from a rendered table or any repeating structure. `page` carries `total` only when the markup declares one, and is omitted only for `{ complete: true }`. Throws if the container is missing — reporting zero rows would say "no records exist". |
| `revFromMutations(target, opts?)` | `{ rev(), bump(), stop() }`. Debounced, monotonic, starts at 1. |
| `clickHandle(name, opts?)` | A verb body that clicks `[data-dk="<name>"]`. Throws naming the handle, and lists the handles that are present. |
| `findHandle(name, opts?)` / `listHandles(opts?)` | Look without clicking; see what the screen offers. |
| `controlsFromDom(config?)` | `{ verbs, controls, note, withControls }` — the controls layer. Three generic verbs plus the enumeration that feeds them. See [CONTROLS.md](CONTROLS.md). |
| `rowHandles(selector, opts?)` | The row elements paired with the ids `rowsFromTable` would report. What lets a per-row control address a row by the id the agent read. |
| `fromDom(config)` | `{ verbs, visible, stop }` — tiers 2 and 3 composed into the shape `mount()` takes. `controls: true` adds the controls layer. |
| `collapse(text)` | The whitespace normalisation everything here applies, exported so your own hooks match it. |

Column keys come from `data-dk-col`, else `<th>` text (lowercased, hyphenated:
`Due Date` → `due-date`), else positional `col0`, `col1`. A row's `id` comes from
`data-dk-id`, else `opts.idColumn`, else the first cell's text, else `row0` —
which is warned about loudly, because a positional id is stable only until
somebody sorts the table.

Every browser global is an option (`document`, `MutationObserver`, `timers`)
defaulting to the real one. That is a design requirement, not a testing shim:
the parts of this package that bite are the ones nobody clicks through by hand.

## What this package does not fix

- **No `kind` inference.** A click's effect on the world is unknowable from
  outside. You declare it; nothing verifies it.
- **No predicates.** Clicks and controls act on one thing at a time, so bulk
  work stays a tier-1 problem. If an agent has to select a thousand rows through
  your UI, the answer is a function, not a better adapter.
- **No coverage of what you did not mark.** The controls layer enumerates the
  marks an author made, and an unmarked button does not exist. That is a
  deliberate refusal to infer, and it means "total coverage" is total over your
  markup and not over your UI. CONTROLS.md says so at more length.
- **No sense of how big the whole is.** A rendered DOM cannot say how many rows
  exist, so a table read through this package reports a window of unknown size.
  An agent is not misled by that — it will not conclude a record is missing —
  but it cannot tell how much is out of view either. **Supply `data-dk-total`
  (or `opts.total`) if you want the agent to know the size of the whole**, and
  `{ complete: true }` if there is nothing out of view at all.
- **No `count`.** The `describe` → `commit` pairing that makes bulk work safe
  needs the app to report how many rows a predicate matched. The DOM only knows
  how many are rendered.
- **Nothing outside the main document.** Canvas-rendered grids, a `<table>` in
  an `<iframe>`, closed shadow roots, and native `<select>` dropdowns are all
  invisible here. Pass your own element for an open shadow root; the rest need a
  tier-1 verb.
