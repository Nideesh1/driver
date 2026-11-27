# e2e — the demo in a real browser

The unit suite asserts the widget against a hand-rolled fake DOM. That is the
right tool for the logic and says nothing about whether the thing renders.
This is the other half: one real Chrome, the real page, the real stylesheet,
the real shadow root.

## Run it

```sh
npm ci && npm run build && npx playwright install chromium   # once
npm run e2e                                                  # starts its own demo on a free port
DK_BASE=http://127.0.0.1:8770 npm run e2e                     # or drive a demo you already have up
```

That is the whole thing. `npm run e2e` is
`node --test e2e/smoke.spec.mjs`; screenshots land in `e2e/artifacts/`.

No chromium download on this machine? `DK_CHANNEL=chrome npm run e2e` uses the
real Chrome you already have. `DK_HEADED=1` to watch it. `DK_E2E_CHAT=1` also
runs the one test that needs a model behind `/api/chat`; without it that test
skips, because a missing key is not a regression.

## What it asserts

Things only a browser can see, and the behaviour nothing else checks:

- the page loads with no console errors and no uncaught exceptions
- the launcher is a 96x40 pill labelled **Ask**
- the panel header is `⠿ ⚙ −`, titled **Assistant**
- `#/contacts` renders 20 rows, `#/companies` renders 8
- a deep link to `#/contacts/c-0184` renders that record, not the not-found screen
- **minimising keeps the transcript**
- **the grip drags the panel and the gear does not**
- the settings view opens, and **Clear conversation** empties the transcript
  and puts the greeting back

## The one trap

Never `waitUntil: "networkidle"`. `connect()` holds an SSE stream to the relay
open for as long as the page is open, so the network never idles and every
navigation times out after 30 seconds with nothing wrong. Use
`domcontentloaded` and then wait on an element.

## The demo in Docker

An addition, not a replacement — the demo needs `python3` and a built
`packages/driverkit/dist`, and nothing else.

```sh
docker compose up --build
open http://127.0.0.1:8770/examples/contacts/app/
```

No API key is needed to serve the page: every screen and the relay work
without one, and only `/api/chat` does not. Put `ANTHROPIC_API_KEY` in the
environment of the shell running compose to get the widget talking to a model;
nothing is written to a file and nothing reaches the browser.

`--profile relay` also starts `driverkit-relay` on its own port, from the pip
half of the project.

One thing worth knowing if you change the compose setup: the relay refuses any
caller that is not on loopback, and a request that arrives through a published
port comes from the Docker gateway. So both containers bind loopback and a
`socat` forwarder carries the published port to them — the relay sees
`127.0.0.1` and nobody has to invent a credential for a dev container. Take
the forwarder out and the page loads with a red dot and a 403 in the console.
