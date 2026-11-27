# Writing the verb list

**The procedure is not in this file.** It is [`INTEGRATING.md`](../../../INTEGRATING.md) at the driverkit repo
root — or `INTEGRATING.md` beside `SKILL.md`, if this skill was installed with the copy step in
[the skill's README](../README.md). Read it, follow the six steps, and come back here for the deep end.

It is one file rather than four because this procedure used to exist in four copies, and the day the wording of
`read` changed from "changes nothing" to "changes no data and reports no count" it had to be fixed in all of them.
If a rule needs changing, change it there.

## What `INTEGRATING.md` already carries

The whole sequence (install → draft → **prune** → import → `/api/chat` → eval), the read-before-you-write rule,
the pile-sorting table and the greps that find the candidates fast, the `kind` decision procedure, the
`describe` → count → `commit` pairing and `consumes: "plan"`, the argument-design rules (`oneOf`, no free-form
predicate, scalars only, `refuses`, reserved slugs), the five `visible()` rules, the four questions to ask the
human rather than decide, and the pre-flight checklist.

So: do not summarise it back to the user from memory, and do not re-derive it. Open it.

## What this skill adds

| when you are | open |
|---|---|
| about to draft your first verb list | [worked-example.md](worked-example.md) — the procedure run over a messy three-year-old React app, every verb, every `kind` justified, and what was left out |
| writing `visible()` | [snapshot.md](snapshot.md) — the full contract, the three `page` states, what `rev` promises |
| adopting an app with more than one screen | [screens.md](screens.md) — `Verb.screen`, `Snapshot.screen`, `CallOptions.screen`, `Manifest.screens`, and `Manifest.flows` for a job that takes several verbs |
| wiring the panel | [widget.md](widget.md) — `/api/chat` in full, the commit gate, every option, the stop reasons |
| driving from another process | [relay-mcp.md](relay-mcp.md), then [auth.md](auth.md) once more than one person uses it |
| asked for something no verb covers | [controls.md](controls.md) — and propose it separately from the draft, never inside it |
| measuring the list you wrote | [eval.md](eval.md) — every `expect` field, diff mode, and the case-writing traps that made the demo's own suite go red while the agent was right |
| installing it today | [packaging.md](packaging.md) |
| "the tab connects and nothing happens" | [troubleshooting.md](troubleshooting.md) |

In Claude Code, `/driverkit:draft-verbs [dir]` runs a name-based survey of the app and drafts the file. Its own
rules are deliberately a restatement rather than a pointer, because it runs in the **app's** repository, where
`INTEGRATING.md` is not on disk. Treat its survey as evidence about where to look, never as a substitute for
reading the files.

## The three readings that were wrong, and why they changed

Worth knowing before you "fix" a rule back to the obvious version. The argument in full is the README's
[*What makes bulk work safe*](../../../README.md#what-makes-bulk-work-safe).

- **`read` is not "changes nothing".** The commonest verb in a multi-screen app — `go`, `open-contact`, `back` —
  moves the person's screen out from under them, and the old wording told an agent that was free. `kind` is about
  what a wrong call **costs**, and a wrong navigation costs what a wrong read costs. The two promises worth making
  are the ones that decide whether the *next* call is safe: no data moved, no count left pending.
- **`describe` is about selection, not filtering.** By the old wording a search box was a `describe` while none of
  the rest of what `describe` means applied to it. The count is the number a following `commit` turns on, and the
  pair is the safety mechanism; a verb that narrows a list and leaves nothing pending is a `read`.
- **`reversible: true` exists because the capitals stopped meaning anything.** `set-setting("rows-per-page", 50)`
  and accepting 3,412 contacts were both just `commit`, so both got the same shouted banner — and a banner that
  fires on a page size is one a model learns to read past, the same way a person learns to click Yes without
  reading. It says there is a way back, not that nobody minds.

Reclassifying a verb changes the manifest fingerprint and invalidates every cached copy. That is deliberate, and
it is why guessing now is not free.
