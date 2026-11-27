# An app with more than one screen

Four fields, and one rule they all exist to protect.

**The verb list must not change with the screen.** A tool list that varied per screen would bust the cached prompt
prefix on every single navigation, which is the cost argument the whole library is built on. So every verb is
offered everywhere, the verb→screen mapping is declared once in the half that gets cached, and only *which screen
is live* is dynamic. `next-page` is offered on the dashboard too, and the core refuses it there with the screen
named.

```ts
mount({
  app: "Northwind CRM",
  // The app's own briefing. Static, cached once, and read by BOTH ways in.
  instructions:
    "This is a CRM with six screens: a dashboard, a contacts list, one screen per contact, a companies list, "
    + "one screen per company, and settings. `go` reaches the four main screens; `open-contact` and "
    + "`open-company` drill into one record and replace the screen you are on.",
  verbs: [
    { name: "sort-companies", kind: "read", screen: "companies", describe: "reorder the companies list", … },
    { name: "select-contact", kind: "describe", describe: "select one contact by id", … },   // anywhere
  ],
  visible: () => ({
    screen: "contacts",                                    // the stable id, for ===
    where: "the contacts list, filtered to “Acme” (433 of 3,412 rows match)",   // prose, for a human
    rev: store.rev,
  }),
});
```

## `screen` is the identity; `where` is the sentence

`where` is documented as "where the user is, in their words", and it carries everything else the person can see —
the filter, the sort, the status tab, and on a drill-down a sentence about the record that is open. So it changes
constantly for reasons that are **not** navigation, and "did I navigate?" cannot be answered by diffing it. That is
why identity moved into a field of its own: `screen` is stable kebab-case, it is compared with `===`, and that is
its whole job.

Absent means the app does not describe its screens, **not** that it has one. An app that leaves `Snapshot.screen`
out keeps every behaviour it had — the core cannot check a `Verb.screen` or a `CallOptions.screen` against nothing,
and makes no claim rather than inventing one. Declaring `Verb.screen` and then forgetting `Snapshot.screen` is the
one combination that is a mistake, and `mount` warns once about it rather than refusing a verb you believe you
scoped correctly.

## Why the refusal is the core's and not yours

Before `Verb.screen`, an app with six screens wrote the check by hand and had to invent a word for it. The next app
would have picked `not-on-this-screen`, and an agent that had learned one would not have recognised the other — so
`wrong-screen` is now **reserved**, like `timeout` and `stale`: it says where a call stopped, not what your app
decided. `mount()` throws if a verb declares it, and the message tells you to use `screen` instead.

What you get for it is a refusal that names **both** halves of the answer:

> you are on the `settings` screen; `sort-companies` works on the `companies` screen. Go there first, then call it
> again.

`wrong-screen` on its own is a dead end — an agent told no and not told where to go has to guess, and the guess is
another refused call. The verb that navigates is your app's and cannot be named from inside the library, which is
what `instructions` is for.

## `CallOptions.screen`: the agent's own claim

`rev` is the agent's claim about *when*; `screen` is its claim about *where*. It is checked **before** `rev`,
because if the agent is not even on the screen it thinks it is, then the arguments and the rev both describe
something it never saw, and "the number moved" sends it to re-read a screen when what it needs is to navigate back.
Different mistakes, different fixes, different slugs.

This catches a failure `rev` does not, and it is a real one: a paging call sent with no `rev`, after the person
clicked away mid-run, paged a different company's contact list and answered `ok`. Nothing about the call was wrong
— both screens page — it simply never said which list it meant.

```ts
await driver.call("next-page", {}, { screen: "contacts", rev: read.rev });
```

Omitting either opts out of that check, which is what every call did before these fields existed. `driverkit/agent`
hoists `screen` into every verb's tool schema the way it hoists `rev`, unless the app has claimed the name itself —
`go(screen)` is a real verb in a real app, and the app's meaning wins.

A verb that genuinely works on **two** screens says so: `Verb.screen` takes a list.

```ts
{ name: "next-page", kind: "read", screen: ["contacts", "company"], describe: "page whichever list you are on", … }
```

The refusal then names the live screen and *all* of the verb's own — "you are on the `dashboard` screen;
`next-page` works on the `contacts` and `company` screens. Go to one of those first" — because naming one of two is
a subtler dead end than naming none: an agent told only about the contacts list navigates there from the company
list it was already standing on. A single string behaves exactly as it always did, and `screen: []` is refused at
`mount()` the way a duplicate verb name is: it says the verb works nowhere, which is an authoring mistake and not a
way to say "anywhere" (leave the field out for that).

This is what closed the gap the demo used to document: `next-page` and `prev-page` page both the contacts list and
a company's contact list, and while `screen` was one string, naming either would have refused a call on a screen
still publishing a `page` block — so the app declared neither and invented a `no-pages-here` refusal, which is
exactly the hand-rolled slug `wrong-screen` is reserved to replace. See `next-page` in
`examples/contacts/app/store.js`.

## `instructions`: the one briefing both paths read

An app that needs to say something about itself — "there are six screens and `go` reaches four of them" — used to
have nowhere to put it. A widget could pass `instructions` to `drive()`, an agent arriving over the relay or MCP
never saw those, and an app that needed both paths briefed ended up repeating itself in `Snapshot.note`: the
uncached half, paid for on every single turn, for a sentence that never changes.

`MountOptions.instructions` lands in `Manifest.instructions`, which is cached once. The in-page loop folds it into
the system prompt; the MCP server puts it in its server instructions. **Static means static** — no ids, no counts,
no user, nothing that differs between two people or two minutes, because one per-screen word in there makes the
prefix uncacheable across users, which is where most of the saving lives. It is in `fingerprint()` for that reason.

Two different fields, and the precedence is documented: the app's `Manifest.instructions` is folded in **first**,
then the host's `DriveOptions.instructions` / `WidgetOptions.instructions`. Whichever is last is the one a model
follows when they disagree, so the host embedding the app wins — a house tone or a rule about this deployment
outranks what the app says about itself. Do not keep a copy of the app's briefing in the host's field: it is
visible to one path and not the other, which is the gap the manifest field was added to close, and two copies of
one briefing is how they drift apart.

## `Manifest.screens`: the map, and the reserved `goto`

The four fields above answer "where am I" and "where does this verb work". They do not answer **"what screens are
there?"** — so until this field existed, an agent could not learn that a companies list was in the app without
being taken to one, and the worked example closed the gap by pasting a prose screen-map into `instructions`. That
is the app's own route table, typed a second time in English, one file away from the first and free to disagree
with it.

```ts
mount({
  app: "Northwind CRM",
  screens: [
    { id: "dashboard", describe: "the headline numbers. Tiles, not a table.", url: "#/dashboard" },
    { id: "contacts",  describe: "every contact, searchable, twenty rows at a time.", url: "#/contacts" },
    { id: "contact",   describe: "one contact and their activity history.", url: "#/contacts/{id}",
      args: { id: { type: "string", describe: "the contact's id, e.g. c-0184" } } },
    { id: "pruning",   describe: "the pruning dialog, over whatever you are on" },   // no url: fine
  ],
  // The core has no router and will not guess at one. This is the whole of what you supply.
  navigate: ({ screen, args, url }) => router.push(url ?? screenToPath(screen, args)),
  verbs: [ … ],
});
```

**`id` is the same string** `Verb.screen` and `Snapshot.screen` are compared against. Three fields that spell the
screen three ways are three fields that disagree after the first rename.

**`url` is RFC 6570**, not a dialect of our own: `{id}`, never `:id` or `<id>`. A route table with holes in it is a
solved problem with a registered media type and a dozen implementations, so a template here can be handed to
`uri-templates` or anything else unchanged. The core expands the one level a route needs, by hand, because
`driverkit` has zero runtime dependencies — the demo loads its `.ts` sources into a browser with no bundler — and
the core's expansion is tested against a real RFC 6570 implementation so it cannot drift. `args` types the
variables, so `goto("company", { slug: 7 })` is refused before anybody navigates rather than landing a person on a
screen with no record on it.

**No `url` is ordinary.** A modal, a wizard step, a tab inside a screen and the whole of an app with no router are
screens with no address. The id is the handle an agent uses; the url is what the app can route on and the one thing
a person can paste.

### Declare every screen the app HAS, never the screens this user can reach

This is the constraint to write on the wall, because it is the one an author will be tempted to break:

> A list filtered by role, by plan, by feature flag or by permission is a **per-user list**, and a per-user list in
> the cached half busts the prompt prefix for everybody — exactly as a per-screen tool list would, one level down.

Two users of the same app must receive the same bytes. If a screen is one this person may not open, that is a
**refusal from the navigate hook at the moment they try**, with a reason an agent can relay ("admin only") — not an
absence from everybody's map. An absence is unfalsifiable: an agent that meets one concludes the feature does not
exist and stops asking, which is the same failure `ScreenControl.disabled` is listed rather than hidden to avoid.

### What you no longer write

Declaring `screens` **and** `navigate` makes the core offer `goto`, and your own navigation verb goes away.

| before | after |
|---|---|
| a verb named `go` / `navigate` / `open-screen` / `route-to`, one per app | `goto`, the same in every app that declares a map |
| its `oneOf` of screen names, hand-maintained | the declared ids, as an enum, from the map |
| the landings only — a record screen needed an argument that could not be required on two of six values | every screen, with each screen's own arguments hoisted onto the verb as optional ones |
| a prose screen-map in `instructions` | the map, as data, rendered into the prompt by the library |
| your own "no such screen" refusal | `bad-argument` listing every screen, from the core's own argument check |

`goto` is a `read`: it changes no data and reports no count, and what it does do — move the person's screen — is
what `read`'s own comment says out loud a read may do. The core refuses `bad-screen-argument` when a screen's own
argument is missing (naming the screen, because "missing argument `id`" on a verb that takes every screen's
arguments does not say which screen wanted it); your hook refuses everything else, in your own vocabulary.

`goto` is reserved in the **weak** sense, unlike `wrong-screen`: an app that declares a verb of its own named
`goto` keeps it and the hook is never called, the same rule as the `rev` and `screen` arguments
`driverkit/agent` hoists into every tool schema. The app's meaning wins over ours. Declaring `screens` with no
`navigate` publishes the map and offers no `goto` — useful on its own, and `mount()` says so once, because the
likelier reading is that the hook was forgotten.

### Generating `screens` from a framework's route table

**Retyping a route table is the authoring burden that kills adoption.** Your app already knows its routes; derive
the list rather than maintaining a second copy. The two things to add by hand are `describe`, which only you can
write, and the decision about which routes are screens at all — an API endpoint, an asset path and a redirect are
not screens, and a `describe`-less entry is worse than no entry.

- **Rails** — `bin/rails routes --expanded` prints every route with its verb, path and controller action; the same
  table is available in process as `Rails.application.routes.routes`. Take the `GET` routes whose action renders a
  page, and translate the path's `:id` segments to `{id}`. A `.json` or `format:` constrained route is not a
  screen. `rails routes` is a documented command and its `--expanded` output is stable enough to parse; the
  in-process table is stabler still.
- **Django** — iterate `django.urls.get_resolver().url_patterns` recursively; `RoutePattern`'s `_route` already
  uses `<int:pk>`-style placeholders, which map to `{pk}` directly, and `name` is a ready-made `id`. For the admin,
  `django.contrib.admin.site._registry` is the registry of models, and the admin's own URL names
  (`admin:app_model_changelist`, `…_change`) give one list screen and one record screen per model — which is a
  whole app's map from one loop.
- **Next.js** — **there is no documented stable route manifest.** The App Router writes
  `.next/app-path-routes-manifest.json` and `.next/routes-manifest.json` during a build; both are internal, both
  have changed shape between minor versions, and neither is covered by Next's public API. Treat anything you read
  there as a generation-time convenience with a pinned Next version and a test that fails loudly when the shape
  moves, or walk `app/**/page.tsx` yourself and translate `[slug]` to `{slug}` and `[...rest]` to a catch-all you
  handle by hand. Do not ship a library that reads it at runtime.

Whichever source you use, generate at build time into a plain array and check it in: the map is static, the
generator is not, and a map computed at mount from a framework's internals is a map that changes when you upgrade
your framework — which moves `Manifest.version` and tells every agent its cached copy went stale for a change you
did not make.

## `Manifest.flows`: multi-step work, as a recipe and not an engine

The level above a single verb. An app's verbs say what can be done and nothing says what is usually **done with
them**, so every agent re-derives the same five-step job and the ones that get it slightly wrong — committing
before reading the count — get it wrong invisibly. Five independent efforts arrived at this level
(webmcp [#255](https://github.com/webmachinelearning/webmcp/issues/255) `registerCollection`,
[#161](https://github.com/webmachinelearning/webmcp/issues/161) `registerSkill`,
[#340](https://github.com/webmachinelearning/webmcp/issues/340), OpenAPI Arazzo's `workflows[]`, and Apple's app
skills), which is the usual sign that the gap is in the problem and not in one design.

```ts
flows: [
  {
    id: "accept-a-companys-pending-contacts",
    describe: "accept the contacts a company has waiting",     // one line, ≤1024 chars
    steps: [
      { section: "find the company", verb: "goto",           hint: "goto(screen: \"companies\")",
        skipWhen: "the person already named the company" },          // optional, one line, a SENTENCE
      { section: "find the company", verb: "sort-companies", hint: "sort by pending so the work is at the top",
        skipWhen: "you already know which company you want" },
      { verb: "open-company",        hint: "open it by name; its list opens on the pending tab" },
      { verb: "select-pending-here", hint: "reports the `count`. READ IT: it is what the next step changes." },
      { verb: "accept-selected",     hint: "takes no filter and acts on the selection. If the count was not what "
                                         + "the person asked for, stop and say so instead of calling this." },
    ],
  },
],
```

**The agent reads a flow and follows it with the verbs it already has. It does not call the flow, and there is no
tool that runs one.** That is a deliberate refusal to ship a workflow engine: a flow that executed internally would
run step 3 on an app whose state had moved — this client already exists, the selection is empty, somebody else
accepted the record a second ago — and its only options are to carry on or stop, both blind, with the agent that
could have adapted holding nothing but an `ok`. Adapting mid-job is the one thing a model is better at than a state
machine. Apple's app skills make the same admission out loud: *"Skills don't enforce deterministic behavior, and
Siri doesn't run the listed intents in sequence."*

**Spend your effort on `describe`.** Microsoft's finding on selection across tool groups is that the choice *"is
based on the plugin's description, not on any of the individual functions"* — a model picking between flows reads
those sentences and not the steps.

Validated at `mount()`, like a duplicate verb name: a step naming a verb the app does not have **throws**. A recipe
citing a verb nobody implemented is a dead end whose only symptom is an agent halfway through a job meeting
`unknown-verb`, after the navigation and before the commit. A flow that reaches a step whose verb declares
`consumes: "plan"` with **no earlier `describe` step** throws for the same reason: the token comes from one of
those, so that recipe could only ever end in `stale-plan`, found at the same worst moment. Both are visible
statically, from what the verbs already declare. It is in `fingerprint()` for the reason `kind` and
`screen` are, with one extra edge: a flow names verbs, so renaming one leaves every cached copy holding a recipe
that cites a verb which no longer exists.

### `skipWhen`: a condition, in words

A flat list of steps reads as all-required, so a step that is only there for the case where you do not already know
the answer had nowhere to say so and its condition went into the middle of a `hint`. `skipWhen` is that condition,
in its own field: present means the step may be skipped when it holds, absent means take it. The renderers print it
as `1. \`goto\` (OPTIONAL — skip it when …) — …`, so a model skimming five numbered lines can see which steps carry
the job without reading every sentence.

**It is a sentence and not an expression, and that is the design.** The obvious thing to put here is a
machine-readable predicate — Arazzo has `successCriteria`, VS Code has `when` clauses. It would be counterfeit
precision, because **nothing in this library evaluates a flow**: a flow is read and followed by the model, so the
only evaluator a predicate could ever have is the reader it is written for, and a predicate a model interprets is a
sentence with brackets round it. All of the rigour is in the notation and none in the enforcement, which is worse
than prose rather than better — a condition that *looks* checkable gets trusted like one.

The conditions that have to be enforced already have an enforced home. "If the count is over 500, ask first" is not
a flow step; it is three lines where the core and not the model holds the gate:

```ts
approve: (req) => ((req.snapshot.selectedCount ?? 0) > 500 ? askTheHuman(req) : true)
```

and "never commit a count you have not read" is `consumes: "plan"` on the verb. So: conditions that decide whether
**data moves** go in `approve`; conditions that decide **which steps you take** go in `skipWhen`, in words. One
line, ≤1024 characters, and it counts against the flow's 10,000-character body budget — moving a sentence out of a
`hint` buys no room.

### What a flow deliberately cannot say

**No iteration.** "For every company, accept its pending contacts" is N commits, and the whole `describe` → read
the `count` → `commit` apparatus, plus the plan token, exists to make ONE commit over many rows safe *instead of*
many commits over few: one count a person can check, one approval naming a real number. A declared loop would be
the manifest teaching an agent to do the thing the plan token was built to stop — N approvals that each look small,
with nobody shown the total. It is also unnecessary in the case it is wanted for, because a verb that operates on
many rows **takes a predicate and resolves it inside the app**: declare `select-where(status: "pending")` and get
one count and one commit. If the job cannot be expressed as a predicate, the repetition is a judgement call about
data the agent must look at between iterations, and it is N approvals because it is N commits.

**No data flow between steps** — no `from: "step2.slug"`. It would need a named output to refer to (`Verb.returns`),
and carrying a value between steps means the AGENT holds it, which is what `Verb` is written against: *the agent
should never learn an id it did not need*. The steps above pass nothing — `open-company` moves the screen,
`select-pending-here` means *this* company, `accept-selected` means *this* selection — because the app holds the
state between steps. The one value that genuinely crosses two steps is the plan token, and it is already declared
per verb and enforced by the core; the renderers print which step it came from, derived from `kind` and `consumes`,
so there is no second declaration to keep in step.

### The size budgets, and why there are any

`SIZE_LIMITS`, copied from Apple's app skills: **`describe` ≤ 1024 characters on one line** (`FlowSpec` and
`ScreenSpec` both, and `FlowStep.skipWhen`), **a flow's steps ≤ 10,000 characters** together — every `section`,
`verb`, `hint` and `skipWhen` — and **`instructions` ≤ 10,000**.

`instructions` had no documented bound, so the honest answer to "how much may I write?" was "nobody has said", and
the field drifts toward being a README. Everything here is in the cached prefix of every session of every user,
which is exactly why it is cheap and exactly why it is tempting: the cost is real, it is just paid once and
invisibly, so a number is the only thing that makes anybody weigh it. The second cost is the one a budget really
guards — text in the prefix competes with the verb list for a model's attention, and a thousand words about the app
is a thousand words read instead of the tool that commits data.

The new fields **throw** when they exceed theirs. `instructions`, which predates having a budget at all, only
**warns**: an app that mounted yesterday with a very long briefing must still mount today, and a new throw on an
old field is exactly the kind of change the additive rule forbids.
