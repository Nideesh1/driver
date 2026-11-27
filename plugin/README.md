# The driverkit plugin for Claude Code

Four slash commands, two zero-dependency scripts, no hooks.

| | what it does |
|---|---|
| `/driverkit:draft-verbs [dir]` | surveys the repo and drafts `src/driverkit.ts` — verbs with names, `kind`s, args and refusals — for a human to prune |
| `/driverkit:check [relay]` | `/dk/tabs`, the tab's manifest and its last snapshot, read-only, with the usual failures named |
| `/driverkit:connect [tab]` | the `claude mcp add` line that points this session at one tab through `driverkit-mcp` |
| `/driverkit:demo` | runs the contacts example: the widget in the corner and the relay at `/dk` on one port |

Install from a checkout (nothing is published):

```sh
/plugin marketplace add /path/to/driverkit     # needs a .claude-plugin/marketplace.json at the repo root
/plugin install driverkit
```

## The procedure the commands sit inside

Adopting driverkit is six steps — install, draft the verb list, **have a human prune it**, import it once, write
the `/api/chat` endpoint the in-page panel needs, and write a handful of eval cases and run them. They are written
down once, in `INTEGRATING.md` at the repository root, and `/driverkit:draft-verbs` is **step 2 of the six**. It
says so, and it names what remains when it finishes.

## Why these four

The hard part of adopting driverkit is not starting a process, it is **writing the verb list**: deciding what
the app can be asked to do, splitting every bulk action into a `describe` that counts and a `commit` that takes
no predicate, and naming the refusals an agent should avoid walking into. That is reading-a-codebase work, which
is exactly what Claude Code is for and exactly what a library cannot do for you. So `draft-verbs` is the command
that earns the plugin; the rest support it.

`check` and `connect` exist because driverkit's second way in has three moving parts (page, relay, agent) and a
failure in any one of them looks the same from the outside: nothing happens. Both are read-only. Neither will
`POST /call`, because a call runs the app's own code — possibly a `commit` — and a status command that can
change a person's data is the wrong shape of tool.

`demo` exists because the contacts example is the only app driverkit has actually been driven against, and it
needs no key, no `npm install` and no bundler to look at.

## Why there are no hooks

AgentGlow's plugin has a `SessionStart` hook because its value is in capturing events it would otherwise miss:
if the server is not up when the session starts, the session is simply not recorded. driverkit has no such
window. The relay only matters while somebody is deliberately driving a browser tab, nothing is lost by starting
it then, and PROTOCOL.md argues the relay should live inside the server the app already runs — which this plugin
has no business starting.

The alternatives were weighed and refused:

- **Autostart a relay on `SessionStart`.** It would be the wrong relay (a bare process on 7777, not the one
  mounted in the app's server), it would need a published PyPI package to be dependency-free, and it would run
  for every session in every repository to serve the few that have a tab to drive.
- **Warn on `PreToolUse` when a snapshot's `rev` has moved.** A hook fires on every tool call, in every session,
  forever. The cost is real and constant; the benefit is a message the `stale` refusal already delivers at
  exactly the moment it matters, from the core, with the two revs in it.

A hook is a tax on every session in every project. Neither of those pays it back, so the directory is absent
rather than present and empty.

## The scripts

Both are plain Node (18+), no dependencies, nothing installed, and both print an actionable sentence rather than
a traceback when something is missing.

- `scripts/scan-app.mjs` — walks a repo and prints what a verb list is made of: framework, whether a driver is
  already mounted and which verbs it declares, `data-dk` handles, candidate functions bucketed by the `kind`
  their *name* suggests, and whether the screen looks like a table with paging and selection. It reads and
  prints; it writes nothing and runs nothing. Name-based evidence is weak evidence, which is why its output is
  labelled candidates and the command is told to read the files.
  **A name it cannot place comes out as `unknown`, never omitted** — a fourth bucket beside `commit`,
  `describe` and `read`. It exists because an omitted name and a name that is not there printed identically,
  and that silence failed in one direction: on the first real app surveyed outside this repo, eight `write*`
  functions plus `castVerdict` and `abandonDescent` were simply absent, so the survey read as an app with no
  writes. `0 commit` therefore means *nothing looked like a write*, and it means *there are no writes* only
  when the `unknown` count is `0` as well. The lists were widened too; that is the lesser half of the fix,
  since the next app will spell its writes in words nobody listed either.
- `scripts/relay-status.mjs` — `GET /dk/tabs`, `/manifest`, `/snapshot`. Tries `127.0.0.1:7777` then
  `127.0.0.1:8770` (the example's port) unless `--relay` or `DK_RELAY` says otherwise, explains a `401` (present
  a tab token) against a `403` (nothing you can present will help), flags verbs that declare no `kind`, and
  prints the `claude mcp add` line with `--mcp`.

Run either with `--help`.

## The skill

`skills/driverkit/` is a copy of the repository's root skill, and is not written here. See
[skills/VENDORING.md](skills/VENDORING.md) for the copy step and why it is a copy rather than a symlink.

## State

Honest version: driverkit is pre-release and unpublished, it has never been used on a real app, and
`driverkit.fastmcp_server` has never been executed. Both ways in *have* been driven end to end against a live
model and a real browser on the contacts example. This plugin's two scripts were run against that live demo —
the connected tab, its manifest and its snapshot — and against a relay with no tabs, a port with nothing
listening, a missing directory and a directory with no source files.
