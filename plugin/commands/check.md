---
description: Is the relay up, has the page dialled out, and are the verbs the ones you wrote
argument-hint: [relay URL, default 127.0.0.1:7777 then :8770]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/relay-status.mjs*)
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/relay-status.mjs --manifest --snapshot --relay $1`

Read-only: that printed `/dk/tabs`, the tab's manifest and its last snapshot. It did **not** call a verb, and
neither should you without being asked — a `commit` verb changes data.

Reply in at most six short lines: whether a relay answered and where, how many tabs are connected, and the app
and verb count of the tab. Then, only if something is wrong:

- **No relay answered** — the script already listed the three ways to start one. Prefer mounting
  `driverkit.asgi.relay_asgi` in the server the app already runs; a separate process is a separate thing to
  supervise.
- **Relay up, zero tabs** — the page is not calling `connect()` from `driverkit/browser`, or it is not open.
  A closed tab is not a tab.
- **A verb with no `kind`** — the script names them. An absent kind makes no safety claim in either direction.
- **`manifest: 404`** — the stream opened and `hello` has not landed yet (they are separate requests). A second
  look settles it; if it persists, the tab belongs to another principal, which is deliberately indistinguishable
  from a tab that does not exist.
- **The snapshot looks stale** — `/snapshot` serves the last one the tab volunteered, not a fresh read. The
  authoritative snapshot is the one that rides back on a call's result.
- **`selectedCount` much larger than `selected`** — expected, and the point: the on-screen ids resolve "this
  one", the count is how big a commit would be.

A tab id is a capability. Do not paste one into a shared log or an issue.
