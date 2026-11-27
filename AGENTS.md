# Notes for an agent working in this repository

This file is the cross-harness entry point (Cursor, Codex, Copilot, Claude Code, anything else that reads the
repo root). It is short on purpose; the two files it points at are the real ones.

## If you are adopting driverkit into an app

Read **[`INTEGRATING.md`](INTEGRATING.md)**. It is the single authoritative procedure — install, draft the verb
list, prune it with the human, import it, write `/api/chat`, write the eval cases — and it is written to be
followed cold, with somebody else's repository open. Do not reconstruct the procedure from the README: the
README's job is explaining *why* the design is what it is.

Two things it will tell you that are worth knowing before you start, because they are the usual failures:

- **Do not write a verb for a function you have not read.** `kind` (`read` / `describe` / `commit`) is a safety
  claim, and the panel's confirmation gate fires on `commit` alone. A `kind` inferred from a function's name is a
  guess with a dialog attached.
- **A drafted verb list is a proposal, not a deliverable.** Which actions an agent may perform at all is a product
  decision. Hand back a prune table and ask.

## If you are changing this repository

```sh
npm install && npm run build                      # dist/ is gitignored; an unbuilt package resolves to nothing
node --experimental-strip-types --test packages/*/test/*.test.ts
./node_modules/.bin/tsc -p tsconfig.json          # whole repo, strict, sources AND tests
cd python && PYTHONPATH=src python3 -m unittest discover -s tests -t tests
node --experimental-strip-types examples/contacts/check.mjs http://127.0.0.1:8770   # needs the demo running
node --test e2e/smoke.spec.mjs                    # real Chrome; needs a browser on disk
```

`.github/workflows/ci.yml` runs all of it and is the definition of green. Use `uv` for Python, never bare `pip`.

Invariants worth not breaking:

- **[`PROTOCOL.md`](PROTOCOL.md) is the source of truth for the wire**, and there are two independent relay
  implementations (TypeScript and Python) tested against each other. A change to one is a change to three files.
- **No runtime dependencies** in the published package, and the Python half is stdlib-only. That is an argument in
  PROTOCOL.md, not an accident.
- `driverkit/relay` is published under the `node` condition and nothing else, deliberately. There is no browser
  shim, because a `createRelay` that silently did nothing would be worse than a build error.
- **The procedure lives in one place.** `INTEGRATING.md` is it. `skills/driverkit/references/authoring-verbs.md`
  adds Claude-specific framing and defers; `plugin/commands/draft-verbs.md` restates only the rules that shape the
  draft, because a slash command runs in the *app's* repository where `INTEGRATING.md` does not exist. When a rule
  changes, change `INTEGRATING.md` first.
- `skills/` is the root copy; `plugin/skills/` is a vendored copy with a copy step in
  [`plugin/skills/VENDORING.md`](plugin/skills/VENDORING.md).

The library is pre-release: nothing is published to npm or PyPI, it has never been used on a real app, and
`driverkit.fastmcp_server` has never been executed. Say so rather than overselling it.
