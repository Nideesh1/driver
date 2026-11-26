---
description: Run the contacts example — one page driven both ways, widget in the corner and relay at /dk
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/relay-status.mjs*) Bash(python3 --version) Bash(ls*) Bash(python3 examples/contacts/*) Bash(open http://127.0.0.1:8770*)
---

Is it already running?

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/relay-status.mjs --relay http://127.0.0.1:8770 2>&1 | head -6`

Is this a driverkit checkout?

!`ls PROTOCOL.md examples/contacts/server.py 2>&1 | head -4`

!`python3 --version`

If a relay already answered on 8770, say so and give the URL — do not start a second one.

Otherwise, if the files above exist, start it **in the background** and then tell the user the URL:

```sh
python3 examples/contacts/server.py           # DK_PORT=8770 DK_HOST=127.0.0.1
open http://127.0.0.1:8770/examples/contacts/app/
```

Facts worth stating in the reply, in at most five lines:

- No `npm install`, no build step, no bundler: the server strips the TypeScript types out of the library's own
  sources as it serves them (`tsstrip.py`). Python standard library only, 3.11+.
- `ANTHROPIC_API_KEY` is needed **only** by the corner widget (it is proxied through `/api/chat`, and the key
  never reaches the browser). Without it the page, the 3,412-row table and the relay all still work, and the
  widget says so in its transcript instead of going quiet.
- The relay is mounted on the same port at `/dk`, so the one page is drivable both ways at once. Run
  `/driverkit:check` next to see the tab, or `/driverkit:connect` to drive it from this session.
- Optional: `DK_PORT`, `DK_HOST`, `DK_MODEL` (default `claude-sonnet-5-5`), `DK_MAX_TOKENS`, and `DK_LLM_IP` for
  a shell where DNS does not resolve.

If the files are not there, this is not a driverkit checkout: say so and point at the repository rather than
guessing a path. The three verification scripts, if the user wants them, are
`python3 examples/contacts/verify_strip.py`, `verify_app.py http://127.0.0.1:8770` and `verify_chat.py`, and
`node examples/contacts/check.mjs` drives the demo four ways (that one needs `npm run build` first).

Driving it from a shell: a `GET /dk/tabs`, then `POST /dk/tabs/<tab>/call` with a JSON `{name, args?, rev?}`.
(`examples/contacts/README.md` warns that a chunked body is read as empty; `serve_relay.py` de-chunks now, so
that warning is stale — but `curl -d` sends a `Content-Length` anyway.)
