# The driverkit wire protocol

This is the contract between three parties. Everything else in the repository
is an implementation of one side of it, and anyone can write another.

```
   agent                relay                   browser tab
 (any language)   (any language)            (driverkit/core)
      │                  │                          │
      │                  │◀──── GET /dk/events ─────┤   opens on page load,
      │                  │      (SSE, stays open)   │   stays open
      │                  │                          │
      ├── POST /call ───▶│                          │
      │                  ├──── event: call ────────▶│
      │                  │                   driver.call(...)
      │                  │◀──── POST /dk/result ────┤
      │◀─── the Result ──┤                          │
```

## Why a tab must dial out

Nothing can call *into* a browser tab. There is no address for it, no port, no
way to reach a function inside a page from another process. The tab has to
open the connection itself and hold it, which is why the relay exists at all:
it is the one place both parties *can* reach.

## Why SSE and not WebSocket

Server-Sent Events are plain chunked HTTP: one long-lived `GET` whose body
never ends, carrying `data:` lines. A WebSocket needs an `Upgrade` handshake,
a base64 SHA-1 key exchange, and a binary framing layer with masking and
continuation frames.

Three reasons that difference decided it:

1. **The relay belongs in a server you already run.** SSE there is "write a
   line, flush" — any HTTP library in any language can do it. A WebSocket server is a dependency and a protocol implementation.
2. **The browser side needs no library either.** `EventSource` is built in, and
   so is `fetch` for the return path.
3. **Traffic is asymmetric and tiny.** A call is a few hundred bytes and a
   human-driven session makes a handful per minute. The thing WebSockets buy —
   cheap high-frequency bidirectional frames — is not a thing this needs.

The cost is one HTTP POST per result instead of a frame on an open socket.
That is the right trade at this volume, and it buys an implementation that
fits in any language without a library.

## Transport is replaceable

The frames below are the contract; SSE is merely how v0 carries them. An
in-page chatbot calls `driver.call()` directly and uses no transport at all,
and the core package has no idea either exists. If a future case genuinely
needs WebSocket framing, it swaps in under the same frames.

## Frames

All frames are JSON objects with a `t` discriminator. Unknown fields are
ignored, so a field may be added without a version bump; removing or
repurposing one is breaking.

### Tab → relay

**`hello`** — sent once, immediately on connecting.

```json
{ "t": "hello", "tab": "7f3a-...", "app": "Contacts",
  "manifest": { "version": "a3f2...", "app": "Contacts", "verbs": [...] },
  "snapshot": { "where": "contacts", "screen": "contacts", "rev": 7, "rows": [...] },
  "title": "Contacts — Acme", "url": "/contacts?company=Acme" }
```

The `tab` id is minted by the tab, not the relay, so a reconnect can resume the
same identity. `title` and `url` exist only so a human can tell two tabs apart
when asked "which one?".

The manifest is the static half and carries three optional fields a relay only
forwards, all of them cacheable for the life of the app:

- `instructions` — the app's own briefing, in its own words ("this app has
  screens: dashboard, contacts, companies, settings — `go` reaches those"). It
  belongs here because it never changes, and because the alternative was an app
  repeating itself in every snapshot's `note`, in the half that is paid for on
  every turn. An MCP server puts it in its server instructions; an in-page loop
  folds it into the cached system prompt.
- `verbs[].screen` — the screen that verb belongs to, **or an array of the
  screens it belongs to**; absent for "anywhere".
  **The tool list must not vary with the live screen**: a verb list that changed
  on every navigation would bust the prompt prefix every time the person moved,
  which is the cost argument the whole protocol is built on. So every verb is
  offered on every screen, the mapping is declared once in the cached half, and
  the core refuses a call made off a verb's screens as `wrong-screen` with the
  live screen and all of the verb's own named in the hint.

  The array exists for a verb that genuinely lives on two screens, and it was
  added because one string made the worked example lie: `next-page` pages both
  the contacts list and a company's contact list, so declaring either screen
  would refuse a paging call on a screen that is still publishing a `page`
  block. Faced with that, an app invents a refusal slug of its own, which is
  the pattern `wrong-screen` was reserved to end.

  A client must read both shapes. The shape the app declared is the shape that
  is sent — a string stays a string, and a relay must not normalise it: the
  manifest's bytes are what `version` fingerprints, so normalising would move
  the version of every app that names one screen. `screen: []` is not valid and
  is refused where the app mounts: it says the verb works nowhere, which is an
  authoring mistake rather than a way to say "anywhere".
- `verbs[].reversible` — `true` on a `commit` the app can undo. Absent makes no
  claim, like `kind`. It exists because changing a page size and accepting three
  thousand contacts were both `commit`, so both were shouted about and both
  stopped to ask a person — and a confirmation dialog on a page-size change is
  how people learn to click Yes without reading.

**`result`** — the answer to exactly one `call`.

```json
{ "t": "result", "tab": "7f3a-...", "id": "c-17",
  "result": { "ok": true, "snapshot": {...} } }
```

**`snapshot`** — the page moved on its own, because a person clicked something.

```json
{ "t": "snapshot", "tab": "7f3a-...",
  "snapshot": { "where": "contact c-8821", "screen": "contact", "rev": 8, ... } }
```

`snapshot.screen` is optional and is a stable, kebab-case screen id beside
`where`. `where` is prose for a human and carries the filter, the sort and, on
a drill-down, a description of the record — so it moves constantly for reasons
that are not navigation, and "did I navigate?" cannot be answered by diffing
it. `screen` can be compared with string equality, and that is its whole job.
Which screen is live is dynamic and belongs here; the *names* of an app's
screens and which verb belongs to which are static and belong in the manifest.
A tab that does not describe its screens omits it, and that is not a claim that
it has one. See `Snapshot.screen`.

**Every tab→relay frame carries `tab`.** `POST /dk/result` has no path parameter
and the relay serves many tabs at once, so without it the relay cannot tell who
is answering — and because a `result` is correlated only by `id`, two tabs with
a call in flight cannot be told apart at all. A relay should also accept
`?tab=` on the URL, and a tab may send both.

Sent on a debounce, not on every keystroke. An agent that is mid-task learns
the human moved and can re-read rather than acting on a dead `rev`. This frame
is what makes the shared-presence case work: both parties watching one screen.

### Relay → tab

**`call`** — run a verb.

```json
{ "t": "call", "id": "c-17", "name": "select-where",
  "args": { "where": "company=Acme" }, "rev": 7, "screen": "contacts" }
```

`id` is echoed back in the `result`. `rev` is optional and is the agent's claim
about what it was looking at; the core refuses the call as `stale` when it no
longer matches. See `CallOptions.rev`.

`screen` is optional and is the agent's claim about WHICH SCREEN it was looking
at: the `snapshot.screen` it last read. The core checks it **before** `rev` and
refuses the call as `wrong-screen`, naming the screen the caller believed it was
on and the one the app is actually on. The two checks catch different mistakes
and have different fixes — navigate back, versus read again — which is why they
are two fields and two slugs rather than more prose on `stale`. A paging call
sent with neither lands on whatever screen is there when it arrives, pages a
list the agent never saw, and answers `ok`.

A relay forwards both untouched and compares neither. It does not know which
screen a tab is on, and a relay that decided would be a second set of rules
beside the core's. An empty `screen` string is dropped rather than forwarded: it
is not the id of any screen, and no app should be asked to refuse a call over a
field a caller left blank. See `CallOptions.screen`.

**`ping`** — a comment line, every 20s, to keep proxies from closing an idle
stream. Carries nothing.

### How the frames sit on the SSE stream

Stating this because a client written against `onmessage` alone silently drops
every call, and the symptom — a connected tab that never does anything — looks
like a relay bug for a long time.

```
: driverkit                 ← comment, sent immediately on connect

event: call                 ← named event. `onmessage` does NOT fire for this;
data: {"t":"call",...}         listen with addEventListener("call", ...)

: ping                      ← comment, not a frame. No event fires.
```

The opening `: driverkit` comment exists so the browser fires `open` right
away rather than on the first real frame. `hello` is sent from `open`, so
without it a loaded tab sits in the registry unidentifiable until somebody
tries to drive it.

## The HTTP surface the agent uses

| method | path | does |
|---|---|---|
| `GET` | `/dk/tabs` | list connected tabs |
| `GET` | `/dk/tabs/:tab/manifest` | the static half — cache this |
| `GET` | `/dk/tabs/:tab/snapshot` | the last snapshot the tab pushed |
| `GET` | `/dk/tabs/:tab/watch` | SSE: `snapshot` frames as they happen |
| `POST` | `/dk/tabs/:tab/call` | `{name, args?, rev?, screen?}` → a `WireResult` |

And the two the tab uses, which an agent never touches:

| method | path | does |
|---|---|---|
| `GET` | `/dk/events?tab=:tab` | the SSE stream the tab holds open |
| `POST` | `/dk/result` | the tab returning a `result` or pushing a `snapshot` |

### `GET /dk/tabs`

```json
{ "tabs": [
  { "tab": "7f3a-...", "app": "Contacts", "title": "Contacts — Acme",
    "url": "/contacts?company=Acme", "manifestVersion": "a3f2c1d40e9b",
    "rev": 7, "since": "2026-11-25T18:04:11Z" }
] }
```

Envelope, not a bare array, so a later field can be added beside `tabs`
without breaking a parser. The id field is `tab`, spelled the same as in the
`hello` frame — one name for one thing. `manifestVersion` is lifted out so a
client can tell whether its cached manifest is current without fetching the
whole thing, which is the entire point of the version existing.

### `GET /dk/tabs/:tab/snapshot` serves what it has, not what is true now

There is no relay→tab frame that asks for a fresh read, so the relay can only
serve the most recent snapshot the tab volunteered — on `hello`, on a push, or
riding on a `Result`. That is a deliberate choice, not an omission: a
round-trip read frame would double the latency of the common path to keep a
promise agents do not need, because **the authoritative snapshot is the one
that comes back on a `Result`.** Acting returns the truth; this endpoint is for
looking before you act.

An agent that needs to follow a screen it is not driving should hold
`/watch` open instead of polling here.

### `GET /dk/tabs/:tab/watch`

An agent cannot subscribe through a request/response surface, so without this
the `snapshot` push frame reaches the relay and stops there — and the
shared-presence case the frame exists for is unreachable. This is the agent's
end of it: the same SSE shape the tab uses, carrying `snapshot` frames and the
same 20s ping comments.

Polling `/snapshot` is the lower-effort alternative and is fine for a scripted
client that acts and stops. It is not fine for an agent sitting beside a human,
which would have to poll fast to feel live and then pay for every poll.

### Every status, so two relays agree

The rule below settles `/call` and nothing else, which left every error path a
coin flip. Two conforming relays disagreeing on these is worse than either
choice, so they are pinned:

| endpoint | case | status | body |
|---|---|---|---|
| `POST /dk/tabs/:tab/call` | anything the tab answered, refusal included | `200` | `WireResult` |
| | relay refusal (`no-such-tab`, `tab-went-away`, `timeout`) | `200` | `WireResult`, no `snapshot` |
| | missing or unparseable `name` | `400` | `{"error":"bad-request"}` |
| | body over the size limit | `413` | `{"error":"too-large"}` |
| `GET /dk/tabs/:tab/manifest` | tab connected but no `hello` yet | `404` | `{"error":"no-manifest"}` |
| `GET /dk/tabs/:tab/snapshot` | same | `404` | `{"error":"no-snapshot"}` |
| `GET /dk/tabs/:tab/watch` | unknown tab | `404` | `{"error":"no-such-tab"}` |
| `POST /dk/result` | accepted | `202` | `{"ok":true}` |
| | frame names no tab, by field or `?tab=` | `400` | `{"error":"unplaceable"}` |
| | `result` present but not an object | `400` | `{"error":"bad-frame"}` |
| | unknown frame `t` | `400` | `{"error":"bad-frame"}` |
| | names a tab that is not connected | `409` | `{"error":"no-such-tab"}` |
| `GET /dk/events` | no `?tab=` | `400` | `{"error":"bad-request"}` |
| any `/dk/*` | no such route | `404` | `{"error":"no-route"}` |
| | wrong method on a real route | `405` | `{"error":"bad-method"}` |
| any | non-loopback peer without remote access on | `403` | `{"error":"forbidden"}` |
| any `/dk/*` | auth configured, no credential presented | `401` | `{"error":"no-credential"}`, `WWW-Authenticate: Bearer` |
| | a credential that does not verify, **for any reason** | `401` | `{"error":"bad-credential"}` |
| | a credential bound to another tab, on `/dk/events` | `403` | `{"error":"forbidden"}` |
| `GET /dk/tabs` | always | `200` | **only the caller's own tabs** |
| `GET /dk/tabs/:tab/manifest` | a tab another principal owns | `404` | `{"error":"no-such-tab"}` — identical to an absent tab |
| `GET /dk/tabs/:tab/snapshot` | same | `404` | same |
| `GET /dk/tabs/:tab/watch` | same | `404` | same |
| `POST /dk/tabs/:tab/call` | same | `200` | `WireResult`, `refused: "no-such-tab"`, no `snapshot` |
| `POST /dk/result` | same | `409` | `{"error":"no-such-tab"}` |
| any `POST` | body sent `Transfer-Encoding: chunked` | as if it had a length | the limits below apply to the **decoded** size |
| | body framing that cannot be decoded | `400` | `{"error":"bad-request"}`, **and the connection closes** |

**One slug for every credential failure.** Expired, wrong audience, unknown
key, tampered signature and "not a token at all" all answer
`401 bad-credential` with the same hint. The distinctions a caller might want
are the distinctions an attacker wants — "the signature verified but the
audience was wrong" tells a forger the forgery worked — and a legitimate
client's move is the same in every case: mint a fresh token and retry once. The
reason is not logged either; it would be a log line about a credential.

**`401` against `403`.** A `401` says "present a different credential and this
will work"; the `403` the peer check answers says "nothing you can present will
help". An agent that cannot tell them apart either retries a hopeless request or
gives up on a fixable one.

**A bad credential on `/call` is a `401`, not a `WireResult`** — by the rule
above, a non-2xx means no `WireResult` was produced at all, and nothing was
asked of any tab. A *valid* credential for someone else's tab is the other case
and is a `200 WireResult` refused `no-such-tab`, because that one must be
indistinguishable from a tab that does not exist.

**Identity is resolved before routing.** An unidentified caller gets `401` and
nothing else — not a `405` for the wrong method, not a `404` for an unknown
path. Authenticating after routing lets a caller you will not serve map the
surface anyway.

The `400` / `409` split is the distinction worth keeping: **`400` means the
frame could never have been accepted by anyone; `409` means the frame was fine
and the relay's state is what made it unacceptable.** A tab that gets `409` may
reasonably reconnect and retry. A tab that gets `400` has a bug.

### A relay must read the whole request body, including a chunked one

The last two rows were missing and the gap cost real debugging time, so they
are spelled out.

**A chunked body is an ordinary body.** Nothing here says a client must count
its bytes before sending them, and plenty of clients do not: `fetch` with a
stream, `curl -T`, and Node's own `http.request` whenever `content-length` is
not set by hand. A relay that reads `Content-Length` and nothing else sees
**zero bytes** from every one of them, and then answers a question nobody
asked — most visibly a `400` for a `/call` with no `name`, which is a
bad-request answer to a perfectly good request. Frameworks hide this: an ASGI
or WSGI server de-chunks before the application sees a byte. A relay built
straight onto a bare HTTP server does not get that for free and must decode the
framing itself. The size limit is checked on the decoded total, which can only
be known partway through a body already in flight; the `413` rules below are
otherwise unchanged.

**An unread body is worse than a wrong answer.** On a keep-alive connection the
bytes a relay failed to read are still in the socket when the next request is
parsed off it, so they *become* that request. The symptom is
`Parse Error: Expected HTTP/, RTSP/ or ICE/` on a connection that was healthy a
moment earlier, and it survives the request that caused it: one wrong answer,
then every later request on that socket destroyed. So a relay reads the body
**even when it is going to refuse the request** — a `405` for the wrong method
and a `404` for an unknown route both still drain it. "We are rejecting this
anyway" is exactly the reasoning that breaks the next request.

**Undecodable framing is a `400` and the connection goes.** It is a `400` by
the rule above: framing this broken is a request no relay could ever have
accepted. The connection closing is not a detail — every byte after the point
the framing stopped making sense is of unknown purpose, so there is no position
at which to begin reading the next request, and a keep-alive socket whose next
boundary is unknown can only produce nonsense. Making the sender reconnect is
the only honest option. The same holds for a `Content-Length` that is not a
number.

A relay must never answer `/call` with a body that is not a `WireResult` — not
even for a malformed frame from the tab. That is the one promise the endpoint
makes, and a client that has to handle `undefined` as a third shape will handle
it badly.

**Body size limit**: 1 MiB, and over it is `413`. A snapshot approaching that
size is a bug in the app's `visible()`, not a limit to raise — the whole design
says an agent sees a screenful.

### `/watch` semantics

Pinned, because these were a sketch and the dedup asymmetry is a real judgement
call nobody would guess:

- **A new watcher is sent the current snapshot immediately.** Otherwise a
  watcher attaching to an idle screen knows nothing until the next click and
  must fetch `/snapshot` anyway — the poll `/watch` exists to remove.
- **A watcher survives the tab reloading.** Watchers are keyed by tab id and
  live outside the tab's registry record, because that reload is one of the
  things being watched for. A watcher dying with the tab would defeat the point.
- **An explicit `snapshot` push is always forwarded**, even at an unchanged
  `rev`. The tab is asserting the page moved; second-guessing it would make the
  relay the judge of what counts as a change, which is the app's call and is
  what `rev` carries.
- **A snapshot riding on a `Result` is broadcast too, deduped on `rev`.** A
  narrow reading would forward only the tab's own pushes, but then a second
  watcher goes blind to the first agent's changes and has to poll for them.
- `/watch` on an unknown tab is a `404`, not a stream held open. The cost is
  that an agent cannot subscribe before a tab connects; it should read
  `/dk/tabs` instead of waiting on a subscription to a screen that does not
  exist.

### `hello` upserts, it does not replace

A reconnecting tab may have navigated, so a later `hello` wins field by field
and absent fields leave the stored value alone. Replacing wholesale would drop
a manifest the relay already had and make `/manifest` 404 on a tab that is
plainly connected. Everything but `tab` is optional, which means there is a
real window where a tab is listed with no app and no manifest — the stream
opens first and `hello` lands a moment later on a separate POST. `/manifest`
404s in that window rather than serving an empty verb list, which would be a
false claim that the app has no verbs.

### Status codes

**The body is authoritative; the status is a hint.** A refusal is an ordinary
outcome, so it arrives as `200` with `ok: false`. Clients must not infer the
outcome from the status, and relays must not use `4xx` to mean "the app said
no" — that conflates a transport failure with a business rule, and they want
opposite handling: one is retry-elsewhere, the other is rephrase-and-retry.

A non-2xx status means the request never produced a `WireResult` at all
(malformed JSON, unroutable path, relay broken). A client should treat that as
a transport failure — an exception, not a refusal.

### When a call never reaches a tab

The relay answers with a `WireResult` whose `snapshot` is **absent** and whose
`refused` is one of a closed set:

| slug | means |
|---|---|
| `no-such-tab` | no tab with that id is connected |
| `tab-went-away` | the stream closed between accepting the call and answering |
| `timeout` | the tab accepted the call and did not answer within the deadline |

These three slugs, plus `stale`, `wrong-screen`, `unknown-verb`,
`bad-argument`, `unmounted` and `threw` from the core, and `declined-by-user`
from a confirmation gate, are **reserved**. (`wrong-screen` is the core's answer
to a call aimed at a screen the app is not on — either because the verb declared
a `screen` of its own and the live one is something else, or because the call
carried a `screen` that no longer matches. It was an app's invention before it
was the core's: an app with six screens had to write the check by hand and name
it, the next one would have picked `not-on-this-screen`, and an agent that had
learned one would not have recognised the other. It says where a call stopped,
not what an app decided, so it is reserved like the rest.) (`declined-by-user` is not a transport outcome at all — it is a
person saying no to a `commit` before it ran. It is a refusal rather than an
error on purpose, so the loop that drives the app treats it as an answer to
adapt to, and never as a failure to retry.) An app must not name one of its
own verb refusals the same thing: an agent needs to tell "your app said no,
phrase it differently" from "your call never landed, reconnect or pick another
tab", and if `timeout` can mean either, it can tell neither.

A tab whose JavaScript has died is a third state the "no queue" rule does not
cover — its stream is open, so the call is accepted, and no answer ever comes.
That is what the deadline is for. A relay should also fail calls already in
flight immediately when a stream closes, rather than letting each one sit out
its own deadline.

The deadline is the relay's, defaults to 15 seconds, and is a property of the
relay rather than the protocol.

**Only `no-such-tab` proves the call did not happen.** It was never forwarded,
because there was nowhere to forward it. The other two are *unknown*:

- `timeout` — the tab accepted the call and went quiet. It may well have run
  the verb and failed to answer.
- `tab-went-away` — the stream closed after the call was accepted. The verb may
  have run and the answer died with the stream.

So a `commit` verb that comes back either way has an **unknown outcome**, and
an agent must read the screen before retrying rather than assuming failure.
This is spelled out because the natural reflex — treat a non-answer as a
failed step and retry it — is the one move that turns one bulk accept into two.

Missing `snapshot` is the signal to distinguish these from an app's own
refusal. See `WireResult` and `RelayRefusal` in `packages/core/src/types.ts`.

## Who is allowed to do this

**The relay grants no authority.** It forwards a verb name to a tab that is
already logged in as a person, and that tab's own session is what the app
checks. An agent driving through driverkit can do exactly what the human whose
tab it is could do, and nothing more — there is no service account, no token
with its own permissions, nothing to over-scope.

**Everything in this section is about proving *which* person, never about
granting power.** That distinction is why the mechanism can be this small: it
decides which hundredth of the relay's registry a caller may see, and the app's
own session decides what they may do with it. The property above is what makes
the design simple, and nothing below weakens it.

That property is also a real limit: **a relay reachable by someone else is that
person driving your logged-in session.** Two things follow, and they are
separate: the relay must refuse callers it cannot place (the peer check), and
it must be able to tell the ones it serves apart (the credential).

### Check the peer on every request, not the interface at bind time

The deployment this document recommends is a relay embedded in a server you
already run, and an embedded relay does not own the listening socket. It cannot
choose an interface, so "bind to loopback" is advice it is unable to follow,
and taken as the whole story it leaves a relay inside a public app server with
no guard at all. So reject a non-loopback peer per request unless remote access
was explicitly turned on.

**Remote access without a way to identify callers must not be reachable.** It
used to be one flag that reads like a convenience, and one flag is what people
set to reach a dev server from a phone. A relay that serves non-loopback
callers and cannot tell them apart offers every connected tab to every one of
them, so a conforming relay **refuses to start** in that configuration rather
than serving it. Three deliberate acts to publish a relay: a non-loopback host,
remote access on, and a statement of how callers are identified.

A tab id is a capability. Do not log it anywhere a tab id becomes a password.

### Every tab belongs to a principal

A **principal** is an opaque string naming one person: a user id the app
chooses, or an anonymous visitor's derived id. The relay keys its registry on
**`(principal, tab id)`** rather than on the tab id alone, which makes the
isolation structural instead of a check each endpoint has to remember:

- `GET /dk/tabs` lists **only the caller's own tabs.** A cross-principal listing
  is an inventory of other people's sessions with their titles and URLs
  attached, and it must not exist.
- A tab belonging to another principal is **indistinguishable from one that was
  never minted** — same status, same slug, same hint, on `/manifest`,
  `/snapshot`, `/watch` and `/call`. A different refusal would make the
  endpoint an existence oracle over tab ids, which is how an attacker finds a
  session to attack.
- Two principals that mint the same tab id have **two tabs**. Neither sees the
  other and neither stream supersedes the other. There is no collision to
  refuse, and so no refusal that would tell a prober which ids are taken.
- `POST /dk/result` is accepted only from the principal that owns the tab the
  frame names, and a `result` settles a call only if that call is pending **on
  that tab**. A tab cannot answer another tab's call, its own person's included.

### The credential: a signed tab token

The relay must learn the principal without becoming an identity provider and
without a user database. **The app's backend mints a short-lived signed token;
the relay verifies it and reads the principal out.** Stateless, no callback, no
round trip, and an HMAC key can only *verify* — it mints nothing the relay could
act with.

The alternative is delegated introspection: the relay asks the app
(`GET /dk/whoami`) with the browser's credentials. It is rejected, and the
reason is not the round trip. To ask, the relay must hold the browser's session
cookie and replay it — so it holds, for a hundred users at once, something it
could use to do anything any of them could do. That is precisely the authority
this design exists not to have. Three smaller costs finish it: the app becomes a
hard dependency of every connect, affording it needs a cache, and a cache of
"who is this browser" is the session store we said we would not need.

```
dkt1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "dkt1." + payload))>
```

**The algorithm is the prefix, not a field in the payload.** A JWT names its
own algorithm in a header the verifier has not authenticated yet, which is the
root of both the `alg: none` family of bugs and the HMAC/RSA confusion family.
Here there is nothing to negotiate: a credential starts with `dkt1.` and is
HMAC-SHA256, or it is not a credential. A future `dkt2` is a new prefix — a
greppable change rather than a field an attacker sets. The prefix is inside the
MAC, so a payload cannot be relabelled into another version.

| claim | required | means |
|---|---|---|
| `sub` | yes | the principal. An opaque id, not an email or a display name |
| `aud` | yes | which relay this token is for, checked exactly |
| `iat` | yes | issued at, Unix seconds. One more than `skew` in the future is refused |
| `exp` | yes | expiry, Unix seconds, honoured with `skew` of slack |
| `kid` | yes | which key signed it. Selects the key; editing it fails the MAC |
| `tab` | no | binds the credential to one tab id |

**HMAC-SHA256**, compared in constant time, with a key of at least 32 bytes.
Nothing here needs public-key signatures: the two parties that matter — the
app's backend and the relay — are run by the same operator, and a symmetric key
keeps both ends free of a crypto library.

**Clock skew: ±60 seconds**, on `exp` and on `iat`. Not five minutes: skew
tolerance is a direct extension of every token's lifetime, so a five-minute
window on a two-minute token would more than treble the time a leaked one stays
useful. Sixty seconds covers two hosts with working NTP, which is the case this
is for.

**Rotation is additive and ordered.** Add the new key to the relay's verify set
and deploy; point the minter at it and deploy; drop the old key once
`ttl + skew` has passed. A key the relay does not know yet refuses every token
signed with it, and a key dropped early logs a hundred people out at once. An
unknown `kid` is a refusal and never a fallback to trying every key — "try them
all" turns a rotation window into a period where every key is live for every
token.

**Binding `tab` into the token is optional, and it is not strictly safer.** The
tab mints its own id (so a reconnect resumes identity), which means the backend
cannot know it at page-render time: binding turns one template variable into a
request the page makes after its JavaScript has chosen an id, repeated on every
reconnect that changes it. That is the cost. The benefit is asymmetric, and both
cases below assume a stolen token, which is the only case either addresses:

- **Unbound.** The thief cannot read or drive the victim's tabs. They can
  register a tab *they* control under the victim's principal. It runs in their
  browser, where their own session is what the app checks, so they gain no
  authority — but the victim's agent now sees a tab that is not the victim's
  and may drive it, typing the victim's data onto the attacker's screen. An
  extra tab; the real ones untouched.
- **Bound to tab T.** The thief cannot do that. What they *can* do is open a
  stream for T — and a second stream for a known `(principal, tab)` is a
  reconnect, which supersedes the first. The victim's page is hung up on and
  the thief's becomes that tab, until the victim's `EventSource` reconnects and
  supersedes back. That is a takeover of the exact tab the agent is already
  driving, which is worse than an extra tab in a list.

So bind where it is cheap, and do not treat the binding as the defence. What
bounds both is the token not leaking: the cookie delivery below rather than the
query parameter, and a short lifetime.

A credential for an **agent** should always be bound. It is free there — the
agent knows its tab id already — and the supersede hazard does not apply,
because an agent never opens a tab stream.

### When a token expires mid-session

This is the case that is usually got wrong, so it is pinned.

**The credential authenticates the *stream open*, and the binding it makes
lasts as long as the stream, not as long as the token.** A relay must not hang
up a connected tab because its token expired. Doing so would disconnect every
tab in a deployment once per token lifetime, mid-verb, while a person watched —
and the fix people reach for, a longer lifetime, is strictly worse, because it
also widens the window a leaked token is useful in. Short tokens plus a binding
that outlives them gives both.

Binding happens at the stream open rather than on `hello`, because the pre-`hello`
window is real and a tab that exists and belongs to nobody is a tab every
principal either can or cannot see, both of which are wrong.

What *does* need a live credential is **`POST /dk/result`**, which is a separate
request. So the symptom of mid-session expiry is precise: a tab that still
receives `call` frames and cannot answer them, and an agent that waits out the
relay's full deadline for an answer that already exists. The page handles it,
and the shape of the handling is the point:

- The page's token option is a **getter, not a string**. A string captured at
  page load is the one shape that cannot survive expiry.
- It is called again before every `hello` — which is before every reconnect.
- A `401` on `POST /dk/result` refreshes the credential and re-sends **the same
  bytes**: the frame was never the problem. Bounded at one retry, because a
  getter producing a credential the relay will not accept is a
  misconfiguration, and a misconfiguration retried in a loop is a page that
  never answers anything.

### Anonymous visitors are first-class, and not one bucket

An unauthenticated visitor still gets a widget and still drives their own
screen. The credential is `anon1.<base64url(32 random bytes)>`, minted by the
page, kept in `sessionStorage` beside the tab id, and resolving to:

```
anon:<sha256("driverkit-anon-v1." + secret)[:16] as hex>
```

Keyless, so the same browser is the same principal across a key rotation and a
relay restart; the keying would buy nothing, since the only party who could
correlate a principal id with a secret already holds the secret. Two visitors
have independent secrets and therefore independent principals, so **visitor A
cannot list, read or drive visitor B's screen** — which is the whole
requirement.

What it is **not**: an identity. It is a bearer capability, and whoever holds
the string is that principal. It does not survive the tab closing, by design. It
confers nothing at the app, which still sees an anonymous browser session. And
it is not a substitute for the app's auth: a relay serving real users should
refuse `anon1` credentials outright, because there an anonymous credential can
only be somebody probing.

**No credential and a bad credential are different answers, and neither is
"anonymous".** Treating an unreadable credential as a fresh anonymous visitor
is the tempting shape and is wrong twice over: a user whose token lapsed would
quietly become a stranger and lose their own tabs, and an agent with a
misconfigured key would be told "you have no tabs" rather than "your key is
wrong". Anonymous is a credential of its own kind, so it is never what the
absence of one means.

### Where the credential travels

`EventSource` cannot set a header, which is the only reason this is a list and
not one header:

1. `Authorization: Bearer` — for an agent, an MCP server, any HTTP client.
2. `X-DK-Token` — when `Authorization` is already spoken for by the app the
   relay is embedded in.
3. The `dk_token` cookie (`__Host-` prefixed or not) — the best option a page
   has in the recommended same-origin deployment: the app sets it and the
   browser attaches it to the stream request, with no token in any URL.
4. `?dk_token=` — last resort, for a cross-origin `EventSource`. **A query
   parameter ends up in every reverse proxy's access log**, which is the one
   place a token must not be. It is accepted because refusing it would leave
   cross-origin pages unable to connect at all; short lifetimes are what make a
   logged one survivable, and a relay must not log it itself.

### The embedded door

A relay inside the app's own server does not need any of the above: the app has
already resolved the session. A conforming relay may take a **host-supplied
function from request headers to a principal id**, consulted before the token
path, with "no answer" falling through — so one relay can serve logged-in users
from the app's own session and anonymous visitors from a minted credential.
Making an app mint a token to tell itself who its own user is would be a
process calling itself over HTTP.

### What the app's backend has to implement

Three things, and none of them involve the relay:

1. **A token endpoint.** `GET /api/dk-token` → `{"token": auth.mint(user.id)}`,
   behind the app's existing session check, with the tab id bound in when the
   page can supply one. It is the only new route.
2. **The same key and audience as the relay.** One secret, from the
   environment, at least 32 bytes. The audience names the deployment, so that a
   secret copied into staging does not make a staging token a production token.
3. **A credential for the agent.** Same minter, same `sub`, bound to a tab
   where the agent drives one.

The operator configures the relay with the key, the audience, whether anonymous
credentials are accepted, and whether the `tab` binding is required.

The failure modes, so they are recognisable: a wrong audience or a stale key is
`401 bad-credential` on every request and no tabs listed; a missing token
endpoint is the page retrying its stream behind backoff; a clock more than the
skew out is every token refused as though forged; and a key rotated faster than
`ttl + skew` is every connected tab unable to answer, all at once. The one
failure that is *not* visible is a relay with auth off and `allow_remote` on,
which is why that combination refuses to start.

### What this mechanism does not do

Listed because a security section that reports itself as complete is the one not
to trust.

- **No revocation inside a token's lifetime.** A stateless token cannot be
  recalled; the lifetime is the only bound, which is why it is short. A
  revocation list would be the state this design exists not to keep.
- **A short lifetime bounds when a stolen token can be *used*, not how long the
  damage lasts.** The binding a stream open creates outlives the token that
  authenticated it — deliberately, because the alternative disconnects every
  tab once per lifetime. So a token leaked for one minute buys an attacker a
  stream they can hold for hours. The proper fix is a relay-minted per-stream
  secret, delivered on the stream and echoed on `POST /dk/result`, which would
  make the credential's reach exactly the stream's lifetime. It is not in this
  version because it adds a frame, and a new frame is a change every hand-written
  page loop has to make.
- **`?dk_token=` is logged by the thing in front of the relay.** A conforming
  relay must not log it, and cannot stop a reverse proxy or an ASGI server's
  access log from doing so. Cross-origin `EventSource` has no other option.
  Prefer the cookie; if you cannot, strip the parameter in the proxy's log
  format.
- **It says nothing about what the agent does with the tab.** Isolation is not
  authorisation, and the relay still has no opinion about a verb. A person's own
  agent driving their own screen destructively is exactly what the design
  permits, and the confirmation gate on a `commit` verb — not anything here — is
  what stands between an agent and a thousand accepted rows.
- **Two tabs of one person are separated by bookkeeping, not by cryptography.**
  An unbound credential names the person, so what stops one of their tabs
  answering another's call is that call ids are unique and the pending map is
  per-tab. That is sound, and it is a weaker kind of statement than the
  cross-person case, which is structural.
- **Anonymous isolation is only as good as `sessionStorage`.** Anything that can
  read a page's `sessionStorage` — an XSS on the origin, an extension with
  access to it — is that anonymous visitor. The same is true of a token the page
  holds in JavaScript, which is one more argument for the cookie.

## What this protocol deliberately does not have

- **No screenshots.** The tab reports rows as text. An image costs roughly
  seven times the tokens and still cannot say what a button will do.
- **No selectors, no DOM paths.** The app names its own verbs. Nothing here
  can break because a class name changed.
- **No model, no prompt, no API key.** The agent decides; this moves bytes.
- **No queue.** A call is forwarded to a connected tab or refused immediately.
  Durability would mean a call landing minutes later against a screen nobody is
  looking at, which is worse than a clean failure.
