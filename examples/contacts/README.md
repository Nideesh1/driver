# Contacts — a runnable driverkit app

A CRM contacts screen: 3,412 seeded rows, a search box, a twenty-row window
with paging, row selection, and a `describe`/`commit` pair behind a bulk
accept. One page, drivable two ways at once — the widget in the corner, and
the relay at `/dk` for an agent in another process.

## Run it

```sh
export ANTHROPIC_API_KEY=…            # your own key; nothing is written to disk
python3 examples/contacts/server.py   # DK_MODEL=claude-sonnet-5-5  DK_LLM_BASE=https://api.anthropic.com
open http://127.0.0.1:8770/examples/contacts/app/
```

No `npm install`, no build step, no bundler: the server strips the types out of
the library's `.ts` sources as it serves them. Python standard library only.

Other environment variables, all optional: `DK_PORT` (8770), `DK_HOST`
(127.0.0.1), `DK_MAX_TOKENS` (2048), and `DK_LLM_IP` — connect to that address
instead of resolving the hostname, keeping the `Host` header and the TLS SNI on
the real name so the certificate still validates. Set it in a shell where DNS
does not work.

Without a key the page, the table and the relay all work; only the widget does
not, and it says so in its transcript rather than going quiet.

## Check it

```sh
python3 examples/contacts/verify_strip.py                            # the stripper, against the library's own 215 tests
python3 examples/contacts/verify_app.py  http://127.0.0.1:8770       # the demo, fetched over HTTP and driven for real
python3 examples/contacts/verify_chat.py                             # the Anthropic translation, against a fake endpoint
```

## What is where

| file | what it is |
|---|---|
| `app/index.html` | the screen |
| `app/data.js` | the 3,412 rows, seeded so every reported count is reproducible |
| `app/store.js` | the store, `visible()`, and the verb table. No DOM, so it is drivable headlessly |
| `app/app.js` | the DOM layer, `mountWidget(…)` and `connect(…)` |
| `server.py` | static files, `/api/chat`, and the relay mounted at `/dk` |
| `tsstrip.py` | TypeScript type erasure, so a browser can import the library unchanged |
| `check.mjs` | the demo driven directly, through `drive()`, through the widget, and through the relay |

## Driving it from outside

While the page is open:

```sh
curl -s http://127.0.0.1:8770/dk/tabs
curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"select-where","args":{"company":"Acme Industrial","status":"new"}}' \
  http://127.0.0.1:8770/dk/tabs/<tab>/call
```

Send a `Content-Length`. A chunked request body is read as empty by the
standalone relay and then desyncs the connection — see the bug list in the
accompanying report.
