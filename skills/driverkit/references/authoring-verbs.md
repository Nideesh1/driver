# Writing the verb list

Installing driverkit is trivial. The verb list is the judgement call, and it is the part worth spending an hour on:
the manifest is **the only description of the app an agent ever gets**, it lives in the cached half of every prompt,
and renaming a verb breaks every stored prompt that used it. This is a procedure for drafting one over a codebase
you did not write.

## 1. Read the repo and sort the actions into three piles

Do not start from the UI. Start from what already exists as a callable function — those verbs are cheap, precise and
can count.

| Look for | Likely verbs | Tier |
|---|---|---|
| a store / reducer / signal module (`store.ts`, `useXStore`, `*Slice.ts`, Pinia, MobX, Zustand) | its actions, almost one-to-one | 1 |
| an API client or service layer (`lib/api.ts`, `services/`, generated SDK, tRPC router) | the mutations and the list queries | 1 |
| anything that takes a **filter or predicate** and acts on many rows server-side | the `describe`/`commit` pair — the valuable ones | 1 |
| a URL router (`router.push`, `navigate`) | `open`, `go-to-x` reads | 1 |
| `onClick={...}` with the logic inline, a form's `onSubmit`, a grid's own toolbar | clicks via `data-dk` | 2 |
| rows that only exist in a template or a third-party grid | `rowsFromTable` + `revFromMutations` | 3 |

Searches that find these fast: `grep -rn "export function\|export const.*=.*async" src/lib src/store`,
`grep -rn "onClick=\|@click\|v-on:click" src | wc -l` (the size of the tier-2 pile),
`grep -rln "useMutation\|fetch(\|axios\." src`.

Then **cut the list down**. A verb per button is the wrong shape: it is a big static half, it teaches the model your
chrome rather than your domain, and it makes bulk work impossible. Ten to twenty-five verbs covering the intents a
support agent would be asked to perform is the right size. Leave out anything that is purely cosmetic (theme,
sidebar collapse), anything the agent can reach another way, and anything that would need an id the agent has no
honest way to learn.

## 2. Name the verb after the intent, in the user's vocabulary

The name and `describe` are what the model reasons from, and it cannot see your code. Two failure modes:

```ts
// Wrong. Named after internals, and the argument is a lane id the agent has to guess.
{ name: "set-lane", args: { vehicleId: {...}, laneId: { type: "number", describe: "lane index" } } }

// Right. The intent a person would state, with the app resolving where a car goes.
{ name: "park", describe: "park a vehicle in the next free bay on a level",
  args: { plate: {...}, level: { type: "string", describe: "level", oneOf: ["P1", "P2", "P3"] } } }
```

**Make an illegal move inexpressible rather than refused.** Every refusal costs a model turn and teaches it nothing
it could have known from the manifest. So push constraints into the argument types:

- `oneOf` with the real values beats prose and beats a free string. A wrong value comes back as `bad-argument`
  *listing the accepted set*, which the model fixes on its next turn without re-reading the screen.
- A free-form `where: string` predicate reads like a kindness and is the opposite: two models invent two query
  languages (`company = 'Acme'`, `employer='Acme'`), both unparseable, and the failure is a silently empty
  selection. Use named fields.
- If a verb can only apply in one state, prefer two verbs (`approve-draft`, `publish-approved`) over one verb that
  refuses half the time — the refusal list is documentation, not a validation layer.
- `refuses: [...]` is the field people skip and the one that earns its place: listing the refusals in the **cached**
  half lets an agent avoid a call instead of discovering the answer by making it. Short, stable slugs; declaring the
  list opts the verb into a dev-time check that a refusal it emits is on it.
- A verb that only works on one screen says `screen: "<id>"` and the core writes the refusal — do not hand-roll
  that check or invent a slug for it. `wrong-screen` is reserved for exactly that reason. [screens.md](screens.md).

## 3. Assign `read` / `describe` / `commit` — the expensive mistake

| kind | means | the agent is told |
|---|---|---|
| `read` | **changes no data and reports no count.** Navigation is a read | free to call, free to get wrong |
| `describe` | changes what is **selected**, changes no data, reports a `count` | safe; worst case is the wrong rows highlighted |
| `commit` | changes data, may be irreversible | `*** THIS CHANGES DATA AND MAY BE IRREVERSIBLE ***` — do not call it to find out what it does |
| `commit` + `reversible: true` | changes data, and the app can undo it | the same warning in plain words, without the capitals |

Two of those readings used to be wrong in ways that bit.

`read` does not say "changes nothing", because the commonest verb a
multi-screen app has — `go`, `open-contact`, `back` — moves the person's screen
out from under them, and the old wording told an agent that was free. The ladder
is about **what a wrong call costs you**, and a wrong navigation costs exactly
what a wrong read costs: the person has to look somewhere else. The two
promises worth making are the ones that decide whether the next call is safe,
and both hold for a navigation.

`describe` is about **selection**, not filtering. By the old wording a search
box was a `describe` — while none of the rest of what `describe` means applied
to it. The count is the number a following `commit` acts on, and the
describe→count→commit pair is the safety mechanism; a verb that narrows a list
and leaves nothing pending is a `read`.

`reversible: true` is read only on a `commit`, and absent makes no claim — like
`kind` itself, and for the same reason. It exists because
`set-setting("rows-per-page", "50")` and accepting 3,412 contacts were both
just `commit`, so both got identical capitals, and a banner that fires on a
page-size change is one a model learns to read past. It means there is a way
back, not that nobody minds: the data still changes and the person still sees
it. Declare it only when your app really can put the change back.

**This is the part most likely to be got wrong and the most expensive when it is.** A `commit` mislabelled `read`
tells an agent an irreversible call is free to try — and the widget's confirmation gate fires on `kind === "commit"`
only, so the mislabel also silently removes the human from in front of it. An absent `kind` makes **no** claim in
either direction and is not a safe default: the tool description then says nothing, and the gate does not fire.
Declare it on every verb.

How to decide, in order:
1. Does the body call anything that writes — an API mutation, a `PATCH`, a store write that persists, an email, a
   payment, a file delete? **`commit`.** Including when the write is "harmless": the agent cannot tell.
2. Does it change selection, filter, sort, page or which record is open, and nothing else? **`describe`** if it
   resolves a predicate and can report a count; `read` if it is a plain navigation (`next-page`, `open`).
3. Does it only read? **`read`.**
4. Is it a tier-2 click? **No adapter can infer the kind — read the handler and declare it yourself.** Nothing
   checks that you were right.

Reclassifying a verb from `describe` to `commit` changes the manifest fingerprint, so cached copies are invalidated.
That is deliberate; it is also why guessing now is not free.

## 4. The `describe` → count → `commit` pairing

Asked to "select everyone at Acme and accept the top thousand", two things can go wrong: the agent selects a
thousand rows one call at a time, and it accepts the wrong thousand. The pairing fixes both.

```ts
// The predicate lives on the DESCRIBE verb. It resolves inside the app, where the rows already are.
{ name: "select-where", kind: "describe",
  describe: "select every contact at one company, optionally only those with one status. Selects across the "
          + "whole table and not just the page on screen, replaces any existing selection, and reports how many "
          + "it matched.",
  args: { company: { type: "string", describe: "the company", oneOf: [...COMPANIES] },
          status:  { type: "string", describe: "only this status; omit for all", oneOf: [...STATUSES], optional: true } },
  run: ({ company, status }) => ({ count: store.select(company, status) }) },   // 0 is a real answer

// The COMMIT verb takes no predicate at all. It acts on the current selection.
{ name: "accept-selected", kind: "commit", describe: "accept the currently selected contacts",
  refuses: ["nothing-selected"],
  run: (_a, ctx) => store.selected.size
    ? { count: store.selected.size, note: `accepted ${store.selected.size}` }
    : ctx.refuse("nothing-selected", "nothing is selected. Use `select-where` first and read the count.") },
```

Two calls, so a count is always seen before data moves, and selecting a thousand rows is one call rather than a
thousand. **A verb that both selects and accepts is how fifty thousand rows get accepted because a filter was wider
than anybody thought.** The count is also what makes the widget's question answerable: "accept the current
selection?" is unanswerable; "accept 1,000 contacts?" is not.

`Report.count` is distinct from `0`: returning `{ count: 0 }` means "I matched nothing", omitting the field means
"I do not count", and those decide different next moves.

### 4a. Two calls is not enough on its own: `consumes: "plan"`

The pairing above is necessary and it is not sufficient, and the gap is worth stating plainly because the library
shipped it as a guarantee for a while. `accept-selected` re-reads "the current selection" **when it runs**, so
between the two calls a person can tick a row, page the list, or a websocket can land — and then the count the
agent read, and a person approved, is not provably the set that moved. Django shipped exactly this bug class from
2010 to 2025: `select_across` silently lost, so a confirmed bulk action ran on page one only.

The fix is Terraform's saved plan. A `describe` that leaves a selection behind gets a `plan` token back beside its
`count`, and a `commit` that declares `consumes: "plan"` can only be called with it:

```ts
// The app publishes the selection's identity. One short string whatever the selection's size.
visible: () => ({ where: "contacts", rev: store.rev, rows: store.onScreen(),
                  selectedCount: store.selected.size,
                  selectionId: selectionId(store.selected) }),   // exported by `driverkit`

// And the commit asks for the receipt.
{ name: "accept-selected", kind: "commit", consumes: "plan", ... }
```

The core mints the token, over the `rev` it was taken at and the `selectionId`, so an app cannot get the hashing
wrong. A commit presented with no token, an unknown one, one taken at an older `rev`, one already spent, or one
whose selection has changed is refused `stale-plan`, and the hint names **both counts** — "you were shown 3,412;
the selection is now 3,418".

Three rules:

- **Publish `selectionId`.** Use `selectionId(ids)` from `driverkit` rather than hand-rolling it:
  `[...set].join(",")` is order-dependent, so ticking the same two rows in the other order reads as a different
  selection and refuses every commit. Without the field the token still binds the `rev` and the count, which catches
  every change you bump `rev` for and no change you make quietly; the core says so once at the first call.
- **ALL OR NONE.** If one commit on the selection consumes a plan, **every** commit on the selection must, or the
  gate is advisory. An eval asked the worked example for a job it could not do, and the agent improvised: it
  selected a company and called the one bulk commit that asked for no receipt, and 403 rows changed with no count
  read and nothing gated. The verb an agent reaches for when it is off its intended path is the least-declared one.
  `mount()` warns when it can see this shape — a `commit` with no arguments is acting on ambient state by
  definition — but the warning cannot see every case and the rule is the thing to remember.
- **A verb that names what it acts on needs no plan.** `set-status(status)` on the one record whose screen is open,
  or anything taking an id, is acting on something the person can see and the count is 1. A plan is the receipt for
  a count **larger than the screen**.

And publish `selectedCount: 0` rather than omitting it when nothing is selected. An absent one means "I do not
count", so the core cannot then tell an agent "nothing is selected, so there is nothing for a plan to be taken on"
— which is the sentence that stops it going off to select something so the commit has rows to run on.

## 5. `visible()`

The snapshot is the uncached half and the honesty of the whole integration. Full contract in
[snapshot.md](snapshot.md), screens in [screens.md](screens.md); the five rules that matter while drafting verbs:

- **`screen` is the id and `where` is the prose.** `screen` is stable kebab-case and exists to be compared with
  `===`, which is the only way "did I navigate?" can be answered — `where` changes constantly for reasons that are
  not navigation. Do not spell the screen's identity into `where` and leave `screen` out; an app with one screen
  can omit `screen` entirely, and omitting it is not a claim to have one.
- **Never more rows than the person can see** — same filters, same sort, same page. That is what keeps cost flat as
  the data grows, and what makes "park that one" resolvable without a query.
- **`rev` must move on every mutation.** Route every change through one `bump()`. A path that changes the table
  without moving `rev` hands out a `rev` that is a lie, the `stale` check silently stops working, and the symptom is
  an agent editing the wrong row an hour later.
- **`page`** says whether the rows are a window: absent = "this is everything", `{index,size,total}` = a known
  window, `{index,size}` = a window of unknown size. Never fake a total.
- **`selected` is on-screen ids only; `selectedCount` is the real size.** Filling `selected` with ten thousand ids
  puts tens of kilobytes in the uncached half of every result from then on.
- **`selectionId` is the selection's identity**, which neither of those two can be: `selected` is only the ids on
  screen and a count cannot tell one selection from a different selection of the same size. See 4a.

Keep `visible()` cheap — it runs on every verb call, twice per call on the refusal paths.

## 6. Review the draft as the model sees it

```ts
console.log(JSON.stringify(driver.manifest(), null, 2));       // the static half, verbatim
```

Checklist before you call it done:

- [ ] Every verb has a `kind`, and every `commit` really does write.
- [ ] No verb name or `refuses` slug is a reserved slug — `wrong-screen` included, which is the one most likely to
      already be in an app's own vocabulary (`mount()` throws, but check before shipping prompts).
- [ ] Every verb that works on one screen only has a `screen`, and `visible()` returns the screen that is live.
- [ ] Anything the app needs to say about itself is in `MountOptions.instructions`, not repeated in every
      snapshot's `note` — the manifest is cached once, the note is paid for on every turn.
- [ ] Every `commit` the app can undo says `reversible: true`, and no `commit` that cannot says it.
- [ ] Bulk work takes predicates. No `select(id)`-per-row verb exists.
- [ ] Every `commit` that acts on a selection has a `describe` partner that counts.
- [ ] No `describe` text names a function, a table, a component or an endpoint.
- [ ] Nothing in the manifest varies per user, per tenant or per screen.
- [ ] Enumerable arguments use `oneOf`.
- [ ] A stranger reading only the manifest could do the app's three commonest tasks.

Then drive it headlessly before any model is involved: `await driver.call("select-where", { company: "Acme" })`
returns the `Result` and the snapshot after it ran. Put the verb table in a file with no DOM imports (as
`examples/contacts/app/store.js` does) and it stays testable without a browser.
