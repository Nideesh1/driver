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
record. Eighteen verbs, each with a `kind` — seventeen the app wrote and
`goto`, which the core supplies from the declared map — and a `visible()` per
screen that fills in both `screen` (the stable id, compared with `===`) and
`where` (the prose about what the person can actually see). The six screens
are declared as data in `router.js`, next to the route parser, with their RFC
6570 URL templates; the cross-screen job below is declared as a `flow`. Drivable two ways at once: the
widget in the corner, and the relay at `/dk` for an agent in another process.

The multi-step path the whole thing exists to exercise: **find a company, open
it, look at its pending contacts, accept them.** `goto(companies)` →
`sort-companies(pending)` → `open-company(Acme Industrial)` →
`select-pending-here` (reports 112) → `accept-selected`. Two of those verbs
declare a `screen` and the core refuses them anywhere else — naming the screen
you are on and the screen the verb wants — and the commit takes no filter.

That path is now **declared**, as `Manifest.flows[0]`, with a hint on every
step: the agent reads the recipe and carries it out with those five verbs.
Nothing calls the flow and there is no tool for it, which is the point —
`select-pending-here` reports a number and what to do about a number that is
not what the person asked for is a judgement, not a branch.

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
python3 examples/contacts/verify_strip.py                            # the stripper, against the library's own 462 tests
python3 examples/contacts/verify_app.py  http://127.0.0.1:8770       # the demo, fetched over HTTP and driven for real
node --experimental-strip-types examples/contacts/check.mjs http://127.0.0.1:8770   # the same checks, straight off disk
python3 examples/contacts/verify_chat.py                             # the Anthropic translation, against a fake endpoint
```

`check.mjs` is 56 checks and walks all six screens: every screen's `visible()`,
the drill-downs, the router's URLs, the core's `wrong-screen` refusals both
ways round (a verb off its screen, and a call that named a screen the person
has left), the cross-screen accept, and the same job again from outside through
the relay. Four of them are about the map and the recipe: that every declared
URL template expands to exactly what `router.js`'s own `href()` produces (with
`uri-templates` as the oracle, not our own expansion), that `goto` reaches all
six screens by id, that the flow names only verbs that exist, and that the
prose screen-map is gone from the briefing and from every screen's uncached
half.

## What is where

| file | what it is |
|---|---|
| `app/index.html` | the shell: a nav of real links and one mount point |
| `app/router.js` | routes as data — `#/companies/acme` ⇄ `{ screen, id }`, and `SCREEN_SPECS`, the app's map with its RFC 6570 templates. No DOM, no driverkit |
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

call '{"name":"goto","args":{"screen":"companies"}}'    # the core's own verb, from the declared map
call '{"name":"open-company","args":{"company":"Acme Industrial"}}'
call '{"name":"select-pending-here"}'          # describe: reports the count
call '{"name":"accept-selected"}'              # commit: takes no filter
```

Three things to notice in what comes back. `snapshot.screen` is the screen id
and `snapshot.where` is the sentence about it — one is for comparing, the other
for reading. `selectedCount` is the honest size of the selection; `selected`
carries just the ids on the page, because `select-where` can select three
thousand rows and a snapshot that listed them all would be mostly ids, in the
half that is never cached. And `GET /dk/tabs/<tab>/manifest` carries
`instructions` — the app's briefing, fetched once — plus a `screen` on each
scoped verb, so an agent out here is told where a verb works before it calls.
It also carries `screens` and `flows`: an agent out here learns that a
companies list exists before it has been to one, and learns what the five
verbs above are usually combined into, both fetched once rather than paid for
per turn.

## Where driverkit still makes this awkward

Kept short on purpose; the report that came with this work has the full list.
Seven of the sharpest gaps are closed: `Snapshot.screen` says which screen you
are on, `MountOptions.instructions` is where the app's own briefing goes,
`Verb.screen` puts the verb→screen mapping in the cached half so the core
writes the `wrong-screen` refusal instead of the app inventing a slug for it,
that field now takes a LIST of screens, and the widget's commit gate reads
`reversible`.

The list of screens is the one this demo asked for. `next-page` and `prev-page`
page both the contacts list and a company's contact list; while `Verb.screen`
was one string, naming either would have made the verb refuse on a screen that
is still publishing a `page` block, so they declared no screen at all and
refused an invented `no-pages-here` instead. They now declare
`screen: ["contacts", "company"]`, the core names every screen they work on in
the refusal, and both the slug and the `pages()` predicate behind it are gone —
the two questions turned out to have one answer in this app, because the screens
that page are exactly the two the verbs name.

And the commit gate: `set-setting` is `reversible: true`, so the person is no
longer asked the same question about a page-size change as about accepting 3,412
rows — the gate fires on commits that are not reversible, plus any commit acting
on more rows than a person can check by eye, whatever it claimed.

The two newest are the map and the recipe. `Manifest.screens` means the
130-character prose screen-map is gone: the six screens are declared beside
`href()` in `router.js`, with URL templates `check.mjs` proves agree with the
router, and the hand-rolled `go` verb is gone with them — the core builds
`goto` from the map plus a three-line `navigate` hook, it reaches all six
screens instead of four, and an agent meets the same verb name in the next
driverkit app instead of this author's word for it. `Manifest.flows` means the
cross-screen job is declared rather than described in this README, where no
model reads it.

What is left over in this demo:

- **A dashboard's tiles and a settings form are still `rows`.** `Snapshot` has
  no shape for either, so `id` names a tile or an input rather than a record,
  and only the `note` says so.
- **`/dk/tabs` still lists the URL from `hello`.** There is no frame that says
  "I navigated", so the listed URL is stale the moment the tab moves.
- **A screen cannot say which element to outline.** `go` carried `at: ".nav"`
  and the widget drew an outline on the navigation bar before the call;
  `ScreenSpec` has no `at`, so `goto` draws nothing. Presentational, and a
  real loss: the two record screens never had one either, because `at` is one
  selector per verb and `goto` is one verb for six screens.
- **A flow cannot say "repeat the middle for every company".** `steps` is an
  ordered list of verbs, so the one honest shape for "do this per company" is
  an agent reading the recipe and looping itself. Which is the design, and it
  is also the reason this demo declares one flow rather than three.
