---
description: Point this Claude Code session at a driverkit tab over MCP (driverkit-mcp through the relay)
argument-hint: [tab id, when more than one is connected]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/relay-status.mjs*)
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/relay-status.mjs --mcp --manifest --tab $1`

That is the external-agent half of driverkit: the tab holds an SSE stream open to the relay, `driverkit-mcp`
generates its tool list from that tab's manifest, and this session drives the app through its own verbs.

Do this:

1. If no relay or no tab was found, stop and say what is missing — `/driverkit:check` explains each case.
2. If several tabs are connected and no `--tab` was given, show their titles and urls and **ask which**. Do not
   pick one: the wrong choice drives somebody else's screen.
3. Show the `claude mcp add` line and **ask before running it** — it edits the user's MCP configuration. Say
   which of the two forms applies: the first needs the `driverkit` PyPI package (not published yet), the second
   runs the module straight out of a checkout with `PYTHONPATH`, which is all the stdlib-only Python half needs.
4. Mention that the server is pinned to one tab id, so a reload that mints a new id means re-running this. If
   the relay was started with `--secret`/`--audience`, the server needs its own token (`DK_TOKEN`), minted by
   the app's backend.

Once connected, the tools are `list_tabs`, `read_screen` and one per verb. The relay grants no authority: every
call runs inside the session the person is already logged into, and a `commit` verb changes their data — so a
commit is something to propose, not something to try. Every result carries the screen as it was *after* the
call, so there is no need to read again before the next step.
