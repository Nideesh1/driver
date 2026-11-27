# Adding driverkit to an app

This is **the** procedure, and the only copy of it. If you are an agent with somebody else's repository open and
a job that sounds like "make this app drivable", "let Claude drive this UI" or "add an agent panel", read this
file and follow the six steps. Everything else in the repository explains *why* the design is what it is —
[`README.md`](README.md) for the argument, [`PROTOCOL.md`](PROTOCOL.md) for the wire — and none of it is required
before you start.

## What you are producing

Four things, in this order. The first one is the whole integration; the other three are what make it run and what
makes it trustworthy.

| deliverable | what it is |
|---|---|
| **`src/driverkit.ts`** | one new file: a single `mount({ app, verbs, visible })`. Put it beside the app's store, in the app's own layout and language (`.js` with JSDoc if the app is not TypeScript) |
| **one import** | in the app's entry point, so that file actually runs |
| **`/api/chat`** | an endpoint on the app's **own backend**, holding the model key. Only for the in-page panel — and the panel does nothing without it |
| **`evals/`** | about five JSON cases and an `app.mjs`. Nothing else in this library tells you whether the verb list you wrote is any good |

What you are **not** producing: changes to the app's existing behaviour. `run` bodies call functions the app
already has. If an action exists only inside a click handler you mark one button and write a four-line helper
(step 2), and that markup change is listed for the human separately.

## The sequence

```
1  install                     npm i driverkit            (today: from a checkout — see below)
2  draft the verb list     →   src/driverkit.ts           most of the work, and all of the judgement
3  prune it                ←   the human's job. A draft is a proposal, not a deliverable
4  import it once              in the app's entry point
5  write /api/chat             the in-page panel does not work without it
6  write ~5 eval cases         and run them. Until this, nobody knows whether step 2 worked
```

Steps 1 and 4 take minutes. Step 2 is an hour of reading somebody's code. Steps 3 and 6 are the two people skip,
and they are the two that decide whether the result is worth having.

---

## 1. Install

```sh
npm i driverkit          # the registry, the widget, the loop, the controls layer, the browser side
pip install driverkit    # only for the relay and the MCP server (case 2)
```

Both are published, at **0.1.0**. The Python half is stdlib-only and needs ≥ 3.11; use `uv`, not bare `pip`.

Pre-1.0, so a minor version may change an API. Pin it if that matters to you.

To work against unreleased changes, consume a checkout instead:

```sh
# in the driverkit checkout — `dist/` is gitignored, so an unbuilt package resolves to nothing
npm install && npm run build

# in the app
npm i "file:../driverkit/packages/driverkit"
```

and `uv pip install -e ./python`, or just `PYTHONPATH=python/src`. Full detail, including `npm pack` and
`pnpm link`: [`references/packaging.md`](skills/driverkit/references/packaging.md).

One package, with a subpath per area: `driverkit` (`mount`), `driverkit/widget`, `driverkit/agent`,
`driverkit/react` (optional peer — React is handed in, never imported), `driverkit/check`, `driverkit/otel`,
`driverkit/controls`, `driverkit/browser`, `driverkit/relay` and `driverkit/relay/serve` (**Node only** — a
browser-targeted build asking for the relay fails at build time, on purpose).

## 2. Draft the verb list

### Read before you write

**A verb for a function nobody read is the central failure mode of this whole procedure.** A name suggests what a
function does; only the body says whether it writes. `kind` is a safety claim, and a claim inferred from a name is
a guess with a confirmation dialog attached to it.

So, before the first verb: open the app's store or reducer, its API or service layer, and the component that
renders the main screen. Read the body of every function you are about to name. If an action lives in a click
handler, read the handler. Four to six files is normal; it is the hour this step is worth.

If you are in Claude Code, `/driverkit:draft-verbs` prints a name-based survey of the repo first. That survey is
evidence about where to look and nothing more — it does not replace reading the files.

**Read its `unknown` lines first.** The survey guesses a `kind` by matching the function's name against three
word lists, and every name it cannot place is printed as `unknown` rather than left out. That is not tidiness:
a name it dropped used to be indistinguishable from a function that was not there, and the loss ran one way —
an app whose writes are spelled `writeSet`, `castVerdict`, `abandonDescent` read as an app with no writes at
all. So `0 commit` in the survey means *no name looked like a write*, and it means *this app has no writes*
only when the `unknown` count is `0` too.

### Sort what you find into piles

Do not start from the UI. Start from what already exists as a callable function: those verbs are cheap, precise,
and can count.

| look for | likely verbs | what `run` is |
|---|---|---|
| a store / reducer / signal module (`store.ts`, `useXStore`, `*Slice.ts`, Pinia, MobX, Zustand) | its actions, almost one-to-one | a function the app already has |
| an API client or service layer (`lib/api.ts`, `services/`, a generated SDK, a tRPC router) | the mutations and the list queries | a function the app already has |
| anything that takes a **filter or predicate** and acts on many rows server-side | the `describe`/`commit` pair — **the valuable ones** | a function the app already has |
| a URL router (`router.push`, `navigate`) | `open-x`, `go-to-x` reads | a function the app already has |
| `onClick={…}` with the logic inline, a form's `onSubmit`, a grid's own toolbar | clicks via `data-dk` | a four-line click helper you write |
| rows that exist only in a template or a third-party grid | none — this is `visible()`, not a verb | a `querySelectorAll().map()` you write ([README, "Your app has no store"](README.md#your-app-has-no-store)) |
| anything a person can press that no verb covers | `press`, `type-into`, `commit-control` | `driverkit/controls`, proposed separately ([CONTROLS.md](packages/driverkit/CONTROLS.md)) |

Searches that find these fast:

```sh
grep -rn "export function\|export const.*=.*async" src/lib src/store
grep -rn "onClick=\|@click\|v-on:click" src | wc -l        # the size of the inline-handler pile
grep -rln "useMutation\|fetch(\|axios\." src
```

### Then write the file

One `mount()`, nothing else in it. **Six to twelve verbs per screen, and under about twenty-five for the whole
app** — the things a person would ask for out loud. (The demo app in `examples/contacts/` has eighteen across six
screens; a one-screen integration that reaches twelve is already long.) A verb per exported function is a manifest
nobody can read and a prompt nobody can afford; it also teaches the model your chrome instead of your domain.

```ts
import { mount } from "driverkit";
import { store } from "./store";

export const driver = mount({
  app: "Contacts",
  instructions: "Statuses move new → pending → accepted. Nothing can be un-accepted.",   // static: no user, no screen
  verbs: [
    { name: "search", kind: "read", describe: "filter the list",
      args: { q: { type: "string", describe: "what to search for" } },
      run: ({ q }) => store.search(q) },

    { name: "select-where", kind: "describe",
      describe: "select every contact at one company, across the whole table and not just the page on "
              + "screen, replacing any existing selection, and report how many matched",
      args: { company: { type: "string", describe: "company name", oneOf: [...COMPANIES] } },
      run: ({ company }) => ({ count: store.select(company) }) },      // the count a commit turns on

    { name: "accept-selected", kind: "commit", describe: "accept the currently selected contacts",
      refuses: ["nothing-selected"],
      run: (_a, ctx) => store.selected.size
        ? { count: store.accept() }
        : ctx.refuse("nothing-selected", "nothing is selected. Use `select-where` first and read the count.") },
  ],
  visible: () => ({
    screen: "contacts",                                   // the stable id, compared with ===
    where: "the contacts list, filtered to “Acme”",       // prose, for a human
    rev: store.rev,
    rows: store.onScreen(),
    page: { index: store.page, size: 20, total: store.total },
    selected: store.visibleSelection(),                   // on-screen ids only
    selectedCount: store.selected.size,                   // the honest total; 0 rather than omitted
  }),
});
```

A full draft over a messy three-year-old React app — every verb, why each `kind` is what it is, and what was
deliberately left out — is [`references/worked-example.md`](skills/driverkit/references/worked-example.md). Read
it once before your first draft.

### The rules the draft must follow

**`kind`, on every verb.** This is the one piece of judgement that is genuinely load-bearing: a `commit`
mislabelled `read` tells an agent an irreversible call is free to try, and the panel's confirmation gate fires on
`kind === "commit"` only — so the mislabel also silently removes the human from in front of it. An absent `kind`
makes **no** claim in either direction and is not a safe default.

| kind | means |
|---|---|
| `read` | changes no data and reports no count. **Navigation is a read** — not "changes nothing": it moves the person's screen out from under them, which costs exactly what a wrong read costs |
| `describe` | changes what is **selected**, changes no data, reports a `count`. Not filtering: a search box reports no count and leaves nothing pending, so it is a `read` |
| `commit` | changes data. `reversible: true` says the app can genuinely put it back |

Decide in this order:

1. Does the body call anything that writes — an API mutation, a `PATCH`, a persisted store write, an email, a
   payment, a file delete? **`commit`.** Including when the write looks harmless: the agent cannot tell.
2. Does it change selection, filter, sort, page or which record is open, and nothing else? **`describe`** if it
   resolves a predicate and can report a count; **`read`** if it is a plain navigation.
3. Does it only read? **`read`.**
4. Is it a click on a button you marked? **Nothing can infer the kind — you read the handler, you declare it.**
   Nothing checks that you were right.

**Split every bulk action in two.** The `describe` verb takes the predicate and resolves it *inside the app*,
where the rows already are, and returns `{ count }`. The paired `commit` verb takes **no predicate at all** and
acts on the current selection. Two calls, so a count is always seen before data moves — and selecting a thousand
rows is one call rather than a thousand. A verb that both selects and accepts is how fifty thousand rows get
accepted because a filter was wider than anybody thought.

**A commit on a selection asks for the receipt: `consumes: "plan"`.** The pairing above is necessary and not
sufficient — `accept-selected` re-reads "the current selection" when it runs, so between the two calls a person
can tick a row or a websocket can land, and the count the human approved is then not provably the set that moves.
Django shipped that bug class for fifteen years. A `describe` that leaves a selection behind hands back a `plan`
token beside its `count`; a `commit` declaring `consumes: "plan"` can only be called with one, and a token that is
unknown, stale, spent, or taken over a different selection is refused `stale-plan` naming **both** counts. Reading
and navigating do not spend it: a `kind: "read"` verb that moves `rev` and leaves `selectionId` unchanged keeps the
plan good, so that checking a number before an irreversible commit is never the expensive path. **Publish
`selectionId` if you consume plans** — an app that does not gets the old expiry, where any `rev` move kills the
token, and the core says so once.

```ts
visible: () => ({ …, selectedCount: store.selected.size,
                  selectionId: selectionId(store.selected) }),     // exported by `driverkit`; do not hand-roll it
{ name: "accept-selected", kind: "commit", consumes: "plan", … }
```

- **All or none.** If one commit on the selection consumes a plan, **every** commit on the selection must, or the
  gate is advisory. An eval caught exactly this: asked for a job it could not do, the agent reached for the one
  bulk commit that asked for no receipt, and 403 rows changed ungated. The verb an agent grabs when it is off its
  intended path is the least-declared one.
- **A verb that names what it acts on needs no plan.** Anything taking an id, or acting on the one open record, is
  acting on something the person can see. A plan is the receipt for a count larger than the screen.

**Make an illegal move inexpressible rather than refused.** Every refusal costs a model turn and teaches it
nothing the manifest could have said.

- `oneOf` with the real values beats prose and beats a free string: a wrong value comes back as `bad-argument`
  *listing the accepted set*, which the model fixes next turn without re-reading the screen.
- A free-form `where: string` predicate reads like a kindness and is the opposite — two models invent two query
  languages, both unparseable, and the failure is a silently empty selection. Use named fields.
- **Arguments are scalars only** (`string | number | boolean`): a verb whose args cannot survive JSON cannot be
  called from outside the page.
- If a verb can only apply in one state, prefer two verbs (`approve-draft`, `publish-approved`) over one that
  refuses half the time.
- **Fill in `refuses`.** Short, stable slugs in the app's own vocabulary (`nothing-selected`, `already-paid`).
  It is the field people skip and the one that earns its place: it lives in the **cached** half, so an agent can
  avoid a call instead of discovering the answer by making it. Declaring it also opts the verb into a dev-time
  check.
- **Never use a reserved slug** as a verb name or a refusal — `mount()` throws. The list (`RESERVED_REFUSALS`,
  exported by `driverkit`, is the authority) is all fifteen of: `stale`, `stale-plan`, `wrong-screen`,
  `unknown-verb`, `bad-argument`, `unmounted`, `threw`, `no-such-tab`, `tab-went-away`, `timeout`,
  `declined-by-user`, `approval-pending`, `approval-timeout`, `budget-spent`, `changed-elsewhere`,
  `ask-unanswered`, `nobody-to-ask`, `asks-spent`.
  `wrong-screen` is the one an app has most likely already invented for itself, and `stale-plan` is the one an
  author drafting a `consumes: "plan"` pair reaches for before reading this line.
- Return `ctx.refuse("slug", "hint")` for an expected no, `{ count }` from a `describe`, and nothing otherwise.
  **Throwing is a bug, not a no.**

**Names and prose are what the model reasons from**, and it cannot see your code. Names are kebab-case, stable and
in the user's vocabulary — `park`, not `set-lane`; `describe` is one imperative line ("accept the selected
contacts"), never "calls patchContacts". Renaming a verb later is a breaking change to every stored prompt.

**One screen's verb says so: `screen: "<id>"`** (or a list, for a verb that works on two). The core then refuses a
call made elsewhere as `wrong-screen`, naming both screens. Do not write that guard by hand. **The verb list must
not vary with the live screen** — one that did would bust the cached prompt prefix on every navigation, which is
the whole cost argument. [`references/screens.md`](skills/driverkit/references/screens.md).

**Nothing per-user, per-tenant or per-screen in the static half** (`app`, verb `describe`, `instructions`). One
user-specific string there busts the prompt cache for everybody and the library stops being cheap. The app's own
briefing goes in `MountOptions.instructions`, not in every snapshot's `note` — the manifest is cached once, the
note is paid for on every turn.

**`visible()` returns what the person can see and nothing more** — same filter, same sort, same page. That is what
keeps cost flat as the data grows. Five rules while drafting; the full contract is
[`references/snapshot.md`](skills/driverkit/references/snapshot.md):

- **`screen` is the id, `where` is the prose.** `screen` is stable kebab-case and exists to be compared with
  `===`, the only way "did I navigate?" can be answered. Do not spell the screen's identity into `where` and
  leave `screen` out. An app with one screen omits it.
- **`rev` must move on every mutation and never go backwards.** Route every change through one `bump()`. A path
  that changes the table without moving `rev` hands out a `rev` that is a lie, the `stale` check silently stops
  working, and the symptom is an agent editing the wrong row an hour later.
- **`page`** says whether the rows are a window: absent = "this is everything", `{index,size,total}` = a known
  window, `{index,size}` = a window of unknown size. Never fake a total.
- **`selected` is on-screen ids only; `selectedCount` is the real size** (`0`, not omitted — an absent one means
  "I do not count"). Filling `selected` with ten thousand ids puts tens of kilobytes in the uncached half of
  every result from then on.
- **Zero rows is a claim.** `rows: []` says "there are no records". If the table has not rendered yet, omit `rows`
  and say so in `note`.

Keep it cheap: it runs on every call, twice on the refusal paths.

### If the app has no store, or its actions live in click handlers

Both cases are in the README and the library deliberately ships no helper for either, because every such helper
is a guess about how an app holds its data: [README, "Apps that are not tidy"](README.md#apps-that-are-not-tidy).
The short version — mark the button yourself (`data-dk="bulk-accept"`) and write the four-line click helper; read
rows with a `querySelectorAll().map()` and bump a counter for `rev`. Two costs no library can carry: a click runs
whatever the handler does, so you must read it to declare `kind`, and a rendered-but-disabled button is clicked,
does nothing, and reports `ok`.

## 3. Stop. The draft is a proposal

**An agent that writes forty verbs and calls the job done has failed.** The verb list is the only description of
the app a model ever gets, it lives in the cached half of every prompt, and a rename breaks stored prompts — so it
is reviewed by somebody who knows the product before it is wired to anything.

End the draft with a table: **verb, `kind`, the file and function its `run` body calls, your confidence.** Mark
every guess inline with `// REVIEW:` — an argument type you inferred, a refusal you think exists, a selector you
did not verify. Then say plainly which verbs you are least sure about.

Four questions that are **not yours to decide**. Ask them, and wait:

1. **Which actions may an agent perform at all?** Not every function that exists should be reachable. Billing,
   deletion, anything that emails a customer — the answer is a product decision.
2. **Is this `commit` truly irreversible?** `reversible: true` means the app really can put the change back, not
   that nobody minds. It turns the confirmation dialog off for small selections, so a wrong `true` is a silent
   removal of the human.
3. **What is the app's own vocabulary?** The words on the buttons and in the support tickets, which is what a user
   will type. Guessing produces a manifest that reads like your code rather than their product.
4. **Which numbers are real?** If you assert a count in step 6, somebody has to confirm the fixture it came from.

Cut, in this order: anything purely cosmetic (theme, sidebar collapse), anything reachable another way, anything
needing an id an agent has no honest way to learn, and every `select(id)`-per-row verb.

### Let the agent ask, or it will guess

`approve` is a **gate**: the person can stop the agent. `ask` is a **channel**: the agent can ask the person
something. Until it existed, an agent that met an ambiguous instruction had two moves, guess or give up — and
guessing is the expensive one even when it guesses right, because it did not know. It is the same argument
`declined-by-user` rests on, one level up: a model that cannot tell "the person said no" from "your arguments
were wrong" retries with different arguments, and **a model that cannot ask will guess.**

Declare it and the core adds a reserved `ask` verb. Nothing else changes; an app that declares nothing gets the
manifest, the fingerprint and the prompt it had before.

```ts
let panel: Widget;
const driver = mount({
  …,
  // The ONE function the core cannot write: it has no panel and no idea whether anybody is looking.
  ask: ({ question }) => panel.question({ question }),
  // A ceiling on the person's patience. Absent means none, like `calls` and `commits`.
  budget: { asks: 5 },
});
panel = mountWidget(driver, { think });
```

**It has to be declared at `mount()`.** The panel cannot adopt it the way it adopts the commit gate, and that is
the one constraint that outranks everything else here: `system` and `tools` are byte-identical on every turn so
the prompt prefix stays cached, so a verb that appeared when a panel mounted would be a tool list changing
underneath a running conversation.

**The answer is the call's own result.** The person's words come back as `ok — the person answered: "…"`, which is
why it works identically through the relay and through the panel and why neither renderer needed a line for it.
The core keeps **no copy** — which is also the whole of the next point.

**An answer is not an approval.** A `commit` after an answered question still goes to `approve` and can still come
back `declined-by-user`. There is no remembered yes for a later call to consult, so the separation is structural
rather than a policy you could relax. Do not wire `ask` to anything that decides whether a commit runs.

**Three ways there is no answer, and they are three facts** — `ask-unanswered` (put, and ignored),
`nobody-to-ask` (there is no person on this run) and `asks-spent` (the allowance is gone). The repairs differ, so
the slugs differ, exactly as `approval-timeout` differs from `declined-by-user`. Your hook returns the person's
words, `{ answered: false }`, or `{ nobody: true }`; a hook that throws is an unanswered question and never a
claim that nobody is there.

**`askTimeout` defaults to 45 seconds, which is the opposite of `approvalTimeout`'s "wait forever".** A lapsed
approval *denies* a commit somebody was still reading about; a lapsed question denies nothing. And 45 is chosen
against the relay's 60: a question that outlived the transport's deadline would turn "nobody answered", which an
agent can act on, into `timeout`, which means **nobody knows**. If you lower `RelayOptions.timeoutMs`, lower this
with it.

What the hook must be is honest about who is there. A mounted panel is a place a question can be seen, so
`Widget.question` answers `{ answered: false }` on teardown and never `{ nobody: true }`; a cron run, a headless
harness or a tab with no panel is the case for `{ nobody: true }`, and
[`examples/contacts/evals/app.mjs`](examples/contacts/evals/app.mjs) is that case written down.

## 4. Import it once

`mount()` has no effect unless the module runs. One line in the app's entry point:

```ts
import "./driverkit";                       // or: import { driver } from "./driverkit";
```

Then verify the integration with no model and no browser involved:

```ts
console.log(JSON.stringify(driver.manifest(), null, 2));          // exactly what the model is told. Read it as a stranger
const out = await driver.call("select-where", { company: "Acme" });   // the Result, plus the screen after it ran
```

Keep the verb table in a file with no DOM imports — as
[`examples/contacts/app/store.js`](examples/contacts/app/store.js) does — and it stays testable without a browser,
which step 6 needs.

## 5. Write `/api/chat`

Only for the in-page panel (case 1). **The panel does not work without it**, and this is the step people are
surprised by, so do it in the same change as step 4.

```ts
import { mountWidget } from "driverkit/widget";
import { backendThink } from "driverkit/agent";

mountWidget(driver, { think: backendThink("/api/chat") });
```

`think` is a function and not a provider option for one non-negotiable reason: **a browser cannot hold an API
key.** `backendThink(url)` POSTs `{ system, tools, messages }` to the app's own backend — which already
authenticates this person and already holds the key — and expects `{ text?, calls? }` back. Never add a key to the
page, and never accept a widget option that would take one.

Three translation facts that cost real time if you miss them, writing that endpoint against the Anthropic
Messages API:

1. **`system` and `tools` are byte-identical on every request** until the verbs change. Forward them with your
   provider's caching marker on (Anthropic: `cache_control` on the `system` block and on the **last** tool) and
   you pay for the app's capability list once instead of once per turn.
2. **driverkit's `Turn` has three roles; the Messages API has two.** A `role: "tool"` turn is a `tool_result`
   block inside a **user** message, and **consecutive tool turns must be merged** into one user message with
   several blocks — several user messages in a row is a 400.
3. **Echo `id` / `tool_use_id` exactly** and pass verb names through verbatim.

A working endpoint in about thirty lines of Python, with the error handling, is
[`examples/contacts/server.py`](examples/contacts/server.py). The options, the commit gate and the stop reasons
are [`references/widget.md`](skills/driverkit/references/widget.md).

**Driving the app from another process instead** (a voice assistant, Claude Desktop, an agent on another machine)
replaces this step rather than adding to it: the tab dials out with `connect()` from `driverkit/browser` and holds
one SSE stream open to a relay, and the agent talks to the relay over MCP. No `/api/chat` and no key in the app.
[`references/relay-mcp.md`](skills/driverkit/references/relay-mcp.md), plus
[`references/auth.md`](skills/driverkit/references/auth.md) the moment more than one person uses it.

## 6. Write about five eval cases, and run them

**This is the step that decides whether any of the above worked, and it is the one nobody does.** The single
biggest lever on whether an agent picks the right verb is each verb's `describe` — and without a harness, editing
one is superstition: you change a sentence, the agent behaves differently, and you cannot say whether it behaves
*better*.

A case is an ask plus what must not happen, one JSON file per failure mode, in a directory beside an `app.mjs`
that exports `newDriver()` — a **factory**, so every run gets a fresh app over fresh data:

```js
// evals/app.mjs
import { createApp } from "../src/store.js";
export function newDriver() { return createApp().driver; }
```

```json
{
  "id": "describe-count-commit",
  "ask": "accept everyone at Acme Industrial who is waiting on a decision",
  "why": "The pairing rule end to end, with the number asserted between the two calls.",
  "expect": {
    "calls":   ["select-where", "accept-selected"],
    "args":    { "select-where": { "company": "Acme Industrial", "status": "pending" } },
    "count":   { "select-where": 112 },
    "commits": ["accept-selected"],
    "steps":   "<=5"
  }
}
```

Run it **from the driverkit checkout**, pointing at the suite directory inside your app: `@driverkit/eval` is a
development tool that is not published and serves its own `src`, so there is nothing to install and no binary on
your `PATH`. Needs Node 22+ for `--experimental-strip-types`.

```sh
# validates every case against the live manifest and replays the asserted counts against the real
# driver with NO MODEL. Free, and it belongs in CI
node --experimental-strip-types packages/eval/src/cli.ts /path/to/your-app/evals --dry-run

# the real thing: needs a server holding the key. Three runs per case, because a model is a sampler
node --experimental-strip-types packages/eval/src/cli.ts /path/to/your-app/evals \
  --endpoint http://127.0.0.1:8771/api/chat --model claude-sonnet-5-5 --runs 3 --save after.json

# what moved since you edited that describe
node --experimental-strip-types packages/eval/src/cli.ts --diff before.json after.json
```

Five cases is a real suite if they are five *different* failure modes. **Start with the ones where nothing should
happen** — an ambiguous ask, an empty selection, a thing the app cannot do, a record that does not exist. A case
that only says what *should* happen passes a run that did that and something expensive as well; `forbid` and
`commits: "none"` are where a case's teeth are. The demo's suite is ten cases and four of them expect the agent
not to act.

Two traps worth knowing before you write the first case:

- **Assert the outcome, not the itinerary.** `calls` is an ordered route, and an app worth driving usually has
  more than one right route; `anyOf` holds several whole routes. The first live run of the demo's own suite went
  red on three cases and the agent was right about all three. Keep the teeth in the count, the commits and
  `forbid`, and never assert the agent's manners — a case that requires an attempt-and-refusal goes red when
  better screen prose makes the attempt unnecessary.
- **Key `count` by verb.** A bare `count: 238` means "the last count any call reported", which in practice caught
  a polite `clear-selection` reporting 0.

Of the four numbers it reports, one is not like the others: a **false commit** is a `commit` verb that *ran* where
the case allowed none. A wrong verb costs a retry; this costs the rows, and running again does not undo it. There
is deliberately no aggregate score, because an "87%" lets a false commit be paid for with two tidy navigations.

The full contract — every `expect` field, diff mode, caching and the case-writing traps — is
[`references/eval.md`](skills/driverkit/references/eval.md), with a worked suite in
[`examples/contacts/evals/`](examples/contacts/evals/).

---

## Before you call it done

- [ ] Every verb has a `kind`, and every `commit` really does write. You read each body.
- [ ] No verb name or `refuses` slug is a reserved slug.
- [ ] Every `commit` the app can undo says `reversible: true`; no `commit` that cannot says it.
- [ ] Bulk work takes predicates. No `select(id)`-per-row verb exists.
- [ ] Every `commit` acting on a selection has a `describe` partner that counts — and if any one of them consumes
      a plan, all of them do.
- [ ] Every verb that works on one screen only has a `screen`, and `visible()` returns the live one.
- [ ] No `describe` text names a function, a table, a component or an endpoint.
- [ ] Nothing in the manifest varies per user, per tenant or per screen.
- [ ] Enumerable arguments use `oneOf`.
- [ ] A stranger reading only `driver.manifest()` could do the app's three commonest tasks.
- [ ] The human has seen the prune table and answered the four questions in step 3.
- [ ] `--dry-run` is clean, and the live suite has been run at least once.

## Where to go deeper

| | |
|---|---|
| why verbs rather than pixels or selectors, and the two ways in | [`README.md`](README.md) |
| a full draft over a messy app, verb by verb | [`references/worked-example.md`](skills/driverkit/references/worked-example.md) |
| the snapshot contract | [`references/snapshot.md`](skills/driverkit/references/snapshot.md) |
| more than one screen; `Manifest.flows` | [`references/screens.md`](skills/driverkit/references/screens.md) |
| the panel, its options, its commit gate and its question box | [`references/widget.md`](skills/driverkit/references/widget.md) |
| the relay and MCP; tab tokens for several users | [`references/relay-mcp.md`](skills/driverkit/references/relay-mcp.md), [`references/auth.md`](skills/driverkit/references/auth.md) |
| the button nobody wrote a verb for | [`references/controls.md`](skills/driverkit/references/controls.md), [`CONTROLS.md`](packages/driverkit/CONTROLS.md) |
| measuring the verb list | [`references/eval.md`](skills/driverkit/references/eval.md), [`packages/eval/README.md`](packages/eval/README.md) |
| installing from a checkout, the build, the example | [`references/packaging.md`](skills/driverkit/references/packaging.md) |
| "the tab connects and nothing happens" | [`references/troubleshooting.md`](skills/driverkit/references/troubleshooting.md) |
| the wire contract, every status code | [`PROTOCOL.md`](PROTOCOL.md) |
| the types, with the reasoning in the comments | [`packages/driverkit/src/core/types.ts`](packages/driverkit/src/core/types.ts) |

## State of the library — say this before recommending it

- **Unpublished.** `npm install driverkit` and `pip install driverkit` do not work yet. Install from a checkout.
- **Never used on a real app.** The only integration that exists is `examples/contacts`, written by the author.
  Expect to be the first person to hit any given edge.
- **Proven:** both ways in driven end to end — the panel against a live model in a real browser, the relay path
  from another process — plus the TypeScript and Python suites, with the two relay implementations tested against
  each other.
- **Not proven:** `driverkit.fastmcp_server` (MCP over HTTP) has never been executed once. Auth is unit-tested and
  has never run in a multi-user deployment. Treat every API as unstable, and a verb rename as a breaking change.
