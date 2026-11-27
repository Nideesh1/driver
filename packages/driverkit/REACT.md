# `driverkit/react`

A second, optional panel, for a team that already has React.

`mountWidget` — `driverkit/widget` — is hand-written DOM in a shadow root with
zero dependencies, and that is the right shape for a drop-in: it goes into a
Thymeleaf template, a Rails view or a static page, and the host ends up owning
no version of anything it did not pick. It is the wrong shape for a team that
has React, a design system and an opinion about what their product looks like.
For them the shadow root is a wall around the panel and the hand-written markup
is something to fight.

So there are two panels. **This one changes nothing about the other one: the
vanilla widget's dependency count is still zero and its behaviour is
untouched.** An app that imports neither pays for neither.

Pre-release, like the rest of the library: nothing is published, and this entry
point has never been rendered by a real React.

---

## Install

```sh
npm install driverkit
```

React is an **optional peer dependency**. If you do not import
`driverkit/react`, React is not installed, is not in your lockfile, and is not
referenced by any declaration file the package publishes. See *How the optional
peer is enforced* below, which is a shorter section than you might expect
because the mechanism is mostly subtraction.

## Bind it to your React, once

```tsx
// src/driver-panel.tsx — one file you own
import * as React from "react";
import { createDriverPanel } from "driverkit/react";

export const { DriverPanel, useDriver, components } = createDriverPanel(React);
```

Everything after that line is ordinary React.

**Why that line exists**, since it is the first thing anybody will object to.
React's hook dispatcher is module-level mutable state, so a component built
against a different copy of `react` than the one rendering it throws "Invalid
hook call" — or, with a bundler that hoisted two versions, silently reads the
wrong dispatcher. A library that imports its own `react` can get that second
copy through a version mismatch, a nested `node_modules`, a monorepo hoist, or
an app that loads React from a CDN while the bundle resolves it from disk.
Taking the runtime as an argument makes it impossible: the only React that can
be passed is the one the host already has. It is the same argument
`driverkit/otel` makes about taking a `Tracer` instead of importing
`@opentelemetry/api`, and it is stronger here, because this failure is one the
adopter cannot debug from inside their own app.

The cost is real and it is one line. What is lost is `import { DriverPanel }
from "driverkit/react"` in forty files instead of re-exporting it from one.

## Use it

### The hook is the library

```tsx
function Assistant({ driver }: { driver: Driver }) {
  const d = useDriver(driver, { think: backendThink("/api/chat") });

  return (
    <YourPanel>
      {d.entries.map((e) => <YourRow key={e.id} entry={e} />)}
      {d.pending && <YourApprovalCard entry={d.pending} onDecide={d.decide} />}
      <YourComposer onSubmit={d.ask} busy={d.busy} />
    </YourPanel>
  );
}
```

`useDriver` is the whole thing: the conversation, the approval gate, the run
controls, the budget and the receipts, as plain data and plain functions. A host
that renders none of our components still gets all of the behaviour. This is
deliberately what the documentation leads with — a team adopting this has a
design system, and headless-with-defaults is the only shape that respects one.

### The panel is one assembly of it

```tsx
<DriverPanel
  driver={driver}
  options={{ think: backendThink("/api/chat") }}
  placeholder="Ask about your contacts"
/>
```

Every part is replaceable, one at a time:

```tsx
<DriverPanel
  driver={driver}
  options={{ think }}
  components={{ ApprovalCard: OurApprovalCard }}
  Prose={OurMarkdown}
/>
```

Both surfaces, rather than one, because the two audiences are real: a single
`<DriverPanel />` would make the design-system team reimplement the gate, which
is the one thing in here nobody should be reimplementing.

### The gate, for a commit that did not come from this panel

An agent over the relay or MCP can call a `commit` too, and that call never
touches `drive`'s `onBeforeCommit`. Wire this panel's card up as the core's
approver and one question covers every path:

```tsx
let panel: PanelStore;
const driver = mount({ …, approve: (req) => panel.approve(req) });
// and from the component, once it has rendered:
const d = useDriver(driver, { think });
panel = d.store;
```

When the core is already asking — the app's own `approve` hook, or a dialog
adopted by something else on the page — the panel installs no gate of its own.
Two questions about one commit is how people learn to click Yes without reading,
and the next one they skip is the bulk accept.

---

## The approval receipt

This is the feature the area was built for, and it is the one place the panel
is better than the vanilla one.

**The card does not disappear when you decide. It becomes a receipt in place:
same element, same id, same position in scrollback, the question's own words
intact, and the button row replaced by a `role="status"` line.** The gate is the
only auditable feature in the library, and auditability happens in scrollback —
a card that unmounted on decision and left a loose outcome line somewhere below
would break the link between the question and its answer, which is exactly the
link somebody scrolling back for "what did I agree to" is following.

The phases, which are what a reader of that receipt needs distinguished:

| phase | what it says |
| --- | --- |
| `asking` | the buttons are live and nothing has happened |
| `allowed` | a person said yes and the verb is now running |
| `allowed-ok` | the verb ran and the app said ok |
| `allowed-refused` | the verb ran and **the app refused it anyway** |
| `denied` | a person said no |
| `stopped` | the run was stopped before the verb ran; nobody refused it |
| `lapsed` | the panel closed with the question open; nobody answered |

`allowed-refused` is the one worth pointing at. "You approved this" and "this
happened" are different facts, and a receipt recording only the first would be
recording the more flattering of the two. A stale rev, a spent budget or a plan
token that no longer matches all land there. `receiptLine(entry)` is exported so
a replacement card keeps the wording without re-deriving it from the phase.

`stopped` and `lapsed` are kept apart from `denied` for the reason the core
keeps `timed-out` apart from `declined`: a record that cannot tell "a person
refused" from "nobody was there" is the record this whole mechanism exists to
stop writing.

### Standing rules — off by default

With `grants: true` the card also offers "Always allow" / "Always refuse". Two
rules hold, and both are load-bearing:

- **The rule is shown in full before the click**, in the same string that is
  then stored, so nobody installs a rule whose text they have not read.
- **Grants live for this panel and this page load.** Nothing is written to
  storage, deliberately: a standing approval that came back after a reload, in a
  session nobody remembers granting it in, is worse than asking again.
  `PanelSnapshot.grants` is on the snapshot so a host can render the list, and
  `revoke(verb)` takes one away — a grant nobody can see is a grant nobody can
  revoke.

A commit answered by a rule is still posted as a receipt, naming the rule that
answered. A rule that silenced the question must not also silence the record.

On the core's `approve` path such a commit answers `{ asked: false }` rather
than `true`, because nobody *was* asked this time, and that is the answer the
core added for exactly this case. **An app that needs every allowed commit to
carry a person's yes in the audit record should leave `grants` off.** (On
`drive`'s `onBeforeCommit` path there is no `{ asked: false }` to return — it is
a `CommitDecision`, not an `Approval` — so a grant there can only say `true`,
and the richer record lives only in the panel. That asymmetry is the core's, not
ours.)

### Notes — off by default

With `notes: true` the card offers a free-text field. On a *denial* the note
becomes the hint the model is told, which is a real feature of the gate rather
than decoration: `CommitDecision` takes a string, and "not until finance signs
off" is something a model can act on where "declined" is not.

**Typing in it never approves anything.** The note is read only when a decision
button is pressed, Enter in the field does not submit, and there is deliberately
no API that takes a note on its own. On a decision the approval itself is the
authorization; a gate that inferred consent from a typed explanation would let
the explanation authorize the call.

---

## The markdown seam

**Markdown rendering is not built here and must not be.** It is being built for
the vanilla widget. When it lands, this is where it plugs in:

```tsx
const Prose: ProseRenderer = ({ text }) => /* nodes */;
<DriverPanel … Prose={Prose} />
```

What the seam guarantees to whatever fills it:

- **`text` is the model's complete text for one turn.** `onSay` delivers a whole
  turn at once — driverkit does not stream tokens — so a renderer never sees a
  half-written fence, never has to parse incrementally, and needs none of the
  streaming-markdown machinery the rest of the world needs.
- It is called during render, so it must be pure. Memoize an expensive parse in
  the host.
- **It returns nodes, never HTML.** The prop is a component precisely so that
  the escape hatch cannot be `dangerouslySetInnerHTML` over a model's output,
  which is the least trusted thing on the screen. Nothing in this area injects
  HTML and a test pins that.

The default renderer is the identity: the model's text, as text. Plugging
markdown in is replacing something rather than filling a hole.

---

## How the optional peer is enforced

Four things have to hold, and three of them are subtraction.

1. **`peerDependencies: { react: ">=18" }` with
   `peerDependenciesMeta: { react: { optional: true } }`.** This is what stops
   npm installing React for somebody who does not want it, and stops it warning
   about a peer they correctly do not have. `>=18` because
   `useSyncExternalStore` is an 18 API and it is the one that makes this area
   small.
2. **React is in no `dependencies`.** The package's only dependency is
   `@types/node`, which the relay's own declarations need.
3. **No file in the package imports `react`, in any form, including
   `import type`.** This is the one that peer-optional alone does not buy: an
   `import type { ReactNode } from "react"` in a published `.d.ts` is a dangling
   module reference for every consumer who did not install React. There is
   nothing to dangle because the React API is typed structurally in
   `src/react/runtime.ts` and passed in.
4. **`./react` is reachable only by naming it.** Nothing in `core`, `agent`,
   `widget`, `controls`, `browser`, `check`, `otel` or `relay` imports this
   area, so the module graph of somebody importing only `driverkit` does not
   contain it.

Proved in `test/packaging.test.ts`, in the style of the entry-point tests
already there:

- `./react` resolves under browser conditions like every other non-relay entry,
  with `types` before `default`.
- the peer is declared, optional, and absent from `dependencies`.
- the emitted JavaScript for `dist/react` names **no** bare specifier — not even
  `react` — so a page can load it from a plain URL with no import map.
- walking the emitted imports from `dist/core/index.js` transitively never
  reaches `dist/react/`.

## What is feature-equivalent, and what is deliberately not

Equivalent, and tested:

- the conversation: sending instructions, the model's replies, the stop notes
- **the approval gate**, under the same three options (`confirmCommits`,
  `commitAskAbove`, `confirmEveryCommit`), the same `reversible` reading, the
  same size check, the same `{ asked: false }` for a commit nobody was asked
  about, and the same no-other-calls lock held while a question is open
- the run controls: pause, resume, single-step, and a visible, changeable pace
  that reaches the run already in flight
- the session budget, where a ceiling is declared
- stop, and a clear that takes a dying run's events with it

Deliberately not:

- **No launcher, no drag, no snapping, no corner.** Those exist because the
  vanilla widget has to place itself in a page nobody told it about. Here the
  host renders the panel in its own layout.
- **No shadow root.** The vanilla panel needs one because it renders into an app
  whose CSS it has never seen. A React app has a CSS isolation story of its own,
  and a shadow root would break it — the host's own class names would not reach
  inside, which is the opposite of the point.
- **No stylesheet at all.** Class names (`dk-step`, `dk-ask`, …) and
  `data-dk` / `data-phase` / `data-status` attributes are emitted for you to
  style. The one exception is the inline clip on the screen-reader-only status
  regions, which is not a look: a `role="status"` that is `display: none` is not
  announced.
- **No `localStorage`.** The vanilla panel remembers a viewer's pace and
  position because it has nowhere else to put them. A React app has a user
  object and a server, and a library writing to `localStorage` behind its back
  is a surprise. Pace, step mode and confirmations are state with setters; the
  host persists them if it wants to.
- **No element highlighting.** `at` is on every step entry and `onAim` fires
  with it, which is the seam. The outline itself is DOM drawn outside React's
  tree into a page whose stacking and transforms belong to the host, and a React
  app that wants it can draw it with the tools it already has.
- **No settings view.** Four preferences and a budget row is a design-system
  decision, and the state is all on the snapshot.

## The vanilla design decisions, kept and dropped

| vanilla decision | here | why |
| --- | --- | --- |
| shadow root | **dropped** | a React app's CSS isolation is its own, and a shadow root breaks it |
| fixed-size launcher ("Ask", never the app's name) | **dropped** | there is no launcher; the host places the panel |
| `textContent` over `innerHTML` | **kept, restated** | React escapes by default; the rule becomes "nothing here calls `dangerouslySetInnerHTML`", including at the markdown seam |
| the `era` counter on Clear | **kept** | React does not help: a `setState` from an async callback that outlived a Clear is exactly as wrong as the `appendChild` it replaced |
| the commit gate's three options and the `reversible` reading | **kept, identically** | one of the two panels being laxer than the other would make "which panel is this app using" a security question |
| row text that reads the same pending or finished (state as a class, never as words) | **kept** | a step row is a record |
| "No" focused / reached first, "Yes" one key further | **kept** | a person pressing Enter on a card that appeared while they were typing must not thereby accept a thousand rows |
| the step row appearing on `onBeforeCall`, before the pace wait | **kept** | the only way "you can see it coming and stop it" is true rather than aspirational |
| named speeds rather than a free slider | **kept** | milliseconds are not a thing anybody has an opinion about, and four labelled radios are keyboard-reachable without anybody being careful forever |
| `aria-live="polite"` on the whole transcript | **dropped as a bug** | at a 600ms pace the region is re-read as each step row lands, so the person hears a growing conversation from the top instead of what just changed. State is announced instead, in one-sentence `role="status"` regions keyed so each change re-announces |
| the approval row keeping its outcome line | **kept and extended** | the vanilla row survives and records that *you* answered; this also records what the *app* then did, which is the half that turns a decision into a record of a change |

## What a React adopter can get wrong that the vanilla widget made impossible

Worth reading once; each of these is a shape the DOM version had no way to
express.

- **Rendering the transcript inside a live region.** The vanilla panel owns its
  markup, so its (wrong) `aria-live` was at least one wrong thing in one place.
  A host that wraps `<DriverPanel />` in its own `aria-live="polite"` container,
  or in a design-system `<Toast>` that is one, reproduces the bug from outside
  and nothing in here can stop it.
- **Replacing `ApprovalCard` with one that unmounts on decision.** The receipt
  is the product. A card that returns `null` once `phase !== "asking"`, or that
  renders decided approvals into a separate "history" list, throws away the
  question/answer link in scrollback. If you replace the card, keep the entry
  rendered in place.
- **Treating `pending` as a modal.** `d.pending` is convenient and it is also
  the entry that is already in `entries`. Rendering it a second time in a dialog
  gives two live "Yes" buttons for one commit.
- **Keying transcript entries by index.** Entries are appended and patched in
  place; `entry.id` is stable and an index is not, so an index key will make a
  receipt inherit another entry's state mid-run.
- **Calling `useDriver` twice for one driver.** Two stores means two gates, and
  the second one's `onBeforeCommit` is a second question about one commit. One
  store per driver; lift it if two components need it.
- **Expecting an options change to take effect.** The store is built once per
  `driver` and the options are read then. The things a person changes while
  watching a run — pace, step mode, confirmations — are state with setters for
  exactly that reason. Re-key the component if you genuinely need new options.
- **Persisting grants.** If you add storage for `PanelSnapshot.grants`, you have
  changed what a standing approval means. See above.

## Reference

```ts
createDriverPanel(react): { useDriver, DriverPanel, components }

useDriver(driver, options): Driving
// entries, busy, runState, paceMs, permits, stepMode, confirmCommits,
// budget?, grants, pending?, era
// ask, stop, clear, pause, resume, step, setPace, setStepMode,
// setConfirmCommits, decide, revoke, approve, store

createPanelStore(driver, options): PanelStore   // the same thing, without React
receiptLine(entry): string                       // what a receipt says
stepOutcome(ok, refused?, count?): string        // what a step row says
COMMIT_ASK_ABOVE                                 // 25, as in the vanilla widget
```

`PanelOptions`: `think`, `instructions`, `maxSteps`, `refusalLimit`, `greeting`,
`confirmCommits`, `commitAskAbove`, `confirmEveryCommit`, `onBeforeCommit`,
`grants`, `notes`, `pace`, `stepMode`, `controls`, `clock`, `onAim`, `onError`,
`AbortController`.
