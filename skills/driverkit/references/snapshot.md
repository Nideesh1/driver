# `visible()` — the snapshot contract

The static half (the manifest) is cached once; the snapshot is the uncached tail, read fresh on every verb call and
returned **after** the call, so acting and observing are one round trip. Its one rule: **an agent is never shown
more than the person at the keyboard.** Same filters, same sort, same page. That is what keeps cost flat as data
grows — a hundred rows on screen is a hundred rows in the prompt whether the table holds a hundred or a million —
and it is what makes "park that one" resolvable without a query.

```ts
visible: () => ({
  screen: "contacts",                        // the stable kebab-case id, compared with ===
  where: "contacts, filtered to “Acme”",     // where the user is, in their words
  rev: store.rev,                            // monotonic, moves on EVERY change
  rows: store.onScreen(),                    // only what is rendered. Row.id is what verbs take
  page: { index: store.page, size: 20, total: store.matchCount },
  selected: store.selectedOnScreen(),        // on-screen ids only, in selection order
  selectedCount: store.selected.size,        // the honest size of the selection
  note: "contact c-8821 is open in the detail panel",   // short; this is the uncached half
})
```

## `screen` and `where` answer different questions

`where` is prose for a human and carries the filter, the sort and a drill-down's record, so it changes constantly
for reasons that are not navigation — which is why "did I navigate?" cannot be answered by diffing it. `screen` is
a stable kebab-case id, compared with string equality, and that is its whole job. It is also what `Verb.screen` and
`CallOptions.screen` are checked against. Omitting it is not a claim to have one screen: it means the app does not
describe its screens, and the core then makes no claim rather than inventing one. [screens.md](screens.md).

## `rev` is a promise, so route every mutation through one place

An agent echoes `rev` back (`CallOptions.rev`, the relay's `call` frame) and the core refuses the call as `stale`
when the screen has moved — checked **before** arguments, because if the screen moved the arguments describe a row
the agent never saw.

```ts
function bump() { store.rev += 1; onChange(); }    // and nothing else ever touches store.rev
```

A path that changes the table without moving `rev` hands out a `rev` that is a lie, the staleness check silently
stops working, and the only symptom is an agent editing the wrong row an hour later. `onChange()` is also where the
page redraws and where `connection.changed()` pushes a snapshot to the relay, so one funnel buys all three.

Without a counter of your own, write the `MutationObserver` that derives one — the repo README's "Your app has no
store" section has the ten lines. The library ships no reader for it: each one was a guess at how an app holds its
data, which is the thing driverkit exists not to do.

## `page` has three states and the third is not a cop-out

| | means |
|---|---|
| `page` absent | **these are all the rows there are** |
| `page` with `total` | a window, and you know how big the whole is |
| `page` without `total` | a window, and you do **not** know how big the whole is |

Absence is a *claim*. An agent that gets no `page` and cannot find a record concludes it does not exist. So omit
`page` only when you know the view is complete; when reading a rendered DOM, give `{ index, size }` and no `total`,
which is the weakest honest claim — the agent knows it is looking through a window and
pages or filters instead of concluding. Never invent a total.

`index` is the page the user is on; a `0` from an undeclared paginator misleads an agent about *where* it is, which
is less damaging than misleading it about *whether* it is seeing everything.

## `selected` vs `selectedCount` — both, and they answer different questions

`select-where` exists to select thousands of rows in one call. A `visible()` that honestly lists every selected id
puts tens of kilobytes of ids into the **uncached** half of every result from then on — paid on every turn, and on
a big table straight through the relay's 1 MiB body limit. So:

- `selected` answers *"which of the things in front of me is 'this one'"* → on-screen ids only, in selection order.
- `selectedCount` answers *"how big is the selection"* → the real total, including off-screen rows.

An agent cannot resolve a pronoun from a number, and cannot judge whether a commit is safe from a truncated list.
When `selectedCount > selected.length`, the renderer says so in words ("selected 1,000 rows in all; 20 shown"), and
the widget's commit gate uses `selectedCount` as the fallback count when no `describe` ran in this turn — which is
exactly the case where the *person* made the selection by hand. **Omitting `selectedCount` while filling `selected`
with a page of ids is the one combination that actively misleads**: a model handed three ids and a bulk commit
believes three rows are about to change.

`selectedCount` is not a substitute for a `describe` verb's `Report.count`: that one is the number a commit
decision turned on at the moment it was made, this one is a property of the screen.

## Rows

`Row` is `{ id: string, [column]: string | number | boolean | null }` — flat and JSON-safe, because anything that
cannot survive JSON cannot cross the relay. `id` is what verbs take, so it must be the id a verb's `args` accept
(`DX-4410`, not a React key). Project only the columns a person can see; a hidden `internalUuid` in every row is
pure uncached cost. Keep the column count and the id format stable — they are effectively part of the interface.

## Cost and cheapness

`visible()` runs on **every** verb call (twice on refusal paths) and on every `rev` poll if `watchMs` is set, which
is why the core documents it as "must be cheap". Filtering three thousand rows per call is fine; re-fetching from
the network is not. A snapshot approaching 1 MiB is a bug in `visible()`, not a limit to raise.

## Snapshots leave the process

Whatever is in `rows` and `note` goes to the model, through the app's own backend (`/api/chat`) or through the
relay to an agent. That is the app's row data in a prompt: do not put anything in a snapshot that the person at the
keyboard is not already looking at, and remember that a backend which logs or stores the `messages` array is
storing row data.
