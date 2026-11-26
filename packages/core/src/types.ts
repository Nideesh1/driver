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
 */
export type VerbKind = "read" | "describe" | "commit";

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
  /** Monotonic, bumped on every change. An agent echoes it back to prove it is
   *  acting on what it saw; see `stale` in PROTOCOL.md. */
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
  | { ok: true; note?: string; count?: number; snapshot: Snapshot }
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
    args?: Record<string, ArgSpec>;
    refuses?: string[];
  }>;
}

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
  /** ISO 8601. A string on purpose: nothing computes with it, and parsing it
   *  would invent a failure mode for a field only ever shown to a person. */
  since?: string;
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
}

export interface Driver {
  /** The static half. Stable across calls unless the verbs change. */
  manifest: () => Manifest;
  /** The dynamic half, read on demand. */
  snapshot: () => Snapshot;
  /** Run a verb. Never throws for an expected refusal; see `Result`. */
  call: (name: string, args?: Record<string, Scalar>, opts?: CallOptions) => Promise<Result>;
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
}
