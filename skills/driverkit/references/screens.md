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

Omitting either opts out of that check, which is what every call did before these fields existed. `@driverkit/agent`
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
