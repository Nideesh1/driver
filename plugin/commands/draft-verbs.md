---
description: Scan this repo and draft src/driverkit.ts — verbs with names, kinds, args and refusals — for a human to prune
argument-hint: [directory to scan, default .]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/scan-app.mjs*) Read Grep Glob Write
---

Survey of the app:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/scan-app.mjs --root $1`

(If the line above shows a literal `${CLAUDE_PLUGIN_ROOT}`, the variable did not expand: find the plugin
directory and run `node <plugin>/scripts/scan-app.mjs --root .` with Bash instead.)

## Where this command sits

driverkit's whole adoption procedure is six steps, written down once in **`INTEGRATING.md`** at the driverkit repo
root (<https://github.com/Nideesh1/driver/blob/main/INTEGRATING.md>; also installed beside the `driverkit` skill,
if that is present):

```
1 install   2 draft the verb list ← THIS COMMAND   3 the human prunes it
4 import it once   5 write /api/chat   6 write ~5 eval cases and run them
```

**This command is step 2 only.** It drafts one file and stops. Do not wire the widget, do not edit the app's
existing code, and do not call the adoption finished — say at the end that steps 4, 5 and 6 remain, and that
**step 6 (`@driverkit/eval`) is the only thing that will tell anybody whether this verb list works**.

The rules below are complete enough to produce a correct draft with **no skill loaded and no driverkit checkout
on disk**, which is this command's own requirement — it runs in the app's repository, where `INTEGRATING.md` is
not a file. They are deliberately the rules and not the arguments for them: if `INTEGRATING.md` or the
`driverkit` skill is reachable, read `INTEGRATING.md` §2 and `references/worked-example.md` before a hard case.

Your job is the hard part of adopting driverkit: **authoring the verb list**. The scan above is name-based
evidence and nothing more. **Do not write a verb for a function you have not read** — `kind` is a safety claim,
and one inferred from a function's name is a guess with a confirmation dialog attached to it.

## Steps

1. **Read before drafting.** Open the two or three highest-ranked files from the survey (the store, the API
   client, the server actions) and the component that renders the main screen. If the survey found no
   candidates, grep for the words on the app's own buttons instead — "accept", "assign", "archive".
   **The survey's `unknown` lines are the ones to read first.** `kind` is guessed from the name against three
   word lists and anything the lists do not carry is printed as `unknown`, not dropped — so `0 commit` means
   *no name looked like a write*, which is the same output a read-only app gives and the same output an app
   whose writes are spelled `writeSet` or `castVerdict` gives. Never draft a read-only verb list off a
   `0 commit` line while the `unknown` count is above zero.
2. **Draft one new file**, `src/driverkit.ts` (or beside the store, following this repo's layout; `.js` with
   JSDoc if the app is not TypeScript). One `mount({ app, verbs, visible })`, nothing else. A draft that also
   rewires the app is a draft nobody can review.
3. **Aim for six to twelve verbs per screen, and under about twenty-five for the whole app** — the ones a
   person would ask for out loud. (driverkit's own demo has eighteen across six screens.) A verb per exported
   function is a manifest nobody can read and a prompt nobody can afford.
4. **Show the human what to prune.** End with a table: verb, kind, the file and function its `run` body calls,
   and your confidence. Mark every guess inline with `// REVIEW:` — an unverified selector, an argument type you
   inferred, a refusal you think exists. Then say plainly which verbs you are least sure about.
5. **Ask, do not decide:** which actions may be exposed at all (a product decision, not a code one), whether each
   `commit` is *truly* reversible, and what the app's own vocabulary for these actions is.

## The rules the draft must follow

- **A bulk verb takes a predicate, never an id.** `select-where({ company })` resolved inside the app, not
  `select(id)` a thousand times. The agent should never learn an id it did not need.
- **Split every bulk action in two.** A `describe` verb takes the predicate, changes only what is selected, and
  returns `{ count }`. The paired `commit` verb takes **no arguments** and acts on the current selection. That is
  what makes a count always visible before data moves.
- **Declare `kind` on every verb.** An absent one makes no safety claim in either direction, and the in-page
  panel's confirmation gate fires on `kind === "commit"` alone. `read` **changes no data and reports no count** —
  navigation is a read, and it is not "changes nothing": it moves the person's screen out from under them.
  `describe` changes what is **selected** (not merely filtered) and reports a `count`. `commit` changes data.
  Decide from the body: anything that writes — a mutation, a `PATCH`, a persisted store write, an email, a
  payment, a delete — is a `commit`, including when the write looks harmless.
- **Mark a `commit` the app can undo `reversible: true`.** Read only on a `commit`; absent makes no claim. It says
  there is a way back, not that nobody minds — so a wrong `true` removes the human from in front of the call.
- **A bulk `commit` can ask for the count as a receipt: `consumes: "plan"`**, which the paired `describe` hands
  back beside its count, and which the core refuses as `stale-plan` if the selection moved in between. If you
  propose it for one commit on the selection, propose it for **every** commit on the selection — one bulk commit
  that asks for no receipt is the verb an agent reaches for when it is off its intended path, and then nothing was
  gated. Flag it for the human either way; it also needs `selectionId(...)` in `visible()`.
- **A verb that works on one screen only declares `screen: "<id>"`**, and `visible()` returns `screen` — the live
  screen's stable kebab-case id, beside the prose `where`. The core then refuses a call made elsewhere as
  `wrong-screen`, naming both screens. Do not write that guard by hand and do not invent a slug for it. **The tool
  list must not vary with the screen**: declaring the mapping statically is what keeps the prompt prefix cacheable
  across navigations. A verb that genuinely works on two screens names both (`screen: ["contacts", "company"]`);
  `screen: []` is refused at mount — leave the field out to mean "anywhere".
- **The app's own briefing goes in `MountOptions.instructions`**, not in every snapshot's `note`: it is cached
  once and read by both the in-page loop and an agent arriving over the relay. Nothing per-user, per-tenant or
  per-screen may go in the static half (`app`, verb `describe`, `instructions`) — one such string busts the prompt
  cache for everybody.
- **Fill in `refuses`.** Short stable slugs from the app's own vocabulary (`nothing-selected`, `already-paid`).
  It is the field people skip and the one that lets an agent avoid a call instead of discovering the answer by
  making it. Declaring it also opts the verb into a dev-time check.
- **Never use a reserved slug** as a verb name or a refusal. All fifteen: `stale`, `stale-plan`, `wrong-screen`,
  `unknown-verb`, `bad-argument`, `unmounted`, `threw`, `no-such-tab`, `tab-went-away`, `timeout`,
  `declined-by-user`, `approval-pending`, `approval-timeout`, `budget-spent`, `changed-elsewhere`. `mount()`
  throws on it. `wrong-screen` is the one an app is likeliest to have invented already — use `screen` instead;
  `stale-plan` is the one a `consumes: "plan"` pair invites you to invent — the core already writes it.
- **Names** are kebab-case, stable, unique, and in the user's vocabulary (`park`, not `set-lane`). **`describe`**
  is one imperative line a stranger can read ("accept the selected contacts"), never "calls patchContacts". Each
  arg's `describe` is written for a reader who cannot see the app; use `oneOf` instead of prose when the set is
  closed, so a wrong value comes back as `bad-argument` listing the accepted set.
- **Arguments are scalars only** (`string | number | boolean`), because a verb whose args cannot survive JSON
  cannot be called from outside the page. No free-form `where:` predicate string: two models invent two query
  languages and the failure is a silently empty selection. Use named fields.
- **`visible()` returns only what the person can see** — same filter, same sort, same page — plus `rev` (which
  must move on every mutation and never go backwards), `screen` (if the app has more than one), `page` (include
  `total` only if the app really knows it; omit `page` only when the rows are all there are), `selected`
  (on-screen ids only) and `selectedCount` (the honest total, `0` rather than omitted). It runs on every call, so
  keep it cheap.
- **`run` calls code that already exists.** If an action lives only inside a click handler, do not invent a
  selector: mark the button `data-dk="..."` and write the four-line click helper by hand
  (`document.querySelector('[data-dk="..."]').click()`, throwing when it is not there), and list the markup change
  as a separate step for the human to approve. The library ships no helper for this and none for reading rows out
  of the DOM either — when the app has no store, `visible()` gets a `querySelectorAll().map()` and a
  `MutationObserver` bumping a counter for `rev`, both written by hand. A click runs whatever the handler does, so
  read the handler before declaring `kind`, and remember a disabled button is clicked, does nothing, and reports
  `ok`. For the asks no verb list anticipates, `driverkit/controls` publishes three generic verbs over elements
  marked `data-dk-control` — propose it separately, never as part of this draft.
- Return `ctx.refuse("slug", "hint")` for an expected no, a `{ count }` report from a `describe`, and nothing
  otherwise. Throwing is a bug, not a no.

If `driverkit` is not in the app's dependencies, say so at the end: the draft will not typecheck until it is,
and nothing is published yet, so it comes from a checkout.
