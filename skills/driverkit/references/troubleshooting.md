# Troubleshooting

Start with: `driver.manifest()` in the page's console (what the model is told), `driver.snapshot()` (what it sees),
and `curl -s <relay>/dk/tabs` (whether the tab is connected and whose it is).

| Symptom | Cause | Fix |
|---|---|---|
| the tab is listed and nothing ever happens | the page side listens on `onmessage`; `call` is a **named** SSE event | `addEventListener("call", …)` — or use `driverkit/browser`, which does |
| `/manifest` 404s on a tab that is plainly connected | the stream opens before `hello` lands (a separate POST); serving an empty verb list would be a false claim | retry; it is a window of milliseconds |
| `GET /dk/tabs` is empty but a page is open | the agent and the page resolve to different principals, or the page never got a token | same key, same audience, same `sub`; a tab token with a `tab` claim lists only that tab |
| `401 bad-credential` on everything | wrong audience, a key the relay lacks, an expired token, a clock >60 s out — all one slug on purpose | mint fresh; check `DK_AUDIENCE` and the clock |
| the page retries its stream behind backoff | the token endpoint is missing or erroring | `GET /api/dk-token` behind the session check |
| a tab receives calls but cannot answer them; agents wait out the full deadline | its token expired mid-session and `token` was a captured **string** | pass a **getter** — it is re-called before every `hello` and on a 401 from `/dk/result` |
| `Relay(...)` raises at construction | `allow_remote=True` with no `auth=` / `resolve_principal=` | configure one, or leave remote off. Do not work around it |
| `400 bad-request` for a `/call` that plainly had a `name` | a body whose framing the relay did not decode (chunked, or a bad `Content-Length`) | send `Content-Length`; if it recurs, the relay is reading `Content-Length` only |
| `Parse Error: Expected HTTP/…` on a previously healthy connection | some relay in the path refused a request without draining its body | the unread bytes became the next request. Drain the body even when refusing |
| every call comes back `stale` | `rev` moves on changes the agent does not care about (a `MutationObserver` over the whole document: tooltips, ticking timestamps) | prefer a real store counter; observe the table, not the document |
| a verb ran and the next call was accepted anyway | `rev` did **not** move on that mutation | route every mutation through one `bump()`. This one is silent and corrupts rows |
| a call reports `ok` and nothing happened | a click helper hit a rendered-but-disabled control | check `disabled` / `aria-disabled` before clicking; `driverkit/controls` refuses a marked one as `disabled`, or replaces that check with `refuseWhen` |
| the agent concludes a record does not exist | `visible()` omits `page`, which **claims** the rows are everything | give `{ index, size }` (+ `total` when you know it); `{ complete: true }` only when it is |
| the model calls a commit without checking a count | no `describe` partner, or the commit takes the predicate itself | split them: predicate+count on `describe`, no predicate on `commit` |
| an irreversible verb ran with no confirmation | `kind` absent or wrong — the widget's gate fires on `kind === "commit"` only | declare `kind` on every verb; an absent one makes no safety claim |
| `413 too-large` | a snapshot near 1 MiB | a bug in `visible()`: show a screenful, and never every selected id |
| the panel renders unstyled or collides with app CSS | no shadow root available, so the host element itself is used | expected fallback; class names are prefixed. Check the host's CSS resets |
| `console.warn: driverkit: the verb X refused with Y, which is not in its declared refuses` | the `refuses` list is stale | add the slug (or stop emitting it). Deduped per message, so a loop cannot flood |
| `mount()` throws about a reserved slug or a duplicate name | a verb named/refusing `timeout`, `stale`, … or two verbs with one name | rename. Both are static facts that would make the app ambiguous to every agent |
| the panel answers `503` / `502` with a sentence from your backend | `/api/chat` has no key, or cannot reach the provider | the sentence is the diagnosis; `backendThink` surfaces the body on purpose |
| the run stops with `silent` | `think` returned neither prose nor calls | a bug in your adapter: check the response mapping |
| the run stops with `stuck` or `max-steps` | the same verb refused `refusalLimit` times, or 12 round trips spent | usually a refusal the manifest never declared, or a verb named after internals |
| prompt costs do not drop across turns | a per-request string was folded into `system`, or no cache marker | `system` and `tools` are byte-identical per run: mark them cached, add nothing per request |
| the retried commit ran twice | `timeout` / `tab-went-away` treated as a failure | those outcomes are **unknown**. Read the screen first |
| `driverkit-fastmcp` misbehaves in any way | it has never been executed | expected. Use the stdio server; see its docstring's five checks |
| `npm test` passes but `packaging.test.ts` reported itself skipped | `dist/` is absent, so nothing can be asked what the package publishes | `npm run build` (the `test` script does it; a bare `node --test` does not) |
