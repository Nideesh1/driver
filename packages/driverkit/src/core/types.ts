/**
 * driverkit — the types.
 *
 * The whole library rests on a split that is worth stating before any code:
 *
 *   A VERB is static. Its name, its arguments and what it refuses are the same
 *   for every user on every day, so they can be sent to a model once, cached in
 *   the prompt prefix, and never sent again.
 *
 *   A SNAPSHOT is dynamic. It is what a human could see at this moment, and
 *   nothing more, so it is small by construction and goes in the tail where it
 *   is never cached.
 *
 * Keeping anything per-user or per-screen out of the verb list is not tidiness,
 * it is the entire cost argument. One user-specific string in the static half
 * busts the cache for everybody and the library stops being cheap to drive.
 */

/** A value an agent can pass to a verb. Deliberately not `any`: if an argument
 *  cannot survive JSON it cannot cross the relay to an agent in another
 *  process, and a verb that only works in-page is a verb that works once. */
export type Scalar = string | number | boolean | null;

/** What a verb accepts. A tiny subset of JSON Schema, hand-rolled so the core
 *  package keeps its promise of zero runtime dependencies. */
export interface ArgSpec {
  type: "string" | "number" | "boolean";
  /** Shown to the model. Write it for a reader who cannot see your app. */
  describe: string;
  /** If present, the only accepted values. Cheaper and safer than prose. */
  oneOf?: Scalar[];
  /** Absent means required. */
  optional?: boolean;
  /**
   * `true` when this argument's VALUE must never appear in an audit record.
   *
   * The one half of redaction the library cannot work out for itself. An
   * argument is whatever the app declared — a row id, a filter, a company
   * name, and on some app somewhere an API key or a one-time code — and only
   * the author who typed the `describe` knows which. A library that guessed
   * would guess by name, which is how `token` gets redacted and
   * `otp_material` does not.
   *
   * So the app declares it and the CORE does the replacing, before the hook
   * is called: `AuditEvent.args` carries `"[redacted]"` in this field's place
   * and `AuditEvent.redacted` names the field, so a reader cannot mistake the
   * marker for a string the agent actually sent. The alternative — hand the
   * hook everything and let the host strip it — puts the secret on the far
   * side of the one boundary where a record is most likely to leave the box,
   * and makes the DANGEROUS case the one you get by doing the obvious thing.
   * A host that wires `onAudit` straight to its tracer should not thereby
   * ship a key to a vendor.
   *
   * It changes nothing else. The value reaches `run` untouched — this is a
   * statement about the record, not about the call — and nothing renders it
   * to the model.
   *
   * It IS in the manifest, and so in `fingerprint()`, like the rest of an
   * `ArgSpec`. That is consistent rather than a leak: it is static, it is the
   * same bytes for every user forever, and it carries no value — only the
   * claim that this field has one worth hiding. An app that declares none
   * hashes exactly what it hashed before this field existed.
   */
  sensitive?: true;
}

/**
 * What a verb does to the world, declared in the cached half so an agent knows
 * before it calls.
 *
 *   `read`     — changes no data and reports no count. Free to call, free to
 *                get wrong. It may still move what the person is looking at:
 *                navigation is a read.
 *   `describe` — changes what is SELECTED, changes no data, and reports a
 *                `count`. Also safe: the worst outcome is the wrong rows
 *                highlighted.
 *   `commit`   — changes data. May be irreversible; see `Verb.reversible`.
 *
 * `read` used to promise "changes nothing", and that was false of the commonest
 * verb a multi-screen app has. `go`, `open-contact`, `back` and `sort-by` move
 * the person's screen out from under them — the most visible thing an agent can
 * do to somebody who is watching — and the cached half was telling it that was
 * free. The wording was fixed rather than a fourth kind added, because these
 * three are a ladder of WHAT A WRONG CALL COSTS YOU, and a wrong navigation
 * costs exactly what a wrong read costs: the person has to look somewhere else.
 * The two promises worth making are the ones that decide whether the next call
 * is safe — no data moved, and no count is left pending — so those are the two
 * this now makes, and they are true of every navigation verb.
 *
 * `describe` no longer says "or FILTERED", and that was not a trim. By that
 * sentence a search box is a `describe`, which is how `search` gets declared
 * one; but the rest of what `describe` means — that it reports a `count`, that
 * the count is what a following `commit` acts on, that the pair is the safety
 * mechanism — is true only of selection. A verb that narrows a list and leaves
 * nothing pending is a `read`.
 *
 * This exists because of one failure mode. Asked to "select the top 1000 rows
 * and bulk accept", an agent that cannot tell `select` from `accept` has to
 * discover the difference by doing it, and the discovery costs you a thousand
 * accepted rows. A screenshot cannot tell it apart either, and neither can an
 * OpenAPI spec, which says what a call takes but not what it costs you.
 *
 * The pairing rule that makes bulk work safe: a `describe` verb takes the
 * predicate and returns the count, a `commit` verb takes NO predicate and acts
 * on the current selection. Two calls, so a count is always seen before data
 * moves. A verb that both selects and accepts is how fifty thousand rows get
 * accepted because a filter was wider than anybody thought.
 *
 * TWO CALLS IS NOT ENOUGH ON ITS OWN, and that is what `Verb.consumes` is for.
 * "Acts on the current selection" re-reads the selection at call time, so
 * between the `describe` and the `commit` a person can tick a row, page the
 * list, or a websocket can land — and then the count the agent read and the
 * human approved is not provably the set the commit touched. Django has shipped
 * that exact bug class since 2010, where `select_across` was silently lost and
 * a confirmed bulk action ran on page one only (tickets 15742, 33083, and 36706
 * closed wontfix in 2025). Chrome's WebMCP best practices state the requirement
 * in one line: confirmation must recompute the current state and reject stale
 * work. So a `commit` may declare `consumes: "plan"`, the `describe` hands back
 * a token the core minted over the selection it left behind, and the commit has
 * to present it. See `Verb.consumes`, `Snapshot.selectionId` and
 * `CallOptions.plan`.
 *
 * `ask` IS THE FOURTH KIND, AND THIS FILE HAS ALREADY REFUSED ONE ONCE, so the
 * difference is worth stating before the type. Navigation was refused a kind of
 * its own on the grounds that the three are a ladder of WHAT A WRONG CALL COSTS
 * YOU and a wrong navigation costs exactly what a wrong read costs. A wrong
 * question is not on that ladder at all: it costs a PERSON'S ATTENTION, which
 * is the one currency the other three never spend. `read` says "free to call,
 * free to get wrong", and that sentence is false of a question — asking is
 * budgeted (`Budget.asks`), it blocks every other call while it is open, and
 * the cost of getting it wrong is paid by somebody who then trusts the next
 * question less. `describe` reports a count about the app and `commit` moves the
 * app's data; a question reads and writes nothing in the app. So it is neither
 * `read` in the ladder's own terms nor a lie dressed as one.
 *
 * **ONLY THE CORE MAY MINT IT.** An app verb declaring `kind: "ask"` is refused
 * at `mount()`. A question is put through `MountOptions.ask` so that the core
 * owns the lock, the deadline, the allowance and the audit row; an app verb
 * wearing the kind would be a question none of those applied to, and the first
 * thing somebody would build with it is a confirmation dialog that answers for
 * the approval gate. See `AskHook`.
 */
export type VerbKind = "read" | "describe" | "commit" | "ask";

/**
 * Something the app can do.
 *
 * `refuses` is the field people skip and the one that earns its place. A
 * screenshot cannot tell an agent what a button will do, and neither can a
 * name: `delete` is reachable on screen whether or not this particular row is
 * deletable. Listing the refusals up front, in the half that gets cached, lets
 * an agent avoid the call instead of discovering the answer by making it.
 *
 * On bulk work, note what a verb must NOT be. If the only way to select a
 * thousand rows is a thousand `select(id)` calls, an agent will make a
 * thousand round trips and lose its way somewhere in the middle. So a verb
 * that operates on many rows takes a PREDICATE and resolves it inside the app,
 * where the rows already are — `select(where, limit)`, never `select(id)`
 * repeated. The agent should never learn an id it did not need.
 */
export interface Verb<A extends Record<string, Scalar> = Record<string, Scalar>> {
  /** Stable, kebab-case, unique within a mount. This is the agent's handle on
   *  it, so renaming one is a breaking change to every stored prompt. */
  name: string;
  /** One line, imperative, in the user's own vocabulary: "accept the selected
   *  contacts". Not "calls patchContacts" — the agent cannot see your code,
   *  and a name drawn from your internals makes it guess at your intent. */
  describe: string;
  /** What this does to the world. Optional, and an absent one makes NO safety
   *  claim in either direction: treating it as `read` would tell an agent an
   *  irreversible verb is free to try, and treating it as `commit` would mark
   *  every verb of an app written before this field as dangerous, which is a
   *  warning on everything and therefore a warning on nothing. Declare it. */
  kind?: VerbKind;
  /**
   * A CSS selector naming the element this verb affects. Optional, purely
   * presentational, and **never used by driverkit to find anything.**
   *
   * It exists for the human watching. An agent driving the screen a person is
   * looking at has to be legible, and "about to accept the selection" reads
   * better with the table it means outlined on the page. `at` is how a verb
   * says which part of the app it is about, so a UI may draw an outline there
   * before the call and clear it after.
   *
   * The library never queries it, never resolves it, never shows it to the
   * model, and nothing about a verb's behaviour depends on it. That restraint
   * is the field's whole design rather than an omission waiting to be filled
   * in: driverkit's claim is that an app is driven through its own verbs and
   * not by poking at its DOM, and an `at` that driverkit itself clicked would
   * be a back door straight back to selector automation — brittle, invisible
   * to the app, and broken by the next CSS refactor. So a wrong or stale `at`
   * must cost nothing but an outline drawn in the wrong place. If a verb stops
   * working when `at` is edited, something has started using it, and that is
   * the bug.
   *
   * It is in `fingerprint()` all the same. Re-pointing a verb at a different
   * element changes what the cached surface claims, and a UI holding the old
   * copy would go on outlining the thing the verb no longer touches.
   */
  at?: string;
  /**
   * The screen this verb belongs to, or the screens it belongs to, matched
   * against `Snapshot.screen`.
   *
   * Absent means the verb applies anywhere, which is the right answer for most
   * of them: `select-contact` and `clear-selection` work from any screen, and
   * an app with one screen never fills this in.
   *
   * **An array is for a verb that genuinely lives on more than one screen**,
   * and it was added because a single string made the library's own worked
   * example lie. `next-page` and `prev-page` page both the contacts list and a
   * company's contact list; declaring either screen would have the demo refuse
   * a paging call on a screen that was still publishing a `page: {index, size,
   * total}` block and whose rendered snapshot still said "more rows exist off
   * screen; use the app's own paging verb". Faced with writing that
   * contradiction into the example, the app invented an `no-pages-here`
   * refusal of its own instead — which is the smell this field exists to
   * remove: an app hand-rolling a check and naming it, so that the next app
   * names it something else and no agent recognises both.
   *
   * A single string behaves exactly as it always did. An EMPTY ARRAY is
   * refused at `mount()`, the way a duplicate verb name is: it says the verb
   * works nowhere, which no author means, and a verb that can never be called
   * is permanently dead weight in everybody's cached prefix. Omit the field to
   * mean "anywhere".
   *
   * **The tool list does not change with the screen, and must not.** A verb
   * list that varied per screen would bust the prompt prefix on every single
   * navigation, which is the cost argument the whole library is built on — so
   * `next-page` is offered on the dashboard too, and the core refuses it there
   * with the screen named. Declaring the mapping statically is what makes it
   * cacheable: the names of the screens and which verb lives on which are the
   * same for every user forever, and only *which screen is live* is dynamic.
   *
   * What this buys over an app's own guard is that the refusal is structural
   * and says both halves of the answer. Before it, the app wrote the check by
   * hand and invented a slug for it, and an agent had no way to learn which
   * screen a verb wanted except by being refused once — the manifest was a
   * flat list with no screen on any entry. Now the mapping is in the cached
   * half, where a well-briefed agent reads it before calling, which is the
   * same argument `refuses` is in there for.
   *
   * In `fingerprint()`, for the reason `kind` is: moving a verb to another
   * screen changes what the cached surface claims about where it works, and so
   * does giving it a second one.
   */
  screen?: string | string[];
  /**
   * `true` on a `commit` whose effect the app can undo.
   *
   * Read only for `kind: "commit"`, and absent makes no claim — exactly like
   * `kind` itself, because the two wrong defaults cost the same two things:
   * assuming reversible tells an agent a bulk accept can be taken back, and
   * assuming irreversible marks every commit of an app written before this
   * field as the dangerous kind, which is a warning on everything and
   * therefore a warning on nothing.
   *
   * It exists because `set-setting("dense-rows", "true")` and accepting 3,412
   * contacts were both `commit`, so both got the same shouted banner and both
   * stopped to ask a person. Putting a page-size change behind a confirmation
   * dialog is how people learn to click Yes without reading, which is the exact
   * failure the gate exists to prevent. The ladder's third rung was carrying
   * two different costs and only had words for the worse one.
   *
   * Reversible is not harmless: it still changes data and the person still
   * sees it. It means there is a way back, not that nobody minds.
   */
  reversible?: true;
  /**
   * `"plan"` on a `commit` that may only be called with a token from the
   * `describe` that counted what it is about to touch.
   *
   * THE HOLE THIS CLOSES. The pairing rule — a `describe` takes the predicate
   * and reports a `count`, a `commit` takes no predicate and acts on the
   * current selection — was advertised as "two calls, so a count is always seen
   * before data moves". It was not that. `commit` re-reads "the current
   * selection" at call time, and between the two calls the person can tick a
   * row, page the list, or a websocket can land. So the count that was read,
   * and approved, was not provably the set that moved. Django shipped exactly
   * this for fifteen years: `select_across` silently lost, so a confirmed bulk
   * action ran on page one only. Chrome's WebMCP best-practices page states the
   * fix in one line — confirmation must recompute the current state and reject
   * stale work — and recommends binding the transition to state version and
   * exact scope, which is what a token here is.
   *
   * The model is Terraform's saved plan: applying one performs exactly the
   * steps in that file, and a saved plan is valid only while the state has not
   * changed. So a `describe` that leaves a selection behind gets a `plan` token
   * back beside its `count` (see `Result.plan`), and a `commit` declaring this
   * must be called with that token in `CallOptions.plan`. The core refuses as
   * `stale-plan` when the token is missing, was never minted here, was taken at
   * an older `rev`, or named a selection that is no longer the one on screen —
   * and names both counts in the hint, the way `wrong-screen` names both
   * screens.
   *
   * **A READ-ONLY MOVE IS NOT AN OLDER `rev`.** Navigation bumps `rev` and
   * changes no data, so a plan is carried across a `kind: "read"` verb whose
   * call left `Snapshot.selectionId` unchanged. Without that, "go back and
   * confirm the number before you move 3,412 rows" cost a refusal and two
   * recovery calls, and committing blind cost nothing — pricing the
   * double-check above the blind commit, which is the opposite of what this
   * field is for. An app publishing no `selectionId` carries nothing and keeps
   * the behaviour it had.
   *
   * **The app does not mint the token and cannot**, which is the point of the
   * field being this small. An app that computed its own would have to get a
   * hash right, and a token an app can forge or accidentally reuse is worse
   * than no token because it still reads as a guarantee. All the app does is
   * publish `Snapshot.selectionId`; the core does the binding.
   *
   * Static, and in `fingerprint()` for the same reason `kind` is: a verb that
   * has started requiring a token has changed what a cached manifest claims
   * about how it may be called, and an agent holding the old copy would go on
   * calling it bare and being refused. An absent one makes NO claim and
   * changes nothing — a commit written before this field behaves exactly as it
   * did, which is why this is not the default. A `read` or a `describe` that
   * declares it is an authoring mistake and is refused at `mount()`: a token
   * is a claim about data that is about to move, and demanding one for a
   * highlight teaches an agent to fetch tokens it does not need.
   *
   * **ALL OR NONE, AND THIS IS THE RULE THE FIELD IS USELESS WITHOUT.** If one
   * `commit` that acts on the selection consumes a plan, every commit that acts
   * on the same selection must, or the gate is advisory. This is not a style
   * note. An eval asked the worked example for a job it cannot do — "archive
   * everyone who has not replied in six months" — and the agent improvised:
   * selected a company, then called the one bulk commit that asked for no
   * receipt, and 403 rows changed with no count read and nothing gated. The
   * verb an agent reaches for when it is off its intended path is the
   * least-declared one, which is exactly when the receipt matters most, so a
   * guarantee is only as strong as its weakest sibling. `mount()` warns when it
   * can see this shape; the warning cannot see every case, and the rule is the
   * thing to remember.
   *
   * What does NOT need one: a commit that names what it acts on. A verb that
   * takes an id, or that changes the one record whose screen is open, is acting
   * on something the person can see and count, and the count is 1. A plan is
   * the receipt for a count LARGER THAN THE SCREEN, which is the only case
   * where a number has to be carried between two calls to mean anything.
   */
  consumes?: "plan";
  args?: Record<string, ArgSpec>;
  /**
   * The refusals this verb can return, as short stable slugs.
   *
   * Documentation for the model, and the list a `refuse()` is checked against:
   * declaring it opts this verb into the check, and a refusal with a slug that
   * is not on the list warns once (see `RESERVED_REFUSALS` and `mount`).
   * Leaving it absent makes no claim and is not checked, the same way an absent
   * `kind` makes no safety claim.
   *
   * None of these may be a slug from `RESERVED_REFUSALS`. An app that refuses
   * with `timeout` has taken away an agent's only way to tell "the app said no"
   * from "your call never landed".
   */
  refuses?: string[];
  /**
   * Do the thing.
   *
   * Return nothing for the ordinary case. Return `ctx.refuse(...)` for an
   * expected "no". Return a `Report` when the verb has a number or a sentence
   * the snapshot cannot carry — above all a `describe` verb's `count`, which is
   * the number the person would have had to see before pressing a bulk button.
   *
   * Throwing is a bug, not a "no".
   */
  run: (
    args: A,
    ctx: VerbContext,
  ) => void | Refusal | Report | Promise<void | Refusal | Report>;
}

/**
 * What a verb has to say about what it just did, beyond the screen.
 *
 * This exists for `count`. A `describe` verb resolves a predicate inside the
 * app — "every contact at Acme" — and the only thing that makes the following
 * `commit` safe is the person or the agent seeing how many rows that matched
 * BEFORE anything irreversible runs. The screen cannot carry it: the whole
 * point is that the match is larger than the window, so `rows` shows twenty of
 * three thousand and `page.total` is about the table, not about the selection.
 *
 * Without this the pairing rule is advice. With it, it is a number.
 */
export interface Report {
  /** How many rows the verb matched or selected. `0` is a real answer and is
   *  distinct from omitting the field, which means "I do not count". */
  count?: number;
  /** One short line for the agent that the snapshot has nowhere to put. */
  note?: string;
}

/**
 * WHY THERE IS NO `plan` FIELD HERE, since this is the first place anybody
 * looks for one.
 *
 * A plan token has to be checkable at the moment the `commit` runs, and the
 * only thing the core can read then is `visible()`. A verb returns its `Report`
 * once, at the end of the `describe`, and is never asked again — so an identity
 * handed back here could be bound into a token and never re-derived, which
 * makes the check "is this the token I minted" and not "is this still the
 * selection I counted". That is the difference between a receipt and a
 * guarantee, and a token that only proves its own provenance is the theatre
 * this whole mechanism exists to avoid.
 *
 * So the identity lives in `Snapshot.selectionId`, which the core reads after
 * the `describe` and again before the `commit`, and the app states it in one
 * place instead of two. Two places is the real cost of the alternative: an app
 * that computed the identity once for the report and once for the screen would
 * eventually compute them differently, and the token would be minted over one
 * and checked against the other.
 */

export interface VerbContext {
  /** Decline, with a reason the agent can act on. See `refuse`. */
  refuse: (reason: string, hint?: string) => Refusal;
}

/** The marker returned by `ctx.refuse`. Not an Error: a refusal is an ordinary
 *  outcome the agent is expected to handle, and making it an exception pushes
 *  app authors toward try/catch around their own business rules. */
export interface Refusal {
  readonly __driverkit: "refusal";
  reason: string;
  hint?: string;
}

/**
 * One control the screen is offering right now.
 *
 * The dynamic half of the controls layer, and the split is the whole reason
 * this type is so small. *That an app can press a control* is static and lives
 * in the manifest as a verb. *Which controls are on this screen at this
 * moment* is as per-screen as a row is, so it belongs here, in the half that is
 * never cached. Listing the control names in a verb's `ArgSpec.oneOf` is the
 * tempting mistake: it reads as helpful typing, and it moves a per-screen list
 * into the cached prefix — busting it for every user on every navigation.
 *
 * Every field but `name` is omitted when it would state the common case, which
 * is why `field` and `disabled` are `true` rather than `boolean`. A screen with
 * eight controls should cost a line, not a paragraph.
 *
 * A per-row control is listed ONCE, with `per: "row"`, and addressed by row id.
 * Twenty rows with six controls each is six entries here, not a hundred and
 * twenty: a snapshot that grew with the row count would undo the cost argument
 * the rest of this file is written to protect.
 *
 * Note what is absent. There is no selector, no path, no coordinates and no
 * handle this library derived by looking at the page. `name` is a word the
 * app's author typed next to their own button, which is the same claim `Verb`
 * makes and the reason neither one rots when the CSS does. `Verb.at` is the
 * one selector in the library and it is presentational — never used to find
 * anything — so it is deliberately not mirrored here.
 */
export interface ScreenControl {
  /** The name the author marked on the element. What a control verb takes,
   *  matched exactly. */
  name: string;
  /** One short human label — the control's own text, usually. A model matches
   *  the user's words against this; `name` is only the handle. */
  label?: string;
  /** What using it does to the world, as the author declared it.
   *
   *  **Absent means the author did not say**, which is not `read` and must
   *  never be rendered or treated as one. It is an unreviewed button, and the
   *  only honest thing to do with it is to assume the strongest claim. See
   *  `packages/adapters/CONTROLS.md`. */
  kind?: VerbKind;
  /** `"row"` when the control appears on each row in `rows` and is addressed by
   *  row id. Omitted for a control that belongs to the screen itself. */
  per?: "row";
  /** Present only when the control takes text. */
  field?: true;
  /** Present only when the control is on screen and not actionable. Listed
   *  rather than hidden: the person can see the greyed-out button, so an agent
   *  shown nothing would conclude the feature does not exist instead of looking
   *  for the precondition that enables it. */
  disabled?: true;
}

/** One row of whatever the screen is showing. `id` is what verbs take. */
export interface Row {
  id: string;
  [column: string]: Scalar | undefined;
}

/**
 * What a human could see right now.
 *
 * The rule this type exists to enforce: an agent is never shown more than the
 * person at the keyboard. Same filters, same sort, same page. That is what
 * keeps the cost flat as the data grows — a hundred rows on screen is a
 * hundred rows in the prompt whether the table holds a hundred or a million —
 * and it is also what makes "park that one" resolvable without a query.
 */
export interface Snapshot {
  /** Where the user is, in their words: "contacts, filtered to Acme". */
  where: string;
  /**
   * Which screen that is, as a stable kebab-case id: `contacts`, `company`.
   *
   * `where` is prose for a human and carries everything else the person can
   * see — the filter, the sort, and on a drill-down a sentence about the record
   * they opened — so it changes constantly for reasons that are not navigation,
   * and "did I navigate?" cannot be answered by diffing it. This can be
   * compared with `===`, and that is its whole job.
   *
   * Dynamic, which is why it is here and not in the manifest: the *names* of
   * an app's screens and which verb belongs to which are static and go in
   * `Verb.screen`; which one is live right now is as per-turn as a row is.
   *
   * Absent means the app does not describe its screens, NOT that it has one.
   * An app that leaves it out keeps every behaviour it had: the core cannot
   * check a `Verb.screen` or a `CallOptions.screen` against nothing, and makes
   * no claim rather than inventing one.
   */
  screen?: string;
  /**
   * Monotonic, bumped on every change. An agent echoes it back to prove it is
   * acting on what it saw; see `stale` in PROTOCOL.md.
   *
   * It means "the snapshot changed", which is a wider thing than "the data
   * changed": a read-only navigation genuinely changes the snapshot, because
   * the person is looking somewhere else. That is right for `stale` -- the
   * question there is "is what you were looking at still what is on screen?"
   * -- and it is why a plan token does NOT turn on this number alone. A plan
   * asks a narrower question, "is the selection you counted still the
   * selection", and navigation does not touch it. See `selectionId`, and
   * `plansGoodAt` in the registry for what one number answering two questions
   * cost.
   */
  rev: number;
  /** Only the rows actually on screen. */
  rows?: Row[];
  /**
   * Present when `rows` is a window onto something larger.
   *
   * Three states, and the third exists because without it the type forces a
   * lie. **Absence is a claim that the agent is seeing everything** — so an
   * adapter reading a rendered table, which cannot tell a virtualised grid
   * from a short list, had no honest option: omit `page` and assert
   * completeness it cannot know, or invent a total. Either way an agent
   * eventually concludes a record does not exist because it could not see it.
   *
   *   page absent          these are all the rows there are
   *   page, total given    a window, and you know how big the whole is
   *   page, total absent   a window, and you do NOT know how big the whole is
   *
   * The third is the weakest claim and the right default whenever you are
   * reading the DOM rather than a store. An agent that needs certainty from it
   * must widen the window or use a `describe` verb that counts server-side.
   */
  page?: { index: number; size: number; total?: number };
  /**
   * Row ids the user has selected, in selection order. Resolves "this one".
   *
   * **Only the ids on screen belong here**, exactly like `rows`, and for the
   * same reason. `select-where` exists to select thousands of rows in one call,
   * so a driver that honestly fills this with every selected id puts tens of
   * kilobytes of ids into the UNCACHED half of every result from then on — paid
   * for on every turn, and on a big table straight through the relay's 1 MiB
   * body limit. An author who fills it with ten thousand ids has silently
   * broken their own token budget, which is the whole cost argument this type
   * exists to protect.
   *
   * So this field answers "which of the things in front of me is 'this one'",
   * and `selectedCount` answers "how big is the selection". Both are needed:
   * an agent cannot resolve a pronoun from a number, and cannot decide whether
   * a commit is safe from a truncated list.
   */
  selected?: string[];
  /**
   * How many rows are selected in all, including the ones off screen.
   *
   * The honest size of the selection, which `selected` deliberately does not
   * carry. Omitting it means "I do not count" — distinct from `0`, which is a
   * real answer — and when it is larger than `selected.length` the renderer
   * says so in words, because a model handed three ids and a bulk commit will
   * otherwise believe three rows are about to change.
   *
   * It is not a substitute for a `describe` verb's `Report.count`. That one is
   * the number a commit decision turns on at the moment it is made; this one is
   * a property of the screen, and is what makes a selection made several turns
   * ago still legible.
   */
  selectedCount?: number;
  /**
   * An opaque fingerprint of the WHOLE current selection, off-screen rows
   * included. The one input the plan token is built from.
   *
   * WHAT IT HAS TO BE. Equal when the selection has not changed, different when
   * it has — including when one row has been swapped for another, which is the
   * case a count cannot see. Nothing else is required of it: the core never
   * parses it, never orders it and never shows it to a model, so an app may use
   * any string that has that one property. `selectionId([...ids])` from this
   * package is the one to use unless you have a reason; it is order-independent
   * and cheap, and the reason it is exported is that an app computing its own
   * is an app that can get it wrong.
   *
   * WHY NOT THE TWO FIELDS ABOVE, which look as though they would do. `selected`
   * is by design only the ids on screen, so it cannot identify the 3,412-row
   * selection that `select-where` exists to make — and filling it honestly with
   * all of them is the token-budget mistake its own comment is about.
   * `selectedCount` is a number, and a number cannot tell a selection from a
   * different selection of the same size. Each would have produced a token that
   * looked like a guarantee and was not.
   *
   * It is one short string whatever the selection's size, which is why it can
   * be in the uncached half at all. An app with a large selection should keep a
   * running value rather than re-hash a large set inside `visible()`, which
   * runs on every call.
   *
   * IT IS ALSO WHAT MAKES LOOKING FREE. A plan token is refused when `rev` has
   * moved, and `rev` moves on a read-only navigation — so an agent that went
   * back to check its premise before an irreversible commit was refused, while
   * one that committed blind was not. The core now carries a plan across a
   * `kind: "read"` verb that moved `rev` **when this string is unchanged
   * across the call**, because that is the app saying the selection is the same
   * selection. This field is the whole of that permission.
   *
   * Absent means the app does not identify its selection — NOT that nothing is
   * selected. A `commit` that declares `consumes: "plan"` in an app that omits
   * this still gets a token, and the token still binds the `rev` and the count,
   * which catches every change the app bumps its `rev` for. It cannot catch a
   * change the app made without bumping `rev`, and the core says so once at the
   * first such call rather than letting the weaker check pass for the stronger
   * one. It also carries nothing across a navigation: an app that publishes no
   * identity keeps exactly the expiry it has always had, which is the fail-safe
   * direction, and the reason the permission above is hung on a field an app
   * either publishes or does not rather than on a counter an author has to
   * remember to bump.
   */
  selectionId?: string;
  /**
   * The controls the screen is offering right now.
   *
   * The second layer: `rows` is what the person can read, this is what they
   * could press. It is here rather than in the manifest for the same reason
   * `rows` is — which buttons exist changes with every navigation, and a verb
   * list that changed with the screen would be a prompt prefix that is never
   * cached twice. See `ScreenControl` and `packages/adapters/CONTROLS.md`.
   *
   * Absent means this screen does not describe its controls, NOT that it has
   * none. An app driven entirely by hand-written verbs never fills this in and
   * is no less drivable for it.
   */
  controls?: ScreenControl[];
  /** Anything else the agent needs and the rows cannot carry. Keep it short;
   *  this is the uncached half. */
  note?: string;
}

/**
 * What the agent gets back. Carries the snapshot AFTER the call, so acting and
 * observing are one round trip rather than two. With ten steps that is ten
 * saved model turns, each of which would have re-read the whole prefix — the
 * round trips, not the manifest, are what actually cost money.
 *
 * `count` is how a `describe` verb reports what it matched: "1,000 selected of
 * 3,412 matching". It is the number a human would have to see before pressing
 * a bulk button, and the reason `describe` and `commit` are separate verbs.
 *
 * A driver mounted in a page ALWAYS fills `snapshot`. That guarantee is worth
 * keeping in the type, so in-page callers never check for it. See `WireResult`
 * for the one case where it can be missing.
 */
export type Result =
  | {
      ok: true;
      note?: string;
      count?: number;
      /**
       * The plan token for the selection this call left behind, minted by the
       * core on a `describe` that reported a `count`. Present only there.
       *
       * It travels beside `count` because it means nothing without it: the
       * count is the number a person approves and this is what binds that
       * number to the set the next `commit` will touch. Pass it back as
       * `CallOptions.plan`. Opaque — a client stores it and forwards it, and
       * nothing outside the core that minted it reads anything out of it.
       */
      plan?: string;
      snapshot: Snapshot;
    }
  | { ok: false; refused: string; hint?: string; snapshot: Snapshot };

/**
 * What an agent receives over the relay: a `Result`, or a refusal from the
 * relay itself about a call that never reached a tab.
 *
 * The distinction is not pedantry. A relay can refuse because the tab id is
 * unknown, because the tab closed, or because the tab accepted the call and
 * went silent past the deadline. In none of those cases is there a screen to
 * report, and the alternatives are both worse than a missing field: inventing
 * an empty snapshot tells an agent the app has no rows, and returning a
 * different shape makes every client parse two shapes and handle the rarer one
 * badly.
 *
 * So the shape holds and `snapshot` goes missing, which is the truthful thing
 * to say — nothing ran and nobody looked. A client must read its absence as
 * "the call did not arrive", never as "the screen is empty".
 */
export type WireResult =
  | Result
  | { ok: false; refused: RelayRefusal; hint?: string; snapshot?: undefined };

/** Refusals that come from the relay rather than from an app's verb. Listed as
 *  a closed set so a client can tell "your app said no" (retry differently)
 *  from "your call never landed" (reconnect, or pick another tab). */
export type RelayRefusal = "no-such-tab" | "tab-went-away" | "timeout";

/**
 * One screen the app has, declared once in the cached half.
 *
 * THE GAP THIS CLOSES. `Snapshot.screen` says which screen is live and
 * `Verb.screen` says which screen a verb lives on, and between them an agent
 * could learn where it is and be refused where it is not — but it could not
 * learn that a screen EXISTS before standing on it. The library's own worked
 * example papered over that by pasting a prose screen-map into
 * `instructions` ("this is a CRM with six screens: a dashboard, a contacts
 * list, …"), which is a map written twice: once in the route table the app
 * already has, and once in English for the model, where nothing checks that
 * the two agree. So this is the map, as data, in the half that is cached.
 *
 * It is static for the same reason `Verb.screen` is, and the argument is the
 * one the whole library rests on: **the names of an app's screens are the same
 * for every user forever.** A CRM has a contacts list whether or not you have
 * any contacts, and whether or not you are allowed to see them. Only *which
 * screen is live* is per-user and per-minute, and that is `Snapshot.screen`.
 *
 * **THE CONSTRAINT THAT MATTERS, and the one an author will be tempted to
 * break: publish every screen the app has, not the screens THIS user can
 * reach.** A list filtered by role, by plan, by feature flag or by permission
 * is a per-user list, and a per-user list in the cached half busts the prompt
 * prefix for everybody — exactly as a per-screen tool list would, which is the
 * mistake `Verb.screen` exists to prevent one level down. Two users of the
 * same app must receive the same bytes here. If a screen is one this person
 * may not open, that is a REFUSAL from the navigate hook at the moment they
 * try, with a reason an agent can relay ("admin only"), and not an absence
 * from everybody's map: an absence is unfalsifiable, so an agent meeting it
 * concludes the feature does not exist and stops asking — the same failure
 * `ScreenControl.disabled` is listed rather than hidden to avoid.
 */
export interface ScreenSpec {
  /**
   * Stable, kebab-case, unique within a mount. **The same string
   * `Verb.screen` and `Snapshot.screen` compare**, which is the whole reason
   * this type has an id rather than only a name: three fields that spell the
   * screen three ways are three fields that disagree after the first rename.
   */
  id: string;
  /** One line for the model, in the user's vocabulary: "the contacts list:
   *  every contact, searchable, twenty rows at a time". Write it for a reader
   *  who cannot see your app and has never been to this screen — which is
   *  precisely the reader this field exists for. At most
   *  `SIZE_LIMITS.describe` characters; see that constant for why there is a
   *  bound at all. */
  describe: string;
  /**
   * An **RFC 6570** URI template for the screen, if it has an address:
   * `"#/contacts"`, `"#/companies/{slug}"`.
   *
   * RFC 6570 rather than a placeholder syntax of our own, because a route
   * table with holes in it is a solved problem with a registered media type
   * and a dozen implementations, and the alternative is a third dialect of
   * `:id` versus `{id}` versus `<id>` for every author to get wrong. Only
   * simple string expansion — `{var}` — is used by the core, which is the
   * level a route has; the syntax is the spec's so a template can be handed to
   * `uri-templates` or any other RFC 6570 library unchanged, and the core's
   * own expansion is tested against one.
   *
   * OPTIONAL, and absent is not a defect. A modal, a wizard step, a tab inside
   * a screen and the whole of a single-page app with no router are all screens
   * with no address, and a type that demanded one would push those authors
   * into inventing fake URLs. `goto` reaches an address-less screen exactly as
   * it reaches any other: the ID is the handle an agent uses, and the url is
   * what the app can use to get there, plus the one thing a person can paste
   * into a browser.
   */
  url?: string;
  /**
   * What the url template takes, by the template's own variable names.
   *
   * Typed, so the core can check `goto("company", { slug: 7 })` before any
   * navigation happens and refuse it as `bad-argument` the way every other
   * mistyped argument is refused — rather than expanding `7` into a URL and
   * landing the person on a screen with no record on it. `ArgSpec` rather than
   * a list of names for the reason verbs take `ArgSpec`: `oneOf` is cheaper
   * and safer than prose, and the refusal lists the accepted set.
   *
   * A screen whose template has a variable with no entry here still expands —
   * the value is taken as optional and an absent one expands to nothing, which
   * is RFC 6570's own rule — but it is undeclared, so nothing checks it and
   * the model is told nothing about it. Declare them.
   */
  args?: Record<string, ArgSpec>;
}

/**
 * Where a `goto` is trying to get to, handed to `MountOptions.navigate`.
 *
 * WHY THERE IS A HOOK AT ALL. The core cannot navigate. It has no router, no
 * `history`, no `location` and no DOM — it is the package that promises to
 * import nothing — and a core that pushed a URL would be guessing between
 * `pushState`, a hash, a framework's own router and a native app with no URLs
 * at all. It would also be the one place in driverkit that reached around the
 * app instead of through it, which is the same back door `Verb.at` is
 * deliberately not allowed to be. So the app supplies the one function it
 * alone can write, and the core supplies everything that is the same in every
 * app: the declared list, the uniqueness check, the argument types, the
 * expansion, the refusal when the screen is not one the app has, and the tool
 * description the model reads.
 */
export interface NavigateTarget {
  /** The `ScreenSpec.id` that was asked for. Already checked against the
   *  declared list, so a hook never sees a screen the app did not declare. */
  screen: string;
  /** The arguments, already checked against the screen's `args`. A hook may
   *  read them directly rather than re-parsing the url. */
  args: Record<string, Scalar>;
  /** The screen's `url` with `args` expanded, or absent when the screen
   *  declared no template. A hook that has a router usually ignores this and
   *  routes on `screen`; a hook on an app whose only addressing is the address
   *  bar assigns it to `location.hash` and is done. */
  url?: string;
}

/**
 * How the app navigates, for the core's reserved `goto` verb.
 *
 * Returns nothing for the ordinary case, `ctx.refuse(...)` for a screen this
 * person may not open or a record that does not exist, or a `Report` with a
 * `note`. It is the same contract as `Verb.run` on purpose: `goto` is an
 * ordinary verb whose body happens to be supplied through a different field,
 * and an author who already knows how to write a verb has nothing new to
 * learn.
 *
 * **A refusal here is how a per-user restriction is expressed**, and it is the
 * other half of `ScreenSpec`'s rule against filtering the declared list. "You
 * may not open the billing screen" is a fact about this person at this moment,
 * so it belongs in the dynamic half — said at the moment of the call, with a
 * reason — and never as a screen quietly missing from everybody's map.
 */
export type NavigateHook = (
  target: NavigateTarget,
  ctx: VerbContext,
) => void | Refusal | Report | Promise<void | Refusal | Report>;

/**
 * What the agent wants to know, handed to `MountOptions.ask`.
 *
 * One field today and a shape rather than a bare string all the same, because
 * the hook is implemented by a UI and a UI that took a positional argument
 * would have to be rewritten to be told anything else — `screen`, the verb that
 * prompted it, a suggested set of answers. A `{ question }` is the version of
 * this that can grow without every implementation changing.
 */
export interface AskQuestion {
  /**
   * What the agent is asking, in its own words, as it typed it.
   *
   * Never built by the core and never rewritten by it: a question the library
   * paraphrased is a question the person answers and the model did not ask.
   * Bounded at `SIZE_LIMITS.describe` and refused as `bad-argument` above
   * that — an agent that needs a paragraph to state its question has not
   * worked out what it does not know, and a wall of text in front of somebody
   * is a question they will dismiss.
   */
  question: string;
}

/**
 * What a person said, or the news that nobody did.
 *
 * THREE ANSWERS, AND THE SPLIT IS THE WHOLE DISCIPLINE OF THIS TYPE. The
 * library already keeps `approval-timeout` apart from `declined-by-user`
 * because "nobody answered" and "the person said no" are different facts an
 * auditor must never confuse. A question has the same hazard one layer over,
 * with a different pair:
 *
 *   a string             the person's words. They reach the model as the
 *                        RESULT of the ask, not as a side channel — see
 *                        `AskHook` — so a model reads an answer where it reads
 *                        every other outcome.
 *   `{ answered: false }` a question was put in front of somebody and no answer
 *                        came back: they closed the panel, walked away, or the
 *                        deadline lapsed. The agent is told plainly that the
 *                        question was seen by nobody who replied, and that
 *                        nothing in the app changed.
 *   `{ nobody: true }`   there is no person on this path at all. A cron run, a
 *                        test harness, a tab with no panel. The question was
 *                        never put.
 *
 * `{ answered: false }` AND `{ nobody: true }` ARE NOT ONE ANSWER, and the
 * repairs are why. Unanswered says the channel works and this particular
 * question went unanswered, so asking once more later, or more briefly, is a
 * move that can succeed. Nobody-to-ask says the channel does not exist on this
 * run, so every further question is wasted and the only honest ending is to
 * decide from what is already known or to stop and say what is missing. An
 * agent handed one word for both will keep asking into an empty room.
 *
 * There is deliberately NO "the person refused to answer". Somebody who says "I
 * would rather not say" has answered; their words are the result, and the model
 * is better at reading that sentence than the core is at classifying it.
 *
 * A HOOK THAT THROWS IS `{ answered: false }`, never `{ nobody: true }`. The
 * precedent is `ApprovalHook`, where a failed ask is a no — here a failed ask is
 * an unanswered question, because a broken question UI is not evidence that
 * nobody is sitting there, and claiming it is would tell an agent to stop asking
 * for the rest of a run over one exception.
 *
 * An answer that is none of these three is treated as `{ answered: false }` and
 * said out loud once. The same rule as `Approval`'s unknown shape being a
 * denial: the core must not read a shape it does not recognise as somebody
 * having spoken.
 */
export type AskAnswer = string | { answered: false } | { nobody: true };

/**
 * How the app puts a question to the person. The body of the reserved `ask`
 * verb.
 *
 * WHY THERE IS A HOOK AT ALL, which is the same answer `NavigateHook` gives:
 * the core cannot ask. It has no DOM, no panel, no notification channel and no
 * idea whether anybody is looking. What it CAN own — and does — is everything
 * that is the same in every app: the verb's name, its one argument, its
 * description, the lock that stops the agent acting while a question is open,
 * the deadline that keeps "nobody answered" a FACT rather than a transport
 * mystery, the allowance that stops an agent asking instead of thinking, and
 * the audit row.
 *
 * **DECLARED AT `mount()` AND NOWHERE ELSE, AND THIS IS NOT A CONVENIENCE.**
 * The approval gate has `DriverApproval.adopt`, so a panel mounted after the
 * driver can install one. A question cannot work that way, and the constraint
 * is the one the whole library is priced on: `system` and `tools` are
 * byte-identical on every turn so the prompt prefix stays cached, and a verb
 * that appeared when a panel mounted would be a tool list that changed
 * underneath a running conversation. So an app that may ever want to ask
 * declares this at mount; an app that declares nothing gets no `ask` verb, the
 * manifest it had before this field existed, and the same fingerprint.
 *
 * **THE ANSWER IS THE TOOL'S RESULT AND NOTHING ELSE KEEPS IT.** The person's
 * words come back as the `note` of the ask's own `Result` — `ok — they said:
 * "…"` — and the core stores not one byte of them. That is the structural half
 * of "a question is not consent": there is no field a later `commit` could
 * consult, no remembered yes, and `ApprovalRequest` has no way to reach an
 * answer, so the approval gate is asked exactly as it would have been if the
 * question had never happened. See `MountOptions.ask`.
 */
export type AskHook = (question: AskQuestion) => AskAnswer | Promise<AskAnswer>;

/**
 * One step of a `FlowSpec`: a verb, and a line about using it here.
 *
 * The shape is webmachinelearning/webmcp#340's `steps[].{section, tool, hint}`,
 * with `tool` spelled `verb` because that is what this library calls the
 * thing — and because a `tool` field whose value must be a verb name is a
 * field somebody will eventually fill with an MCP tool name instead.
 */
export interface FlowStep {
  /** The verb to call. Checked at `mount()` against the verbs that exist; see
   *  `Manifest.flows`. */
  verb: string;
  /** What to do with it HERE, in this flow: "sort by pending so the companies
   *  with work at the top", "read the count it reports before going on". The
   *  verb's own `describe` already says what the verb does; this says why this
   *  step exists and what to watch for, which is what a recipe is. */
  hint: string;
  /** An optional grouping label for a flow with phases — "find the company",
   *  "check the numbers". From #340's shape. Several consecutive steps may
   *  share one. */
  section?: string;
  /**
   * When this step may be skipped, in one line: "the person already named the
   * company". Present means the step is NOT load-bearing; absent means take it.
   *
   * THE GAP THIS CLOSES. A flow was a flat list in which every step read as
   * required, so a recipe with an optional first step had nowhere to say so and
   * the condition went into the `hint` — the worked example's own step one said
   * "If the person named the company, you can skip straight to `open-company`"
   * in the middle of a sentence about what `goto` is for. A reader cannot tell
   * from the structure which steps carry the job and which are there for the
   * case where you do not already know the answer, and neither can a model
   * skimming five of them.
   *
   * **IT IS A SENTENCE AND NOT AN EXPRESSION, AND THAT IS THE DESIGN.** The
   * obvious thing to put here is a machine-readable predicate — Arazzo has
   * `successCriteria`, VS Code has `when` clauses, and a `{ fact: "count", gt:
   * 500 }` would look like the same move. It is not, because **nothing in this
   * library evaluates a flow.** A flow is read and followed by the model (see
   * `FlowSpec`), so the only evaluator a predicate could ever have is the
   * reader it is written for, and a predicate read by a model is a sentence
   * with brackets round it: all of the precision is in the notation and none of
   * it is in the enforcement. That is worse than prose rather than better,
   * because a condition that LOOKS checkable gets trusted like one. A string
   * admits in its own type that this is a judgement call.
   *
   * WHERE THE CONDITIONS THAT MUST BE ENFORCED ACTUALLY LIVE, because "if the
   * count is over 500, ask first" is the example everybody reaches for and it
   * is already expressible in the one place where the core and not the model
   * holds the gate:
   *
   *     approve: (req) => (req.snapshot.selectedCount ?? 0) > 500
   *       ? askTheHuman(req)
   *       : true
   *
   * `ApprovalHook` runs at the moment of the commit, on the snapshot the core
   * read itself, and a model cannot route around it. `Verb.consumes` is the
   * same shape of answer for "do not commit a count you have not read". A
   * threshold written HERE instead would be a second, weaker copy of a gate the
   * library already enforces, and the copy is the one the model can misread.
   * So: conditions that decide whether DATA MOVES go in `approve`; conditions
   * that decide WHICH STEPS YOU TAKE go here, in words.
   *
   * One line, at most `SIZE_LIMITS.describe` characters, no newline, and it
   * counts against the flow's `SIZE_LIMITS.body` budget like a `hint` does —
   * it is rendered into the same cached prefix. An empty string is refused at
   * `mount()`: a step that is skippable for no stated reason is a step the
   * author has not decided about, and "optional" with no condition tells a
   * model it may drop a step whenever it likes.
   *
   * In `fingerprint()` with the rest of the flow, for the reason the steps are:
   * a step that has become optional is a different recipe, and an agent holding
   * the old cached copy is working from the version where it was required.
   */
  skipWhen?: string;
}

/**
 * WHY THERE IS NO ITERATION CONSTRUCT, since "do this for every company" is
 * the second thing anybody tries to write down here.
 *
 * It was considered and refused, and not on grounds of effort: a `forEach` over
 * a step list is small. It is refused because it is **against the grain of the
 * one safety mechanism this library actually enforces.** "For every company,
 * accept its pending contacts" is N commits. The whole `describe` → read the
 * `count` → `commit` apparatus, and the plan token that binds the second to the
 * first, exists to make ONE commit over many rows safe *instead of* many
 * commits over few — one count a person can check, one approval that names a
 * real number, one receipt. A declared loop would be the library's own manifest
 * teaching an agent to do the thing the plan token was built to stop: N
 * approvals that each look small, with nobody ever shown the total.
 *
 * And it is unnecessary in the case it is wanted for, because `Verb` already
 * answers it one level down: a verb that operates on many rows **takes a
 * predicate and resolves it inside the app**, where the rows already are. The
 * app that needs "every pending contact everywhere" declares
 * `select-where(status: "pending")` and gets one count and one commit; the
 * worked example has exactly that verb beside its per-company one. If an app
 * cannot express the job as a predicate, the loop is a judgement call about
 * data the agent has to look at between iterations — which is the argument in
 * `FlowSpec` for why nothing executes a flow, applied to the one construct that
 * would need to.
 *
 * So the honest form of "do this for every company" is a flow whose `describe`
 * says the job is per-company and whose steps are the one company's, plus the
 * agent repeating it and being gated each time. That repetition is not a gap
 * the notation should close. It is N approvals because it is N commits.
 *
 * WHY THERE IS NO `from: "step2.slug"` EITHER — no reference from one step to
 * an earlier step's output. It would require a named output to refer to:
 * `Verb.returns` or similar, since a verb's body returns `void | Refusal |
 * Report` and the only named things in a `Report` are a `count` and a `note`.
 * A half-wired reference — a `from` the model has to guess the meaning of
 * because no verb declares what it hands back — is the worst of the available
 * outcomes, so the choice was properly or not at all, and it is not at all:
 *
 *   - Carrying a value between steps means the AGENT holds it, and `Verb` is
 *     written against exactly that: "the agent should never learn an id it did
 *     not need". The steps of the worked example's own flow pass nothing —
 *     `open-company` moves the screen, `select-pending-here` needs no slug
 *     because it means *this* company, `accept-selected` needs no ids because
 *     it means *this* selection. The app holds the state between steps. That is
 *     not a missing feature of the flow notation; it is where this library
 *     decided state lives, and a `from` field would be the first thing to
 *     argue the other way.
 *
 *   - The ONE value that genuinely has to cross two steps is the plan token,
 *     and it is already declared — per verb, in the cached half, as
 *     `Verb.consumes` — and already *enforced* by the core rather than
 *     interpreted by the reader. A second declaration of it on the step would
 *     be a weaker copy of a check that works.
 *
 * What a flow now does about that one dependency is the little that can be done
 * honestly: `mount()` refuses a flow whose plan-consuming step has no earlier
 * `describe` step to mint the token (a recipe that cannot be followed, found at
 * startup instead of at the commit), and the renderer prints which step the
 * token comes from. Both are derived from what the verbs already declare. No
 * new field, nothing for an author to keep in step, and nothing claimed that
 * the core does not check.
 */

/**
 * A declared, static, READABLE recipe: the level above a single verb.
 *
 * WHY THIS EXISTS, in one sentence: an app's verbs say what can be done and
 * nothing says what is usually done with them, so every agent re-derives the
 * same five-step job from scratch, and the four of five that get it slightly
 * wrong get it wrong in a way nobody sees until the commit. Five independent
 * efforts arrived at the same level — webmcp#255 (`registerCollection`),
 * webmcp#161 (`registerSkill`), webmcp#340, OpenAPI Arazzo's `workflows[]`,
 * and Apple's app skills — which is the usual sign that the gap is in the
 * problem and not in one design.
 *
 * **THE AGENT READS THIS AND FOLLOWS IT. IT DOES NOT CALL IT.** That is the
 * whole design and it is a deliberate refusal to ship a workflow engine. A
 * flow that executed internally would run step 3 on an app whose state had
 * moved — the client already exists, the selection is empty, the record was
 * accepted by somebody else a second ago — and the only answers available to
 * it are to carry on or to stop, both blind, with the agent that could have
 * adapted holding nothing but an `ok`. Adapting mid-job is the one thing a
 * model is better at than a state machine, and handing the recipe to the model
 * keeps the adapting where the judgement is. Apple's app skills make the same
 * admission out loud — *"Skills don't enforce deterministic behavior, and Siri
 * doesn't run the listed intents in sequence"* — and it reads as a caveat only
 * if you expected an engine.
 *
 * **The `describe` carries the weight.** Microsoft's finding on plugin
 * selection across groups is that the choice *"is based on the plugin's
 * description, not on any of the individual functions"*: a model picking
 * between several flows reads these sentences and not the steps. So `describe`
 * is the field to spend the effort on, which is also why it has a documented
 * size budget — see `SIZE_LIMITS`.
 *
 * Static, so it rides in the manifest that was already being cached and costs
 * nothing per turn. That is the cheapest possible version of this feature:
 * nothing is sent per turn, nothing is computed per call, and an app that
 * declares no flows produces the manifest it produced before the field
 * existed, byte for byte.
 */
export interface FlowSpec {
  /** Stable, kebab-case, unique within a mount. An agent's handle on the flow
   *  when a person says "do the usual thing", and the string a transcript
   *  names. */
  id: string;
  /**
   * What this flow is for, in one line, in the user's own words: "accept a
   * company's pending contacts".
   *
   * The field a model chooses on. At most `SIZE_LIMITS.describe` characters
   * and **no newline**: it is a one-line label, and a paragraph here is a
   * paragraph that is read instead of the steps.
   */
  describe: string;
  /**
   * The steps, in order. At least one.
   *
   * Every `step.verb` must name a verb that exists, and `mount()` throws if
   * one does not — the way it throws on a duplicate verb name. A recipe citing
   * a verb nobody implemented is a dead end whose only symptom is an agent
   * halfway through a job getting `unknown-verb`, after the navigation and
   * before the commit, which is the worst place to find out.
   *
   * The same argument gets a second check: a step whose verb declares
   * `consumes: "plan"` must have an earlier step whose verb is a `describe`,
   * because the token can only come from one of those. A flow that commits
   * without counting first is a recipe whose only possible ending is
   * `stale-plan` — the same dead end, found at the same worst moment — and the
   * core can see it statically, from what the verbs already declare, so it says
   * so at `mount()` instead. Nothing new is written down for this: it is the
   * one piece of data flow between steps that exists, and it is declared on the
   * verb. See the note under `FlowStep` for why there is no other.
   */
  steps: FlowStep[];
}

/** The static half: hand this to a model once and cache it. Contains no data,
 *  no ids, no user, nothing that varies between two people or two minutes. */
export interface Manifest {
  /** Changes when the verb list changes, so an agent can tell its cached copy
   *  went stale without diffing. */
  version: string;
  app: string;
  /**
   * The app's own briefing, in its own words: "this app has screens —
   * dashboard, contacts, companies, settings — and `go` reaches those".
   *
   * It is here because it is static by definition and belongs in the half that
   * gets cached once. Before it there was nowhere: a widget could pass
   * `instructions` to `drive()`, an agent arriving through the relay or MCP
   * never saw those, and an app that needed to say something about itself to
   * BOTH paths had to put it in `Snapshot.note` — in the uncached half, paid
   * for on every single turn, for a sentence that never changes. That was the
   * one thing in the library the in-page path and the outside path disagreed
   * about.
   *
   * Static means static. No ids, no counts, no user, nothing that differs
   * between two people or two minutes; one per-screen word in here makes the
   * prefix uncacheable across users, which is where most of the saving lives.
   * It is in `fingerprint()` for that reason — it is part of what a cached
   * copy claims.
   */
  instructions?: string;
  verbs: Array<{
    name: string;
    describe: string;
    kind?: VerbKind;
    /** A CSS selector for the element this verb affects, if the app named one.
     *  A hint for a UI that wants to outline what is about to be touched, and
     *  nothing else: driverkit never resolves it and never sends it to a
     *  model. See `Verb.at`, which this is copied from. */
    at?: string;
    /** The screen, or screens, this verb belongs to; absent for "anywhere".
     *  Copied from `Verb.screen`, which carries the reasoning — above all why
     *  the tool list must NOT vary with the screen.
     *
     *  Copied in the SHAPE the app declared it, a string staying a string, so
     *  that a client written before verbs could name two screens goes on
     *  reading every single-screen app exactly as it did. A reader that wants
     *  one rule for both should normalise with an `Array.isArray` of its own
     *  rather than hope. */
    screen?: string | string[];
    /** `true` on a `commit` the app can undo. Copied from `Verb.reversible`;
     *  absent makes no claim. */
    reversible?: true;
    /** `"plan"` on a `commit` that may only be called with the token from the
     *  `describe` that counted what it is about to touch. Copied from
     *  `Verb.consumes`; absent means it may be called bare, which is what every
     *  commit written before this field does.
     *
     *  In the cached half because it has to be: a client renders a tool schema
     *  and a description from this once and caches both, and "you must run the
     *  `describe` first and pass what it gave you" is a fact an agent should
     *  read there rather than discover by being refused. The same argument as
     *  `refuses` and `screen`. */
    consumes?: "plan";
    args?: Record<string, ArgSpec>;
    refuses?: string[];
  }>;
  /**
   * The app's map: every screen it has, declared once.
   *
   * Copied from `MountOptions.screens` and in `fingerprint()`, because it is
   * part of what a cached copy claims about the app — a screen that gained a
   * url template, or whose `describe` was rewritten, is a screen a model was
   * briefed about in the app's old words.
   *
   * Absent means the app does not describe its screens, NOT that it has one.
   * Exactly `Snapshot.screen`'s rule, and for the same reason: an app mounted
   * before this field existed must read identically.
   *
   * See `ScreenSpec`, and above all its rule against publishing only the
   * screens the current user can reach.
   */
  screens?: ScreenSpec[];
  /**
   * The app's recipes: the multi-step jobs its verbs are usually combined
   * into. Read and followed by the agent, never called. See `FlowSpec`.
   *
   * In `fingerprint()` for the reason `kind` and `screen` are: a flow is
   * rendered straight into the cached system prompt, so an agent holding the
   * old manifest is working from the app's old recipe — one that may name a
   * verb this version has renamed.
   */
  flows?: FlowSpec[];
}

/**
 * Where a tab stands in the person's attention, as the page itself reports it.
 *
 * Three states and not a boolean, because the honest answer has three cases
 * and a boolean would have to lie about one of them:
 *
 *   `"focused"`  the active tab of the frontmost window. The person is looking
 *                at THIS. `document.visibilityState === "visible"` AND
 *                `document.hasFocus()`.
 *   `"visible"`  the active tab of its window, but the window is not frontmost
 *                — the person is in another application. Visible, not looked
 *                at. This is the state a two-state field would have had to
 *                call either "focused" (and send an agent to a window nobody
 *                is in front of) or "hidden" (and lose the only honest answer
 *                to "which one was I last in?").
 *   `"hidden"`   a background tab, or a minimised window.
 *
 * It is reported by the page and never inferred by a relay: the only process
 * that can see `document.hasFocus()` is the document. A relay carries the
 * string and has no opinion about it, exactly as it carries `rev`.
 *
 * ABSENT IS UNKNOWN, NOT HIDDEN. A tab driven by a hand-written `fetch` loop,
 * or a page that passed `focus: false` to `connect()`, reports nothing — and a
 * client that read absence as "not the one" would quietly stop being able to
 * drive it at all.
 */
export type TabFocus = "focused" | "visible" | "hidden";

/**
 * One row of `GET /dk/tabs`.
 *
 * Declared here rather than left in the protocol document because this is the
 * listing every client hits first, and it carries a subtlety prose loses: the
 * id field is `tab`, not `id`, spelled the same as in the `hello` frame. A
 * client that re-derived this shape from the markdown is exactly how the first
 * version of it ended up mutually incompatible between two implementations.
 *
 * `manifestVersion` is lifted out of the manifest so a client can tell whether
 * its cached copy is current without fetching the whole thing — which is the
 * only reason the version exists.
 */
export interface TabInfo {
  tab: string;
  app?: string;
  /** Only so a human can tell two tabs apart when asked "which one?". */
  title?: string;
  url?: string;
  manifestVersion?: string;
  rev?: number;
  /**
   * Where the person's attention is, as the page itself last reported it.
   *
   * The field that answers "the one I am looking at" — which is what a person
   * means when they say which tab, and the one thing `--tab <id>` could never
   * express. See `TabFocus` for the three states, and PROTOCOL.md for the rule
   * a client applies when more than one tab is a candidate.
   */
  focus?: TabFocus;
  /** ISO 8601. A string on purpose: nothing computes with it, and parsing it
   *  would invent a failure mode for a field only ever shown to a person. */
  since?: string;
}

/**
 * What an approval is being asked about.
 *
 * Structurally identical to `driverkit/agent`'s `CommitRequest`, on purpose
 * and not by coincidence: the widget's dialog was written against that shape
 * and is now an implementation of THIS hook, so the two types have to be the
 * same four fields or the one working confirmation UI in the repository would
 * need a shim to be reusable. A function that satisfies one satisfies the
 * other.
 *
 * `verb` is the manifest entry rather than the `Verb`, so an approval UI reads
 * `kind`, `reversible` and `refuses` — the declared facts a person's question
 * should be worded from — and cannot reach `run`. A gate that could call the
 * body it is gating is a gate with a way round itself.
 */
export interface ApprovalRequest {
  name: string;
  args: Record<string, Scalar>;
  verb: Manifest["verbs"][number];
  /** The screen as it is right now, so a question can name the selection the
   *  commit is about to act on. Read before the verb runs. */
  snapshot: Snapshot;
}

/**
 * What an approval hook answers.
 *
 * Three outcomes, because there are three things that can happen when you ask
 * a person: they say yes, they say no, or they are not there.
 *
 *   `true` / nothing      allow. Nothing is a yes so a hook may fall through
 *                         its own cases without accidentally denying.
 *   `false`               deny, with the core's own wording.
 *   a string              deny, and the string becomes the hint the agent is
 *                         told. This is the useful one: "not until finance
 *                         signs off" is something a model can act on and
 *                         "declined" is not.
 *   `{ timedOut: true }`  nobody answered. Distinct from `false`, which is a
 *                         person deciding; see `approval-timeout` in
 *                         `RESERVED_REFUSALS`.
 *   `{ asked: false }`    allow, and say that nobody was asked. See below.
 *
 * Anything else — an object that is none of these — is treated as a DENIAL and
 * never as consent. A hook that returns a shape the core does not recognise
 * has not approved anything, and reading an unknown answer as yes is how a
 * refactor that changes a return type silently removes the gate.
 *
 * WHY THERE IS A FOURTH ANSWER, AND IT IS THE RECORD'S FAULT. A real gate does
 * not ask about every commit: the widget's dialog lets a `reversible` commit
 * under its size threshold through without a question, and lets every commit
 * through when the person has switched confirmations off. Such a hook used to
 * have to answer `true`, which is right about the call and a lie in the
 * record — the core writes `approval: "allowed"`, and that claims somebody
 * said yes. `{ asked: false }` allows the call and records `not-asked`, which
 * is what actually happened. A gate that asks every time never needs it, and
 * `true` still means "asked, and the answer was yes" for every hook written
 * before this existed.
 */
export type Approval =
  | boolean
  | string
  | void
  | { timedOut: true; hint?: string }
  | { asked: false };

/** The hook itself. Async because a human is on the other end of it; a
 *  synchronous gate can only ever consult a policy, never a person. */
export type ApprovalHook = (req: ApprovalRequest) => Approval | Promise<Approval>;

/**
 * What `MountOptions.approve` accepts: a hook, or the word `"unattended"`.
 *
 * `"unattended"` is not a hook that returns true. It is the app SAYING OUT
 * LOUD that commits on this driver run with no person in front of them —
 * which is a legitimate configuration (a cron job, a test harness, a backend
 * that has already done its own authorisation) and is also the dangerous one,
 * so it is written down rather than reached by leaving a field out. See
 * `MountOptions.approve` for the argument, and `connect()` for the one place
 * the absence of either becomes an error.
 */
export type ApprovalPolicy = ApprovalHook | "unattended";

/**
 * The approval state a mounted driver publishes.
 *
 * Three things live here and they are for three different readers. `declared`
 * is for whoever is about to publish this driver to the outside — `connect()`
 * reads it and refuses to publish a driver whose irreversible commits nobody
 * has said who approves. `policy` is for a reader of the RECORD: who is
 * actually asked right now, which is not always what the app declared. `hold`
 * is for an approval UI that is not an approver at all: a host's own modal that
 * gates outside `call()` and needs the core to stop taking calls while its
 * question is open.
 */
export interface DriverApproval {
  /**
   * Who is asked about a commit on this driver RIGHT NOW.
   *
   * Four values, and the fourth is the one worth reading about. Three of them
   * are what the app wrote at `mount()` and are also `declared`: `none`,
   * `hook`, `unattended`. The fourth, `adopted`, means an approver was
   * installed after `mount()` by something in the page — see `adopt` — and it
   * is a weaker claim than `hook` on purpose:
   *
   *   `hook` is a line in the app's own source. It is there before the first
   *   call and it is there for every path, so `connect()` accepts it as the
   *   declaration it requires.
   *
   *   `adopted` is a gate that exists only while whatever installed it is
   *   still mounted. A panel that is unmounted takes its dialog with it and
   *   this goes back to `declared`. That is a real gate while it lasts, and
   *   it is not a statement the app made, so it does not satisfy `connect()`.
   *
   * Folding the two into one word was the alternative and it is the one thing
   * this field must not do: an auditor reading `hook` on every record would
   * have no way to tell the app's own gate from one that happened to be on the
   * page that afternoon, and a field that cannot be wrong is a field that
   * cannot be checked.
   *
   * It is a live read, not a constant: the same driver answers `none` before
   * a panel mounts and `adopted` after, because that is the truth about which
   * commits had a person in front of them.
   */
  readonly policy: "none" | "hook" | "unattended" | "adopted";
  /**
   * Which of the three the app itself declared at `mount()`, for all time.
   *
   * Never moves, and that is what it is for. `policy` answers "is there a gate
   * on this driver now"; this answers "did the app say who approves", which is
   * the question `connect()` asks before publishing a driver to an outside
   * agent. The two were one field until the widget could install a gate of its
   * own, and merging them would have made mounting a panel quietly satisfy the
   * check that exists to make somebody write a sentence.
   *
   * Optional, so a hand-written `approval` from before this existed still
   * satisfies the interface; a reader falls back to `policy`, which is what it
   * meant then. See `Driver.approval`.
   */
  readonly declared?: "none" | "hook" | "unattended";
  /**
   * Install an approver now, for a dialog that lives in the page.
   *
   * WHAT IT IS FOR. The widget's confirmation is the one working approval UI
   * in this repository and it used to gate OUTSIDE `call()` — `hold` the lock,
   * ask the person, then call the verb. The core never saw the question, so an
   * app that mounted the panel and wired `onAudit` and nothing else recorded
   * `approval: "not-asked", policy: "none"` for a commit a person had just
   * clicked Approve on. That record reads as complete and says the opposite of
   * what happened, which is the one thing an audit trail cannot do.
   *
   * WHO WINS. The app does, always. This returns `null` and installs nothing
   * when the app declared `approve` of either kind:
   *
   *   a declared `hook` is already asked on every path, so there is nothing to
   *   fix and nothing to argue about — and replacing it would mean a commit
   *   got two dialogs, or the app's own gate silently stopped running.
   *
   *   `unattended` is the app saying out loud that commits here run with
   *   nobody in front of them. An approver installed over the top of that
   *   would make an unattended driver interactive, which is the configuration
   *   somebody deliberately chose against.
   *
   * It also returns `null` when another adopter already holds it. First one
   * wins, because two gates for one commit is two dialogs, and the second
   * caller is told out loud rather than left believing it is the gate.
   *
   * RELEASING. The return value is a disposer, and calling it is not optional
   * for anything that can be torn down: an approver whose UI is gone is a
   * driver where every later commit waits forever on a dialog nobody can see.
   * After it runs, `policy` is `declared` again and the next adopter can win.
   * A disposer only ever releases its own hook, so a late one cannot unhook
   * whoever came after it.
   *
   * Optional on the interface, like the rest of `approval`: a hand-written
   * driver need not offer it, and a caller that finds it absent is on the
   * driver this mechanism did not exist on.
   */
  adopt?: (hook: ApprovalHook) => (() => void) | null;
  /**
   * Run `ask` with the driver's no-other-calls lock held.
   *
   * While it is held, every `call()` on this driver is refused
   * `approval-pending`. That is what stops an agent from pressing the Approve
   * button of the dialog that is asking it about something else — see
   * `RESERVED_REFUSALS` and webmachinelearning/webmcp#288 — and it is why the
   * widget's dialog goes through here even when the app declared no core hook.
   *
   * The verb's own call is not blocked by its own approval: the core clears
   * the lock before it runs `run`.
   */
  hold: <T>(verb: string, ask: () => Promise<T>) => Promise<T>;
}

/**
 * One thing an agent did to this app, as it happened.
 *
 * WHY THIS EXISTS. The library commits data on a person's behalf — the whole
 * design is about making a 3,412-row bulk accept safe — and until this it kept
 * no record that it happened. Who approved it, which plan token, what count,
 * at what `rev`, on which screen: "what did the agent do yesterday?" had no
 * answer. RPA tools have had an audit log for twenty years.
 *
 * WHY A HOOK AND NOT A SINK. The host already has somewhere for this to go:
 * one adopter runs OpenTelemetry, the next has Datadog, the next a table in
 * their own database. A library that picks your logging backend is a library
 * you fight, so this one emits a structured record and owns nothing else.
 * `driverkit/otel` is one such sink, kept behind its own entry point that
 * nothing in here imports.
 *
 * AND WHY THE SINK CANNOT BE THE RELAY OR THE PYTHON PACKAGE. The in-page
 * widget — the case most likely to commit data, because somebody is sitting
 * there — has no relay and no Python in it at all. An audit trail that only
 * existed for the relay case would be worse than none, because it would look
 * complete.
 *
 * WHERE IT IS EMITTED FROM, which is the property that makes it worth
 * trusting: the record is built from the `Result` that `call()` is about to
 * return, in the same place that `Result` is decided, and every field it
 * carries beyond the result was written down by the step that decided it — the
 * approval answer by the gate, the plan by the mint and the burn. Nothing here
 * is reconstructed by a second reading of the app, because a log that can
 * disagree with the `Result` is worse than no log.
 *
 * ONE EVENT PER `call()`, whichever path the call came in on — the in-page
 * loop, a relay frame, a test with no transport — including the calls that
 * never reached a verb at all. A refused call is the most interesting line in
 * an audit trail: `declined-by-user` is a person saying no, `stale-plan` is an
 * agent trying to spend a receipt for a count that moved, and a log that only
 * recorded successes would have nothing to say about either.
 *
 * ---
 *
 * **HOW A QUESTION APPEARS IN HERE, AND WHY IT NEEDED NO NEW FIELD.** An `ask`
 * is a human interaction and belongs in the record as much as an approval does,
 * and the fields already here say all of it — which is worth spelling out
 * because the instinct is to add an `asked:` enum beside `approval`, and a
 * second way to say one thing is a second thing to get wrong.
 *
 *   `verb: "ask"`, `kind: "ask"`   this row is a question.
 *   `args.question`                what was asked, as the agent typed it.
 *   `waitedMs`                     how long it was open. **Present exactly when
 *                                  a question reached somebody**, which is the
 *                                  field that tells "asked" from "never put".
 *   `ok: true`                     asked AND ANSWERED.
 *   `refused: "ask-unanswered"`    asked AND IGNORED. `waitedMs` says for how
 *                                  long.
 *   `refused: "nobody-to-ask"`     never put: no person on this path.
 *   `refused: "asks-spent"`        never put: the allowance was gone.
 *
 * So "asked and answered" and "asked and ignored" are two values of a field
 * that already exists, and the two kinds of not-asking are told apart by slug
 * and by the absence of `waitedMs`. `approval` stays `not-asked` on every one
 * of these rows, because nobody approved anything: a question is not consent,
 * and a record in which a question could read as an approval would be the
 * bypass this feature was built not to be.
 *
 * **WHAT THE ANSWER'S TEXT IS DOING OUTSIDE THE RECORD, DELIBERATELY.** The
 * person's words are the `Result`'s `note` and the core keeps no copy, so they
 * are not here. That is the same argument `ArgSpec.sensitive` makes about this
 * very hook being "the one boundary where a record is most likely to leave the
 * box": an answer is free text a person typed, it may be anything, and a host
 * that wires `onAudit` straight to a vendor's tracer should not thereby ship it
 * there. What an auditor needs is that a question was asked, what it was, and
 * whether somebody answered — all of which is above. If you need the words,
 * they are in the transcript, which is the artefact that is supposed to hold
 * what was said.
 */
export interface AuditEvent {
  /** `Date.now()` when the call settled. Milliseconds since the epoch, not an
   *  ISO string: a host formats it its own way, and a number cannot be
   *  mistaken for a timezone-bearing claim this library is not making. */
  at: number;
  /** How long the call took, in milliseconds, approval included. The gap
   *  between a question being asked and a person answering it is the part of a
   *  bulk commit a reader most often wants back. */
  ms: number;
  /**
   * How much of `ms` was spent waiting for an approval to be answered.
   *
   * Present only when somebody was actually asked — so its absence means no
   * question was open and `ms` is the app's own work, start to finish.
   *
   * **Why both numbers and not one.** `ms` is deliberately approval-inclusive:
   * "this bulk accept took 41 seconds from the agent's point of view" is the
   * fact an auditor wants, and a record that silently excluded the human would
   * make a slow decision look like a fast app. But the two are different
   * quantities and only one of them is about the software — `ms - waitedMs` is
   * how long the verb took, and `waitedMs` is how long a person took — and a
   * record that gave only the sum cannot be used to answer either question.
   * Subtracting is cheap; recovering a figure that was never written down is
   * not.
   *
   * The same separation reaches the MODEL by a different route and for a
   * sharper reason: see `DriveOptions.timing`, where the duration a model is
   * shown is measured so as to EXCLUDE this from the start. An auditor reading
   * "41 seconds, 38 of them waiting" draws the right conclusion; a model told
   * "this call took 40 seconds" draws the wrong one about the app's speed and
   * routes around a verb that is not slow.
   */
  waitedMs?: number;
  /** `MountOptions.app`. Two drivers can be mounted on one page — a widget and
   *  an embedded view — and an unattributed record is one you cannot act on. */
  app: string;
  /** The verb. `goto` is the core's own and appears here like any other. */
  verb: string;
  /** As DECLARED. Absent means the app made no safety claim about this verb,
   *  which is a fact worth keeping in the record rather than defaulting away:
   *  an auditor asking "what commits ran" must be able to see that some verbs
   *  never said. */
  kind?: VerbKind;
  /** As declared. Absent makes no claim; see `Verb.reversible`. */
  reversible?: true;
  /**
   * The arguments AS SENT, with one exception, named by `redacted`.
   *
   * As sent, not as validated: an argument of the wrong type, or one the verb
   * never declared, is exactly what an audit reader is looking for when a call
   * went wrong. The core does not strip undeclared arguments from the record
   * for the same reason it does not strip them from the call.
   */
  args: Record<string, Scalar>;
  /** The argument names whose values were replaced with `REDACTED`, because
   *  the verb declared them `ArgSpec.sensitive`. Present only when something
   *  was replaced, so the absence of this field means the `args` above are
   *  the whole truth. */
  redacted?: string[];
  /** `Snapshot.screen` the call ran against, read once, before the verb. */
  screen?: string;
  /** `Snapshot.rev` the call ran against. With `screen`, this is what the
   *  record needs to be re-readable later: "3,412 rows at rev 180 of the
   *  contacts screen" is a claim somebody can go and check. */
  rev: number;
  /** What the agent CLAIMED it was acting on, when it claimed anything. Kept
   *  beside the two above rather than folded into them, because the difference
   *  between them is the whole of a `stale` or a `wrong-screen`, and a record
   *  that kept only one side could not show why the call was refused. */
  claimed?: { rev?: number; screen?: string };
  /** `Result.ok`. */
  ok: boolean;
  /** The refusal slug, present exactly when `ok` is false. The app's own slug
   *  or a reserved one; see `RESERVED_REFUSALS`. */
  refused?: string;
  /** `Result.count` — what a `describe` reported it matched. The number a
   *  person approves, and the reason this field is in the record. */
  count?: number;
  /** The plan token this call PRESENTED, when the verb consumes one. Recorded
   *  whether or not it was accepted: a rejected token is how you find the
   *  agent that tried to spend a stale receipt. */
  plan?: string;
  /** The plan token this call MINTED, on a `describe` that counted. The join
   *  key for the two halves of a gated bulk commit: the event that carries
   *  this one as `minted` reported the count, and the event that carries it as
   *  `plan` is the commit that spent it. That pair is the answer to "who
   *  approved 3,412 rows, and was 3,412 the number that moved". */
  minted?: string;
  /**
   * How the approval question was answered.
   *
   *   `allowed`    a hook said yes.
   *   `declined`   a hook said no — a person deciding.
   *   `timed-out`  nobody answered. The verb did not run.
   *   `not-asked`  nobody was asked, and `policy` says why.
   *
   * Four values, not three, because "declined" and "never asked" are the two
   * an auditor must never confuse: one is a person refusing and one is a gate
   * that was not there.
   *
   * `not-asked` has two shapes and `policy` tells them apart. With a `policy`
   * of `none` or `unattended` there was no gate: nothing could have asked.
   * With a `policy` of `hook` or `adopted` there WAS a gate and it let this
   * commit through without a question — a reversible verb under the panel's
   * size threshold, or confirmations switched off — which is a gate's decision
   * and not a person's, so it is not `allowed`. See `Approval`'s
   * `{ asked: false }`.
   */
  approval: "allowed" | "declined" | "timed-out" | "not-asked";
  /**
   * Who was in a position to be asked, at the moment of this call.
   *
   * It is what turns a `not-asked` from a silence into a sentence:
   * `unattended` is an app saying out loud that commits here run with nobody
   * in front of them, `none` is an app that never said, and `hook` or
   * `adopted` beside a `not-asked` is a gate that was there and decided this
   * particular commit did not need a question.
   *
   * Read per call rather than once at `mount()`, because a page can acquire a
   * gate after it starts: `adopted` is a panel's dialog installed by
   * `DriverApproval.adopt`, and the same driver's earlier records honestly say
   * `none`. See `DriverApproval.policy` for why that is a different word from
   * `hook` and not a synonym for it.
   */
  policy: DriverApproval["policy"];
}

/**
 * Where the records go. See `MountOptions.onAudit`.
 *
 * Returns nothing. A promise is tolerated and is NOT awaited; see the hook's
 * own documentation for why this one differs from `ApprovalHook`, which is.
 */
export type AuditHook = (event: AuditEvent) => void | Promise<void>;

/**
 * What one driver tells the other drivers of the same app when a commit lands.
 *
 * The whole payload, and it is deliberately two strings of the core's OWN
 * making. `verb` is a name out of this driver's verb table and `from` is the
 * driver's own identity; neither is app data, neither is a row, neither is a
 * count. A notice that carried the new rows would be a cross-tab replication
 * protocol, which is the app's problem and not a library's — and it would be a
 * leak besides, since the two tabs may not be showing the same person's data
 * if the app got that wrong.
 *
 * It says "something changed, and it was not your copy that changed it". That
 * is the only fact a sibling tab cannot work out for itself, and it is enough
 * to stop that tab claiming freshness it has not got.
 */
export interface ElsewhereNotice {
  /** The `commit` verb that ran. Named so a refusal can say what happened
   *  rather than "something changed somewhere", which an agent cannot act on. */
  verb: string;
  /** The driver that sent it. A driver ignores its own notices; without this
   *  a `BroadcastChannel` that echoed to the sender would make every commit
   *  poison the tab that made it. Opaque, and minted per `mount()`. */
  from: string;
}

/**
 * How the drivers of one app in different tabs hear about each other's commits.
 *
 * THE HOLE THIS EXISTS TO CLOSE. `Snapshot.rev` is the app's claim that its
 * data has not moved, and it is bumped by the app's own mutation path. Two
 * tabs of the same app over one backend: an agent commits in tab A, tab B's
 * data has changed, and B's `rev` has not moved, because B's store never heard.
 * So B's snapshot reports stale rows as current, a `stale` check against B's
 * `rev` PASSES, and a plan token minted in B still verifies — the whole
 * staleness machinery passing in exactly the situation it exists to catch.
 *
 * Nothing inside tab B can see that. Every value a check could be built from —
 * `rev`, `selectionId`, a count, a hash of the rows — comes out of `visible()`,
 * which reads B's own store, and B's own store is the thing that is wrong. The
 * fact has to arrive from outside, and the core's own commit is the only thing
 * that knows it.
 *
 * SO THIS IS A TRANSPORT AND NOT A POLICY. Two functions, no server, no
 * authority. `driverkit/browser` ships `broadcastElsewhere()`, a
 * `BroadcastChannel` implementation that works same-origin with no relay at all
 * — which matters, because an app driven only by its own in-page panel has no
 * relay to route anything through. An app that already has a websocket or a
 * service worker implements the same two functions over it and gets the same
 * check. The relay deliberately does NOT do this: it grants no authority and
 * knows nothing about verbs, and a relay that read `kind` out of a manifest to
 * decide what to announce would be a second place that decides what a commit
 * is.
 *
 * WHAT IT BUYS, STATED HONESTLY. It does not make tab B's data correct — only
 * the app refetching does that, and an app that listens on this channel itself
 * and refetches is the real fix. What it buys is that B stops lying in the
 * window before that happens: a `commit` in B is refused `changed-elsewhere`,
 * and every snapshot B hands back says so in words. See `MountOptions.elsewhere`.
 */
export interface ElsewhereChannel {
  /**
   * Broadcast a notice. Called by the core after a `commit` verb's body runs.
   *
   * Must not throw usefully — the core catches and warns, because a failed
   * broadcast is not a reason to turn a commit that already happened into an
   * error.
   */
  post: (notice: ElsewhereNotice) => void;
  /**
   * Subscribe. Called once at `mount()`.
   *
   * The returned function, if there is one, is called at `unmount()`. Returning
   * nothing is allowed so that a three-line channel in a test need not invent
   * one.
   */
  listen: (heard: (notice: ElsewhereNotice) => void) => (() => void) | void;
}

/**
 * A hard ceiling on what one mounted driver will ever spend.
 *
 * `DriveOptions.maxSteps` bounds ONE run. Nothing bounded runs. An agent in a
 * loop re-enters `drive()` with a fresh `maxSteps` every time, and a widget
 * somebody leaves open in a tab over a long weekend has no bound at all — so
 * the app's API and somebody's token budget were both unprotected by
 * construction, not by oversight.
 *
 * WHY THIS IS IN `mount()` AND NOT IN THE WIDGET'S SETTINGS. The settings view
 * owns what a VIEWER is comfortable with: the pace, step mode, whether the
 * panel explains itself. A spend limit is not a comfort, it is somebody else's
 * money, and a viewer who can raise their own ceiling does not have one. So it
 * is declared where the app is declared, by the person who pays. The settings
 * view may SHOW it — see `Driver.budget`, which exists so it can — and must
 * not offer to change it.
 *
 * WHAT IS BOUNDED, AND WHAT WAS REJECTED.
 *
 *   `calls`   — every `call()` this driver ever accepts, refused ones
 *               included. This is the bound that matters. It is a bound on the
 *               app's own API, because every verb body is behind it, and it is
 *               a bound on tokens, because an agent spends a model round trip
 *               to produce each one. Refused calls count on purpose: an agent
 *               spinning on `bad-argument` is precisely the runaway this
 *               exists for, and a counter that only counted successes would
 *               never fire on it.
 *
 *   `commits` — `kind: "commit"` verbs that actually ran. A second counter
 *               rather than a stricter first one, because the two bound
 *               different costs: a thousand reads costs tokens, and a
 *               thousand commits costs DATA. An app may happily allow the
 *               first and not the second, and one number cannot say that.
 *
 *   `asks`    — questions actually put to somebody. A third counter by the
 *               same argument the second one is made of: a thousand reads
 *               costs tokens, a thousand commits costs data, and a thousand
 *               questions costs A PERSON'S PATIENCE, which is the one of the
 *               three that cannot be topped up. One number cannot bound all
 *               three because an app may well want two hundred calls, ten
 *               commits and three questions.
 *
 *               It is the counter with the sharpest failure mode behind it: an
 *               agent that is confused can ask instead of thinking, and each
 *               question looks individually reasonable while the sequence is a
 *               person being interrogated by something that has stopped
 *               working. `drive`'s `refusalLimit` cannot see it, because every
 *               one of those questions SUCCEEDS.
 *
 *               It refuses `asks-spent` and never `budget-spent`, and that is
 *               the one place this field departs from the two above. See the
 *               slug in `RESERVED_REFUSALS`: those two end in no repair — stop,
 *               and tell the person — and this one ends in a real one, which is
 *               to say in the final answer what you would have asked.
 *
 * REJECTED: **runs per minute**, or calls per minute, or any rolling window.
 * It is the one that looks most like a cost control and is the least like one.
 * A rate limit converts an unbounded spend into a slower unbounded spend — the
 * runaway loop still runs forever, just politely — so it bounds instantaneous
 * load and not cost, and it is a ceiling nobody can ever hit and therefore a
 * ceiling that never says anything. An app that genuinely needs load shedding
 * has it at the server, where a client-side limiter is advisory anyway.
 *
 * REJECTED: **model round trips.** It is the thing an author actually wants to
 * cap, and the core cannot see one. `call()` is the only place every path
 * converges; a round-trip count would have to be reported by the loop, and the
 * loop is the consumer being limited. A number the limited thing reports about
 * itself is not a limit. `calls` is the honest proxy, and the relationship is
 * close: one tool call is one round trip in every tool-use API there is.
 *
 * REJECTED: **total steps per session** as a third field. That is `calls`
 * under another name — `drive()`'s steps are verb calls — and two fields for
 * one quantity is two fields that come to disagree.
 *
 * Absent, or a field absent, means no ceiling: an app mounted before this
 * existed behaves byte-identically, and the manifest and its fingerprint do
 * not move, because a spend limit is a runtime arrangement and not part of the
 * surface an agent caches.
 */
export interface Budget {
  /** Most calls this driver will ever accept. Omitted means no bound. A
   *  non-positive number is refused at `mount()`: it means the app is never
   *  drivable, which nobody means, and it would make every call fail with no
   *  hint that a budget was the cause. */
  calls?: number;
  /** Most `commit` verbs this driver will ever run. Omitted means no bound. */
  commits?: number;
  /**
   * Most questions this driver will ever put to a person. Omitted means no
   * bound, which is the same default the two above have and is deliberately
   * not a small number: a ceiling the library picked would be a ceiling that
   * fires in somebody's app for a reason they never wrote down.
   *
   * Counted only when a question actually reached the hook — a question
   * refused for a spent allowance, or one the app answered `{ nobody: true }`
   * to, charged nothing, because neither one took anybody's attention.
   */
  asks?: number;
  /**
   * Where the counters are kept, so a page reload does not refill them.
   *
   * **WHY THIS IS NOT OPTIONAL POLISH.** Navigation is one of the agent's own
   * verbs. `goto`, `go`, `open-contact` are `read` verbs an agent calls freely,
   * and a `goto` to a full page load tears the driver down and mounts a fresh
   * one — with `callsUsed` back at zero. So without this field an agent that
   * reaches a ceiling can refresh its way past it, and the `budget-spent` hint
   * says in so many words "it does not refill, and waiting or retrying will not
   * change it", which was then false. A ceiling that resets is not a ceiling,
   * and a hint that lies about it is worse than no hint.
   *
   * Absent means in-memory counters and the behaviour this had before the field
   * existed: the ceiling bounds one mounted driver and a reload starts over.
   * That is still the right default for an app with no storage to reach for.
   *
   * **FAIL CLOSED, UNLIKE EVERY OTHER PIECE OF PERSISTENCE IN HERE.** The
   * widget's panel position and its transcript swallow every storage failure,
   * because the worst case is a forgotten pane and a lost conversation. Here
   * the worst case is an uncapped agent, so the asymmetry is reversed on
   * purpose: when `load()` answers `{ ok: false }`, or a `save()` throws, every
   * subsequent call is refused `budget-spent` with a hint that names the cause.
   * An app whose storage is unavailable is still fully usable by the person at
   * the keyboard — it is only the agent that stops. See `BudgetStore`.
   *
   * **THIS IS A COST CONTROL AND NOT A SECURITY BOUNDARY, and the type should
   * say so rather than imply a guarantee the browser cannot give.** Whatever
   * holds the record is readable and writable by the person sitting there, in
   * two keystrokes of devtools, and clearing site data resets it. That is fine:
   * they own the machine and they are the one paying. What this stops is an
   * agent in a loop, which is the thing it was built for. A ceiling that has to
   * hold against the person is a ceiling that belongs on the server, behind the
   * API the verbs call.
   */
  store?: BudgetStore;
  /**
   * The name of the current allowance. Changing it starts a fresh one.
   *
   * A persisted ceiling cannot reset on nothing, because a budget that is
   * permanently spent makes the app permanently undrivable — which nobody will
   * read as a working cost control, they will read it as this library being
   * broken, and the next thing they do is clear site data, which resets it
   * anyway and teaches them to do that every time.
   *
   * So this is the deliberate, host-held reset: a string the app chooses. A
   * record written under a different `epoch` is discarded and the allowance
   * starts again. A deploy can bump it, a billing period can be its name, a
   * support tool can write a new one into the page it serves.
   *
   * **The agent cannot reach it.** It is an argument to `mount()`, so it lives
   * in the page's own source, which an agent driving through verbs has no verb
   * for. That is the test every reset mechanism here has to pass, and it is why
   * there is no reset VERB and never should be.
   */
  epoch?: string;
  /**
   * How long one allowance lasts, in milliseconds. Omitted means forever.
   *
   * `{ calls: 200, window: 86_400_000 }` is two hundred calls a day: the record
   * carries when its allowance started, and a record older than this is
   * discarded for a fresh one.
   *
   * **This is not the rolling window this type rejects further up, and the
   * difference is worth being exact about.** What was rejected was a RATE
   * limit — calls per minute as the bound — on the grounds that it "converts an
   * unbounded spend into a slower unbounded spend": the runaway still runs
   * forever, politely. This is a hard ceiling with a renewal period, which is a
   * quota. A runaway still stops dead at `calls` and stays stopped for the rest
   * of the window; what the window buys is that tomorrow the app works again
   * without anybody deploying anything. Tumbling and not sliding, because a
   * sliding window needs the timestamp of every call and this needs one number.
   *
   * Also agent-unreachable: it is declared at `mount()`, and the only thing
   * that advances it is the wall clock. An agent that could set the page's
   * clock forward has bigger powers than this field.
   *
   * A DESIGN NOTE, NOT BUILT, so the argument is not lost: the settings view
   * could let the VIEWER lower this app's ceiling but never raise it. A person
   * tightening their own leash is always safe, and the app's declared number
   * stays the hard stop, so there is no bypass in it. It is not here because a
   * viewer-held floor is a second persisted number with its own scope question,
   * and the ceiling that actually had to stop resetting is this one.
   */
  window?: number;
}

/**
 * Where a `Budget`'s counters live between page loads.
 *
 * An interface and not a `localStorage` call, for the reason every other
 * environment touch in the core is one: `mount()` runs in a browser, in a test
 * with a fake DOM, in `jsdom`, and in whatever somebody embeds this in next.
 * The core decides what the numbers MEAN — what counts, when an allowance has
 * expired, what a broken store does to the next call — and the store only
 * carries bytes. `localBudgetStore` in `driverkit/browser` is the one this
 * library ships; it is twenty lines over the same `loadJson`/`saveJson` the
 * widget's position and settings go through.
 *
 * **Scoped PER APP PER ORIGIN, which is what `localBudgetStore` does, and the
 * scope is a design decision rather than an implementation detail.** The
 * widget's transcript is scoped per TAB — it goes in `sessionStorage` — and a
 * budget deliberately is not, for one reason: if the ceiling were per tab then
 * "open a second tab" would be a budget-doubling move, which is the reload
 * bypass this whole mechanism exists to close, wearing a different hat. Two
 * tabs of one app therefore share one allowance, and yes, that means one tab
 * can exhaust the other's. That is the correct failure and the honest one: it
 * is ONE ceiling, spent by one person's agents, exactly as it would behave if
 * it were counted on the server — and the alternative fails in the direction
 * that costs money.
 */
export interface BudgetStore {
  /**
   * The record this store holds, or the news that it cannot be consulted.
   *
   * Three answers and not two, because the third is the whole of fail-closed:
   * "nothing stored yet" and "I could not look" are indistinguishable in a
   * plain `getItem` and must never be treated alike. A private window, blocked
   * site data and a corrupt record all answer `{ ok: false }`, and a corrupt
   * record is included on purpose — it cannot be told apart from tampering, and
   * guessing in the agent's favour is the one guess with a bill attached.
   *
   * **Called at `mount()` and again before every charged call**, and the
   * re-read is what makes "one app, one ceiling" true rather than aspirational.
   * Two tabs open at once each hold their own copy of the counters, so a
   * mount-time read alone gave each of them the whole allowance — two tabs, two
   * ceilings, which is the reload bypass wearing a different hat. It must
   * therefore be cheap and synchronous; `localBudgetStore` is one `getItem` and
   * one `JSON.parse` of a four-field object.
   *
   * The core takes the HIGHER of what this answers and what it already holds,
   * so a store that reads back a smaller figure — a tab that was behind, a
   * record somebody edited — can never hand an allowance back.
   */
  load(): { ok: true; spent: BudgetRecord | null } | { ok: false };
  /**
   * Write the record back. Called after every charged call.
   *
   * **May throw, and a throw is load-bearing here.** Everywhere else in this
   * library a failed storage write is swallowed, because a forgotten panel
   * position is not worth an exception. A budget that cannot be written is a
   * budget that will not be there after the next reload, which is the uncapped
   * agent again — so the core catches this, refuses every later call
   * `budget-spent`, and names the reason in the hint. Throwing is how a store
   * says "this ceiling is no longer being kept".
   */
  save(record: BudgetRecord): void;
}

/**
 * One allowance, as it is stored.
 *
 * Four fields and no more. In particular there is no verb name, no argument, no
 * count and no screen: a spend record that carried any of those would be a
 * transcript in `localStorage` under a field nobody reads as one, and the
 * privacy class of "this app has made 41 calls" is nothing like the privacy
 * class of what those calls were about.
 */
export interface BudgetRecord {
  /** Calls charged so far, matching `BudgetState.calls.used`. */
  calls: number;
  /** Commits run so far, matching `BudgetState.commits.used`. */
  commits: number;
  /**
   * Questions put so far, matching `BudgetState.asks.used`.
   *
   * Optional, and that is the migration: a record written before this field
   * existed reads back with no `asks`, which the core takes as 0 rather than
   * discarding the record — the two numbers beside it are still true, and
   * throwing an allowance away because a field was added would hand every app
   * with a store a fresh ceiling on upgrade.
   *
   * Still four fields' worth of privacy class and no more: a count of
   * questions, never a question. Nothing a person typed is written here, by
   * the rule the rest of this type is built on.
   */
  asks?: number;
  /** `Date.now()` when this allowance began. Only `Budget.window` reads it; an
   *  app with no window never looks, and the field is still written so that
   *  adding a window later does not have to treat every existing record as
   *  having started at the epoch. */
  since: number;
  /** The `Budget.epoch` in force when this record was written, absent when the
   *  app declared none. A mismatch discards the record; see `Budget.epoch`. */
  epoch?: string;
}

/**
 * What a mounted driver has spent, for a UI to show a person.
 *
 * READ-ONLY and that is the field's whole design. The widget's settings view
 * shows this and offers no control beside it; see `Budget` for why a viewer
 * must not be able to raise their own ceiling.
 *
 * `used` without `limit` is the normal case — an app with no budget still
 * reports what it has spent, which is the number somebody debugging a runaway
 * actually wants. `left` is deliberately absent: it is `limit - used`, and a
 * second way to say one thing is a second thing to get wrong.
 */
export interface BudgetState {
  calls: { used: number; limit?: number };
  commits: { used: number; limit?: number };
  /** Questions put to a person, and the ceiling if the app set one. Reported
   *  whatever the app declared, like the two above, so a settings view has one
   *  shape to render — and so "it has asked me four things" is a number
   *  somebody can see. */
  asks: { used: number; limit?: number };
}

export interface MountOptions {
  /** Shown in the manifest. A name a human would recognise. */
  app: string;
  /** The app's own briefing, copied into `Manifest.instructions` and read by
   *  every path that drives it — the in-page prompt and the MCP server alike.
   *  Static: see `Manifest.instructions` for what may not go in it. */
  instructions?: string;
  verbs: Verb<never>[] | Verb<Record<string, Scalar>>[] | Verb<any>[];
  /** Called fresh on every read. Must be cheap: it runs on each verb call. */
  visible: () => Snapshot;
  /**
   * Every screen the app has, with an optional RFC 6570 url template each.
   *
   * Declaring this plus `navigate` is what makes the core offer the reserved
   * `goto` verb, which is the point of the field: an app stops hand-rolling a
   * navigation verb under a name of its own — `go`, `navigate`, `open-screen`,
   * `route-to`, one per app, none of which the next agent recognises — and
   * gets one whose name, arguments, refusals and tool description are the
   * same in every app that declares a map.
   *
   * Declared WITHOUT `navigate` the list is still published and still useful:
   * an agent learns what screens exist and what their addresses look like,
   * which is more than it had. But no `goto` appears, because a navigation
   * verb the core cannot carry out would be a dead verb sitting in everybody's
   * cached prefix. `mount()` says so once, out loud, since the likelier of the
   * two readings is that the hook was forgotten.
   *
   * See `ScreenSpec`. Static, and the one rule worth repeating here: publish
   * the screens the APP has, never the screens this user can reach.
   */
  screens?: ScreenSpec[];
  /**
   * How the app gets to a screen. The body of the reserved `goto` verb.
   *
   * Read only when `screens` is declared, and ignored without it: there is
   * nowhere for `goto` to go. See `NavigateHook` for why this is the app's
   * function and not the core's, and `NavigateTarget` for what it is handed.
   *
   * An app that would rather keep its own navigation verb simply declares one
   * named `goto` in `verbs`, and the core leaves it alone — the same rule as
   * the hoisted `rev` and `screen` arguments in `driverkit/agent`, where an
   * app that claims the name keeps it, because the app's meaning wins over
   * ours.
   */
  navigate?: NavigateHook;
  /**
   * How the app puts a question to the person. Declaring it is what makes the
   * core offer the reserved `ask` verb.
   *
   * THE GAP THIS CLOSES. `approve` is a GATE, not a channel. A person could
   * stop the agent and the agent could not ask the person anything, so an
   * agent meeting an ambiguous instruction — "select the contact called Ada
   * Duarte", and five people are called that — had two moves: guess, or give
   * up. The argument is the one `declined-by-user` already rests on, one level
   * up: a model that cannot tell "the person said no" from "your arguments
   * were wrong" will retry with different arguments, and **a model that cannot
   * ask will guess.** Two of this library's own eval cases were written for an
   * outcome it could not express.
   *
   * Absent means absent, which is the whole of the additive promise here: no
   * `ask` verb appears, the manifest is the document it was before this field
   * existed, and `fingerprint()` does not move. An app that cannot ask is an
   * app where the guidance in `systemPrompt` about asking is never rendered
   * either, so a model is not told about a tool it has not got.
   *
   * BOTH WAYS IN, which is the half that makes this a feature rather than a
   * widget. The verb lives in `call()`, like every other, so an agent arriving
   * over the relay or MCP asks the same question through the same hook and the
   * person answers it in the same panel. What the outside path needs that the
   * in-page one does not is `askTimeout`; see it for why the default is a
   * deadline here and "wait forever" for an approval.
   *
   * IT IS NOT AN APPROVAL AND MUST NOT BECOME ONE. Nothing the person types
   * here is stored, nothing reaches `ApprovalRequest`, and a `commit` after a
   * question is gated exactly as a commit before one would have been — so an
   * agent that asks "shall I accept these 3,412?" and is told yes still meets
   * `approve`, and a `false` from `approve` still refuses the commit. The
   * separation is structural because there is no state for it to be a policy
   * about. See `AskHook`.
   */
  ask?: AskHook;
  /**
   * How long to wait for an answer before giving up, in milliseconds.
   * **Defaults to `DEFAULT_ASK_TIMEOUT_MS`, which is 45 seconds.**
   *
   * **THE OPPOSITE DEFAULT FROM `approvalTimeout`, ON PURPOSE.** That one waits
   * forever, because the person may be reading the rows the question is about
   * and a deadline that DENIES while they are deciding teaches them the dialog
   * is a race. Both halves of that argument invert here.
   *
   * Nothing is denied by a lapsed question: no verb was going to run and no
   * data was going to move, so giving up costs the agent one refusal it can
   * read and act on, and costs the person nothing at all.
   *
   * And waiting past the transport's own deadline is actively dishonest. The
   * relay gives a call 60 seconds and then answers `timeout`, which PROTOCOL.md
   * defines as **outcome unknown** — a commit that came back that way may
   * already have run. A question that outlived it would convert "nobody
   * answered", which is a fact the agent can act on, into "nobody knows", which
   * is the most expensive answer in the system, over the one call where the
   * truth was plainly knowable. So the default sits comfortably under the
   * relay's: the page answers `ask-unanswered` first, every time, and the
   * outside agent learns the fact rather than the mystery.
   *
   * 45 seconds is also about as long as a question can sit in front of
   * somebody before it is stale: an agent that asked a minute ago is asking
   * about a screen that has moved. Raise it for a gate that is a webhook or a
   * phone, and raise `RelayOptions.timeoutMs` with it or the relay will answer
   * first — which is the one combination that gives back exactly the honesty
   * this default is protecting. A non-positive number means wait forever, which
   * is the right answer for an app that is only ever driven in-page.
   */
  askTimeout?: number;
  /**
   * The app's multi-step recipes, for an agent to read and follow.
   *
   * Validated at `mount()` — a flow naming a verb that does not exist throws,
   * like a duplicate verb name — and then copied into the manifest and
   * rendered into the cached system prompt. Nothing executes them. See
   * `FlowSpec`, which carries the argument for why not.
   */
  flows?: FlowSpec[];
  /**
   * Who approves a `commit`, as a hook or as the word `"unattended"`.
   *
   * WHY THIS IS IN THE CORE AND NOT IN A CONSUMER. The confirmation used to
   * live in `driverkit/agent`'s `onBeforeCommit`, which `mountWidget` turns
   * on by default — so a person watching the panel was asked, and an agent
   * arriving over the relay or MCP called `accept-selected` and it simply ran.
   * The reserved slug `declined-by-user` existed and nothing on the outside
   * path could ever emit it. That is the gate being in the wrong layer: a
   * safety property that holds on one of two paths is not a safety property,
   * it is a property of one consumer. `call()` is where every path converges —
   * the in-page loop, a relay frame, a test with no transport — so the gate
   * belongs here, and from here a denial is the same `declined-by-user`
   * refusal whichever way the call arrived.
   *
   * Called before `run`, for `kind: "commit"` verbs only. `read` and
   * `describe` are the two kinds that promise no data moves, which is the
   * promise this gate exists to check; asking about them is how people learn
   * to click Yes without reading. A commit that declares `reversible` is still
   * asked about here — the core does not know how large the selection is or
   * how good the app's undo really is, and the widget's dialog, which does,
   * answers that question inside its own implementation of this hook.
   *
   * NOBODY IS THERE TO ASK: the third answer, and the one this field is shaped
   * by. A headless agent over MCP has no human, and the three candidate
   * answers were refuse (safe, and it breaks every automated run), allow (what
   * happened before this existed, and it is the gap) or make the host DECLARE
   * which it is. The third is taken, and the precedent is `allow_remote=True`
   * with no way to identify callers, which raises at construction rather than
   * serving: three deliberate acts to publish a relay, not one. So here —
   * absent means absent, in-page behaviour is exactly what it was, and the
   * declaration is enforced at the moment the driver is published to the
   * outside. `connect()` refuses to open a stream for a driver that has
   * `commit` verbs which have not declared `reversible` and no `approve` of
   * either kind. Three deliberate acts to let an outside agent change data: a
   * commit verb, a relay connection, and a statement of who approves. The
   * unsafe case is still reachable — `approve: "unattended"` — but no longer
   * by accident, which is the whole of what this buys.
   *
   * Absent here makes NO claim and changes nothing about the core: an app
   * mounted yesterday with no `approve` behaves identically in-page, which is
   * why this is not a required field and why the default is not a gate.
   *
   * WHAT THE WIDGET DOES WITH AN ABSENT ONE. `mountWidget` installs its own
   * confirmation dialog here, through `DriverApproval.adopt`, so the question
   * a person answers in the panel is asked inside `call()` and lands in the
   * audit record as `approval: "allowed"` with `policy: "adopted"`. That is
   * additive — the dialog, its wording and its thresholds are what they were,
   * and a commit now gets asked about on paths the panel could not reach — and
   * it does not make the driver publishable: `connect()` reads
   * `DriverApproval.declared`, which this field alone writes.
   *
   * DECLARING ONE HERE OVERRULES THAT, always. A hook of your own is asked and
   * the panel installs nothing, so one commit gets one dialog; `"unattended"`
   * is not quietly made interactive by a panel being mounted. The documented
   * way to have both is to declare the panel's own dialog as this hook:
   * `approve: (req) => panel.approve(req)`. See `Widget.approve`.
   */
  approve?: ApprovalPolicy;
  /**
   * How long to wait for an approval before giving up, in milliseconds.
   *
   * Absent means wait, and that is the right default rather than a timid one:
   * the person may be reading the rows the question is about, and a deadline
   * that denies while they are deciding teaches them that the dialog is a race
   * instead of a decision. Nothing is lost by waiting — the agent's own
   * transport deadline fires on its side and tells it the outcome is unknown,
   * which is true.
   *
   * The cost of waiting is that an approval nobody EVER answers leaves the
   * lock held and every later call refused `approval-pending` until the page
   * is reloaded. That is safe and it is also a dead app, so an app whose
   * people are on a phone, or whose gate is a webhook, sets a number here. A
   * lapsed approval is `approval-timeout`, which says the verb DID NOT RUN —
   * unlike the relay's `timeout`, which means nobody knows.
   */
  approvalTimeout?: number;
  /**
   * Where this app's audit records go. One call per `call()`; see `AuditEvent`.
   *
   * WHAT IT COSTS TO LEAVE OUT. Nothing: an app that passes no hook behaves
   * byte-identically to one mounted before this field existed — no record is
   * built, no clock is read, and the manifest and its fingerprint do not move,
   * because an audit trail is a runtime arrangement and not part of the
   * surface an agent caches.
   *
   * A THROWING OR SLOW HOOK MUST NOT TAKE THE APP DOWN, and this hook is
   * shaped by that rather than by politeness. It is called and NOT awaited: a
   * returned promise has a `catch` attached and is otherwise left alone, and a
   * synchronous throw is caught. Either way the failure is reported once
   * through the same `console.warn` channel the rest of the core's authoring
   * mistakes use — because a record that vanished silently is the one failure
   * an audit trail cannot survive — and the call's `Result` is returned
   * unchanged.
   *
   * WHY THIS IS NOT `ApprovalHook`, which is awaited, deadlined and whose
   * failure is a refusal. An approval is asked BEFORE the decision and its
   * answer IS the decision, so there is nothing to do but wait for it, and a
   * failed ask has to be a no. An audit record is emitted AFTER the outcome is
   * decided and, for a commit, after the data has already moved: there is
   * nothing left to refuse, so waiting on the sink can only delay the agent,
   * and failing the call because the logger is down would turn a broken
   * logging backend into a broken application. Hence no deadline here, and
   * hence no timer — which is also why this hook cannot repeat the bug
   * `deadline()` carries a comment about.
   *
   * FAIL-OPEN IS A REAL LIMIT AND NOT A SHRUG. If you need a commit to be
   * impossible unless it has been recorded, the place to put that is the
   * `approve` hook, which runs before the verb and whose no means no. This one
   * cannot give you that guarantee and does not claim to.
   */
  onAudit?: AuditHook;
  /**
   * A hard ceiling on what this driver will ever spend. See `Budget`, which
   * carries the argument for what is bounded and what was rejected.
   *
   * Off by default and costs nothing to leave out: with no `budget` the
   * counters are not kept, nothing is compared, and the call path is the one
   * it was before this field existed.
   *
   * When a ceiling is reached, the call is refused `budget-spent` with the
   * numbers in the hint. That refusal is the point as much as the stopping is:
   * `approvalTimeout` waits forever by default because "a deadline that denies
   * while somebody is reading teaches them the dialog is a race", and a ceiling
   * has the same hazard pointing the other way — a job that stops halfway and
   * does not say why is read as a broken app, and the next thing somebody does
   * is run it again. So nothing here is silent: the agent is told which
   * ceiling and that it does not reset, `Driver.budget` lets a panel show the
   * person the same thing, and `drive()` ends the run with `over-budget`
   * rather than grinding through its refusal limit first.
   */
  budget?: Budget;
  /**
   * How this driver hears that another tab of the same app committed.
   *
   * Absent makes NO claim and changes nothing — the default, and deliberately
   * the default: a single-tab app, or an app that already invalidates across
   * tabs so that `rev` moves on its own, gains nothing from this and should pay
   * nothing for it. An app that passes a channel gets two things:
   *
   *  - a `commit` is refused `changed-elsewhere` while a notice from another
   *    driver is outstanding, which closes the hole described on
   *    `ElsewhereChannel`: the one case where `stale` passed, the plan token
   *    verified, and the data had moved anyway;
   *  - every `Snapshot` this driver hands back says so, in `note`, so a read is
   *    no longer silently wrong either.
   *
   * WHEN IT CLEARS: when this app's own `rev` moves. `rev` is the only
   * statement the core is entitled to believe about this app's data, and a
   * second staleness rule beside it would be a second set of rules — the thing
   * `call()` exists not to have. The cost is stated rather than hidden: a `rev`
   * that moves for an unrelated reason (the person typed in a filter) clears
   * the notice without the data having been refetched. That is the SAME
   * weakness `rev` already has — an app that bumps `rev` without refetching has
   * already broken `stale` — so this adds none. The fix for both is the same:
   * listen on the channel yourself and refetch. An app that does is an app
   * where none of this ever fires.
   *
   * ONE THING IS HELD BACK WHILE A NOTICE STANDS: a plan is not carried across
   * a read-only move. A plan surviving a navigation is a `selectionId` saying
   * the selection is the same selection, and while a notice stands the core has
   * been told that this tab's copy of the data is not. Those two would have
   * composed into a bulk commit going through with the notice silently cleared
   * and no fresh count read anywhere, so the carry declines and the agent has
   * to describe again. See `plansGoodAt` in the registry.
   *
   * See `ElsewhereChannel`, and `broadcastElsewhere()` in `driverkit/browser`
   * for the same-origin implementation that needs no server and no relay.
   */
  elsewhere?: ElsewhereChannel;
}

export interface Driver {
  /** The static half. Stable across calls unless the verbs change. */
  manifest: () => Manifest;
  /** The dynamic half, read on demand. */
  snapshot: () => Snapshot;
  /** Run a verb. Never throws for an expected refusal; see `Result`. */
  call: (name: string, args?: Record<string, Scalar>, opts?: CallOptions) => Promise<Result>;
  /**
   * The approval policy this driver was mounted with, and its lock.
   *
   * Optional only so that a hand-written driver — which PROTOCOL.md says must
   * remain possible — still satisfies this interface. A reader treats an
   * absent one as `policy: "none"`, and `connect()` does. A hand-written
   * driver that has its own gate says so with
   * `approval: { policy: "unattended", hold: (_, ask) => ask() }`, and such a
   * driver has no `declared` and no `adopt`: `connect()` reads `declared` and
   * falls back to `policy`, so that one goes on publishing exactly as it did,
   * and a panel mounted on it finds no `adopt` and keeps its own in-page
   * dialog.
   */
  approval?: DriverApproval;
  /**
   * What this driver has spent, and against what ceiling. See `BudgetState`.
   *
   * Offered whatever the app declared, including no budget at all, so a panel
   * has one shape to render instead of two — and so the numbers are there for
   * somebody debugging an app that is making more calls than they thought.
   *
   * Optional on the interface for the reason `approval` is: a hand-written
   * driver must remain possible, and a reader treats an absent one as "this
   * driver does not account for itself".
   */
  budget?: () => BudgetState;
  /** Stop serving. Idempotent. */
  unmount: () => void;
}

export interface CallOptions {
  /** The `rev` the agent believes it is acting on. If the screen has moved on,
   *  the call is refused as `stale` rather than applied to a row the agent
   *  never saw. Omitting it opts out of the check. */
  rev?: number;
  /**
   * The `Snapshot.screen` the agent believes it is on. Checked BEFORE `rev`,
   * and refused as `wrong-screen`.
   *
   * Before this, a `next-page` call sent with no `rev` landed on a screen the
   * agent had never seen, paged a different company's contact list, and
   * answered `ok`. "You are somewhere else" is a better answer than "the
   * number moved", and the two are different mistakes with different fixes —
   * read again, versus navigate back — which is why this is a separate check
   * and a separate slug rather than more prose on `stale`.
   *
   * Before `rev` for the same reason `rev` is before the argument check: if the
   * agent is not even on the screen it thinks it is, then the arguments and the
   * rev both describe something it never saw, and complaining about either
   * answers the wrong question. Omitting it opts out, like `rev`.
   */
  screen?: string;
  /**
   * The plan token from the `describe` whose `count` this call was approved
   * against. Required by a verb declaring `consumes: "plan"`, ignored by every
   * other verb, and refused as `stale-plan`.
   *
   * The third of the three claims, and the one that is NOT optional where it
   * applies. `rev` and `screen` may be omitted to opt out of their checks,
   * because an agent that makes no claim about what it was looking at has at
   * least not made a false one. A plan token cannot work that way: a commit
   * that may be called without one is a commit whose count guarantee is
   * advisory, which is the state this field was added to leave. So the verb
   * declares it statically, in the cached half, and the core refuses the bare
   * call — with the pairing spelled out in the hint, rather than a validator
   * at the client rejecting the call before the explanation can reach the
   * model.
   *
   * Checked after `screen` and BEFORE `rev`, which is the order where both
   * apply; `call()` carries the argument for it. They are not nested: a
   * read-only navigation is `stale` and is not `stale-plan`, since the screen
   * moved and the selection did not. Opaque: the core minted it and the core
   * reads it, and every hop
   * in between — both relays, `connect()`, the Python client — forwards the
   * string untouched, exactly as they do `rev` and `screen`.
   */
  plan?: string;
}
