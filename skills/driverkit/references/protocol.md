# The wire protocol, in brief

`PROTOCOL.md` at the repo root is the contract; this is the working subset plus the parts clients get wrong. Three
parties: an agent, the relay, and a browser tab. Everything in the repository is an implementation of one side, and
anyone can write another.

```
agent                relay                 browser tab
  │                    │◀── GET /dk/events ──┤   opens on page load, stays open (SSE)
  ├── POST /call ─────▶├──── event: call ───▶│   driver.call(...)
  │                    │◀── POST /dk/result ─┤
  │◀─── the Result ────┤                     │
```

**Why a tab dials out:** nothing can call into a page. **Why SSE and not WebSocket:** the relay belongs inside a
server you already run, where SSE is "write a line, flush" in any language, `EventSource` and `fetch` are built in
on the browser side, and the traffic is tiny and asymmetric. The frames are the contract; SSE is only how v0 carries
them, and an in-page chatbot calls `driver.call()` with no transport at all.

## Frames

All frames are JSON with a `t` discriminator. Unknown fields are ignored (so a field may be added without a version
bump); removing or repurposing one is breaking.

| direction | `t` | carries |
|---|---|---|
| tab → relay | `hello` | `tab` (minted by the tab, so a reconnect resumes identity), `app`, `manifest`, `snapshot`, `title`, `url` |
| tab → relay | `result` | `tab`, `id` (echoed from the call), `result` |
| tab → relay | `snapshot` | `tab`, `snapshot` — the page moved on its own, because a person clicked. Debounced |
| relay → tab | `call` | `id`, `name`, `args`, optional `rev` |
| relay → tab | `ping` | nothing: a comment line every 20 s, to stop proxies closing an idle stream |

**Every tab→relay frame carries `tab`** (`POST /dk/result` has no path parameter, and a `result` is correlated only
by `id`). `?tab=` on the URL is also accepted.

**The frames sit on the stream as named events**, which is the single most common client bug:

```
: driverkit             ← comment on connect, so `open` fires immediately (hello is sent from `open`)
event: call             ← `onmessage` does NOT fire. addEventListener("call", …)
data: {"t":"call",...}
: ping                  ← a comment, not a frame
```

A client written against `onmessage` alone silently drops every call, and the symptom — a connected tab that never
does anything — looks like a relay bug for a long time.

## The HTTP surface

| | | |
|---|---|---|
| `GET` | `/dk/tabs` | the caller's own connected tabs, as `{"tabs": [...]}`. The id field is `tab`, not `id` |
| `GET` | `/dk/tabs/:tab/manifest` | the static half — **cache this**; `manifestVersion` in the listing says when you may not |
| `GET` | `/dk/tabs/:tab/snapshot` | the last snapshot the tab pushed — for looking before you act |
| `GET` | `/dk/tabs/:tab/watch` | SSE: `snapshot` frames as they happen |
| `POST` | `/dk/tabs/:tab/call` | `{name, args?, rev?}` → a `WireResult` |
| `GET` | `/dk/events?tab=` | the stream the tab holds open (never touched by an agent) |
| `POST` | `/dk/result` | the tab returning a result or pushing a snapshot |

`/snapshot` serves what it has, not what is true now: there is no frame that asks a tab for a fresh read, because
**the authoritative snapshot is the one that comes back on a `Result`.** An agent following a screen it is not
driving holds `/watch` open instead of polling. `/watch` sends the current snapshot immediately, survives the tab
reloading (watchers live outside the tab's registry record), forwards an explicit push even at an unchanged `rev`,
broadcasts a snapshot riding on a `Result` deduped on `rev`, and 404s for an unknown tab rather than holding a
stream open for a screen that does not exist.

## Status codes — the body is authoritative, the status is a hint

A refusal is an ordinary outcome, so it arrives as `200` with `ok: false`. **A non-2xx means no `WireResult` was
produced at all** — a transport failure, an exception, not a refusal. Relays must not use 4xx to mean "the app said
no": one is retry-elsewhere, the other is rephrase-and-retry.

| case | answer |
|---|---|
| anything the tab answered, refusal included | `200` `WireResult` |
| relay refusal (`no-such-tab`, `tab-went-away`, `timeout`) | `200` `WireResult`, **no `snapshot`** |
| missing/unparseable `name` | `400 bad-request` · body over 1 MiB → `413 too-large` |
| tab connected but no `hello` yet | `404 no-manifest` / `no-snapshot` (never an empty verb list) |
| auth on, no credential | `401 no-credential` + `WWW-Authenticate: Bearer` |
| a credential that does not verify, **for any reason** | `401 bad-credential`, one slug for all of them |
| a tab another principal owns | identical to an absent tab, everywhere |
| `POST /dk/result` accepted | `202 {"ok":true}` · unplaceable frame `400` · tab not connected `409` |

`400` means the frame could never have been accepted by anyone; `409` means the frame was fine and the relay's state
made it unacceptable — a tab may reasonably reconnect and retry a `409`, while a `400` is a bug. Identity is
resolved **before** routing, so an unidentified caller gets `401` and never a `404` or `405` that would map the
surface. Body limit is 1 MiB and over it is `413`; a snapshot near it is a bug in `visible()`.

A relay must read the whole request body — **including a chunked one, and even when it is going to refuse the
request**. Unread bytes stay in the socket and *become* the next request on a keep-alive connection (the symptom is
`Parse Error: Expected HTTP/…` on a connection that was healthy a moment ago). Undecodable framing is a `400` **and
the connection closes**, because there is no position at which to start reading the next request.

## Reserved refusals, and the three that mean "unknown"

Reserved: `stale`, `unknown-verb`, `bad-argument`, `unmounted`, `threw` (the core), `no-such-tab`,
`tab-went-away`, `timeout` (the relay), `declined-by-user` (a confirmation gate). An app may not name a verb or its
own refusal any of these: an agent must be able to tell "your app said no, phrase it differently" from "your call
never landed, reconnect or pick another tab", and if `timeout` can mean either it can tell neither. `mount()`
throws on a reserved verb name or a reserved declared refusal; a reserved slug returned at runtime is reported as
`threw`, with a warning, because that is the app's own bug.

Missing `snapshot` is the signal that a relay refusal is not an app refusal — a client must read its absence as
"the call did not arrive", never as "the screen is empty".

**Only `no-such-tab` proves the call did not happen.** `timeout` (the tab accepted and went quiet) and
`tab-went-away` (the stream closed after acceptance) are *unknown*: the verb may well have run. So a `commit` that
comes back either way has an **unknown outcome** and the agent must read the screen before retrying. The natural
reflex — treat a non-answer as a failed step and retry — is the one move that turns one bulk accept into two.

The relay's deadline (15 s by default) is a property of the relay, not the protocol. There is **no queue**: a call
reaches a connected tab or is refused immediately, because durability would mean a call landing minutes later
against a screen nobody is looking at.

`hello` **upserts** field by field: a reconnecting tab may have navigated, and replacing wholesale would drop a
manifest the relay already had. There is a real window where a tab is listed with no app and no manifest — the
stream opens first and `hello` lands a moment later on a separate POST.

## Deliberately absent

No screenshots. No selectors or DOM paths. No model, no prompt, no API key — the protocol moves bytes. No queue.
