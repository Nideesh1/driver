# Auth: which person, never what they may do

**The relay grants no authority.** It forwards a verb name to a tab that is already logged in as a person, and that
tab's own session is what the app checks. An agent driving through driverkit can do exactly what the human whose tab
it is could do, and nothing more — no service account, no token with its own permissions, nothing to over-scope.

Everything here is about proving **which** person, so the relay can keep a hundred people's tabs apart. That is why
the mechanism is this small.

The flip side is a real limit: **a relay someone else can reach is that person driving your logged-in session.** So
two separate guards — the peer check, and the credential.

## Nothing to do on a loopback dev relay

`Relay()` with no `auth=` and no `resolve_principal=` has auth **off**: non-loopback peers are refused per request
(not at bind time — an embedded relay does not own the socket), and every request resolves to one principal. That
is the one-developer case and it needs no setup. `connect(driver, { relay: "" })` with no `token` is correct there.

**`allow_remote=True` without `auth=` or `resolve_principal=` raises in the constructor.** A relay that serves
strangers and cannot tell them apart offers every connected tab to every one of them. Publishing a relay takes three
deliberate acts: a non-loopback host, remote access on, and a statement of how callers are identified.

## Every tab belongs to a principal

A **principal** is an opaque string naming one person — a user id the app chooses, or a derived anonymous id. The
registry is keyed on **`(principal, tab id)`**, which makes isolation structural rather than a check each endpoint
must remember:

- `GET /dk/tabs` lists **only the caller's own tabs**. A cross-principal listing is an inventory of other people's
  sessions with titles and URLs attached.
- Another principal's tab is **indistinguishable from one that never existed** — same status, same slug, same hint,
  on `/manifest`, `/snapshot`, `/watch` and `/call`. Anything else is an existence oracle over tab ids.
- Two principals that mint the same tab id have **two tabs**. No collision, so no refusal that tells a prober which
  ids are taken.

## The credential: a signed tab token

```
dkt1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "dkt1." + payload))>
```

The app's backend mints; the relay verifies and reads the principal out. Stateless, no callback, no user database —
and an HMAC key can only *verify*, so it mints nothing the relay could act with. (Delegated introspection — the
relay asking the app `whoami` with the browser's cookie — was rejected because the relay would then hold, for a
hundred users at once, something it could use to do anything any of them could do.)

**The algorithm is the prefix, not a payload field**, which removes the whole `alg: none` and HMAC/RSA-confusion
family: a credential starts with `dkt1.` and is HMAC-SHA256, or it is not a credential. Claims: `sub` (the
principal — an opaque id, not an email or a display name), `aud` (which relay, checked exactly), `iat`, `exp`,
`kid`, and optional `tab`. HMAC-SHA256, constant-time compare, key ≥ 32 bytes, clock skew ±60 s (not five minutes:
skew extends every token's lifetime).

### What the app's backend must implement — three things, none involving the relay

```python
from driverkit import TabAuth

auth = TabAuth(secret=os.environ["DK_SECRET"],      # ≥32 bytes, or keys={kid: secret} for rotation
               audience="dispatch-prod",            # names THIS deployment, so a staging token is not a prod token
               ttl_s=120,                           # short: a stateless token cannot be revoked
               anonymous=False,                     # every user is logged in → an anon credential is somebody probing
               require_tab_binding=False)

@app.get("/api/dk-token")                           # behind the app's existing session check. The ONLY new route.
def dk_token(tab: str | None = None):
    return {"token": auth.mint(current_user.id, tab=tab)}
```

1. **A token endpoint**, behind the session check, with the tab id bound in if the page can supply one.
2. **The same key and audience as the relay** (`Relay(auth=TabAuth(...))`, or `driverkit-relay --secret --audience`,
   env `DK_SECRET` / `DK_AUDIENCE` — an argument is visible in `ps`).
3. **A credential for the agent**: same minter, same `sub`, bound to a tab where the agent drives one. A token with
   a `tab` claim narrows a client to that one tab; everything else refuses as `no-such-tab`.

### The page passes a getter, not a string

```ts
connect(driver, { relay: "", token: () => fetch("/api/dk-token").then(r => r.json()).then(j => j.token) });
```

The credential authenticates the **stream open**, and the binding it makes lasts as long as the stream, not as long
as the token — a relay must never hang up a connected tab because its token expired. What *does* need a live
credential is `POST /dk/result`, a separate request. So the symptom of mid-session expiry is precise: a tab that
still receives `call` frames and cannot answer them, and an agent waiting out the relay's full deadline for an
answer that already exists. The getter is the whole handling: called before every `hello` (so before every
reconnect) and again on a 401 from `/dk/result`, which re-sends the same bytes, once.

### Where the credential travels

`Authorization: Bearer` (agents, MCP, any HTTP client) → `X-DK-Token` (when the host app owns `Authorization`) →
the `dk_token` cookie, `__Host-` prefixed (**the best option a page has**: `EventSource` cannot set a header, and
the app sets the cookie so no token appears in any URL) → `?dk_token=` (last resort, cross-origin `EventSource`:
**a query parameter ends up in every reverse proxy's access log**). `connect`'s `tokenIn` defaults to `"query"`
because that works cross-origin; pass `"cookie"` when you can.

### Binding `tab` is cheap, and is not the defence

Both cases assume a stolen token. **Unbound:** the thief cannot read or drive the victim's tabs; they can register a
tab *they* control under the victim's principal, which the victim's agent may then drive — typing the victim's data
onto the attacker's screen. An extra tab, the real ones untouched. **Bound to tab T:** the thief can instead open a
stream for T, and a second stream for a known `(principal, tab)` is a reconnect, which *supersedes* — a takeover of
the exact tab the agent is driving. So bind where it is cheap (always, for an agent: it knows its tab id, and it
never opens a tab stream), and rely on the token not leaking: the cookie, and a short lifetime.

### Rotation is additive and ordered

Add the new key to the relay's `keys` and deploy → point the minter at it (`active_kid`) and deploy → drop the old
key once `ttl_s + skew_s` has passed. A key the relay does not know yet refuses every token signed with it; a key
dropped early logs everybody out at once. An unknown `kid` is a refusal and never a fallback to trying every key.

## Anonymous visitors are first-class, and not one bucket

An unauthenticated visitor still gets a widget and still drives their own screen. `connect(driver, { anonymous:
true })` mints `anon1.<32 random bytes>` into `sessionStorage` beside the tab id; the relay derives
`anon:<sha256("driverkit-anon-v1." + secret)[:16]>`. Keyless, so a key rotation or relay restart does not change a
visitor's identity. Two visitors have independent secrets, so **A cannot list, read or drive B's screen** — which
is the whole requirement.

It is **not** an identity: whoever holds the string is that principal, it dies with the tab by design, and it
confers nothing at the app. `anonymous` is **off by default** in `connect` on purpose — on, a page whose author
forgot to wire `token` would quietly work, every user becoming their own stranger while their agent (with a real
token) saw zero tabs. A relay serving real users should set `anonymous=False`.

**No credential and a bad credential are different answers, and neither is "anonymous."**

## The embedded door

A relay inside the app's own server has already resolved the session, so it needs none of the above:
`Relay(resolve_principal=lambda headers: session_user_id(headers))`, consulted first, with `None` falling through to
`auth=` — so one relay serves logged-in users from the app's own session and anonymous visitors from a minted
credential. Making an app mint a token to tell itself who its own user is would be a process calling itself.

## Failure modes, so they are recognisable

| symptom | cause |
|---|---|
| `401 bad-credential` everywhere, no tabs listed | wrong audience, or a key the relay does not have |
| the page retries its stream behind backoff | the token endpoint is missing or 500ing |
| every token refused as though forged | a clock more than ±60 s out |
| every connected tab suddenly cannot answer | a key rotated faster than `ttl + skew` |
| tabs appear and then vanish from an agent's listing | the agent and the page resolve to different principals |
| nothing visibly wrong, strangers can drive | impossible by construction: `allow_remote` + no auth refuses to start |

Every credential failure answers the same `401 bad-credential` — expired, wrong audience, unknown key, tampered,
not-a-token. The distinctions a caller might want are the ones an attacker wants, and a legitimate client's move is
the same in every case: mint a fresh token and retry once.

## What this does not do

No revocation inside a token's lifetime (the lifetime is the bound — keep it short). A short lifetime bounds when a
stolen token can be *used*, not how long the damage lasts: the stream binding outlives the token, so a token leaked
for a minute buys a stream that can be held for hours. Isolation is not authorisation — the relay still has no
opinion about a verb, and the **commit gate**, not anything here, is what stands between an agent and a thousand
accepted rows. Two tabs of one person are separated by bookkeeping, not cryptography. Anonymous isolation is only
as good as `sessionStorage` (an XSS on the origin is that visitor — one more argument for the cookie).

**None of this has run in a real multi-user deployment.** It is unit-tested on both sides and it is the part to
review hardest before exposing a relay.
