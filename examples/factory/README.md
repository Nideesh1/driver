# A drafted driverkit integration for FACTORY

**Nothing here is mounted and nothing here has been run against FACTORY.** It was drafted from FACTORY's
source alone — the owner's stack was not reachable from the machine this was written on, so not one byte
of the real kernel was read. What *has* run is the verb list itself, headlessly, against a fake kernel in
[`evals/fixture.ts`](evals/fixture.ts): it mounts without a warning, 0 errors from `--dry-run`, and the
twelve refusal and commit paths below were driven by hand. That is a check on the *shape*, not a claim
that it works on the owner's graph.

```
examples/factory/
  src/port.ts       the subset of frontend/src/app/lib/kernel.ts the verbs call. Signatures copied, not invented.
  src/screens.ts    22 screens, ids and url templates taken from the router's own Route union
  src/verbs.ts      19 verbs. No DOM, no FACTORY imports — drivable against a fake port
  src/flows.ts      3 recipes
  src/board.ts      visible(), rev, and the selection, with what it cannot see written down
  src/mount.ts      mountFactory(). The only file that touches the DOM
  evals/            12 cases, a fake FACTORY to run them against, and app.mjs
```

---

## The verb list

19 app verbs plus the core's `goto`. `run` calls are functions FACTORY already has; the line numbers are
`frontend/src/app/lib/kernel.ts` unless stated.

| verb | kind | what it does | what it calls |
|---|---|---|---|
| `read-health` | read | the kernel's one-line self-report: which graph, how big each of the five lanes is | `fetchHealth()` :182 |
| `read-backlog` | read | every descent lane by lane, or one lane. `pruning` is the human gate | `fetchDescents()` :214 |
| `read-descent` | read | one descent in full, with every finding it recorded layer by layer | `fetchDescentDetail(id)` :431 |
| `find-findings` | read | findings by filter — above all **every finding citing one file**, in one hop | `fetchFindings(filter)` :502 |
| `read-iterations` | read | every iteration: leg, set, when it last changed | `fetchIterations()` :1154 |
| `read-iteration` | read | one iteration: set, reason, leg, method, model. **Read this before running one** | `fetchIteration(id)` :1179 |
| `read-sets` | read | the repository sets, with how many repositories each holds | `fetchSets()` :536 |
| `read-templates` | read | the method templates, with their breadth and depth sizes | `fetchTemplates()` :1595 |
| `read-template` | read | one method in full: every breadth item in order, every depth item | `fetchTemplate(id)` :1625 |
| `read-pieces` | read | the piece library, optionally one kind | `fetchPieces()` :2173 |
| `select-pieces` | **describe** | select pieces across the whole library by kind and/or text; reports the count | `fetchPieces()` + `matchingPieces()` (`routes/Pieces.tsx:167`) |
| `rule-on-descent` | **commit** | rule at the pruning gate: deeper, stop or park, against a named author | `fetchLane(id)` :226 then `castVerdict(...)` :338 |
| `abandon-descent` | **commit** | take a descent out of the backlog for good | `abandonDescent(id)` :271 |
| `run-iteration` | **commit** | write one descent per repository and ask the engine to start them | `runIteration(id)` :2006 |
| `draft-iteration` | **commit**, reversible | draft a study iteration over a set. Starts nothing | `writeIteration({op:"create"})` :1458 |
| `delete-iteration` | **commit** | delete an iteration; its descents and findings stay | `writeIteration({op:"delete"})` :1458 |
| `add-piece` | **commit**, reversible | add a breadth or depth piece to the library | `writePiece({op:"create"})` :2228 |
| `delete-piece` | **commit** | delete one piece. Refused outright if a method that copied it has run | `writePiece({op:"delete"})` :2228 |
| `delete-selected-pieces` | **commit**, `consumes: "plan"` | delete what `select-pieces` matched, one call per row | `writePiece({op:"delete"})` ×N |
| `goto` | read | the core's, from `screens` + `navigate` | `pushState` + `popstate` |

### Why each kind, including the two that are arguable

**Every `read` is a `GET` through FACTORY's own machine proxy** and nothing else. The port split did the
classifying: `kernel.ts` dials the *human* port from the browser for exactly the writes a machine is not
allowed to make, so "does this write" is answerable by reading one URL constant. Ten reads, eight commits,
and no judgement call in either direction.

**No `read` reports a `count`.** `read-backlog` knows the lane is 3 descents long and says so in
`Report.note` as prose, because `read` promises not to report a count. See "what the kinds could not say"
below — this is the one place the draft fought the type rather than the app.

**`select-pieces` is the only `describe`,** because the piece library is the only place in FACTORY where
many rows are selected for one action (`useBatchDelete`, `components/BatchDelete.tsx`). It is scoped
`screen: "pieces"`, so calling it from the dashboard is the core's `wrong-screen` and names both screens.

**`draft-iteration` and `add-piece` are `reversible: true`, and this is the judgement to argue with.**
Neither verb can undo itself; what makes the claim true is that a sibling verb deletes the record and the
prior state was "this record did not exist". A drafted iteration runs nothing until `run-iteration`, and a
new piece changes no existing method — every item in a template is a *copy*, so adding a piece cannot
alter anything already written. **If the owner thinks `reversible` should mean "this verb has an undo"
rather than "this change can be put back", both flags should come off.** Nothing else in the list claims it:
a verdict, an abandon, a run and all three deletes do not.

**`run-iteration` returns `ok` when nothing was pushed.** FACTORY's `no-emitter` outcome means the descents
*were written* and no event went out. Calling that a refusal would tell an agent nothing happened while
`read-backlog` can already see the new rows, so it comes back `ok` with the count and a note that says
nothing will start. This is the trap `kernel.ts:1953` documents and the draft's handling of it is copied
from that comment, not reasoned out fresh.

---

## Turning it on

Four changes, and the fourth is the one to argue about before any of them.

**1. Add the dependency.** driverkit is unpublished, so it comes from a checkout:
`frontend/package.json` → `"driverkit": "file:../../driverkit/packages/driverkit"`. Until then nothing
here typechecks inside FACTORY. (Checked with `tsc --strict` standalone: 0 errors.)

**2. Copy this directory in** as `frontend/src/app/driverkit/` (or keep it here and point a path alias at
it). Nothing in `src/` imports FACTORY, by construction, so the move is a copy.

**3. One new file, `frontend/src/app/driverkit/adapter.ts`** — the three lines the port exists for. It is
new, not an edit:

```ts
import * as kernel from "../lib/kernel";
import { matchingPieces } from "../routes/Pieces";   // already exported, routes/Pieces.tsx:167
import type { KernelPort } from "./port";

export const port = (humanBase: string, login: string | null): KernelPort => ({
  fetchHealth: kernel.fetchHealth,
  fetchDescents: kernel.fetchDescents,
  fetchLane: kernel.fetchLane,
  fetchDescentDetail: kernel.fetchDescentDetail,
  fetchFindings: kernel.fetchFindings,
  fetchSets: kernel.fetchSets,
  fetchIterations: kernel.fetchIterations,
  fetchTemplates: kernel.fetchTemplates,
  fetchPieces: kernel.fetchPieces,
  fetchIteration: kernel.fetchIteration,
  fetchTemplate: kernel.fetchTemplate,
  castVerdict: (id, prune, note, by) => kernel.castVerdict(humanBase, id, prune, note, by),
  abandonDescent: (id) => kernel.abandonDescent(humanBase, id),
  runIteration: (id) => kernel.runIteration(humanBase, id),
  createIteration: (d) => kernel.writeIteration(humanBase, { op: "create", ...d }),
  deleteIteration: (id) => kernel.writeIteration(humanBase, { op: "delete", id }),
  createPiece: (p) => kernel.writePiece(humanBase, { op: "create", ...p }),
  deletePiece: (id) => kernel.writePiece(humanBase, { op: "delete", id }),
  matchingPieces,
  signedInAs: () => login,
});
```

**4. A REAL EDIT TO FACTORY, in `frontend/src/components/Dashboard.tsx`.** There is no way round this one,
and it is where to stop and decide. Inside `Screens` (`:197`) — the component that already holds
`humanBase`, the live `route`, and the hoisted `backlog`, `sets`, `templates` and `keys`:

```tsx
const { publish } = useFactoryDriver({
  port: port(humanBase, login),
  approve: askTheHuman,                       // see below. There is no safe default
  screenNow: () => route.name,
  whereNow: () => whereIAm(route, backlog),   // yours to write; the screen id is the honest fallback
});
useEffect(() => { publish(rowsFor(route, backlog, sets, templates, keys)); },
          [route, backlog, sets, templates, keys]);
```

`useFactoryDriver` is a four-line `useMemo` over `mountFactory`; it is not written here because a hook
belongs in the app, not in a package that promises not to import React.

**What each of the four buys, so the list is honest about what is optional:**

- Without (1) and (2) nothing runs at all.
- Without (3) every `commit` is unreachable. `humanBase` comes from `process.env.KERNEL_HUMAN_URL` at Astro
  render time (`pages/app/[...path].astro:32`) and reaches the island as a React prop — it is not on
  `window`, not in `import.meta.env`, and not importable. **A draft that hardcoded
  `http://127.0.0.1:8788` would be right on the owner's laptop and silently wrong on every deployment**,
  which is why the port takes it rather than guessing.
- Without (4) the integration still works: `screen`, `where`, `rev`, every read, every commit, `goto` and
  the plan token. What it loses is `Snapshot.rows` for *the person's screen*. See the next section.
- `approve` is required by `mountFactory` even though `mount()` leaves it optional, and that is deliberate:
  **FACTORY already has a human gate in front of its three most expensive actions and every commit here
  goes round it.** Run is two clicks in the UI ("run", then "queue the descents and ask"); a piece delete
  is two; a batch delete is two. `runIteration` called from a verb is one. `MountOptions.approve` is the
  only thing that puts a person back in front of them, so there is no default and the mount will not
  build without one.

### What cannot be turned on at all

- **A verdict skips the author check.** The UI will not enable the three verdict buttons until there is a
  name — the signed-in GitHub login, or one the person typed (`routes/Verdict.tsx:188`). `rule-on-descent`
  takes `by` as a required argument instead, and refuses a blank one, which moves the check from a
  disabled button to an argument the model has to fill in. **A model that invents `by: "assistant"`
  satisfies it.** `signedInAs()` is on the port so the app can supply the real login; the verb does not
  read it, because a verb that quietly signs a person's name to a judgement is worse than one that asks.
- **`rev` only moves for this driver's own writes** until step 4 is made. A person clicking in the UI
  changes the graph and `rev` does not move, so the `stale` check silently does not work for them. This is
  the `rev`-is-a-lie failure `snapshot.md` warns about, and it is unavoidable from outside the app.

---

## What `visible()` honestly shows

FACTORY is neither of the two cases the procedure plans for. It has **no store**, and it has **no DOM to
read either**: no `data-*` on any row on any screen, no `id`, no semantic class name. Every list's search
text, page index, selection and kind filter is component-local `useState` with no export, no context and
no `window` hook. Two agents swept the whole routes tree for a seam; the only id-bearing node in the app is
`id="run-says-<iterationId>"` on one screen, and the only row-level `data-*` is `data-slot` in the template
editor. So `querySelectorAll().map()` has nothing to key off and a `MutationObserver` would be watching
Tailwind classes change.

So the snapshot is in two tiers, and says which it is giving you:

- **Tier 0 (today):** `screen` — exact and free, because `parse(location.pathname).name` is the app's own
  router over the app's own URL — plus `where`, `rev` and `selectedCount`. `rows` and `page` are **absent**,
  which `Snapshot` is explicit means "the app does not publish these" and not "there are none".
- **Tier 0½ (what the reads do):** a `read-` verb publishes its own answer into the snapshot, windowed to
  20 rows, **labelled** `the rows are this driver's last read of <what>, not the rows on the person's
  screen`. That label is the whole of the honesty: an agent holding those rows is holding something the
  person is not looking at, which is the one rule `Snapshot` exists to protect, and the alternative was a
  `read` verb with nowhere at all to put forty rows.
- **Tier 1 (after step 4):** the rows the person can actually see, their page window, and a `rev` that
  moves when the app re-reads.

**The selection is this driver's, not the screen's.** `select-pieces` cannot tick the checkboxes on the
pieces screen — they are a `useState<string[]>` inside `useBatchDelete` — so the selection lives in
`board.ts` and `delete-selected-pieces` acts on it. The count is real and the plan token binds it, and
**the person at the keyboard cannot see what the agent selected.** The `describe`→count→`commit` pairing's
second guarantee is that the rows are highlighted on screen; here only the number is true.

---

## What could not be drafted, and why

1. **Any set write.** `writeSet` create and replace carry `repos: RepoRef[]`, an array of objects, and a
   verb argument has to be a scalar. The delete arm *is* expressible — and is left out on purpose, because
   shipping only the destructive half of a record's CRUD is a verb list that can delete a set and not make
   one.
2. **A method's breadth or depth lists.** `writeTemplate` carries `ItemLineage[]`, same wall. "Add the
   Telemetry piece to the study-the-shape method" is the single most plausible thing an owner would ask of
   a method and it is not expressible: it needs a read of the template, a read of the piece, an append, and
   a replace — which is **new logic**, and the procedure is explicit that `run` calls code that already
   exists. It is four honest lines inside FACTORY and does not belong in a draft nobody has reviewed.
   `delete` *is* expressible; left out for reason 1's reason.
3. **Provider keys and Telegram chats.** `writeKey` takes a `secret`. A verb whose argument is a credential
   puts it in a tool call, which goes to a model, which goes into whatever logs the `messages` array —
   and `kernel.ts:809` is explicit that the two processes that see those bytes are the only two that should.
   Not drafted, not drafted later, listed in `instructions` as something the app cannot do this way.
4. **Requeue.** `POST /descents/{id}/requeue` is live on the kernel's human port (`serve.rs:2098`) and
   **has no function in `frontend/src/app/lib/kernel.ts`**. It is the one thing that could undo a verdict,
   so its absence is also why `rule-on-descent` is not `reversible`. A verb for it needs a FACTORY function
   first.
5. **The iteration wizard's later steps.** `href()` serialises step 1 to `/app/iterations/new` and steps
   2–4 to `/app/iterations/new/<step>`. RFC 6570 simple expansion cannot say "this segment, or nothing",
   so the screen is declared at its step-1 address and an agent cannot deep-link to step 3.
6. **The code leg.** `routes/NewIteration.tsx:704` returns early unless the leg is `study`, and `reach()`
   caps a code draft at step 1 — the code leg is a placeholder in the UI. So `draft-iteration`'s `leg`
   argument is `oneOf: ["study"]`, which makes the move inexpressible rather than refused. One string to
   change the day it lands.
7. **A finding has no id.** It is addressed by `(descent, layer, index)` — positional, in the kernel's
   served order. `Row.id` is one string, so the rows `read-descent` publishes carry a synthesised
   `descent/layer/index` that no verb accepts as an argument. `goto("finding", …)` takes the three
   separately and works; a verb that acted on one finding could not take a row id.
8. **The verdict screen's own gate.** `rule-on-descent` re-reads `GET /descents/{id}/lane` and refuses
   `not-at-the-gate` off its answer, which mirrors the UI's `row.lane === "pruning"` test. That is a
   round trip inside a commit, and it is there because the alternative is a verb that is offered everywhere
   and refused by the kernel in prose an agent has to parse.

## The eval cases

Twelve, in [`evals/`](evals/), written for what a FACTORY owner would ask rather than for what these verbs
can do — **five of the twelve expect nothing to be committed and three expect the agent to ask.**
[`evals/README.md`](evals/README.md) says how to run them and, more importantly, what running them against
a live FACTORY would do. **They have not been run against a model.** `--dry-run` passes with 0 errors
against the fixture.
