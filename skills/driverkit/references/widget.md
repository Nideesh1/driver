# Case 1 — the chat panel in the corner of your own app

The page holds the driver, so **there is no transport at all**: the loop asks a model what to do and calls the verb
in-process. Two subpaths of the one package: `driverkit/widget` (plain DOM, a shadow root, no framework — it drops
into a React, Vue or Rails app alike) and `driverkit/agent` (the loop; no model client, no API key).

```ts
import { mountWidget } from "driverkit/widget";
import { backendThink } from "driverkit/agent";

const panel = mountWidget(driver, {
  think: backendThink("/api/chat"),
  greeting: "Ask me to do things in Contacts. Try: “select everyone at Acme whose status is new, "
          + "tell me how many, then accept them”.",
  // THIS HOST's voice, not the app's. What the app has to say about itself goes in
  // MountOptions.instructions, which also reaches an agent arriving over the relay.
  instructions: "Keep answers to one sentence; this panel is narrow.",       // STATIC: no user, no screen
  onError: (err) => console.error("driverkit widget:", err),
});
// panel.ask("…"), panel.open(), panel.close(), panel.moveTo({x,y}), panel.unmount()
```

## You must write `/api/chat`, and the key lives there

`think` is a function, not a provider option, for one reason that is not negotiable: **a browser cannot hold an API
key.** Anything shipped to a page is readable by whoever has the page. The realistic deployment is that `think`
posts to the app's own backend, which already authenticates this person and already holds the key.

`backendThink(url)` POSTs `{ system, tools, messages }` and expects `{ text?, calls? }` back. Credentials ride as
any same-origin request's do, so a session cookie is already attached; pass `headers` for a CSRF token. A non-2xx
throws (with the body's `error` string in the message) rather than being swallowed as empty prose — a 500 from your
own backend is not the model declining to act.

A minimal endpoint, in Python, against the Anthropic Messages API. The full version with error handling is
`examples/contacts/server.py`:

```python
def handle_chat(ask: dict) -> dict:
    payload = {
        "model": MODEL, "max_tokens": 2048,
        # A list of blocks, not a bare string: the only shape that can carry a cache breakpoint.
        "system": [{"type": "text", "text": ask["system"], "cache_control": {"type": "ephemeral"}}],
        "tools": to_anthropic_tools(ask["tools"]),       # inputSchema -> input_schema; mark the LAST tool cached
        "messages": to_anthropic_messages(ask["messages"]),
    }
    reply = call_the_model(payload)                      # the key is read from the environment, here
    return from_anthropic(reply)                         # {"text": ..., "calls": [{"id","name","args"}]}
```

Three translation facts that cost real time if you miss them:

1. **`system` and `tools` are byte-identical on every request within a run** — and across runs and across users
   until the verbs change. Forward them with your provider's caching marker on (Anthropic: `cache_control` on the
   `system` block and on the **last** tool, since a breakpoint covers everything before it) and you pay for the
   app's whole capability list once instead of once per turn. A backend that appends its own per-request string to
   `system` gives that saving back and nothing breaks — it just costs more.
2. **driverkit's `Turn` has three roles; the Messages API has two.** A `role: "tool"` turn is a `tool_result`
   content block inside a **user** message, and **consecutive tool turns must be merged** into one user message
   with several blocks (one assistant turn may emit several calls) — several user messages in a row is a 400.
3. **Echo `id` / `tool_use_id` exactly**, and pass verb names through verbatim: they are kebab-case by the core's
   contract, the API's name pattern allows that, and the loop looks the returned name up in the manifest.

For OpenAI-shaped APIs the same three points hold, plus one more: `arguments` arrives as a JSON **string**, so
there is a malformed-arguments case to handle that the Anthropic shape does not have.

Your backend must not trust the verb names it is handed: the model's reply is executed against the driver mounted
in *this* page under *this* person's session, which is the same authority model the relay has.

## The commit gate

`mountWidget` defaults `confirmCommits: true`, and this is the one place the widget's default differs from
`drive`'s (which gates nothing — it is a library primitive whose callers may have their own policy). A person
watching a chatbot move their own screen should not learn about a thousand accepted rows afterwards.

The gate fires on `kind === "commit"` and nowhere else — which is the other reason a mislabelled `kind` is
expensive. It asks **one question per call, not per row**: a commit verb takes no predicate and acts on the whole
selection, so accepting a thousand contacts is one call and one prompt. The question carries the count the
preceding `describe` reported, falling back to `Snapshot.selectedCount` and then to `Snapshot.selected.length`;
with none of the three it says so out loud ("no count was reported, so nobody can tell you how many rows it
affects").

A commit that declares `Verb.reversible` **runs without a question**. That is what the flag buys: a page-size
change and a bulk accept of 3,412 rows were getting the same dialog, and a modal on something trivial is how
people learn to click Yes without reading — the next one they skip is the bulk accept. An absent `reversible`
makes no claim and is still gated.

Two things override the flag. A commit acting on more than `commitAskAbove` rows (default `COMMIT_ASK_ABOVE`,
25 — one screenful, past which the person cannot check the selection by eye) is asked about anyway, because
"undo" over thousands of rows is a promise an app may not be able to keep at that size whatever it declared. And
`confirmEveryCommit: true` restores the ask-on-every-commit behaviour for an app that wants it. When a reversible
commit does get a dialog it says **"this can be undone"**, so the two dialogs do not read alike — two dialogs
with the same words are one dialog as far as a person's attention is concerned.

A "no" reaches the model as the `declined-by-user` refusal — an ordinary answer, never an exception — so it adapts
("you declined that; want me to narrow it first?") instead of leaving a dead panel. `onBeforeCommit` **replaces**
the built-in dialog rather than stacking with it; it receives `{ name, args, verb, snapshot }` and returns
`true` / `false` / a string (which becomes the hint the model is told).

## Options worth knowing

| option | default | |
|---|---|---|
| `think` | — | required. See above |
| `confirmCommits` | `true` | false only for an app whose commits are all small; above both rules below |
| `commitAskAbove` | 25 | selection size past which even a `reversible` commit is confirmed |
| `confirmEveryCommit` | `false` | true to ask before every commit, reversible or not |
| `onBeforeCommit` | — | your own confirmation, instead of the built-in one |
| `maxSteps` | 12 | model round trips. Enough for read → describe → check → commit → answer with room for two refusals |
| `refusalLimit` | 3 | stop after this many identical refusals (same verb, same slug), counted across the run |
| `instructions` | — | static guidance from THIS HOST, folded into the system prompt **after** the app's own `Manifest.instructions` — so the host's is what a model follows if they disagree, and it reaches only this path. Per-user text here breaks caching across users |
| `title` / `greeting` / `placeholder` | app name | header, first transcript line, input placeholder |
| `open` | `false` | a panel that opens itself is a panel over something the person was reading |
| `position` / `draggable` / `snapThreshold` / `persist` | CSS / `true` / 72 / `true` | corner or `{x,y}`; dragged position is remembered per app and viewer in `localStorage`, as a fraction of free space |
| `container`, `document`, `window`, `storage`, `AbortController` | the real ones | injected; a design requirement, not a testing shim |

Leave `position` out and the stylesheet decides (`--dk-x` / `--dk-y` / `--dk-gap` on `:host`, bottom-right) — which
is the only way a host app can place the panel from its own CSS. Passing it writes those properties inline. A
position the *person* dragged to always beats both.

Every verb that runs appears in the transcript, labelled with its `kind` and what it answered. That visibility is
what the widget adds over `drive` alone: silent mutation is alarming even when it is right.

## Stop reasons

`answered` (the model's own ending), `max-steps`, `stuck` (the refusal limit), `aborted`, and `silent` — which
means `think` returned neither prose nor calls and is almost always a bug in your adapter. They are returned, not
thrown: a bounded run is an outcome a UI renders, not a failure.

## Headless, without the panel

```ts
import { drive } from "driverkit/agent";
const out = await drive(driver, { think, task: "accept everyone at Acme", onBeforeCommit: myPolicy });
// out.stop, out.text, out.steps, out.messages  — pass `messages` back as `history` to continue
```

The loop keeps no state between runs; the conversation is the caller's array. `out.messages` is not a verbatim
transcript — older user turns have had their screen blocks replaced (`pruneScreens`), so a model is never shown two
screens and left to guess which is now true.
