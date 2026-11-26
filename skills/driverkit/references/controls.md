# `driverkit/controls` — the request nobody wrote a verb for

A verb list is a set of shortcuts, and shortcuts are incomplete by construction. A contacts app whose only
selecting verb was `select-where(company)` was asked to select one named contact, and the model refused —
correctly: that verb would have selected all four hundred and ten contacts at the company to get one of them.
Write `select-one(id)` and the next ask is "unsubscribe him", then "switch to the compact view", then "dismiss
that banner". The set of things a person will ask for is not a set anybody has, so the gap is structural and no
amount of curation closes it.

`driverkit/controls` closes it from the other end: the author **marks** the elements an agent may use, and three
generic verbs reach whatever is on screen right now.

The two layers live in one `mount()` and an agent cannot tell them apart. Neither replaces the other. A shortcut
is how bulk work is *safe* — `select-where` resolves a predicate where the rows already are and reports the count
a `commit` then acts on, so four hundred and ten rows is two calls and one question. A control is one action on
one thing, so the same work is four hundred and ten presses and an agent that loses its place. **If the answer to
a request is a predicate, the answer is a shortcut**, and writing one is still the most valuable thing an app
author can do. A control is how the request nobody anticipated gets done at all.

The whole integration for an app that already has a verb list:

```ts
import { controlsFromDom } from "driverkit/controls";

const dk = controlsFromDom({ root: "#app", rows: "#contacts" });

mount({
  app: "Contacts",
  verbs: [...myShortcuts, ...dk.verbs],
  visible: () => dk.withControls(myVisible()),
});
```

`withControls` is non-destructive: a `note` the app already wrote is kept and the control line appended to it.
Point `rows` at the table the snapshot's rows come from — that is what makes the per-row collapsing below work.

## The three verbs, and why the split is by `kind`

| verb | kind | for |
|---|---|---|
| `press` | `describe` | press a button, tick a checkbox, switch tabs |
| `type-into` | `describe` | put text in a field |
| `commit-control` | `commit` | a control that changes data — or one the app never declared |

The arguments are a control name and an optional `row`; `type-into` takes `text`, and `commit-control` takes it
optionally, for a field that commits.

`kind` is static because it is a property of a **verb**; what a control does is a property of the **control**,
which is dynamic. One generic `press` carrying one `kind` for everything it can reach has only bad answers:
`read` tells an agent an unmarked Delete button is free to try, and `commit` asks the person about paging and
sorting, which is a gate nobody reads. So the verbs are split along the only line that has to be static — the
safe door and the gated door. The gated door is deliberately **one** verb: everything irreversible goes through
one name, so a host auditing commits has one name to watch and a person being asked has one question shape to
recognise.

`press` is declared `describe` and not `read` because it also presses controls the author marked `describe` (a
select-all checkbox). `describe` is the weakest claim that covers both, and everything downstream treats `read`
and `describe` alike, so the collapse costs nothing real.

**Routing is enforced in both directions.** `press` on a control declared `commit` is refused `wrong-verb`, with
a hint naming `commit-control`. `commit-control` on a control declared `read` is refused too, and that direction
matters more than it looks: without it a model can route every press through the gated verb — plausibly, even
helpfully — and the person is asked to confirm paging.

## The marks

```html
<button data-dk-control="next-page"  data-dk-kind="read">Next</button>
<input  data-dk-control="search"     data-dk-kind="describe" placeholder="Search" />
<button data-dk-control="accept-all" data-dk-kind="commit">Accept all</button>
```

- **`data-dk-control="name"`** publishes the element to an agent as a control it may use at will. Deliberately
  **not** `data-dk`, which says something else — "a verb I wrote, named and described clicks this". Folding them
  together would publish every button whose author deliberately wrapped it in a narrower verb, and publishing is
  consent. `{ attribute: "data-dk" }` opts into exactly that, once you have read the list.
- **`data-dk-kind="read|describe|commit"`** goes in the markup, because the person who knows what the handler
  does is the person editing that line, and a map keyed by control name in another file rots at the first
  rename. A `kind(name, el)` hook is consulted first, for generated or third-party markup you cannot annotate.
- **`data-dk-label`** is the label a human would read; it falls back to the element's text, then `aria-label`,
  then `title`.
- **`data-dk-human-only`** takes a marked control back out: not enumerated, and refused as `no-such-control` —
  the same answer an unmarked button gets, so the refusal is not an oracle over which buttons are the
  interesting ones. The mark is **inherited**, so one attribute on a `<dialog>` withholds every control inside
  it. Put it on the Yes, the signature field, the "I agree" tick, the 2FA box.

**An undeclared control is reported with no `kind` at all, and is reachable only through `commit-control`.** The
three alternatives are all worse. Defaulting to `read` manufactures a safety claim about code the library has
never seen. Defaulting to `commit` makes the fifth confirmation decoration. Refusing undeclared controls
outright throws away the one property the layer exists for. So the agent is never told an unreviewed button is
safe, the control is still reachable, and what the missing declaration costs is a question to a human — a cost
that goes away when the control is declared, which is the incentive pointing the right way. The author hears the
undeclared names once, on the console; an agent is never told, because a diagnostic about the app's markup is
not something an agent can act on.

## Per-row controls are one entry, addressed by row id

Twenty rows with six controls each is a hundred and twenty marked elements, and must not be a hundred and twenty
snapshot entries. A control found inside one of the rows the snapshot is showing is listed **once**, marked
`per: "row"`:

```
controls: search “Search contacts” (text, describe), next-page “Next”, accept-all “Accept all” (commit);
each row: pick (describe), open, delete (commit)
```
```ts
await driver.call("press", { control: "open", row: "c-0184" });
```

The twenty copies came out of one template and differ in nothing an agent needs — what differs is the row, and
the row is already in `rows`. Row ids are computed by the same code that reads the rows, so an id an agent read
out of `rows` is an id a control accepts. There is a `limit`, default 40: over it the list is cut, says how much
it is hiding, and tells the author to narrow `root`.

## Refusals

All three verbs declare the same six, in the cached half, so a briefed agent avoids the call rather than
discovering the answer by making it.

| slug | means |
|---|---|
| `no-such-control` | this screen offers no control by that name. Lists the ones it does |
| `no-such-row` | no row with that id is on screen. Lists some that are |
| `needs-row` | a per-row control was named with no row |
| `not-a-row-control` | a screen control was named with a row |
| `wrong-verb` | the right control, the wrong verb. The hint names the right one |
| `disabled` | on screen, not actionable right now |

Two of those earn the list.

**A control that has vanished refuses cleanly.** The element is resolved on every call and never captured: any
app worth adapting re-renders, and pressing a detached node does precisely nothing, with no error, and the verb
reports success. The person at the keyboard has been clicking the whole time the model was thinking, so a control
disappearing between the snapshot and the call is the ordinary case. The refusal carries the screen as it is
*now*, so the next turn sees the shorter list without another read; quoting `rev` turns the same situation into
`stale` one layer up, which is better still.

**A disabled control refuses instead of being pressed.** A rendered-but-disabled button accepts a click, does
nothing, and the call reports `ok` — a verb that silently does nothing is the worst outcome in this library. The
check is `disabled` and `aria-disabled="true"`; `refuseWhen` replaces it for an app that disables controls some
other way, and should return `disabled` rather than a slug the verbs never declared. Deliberately not a
visibility or pointer-events check: those need layout, and a heuristic that is right in Chrome and wrong in a
test is worse than a rule an author can read off their own markup.

## The snapshot carries the controls; the manifest must not

| | |
|---|---|
| static, cached in the prompt prefix, in the **manifest** | *that* the app can press a control: three verbs, three argument lists |
| dynamic, never cached, in the **snapshot** | *which* controls are on this screen right now: `Snapshot.controls` |

Which buttons exist changes when you page, filter, open a panel or switch tab, and differs between two users with
different permissions. That is the definition of the dynamic half, so the controls ride beside the rows and are
kept small by the same discipline: never more than the person at the keyboard can see.

The mistake this split exists to prevent is attractive:

```ts
// WRONG. Do not do this.
args: { control: { type: "string", describe: "which control", oneOf: ["next-page", "accept-all", "open"] } }
```

`oneOf` lives in `ArgSpec`, which lives in `Verb`, which lives in the **manifest**. A per-screen list there busts
the cached prefix once per navigation, per user, forever — and no two users share a prefix at all, because no two
are looking at the same screen. So `control` is a plain `string`, validated against the page at call time. The
cost is one refusal when a model names a control that is not there, and the refusal lists the ones that are, so
the model fixes it on the next turn without another read. A test walks the manifest and asserts that no argument
enumerates anything, because this is the kind of thing somebody improves in six months with the best intentions.

The enumeration also writes a compact one-line rendering into `note`, because nothing that renders a snapshot for
a model reads `Snapshot.controls` yet — the TypeScript renderer and the Python one both print `note`, `rows`,
`page` and `selected`. That duplication is in the uncached half and is transitional; `inNote: false` turns it off
once your renderer prints `controls`.

## Typing is not assigning `value`

```ts
await driver.call("type-into", { control: "search", text: "Ada" });
```

A framework learns about a keystroke from an event. A field whose `value` was assigned and nothing else looks
right on screen, has told the app nothing, and is wiped by the next render — while the verb reports `ok`. So the
default path focuses the element, assigns `value`, and fires `input` and `change`; when it can fire nothing at
all it **throws** rather than doing the half of the job that looks like all of it. `setValue` is the hook for a
framework the default cannot reach.

A checkbox is a control you press, not a field you type into. `textarea` and `input` are fields, except the
`input` types that plainly are not text (`checkbox`, `radio`, `button`, `submit`, `reset`, `file`, `image`,
`color`, `range`). `data-dk-field="true|false"` overrides that for a `contenteditable` div or a custom element.

## The honest limits

`packages/driverkit/CONTROLS.md` argues the whole design and is the authority; read it before importing the layer.

- **Enumeration is not inference.** The library lists the marks the author made. No label text, no ARIA role, no
  position, no similarity, no "did you mean" — a near miss is how an agent presses Delete when it meant Dismiss.
  A name the screen does not offer is a refusal listing the names it does.
- **This is the only part of the library that resolves a name to an element in order to act**, and
  `data-dk-kind` is a claim nothing can check. The core gates on the **verb's** kind, so a genuinely destructive
  button marked `read` is pressed by `press` with no question asked. The `kind(name, el)` hook is the central
  override for markup whose claims are not yours.
- **Coverage is complete over what the author marked, not over the UI.** A screen with thirty controls and three
  marks is three controls, and the agent will say it cannot do something a person can plainly see.
  `data-dk-control` on every interactive element in a view is a mechanical edit; `data-dk-kind` on each is the
  hour of judgement that cannot be mechanised.
- **An agent can press a confirm button.** Three things stop it: the core refuses every call while an approval is
  open (`approval-pending`), a dialog in a closed shadow root is invisible here, and `data-dk-human-only`. The
  third is the one an author can forget, so it is a second line and never the only one.
- **No predicates, so no bulk work, and no `count`.** A control never had a predicate, so the
  describe→count→commit pairing stays a property of hand-written verbs.
- **No multi-step macros, no keystroke granularity, no composition, no blur, no `press-key`.** An autocomplete
  that only searches on the third character, an input mask, an IME composition, a form that validates on blur, a
  control that commits on Enter: none are reachable. A screen that genuinely needs one needs a hand-written verb
  more. Sequencing is the agent's job, which is the one thing an agent is unambiguously good at.
- **React controlled inputs may defeat the default typing path.** React tracks the value on the DOM node and a
  plain assignment bypasses the tracker, so the next render can revert the field. `setValue` is the hook; a verb
  of your own that calls the state setter is better.
- **Per-row `disabled` is collapsed**, so a control claims `disabled` only when every copy is. The call-time
  check is correct; the snapshot is a summary.
- **No ordering, grouping or spatial sense.** Document order, with no notion of toolbars, menus or what is behind
  a modal, so an agent cannot tell that a control is inside a dialog it must dismiss first. `root` is the only
  tool for this, and narrowing it to the open dialog is the app's job.
- **Nothing outside the main document.** Canvas-rendered grids, a table in an `<iframe>`, closed shadow roots and
  native `<select>` dropdowns are invisible. An open shadow root works if you pass the element as `root`.
- **Two controls with one name** is an authoring bug this can only report; the verb acts on whichever the page
  yields first, and a suffixed name would be a name no screen shows.
- `Verb.at` is **not** this. It is a presentational CSS selector that the library never queries, never resolves
  and never shows to a model, so a wrong one costs an outline in the wrong place. A control is a name and not a
  selector, the agent does see it, and resolving it is the point. An `at` the library clicked would be a back door
  straight back to selector automation.
