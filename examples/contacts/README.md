# Northwind CRM — a runnable multi-screen driverkit app

Six screens over 3,412 seeded contacts and the eight companies they work for:

| URL | screen | shape |
|---|---|---|
| `#/dashboard` | dashboard | tiles and bars. Not a table |
| `#/contacts` | contacts list | 3,412 rows, a search box, a twenty-row window, selection |
| `#/contacts/c-0184` | one contact | their fields, and their activity history as rows |
| `#/companies` | companies list | eight rows, sortable, rolled up from the contacts |
| `#/companies/acme-industrial` | one company | its contacts, tabbed by status, paged, selectable |
| `#/settings` | settings | a form. Also not a table, and it changes the two lists |

One URL per screen, browser Back and Forward, and a deep link straight to a
record. Eighteen verbs, each with a `kind`, and a `visible()` per screen that
says which of the six you are on. Drivable two ways at once — the widget in the
corner, and the relay at `/dk` for an agent in another process.

The multi-step path the whole thing exists to exercise: **find a company, open
it, look at its pending contacts, accept them.** `go(companies)` →
`sort-companies(pending)` → `open-company(Acme Industrial)` →
`select-pending-here` (reports 112) → `accept-selected`. Two of those verbs
refuse on any other screen, and the commit takes no filter.

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

Without a key the page, every screen and the relay all work; only the widget
does not, and it says so in its transcript rather than going quiet.

## Check it

```sh
python3 examples/contacts/verify_strip.py                            # the stripper, against the library's own 215 tests
python3 examples/contacts/verify_app.py  http://127.0.0.1:8770       # the demo, fetched over HTTP and driven for real
node --experimental-strip-types examples/contacts/check.mjs http://127.0.0.1:8770   # the same checks, straight off disk
python3 examples/contacts/verify_chat.py                             # the Anthropic translation, against a fake endpoint
```

`check.mjs` is 45 checks and walks all six screens: every screen's `visible()`,
the drill-downs, the router's URLs, the `wrong-screen` refusals, the
cross-screen accept, and the same job again from outside through the relay.

## What is where

| file | what it is |
|---|---|
| `app/index.html` | the shell: a nav of real links and one mount point |
| `app/router.js` | routes as data — `#/companies/acme` ⇄ `{ screen, id }`. No DOM, no driverkit |
| `app/data.js` | the 3,412 contacts, the eight companies, the per-contact history. Seeded so every reported count is reproducible |
| `app/store.js` | the store, a `visible()` per screen, and the verb table. No DOM, so every screen is drivable headlessly |
| `app/screens.js` | the DOM, one function per screen. No rules, so the harness need not run it |
| `app/app.js` | the route⇄URL sync, `mountWidget(…)` and `connect(…)` |
| `server.py` | static files, `/api/chat`, and the relay mounted at `/dk` |
| `tsstrip.py` | TypeScript type erasure, so a browser can import the library unchanged |
| `check.mjs` | the demo driven directly, through `drive()`, through the widget, and through the relay |

## Driving it from outside

While the page is open:

```sh
curl -s http://127.0.0.1:8770/dk/tabs

call() { curl -s -X POST -H 'content-type: application/json' -d "$1" \
  http://127.0.0.1:8770/dk/tabs/<tab>/call; }

call '{"name":"open-company","args":{"company":"Acme Industrial"}}'
call '{"name":"select-pending-here"}'          # describe: reports the count
call '{"name":"accept-selected"}'              # commit: takes no filter
```

Two things to notice in what comes back. `snapshot.where` is the only thing
that says which of the six screens the call landed on, and `selectedCount` is
the honest size of the selection — `selected` carries just the ids on the page,
because `select-where` can select three thousand rows and a snapshot that
listed them all would be mostly ids, in the half that is never cached.

## Where driverkit made this awkward

Kept out of this file on purpose — the report that came with this work has the
list, with what was wanted, what had to be written instead, and what the
library should do about each. The short version is that `Snapshot` has no field
for which screen you are on, `Manifest` has no place for the app's own
briefing, and a flat verb list cannot say that `select-pending-here` only
exists on one of six screens.
