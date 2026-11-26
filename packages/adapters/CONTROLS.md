# Controls

driverkit has one layer today, and it is a good one: somebody writes a verb
list, an agent calls the verbs by name, and a thousand rows move in one call
with a count in front of them. This document is about the thing that layer
cannot do, and the second layer that fixes it.

## The failure

A contacts demo. The verb list had `select-where(company, status?)` and nothing
else that selected anything. Asked to select one named contact, the model
refused.

It was right to refuse. Its only selection tool would have selected all four
hundred and ten contacts at that company in order to get one of them, and
`select-where` is a `describe` verb whose whole purpose is to be the thing that
happens *before* a commit. The model did the correct thing with the wrong
vocabulary.

The obvious fix is to write a `select-one(id)` verb. Do that and the next
request is "unsubscribe him from the newsletter", and the next is "switch to
the compact view", and the next is "dismiss that banner". You cannot enumerate
your way out of this, because the set of things a person will ask for is not a
set anybody has. The requirement is plainer than any verb list can satisfy:
**driverkit needs to be able to do whatever I ask it on the UI** — a button
click at the small end, multi-step work at the large one.

So the gap is structural, not an omission. A curated list is incomplete by
construction, and no amount of curation fixes a construction.

## The two layers

```
controls    one action, total coverage    press a button, tick a row, type in a field
shortcuts   one call, many rows           select-where(company) -- 410 rows, one call, one count
```

Neither replaces the other, and the reason is worth being precise about,
because "add controls and delete the verb list" is the wrong lesson.

A shortcut is how bulk work is *safe*. `select-where` resolves a predicate
inside the app, where the rows already are, reports how many it matched, and a
`commit` verb then acts on that selection with a number in front of the human.
Four hundred and ten rows, two calls, one question. The controls layer cannot
do that at any price: a control is one action on one thing, so four hundred and
ten rows is four hundred and ten presses, four hundred and ten round trips, and
an agent that loses its place in the middle. If the answer to a request is a
predicate, the answer is a shortcut, and writing one is still the single most
valuable thing an app author can do.

A control is how the request nobody anticipated gets done *at all*. It is
complete by construction rather than by curation: whatever the person at the
keyboard could press, tick or type into, an agent can too, and the app author
did not have to foresee it.

They compose in one `mount()`. An agent cannot tell which layer a verb came
from — it sees verb names and a snapshot — which is the same property the
three-tier ladder already has, for the same reason.

## Where each half lives

This is the decision everything else follows from, and getting it backwards
would quietly destroy the library's cost argument.

| | | |
|---|---|---|
| **static**, cached in the prompt prefix, in the **manifest** | *that* the app can press a control | three verbs, three argument lists |
| **dynamic**, never cached, in the **snapshot** | *which* controls are on this screen right now | `Snapshot.controls` |

A verb is static because its name, arguments and refusals are the same for
every user on every day. Which buttons exist is not: it changes when you page,
filter, open a detail panel or switch tab, and it differs between two users
looking at the same app with different permissions. That is exactly the
definition of the dynamic half, which is where the rows already live. So the
controls ride beside the rows, in the uncached tail, and they are small by the
same discipline: never more than the person at the keyboard can see.

### The mistake this split exists to prevent

It has an obvious and attractive shape:

```ts
// WRONG. Do not do this.
args: { control: { type: "string", describe: "which control",
                   oneOf: ["next-page", "accept-all", "open", "delete"] } }
```

It reads as a kindness. The model cannot then name a control that does not
exist, it gets an `enum` in its tool schema, and a wrong value comes back from
the core listing the accepted set. Every one of those is true, and it is still
the single most expensive line anybody could add to this library.

`oneOf` lives in `ArgSpec`, which lives in `Verb`, which lives in the
**manifest**. Putting a per-screen list there means the cached half changes on
every navigation, so the prefix is busted once per screen, per user, forever —
and no two users share a prefix at all, because no two users are looking at the
same screen. The manifest stops being cacheable, which is the entire reason the
manifest exists.

So `control` is a plain `string`, and it is validated against the page at call
time instead. The cost is one refusal when a model names a control that is not
there; the refusal lists the ones that are, so the model fixes it on the next
turn without another read. There is a test that walks the manifest and asserts
no argument enumerates anything, because this is the kind of thing somebody
improves in six months with the best intentions.

## The three verbs

```
press            describe   press a button, tick a checkbox, switch tabs
type-into        describe   put text in a field
commit-control   commit     use a control that changes data -- or one the app never declared
```

A control's name and an optional `row` are the arguments. `type-into` takes
`text`; `commit-control` takes it optionally, for a field that commits.

### Why three, and why the split is by *kind*

`kind` is how an agent knows what is irreversible before it calls, and the
confirmation gate in `@driverkit/agent` fires on `kind === "commit"` and on
nothing else. `kind` is a property of a **verb**, which is static. The effect
of pressing a control is a property of the **control**, which is dynamic. One
generic `press` verb would have to carry one `kind` for every control it could
ever reach, and both available answers are bad:

- `kind: "read"` tells an agent that an unmarked Delete button is free to try.
- `kind: "commit"` asks the human about paging, sorting and switching tabs. A
  gate that asks about everything is a gate nobody reads, which is the same as
  having no gate while looking like you have one.

So the verbs are split along the only line that has to be static: the safe
door and the gated door. `read` and `describe` controls share the safe door;
`commit` controls use the gated one. `press` and `type-into` are then two
mechanisms behind the safe door, because their argument shapes genuinely
differ — a field takes text and a button has nowhere to put it, and "an
optional `text` that is required for some values of another argument" is the
shape the authoring guide tells app authors not to write.

The gated door is deliberately **one** verb rather than two. Everything
irreversible goes through one name, so a host auditing commits has one name to
watch, and a person being asked has one question shape to recognise.

`press` is declared `describe` and not `read`. It presses `read` controls as
well, so `read` would be the stronger claim — and it would be false the moment
somebody marks a select-all checkbox `describe`. `describe` is the weakest
claim that covers both, and `read` and `describe` are treated identically by
everything downstream (both are "safe to call"), so the collapse costs nothing
real. Its description says it reports no count, because the generic
`describe` briefing promises one.

### Routing is enforced, in both directions

Calling `press` on a control the author declared `commit` is refused
`wrong-verb`, with a hint naming `commit-control`. That is the direction people
expect.

Calling `commit-control` on a control declared `read` is **also** refused. This
direction matters more than it looks: without it, a model can route every press
through the gated verb — plausibly, even helpfully — and the person is asked to
confirm paging. One control, one verb; the gate stays worth reading.

## How `kind` is declared, and what happens when it is not

The author declares it in the markup, next to the control:

```html
<button data-dk-control="next-page"  data-dk-kind="read">Next</button>
<input  data-dk-control="search"     data-dk-kind="describe" placeholder="Search" />
<button data-dk-control="accept-all" data-dk-kind="commit">Accept all</button>
```

In the markup rather than in a config map in the mount file, because the person
who knows what the handler does is the person editing that line, and a map
keyed by control name in another file rots the first time somebody renames a
button. A `kind(name, el)` hook exists for generated or third-party markup you
cannot annotate; it is consulted first and falling through to the attribute.

Nothing can infer this. The library cannot tell a "Next page" button from a
"Delete account" button, and no amount of looking at the DOM changes that — the
two differ only in what the handler does, which is code this package cannot
see. That is the same honest cost `clickHandle` has carried from the start, and
it is why the attribute exists.

### An undeclared control is reachable only through the gate

This is the load-bearing default, so here is the argument rather than the rule.

Three options were available for a control whose author never declared a kind:

1. **Default to `read`.** Unacceptable. An unmarked Delete button is then
   described to an agent as free to try, and the agent finds out it was not by
   doing it. The library would be manufacturing a safety claim about code it
   has never seen.
2. **Default to `commit`.** Every press is a question, including in an app that
   declared nothing because it declared nothing yet. The person clicks through
   the fifth confirmation without reading it and the gate is now decoration.
3. **Refuse undeclared controls entirely.** Honest, and it throws away the one
   property the layer exists for. A tier-3 app that marked its buttons and
   nothing else would have complete coverage of nothing.

What ships is none of those and is closest to (2) with the sting removed:
**an undeclared control is reported with no `kind` at all, and is reachable
only through `commit-control`.** So:

- The agent is never told an unreviewed button is safe. `ScreenControl.kind` is
  absent, which `Snapshot`'s own doctrine already defines as "no claim", and
  the control is rendered to the model as `(undeclared)` — never as `read`.
- It is still reachable. Coverage holds. What the missing declaration costs is
  a question to the human, not the action.
- **The cost decays.** Declare the control and the question goes away. Unlike
  defaulting everything to `commit`, this leaves a well-marked app with a gate
  that fires on the things that actually commit — so the gate goes on meaning
  something, and the incentive points at declaring rather than at ignoring.
- The author hears about it once, on the console, listing the undeclared
  names. The agent is never told; a diagnostic about the app's markup is not
  information an agent can act on.

The treatment is the same one `Snapshot.page.total` gets: take the weakest
honest claim, and let the cost fall on the cheap side. A redundant
confirmation costs a round trip and a moment of a person's attention. The
reverse mistake costs something that cannot be undone.

## Keeping the snapshot small

A screen with twenty rows and six controls on each row has a hundred and twenty
marked elements. It must not have a hundred and twenty snapshot entries, and it
does not have eight.

A control found inside one of the rows the snapshot is showing is listed
**once**, marked `per: "row"`, and addressed by row id:

```
controls: search “Search contacts” (text, describe), next-page “Next”, accept-all “Accept all” (commit);
each row: pick (describe), open, delete (commit)
```

```ts
await driver.call("press", { control: "open", row: "c-0184" });
```

This works because the twenty copies came out of one template. They are the
same control rendered twenty times and differ in nothing an agent needs — the
thing that differs between them is the row, and the row is already in `rows`.
The row ids are computed by the same code `rowsFromTable` uses, including the
`data-dk-id` / `idColumn` / `idFrom` precedence and the positional fallback, so
an id an agent reads out of `rows` is an id a control accepts. Two near-identical
id rules in one package would diverge on the first bug report, and the symptom
would be a control refusing for a row that is plainly on screen.

Every field but `name` is omitted when it would state the common case, which is
why `field` and `disabled` are `true` rather than `boolean`. Eight controls cost
about one line.

There is a `limit`, default 40. Over it the list is cut, says how much it is
hiding, and warns the author to narrow `root`. A truncated list that admits it
is truncated costs an agent a step; a two-hundred-entry list costs every turn of
every session, in the half that is never cached.

## Never a selector the library guessed

The agent sees `accept`, and `accept` is a word somebody typed next to their own
button:

```html
<button data-dk-control="accept" onclick={/* whatever lives here */}>Accept</button>
```

That is the same claim `clickHandle` makes and it holds for the same reasons:
the attribute exists only for this, so restyling, renaming the component,
swapping CSS framework or translating the label does not touch it; and the agent
never sees a selector, so it cannot ask for a different element, be prompted
onto one, or drift onto one when the DOM changes shape.

What this layer adds is **enumeration**, and enumeration is not inference. The
library lists the marks the author made. It does not search by label text, by
ARIA role, by position, by heuristic or by similarity, and there is no
"did you mean". A name the screen does not offer is a refusal listing the names
it does offer — never a near miss, because a near miss is how an agent presses
Delete when it meant Dismiss. There is a test that fires `Next`, `next`,
`nextpage`, `next-pag`, `Accept all` and `accept` at a screen offering
`next-page` and `accept-all`, and asserts that nothing was clicked.

`data-dk-control` is deliberately **not** `data-dk`. The two marks say different
things. `data-dk` says "a verb I wrote, named and described clicks this".
`data-dk-control` says "publish this to an agent as a control it may use at
will". Folding them together would silently publish every button an app marked
for tier 2, including the ones whose author deliberately wrapped them in a
narrower verb — and publishing is consent. `{ attribute: "data-dk" }` opts into
exactly that, once you have looked at the list.

### How this differs from `Verb.at`

`Verb.at` is a CSS selector and is purely presentational: it exists so a UI can
outline the part of the screen a verb is about while a human watches, and the
library never queries it, never resolves it, and never shows it to the model. A
wrong `at` costs an outline drawn in the wrong place and nothing else.

A control is the opposite in every respect: it is a name and not a selector, the
agent *does* see it, and resolving it is the point. The two must not be
conflated in either direction. An `at` that the library clicked would be a back
door straight back to selector automation. A control that the library found by
guessing would be the same door with a different sign on it.

## Refusals

All three verbs declare the same six, in the cached half, so a briefed agent
avoids the call rather than discovering the answer by making it.

| slug | means |
|---|---|
| `no-such-control` | this screen offers no control by that name. Lists the ones it does. |
| `no-such-row` | no row with that id is on screen. Lists some that are. |
| `needs-row` | a per-row control was named with no row. |
| `not-a-row-control` | a screen control was named with a row. |
| `wrong-verb` | the right control, the wrong verb. The hint names the right one. |
| `disabled` | on screen, not actionable right now. |

Two of these are the ones that earn the list.

**A control that has vanished refuses cleanly.** The element is resolved on
every call and never captured, for the reason `click.ts` gives at length: any
app worth adapting re-renders, and a captured node is a node that has since been
detached — pressing it does precisely nothing, with no error, and the verb
reports success. Worse, the person at the keyboard has been clicking the whole
time the model was thinking, so a control disappearing between the snapshot and
the call is the ordinary case and not an exception. It is therefore a refusal
carrying the screen as it is *now*, so the agent's next turn sees the shorter
list without another read. Quoting `rev` turns the same situation into a `stale`
refusal one layer up, which is better still, and the hint says so.

**A disabled control refuses instead of being pressed.** A rendered-but-disabled
button accepts a click, does nothing, and the call reports `ok`. A verb that
silently does nothing is the worst outcome in this library. The check is
`disabled` and `aria-disabled="true"`, the same rule `fromDom` uses, and
`refuseWhen` replaces it for an app that disables its controls some other way —
return `disabled` from it unless you mean to add a slug, because `disabled` is
the only availability refusal the verbs declare and the core warns once about
any refusal that is not on a verb's declared list.
Deliberately not a visibility or pointer-events check: those need layout, layout
needs a real browser, and a heuristic that is right in Chrome and wrong in a
test is worse than a rule an author can read off their own markup.

## Typing is not assigning `value`

```ts
await driver.call("type-into", { control: "search", text: "Ada" });
```

Assigning `value` and stopping is the failure this part is built around. A
framework learns about a keystroke from an event; a field whose `value` was
assigned and nothing else looks right on screen, has told the app nothing, and
is wiped by the next render — while the verb reports `ok`. So the default path
focuses the element, assigns `value`, and fires `input` and `change`. When it
cannot fire anything (no `Event`, no `dispatchEvent`) it **throws** rather than
doing the half of the job that looks like all of it.

`setValue` is the hook for a framework the default cannot reach; see the limits
below for why React is one of them.

A checkbox is an `<input>` and is a control you press, not a field you type
into. The rule: `textarea` and `input` are fields, except the `input` types that
plainly are not text (`checkbox`, `radio`, `button`, `submit`, `reset`, `file`,
`image`, `color`, `range`). `data-dk-field="true|false"` overrides it for a
`contenteditable` div or a custom element.

## Using it

The whole integration for an app that already has a verb list:

```ts
import { controlsFromDom } from "@driverkit/adapters";

const dk = controlsFromDom({ root: "#app", rows: "#contacts" });

mount({
  app: "Contacts",
  verbs: [...myShortcuts, ...dk.verbs],
  visible: () => dk.withControls(myVisible()),
});
```

`withControls` is non-destructive: a note the app already wrote is kept and the
control line is appended to it. For an app with no store at all, `fromDom`
takes `controls: true` and points the row scan at the table it already knows
about:

```ts
const dom = fromDom({
  where: "invoices",
  table: "#invoices",
  controls: true,
});
```

Pointing the row scan at the table is what makes the per-row collapsing work, so
`fromDom` doing it for you is not just convenience — a caller who wired this by
hand and forgot `rows` would get a hundred and twenty entries under twenty
names, a duplicate-name warning for each, and a snapshot that grows with the
table.

### Why the control list is also in `note`

`Snapshot.controls` is structured and new, and nothing that renders a snapshot
for a model reads it yet — the TypeScript renderer and the Python one both print
`note`, `rows`, `page` and `selected`. So the enumeration also writes a compact
one-line rendering into `note`, which is how the controls actually reach a
model today.

That is duplication in the uncached half and it is transitional. The grammar is
terse on purpose and the legend that makes it readable lives in the verbs'
descriptions, which are cached — the same static/dynamic reasoning applied to
the rendering itself. `inNote: false` turns it off; set it once your renderer
prints `controls`.

## What this deliberately does not do

- **No `kind` inference.** Declared by the author, checked by nothing. Same
  honest cost `clickHandle` has always had.
- **No predicates, so no bulk work.** A control acts on one thing. Four hundred
  rows is four hundred presses, and the answer to that is a shortcut, not a
  better control layer.
- **No `count`.** A control cannot report how many rows a predicate matched,
  because it never had a predicate. The `describe` → count → `commit` pairing
  stays a tier-1 property.
- **No selector, path, role, label or coordinate matching.** Only the names the
  author marked.
- **No multi-step macros.** Three verbs, one action each. Sequencing is the
  agent's job, which is the one thing an agent is unambiguously good at.
- **No reading of `Verb.at`.** See above.

## The honest limits

Named, because a design that reports itself complete is the one not to trust.

**Coverage is complete over what the author marked, not over the UI.** This is
the big one, and it is a real retreat from "whatever I ask it on the UI". An
unmarked button does not exist to an agent, so the completeness is structural
only once the marking is. A screen with thirty controls and three marks is three
controls, and the agent will answer "I cannot do that" about a button a person
can see. The unmarked alternative — enumerate every `<button>` — would be
inference, would publish controls nobody reviewed, and would have no `kind` for
any of them; that trade was refused on purpose. The practical mitigation is a
loud list of what *is* marked and a codemod-shaped job: `data-dk-control` on
every interactive element in a view is a mechanical edit, and `data-dk-kind` on
each is the hour of judgement that cannot be mechanised.

**Per-row `disabled` is collapsed and therefore imprecise.** Twenty Delete
buttons, three of them greyed out, are one entry. It claims `disabled` only when
every copy is disabled, so an agent can be told a control is available and then
refused for the specific row. The call-time check is correct; the snapshot is a
summary. The alternative is one entry per row per control, which is the cost
argument gone.

**React controlled inputs may defeat the default typing path.** React tracks an
input's value on the DOM node and a plain assignment bypasses the tracker, so
the `input` event may be dispatched with React still believing the old value,
and the next render reverts the field. The fix is the native-setter trick, which
this package does not do for you because it is a React-specific hack that has
changed shape across versions. `setValue` is the hook, and an app that is
driving a controlled input should use it — or better, expose a tier-1 verb that
calls the state setter.

**No keystroke granularity, no composition, no blur.** Typing replaces the whole
value in one shot. An autocomplete that only searches on the third character, a
field with an input mask, an IME composition, a form that validates on blur, a
control that commits on Enter — none of those are reachable. There is no
`press-key` verb; a screen that genuinely needs one needs a tier-1 verb more.

**Nothing outside the main document.** Canvas-rendered grids, a table in an
`<iframe>`, closed shadow roots, native `<select>` dropdowns, and anything
drawn by a non-DOM renderer are invisible here, exactly as they are to the rest
of this package. An open shadow root works if you pass the element as `root`.

**No ordering, grouping or spatial sense.** The control list is in document
order with no notion of toolbars, menus, dialogs or what is behind a modal. An
agent cannot tell that a control is inside a dialog it must dismiss first, or
that two controls are mutually exclusive. It will discover that by being refused
or, worse, by pressing something that was technically available. `root` is the
only tool for this, and narrowing it to the open dialog is a thing the app has
to do.

**Two controls with one name is an authoring bug this can only report.** Like
two rows with one id, the verb acts on whichever the page yields first. Warned
about, never renamed — a suffixed name would be a name no screen shows.

**The gate is only as good as the host.** `commit-control` is declared `commit`
and that is all this package can do. Nothing fires if the host never wired
`onBeforeCommit`, and in that case an undeclared control is pressed with no
question at all. The routing is still worth it — the model is told the control
is treated as changing data — but the human in front of it is the host's
responsibility.

**The uncached cost is real and grows with the screen.** Rows plus controls plus
the duplicated note line is paid for on every turn. Forty controls is a lot more
than eight, and nothing here makes a busy admin screen cheap. `limit`, `root`
and `inNote: false` are the three levers, and all three are the author's to
pull.
