---
description: Scan this repo and draft src/driverkit.ts — verbs with names, kinds, args and refusals — for a human to prune
argument-hint: [directory to scan, default .]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/scan-app.mjs*) Read Grep Glob Write
---

Survey of the app:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/scan-app.mjs --root $1`

(If the line above shows a literal `${CLAUDE_PLUGIN_ROOT}`, the variable did not expand: find the plugin
directory and run `node <plugin>/scripts/scan-app.mjs --root .` with Bash instead.)

The rules below are the whole procedure, so this command works with no skill loaded. If the `driverkit` skill is
available, its `references/authoring-verbs.md` and `references/worked-example.md` go deeper on the judgement
calls; read them before a hard case rather than instead of the files you are drafting from.

Your job is the hard part of adopting driverkit: **authoring the verb list**. The scan above is name-based
evidence and nothing more. Do not write a verb for a function you have not read.

## Steps

1. **Read before drafting.** Open the two or three highest-ranked files from the survey (the store, the API
   client, the server actions) and the component that renders the main screen. If the survey found no
   candidates, grep for the words on the app's own buttons instead — "accept", "assign", "archive".
2. **Draft one new file**, `src/driverkit.ts` (or beside the store, following this repo's layout; `.js` with
   JSDoc if the app is not TypeScript). One `mount({ app, verbs, visible })`, nothing else. Do not edit the
   app's existing code in this command, and do not wire up the widget or the relay — that is `/driverkit:check`
   and the skill's job, and a draft that also rewires the app is a draft nobody can review.
3. **Aim for six to twelve verbs**, the ones a person would ask for out loud. A verb per exported function is a
   manifest nobody can read and a prompt nobody can afford.
4. **Show the human what to prune.** End with a table: verb, kind, the file and function its `run` body calls,
   and your confidence. Mark every guess inline with `// REVIEW:` — an unverified selector, an argument type you
   inferred, a refusal you think exists. Then say plainly which verbs you are least sure about.

## The rules the draft must follow

- **A bulk verb takes a predicate, never an id.** `select-where({ company })` resolved inside the app, not
  `select(id)` a thousand times. The agent should never learn an id it did not need.
- **Split every bulk action in two.** A `describe` verb takes the predicate, changes only what is selected or
  filtered, and returns `{ count }`. The paired `commit` verb takes **no arguments** and acts on the current
  selection. That is what makes a count always visible before data moves.
- **Declare `kind` on every verb.** An absent one makes no safety claim in either direction, so an agent cannot
  tell a free read from something irreversible. `read` changes nothing, `describe` changes the selection or the
  filter, `commit` changes data.
- **Fill in `refuses`.** Short stable slugs from the app's own vocabulary (`nothing-selected`, `already-paid`).
  It is the field people skip and the one that lets an agent avoid a call instead of discovering the answer by
  making it. Declaring it also opts the verb into a dev-time check.
- **Never use a reserved slug** as a verb name or a refusal: `stale`, `unknown-verb`, `bad-argument`,
  `unmounted`, `threw`, `no-such-tab`, `tab-went-away`, `timeout`, `declined-by-user`. `mount()` throws on it.
- **Names** are kebab-case, stable, unique. **`describe`** is one imperative line in the user's vocabulary
  ("accept the selected contacts"), never "calls patchContacts". Each arg's `describe` is written for a reader
  who cannot see the app; use `oneOf` instead of prose when the set is closed.
- **Arguments are scalars only** (`string | number | boolean`), because a verb whose args cannot survive JSON
  cannot be called from outside the page.
- **`visible()` returns only what the person can see** — same filter, same sort, same page — plus `rev`,
  `page` (include `total` only if the app really knows it; omit `page` only when the rows are all there are),
  `selected` (on-screen ids only) and `selectedCount` (the honest total). It runs on every call, so keep it
  cheap, and never put a per-user string in the verb list: the verbs are the half that gets cached.
- **`run` calls code that already exists.** If an action lives only inside a click handler, do not invent a
  selector: mark the button `data-dk="..."` and use `clickHandle("...")` from `@driverkit/adapters`, and list
  the markup change as a separate step for the human to approve. Same for `rowsFromTable` / `revFromMutations`
  when the app has no store.
- Return `ctx.refuse("slug", "hint")` for an expected no, a `{ count }` report from a `describe`, and nothing
  otherwise. Throwing is a bug, not a no.

If `driverkit` is not in the app's dependencies, say so at the end: the draft will not typecheck until it is,
and nothing is published yet, so it comes from a checkout.
